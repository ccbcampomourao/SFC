import { WorkerMailer } from "worker-mailer";

const SESSION_COOKIE = "sfc_session";
const SESSION_INATIVIDADE_MS = 4 * 60 * 60 * 1000; // desloga só depois de 4h sem usar o sistema
const SESSION_RENOVA_MS = 30 * 60 * 1000;          // renova no máximo a cada 30 min (economiza gravações no KV)
const SESSION_COOKIE_SEGUNDOS = 60 * 60 * 24 * 30;  // o cookie dura; quem decide se a sessão vale é o servidor
const CONFIRMACAO_TTL_SEGUNDOS = 60 * 60 * 24; // 24h para confirmar o e-mail

function emailValido(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function enviarEmailConfirmacao(env, origin, destinatario, nome, token) {
  const link = `${origin}/api/auth/confirmar?token=${token}`;
  await WorkerMailer.send(
    {
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      authType: "login",
      credentials: { username: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD },
    },
    {
      from: env.GMAIL_USER,
      to: destinatario,
      subject: "Confirme seu acesso — FZCONT",
      text:
        `Olá, ${nome}!\n\n` +
        `Para liberar seu acesso ao sistema, confirme seu e-mail clicando no link abaixo:\n\n${link}\n\n` +
        `Se você não pediu esse cadastro, pode ignorar esta mensagem.`,
    }
  );
}

// ---------------------------------------------------------------------------
// Utilidades gerais
// ---------------------------------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function lerCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  header.split(";").forEach((parte) => {
    const [k, ...v] = parte.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  });
  return out;
}

