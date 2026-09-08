import { WorkerMailer } from "worker-mailer";

const SESSION_COOKIE = "sfc_session";
const SESSION_TTL_SEGUNDOS = 60 * 60 * 24 * 7; // 7 dias
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
      subject: "Confirme seu acesso — Sistema Fiscal Contábil",
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

async function usuarioLogado(request, env) {
  const cookies = lerCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const sessao = await env.SFC_KV.get(`session:${token}`, "json");
  return sessao ? sessao.username : null;
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
  return { grupos, checklist, parcelamentos };
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

  await env.KV_EMPRESAS.put(`${prefixo}dados`, JSON.stringify({ grupos }));
  await env.KV_EMPRESAS.put(`${prefixo}parcelamentos`, JSON.stringify({ parcelamentos }));
  await env.KV_COMENTARIOS.put(`${prefixo}checklist`, JSON.stringify(estado.checklist || []));
  await env.KV_COMENTARIOS.put(`${prefixo}comentariosEmpresas`, JSON.stringify(comentariosEmpresas));
  await env.KV_COMENTARIOS.put(`${prefixo}comentariosParcelamentos`, JSON.stringify(comentariosParcelamentos));

  return { grupos, checklist: estado.checklist || [], parcelamentos };
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
// Handler principal
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // ---------- CADASTRO (disponível a qualquer momento, sempre com confirmação por e-mail) ----------
      if (pathname === "/api/auth/cadastro" && request.method === "POST") {
        const { username, password, nome, email } = await request.json();
        if (!username || !password || password.length < 6) {
          return json({ erro: "Usuário e senha (mín. 6 caracteres) são obrigatórios." }, 400);
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
        if (email) {
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
        await env.SFC_KV.put(`session:${token}`, JSON.stringify({ username }), {
          expirationTtl: SESSION_TTL_SEGUNDOS,
        });
        return new Response(JSON.stringify({ ok: true, nome: usuario.nome }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": cookieDeSessao(token, SESSION_TTL_SEGUNDOS),
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

      // A partir daqui, tudo exige login
      const username = await usuarioLogado(request, env);
      if (!username) return json({ erro: "Não autenticado." }, 401);

      // ---------- USUÁRIOS (adicionar novo funcionário) ----------
      if (pathname === "/api/users" && request.method === "GET") {
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        return json({ usuarios: usuarios.map((u) => ({ username: u.username, nome: u.nome, email: u.email, confirmado: !!u.confirmado })) });
      }

      if (pathname === "/api/users" && request.method === "POST") {
        const { username: novoUser, password, nome, email } = await request.json();
        if (!novoUser || !password || password.length < 6) {
          return json({ erro: "Usuário e senha (mín. 6 caracteres) são obrigatórios." }, 400);
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
          empresas: g.empresas.map((e) => ({
            id: e.id,
            nome: e.nome,
            status: "SEM",
            nfs: false,
            nfe: false,
            nfc: false,
            fechado: false,
            cnpj: e.cnpj,
            cpf: e.cpf,
            senhaPrefeitura: e.senhaPrefeitura,
            senhaRegularize: e.senhaRegularize,
            inscricaoEstadual: e.inscricaoEstadual,
            email: e.email,
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
        const { destinatario, assunto, mensagem } = await request.json();
        if (!destinatario || !assunto) {
          return json({ erro: "Destinatário e assunto são obrigatórios." }, 400);
        }
        if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
          return json(
            { erro: "E-mail não configurado. Rode: wrangler secret put GMAIL_USER / GMAIL_APP_PASSWORD" },
            500
          );
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
              from: env.GMAIL_USER,
              to: destinatario,
              subject: assunto,
              text: mensagem || "",
            }
          );
          return json({ ok: true });
        } catch (err) {
          return json({ erro: "Falha ao enviar e-mail: " + err.message }, 500);
        }
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