function cookieDeSessao(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function bufParaHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashSenha(senha, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex
    ? new Uint8Array(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const chaveBase = await crypto.subtle.importKey("raw", enc.encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    chaveBase,
    256
  );
  return { hash: bufParaHex(bits), salt: bufParaHex(salt) };
}

async function conferirSenha(senha, hashSalvo, saltSalvo) {
  const { hash } = await hashSenha(senha, saltSalvo);
  return hash === hashSalvo;
}

const REDEFINICAO_TTL_SEGUNDOS = 60 * 60;   // link de nova senha vale 1 hora
const REDEFINICAO_ESPERA_SEGUNDOS = 120;    // no máximo um e-mail de nova senha a cada 2 min por usuário
const SENHA_MINIMA = 8;

async function enviarEmailRedefinicao(env, origin, destinatario, nome, token) {
  const link = `${origin}/?redefinir=${token}`;
  await WorkerMailer.send(
    {
      host: "smtp.gmail.com", port: 465, secure: true, authType: "login",
      credentials: { username: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD },
    },
    {
      from: env.GMAIL_USER,
      to: destinatario,
      subject: "Criar uma nova senha — Prumo",
      text:
        `Olá, ${nome}!\n\n` +
        `Recebemos um pedido para criar uma nova senha no Prumo. Para continuar, abra o link abaixo (vale por 1 hora e só funciona uma vez):\n\n${link}\n\n` +
        `Se não foi você, ignore esta mensagem: sua senha atual continua valendo.`,
    }
  );
}

// Cria o link de nova senha e manda por e-mail. Respeita a espera entre envios.
async function pedirRedefinicao(env, origin, usuario) {
  if (!usuario || !usuario.email || usuario.bloqueado) return { enviado: false };
  const espera = `redefinir-espera:${usuario.username}`;
  if (await env.SFC_KV.get(espera)) return { enviado: false, aguarde: true };
  const token = bufParaHex(crypto.getRandomValues(new Uint8Array(24)));
  await env.SFC_KV.put(`redefinir:${token}`, JSON.stringify({ username: usuario.username, criadoEm: Date.now() }), { expirationTtl: REDEFINICAO_TTL_SEGUNDOS });
  await env.SFC_KV.put(espera, "1", { expirationTtl: REDEFINICAO_ESPERA_SEGUNDOS });
  await enviarEmailRedefinicao(env, origin, usuario.email, usuario.nome || usuario.username, token);
  return { enviado: true };
}

// Derruba as sessões abertas de um usuário (ao bloquear ou trocar a senha).
// As sessões guardam o usuário nos metadados da chave, então dá para achar só listando.
async function encerrarSessoesDe(env, username, exceto = null) {
  let cursor;
  do {
    const pagina = await env.SFC_KV.list({ prefix: "session:", cursor });
    for (const k of pagina.keys) {
      const token = k.name.slice(8);
      if (token === exceto) continue;
      let dono = k.metadata && k.metadata.username;
      if (!dono) { const s = await env.SFC_KV.get(k.name, "json"); dono = s && s.username; } // sessões antigas, sem metadados
      if (dono === username) await env.SFC_KV.delete(k.name);
    }
    cursor = pagina.list_complete ? null : pagina.cursor;
  } while (cursor);
}

// Sessão por inatividade: cada uso "renova" a sessão por mais 4h. Para não gravar no KV a cada
// clique, a renovação acontece no máximo a cada 30 min — e a validade é 4h + 30 min a partir dela,
// então o sistema desloga entre 4h e 4h30 depois do último uso (nunca antes de 4h).
async function gravarSessao(env, token, username) {
  await env.SFC_KV.put(`session:${token}`, JSON.stringify({ username, renovadaEm: Date.now() }), {
    expirationTtl: Math.ceil((SESSION_INATIVIDADE_MS + SESSION_RENOVA_MS) / 1000),
    metadata: { username },
  });
}

async function usuarioLogado(request, env) {
  const cookies = lerCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const sessao = await env.SFC_KV.get(`session:${token}`, "json");
  if (!sessao || !sessao.username) return null;
  const agora = Date.now();
  const renovadaEm = Number(sessao.renovadaEm) || 0; // sessões antigas (antes desta versão) não têm esse campo
  if (renovadaEm && agora - renovadaEm > SESSION_INATIVIDADE_MS + SESSION_RENOVA_MS) return null;
  if (agora - renovadaEm >= SESSION_RENOVA_MS) {
    try { await gravarSessao(env, token, sessao.username); } catch { /* limite do KV: segue logado, tenta na próxima */ }
  }
  return sessao.username;
}

function gruposIniciais() {
  return [
    { nome: "LUCRO PRESUMIDO", empresas: [] },
    { nome: "FATOR R", empresas: [] },
    { nome: "ANEXO III", empresas: [] },
    { nome: "ANEXO IV", empresas: [] },
    { nome: "COMERCIO E SERVIÇO", empresas: [] },
    { nome: "COMERCIO E INDÚSTRIA", empresas: [] },
  ];
}

// ---------------------------------------------------------------------------
// Camada de dados: KV_EMPRESAS (cadastro/status) + KV_COMENTARIOS (comentários/tarefas) + R2 (anexos)
// ---------------------------------------------------------------------------

// Lê o estado completo (mesclando empresas/parcelamentos com seus comentários) a partir de um
// prefixo de chaves — "" para os dados atuais/vivos, ou "periodo:<nome>:" para um período salvo.
async function lerDadosCompletos(env, prefixo = "") {
  const dados = (await env.KV_EMPRESAS.get(`${prefixo}dados`, "json")) || { grupos: gruposIniciais() };
  const parcelamentosObj = (await env.KV_EMPRESAS.get(`${prefixo}parcelamentos`, "json")) || { parcelamentos: [] };
  const checklist = (await env.KV_COMENTARIOS.get(`${prefixo}checklist`, "json")) || [];
  const comentEmp = (await env.KV_COMENTARIOS.get(`${prefixo}comentariosEmpresas`, "json")) || {};
  const comentPar = (await env.KV_COMENTARIOS.get(`${prefixo}comentariosParcelamentos`, "json")) || {};

  const grupos = dados.grupos.map((g) => ({
    nome: g.nome,
    empresas: g.empresas.map((e) => ({ ...e, comentarios: comentEmp[e.id] || [] })),
  }));
  const parcelamentos = parcelamentosObj.parcelamentos.map((p) => ({ ...p, comentarios: comentPar[p.id] || [] }));
  return { grupos, checklist, parcelamentos, ...(dados.mesTrabalho ? { mesTrabalho: dados.mesTrabalho } : {}) };
}

// Grava o estado completo, separando: cadastro/status -> KV_EMPRESAS, comentários/tarefas -> KV_COMENTARIOS.
// Garante que toda empresa/parcelamento tenha um "id" estável (gera um se estiver faltando).
async function gravarDadosCompletos(env, estado, prefixo = "") {
  const comentariosEmpresas = {};
  const comentariosParcelamentos = {};

  const grupos = (estado.grupos || []).map((g) => ({
    nome: g.nome,
    empresas: (g.empresas || []).map((e) => {
      const id = e.id || crypto.randomUUID();
      comentariosEmpresas[id] = e.comentarios || [];
      const { comentarios, ...resto } = e;
      return { ...resto, id };
    }),
  }));

  const parcelamentos = (estado.parcelamentos || []).map((p) => {
    const id = p.id || crypto.randomUUID();
    comentariosParcelamentos[id] = p.comentarios || [];
    const { comentarios, ...resto } = p;
    return { ...resto, id };
  });

  // O plano gratuito do KV permite só 1.000 gravações por dia: cada chave só é regravada se
  // o conteúdo realmente mudou (ler é barato — 100.000 leituras/dia).
  const gravarSeMudou = async (kv, chave, valor) => {
    const atual = await kv.get(chave);
    if (atual === valor) return false;
    await kv.put(chave, valor);
    return true;
  };
  await Promise.all([
    gravarSeMudou(env.KV_EMPRESAS, `${prefixo}dados`, JSON.stringify(/^\d{4}-\d{2}$/.test(estado.mesTrabalho || "") ? { grupos, mesTrabalho: estado.mesTrabalho } : { grupos })),
    gravarSeMudou(env.KV_EMPRESAS, `${prefixo}parcelamentos`, JSON.stringify({ parcelamentos })),
    gravarSeMudou(env.KV_COMENTARIOS, `${prefixo}checklist`, JSON.stringify(estado.checklist || [])),
    gravarSeMudou(env.KV_COMENTARIOS, `${prefixo}comentariosEmpresas`, JSON.stringify(comentariosEmpresas)),
    gravarSeMudou(env.KV_COMENTARIOS, `${prefixo}comentariosParcelamentos`, JSON.stringify(comentariosParcelamentos)),
  ]);

  return { grupos, checklist: estado.checklist || [], parcelamentos, ...(estado.mesTrabalho ? { mesTrabalho: estado.mesTrabalho } : {}) };
}

// Migração automática e transparente: se ainda existirem dados no formato antigo (tudo dentro do
// SFC_KV, anexos em base64 dentro do próprio KV), copia tudo para o novo formato (KV_EMPRESAS +
// KV_COMENTARIOS + R2) na primeira vez que o app é acessado depois do upgrade.
async function migrarSeNecessario(env) {
  const jaMigrado = await env.KV_EMPRESAS.get("dados");
  if (jaMigrado) return;

  const legadoDados = await env.SFC_KV.get("dados", "json");
  if (!legadoDados) return; // instalação nova, nada a migrar

  const legadoParcelamentos = (await env.SFC_KV.get("parcelamentos", "json")) || { parcelamentos: [] };

  async function migrarAnexos(lista) {
    for (const anexo of lista || []) {
      if (!anexo || !anexo.id) continue;
      const antigo = await env.SFC_KV.get(`anexo:${anexo.id}`, "json");
      if (antigo && antigo.dataB64) {
        const bytes = Buffer.from(antigo.dataB64, "base64");
        await env.ANEXOS_R2.put(`anexos/${anexo.id}`, bytes, {
          httpMetadata: { contentType: antigo.tipo || "application/octet-stream" },
          customMetadata: { nome: antigo.nome || anexo.nome || "arquivo" },
        });
        await env.SFC_KV.delete(`anexo:${anexo.id}`).catch(() => {});
      }
    }
  }

  for (const g of legadoDados.grupos || []) {
    for (const e of g.empresas || []) {
      e.id = e.id || crypto.randomUUID();
      await migrarAnexos(e.anexos);
    }
  }
  for (const p of legadoParcelamentos.parcelamentos || []) {
    p.id = p.id || crypto.randomUUID();
    await migrarAnexos(p.anexos);
  }

  await gravarDadosCompletos(env, {
    grupos: legadoDados.grupos || gruposIniciais(),
    checklist: legadoDados.checklist || [],
    parcelamentos: legadoParcelamentos.parcelamentos || [],
  });

  await env.SFC_KV.delete("dados").catch(() => {});
  await env.SFC_KV.delete("parcelamentos").catch(() => {});
}

// ---------------------------------------------------------------------------
// INTEGRACONTADOR (SERPRO) — SITFIS via mTLS + CND (produto separado, sem certificado)
// ---------------------------------------------------------------------------
const SERPRO_SITFIS_AUTH_URL = "https://autenticacao.sapi.serpro.gov.br/authenticate";
const SERPRO_SITFIS_BASE = "https://gateway.apiserpro.serpro.gov.br/integra-contador/v1";
// Produto "Consulta CND" — separado do Integra Contador, não usa certificado digital.
// Endpoint de PRODUÇÃO inferido a partir do de homologação documentado publicamente pelo
// SERPRO; se retornar 404, ajuste CND_CONSULTA_URL abaixo com o endereço correto do seu contrato.
const CND_TOKEN_URL = "https://apigateway.conectagov.estaleiro.serpro.gov.br/oauth2/jwt-token";
const CND_CONSULTA_URL = "https://apigateway.conectagov.estaleiro.serpro.gov.br/api-cnd/v1/ConsultaCnd/certidao";

function tipoPessoa(numero) {
  return limparNumeroDoc(numero).length === 11 ? 1 : 2; // 1 = CPF, 2 = CNPJ
}
function limparNumeroDoc(s) {
  return (s || "").replace(/[^0-9]/g, "");
}

// Erros com "etapa" e "dica" para a tela mostrar exatamente onde e por que falhou.
function erroComEtapa(mensagem, etapa, dica) {
  const e = new Error(mensagem);
  e.etapa = etapa;
  if (dica) e.dica = dica;
  return e;
}
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function obterTokenSitfis(env) {
  if (!env.SERPRO_CERT) {
    throw erroComEtapa(
      "Certificado digital ainda não vinculado ao Worker (binding SERPRO_CERT ausente).",
      "configuracao",
      "Suba o certificado pela tela IntegraContador e ative o bloco [[mtls_certificates]] no wrangler.toml."
    );
  }
  if (!env.SERPRO_CONSUMER_KEY || !env.SERPRO_CONSUMER_SECRET) {
    throw erroComEtapa(
      "SERPRO_CONSUMER_KEY / SERPRO_CONSUMER_SECRET não configurados.",
      "configuracao",
      "Cadastre os dois secrets no Worker (Settings → Variables and Secrets)."
    );
  }
  const basic = Buffer.from(`${env.SERPRO_CONSUMER_KEY}:${env.SERPRO_CONSUMER_SECRET}`).toString("base64");
  const resp = await env.SERPRO_CERT.fetch(SERPRO_SITFIS_AUTH_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Role-Type": "TERCEIROS" },
  });
  const texto = await resp.text();
  if (!resp.ok) {
    throw erroComEtapa(
      `O SERPRO recusou a autenticação (HTTP ${resp.status}): ${texto.replace(/\s+/g, " ").slice(0, 300) || "sem detalhes"}`,
      "autenticacao",
      "Confira o Consumer Key/Secret, se o certificado (.pfx) enviado é o e-CNPJ do titular do contrato e se ele não está vencido."
    );
  }
  let dados;
  try { dados = JSON.parse(texto); } catch {
    throw erroComEtapa("A resposta de autenticação do SERPRO não é JSON: " + texto.slice(0, 300), "autenticacao");
  }
  if (!dados.access_token) throw erroComEtapa("O SERPRO não retornou access_token: " + texto.slice(0, 300), "autenticacao");
  return dados;
}

// Reaproveita o token por alguns minutos (com margem de segurança) em vez de repetir o
// handshake com o certificado a cada empresa consultada — é a parte mais lenta da requisição.
async function obterTokenSitfisCacheado(env, forcar = false) {
  if (!forcar) {
    try {
      const cacheado = await env.SFC_KV.get("sitfis_token_cache", "json");
      if (cacheado && cacheado.expiraEm > Date.now() + 5000) return cacheado.token;
    } catch {}
  }
  const token = await obterTokenSitfis(env);
  const segundos = Number(token.expires_in || token.expiresIn || 300);
  const validoPor = Math.max(segundos - 30, 30); // margem de segurança de 30s
  try {
    await env.SFC_KV.put(
      "sitfis_token_cache",
      JSON.stringify({ token, expiraEm: Date.now() + validoPor * 1000 }),
      { expirationTtl: Math.max(validoPor, 60) }
    );
  } catch {}
  return token;
}

async function chamarIntegraContador(env, token, caminho, corpo) {
  const resp = await env.SERPRO_CERT.fetch(`${SERPRO_SITFIS_BASE}/${caminho}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      jwt_token: token.jwt_token || "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(corpo),
  });
  const texto = await resp.text();
  let json;
  try { json = JSON.parse(texto); } catch { json = { dados: texto }; }
  if (!json || typeof json !== "object" || Array.isArray(json)) json = { dados: json };
  const { httpStatus: _ignorar, ...resto } = json;
  return { ...resto, statusCorpo: json.status, httpStatus: resp.status };
}

// Se o token em cache foi invalidado do lado do SERPRO (401), renova uma vez e repete.
async function chamarComRenovacao(env, tokenRef, caminho, corpo) {
  let resp = await chamarIntegraContador(env, tokenRef.token, caminho, corpo);
  if (resp.httpStatus === 401) {
    try { await env.SFC_KV.delete("sitfis_token_cache"); } catch {}
    tokenRef.token = await obterTokenSitfisCacheado(env, true);
    resp = await chamarIntegraContador(env, tokenRef.token, caminho, corpo);
  }
  return resp;
}

function lerDadosSerpro(dados) {
  if (dados == null || dados === "") return null;
  if (typeof dados === "object") return dados;
  try { return JSON.parse(dados); } catch { return null; }
}

function extrairMensagensSerpro(resp) {
  const m = resp && resp.mensagens;
  if (!m) return [];
  return (Array.isArray(m) ? m : [m])
    .map((i) => (typeof i === "string"
      ? { codigo: "", texto: i }
      : { codigo: String((i && i.codigo) || ""), texto: String((i && (i.texto || i.mensagem)) || "") }))
    .filter((i) => i.codigo || i.texto);
}

// Traduz os códigos mais comuns do Integra Contador numa orientação prática.
function explicarErroSerpro(mensagens, httpStatus) {
  const t = mensagens.map((m) => `${m.codigo} ${m.texto}`).join(" ");
  if (/ICGERENCIADOR-016|NI do Contratante/i.test(t)) {
    return "O CNPJ configurado em SERPRO_CONTRATANTE_CNPJ não bate com o do certificado digital (e-CNPJ). Os dois precisam ser do mesmo titular — o que contratou o Integra Contador. Esse erro afetaria todas as empresas, não só uma.";
  }
  if (/procura[çc][ãa]o|PROELETRON|ICGERENCIADOR-0?(17|21|32)\b/i.test(t)) {
    return "Essa empresa provavelmente ainda não deu procuração eletrônica no e-CAC para o CNPJ do seu escritório, com permissão para o serviço de Situação Fiscal. É a causa mais comum de erro em um CNPJ específico enquanto os outros funcionam. O cadastro é feito no e-CAC da empresa (Procuração Eletrônica). Atenção: o SERPRO cobra também as chamadas recusadas (403), então evite repetir várias vezes.";
  }
  if (/vers[ãa]o/i.test(t)) {
    return "O SERPRO reclamou da versão do serviço. Defina a variável SERPRO_SITFIS_VERSAO no Worker (teste com 1.0; o padrão é 2.0).";
  }
  if (httpStatus === 429 || /excesso de (requisi|solicita)/i.test(t)) {
    return "O SERPRO limitou a quantidade de requisições. Aguarde um pouco antes de tentar de novo (chamadas recusadas também são cobradas).";
  }
  if (httpStatus === 401) return "O SERPRO não aceitou o token de acesso mesmo depois de renovar. Confira as credenciais e o certificado.";
  if (httpStatus === 403) {
    return "O SERPRO negou o acesso a essa empresa. Normalmente é falta de procuração eletrônica no e-CAC da empresa para o CNPJ do seu escritório. Chamadas recusadas também são cobradas, então evite repetir.";
  }
  if (httpStatus >= 500) {
    return "O erro veio do lado do SERPRO (instabilidade ou falha ao processar essa empresa). Tente de novo em alguns minutos; se persistir só nesse CNPJ, vale conferir a situação cadastral dele.";
  }
  return null;
}

const ROTULO_ETAPA = {
  solicitar_protocolo: "ao solicitar o protocolo do relatório",
  emitir_relatorio: "ao emitir o relatório",
};

function erroSerpro(etapa, resp, { semMensagens, protocolo } = {}) {
  const mensagens = extrairMensagensSerpro(resp);
  let resumo;
  if (mensagens.length) {
    resumo = mensagens.map((m) => [m.codigo, m.texto].filter(Boolean).join(" ")).join(" | ");
  } else if (semMensagens) {
    resumo = semMensagens;
  } else if (typeof resp.dados === "string" && resp.dados.trim()) {
    resumo = resp.dados.replace(/\s+/g, " ").slice(0, 300);
  } else {
    resumo = "o SERPRO não informou o motivo";
  }
  let detalheTecnico;
  try {
    detalheTecnico = JSON.stringify({
      etapa, httpStatus: resp.httpStatus, statusCorpo: resp.statusCorpo, mensagens: resp.mensagens,
      dados: typeof resp.dados === "string" ? resp.dados.slice(0, 400) : resp.dados,
    }).slice(0, 1000);
  } catch { detalheTecnico = ""; }
  const resultado = {
    ok: false,
    etapa,
    httpStatus: resp.httpStatus,
    mensagens,
    erro: `Erro do SERPRO ${ROTULO_ETAPA[etapa] || etapa} (HTTP ${resp.httpStatus}): ${resumo}`,
    dica: explicarErroSerpro(mensagens, resp.httpStatus),
    detalheTecnico,
  };
  if (protocolo) resultado.protocolo = protocolo;
  return resultado;
}

async function buscarRelatorioSitfis(env, cnpjCliente, { protocolo: protocoloExistente } = {}) {
  const contratante = limparNumeroDoc(env.SERPRO_CONTRATANTE_CNPJ);
  if (!contratante) {
    throw erroComEtapa(
      "SERPRO_CONTRATANTE_CNPJ não configurado (CNPJ do seu escritório contábil).",
      "configuracao",
      "Cadastre o secret SERPRO_CONTRATANTE_CNPJ com o CNPJ do escritório (o mesmo do certificado digital)."
    );
  }
  const versao = String(env.SERPRO_SITFIS_VERSAO || "2.0");
  const cnpj = limparNumeroDoc(cnpjCliente);
  const tokenRef = { token: await obterTokenSitfisCacheado(env) };

  const envelope = (idServico, dadosStr) => ({
    contratante: { numero: contratante, tipo: 2 },
    autorPedidoDados: { numero: contratante, tipo: 2 },
    contribuinte: { numero: cnpj, tipo: tipoPessoa(cnpj) },
    pedidoDados: { idSistema: "SITFIS", idServico, versaoSistema: versao, dados: dadosStr },
  });

  let protocolo = protocoloExistente || null;
  let espera = protocolo ? 0 : 2000;

  if (!protocolo) {
    const protocoloResp = await chamarComRenovacao(env, tokenRef, "Apoiar", envelope("SOLICITARPROTOCOLO91", ""));
    if (protocoloResp.httpStatus >= 400) return erroSerpro("solicitar_protocolo", protocoloResp);
    const dadosProtocolo = lerDadosSerpro(protocoloResp.dados);
    protocolo = dadosProtocolo && (dadosProtocolo.protocoloRelatorio || dadosProtocolo.protocolo);
    if (!protocolo) {
      return erroSerpro("solicitar_protocolo", protocoloResp, { semMensagens: "a resposta veio sem o protocolo do relatório" });
    }
    espera = Math.min(Number(dadosProtocolo.tempoEspera) || 2000, 15000);
  }

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    if (espera > 0) await esperar(espera);
    const emitirResp = await chamarComRenovacao(
      env, tokenRef, "Emitir",
      envelope("RELATORIOSITFIS92", JSON.stringify({ protocoloRelatorio: protocolo }))
    );
    if (emitirResp.httpStatus === 202) {
      const d = lerDadosSerpro(emitirResp.dados);
      espera = Math.min(Number(d && d.tempoEspera) || 3000, 15000);
      continue;
    }
    if (emitirResp.httpStatus >= 400) return erroSerpro("emitir_relatorio", emitirResp, { protocolo });
    const dadosFinal = lerDadosSerpro(emitirResp.dados);
    const pdfBase64 = dadosFinal && (dadosFinal.pdf || dadosFinal.relatorio || dadosFinal.arquivo);
    if (!pdfBase64) {
      return erroSerpro("emitir_relatorio", emitirResp, { semMensagens: "o relatório veio sem o PDF na resposta", protocolo });
    }
    return { ok: true, pdfBase64, nomeArquivo: `SITFIS-${cnpj}.pdf` };
  }
  return {
    ok: false, processando: true, protocolo, tempoEsperaMs: espera,
    erro: "O SERPRO ainda está gerando o relatório.",
  };
}

// Área própria do IntegraContador (não mexe nos anexos da empresa): cada relatório usa uma
// chave FIXA no R2 (empresa + serviço), então baixar de novo simplesmente sobrescreve o
// arquivo anterior — sempre a versão mais recente disponível, sem acumular cópias.
async function salvarRelatorioIntegraContador(env, { servico, cnpj, nomeEmpresa, bytesBase64 }) {
  const cnpjLimpo = limparNumeroDoc(cnpj);
  const chave = `integracontador/${servico}/${cnpjLimpo}.pdf`;
  const bytes = Buffer.from(bytesBase64, "base64");
  await env.ANEXOS_R2.put(chave, bytes, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { nome: nomeEmpresa || cnpjLimpo, cnpj: cnpjLimpo },
  });

  const indice = (await env.KV_EMPRESAS.get("integracontador_relatorios", "json")) || {};
  indice[cnpjLimpo] = indice[cnpjLimpo] || {};
  if (nomeEmpresa) indice[cnpjLimpo].nomeEmpresa = nomeEmpresa;
  indice[cnpjLimpo][servico] = { atualizadoEm: new Date().toISOString() };
  await env.KV_EMPRESAS.put("integracontador_relatorios", JSON.stringify(indice));
}

async function obterTokenCnd(env) {
  if (!env.CND_CONSUMER_KEY || !env.CND_CONSUMER_SECRET) throw new Error("CND_CONSUMER_KEY / CND_CONSUMER_SECRET não configurados.");
  const basic = Buffer.from(`${env.CND_CONSUMER_KEY}:${env.CND_CONSUMER_SECRET}`).toString("base64");
  const resp = await fetch(CND_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const texto = await resp.text();
  if (!resp.ok) throw new Error(`Falha ao autenticar no SERPRO (CND): ${resp.status} ${texto}`);
  let dados;
  try { dados = JSON.parse(texto); } catch { throw new Error("Resposta de autenticação da CND não é JSON: " + texto.slice(0, 300)); }
  if (!dados.access_token) throw new Error("SERPRO (CND) não retornou access_token: " + texto.slice(0, 300));
  return dados;
}

async function obterTokenCndCacheado(env) {
  try {
    const cacheado = await env.SFC_KV.get("cnd_token_cache", "json");
    if (cacheado && cacheado.expiraEm > Date.now() + 5000) return cacheado.accessToken;
  } catch {}

  const dados = await obterTokenCnd(env);
  const segundos = Number(dados.expires_in || dados.expiresIn || 300);
  const validoPor = Math.max(segundos - 30, 30);
  try {
    await env.SFC_KV.put(
      "cnd_token_cache",
      JSON.stringify({ accessToken: dados.access_token, expiraEm: Date.now() + validoPor * 1000 }),
      { expirationTtl: validoPor }
    );
  } catch {}
  return dados.access_token;
}

async function buscarCnd(env, cnpjCliente) {
  const token = await obterTokenCndCacheado(env);
  const numero = limparNumeroDoc(cnpjCliente);
  const resp = await fetch(`${CND_CONSULTA_URL}?numeroInscricao=${numero}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const texto = await resp.text();
  if (!resp.ok) return { ok: false, erro: `Falha ao consultar CND (${resp.status}): ${texto.slice(0, 400)}` };
  let dados;
  try { dados = JSON.parse(texto); } catch { dados = null; }
  const pdfBase64 = dados && (dados.pdfCertidao || dados.arquivo || dados.pdf || dados.certidaoPdf);
  if (!pdfBase64) return { ok: false, erro: "CND retornada, mas não achei o PDF na resposta: " + texto.slice(0, 400) };
  return { ok: true, pdfBase64, nomeArquivo: `CND-${numero}.pdf` };
}

// ---------------------------------------------------------------------------
// CONSULTA PÚBLICA DE CNPJ (optante pelo Simples Nacional / MEI)
// Fontes gratuitas são espelhos da base aberta da Receita (atualizada mensalmente) e limitam
// as requisições (erro 429). Por isso: cache de 24h por CNPJ + fontes de reserva em cadeia.
// ---------------------------------------------------------------------------
const CNPJ_CACHE_TTL_SEGUNDOS = 60 * 60 * 24;

// Valida os dígitos verificadores — evita gastar uma consulta (limitada) com CNPJ digitado errado.
function cnpjValido(c) {
  if (!/^\d{14}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const digito = (base) => {
    let soma = 0;
    let peso = base.length - 7;
    for (let i = 0; i < base.length; i++) {
      soma += Number(base[i]) * peso--;
      if (peso < 2) peso = 9;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return digito(c.slice(0, 12)) === Number(c[12]) && digito(c.slice(0, 13)) === Number(c[13]);
}

// BrasilAPI e Minha Receita usam o mesmo esquema (a BrasilAPI é um proxy da Minha Receita).
// IMPORTANTE: null = "sem registro na base pública", que NÃO é o mesmo que false.
function normalizarMinhaReceita(dados, fonte) {
  const tresEstados = (v) => (v === true || v === false ? v : null);
  return {
    fonte,
    razaoSocial: dados.razao_social || null,
    situacaoCadastral: dados.descricao_situacao_cadastral || null,
    optanteSimples: tresEstados(dados.opcao_pelo_simples),
    dataOpcaoSimples: dados.data_opcao_pelo_simples || null,
    dataExclusaoSimples: dados.data_exclusao_do_simples || null,
    optanteMei: tresEstados(dados.opcao_pelo_mei),
    dataOpcaoMei: dados.data_opcao_pelo_mei || null,
    dataExclusaoMei: dados.data_exclusao_do_mei || null,
  };
}

// CNPJ.ws tem base independente (último recurso, limite baixo). Se o formato vier diferente do
// esperado, devolve null e a cadeia segue — nunca afirma nada com base em campo que não reconhece.
function normalizarCnpjWs(dados) {
  const s = dados && dados.simples;
  if (!s || typeof s !== "object") return null;
  const simNao = (v) => (v === "Sim" || v === true ? true : v === "Não" || v === "Nao" || v === false ? false : null);
  return {
    fonte: "CNPJ.ws",
    razaoSocial: dados.razao_social || null,
    situacaoCadastral: (dados.estabelecimento && dados.estabelecimento.situacao_cadastral) || null,
    optanteSimples: simNao(s.simples),
    dataOpcaoSimples: s.data_opcao_simples || null,
    dataExclusaoSimples: s.data_exclusao_simples || null,
    optanteMei: simNao(s.mei),
    dataOpcaoMei: s.data_opcao_mei || null,
    dataExclusaoMei: s.data_exclusao_mei || null,
  };
}

const PROVEDORES_CNPJ = [
  { url: (c) => `https://brasilapi.com.br/api/cnpj/v1/${c}`, normalizar: (d) => normalizarMinhaReceita(d, "BrasilAPI") },
  { url: (c) => `https://minhareceita.org/${c}`, normalizar: (d) => normalizarMinhaReceita(d, "Minha Receita") },
  { url: (c) => `https://publica.cnpj.ws/cnpj/${c}`, normalizar: normalizarCnpjWs },
];

async function consultarCnpjPublico(env, cnpj) {
  // Cache de 24h no cache da própria Cloudflare (gratuito e sem limite diário), em vez do KV —
  // assim "Verificar exclusões" de muitas empresas não gasta as 1.000 gravações/dia do KV.
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const chaveCache = new Request(`https://cache.fzcont.interno/cnpj/v2/${cnpj}`);
  try {
    const emCache = cache && (await cache.match(chaveCache));
    if (emCache) return { ok: true, ...(await emCache.json()), doCache: true };
  } catch {}

  let viu429 = false;
  let todos404 = true;
  for (const provedor of PROVEDORES_CNPJ) {
    try {
      const resp = await fetch(provedor.url(cnpj), {
        headers: { Accept: "application/json", "User-Agent": "FZCONT/1.0 (consulta de optante pelo Simples Nacional)" },
        signal: AbortSignal.timeout(6000),
      });
      if (resp.status === 404) continue;
      todos404 = false;
      if (resp.status === 429) { viu429 = true; continue; }
      if (!resp.ok) continue;
      const dados = await resp.json().catch(() => null);
      const resultado = dados ? provedor.normalizar(dados) : null;
      if (!resultado) continue;

      resultado.consultadoEm = new Date().toISOString();
      try {
        if (cache) {
          await cache.put(chaveCache, new Response(JSON.stringify(resultado), {
            headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CNPJ_CACHE_TTL_SEGUNDOS}` },
          }));
        }
      } catch {}
      return { ok: true, ...resultado, doCache: false };
    } catch {
      todos404 = false; // timeout ou erro de rede: tenta a próxima fonte
    }
  }

  if (viu429) {
    return {
      ok: false,
      status: 429,
      erro:
        "As fontes públicas de CNPJ estão limitando as consultas agora (muitas requisições seguidas). " +
        "Aguarde cerca de 1 minuto e tente de novo — consultas já feitas ficam guardadas por 24h e não contam.",
    };
  }
  if (todos404) {
    return { ok: false, status: 404, erro: "CNPJ não encontrado na base pública (pode ser muito recente ou estar incorreto)." };
  }
  return { ok: false, status: 502, erro: "Não consegui consultar as fontes públicas agora. Tente de novo em instantes." };
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LINKS DE DOWNLOAD PARA O CLIENTE (WhatsApp)
// ---------------------------------------------------------------------------
// Validade: até o FIM do dia escolhido (23:59:59, horário de Brasília). "dias" fica por compatibilidade.
function calcularValidadeLink(ate, dias) {
  if (typeof ate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ate)) {
    const expiraMs = Date.parse(`${ate}T23:59:59-03:00`);
    if (!Number.isFinite(expiraMs)) return { erro: "Data de validade inválida." };
    if (expiraMs <= Date.now()) return { erro: "A data de validade precisa ser hoje ou depois." };
    if (expiraMs - Date.now() > 366 * 86400000) return { erro: "A validade máxima é de 1 ano." };
    return { expiraMs };
  }
  return { expiraMs: Date.now() + Math.min(Math.max(Number(dias) || 7, 1), 366) * 86400000 };
}

function idsAnexosValidos(anexoIds) {
  return Array.isArray(anexoIds) ? [...new Set(anexoIds.filter((x) => typeof x === "string" && /^[\w-]{8,64}$/.test(x)))] : [];
}

async function criarLinkCompartilhado(env, { ids, titulo, expiraMs, username, origem }) {
  if (!ids.length) return { erro: "Nenhum arquivo para compartilhar.", status: 400 };
  if (ids.length > 50) return { erro: "Máximo de 50 arquivos por link.", status: 400 };
  const arquivos = [];
  for (const id of ids) {
    const head = await env.ANEXOS_R2.head(`anexos/${id}`);
    if (head) arquivos.push({ id, nome: head.customMetadata?.nome || id, tamanho: head.size || 0 });
  }
  if (!arquivos.length) return { erro: "Os arquivos não foram encontrados no armazenamento (talvez tenham sido apagados).", status: 404 };
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""); // 48 caracteres, impossível de adivinhar
  const expiraEm = new Date(expiraMs).toISOString();
  await env.SFC_KV.put(
    `link:${token}`,
    JSON.stringify({ titulo: String(titulo || "").slice(0, 200), arquivos, criadoEm: new Date().toISOString(), criadoPor: username, expiraEm }),
    { expirationTtl: Math.max(60, Math.ceil((expiraMs - Date.now()) / 1000)) }
  );
  return { url: `${origem}/d/${token}`, expiraEm, arquivos: arquivos.length };
}


// ---------------------------------------------------------------------------
// ROBÔS DO ESCRITÓRIO (Agente Prumo num computador do escritório)
// Tudo fica numa chave só ("robo:estado") para que cada "tem tarefa?" do agente
// custe UMA leitura no KV. Gravações só quando algo muda (ou o "visto" envelhece).
// ---------------------------------------------------------------------------
const ROBO_VISTO_GRAVA_MS = 10 * 60 * 1000;   // atualiza "visto há…" no máximo a cada 10 min
const ROBO_TAREFA_PRESA_MS = 15 * 60 * 1000;  // tarefa "em andamento" sem resposta vira "interrompida"
const ROBO_MAX_TAREFAS = 200;

async function lerEstadoRobos(env) {
  const e = (await env.SFC_KV.get("robo:estado", "json")) || {};
  return { ...e, robos: e.robos || [], tarefas: e.tarefas || [] };
}
async function gravarEstadoRobos(env, estado) {
  estado.tarefas = estado.tarefas.slice(-ROBO_MAX_TAREFAS);
  await env.SFC_KV.put("robo:estado", JSON.stringify(estado));
}
async function sha256Hex(texto) {
  return bufParaHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto)));
}
// tarefas que ficaram "em andamento" sem resposta: NÃO voltam sozinhas para a fila
// (poderia emitir nota em duplicidade) — ficam "interrompida" para alguém conferir.
function marcarTarefasPresas(estado) {
  let mudou = false;
  const agora = Date.now();
  for (const t of estado.tarefas) {
    if (t.status === "em_andamento" && agora - Date.parse(t.iniciadoEm || 0) > ROBO_TAREFA_PRESA_MS) {
      Object.assign(t, { status: "interrompida", mensagem: "O robô parou de responder no meio da tarefa. Confira no portal se a nota saiu antes de mandar de novo.", finalizadoEm: new Date().toISOString() });
      mudou = true;
    }
  }
  return mudou;
}
function roboPublico(r) {
  return { id: r.id, nome: r.nome, criadoEm: r.criadoEm, vistoEm: r.vistoEm || null, versao: r.versao || null, emitentesComSenha: r.emitentesComSenha || [], online: !!r.vistoEm && Date.now() - Date.parse(r.vistoEm) < ROBO_VISTO_GRAVA_MS + 5 * 60 * 1000 };
}
function tarefaPublica(t) {
  const { dados, ...resto } = t;
  return { ...resto, resumo: t.tipo === "nfae" && dados ? { cliente: dados.cliente?.nome || dados.cliente?.razao_social, cnpj: dados.cliente?.cnpj, itens: (dados.itens || []).length, total: (dados.itens || []).reduce((s, i) => s + (Number(i.qtd) || 0) * valorBr(i.valor), 0), emitenteId: dados.emitenteId } : null };
}
function valorBr(v) {
  const t = String(v ?? "").trim();
  if (!t) return 0;
  return Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t) || 0;
}
async function roboDaRequisicao(request, env, estado) {
  const auth = request.headers.get("Authorization") || "";
  const token = /^Bearer ([a-f0-9]{64})$/.exec(auth)?.[1];
  if (!token) return null;
  const h = await sha256Hex(token);
  return estado.robos.find((r) => r.tokenHash === h) || null;
}
// valida o pedido de NFA-e antes de mandar ao robô (o robô transmite sozinho!)
function validarPedidoNfae(d, cadastros) {
  const erros = [];
  const emitente = (cadastros.emitentes || []).find((e) => e.id === d.emitenteId);
  if (!emitente) erros.push("Escolha o emitente (login da Receita-PR).");
  const c = d.cliente || {};
  const cnpj = String(c.cnpj || "").replace(/\D/g, "");
  if (cnpj.length !== 14 || !cnpjValido(cnpj)) erros.push("CNPJ do destinatário inválido.");
  if (!String(c.ie || "").replace(/\D/g, "")) erros.push("Falta a inscrição estadual do destinatário.");
  for (const campo of ["nome", "cep", "logradouro", "numero", "bairro", "municipio"]) if (!String(c[campo] || "").trim() && !(campo === "nome" && c.razao_social)) erros.push(`Falta “${campo}” do destinatário.`);
  const itens = Array.isArray(d.itens) ? d.itens : [];
  if (!itens.length) erros.push("Adicione pelo menos um produto.");
  if (itens.length > 60) erros.push("No máximo 60 produtos por nota.");
  itens.forEach((i, n) => {
    if (!String(i.codigo || "").trim() || !String(i.descricao || "").trim()) erros.push(`Produto ${n + 1}: falta código ou descrição.`);
    if (!/^\d{8}$/.test(String(i.ncm || "").replace(/\D/g, ""))) erros.push(`Produto ${n + 1}: NCM precisa ter 8 números.`);
    if (!(Number(i.qtd) > 0)) erros.push(`Produto ${n + 1}: quantidade precisa ser maior que zero.`);
    if (!(valorBr(i.valor) > 0)) erros.push(`Produto ${n + 1}: valor precisa ser maior que zero.`);
  });
  return { erros, emitente };
}

// ---------------------------------------------------------------------------
// NFS-e — IPM / Atende.Net (Campo Mourão). Manual: NTE 35/2021 v2.9.
// Consulta por número + série + cadastro econômico; login = CPF/CNPJ do emissor + senha
// do portal; o webservice é síncrono (uma requisição por vez) e reaproveita a sessão (PHPSESSID).
// ---------------------------------------------------------------------------
const IPM_MUNICIPIO_PADRAO = "campomourao";
const IPM_MAX_NOTAS_POR_CHAMADA = 15; // o plano gratuito permite 50 consultas externas por chamada

// Endereços do webservice. O manual traz o primeiro; em algumas cidades a IPM usa o segundo
// (ws-cidade.atende.net). Se o primeiro negar o acesso, o sistema tenta o outro.
// Para fixar um endereço, crie a variável IPM_URL no Worker.
function municipioIpm(env, pedido) {
  const m = String(pedido || env.IPM_MUNICIPIO || IPM_MUNICIPIO_PADRAO).toLowerCase().replace(/[^a-z0-9]/g, "");
  return /^[a-z]{3,40}$/.test(m) ? m : IPM_MUNICIPIO_PADRAO; // só o nome da cidade: o endereço é sempre *.atende.net
}
function urlsWebserviceIpm(env, municipio) {
  if (env.IPM_URL && municipio === municipioIpm(env)) return [String(env.IPM_URL)];
  return [
    `https://${municipio}.atende.net/?pg=rest&service=WNERestServiceNFSe`,
    `https://ws-${municipio}.atende.net/?pg=rest&service=WNERestServiceNFSe`,
  ];
}

// Resposta {"retorno":{"msg":"Acesso Negado!","sis":"EST","code":401}}: a própria plataforma
// Atende.Net recusou o login (antes de chegar no módulo de NFS-e).
function acessoNegadoIpm(texto, http) {
  const t = String(texto || "").trim();
  if (t.startsWith("{")) {
    try {
      const r = JSON.parse(t).retorno || {};
      if (Number(r.code) === 401 || /acesso negado/i.test(r.msg || "")) return { codigo: 401, texto: r.msg || "Acesso Negado!" };
    } catch {}
  }
  if (http === 401 || /acesso negado/i.test(t.slice(0, 300))) return { codigo: 401, texto: "Acesso Negado!" };
  return null;
}

function tagXml(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}\\s*>`, "i").exec(xml || "");
  return m ? m[1].trim() : "";
}
function blocosXml(xml, tag) {
  return [...String(xml || "").matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}\\s*>`, "gi"))].map((m) => m[1]);
}
function valorIpm(s) {
  const t = String(s || "").trim();
  if (!t) return 0;
  // o manual usa vírgula como decimal ("1.234,56"); aceita também "1234.56"
  const n = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
  return Number(n) || 0;
}

function decodificarRespostaIpm(bytes, contentType) {
  const cabeca = new TextDecoder("latin1").decode(bytes.slice(0, 200));
  const charset = (/charset=([\w-]+)/i.exec(contentType || "") || /encoding=["']([\w-]+)["']/i.exec(cabeca) || [])[1] || "utf-8";
  const rotulo = /8859-1|latin/i.test(charset) ? "windows-1252" : charset;
  try { return new TextDecoder(rotulo).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

function mensagensIpm(xml) {
  return blocosXml(xml, "mensagem").flatMap((b) => blocosXml(b, "codigo")).map((c) => {
    const m = /^\s*0*(\d+)\s*-\s*([\s\S]*)$/.exec(c);
    return m ? { codigo: Number(m[1]), texto: m[2].trim() } : { codigo: null, texto: c.trim() };
  });
}

function dicaErroIpm(codigo, texto, municipio = IPM_MUNICIPIO_PADRAO) {
  if (codigo === 401) return `A prefeitura recusou o login antes de olhar as notas. Confira, nesta ordem: (1) entre em ${municipio}.atende.net com o mesmo login e a mesma senha cadastrados aqui (login = CNPJ só com números, ou o campo “Login prefeitura” se a empresa entra com CPF); se não entrar, a senha está errada ou vencida; (2) no Autoatendimento, menu Empresa → “Emissão de NFS-e por WebService” → Acessar → marque “Liberar Acesso ao Usuário” e confirme (se já estava marcado, desmarque, confirme e marque de novo); (3) se trocou a senha do portal, atualize também aqui.`;
  if (codigo === 132) return "Usuário ou senha inválidos. O login é o CNPJ da empresa e a senha é a do portal da prefeitura (campo “Senha Prefeitura”).";
  if (codigo === 133) return "O usuário dessa empresa está desativado no portal da prefeitura.";
  if ([137, 138, 139].includes(codigo)) return "O webservice não está liberado para essa empresa. No Portal do Cidadão da prefeitura, abra o serviço “Emissão de NFS-e por WebService”, marque “Liberar Acesso ao Usuário” e confirme.";
  if ([134, 135, 4, 41, 111].includes(codigo)) return "A prefeitura não encontrou o cadastro econômico dessa empresa. Confira o número do cadastro econômico (inscrição municipal) nos dados da empresa.";
  if ([5, 207].includes(codigo)) return "Esse usuário não tem permissão para consultar as notas desse cadastro. Use o login da própria empresa e confira o cadastro econômico.";
  if (codigo === 144) return "O login precisa ter só números (o CNPJ sem pontos).";
  if (codigo === 6) return "A empresa está baixada no cadastro da prefeitura.";
  if (/senha|usu[áa]rio/i.test(texto || "")) return "Confira o CNPJ e a senha do portal da prefeitura.";
  return null;
}

// Lê os campos que interessam do XML completo da nota (layout 4.1 + tags do item 4.7 do manual).
function lerNotaIpm(xml) {
  const nf = tagXml(xml, "nf") || xml;
  const tomador = tagXml(xml, "tomador");
  const prestador = tagXml(xml, "prestador");
  const itens = blocosXml(xml, "item");
  const somaItens = (tag) => itens.reduce((s, it) => s + valorIpm(tagXml(it, tag)), 0);
  return {
    numero: tagXml(xml, "numero_nfse"),
    serie: tagXml(xml, "serie_nfse"),
    data: tagXml(xml, "data_nfse"),
    hora: tagXml(xml, "hora_nfse"),
    cancelada: tagXml(xml, "situacao_codigo_nfse") === "2" || /cancelad/i.test(tagXml(xml, "situacao_descricao_nfse")),
    situacao: tagXml(xml, "situacao_descricao_nfse"),
    valorTotal: valorIpm(tagXml(nf, "valor_total")),
    issRetido: somaItens("valor_issrf"),
    valorTributavel: somaItens("valor_tributavel"),
    servicos: [...new Set(itens.map((it) => tagXml(it, "codigo_item_lista_servico")).filter(Boolean))],
    prestadorCnpj: tagXml(prestador, "cpfcnpj"),
    tomadorCnpj: tagXml(tomador, "cpfcnpj"),
    tomadorNome: tagXml(tomador, "nome_razao_social"),
    codigoVerificador: tagXml(xml, "cod_verificador_autenticidade"),
    link: tagXml(xml, "link_nfse"),
  };
}

// Limite da IPM: "Limite de requisições (6) por segundo do serviço foi expirado" (código 000989).
// Espaçamos as consultas e, se mesmo assim o limite estourar, esperamos e tentamos de novo.
const IPM_INTERVALO_MS = 400;          // ~2,5 por segundo por chamada (o navegador consulta 2 empresas por vez)
const IPM_ESPERAS_LIMITE_MS = [1200, 2500, 4000];
function limiteIpm(texto) {
  const t = String(texto || "").slice(0, 400);
  return /limite de requisi/i.test(t) || /"code"\s*:\s*"?0*989"?/.test(t);
}
let _ultimaConsultaIpm = 0;
async function consultarNotaIpm(env, dados) {
  for (let tentativa = 0; ; tentativa++) {
    const falta = _ultimaConsultaIpm + IPM_INTERVALO_MS - Date.now();
    if (falta > 0) await esperar(falta);
    _ultimaConsultaIpm = Date.now();
    const r = await consultarNotaIpmUmaVez(env, dados);
    if (!limiteIpm(r.texto) || tentativa >= IPM_ESPERAS_LIMITE_MS.length) return { ...r, limite: limiteIpm(r.texto) };
    await esperar(IPM_ESPERAS_LIMITE_MS[tentativa]);
  }
}

async function consultarNotaIpmUmaVez(env, { url, login, senha, cadastro, serie, numero, cookie }) {
  const xmlPesquisa = `<?xml version="1.0" encoding="ISO-8859-1"?><nfse><pesquisa><numero>${numero}</numero><serie_nfse>${serie}</serie_nfse><cadastro>${cadastro}</cadastro></pesquisa></nfse>`;
  const form = new FormData();
  form.append("xml", new Blob([xmlPesquisa], { type: "text/xml" }), "consulta.xml");
  const headers = { Authorization: "Basic " + Buffer.from(`${login}:${senha}`, "utf8").toString("base64") };
  if (cookie) headers.Cookie = cookie;
  const resp = await fetch(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(25000) });
  const sessao = /PHPSESSID=[^;,\s]+/.exec(resp.headers.get("set-cookie") || "");
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const texto = decodificarRespostaIpm(bytes, resp.headers.get("content-type"));
  return { http: resp.status, cookie: sessao ? sessao[0] : cookie, texto, bytes };
}

// Página pública que o cliente abre pelo link do WhatsApp (sem login).
function paginaDownload(registro, token) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tamanho = (b) => (!b ? "" : b > 1048576 ? (b / 1048576).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
  const dataBR = (iso) => { try { return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }); } catch { return ""; } };
  const icone = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>';
  const baixar = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';
  const corpo = registro
    ? `<h1>Seus documentos</h1>
       ${registro.titulo ? `<p class="sub">${esc(registro.titulo)}</p>` : ""}
       <div class="lista">${registro.arquivos.map((a, i) => `
         <a class="arq" href="/d/${token}/${i}" download>
           <span class="ic">${icone}</span>
           <span class="nome"><b>${esc(a.nome)}</b><small>${tamanho(a.tamanho)}</small></span>
           <span class="bt">${baixar}<span>Baixar</span></span>
         </a>`).join("")}</div>
       <p class="val">Link disponível até ${esc(dataBR(registro.expiraEm))}.</p>`
    : `<h1>Link expirado</h1><p class="sub">Este link não está mais disponível. Peça um novo ao escritório.</p>`;
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>FZ CONT · Documentos</title><link rel="icon" href="/img/logo-mark.png">
<style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#F4F6FA;color:#232A4A;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px}
.c{width:100%;max-width:520px;background:#fff;border:1.3px solid #E4E7F0;border-radius:18px;padding:26px 22px;box-shadow:0 10px 30px rgba(23,27,51,.08)}
.topo{display:flex;align-items:center;gap:10px;margin-bottom:20px;font-weight:800;letter-spacing:.02em}.topo img{width:34px;height:34px}
h1{font-size:21px;margin:0 0 4px}.sub{color:#5B6285;margin:0 0 18px;font-size:14px;line-height:1.5}
.lista{display:flex;flex-direction:column;gap:8px}
.arq{display:flex;align-items:center;gap:12px;padding:12px;border:1.3px solid #E4E7F0;border-radius:12px;text-decoration:none;color:inherit;transition:border-color .15s}
.arq:hover{border-color:#0B84C0}.ic{width:40px;height:40px;border-radius:10px;background:#FDEDED;color:#DC2626;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.nome{flex:1;min-width:0}.nome b{display:block;font-size:14px;overflow-wrap:anywhere}.nome small{color:#8A90AE;font-size:12px}
.bt{display:flex;align-items:center;gap:6px;background:#0B84C0;color:#fff;font-weight:700;font-size:13px;padding:8px 12px;border-radius:9px;flex-shrink:0}
.val{color:#8A90AE;font-size:12.5px;margin:18px 0 0;text-align:center}
@media(max-width:420px){.bt span{display:none}}
</style></head><body><main class="c"><div class="topo"><img src="/img/logo-mark.png" alt="">FZ CONT</div>${corpo}</main></body></html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // ---------- CADASTRO PÚBLICO: só existe enquanto o sistema não tem nenhum usuário ----------
      // (primeiro acesso). Depois disso, contas novas só são criadas por quem já está logado
      // (menu Usuários) — antes qualquer pessoa na internet podia criar conta e ver os dados.
      if (pathname === "/api/auth/pode-cadastrar" && request.method === "GET") {
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        return json({ cadastroAberto: usuarios.length === 0 });
      }

      if (pathname === "/api/auth/cadastro" && request.method === "POST") {
        const existentes = (await env.SFC_KV.get("users", "json")) || [];
        if (existentes.length) {
          return json({ erro: "O cadastro pela tela de login está fechado. Peça a quem já usa o sistema para criar seu acesso no menu Usuários." }, 403);
        }
        const { username, password, nome, email } = await request.json();
        if (!username || !password || password.length < SENHA_MINIMA) {
          return json({ erro: "Usuário e senha (mín. 8 caracteres) são obrigatórios." }, 400);
        }
        if (!emailValido(email)) {
          return json({ erro: "Informe um e-mail válido." }, 400);
        }
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        if (usuarios.some((u) => u.username === username)) {
          return json({ erro: "Esse usuário já existe. Escolha outro nome de usuário." }, 400);
        }
        const { hash, salt } = await hashSenha(password);
        usuarios.push({ username, nome: nome || username, email, hash, salt, confirmado: false });
        await env.SFC_KV.put("users", JSON.stringify(usuarios));

        const token = crypto.randomUUID();
        await env.SFC_KV.put(`confirm:${token}`, JSON.stringify({ username }), {
          expirationTtl: CONFIRMACAO_TTL_SEGUNDOS,
        });
        try {
          await enviarEmailConfirmacao(env, url.origin, email, nome || username, token);
        } catch (err) {
          return json({ ok: true, emailFalhou: true, erroEmail: err.message });
        }
        return json({ ok: true, emailFalhou: false });
      }

      // ---------- REENVIAR CONFIRMAÇÃO (para contas antigas sem e-mail, ou links expirados) ----------
      if (pathname === "/api/auth/reenviar-confirmacao" && request.method === "POST") {
        const { username, email } = await request.json();
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        const usuario = usuarios.find((u) => u.username === username);
        if (!usuario) return json({ erro: "Usuário não encontrado." }, 404);
        if (usuario.confirmado) {
          return json({ erro: "Essa conta já está confirmada. Tente entrar normalmente." }, 400);
        }
        // Sem login, só dá para INFORMAR um e-mail em conta antiga que não tinha nenhum;
        // trocar o e-mail de uma conta pendente por aqui permitiria desviar o link de confirmação.
        if (email && !usuario.email) {
          if (!emailValido(email)) return json({ erro: "Informe um e-mail válido." }, 400);
          usuario.email = email;
          await env.SFC_KV.put("users", JSON.stringify(usuarios));
        }
        if (!usuario.email) {
          return json({ erro: "Informe um e-mail para receber o link de confirmação." }, 400);
        }
        const token = crypto.randomUUID();
        await env.SFC_KV.put(`confirm:${token}`, JSON.stringify({ username }), {
          expirationTtl: CONFIRMACAO_TTL_SEGUNDOS,
        });
        try {
          await enviarEmailConfirmacao(env, url.origin, usuario.email, usuario.nome || username, token);
        } catch (err) {
          return json({ ok: true, emailFalhou: true, erroEmail: err.message });
        }
        return json({ ok: true, emailFalhou: false });
      }

      // ---------- LOGIN ----------
      if (pathname === "/api/auth/login" && request.method === "POST") {
        const { username, password } = await request.json();
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        const usuario = usuarios.find((u) => u.username === username);
        if (!usuario || !(await conferirSenha(password, usuario.hash, usuario.salt))) {
          return json({ erro: "Usuário ou senha inválidos." }, 401);
        }
        if (usuario.bloqueado) {
          return json({ erro: "Seu acesso está bloqueado. Fale com o responsável pelo sistema no escritório.", bloqueado: true }, 403);
        }
        if (!usuario.confirmado) {
          return json(
            {
              erro: "Sua conta ainda não foi confirmada por e-mail.",
              naoConfirmado: true,
              temEmail: !!usuario.email,
            },
            403
          );
        }
        const token = crypto.randomUUID();
        await gravarSessao(env, token, username);
        return new Response(JSON.stringify({ ok: true, nome: usuario.nome }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": cookieDeSessao(token, SESSION_COOKIE_SEGUNDOS),
          },
        });
      }

      if (pathname === "/api/auth/logout" && request.method === "POST") {
        const cookies = lerCookies(request);
        const token = cookies[SESSION_COOKIE];
        if (token) await env.SFC_KV.delete(`session:${token}`);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": cookieDeSessao("", 0),
          },
        });
      }

      if (pathname === "/api/session" && request.method === "GET") {
        const username = await usuarioLogado(request, env);
        return json({ logado: !!username, username });
      }

      if (pathname === "/api/auth/confirmar" && request.method === "GET") {
        const token = url.searchParams.get("token");
        const registro = token ? await env.SFC_KV.get(`confirm:${token}`, "json") : null;
        const paginaHtml = (titulo, mensagem, sucesso) => `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
          <title>${titulo}</title>
          <style>body{font-family:system-ui,sans-serif;background:#f4f5fa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
          .c{background:#fff;padding:36px;border-radius:16px;max-width:400px;text-align:center;box-shadow:0 12px 32px rgba(30,34,51,.14)}
          h1{font-size:18px;color:${sucesso ? "#16a34a" : "#dc2626"}}
          a{color:#4f46e5;font-weight:600;text-decoration:none}</style></head>
          <body><div class="c"><h1>${titulo}</h1><p>${mensagem}</p><a href="/">Ir para o login</a></div></body></html>`;

        if (!registro) {
          return new Response(paginaHtml("Link inválido ou expirado", "Peça um novo link na tela de login.", false), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
            status: 400,
          });
        }
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        const usuario = usuarios.find((u) => u.username === registro.username);
        if (usuario) usuario.confirmado = true;
        await env.SFC_KV.put("users", JSON.stringify(usuarios));
        await env.SFC_KV.delete(`confirm:${token}`);
        return new Response(paginaHtml("E-mail confirmado! ✓", "Sua conta está liberada. Já pode fazer login normalmente.", true), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // ---------- ESQUECI MINHA SENHA ----------
      // A resposta é sempre a mesma, exista ou não o usuário — assim ninguém usa esta tela
      // para descobrir quais logins/e-mails existem no sistema.
      if (pathname === "/api/auth/esqueci" && request.method === "POST") {
        const { identificador } = await request.json().catch(() => ({}));
        const id = String(identificador || "").trim().toLowerCase();
        const mensagem = "Se esse usuário ou e-mail estiver cadastrado, enviamos um link para criar uma nova senha. Confira o e-mail (e o spam). O link vale por 1 hora.";
        if (!id) return json({ erro: "Informe seu usuário ou e-mail." }, 400);
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        const usuario = usuarios.find((u) => String(u.username).toLowerCase() === id || String(u.email || "").toLowerCase() === id);
        try { await pedirRedefinicao(env, url.origin, usuario); } catch { /* falha de e-mail não muda a resposta */ }
        return json({ ok: true, mensagem });
      }

      if (pathname === "/api/auth/redefinir" && request.method === "GET") {
        const token = url.searchParams.get("token") || "";
        const reg = /^[a-f0-9]{48}$/.test(token) ? await env.SFC_KV.get(`redefinir:${token}`, "json") : null;
        return json({ valido: !!reg, usuario: reg ? reg.username : null });
      }

      if (pathname === "/api/auth/redefinir" && request.method === "POST") {
        const { token, senha } = await request.json().catch(() => ({}));
        const reg = /^[a-f0-9]{48}$/.test(String(token || "")) ? await env.SFC_KV.get(`redefinir:${token}`, "json") : null;
        if (!reg) return json({ erro: "Esse link expirou ou já foi usado. Peça um novo em “Esqueci minha senha”." }, 400);
        if (typeof senha !== "string" || senha.length < SENHA_MINIMA) return json({ erro: `A nova senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.` }, 400);
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        const usuario = usuarios.find((u) => u.username === reg.username);
        if (!usuario || usuario.bloqueado) return json({ erro: "Não foi possível trocar a senha desse usuário. Fale com o responsável pelo sistema." }, 400);
        const { hash, salt } = await hashSenha(senha);
        Object.assign(usuario, { hash, salt, confirmado: true, senhaTrocadaEm: new Date().toISOString() }); // o link chegou no e-mail dele: e-mail confirmado
        await env.SFC_KV.put("users", JSON.stringify(usuarios));
        await env.SFC_KV.delete(`redefinir:${token}`);
        await encerrarSessoesDe(env, usuario.username); // quem estava logado com a senha antiga sai
        return json({ ok: true, usuario: usuario.username });
      }

      // ---------- LINK PÚBLICO DE DOWNLOAD (enviado ao cliente pelo WhatsApp) ----------
      // Não exige login: quem tem o link baixa SÓ os arquivos daquele envio, até a data de validade.
      if (pathname.startsWith("/d/") && request.method === "GET") {
        const partes = pathname.slice(3).split("/");
        const token = partes[0];
        const registro = /^[a-f0-9]{40,64}$/.test(token) ? await env.SFC_KV.get(`link:${token}`, "json") : null;
        const cabecalhosSeguros = {
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        };
        if (!registro || (registro.expiraEm && Date.parse(registro.expiraEm) < Date.now())) {
          return new Response(paginaDownload(null), { status: 404, headers: { ...cabecalhosSeguros, "Content-Type": "text/html; charset=utf-8" } });
        }
        if (partes.length === 1 || partes[1] === "") {
          return new Response(paginaDownload(registro, token), { headers: { ...cabecalhosSeguros, "Content-Type": "text/html; charset=utf-8" } });
        }
        const indice = Number(partes[1]);
        const arquivo = Number.isInteger(indice) ? registro.arquivos[indice] : null;
        if (!arquivo) return new Response("Arquivo não encontrado.", { status: 404, headers: cabecalhosSeguros });
        const obj = await env.ANEXOS_R2.get(`anexos/${arquivo.id}`);
        if (!obj) return new Response("Esse arquivo não está mais disponível.", { status: 404, headers: cabecalhosSeguros });
        const headers = new Headers(cabecalhosSeguros);
        obj.writeHttpMetadata(headers);
        const nome = arquivo.nome || obj.customMetadata?.nome || "arquivo";
        const ascii = nome.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.\- ]+/g, "_");
        headers.set("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nome)}`);
        return new Response(obj.body, { headers });
      }

      // ---------- AGENTE PRUMO (computador do escritório) — autenticado pela chave da máquina ----------
      if (pathname === "/api/robo/vincular" && request.method === "POST") {
        const { codigo, nome } = await request.json().catch(() => ({}));
        const cod = String(codigo || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const reg = cod.length === 6 ? await env.SFC_KV.get(`robo-codigo:${cod}`, "json") : null;
        if (!reg) return json({ erro: "Código inválido ou vencido. Gere um novo no Prumo (NFA-e → Robôs → Vincular computador)." }, 400);
        await env.SFC_KV.delete(`robo-codigo:${cod}`); // código vale uma vez só
        const token = bufParaHex(crypto.getRandomValues(new Uint8Array(32)));
        const estado = await lerEstadoRobos(env);
        const robo = { id: crypto.randomUUID(), nome: String(nome || "Computador do escritório").slice(0, 60), tokenHash: await sha256Hex(token), criadoEm: new Date().toISOString(), criadoPor: reg.username, vistoEm: new Date().toISOString(), emitentesComSenha: [] };
        estado.robos.push(robo);
        await gravarEstadoRobos(env, estado);
        return json({ token, robo: roboPublico(robo) });
      }

      // Um pedido por ciclo: avisa que está vivo, conta quais senhas tem e recebe a próxima tarefa
      if (pathname === "/api/robo/ciclo" && request.method === "POST") {
        const estado = await lerEstadoRobos(env);
        const robo = await roboDaRequisicao(request, env, estado);
        if (!robo) return json({ erro: "Este computador não está vinculado (ou foi desvinculado no Prumo).", desvinculado: true }, 401);
        const corpo = await request.json().catch(() => ({}));
        let mudou = marcarTarefasPresas(estado);
        const agora = Date.now();
        const senhas = Array.isArray(corpo.emitentesComSenha) ? corpo.emitentesComSenha.filter((x) => typeof x === "string").slice(0, 50).sort() : robo.emitentesComSenha || [];
        if (!robo.vistoEm || agora - Date.parse(robo.vistoEm) > ROBO_VISTO_GRAVA_MS || JSON.stringify(senhas) !== JSON.stringify(robo.emitentesComSenha || []) || corpo.versao !== robo.versao) {
          Object.assign(robo, { vistoEm: new Date().toISOString(), emitentesComSenha: senhas, versao: String(corpo.versao || "").slice(0, 20) || null });
          mudou = true;
        }
        let tarefa = null;
        const ocupado = estado.tarefas.some((t) => t.status === "em_andamento" && t.roboId === robo.id);
        if (!ocupado && corpo.livre !== false) {
          tarefa = estado.tarefas.find((t) => t.status === "pendente");
          if (tarefa) { Object.assign(tarefa, { status: "em_andamento", roboId: robo.id, roboNome: robo.nome, iniciadoEm: new Date().toISOString() }); mudou = true; }
        }
        if (mudou) await gravarEstadoRobos(env, estado);
        let emitentes = undefined;
        if (corpo.querEmitentes || tarefa) {
          const cad = (await env.KV_EMPRESAS.get("nfae_cadastros", "json")) || {};
          emitentes = (cad.emitentes || []).map(({ id, nome, usuario }) => ({ id, nome, usuario }));
        }
        return json({ tarefa: tarefa ? { id: tarefa.id, tipo: tarefa.tipo, dados: tarefa.dados, criadoEm: tarefa.criadoEm } : null, emitentes, emitentesVersao: estado.emitentesVersao || 0, pendentes: estado.tarefas.filter((t) => t.status === "pendente").length });
      }

      // Resultado da tarefa (com PDF/XML/print da tela) — arquivos vão para o R2
      if (pathname === "/api/robo/resultado" && request.method === "POST") {
        const estado = await lerEstadoRobos(env);
        const robo = await roboDaRequisicao(request, env, estado);
        if (!robo) return json({ erro: "Não vinculado.", desvinculado: true }, 401);
        const corpo = await request.json().catch(() => ({}));
        const t = estado.tarefas.find((x) => x.id === corpo.tarefaId);
        if (!t || t.roboId !== robo.id) return json({ erro: "Tarefa não encontrada para este computador." }, 404);
        const arquivos = [];
        for (const a of (Array.isArray(corpo.arquivos) ? corpo.arquivos : []).slice(0, 6)) {
          const nome = String(a.nome || "arquivo").replace(/[^\w.\- ]+/g, "_").slice(0, 80);
          if (!a.base64 || a.base64.length > 14 * 1024 * 1024) continue;
          await env.ANEXOS_R2.put(`robo/${t.id}/${nome}`, Buffer.from(a.base64, "base64"), { httpMetadata: { contentType: String(a.tipo || "application/octet-stream") }, customMetadata: { nome } });
          arquivos.push({ nome, tipo: String(a.tipo || "") });
        }
        const ok = corpo.status === "concluida";
        Object.assign(t, {
          status: ok ? "concluida" : corpo.status === "conferir" ? "conferir" : "erro",
          mensagem: String(corpo.mensagem || (ok ? "Concluída." : "Falhou.")).slice(0, 1500),
          numeroNota: corpo.numeroNota ? String(corpo.numeroNota).slice(0, 30) : t.numeroNota || null,
          arquivos: [...(t.arquivos || []), ...arquivos],
          finalizadoEm: new Date().toISOString(),
        });
        robo.vistoEm = new Date().toISOString();
        await gravarEstadoRobos(env, estado);
        return json({ ok: true });
      }

      // A partir daqui, tudo exige login
      const username = await usuarioLogado(request, env);
      if (!username) return json({ erro: "Não autenticado." }, 401);

      // ---------- USUÁRIOS (adicionar novo funcionário) ----------
      if (pathname === "/api/users" && request.method === "GET") {
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        return json({ usuarios: usuarios.map((u) => ({ username: u.username, nome: u.nome, email: u.email, confirmado: !!u.confirmado, bloqueado: !!u.bloqueado, bloqueadoEm: u.bloqueadoEm || null, voce: u.username === username })) });
      }

      // ---------- BLOQUEAR / DESBLOQUEAR USUÁRIO ----------
      if (pathname === "/api/users/bloqueio" && request.method === "POST") {
        const { username: alvo, bloquear } = await request.json().catch(() => ({}));
        if (alvo === username) return json({ erro: "Você não pode bloquear o seu próprio acesso." }, 400);
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        const usuario = usuarios.find((u) => u.username === alvo);
        if (!usuario) return json({ erro: "Usuário não encontrado." }, 404);
        if (bloquear) {
          Object.assign(usuario, { bloqueado: true, bloqueadoEm: new Date().toISOString(), bloqueadoPor: username });
        } else {
          delete usuario.bloqueado; delete usuario.bloqueadoEm; delete usuario.bloqueadoPor;
        }
        await env.SFC_KV.put("users", JSON.stringify(usuarios));
        if (bloquear) await encerrarSessoesDe(env, alvo); // sai na hora de todos os aparelhos
        return json({ ok: true, bloqueado: !!bloquear });
      }

      // ---------- ENVIAR LINK DE NOVA SENHA PARA OUTRO USUÁRIO ----------
      if (pathname === "/api/users/enviar-redefinicao" && request.method === "POST") {
        const { username: alvo } = await request.json().catch(() => ({}));
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        const usuario = usuarios.find((u) => u.username === alvo);
        if (!usuario) return json({ erro: "Usuário não encontrado." }, 404);
        if (usuario.bloqueado) return json({ erro: "Esse usuário está bloqueado. Desbloqueie antes de enviar o link." }, 400);
        if (!usuario.email) return json({ erro: "Esse usuário não tem e-mail cadastrado." }, 400);
        try {
          const r = await pedirRedefinicao(env, url.origin, usuario);
          if (r.aguarde) return json({ erro: "Um link acabou de ser enviado para esse usuário. Espere 2 minutos para mandar outro." }, 429);
        } catch (err) {
          return json({ erro: "Não consegui enviar o e-mail: " + err.message }, 500);
        }
        return json({ ok: true, email: usuario.email });
      }

      // ---------- TROCAR A PRÓPRIA SENHA ----------
      if (pathname === "/api/users/minha-senha" && request.method === "POST") {
        const { atual, nova } = await request.json().catch(() => ({}));
        if (typeof nova !== "string" || nova.length < SENHA_MINIMA) return json({ erro: `A nova senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.` }, 400);
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        const usuario = usuarios.find((u) => u.username === username);
        if (!usuario || !(await conferirSenha(String(atual || ""), usuario.hash, usuario.salt))) return json({ erro: "A senha atual não confere." }, 400);
        const { hash, salt } = await hashSenha(nova);
        Object.assign(usuario, { hash, salt, senhaTrocadaEm: new Date().toISOString() });
        await env.SFC_KV.put("users", JSON.stringify(usuarios));
        await encerrarSessoesDe(env, username, lerCookies(request)[SESSION_COOKIE]); // derruba os outros aparelhos, mantém este
        return json({ ok: true });
      }

      if (pathname === "/api/users" && request.method === "POST") {
        const { username: novoUser, password, nome, email } = await request.json();
        if (!novoUser || !password || password.length < SENHA_MINIMA) {
          return json({ erro: "Usuário e senha (mín. 8 caracteres) são obrigatórios." }, 400);
        }
        if (!emailValido(email)) {
          return json({ erro: "Informe um e-mail válido." }, 400);
        }
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        if (usuarios.some((u) => u.username === novoUser)) {
          return json({ erro: "Esse usuário já existe." }, 400);
        }
        const { hash, salt } = await hashSenha(password);
        usuarios.push({ username: novoUser, nome: nome || novoUser, email, hash, salt, confirmado: false });
        await env.SFC_KV.put("users", JSON.stringify(usuarios));

        const token = crypto.randomUUID();
        await env.SFC_KV.put(`confirm:${token}`, JSON.stringify({ username: novoUser }), {
          expirationTtl: CONFIRMACAO_TTL_SEGUNDOS,
        });
        try {
          await enviarEmailConfirmacao(env, url.origin, email, nome || novoUser, token);
        } catch (err) {
          return json({ ok: true, emailFalhou: true, erroEmail: err.message });
        }
        return json({ ok: true, emailFalhou: false });
      }

      // ---------- INTEGRACONTADOR (SERPRO): status, certificado, SITFIS, CND ----------
      if (pathname === "/api/integracontador/status" && request.method === "GET") {
        return json({
          certificadoConfigurado: !!env.SERPRO_CERT,
          sitfisConfigurado: !!(env.SERPRO_CONSUMER_KEY && env.SERPRO_CONSUMER_SECRET && env.SERPRO_CONTRATANTE_CNPJ),
          cndConfigurado: !!(env.CND_CONSUMER_KEY && env.CND_CONSUMER_SECRET),
        });
      }

      if (pathname === "/api/integracontador/testar-credenciais-cf" && request.method === "GET") {
        if (!env.CF_API_TOKEN) return json({ ok: false, erro: "Secret CF_API_TOKEN não está configurado no Worker." });
        if (!env.CF_ACCOUNT_ID) return json({ ok: false, erro: "Secret CF_ACCOUNT_ID não está configurado no Worker." });

        // 1) O token em si é válido?
        const verif = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
          headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
        });
        const verifJson = await verif.json().catch(() => ({}));
        if (!verif.ok || !verifJson.success) {
          return json({
            ok: false,
            erro: "O CF_API_TOKEN é inválido, expirou ou foi digitado errado (talvez com espaço sobrando). Gere um novo token e cadastre de novo.",
            detalhe: JSON.stringify(verifJson.errors || verifJson).slice(0, 300),
          });
        }

        // 2) O token enxerga essa conta e tem permissão de certificados?
        const lista = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/mtls_certificates`, {
          headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
        });
        const listaJson = await lista.json().catch(() => ({}));
        if (!lista.ok || !listaJson.success) {
          return json({
            ok: false,
            erro:
              "O token é válido, mas não conseguiu acessar os certificados desta conta. Causas comuns: (a) falta a permissão 'Account → SSL and Certificates → Edit' no token, ou (b) o CF_ACCOUNT_ID não é o ID da conta correta.",
            detalhe: JSON.stringify(listaJson.errors || listaJson).slice(0, 300),
          });
        }

        return json({ ok: true, mensagem: "Token e Account ID estão corretos e com a permissão necessária. Pode subir o certificado." });
      }

      if (pathname === "/api/integracontador/certificado" && request.method === "POST") {
        const { certPem, keyPem, nome } = await request.json();
        if (!certPem || !keyPem) return json({ erro: "Certificado ou chave privada ausente." }, 400);
        if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
          return json({ erro: "Configure os secrets CF_API_TOKEN e CF_ACCOUNT_ID antes de subir o certificado." }, 500);
        }
        const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/mtls_certificates`, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ certificates: certPem, private_key: keyPem, name: nome || "serpro-integracontador", ca: false }),
        });
        const dados = await resp.json().catch(() => ({}));
        if (!resp.ok || !dados.success) {
          const codigos = (dados.errors || []).map((e) => e.code);
          if (codigos.includes(10000)) {
            return json({
              erro:
                "A Cloudflare recusou por falta de autenticação (erro 10000). Isso é do CF_API_TOKEN / CF_ACCOUNT_ID, não do seu certificado. " +
                "Clique em 'Testar credenciais Cloudflare' na página para descobrir qual dos dois está errado.",
            }, 400);
          }
          return json({ erro: "Cloudflare recusou o certificado: " + JSON.stringify(dados.errors || dados) }, 400);
        }
        return json({ ok: true, certificateId: dados.result.id });
      }

      if (pathname === "/api/integracontador/sitfis" && request.method === "POST") {
        const { cnpj, nomeEmpresa, protocolo } = await request.json().catch(() => ({}));
        if (!cnpj || !cnpjValido(limparNumeroDoc(cnpj))) {
          return json({ ok: false, etapa: "validacao", erro: cnpj ? "CNPJ inválido (confira os dígitos no cadastro da empresa)." : "CNPJ é obrigatório." }, 400);
        }
        try {
          const resultado = await buscarRelatorioSitfis(env, cnpj, { protocolo });
          if (resultado.ok) {
            try {
              await salvarRelatorioIntegraContador(env, { servico: "sitfis", cnpj, nomeEmpresa, bytesBase64: resultado.pdfBase64 });
            } catch (e) {
              resultado.avisoSalvar = "Baixou, mas não consegui guardar em 'Relatórios salvos': " + (e && e.message ? e.message : e);
            }
          }
          return json(resultado, resultado.ok ? 200 : resultado.processando ? 202 : 502);
        } catch (err) {
          return json({ ok: false, etapa: err.etapa || "interno", erro: err.message, dica: err.dica || null }, 500);
        }
      }

      if (pathname === "/api/integracontador/cnd" && request.method === "POST") {
        const { cnpj, nomeEmpresa } = await request.json().catch(() => ({}));
        if (!cnpj || !cnpjValido(limparNumeroDoc(cnpj))) {
          return json({ ok: false, etapa: "validacao", erro: cnpj ? "CNPJ inválido (confira os dígitos no cadastro da empresa)." : "CNPJ é obrigatório." }, 400);
        }
        try {
          const resultado = await buscarCnd(env, cnpj);
          if (resultado.ok) {
            try {
              await salvarRelatorioIntegraContador(env, { servico: "cnd", cnpj, nomeEmpresa, bytesBase64: resultado.pdfBase64 });
            } catch (e) {
              resultado.avisoSalvar = "Baixou, mas não consegui guardar em 'Relatórios salvos': " + (e && e.message ? e.message : e);
            }
          }
          return json(resultado, resultado.ok ? 200 : 502);
        } catch (err) {
          return json({ ok: false, etapa: err.etapa || "interno", erro: err.message, dica: err.dica || null }, 500);
        }
      }

      if (pathname === "/api/integracontador/relatorios" && request.method === "GET") {
        const indice = (await env.KV_EMPRESAS.get("integracontador_relatorios", "json")) || {};
        return json({ relatorios: indice });
      }

      if (pathname.startsWith("/api/integracontador/arquivo/") && request.method === "GET") {
        const partes = pathname.replace("/api/integracontador/arquivo/", "").split("/");
        const servico = partes[0];
        const cnpjLimpo = limparNumeroDoc(partes[1] || "");
        const obj = await env.ANEXOS_R2.get(`integracontador/${servico}/${cnpjLimpo}.pdf`);
        if (!obj) return json({ erro: "Esse relatório ainda não foi baixado pra essa empresa." }, 404);
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set("etag", obj.httpEtag);
        const nome = obj.customMetadata?.nome || cnpjLimpo;
        headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(servico.toUpperCase())}-${encodeURIComponent(nome)}.pdf"`);
        return new Response(obj.body, { headers });
      }

      if (pathname.startsWith("/api/integracontador/arquivo/") && request.method === "DELETE") {
        const partes = pathname.replace("/api/integracontador/arquivo/", "").split("/");
        const servico = partes[0];
        const cnpjLimpo = limparNumeroDoc(partes[1] || "");
        await env.ANEXOS_R2.delete(`integracontador/${servico}/${cnpjLimpo}.pdf`);
        const indice = (await env.KV_EMPRESAS.get("integracontador_relatorios", "json")) || {};
        if (indice[cnpjLimpo]) {
          delete indice[cnpjLimpo][servico];
          await env.KV_EMPRESAS.put("integracontador_relatorios", JSON.stringify(indice));
        }
        return json({ ok: true });
      }

      // ---------- CONSULTA PÚBLICA DE CNPJ (Simples Nacional / MEI) — sem certificado, com cache e fontes de reserva ----------
      if (pathname === "/api/consulta-cnpj" && request.method === "GET") {
        const cnpj = limparNumeroDoc(url.searchParams.get("cnpj") || "");
        if (cnpj.length !== 14) return json({ erro: "CNPJ inválido: precisa ter 14 dígitos." }, 400);
        if (!cnpjValido(cnpj)) {
          return json({ erro: "CNPJ inválido: os dígitos verificadores não conferem. Confira o cadastro da empresa." }, 400);
        }
        const resultado = await consultarCnpjPublico(env, cnpj);
        if (!resultado.ok) return json({ erro: resultado.erro }, resultado.status);
        const { ok, status, ...dados } = resultado;
        return json(dados);
      }

      // ---------- DADOS PRINCIPAIS (grupos/empresas/checklist/parcelamentos) ----------
      if (pathname === "/api/data" && request.method === "GET") {
        await migrarSeNecessario(env);
        const estado = await lerDadosCompletos(env);
        return json(estado);
      }

      if (pathname === "/api/data" && request.method === "POST") {
        const body = await request.json();
        await gravarDadosCompletos(env, body);
        return json({ ok: true, salvoEm: new Date().toISOString() });
      }

      // ---------- NOVA LISTA (reset mensal) ----------
      // Mantém nome + dados de acesso de cada empresa (cnpj, senhas, etc), mas zera status,
      // checkboxes, comentários e a LISTA de anexos (os arquivos em si continuam no R2, caso
      // algum período salvo ainda precise deles — use a lixeira em cada anexo pra apagar de vez).
      if (pathname === "/api/reset" && request.method === "POST") {
        const estado = await lerDadosCompletos(env);
        const novosGrupos = estado.grupos.map((g) => ({
          nome: g.nome,
          // Mantém todos os dados cadastrais (CNPJ, senhas, e-mail, WhatsApp, cadastro econômico...)
          // e zera só o que é do mês: status, checkboxes, comentários e anexos.
          empresas: g.empresas.map((e) => ({
            ...e,
            status: "SEM",
            nfs: false,
            nfe: false,
            nfc: false,
            fechado: false,
            comentarios: [],
            anexos: [],
          })),
        }));
        await gravarDadosCompletos(env, { grupos: novosGrupos, checklist: estado.checklist, parcelamentos: estado.parcelamentos });
        return json({ ok: true });
      }

      // ---------- PERÍODOS NOMEADOS (ex: "07-2026") — salvar e restaurar arquivos de períodos ----------
      if (pathname === "/api/periodos" && request.method === "GET") {
        const indice = (await env.KV_EMPRESAS.get("periodos_index", "json")) || [];
        return json({ periodos: indice });
      }

      if (pathname === "/api/periodos" && request.method === "POST") {
        const { nome } = await request.json();
        const nomeLimpo = (nome || "").trim();
        if (!nomeLimpo) return json({ erro: "Informe um nome para o período (ex: 07-2026)." }, 400);

        const estadoAtual = await lerDadosCompletos(env);
        await gravarDadosCompletos(env, estadoAtual, `periodo:${nomeLimpo}:`);

        const indice = (await env.KV_EMPRESAS.get("periodos_index", "json")) || [];
        const semEsse = indice.filter((p) => p.nome !== nomeLimpo);
        semEsse.unshift({ nome: nomeLimpo, criadoEm: new Date().toISOString() });
        await env.KV_EMPRESAS.put("periodos_index", JSON.stringify(semEsse));
        return json({ ok: true });
      }

      if (pathname === "/api/periodos/importar" && request.method === "POST") {
        const { nome } = await request.json();
        const nomeLimpo = (nome || "").trim();
        const existe = await env.KV_EMPRESAS.get(`periodo:${nomeLimpo}:dados`);
        if (!existe) return json({ erro: `Período "${nomeLimpo}" não encontrado.` }, 404);

        const estadoDoPeriodo = await lerDadosCompletos(env, `periodo:${nomeLimpo}:`);
        await gravarDadosCompletos(env, estadoDoPeriodo);
        return json({ ok: true });
      }

      if (pathname.startsWith("/api/periodos/") && request.method === "DELETE") {
        const nomeLimpo = decodeURIComponent(pathname.replace("/api/periodos/", ""));
        await env.KV_EMPRESAS.delete(`periodo:${nomeLimpo}:dados`);
        await env.KV_EMPRESAS.delete(`periodo:${nomeLimpo}:parcelamentos`);
        await env.KV_COMENTARIOS.delete(`periodo:${nomeLimpo}:checklist`);
        await env.KV_COMENTARIOS.delete(`periodo:${nomeLimpo}:comentariosEmpresas`);
        await env.KV_COMENTARIOS.delete(`periodo:${nomeLimpo}:comentariosParcelamentos`);
        const indice = (await env.KV_EMPRESAS.get("periodos_index", "json")) || [];
        await env.KV_EMPRESAS.put("periodos_index", JSON.stringify(indice.filter((p) => p.nome !== nomeLimpo)));
        return json({ ok: true });
      }

      // ---------- ENVIO DE E-MAIL (via Gmail, usando conexão TCP direta) ----------
      if (pathname === "/api/email" && request.method === "POST") {
        const { destinatario, assunto, mensagem, anexoIds, html, remetenteNome } = await request.json();
        if (!destinatario || !assunto) {
          return json({ erro: "Destinatário e assunto são obrigatórios." }, 400);
        }
        // O campo de e-mail da empresa pode ter vários endereços ("a@x.com, b@y.com").
        // O SMTP precisa recebê-los como lista, não como uma string única.
        const listaDestinatarios = String(destinatario)
          .split(/[,;\s]+/)
          .map((e) => e.trim())
          .filter(Boolean);
        if (!listaDestinatarios.length) {
          return json({ erro: "Nenhum e-mail válido informado." }, 400);
        }
        const invalidos = listaDestinatarios.filter((e) => !emailValido(e));
        if (invalidos.length) {
          return json({ erro: `E-mail(s) em formato inválido: ${invalidos.join(", ")}` }, 400);
        }
        if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
          return json(
            { erro: "E-mail não configurado. Rode: wrangler secret put GMAIL_USER / GMAIL_APP_PASSWORD" },
            500
          );
        }

        const attachments = [];
        let tamanhoTotal = 0;
        for (const id of anexoIds || []) {
          const obj = await env.ANEXOS_R2.get(`anexos/${id}`);
          if (!obj) continue;
          const bytes = await obj.arrayBuffer();
          tamanhoTotal += bytes.byteLength;
          if (tamanhoTotal > 20 * 1024 * 1024) {
            return json({ erro: "Os anexos somados passam de 20MB — o Gmail não aceita e-mails tão grandes. Remova algum anexo antes de enviar." }, 400);
          }
          attachments.push({
            filename: obj.customMetadata?.nome || id,
            content: Buffer.from(bytes).toString("base64"),
            mimeType: obj.httpMetadata?.contentType || "application/octet-stream",
          });
        }

        try {
          await WorkerMailer.send(
            {
              host: "smtp.gmail.com",
              port: 465,
              secure: true,
              authType: "login",
              credentials: { username: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD },
            },
            {
              from: { name: remetenteNome || "FZCONT", email: env.GMAIL_USER },
              to: listaDestinatarios,
              subject: assunto,
              text: html ? undefined : mensagem || "",
              html: html ? mensagem || "" : undefined,
              attachments: attachments.length ? attachments : undefined,
            }
          );
          return json({ ok: true, anexados: attachments.length });
        } catch (err) {
          return json({ erro: "Falha ao enviar e-mail: " + err.message }, 500);
        }
      }

      // ---------- CRIAR LINK DE DOWNLOAD PARA O CLIENTE (WhatsApp) ----------
      if (pathname === "/api/compartilhar" && request.method === "POST") {
        const { anexoIds, titulo, dias, ate } = await request.json().catch(() => ({}));
        const validade = calcularValidadeLink(ate, dias);
        if (validade.erro) return json({ erro: validade.erro }, 400);
        const r = await criarLinkCompartilhado(env, { ids: idsAnexosValidos(anexoIds), titulo, expiraMs: validade.expiraMs, username, origem: url.origin });
        if (r.erro) return json({ erro: r.erro }, r.status);
        return json(r);
      }

      // ---------- VÁRIOS LINKS DE UMA VEZ (envio em lote pelo WhatsApp) ----------
      // Uma chamada só para a fila inteira; cada item vira um link independente.
      if (pathname === "/api/compartilhar-lote" && request.method === "POST") {
        const { itens, dias, ate } = await request.json().catch(() => ({}));
        if (!Array.isArray(itens) || !itens.length) return json({ erro: "Nenhuma empresa selecionada." }, 400);
        if (itens.length > 100) return json({ erro: "Máximo de 100 empresas por lote." }, 400);
        const validade = calcularValidadeLink(ate, dias);
        if (validade.erro) return json({ erro: validade.erro }, 400);
        const resultados = [];
        for (const item of itens) {
          const r = await criarLinkCompartilhado(env, {
            ids: idsAnexosValidos(item && item.anexoIds), titulo: item && item.titulo,
            expiraMs: validade.expiraMs, username, origem: url.origin,
          });
          resultados.push({ chave: item && item.chave, ...(r.erro ? { erro: r.erro } : r) });
        }
        return json({ resultados, expiraEm: new Date(validade.expiraMs).toISOString() });
      }

      // ---------- NFS-e IPM (Atende.Net): consulta várias notas de uma empresa numa chamada ----------
      if (pathname === "/api/ipm/consultar" && request.method === "POST") {
        const corpo = await request.json().catch(() => ({}));
        const login = limparNumeroDoc(corpo.login || corpo.cnpj);
        const senha = String(corpo.senha || "");
        const cadastro = limparNumeroDoc(corpo.cadastro);
        const serie = limparNumeroDoc(corpo.serie) || "1";
        const numeros = [...new Set((Array.isArray(corpo.numeros) ? corpo.numeros : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 1e9))];
        if (!login || !senha) return json({ erro: "Faltam o CNPJ ou a senha do portal da prefeitura da empresa." }, 400);
        if (!cadastro) return json({ erro: "Falta o cadastro econômico (inscrição municipal) da empresa." }, 400);
        if (!numeros.length) return json({ erro: "Nenhum número de nota informado." }, 400);
        if (numeros.length > IPM_MAX_NOTAS_POR_CHAMADA) return json({ erro: `Máximo de ${IPM_MAX_NOTAS_POR_CHAMADA} notas por chamada.` }, 400);

        let cookie = null;
        const notas = [];
        const municipio = municipioIpm(env, corpo.municipio);
        const urls = urlsWebserviceIpm(env, municipio);
        let url = urls.includes(corpo.url) ? corpo.url : urls[0]; // o navegador lembra qual endereço funcionou
        let negado = null;
        const tentativas = [];
        for (const numero of numeros) {
          let r;
          try {
            r = await consultarNotaIpm(env, { url, login, senha, cadastro, serie, numero, cookie });
            // Acesso negado no primeiro pedido: tenta o outro endereço uma vez
            const recusa = !notas.length && acessoNegadoIpm(r.texto, r.http);
            if (recusa) {
              negado = recusa;
              tentativas.push(`${new URL(url).host} → acesso negado`);
              for (const alternativa of urls.filter((u) => u !== url)) {
                const host = new URL(alternativa).host;
                try {
                  const r2 = await consultarNotaIpm(env, { url: alternativa, login, senha, cadastro, serie, numero, cookie: null });
                  tentativas.push(`${host} → ${acessoNegadoIpm(r2.texto, r2.http) ? "acesso negado" : respostaValidaIpm(r2) ? "respondeu" : `não é o webservice (HTTP ${r2.http})`}`);
                  // só aceita se for uma resposta de verdade do webservice (XML da IPM);
                  // erro de conexão da Cloudflare (522, 52x) ou página qualquer não conta
                  if (respostaValidaIpm(r2) && !acessoNegadoIpm(r2.texto, r2.http)) { r = r2; url = alternativa; negado = null; break; }
                } catch (e) { tentativas.push(`${host} → sem conexão`); /* fica com o erro do primeiro */ }
              }
            }
          } catch (err) {
            return json({ erro: "Não consegui falar com o servidor da prefeitura: " + (err && err.message ? err.message : err), etapa: "conexao", notas }, 502);
          }
          if (r.limite) {
            return json({ erro: "A prefeitura está limitando a quantidade de consultas por segundo. O sistema esperou e tentou de novo, mas o limite continuou. Tente de novo em alguns segundos.", codigo: "limite", limite: true, etapa: "prefeitura", notas, url }, 429);
          }
          if (!negado && r.http >= 500) {
            return json({ erro: `O servidor da prefeitura não respondeu (HTTP ${r.http}${r.http >= 520 && r.http <= 526 ? " — a Cloudflare não conseguiu conectar" : ""}).`, codigo: r.http, dica: "Pode ser instabilidade no Atende.Net. Tente de novo em alguns minutos.", etapa: "conexao", notas, url }, 502);
          }
          if (negado || acessoNegadoIpm(r.texto, r.http)) {
            const recusa = negado || acessoNegadoIpm(r.texto, r.http);
            return json({ erro: `Prefeitura respondeu: acesso negado (login ${login.length === 14 ? "CNPJ" : "CPF"} ${login})${tentativas.length ? ` — endereços testados: ${tentativas.join("; ")}` : ""}`, codigo: 401, dica: dicaErroIpm(401, recusa.texto, municipio), etapa: "prefeitura", notas, url }, 502);
          }
          cookie = r.cookie;
          const mensagens = mensagensIpm(r.texto);
          const existe = /<numero_nfse>/i.test(r.texto) && !mensagens.some((m) => m.codigo === 142 || m.codigo === 206);
          if (existe) {
            notas.push({ numero, existe: true, dados: lerNotaIpm(r.texto), ...(corpo.comXml ? { xmlBase64: Buffer.from(r.bytes).toString("base64") } : {}) });
            continue;
          }
          // 142 (manual) e 206 (Campo Mourão responde assim): não existe nota com esse número
          const naoEncontrada = mensagens.some((m) => m.codigo === 142 || m.codigo === 206 || /n[ãa]o encontrad|nenhuma nfs-?e foi encontrada/i.test(m.texto));
          if (naoEncontrada) { notas.push({ numero, existe: false }); continue; }
          // Qualquer outro erro (login, permissão, cadastro) vale para todas as notas: para aqui.
          const principal = mensagens.find((m) => m.codigo !== 1) || { codigo: null, texto: r.texto.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || `HTTP ${r.http}` };
          return json({
            erro: `Prefeitura respondeu: ${principal.codigo ? `[${principal.codigo}] ` : ""}${principal.texto}`,
            codigo: principal.codigo,
            dica: dicaErroIpm(principal.codigo, principal.texto, municipio),
            etapa: "prefeitura",
            notas,
            url,
          }, 502);
        }
        return json({ notas, url });
      }

      // ---------- ANEXOS (upload/download/exclusão reais, guardados no bucket R2) ----------
      if (pathname === "/api/anexos" && request.method === "POST") {
        const { nome, tipo, dataB64 } = await request.json();
        if (!nome || !dataB64) return json({ erro: "Arquivo inválido." }, 400);
        if (dataB64.length > 130 * 1024 * 1024) {
          return json({ erro: "Arquivo grande demais (máximo ~95MB)." }, 400);
        }
        const id = crypto.randomUUID();
        const bytes = Buffer.from(dataB64, "base64");
        await env.ANEXOS_R2.put(`anexos/${id}`, bytes, {
          httpMetadata: { contentType: tipo || "application/octet-stream" },
          customMetadata: { nome },
        });
        return json({ id, nome, tipo: tipo || "application/octet-stream" });
      }

      if (pathname.startsWith("/api/anexos/") && request.method === "GET") {
        const id = pathname.replace("/api/anexos/", "");
        const obj = await env.ANEXOS_R2.get(`anexos/${id}`);
        if (!obj) return json({ erro: "Anexo não encontrado (ou já foi apagado)." }, 404);
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set("etag", obj.httpEtag);
        const nomeArq = obj.customMetadata?.nome || id;
        headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(nomeArq)}"`);
        return new Response(obj.body, { headers });
      }

      if (pathname.startsWith("/api/anexos/") && request.method === "DELETE") {
        const id = pathname.replace("/api/anexos/", "");
        await env.ANEXOS_R2.delete(`anexos/${id}`);
        return json({ ok: true });
      }

      // ---------- ROBÔS: vincular / listar / desvincular ----------
      if (pathname === "/api/robos" && request.method === "GET") {
        const estado = await lerEstadoRobos(env);
        if (marcarTarefasPresas(estado)) await gravarEstadoRobos(env, estado);
        return json({ robos: estado.robos.map(roboPublico) });
      }
      if (pathname === "/api/robos/codigo" && request.method === "POST") {
        const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I para não confundir
        const bytes = crypto.getRandomValues(new Uint8Array(6));
        const codigo = [...bytes].map((b) => letras[b % letras.length]).join("");
        await env.SFC_KV.put(`robo-codigo:${codigo}`, JSON.stringify({ username }), { expirationTtl: 600 });
        return json({ codigo: `${codigo.slice(0, 3)}-${codigo.slice(3)}`, expiraEm: new Date(Date.now() + 600000).toISOString() });
      }
      if (pathname.startsWith("/api/robos/") && request.method === "DELETE") {
        const id = pathname.slice("/api/robos/".length);
        const estado = await lerEstadoRobos(env);
        const antes = estado.robos.length;
        estado.robos = estado.robos.filter((r) => r.id !== id);
        if (estado.robos.length === antes) return json({ erro: "Computador não encontrado." }, 404);
        await gravarEstadoRobos(env, estado);
        return json({ ok: true });
      }

      // ---------- NFA-e: cadastros (emitentes, clientes, produtos) ----------
      if (pathname === "/api/nfae/cadastros" && request.method === "GET") {
        const cad = (await env.KV_EMPRESAS.get("nfae_cadastros", "json")) || {};
        return json({ emitentes: cad.emitentes || [], clientes: cad.clientes || {}, produtos: cad.produtos || {} });
      }
      if (pathname === "/api/nfae/cadastros" && request.method === "POST") {
        const corpo = await request.json().catch(() => ({}));
        const atual = (await env.KV_EMPRESAS.get("nfae_cadastros", "json")) || {};
        const novo = {
          emitentes: Array.isArray(corpo.emitentes) ? corpo.emitentes.slice(0, 50).map((e) => ({ id: String(e.id || crypto.randomUUID()).slice(0, 40), nome: String(e.nome || "").slice(0, 80), usuario: String(e.usuario || "").slice(0, 60) })).filter((e) => e.nome && e.usuario) : atual.emitentes || [],
          clientes: corpo.clientes && typeof corpo.clientes === "object" ? corpo.clientes : atual.clientes || {},
          produtos: corpo.produtos && typeof corpo.produtos === "object" ? corpo.produtos : atual.produtos || {},
        };
        const tamanho = JSON.stringify(novo).length;
        if (tamanho > 2 * 1024 * 1024) return json({ erro: "Cadastro grande demais (máx. 2 MB)." }, 400);
        await env.KV_EMPRESAS.put("nfae_cadastros", JSON.stringify(novo));
        // emitentes mudaram: avisa o robô (ele vê a "versão" na próxima pergunta, sem custo extra)
        if (JSON.stringify(novo.emitentes) !== JSON.stringify(atual.emitentes || [])) {
          const estado = await lerEstadoRobos(env);
          estado.emitentesVersao = Date.now();
          await gravarEstadoRobos(env, estado);
        }
        return json({ ok: true, ...novo });
      }

      // ---------- NFA-e: tarefas para o robô ----------
      if (pathname === "/api/nfae/tarefas" && request.method === "GET") {
        const estado = await lerEstadoRobos(env);
        if (marcarTarefasPresas(estado)) await gravarEstadoRobos(env, estado);
        return json({ tarefas: estado.tarefas.filter((t) => t.tipo === "nfae").slice().reverse().map(tarefaPublica), robos: estado.robos.map(roboPublico) });
      }
      if (pathname === "/api/nfae/tarefas" && request.method === "POST") {
        const d = await request.json().catch(() => ({}));
        const cad = (await env.KV_EMPRESAS.get("nfae_cadastros", "json")) || {};
        const { erros, emitente } = validarPedidoNfae(d, cad);
        if (erros.length) return json({ erro: erros.join(" "), erros }, 400);
        const estado = await lerEstadoRobos(env);
        // trava contra clique duplo: mesmo pedido idêntico ainda pendente/andando
        const assinatura = await sha256Hex(JSON.stringify([d.emitenteId, d.cliente?.cnpj, d.itens]));
        if (estado.tarefas.some((t) => t.assinatura === assinatura && ["pendente", "em_andamento"].includes(t.status))) return json({ erro: "Essa mesma nota já está na fila do robô." }, 409);
        const tarefa = {
          id: crypto.randomUUID(), tipo: "nfae", status: "pendente", criadoEm: new Date().toISOString(), criadoPor: username, assinatura,
          dados: {
            emitenteId: emitente.id, emitenteNome: emitente.nome,
            cliente: Object.fromEntries(["cnpj", "ie", "nome", "razao_social", "cep", "logradouro", "numero", "bairro", "municipio", "estado", "complemento"].map((k) => [k, String(d.cliente?.[k] ?? "").trim().slice(0, 120)])),
            itens: d.itens.map((i) => ({ codigo: String(i.codigo).trim().slice(0, 20), descricao: String(i.descricao).trim().slice(0, 120), ncm: String(i.ncm).replace(/\D/g, ""), qtd: Number(i.qtd), valor: String(i.valor).trim(), cfop: String(i.cfop || "5405").replace(/\D/g, "").slice(0, 4) || "5405", unidade: String(i.unidade || "UN").slice(0, 6) })),
            observacao: String(d.observacao || "").slice(0, 500),
          },
        };
        estado.tarefas.push(tarefa);
        await gravarEstadoRobos(env, estado);
        return json({ ok: true, tarefa: tarefaPublica(tarefa) });
      }
      if (/^\/api\/nfae\/tarefas\/[\w-]+\/(cancelar|refazer)$/.test(pathname) && request.method === "POST") {
        const [, , , , id, acao] = pathname.split("/");
        const estado = await lerEstadoRobos(env);
        const t = estado.tarefas.find((x) => x.id === id);
        if (!t) return json({ erro: "Tarefa não encontrada." }, 404);
        if (acao === "cancelar") {
          if (t.status !== "pendente") return json({ erro: "Só dá para cancelar o que ainda não começou." }, 400);
          Object.assign(t, { status: "cancelada", finalizadoEm: new Date().toISOString(), mensagem: `Cancelada por ${username}.` });
        } else {
          if (!["erro", "interrompida", "conferir", "cancelada"].includes(t.status)) return json({ erro: "Essa tarefa não pode ser refeita." }, 400);
          Object.assign(t, { status: "pendente", mensagem: `Mandada de novo por ${username}.`, roboId: null, iniciadoEm: null, finalizadoEm: null });
        }
        await gravarEstadoRobos(env, estado);
        return json({ ok: true, tarefa: tarefaPublica(t) });
      }
      if (pathname.startsWith("/api/nfae/arquivo/") && request.method === "GET") {
        const [id, ...resto] = pathname.slice("/api/nfae/arquivo/".length).split("/");
        const nome = decodeURIComponent(resto.join("/"));
        if (!/^[\w-]+$/.test(id) || !nome || nome.includes("..")) return json({ erro: "Arquivo inválido." }, 400);
        const obj = await env.ANEXOS_R2.get(`robo/${id}/${nome}`);
        if (!obj) return json({ erro: "Arquivo não encontrado." }, 404);
        const headers = new Headers({ "X-Content-Type-Options": "nosniff" });
        obj.writeHttpMetadata(headers);
        const exibivel = /^(application\/pdf|image\/(png|jpeg))$/.test(headers.get("content-type") || "");
        headers.set("Content-Disposition", `${url.searchParams.get("ver") && exibivel ? "inline" : "attachment"}; filename="${encodeURIComponent(nome)}"`);
        return new Response(obj.body, { headers });
      }

      // ---------- BACKUP COMPLETO EM ARQUIVO (exportar/importar .json — cópia offline de um período) ----------
      if (pathname === "/api/backup/export" && request.method === "GET") {
        const estado = await lerDadosCompletos(env);

        const idsAnexos = new Set();
        estado.grupos.forEach((g) => g.empresas.forEach((e) => (e.anexos || []).forEach((a) => a?.id && idsAnexos.add(a.id))));
        estado.parcelamentos.forEach((p) => (p.anexos || []).forEach((a) => a?.id && idsAnexos.add(a.id)));

        const anexosEmpacotados = {};
        for (const id of idsAnexos) {
          const obj = await env.ANEXOS_R2.get(`anexos/${id}`);
          if (obj) {
            const bytes = await obj.arrayBuffer();
            anexosEmpacotados[id] = {
              nome: obj.customMetadata?.nome || id,
              tipo: obj.httpMetadata?.contentType || "application/octet-stream",
              dataB64: Buffer.from(bytes).toString("base64"),
            };
          }
        }

        const backup = {
          versao: 2,
          geradoEm: new Date().toISOString(),
          grupos: estado.grupos,
          checklist: estado.checklist,
          parcelamentos: estado.parcelamentos,
          anexos: anexosEmpacotados,
        };

        const nomeArquivo = `backup-sfc-${new Date().toISOString().slice(0, 10)}.json`;
        return new Response(JSON.stringify(backup), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${nomeArquivo}"`,
          },
        });
      }

      if (pathname === "/api/backup/import" && request.method === "POST") {
        const backup = await request.json();
        if (!backup || !Array.isArray(backup.grupos)) {
          return json({ erro: "Arquivo de backup inválido." }, 400);
        }

        const mapaIds = {};
        if (backup.anexos) {
          for (const [idAntigo, anexo] of Object.entries(backup.anexos)) {
            const novoId = crypto.randomUUID();
            const bytes = Buffer.from(anexo.dataB64, "base64");
            await env.ANEXOS_R2.put(`anexos/${novoId}`, bytes, {
              httpMetadata: { contentType: anexo.tipo || "application/octet-stream" },
              customMetadata: { nome: anexo.nome },
            });
            mapaIds[idAntigo] = novoId;
          }
        }
        const remapear = (lista) =>
          (lista || []).map((item) => ({
            ...item,
            anexos: (item.anexos || [])
              .map((a) => (a && a.id && mapaIds[a.id] ? { ...a, id: mapaIds[a.id] } : a))
              .filter(Boolean),
          }));

        const novosGrupos = backup.grupos.map((g) => ({ nome: g.nome, empresas: remapear(g.empresas || []) }));
        const novosParcelamentos = remapear(backup.parcelamentos || []);

        await gravarDadosCompletos(env, { grupos: novosGrupos, checklist: backup.checklist || [], parcelamentos: novosParcelamentos });
        return json({ ok: true });
      }

      // Nenhuma rota de API bateu — deixa cair pro handler de assets estáticos
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ erro: "Erro interno: " + err.message }, 500);
    }
  },
};
