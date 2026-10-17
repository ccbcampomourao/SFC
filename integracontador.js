// ============================================================================
// integracontador.js — página do IntegraContador (SERPRO): certificado,
// seleção de empresas e download de relatórios (Situação Fiscal / CND)
// ============================================================================

function renderizarPagina() {
  carregarStatusIntegraContador();
  renderizarListaEmpresasIC();
  renderizarRelatoriosSalvos();
}

// ---------------------------------------------------------------------------
// STATUS / CERTIFICADO DIGITAL (.pfx lido no navegador com node-forge; nunca
// sobe o arquivo original nem a senha — só o certificado/chave já convertidos)
// ---------------------------------------------------------------------------
function htmlItemStatus(ok, titulo, textoOk, textoPendente, ic) {
  return `
    <div class="ic-status-item ${ok ? "ok" : "pendente"}">
      <span class="linha-icone">${icone(ok ? "ok" : ic)}</span>
      <span><b>${titulo}</b><small>${ok ? textoOk : textoPendente}</small></span>
    </div>`;
}

async function carregarStatusIntegraContador() {
  const box = $("#certificado-status");
  try {
    const status = await api("/api/integracontador/status");
    box.innerHTML = `
      ${htmlItemStatus(status.certificadoConfigurado, "Certificado digital", "Configurado e vinculado ao Worker", "Ainda não configurado", "chave")}
      ${htmlItemStatus(status.sitfisConfigurado, "Situação Fiscal (SITFIS)", "Pronto para baixar", "Faltam credenciais (Consumer Key/Secret + CNPJ do escritório)", "alerta")}
      ${htmlItemStatus(status.cndConfigurado, "CND", "Pronto para baixar", "Faltam credenciais (Consumer Key/Secret)", "alerta")}
      <div class="ic-status-acoes">
        <button class="btn-secundario btn-sm" id="btn-config-certificado">${icone("chave")}Configurar certificado (.pfx)</button>
        <button class="btn-ghost btn-sm" id="btn-testar-cf">${icone("teste")}Testar credenciais Cloudflare</button>
      </div>
      <div id="teste-cf-resultado" class="oculto" style="grid-column:1/-1"></div>
    `;
    $("#btn-config-certificado").addEventListener("click", abrirModalCertificado);
    $("#btn-testar-cf").addEventListener("click", (ev) => comCarregando(ev.currentTarget, async () => {
      const cx = $("#teste-cf-resultado");
      cx.className = "mensagem-info";
      cx.textContent = "Testando...";
      try {
        const r = await api("/api/integracontador/testar-credenciais-cf");
        if (r.ok) {
          cx.className = "mensagem-sucesso";
          cx.textContent = r.mensagem;
        } else {
          cx.className = "mensagem-erro";
          cx.textContent = r.erro + (r.detalhe ? "\n\nDetalhe técnico: " + r.detalhe : "");
        }
      } catch (err) {
        cx.className = "mensagem-erro";
        cx.textContent = err.message;
      }
    }));
  } catch (err) {
    box.innerHTML = `<div class="mensagem-erro" style="grid-column:1/-1">Erro ao carregar status: ${escaparHtml(err.message)}</div>`;
  }
}

function arrayBufferParaStringBinaria(buf) {
  const bytes = new Uint8Array(buf);
  let binario = "";
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + passo));
  }
  return binario;
}

async function extrairCertificadoDoPfx(arquivo, senha) {
  if (!window.forge) throw new Error("O leitor de certificado ainda está carregando. Tente de novo em alguns segundos.");
  const buf = await arquivo.arrayBuffer();
  const binario = arrayBufferParaStringBinaria(buf);
  const p12Asn1 = forge.asn1.fromDer(binario);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
  let keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag];
  if (!keyBags || !keyBags.length) keyBags = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag];

  if (!certBags || !certBags.length || !keyBags || !keyBags.length) {
    throw new Error("Não consegui ler o certificado ou a chave privada do arquivo. Confira a senha.");
  }
  return {
    certPem: forge.pki.certificateToPem(certBags[0].cert),
    keyPem: forge.pki.privateKeyToPem(keyBags[0].key),
  };
}

function abrirModalCertificado() {
  abrirModal(`
    <h2>Configurar certificado digital</h2>
    <p class="modal-sub">O arquivo .pfx é lido aqui no seu navegador — só o certificado convertido é enviado para a Cloudflare (nunca o arquivo original nem a senha).</p>
    <form id="form-cert">
      <div class="campo-form"><label>Arquivo .pfx / .p12</label><input type="file" id="cert-arquivo" accept=".pfx,.p12"></div>
      <div class="campo-form"><label>Senha do certificado</label><input type="password" id="cert-senha" autocomplete="off"></div>
      <div id="cert-status" class="oculto"></div>
      <div class="modal-rodape">
        <button type="button" class="btn-ghost" id="cert-cancelar">Cancelar</button>
        <button type="submit" class="btn-primario" id="cert-enviar">${icone("enviar")}Enviar</button>
      </div>
    </form>`);
  $("#cert-cancelar").addEventListener("click", fecharModal);
  $("#form-cert").addEventListener("submit", (e) => {
    e.preventDefault();
    comCarregando($("#cert-enviar"), async () => {
      const arquivo = $("#cert-arquivo").files[0];
      const senha = $("#cert-senha").value;
      const status = $("#cert-status");
      if (!arquivo) {
        status.className = "mensagem-erro";
        status.textContent = "Selecione o arquivo .pfx.";
        return;
      }
      try {
        status.className = "mensagem-info";
        status.textContent = "Lendo o certificado no navegador...";
        const { certPem, keyPem } = await extrairCertificadoDoPfx(arquivo, senha);
        status.textContent = "Enviando para a Cloudflare...";
        const resp = await api("/api/integracontador/certificado", {
          method: "POST",
          body: JSON.stringify({ certPem, keyPem, nome: "serpro-integracontador" }),
        });
        status.className = "mensagem-sucesso";
        status.textContent =
          `Certificado enviado! ID: ${resp.certificateId}\n\n` +
          `Falta um último passo: abra o wrangler.toml no GitHub, descomente o bloco [[mtls_certificates]] ` +
          `perto do fim do arquivo, cole esse ID no lugar de COLE_AQUI_O_CERTIFICATE_ID, e salve. ` +
          `O deploy roda sozinho a partir daí.`;
      } catch (err) {
        status.className = "mensagem-erro";
        status.textContent = "Erro: " + err.message;
      }
    });
  });
}

// ---------------------------------------------------------------------------
// RELATÓRIOS SALVOS (área própria do IntegraContador — sempre a versão mais
// recente por empresa+serviço, sobrescrita automaticamente ao baixar de novo)
// ---------------------------------------------------------------------------
const ROTULO_SERVICO = { sitfis: "Situação Fiscal", cnd: "CND" };
let _assinaturaRelatorios = null; // evita redesenhar (e piscar) quando nada mudou
const _cartoesJaVistos = new Set();

function formatarDataHora(iso) {
  try {
    return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

async function renderizarRelatoriosSalvos() {
  const cont = $("#lista-relatorios-salvos");
  if (!cont) return;
  let relatorios = {};
  try {
    ({ relatorios } = await api("/api/integracontador/relatorios"));
    relatorios = relatorios || {};
  } catch (err) {
    cont.innerHTML = `<div class="mensagem-erro">Erro ao carregar: ${escaparHtml(err.message)}</div>`;
    return;
  }

  const cnpjs = Object.keys(relatorios)
    .filter((c) => relatorios[c].sitfis || relatorios[c].cnd)
    .sort((a, b) => (relatorios[a].nomeEmpresa || a).localeCompare(relatorios[b].nomeEmpresa || b, "pt-BR"));
  const assinatura = JSON.stringify(cnpjs.map((c) => [c, relatorios[c]]));
  if (assinatura === _assinaturaRelatorios) return;
  _assinaturaRelatorios = assinatura;

  if (cnpjs.length === 0) {
    cont.innerHTML = `<div class="vazio" style="grid-column:1/-1">${icone("arquivo", "ico-xl")}<strong>Nenhum relatório ainda</strong><p>Selecione empresas e serviços acima e clique em “Baixar selecionados”.</p></div>`;
    return;
  }

  const primeiraVez = _cartoesJaVistos.size === 0;
  cont.innerHTML = cnpjs.map((cnpj) => {
    const item = relatorios[cnpj];
    const chaveCartao = cnpj + JSON.stringify(item);
    const novo = !primeiraVez && !_cartoesJaVistos.has(chaveCartao);
    _cartoesJaVistos.add(chaveCartao);
    const linhaServico = (chave) => {
      const info = item[chave];
      if (!info) return "";
      return `
        <div class="ic-relatorio-linha">
          <div>
            <div class="ic-relatorio-servico">${icone("documento", "ico-sm")}${ROTULO_SERVICO[chave]}</div>
            <div class="ic-relatorio-data">Atualizado em ${formatarDataHora(info.atualizadoEm)}</div>
          </div>
          <div class="ic-relatorio-acoes">
            <button type="button" class="btn-icone neutro" data-baixar="${chave}" data-cnpj="${escaparHtml(cnpj)}" title="Abrir / baixar">${icone("baixar")}</button>
            <button type="button" class="btn-icone" data-apagar="${chave}" data-cnpj="${escaparHtml(cnpj)}" title="Apagar">${icone("lixeira")}</button>
          </div>
        </div>`;
    };
    return `
      <div class="ic-relatorio-card${novo ? " ic-surgir" : ""}">
        <div class="ic-relatorio-empresa"><span class="linha-icone">${icone("empresas", "ico-sm")}</span><span title="${escaparHtml(item.nomeEmpresa || cnpj)}">${escaparHtml(item.nomeEmpresa || cnpj)}</span></div>
        ${linhaServico("sitfis")}
        ${linhaServico("cnd")}
      </div>`;
  }).join("");
}

$("#lista-relatorios-salvos")?.addEventListener("click", async (e) => {
  const baixar = e.target.closest("[data-baixar]");
  if (baixar) {
    window.open(`/api/integracontador/arquivo/${baixar.dataset.baixar}/${encodeURIComponent(baixar.dataset.cnpj)}`, "_blank");
    return;
  }
  const apagar = e.target.closest("[data-apagar]");
  if (!apagar) return;
  const ok = await confirmar("O PDF guardado desse relatório será apagado. Você pode baixá-lo de novo depois.", { titulo: "Apagar relatório salvo?", textoOk: "Apagar", perigo: true });
  if (!ok) return;
  const card = apagar.closest(".ic-relatorio-card");
  try {
    await api(`/api/integracontador/arquivo/${apagar.dataset.apagar}/${encodeURIComponent(apagar.dataset.cnpj)}`, { method: "DELETE" });
    card?.classList.add("saindo");
    setTimeout(renderizarRelatoriosSalvos, 180);
  } catch (err) {
    notificar("Erro ao apagar: " + err.message, "erro");
  }
});

// ---------------------------------------------------------------------------
// SELEÇÃO DE EMPRESAS (com filtro e contador)
// ---------------------------------------------------------------------------
function todasEmpresasComCnpj() {
  const lista = [];
  ESTADO.grupos.forEach((g) => g.empresas.forEach((e) => { if (e.cnpj) lista.push(e); }));
  return lista.sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR"));
}

function atualizarContadorSelecionadas() {
  const total = $$(".ic-empresa-check").length;
  const marcadas = $$(".ic-empresa-check:checked").length;
  const el = $("#contador-selecionadas");
  if (el) el.textContent = total ? `${marcadas} de ${total}` : "";
}

function renderizarListaEmpresasIC() {
  const cont = $("#lista-empresas-ic");
  const empresas = todasEmpresasComCnpj();
  if (empresas.length === 0) {
    cont.innerHTML = `<div class="vazio" style="grid-column:1/-1">${icone("empresas", "ico-xl")}<p>Nenhuma empresa com CNPJ cadastrado ainda. Cadastre em “Empresas” primeiro.</p></div>`;
    atualizarContadorSelecionadas();
    return;
  }
  cont.innerHTML = empresas.map((e) => `
    <label class="ic-empresa-item" data-busca="${escaparHtml(((e.nome || "") + " " + e.cnpj + " " + limparDigitos(e.cnpj)).toLowerCase())}">
      <input type="checkbox" class="ic-empresa-check" data-cnpj="${escaparHtml(e.cnpj)}" data-nome="${escaparHtml(e.nome)}" checked>
      <span class="ic-empresa-nome" title="${escaparHtml(e.nome)}">${escaparHtml(e.nome)}</span>
      <span class="ic-empresa-cnpj">${escaparHtml(e.cnpj)}</span>
    </label>`).join("");
  atualizarContadorSelecionadas();
}

$("#lista-empresas-ic")?.addEventListener("change", atualizarContadorSelecionadas);
// "Marcar/Desmarcar todas" age só sobre as empresas visíveis no filtro.
const _visiveisIC = () => $$(".ic-empresa-item").filter((l) => !l.classList.contains("oculto")).map((l) => l.querySelector("input"));
$("#btn-marcar-todas")?.addEventListener("click", () => { _visiveisIC().forEach((c) => (c.checked = true)); atualizarContadorSelecionadas(); });
$("#btn-desmarcar-todas")?.addEventListener("click", () => { _visiveisIC().forEach((c) => (c.checked = false)); atualizarContadorSelecionadas(); });
$("#busca-ic")?.addEventListener("input", atrasar((e) => {
  const termo = e.target.value.trim().toLowerCase();
  $$(".ic-empresa-item").forEach((l) => l.classList.toggle("oculto", !!termo && !l.dataset.busca.includes(termo)));
}, 100));

// ---------------------------------------------------------------------------
// BAIXAR SELECIONADOS
// ---------------------------------------------------------------------------
function baixarBase64ComoArquivo(base64, nomeArquivo) {
  // Blob em vez de data: URL — não trava a aba com PDFs grandes
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = nomeArquivo;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const ROTULO_ETAPA_IC = {
  validacao: "Validação do CNPJ",
  configuracao: "Configuração do Worker",
  autenticacao: "Autenticação no SERPRO",
  solicitar_protocolo: "Solicitar protocolo do relatório",
  emitir_relatorio: "Emitir relatório",
  interno: "Erro interno do servidor",
};

// Texto completo que o botão "Copiar detalhes" coloca na área de transferência.
function montarDetalhesErro(info, emp, svc) {
  const linhas = [`Empresa: ${emp.nome}`, `CNPJ: ${emp.cnpj}`, `Serviço: ${svc.rotulo}`];
  if (info.etapa) linhas.push(`Etapa: ${ROTULO_ETAPA_IC[info.etapa] || info.etapa}`);
  if (info.httpStatus) linhas.push(`HTTP: ${info.httpStatus}`);
  linhas.push(`Erro: ${info.erro || info.message || "Erro desconhecido"}`);
  if (info.dica) linhas.push(`Dica: ${info.dica}`);
  if (info.protocolo) linhas.push(`Protocolo: ${info.protocolo}`);
  if (info.detalheTecnico) linhas.push(`Detalhe técnico: ${info.detalheTecnico}`);
  linhas.push(`Data: ${agora()}`);
  return linhas.join("\n");
}

// Depois que pelo menos uma empresa deu certo, já sabemos que certificado/credenciais estão OK.
let configuracaoConfirmada = false;

// Erros de configuração/autenticação aconteceriam igual em todas as empresas — não adianta
// (e custa dinheiro) continuar o lote.
function erroAfetaTodas(info) {
  if (!info) return false;
  if (info.etapa === "configuracao" || info.etapa === "autenticacao") return true;
  return /SERPRO_CONTRATANTE_CNPJ/.test(info.dica || "");
}

// Se o SERPRO ainda estiver gerando o relatório, continua com o MESMO protocolo
// (não pede outro, o que seria cobrado de novo).
async function obterRelatorioComEspera(chamar, { aoAguardar, maxRodadas = 3 } = {}) {
  let resp = await chamar(null);
  for (let rodada = 1; resp && resp.processando && resp.protocolo && rodada <= maxRodadas; rodada++) {
    if (aoAguardar) aoAguardar(rodada, maxRodadas);
    await new Promise((r) => setTimeout(r, Math.min(Number(resp.tempoEsperaMs) || 3000, 15000)));
    resp = await chamar(resp.protocolo);
  }
  return resp;
}

function definirBadge(badge, tipo, texto, titulo = "") {
  const ic = { aguardando: "relogio", baixando: "carregando", ok: "check", erro: "erro", cancelado: "proibido" }[tipo];
  badge.className = `ic-badge ic-badge-${tipo}`;
  badge.innerHTML = `${icone(ic, tipo === "baixando" ? "girando" : "")}${escaparHtml(texto)}`;
  badge.title = titulo;
}

function mostrarErroNaLinha(linha, badge, info, emp, svc) {
  const msg = info.erro || info.message || "Erro desconhecido";
  definirBadge(badge, "erro", "Erro", msg);
  linha.querySelector(".ic-erro-detalhe")?.remove();
  const caixa = document.createElement("div");
  caixa.className = "ic-erro-detalhe";
  caixa.innerHTML = `
    <div class="ic-erro-texto">${escaparHtml(msg)}</div>
    ${info.dica ? `<div class="ic-erro-dica">${icone("lampada")}<span>${escaparHtml(info.dica)}</span></div>` : ""}
    <button type="button" class="btn-secundario btn-sm ic-copiar-erro">${icone("copiar")}Copiar detalhes</button>`;
  const texto = montarDetalhesErro(info, emp, svc);
  const botaoCopiar = caixa.querySelector(".ic-copiar-erro");
  botaoCopiar.addEventListener("click", async () => {
    const ok = await copiarParaAreaDeTransferencia(texto);
    if (ok) {
      botaoCopiar.innerHTML = `${icone("check")}Copiado`;
      setTimeout(() => { botaoCopiar.innerHTML = `${icone("copiar")}Copiar detalhes`; }, 2000);
    } else {
      avisar(texto, { titulo: "Copie os detalhes abaixo" });
    }
  });
  linha.appendChild(caixa);
}

function mostrarAvisoNaLinha(linha, texto) {
  const caixa = document.createElement("div");
  caixa.className = "ic-aviso-detalhe";
  caixa.innerHTML = `${icone("alerta")}<span>${escaparHtml(texto)}</span>`;
  linha.appendChild(caixa);
}

$("#btn-baixar-selecionados")?.addEventListener("click", async (ev) => {
  const botao = ev.currentTarget;
  const empresasSelecionadas = $$(".ic-empresa-check:checked").map((c) => ({ cnpj: c.dataset.cnpj, nome: c.dataset.nome }));
  if (!empresasSelecionadas.length) return notificar("Selecione pelo menos uma empresa.", "aviso");

  const servicos = [];
  if ($("#svc-sitfis").checked) servicos.push({ chave: "sitfis", rotulo: "Situação Fiscal", endpoint: "/api/integracontador/sitfis" });
  if ($("#svc-cnd").checked) servicos.push({ chave: "cnd", rotulo: "CND", endpoint: "/api/integracontador/cnd" });
  if (!servicos.length) return notificar("Selecione pelo menos um serviço.", "aviso");

  if (empresasSelecionadas.length * servicos.length > 10) {
    const ok = await confirmar(
      `Serão ${empresasSelecionadas.length * servicos.length} consultas ao SERPRO (cada uma é cobrada pelo seu contrato, inclusive as recusadas).`,
      { titulo: "Baixar todos os selecionados?", textoOk: "Baixar" }
    );
    if (!ok) return;
  }

  botao.disabled = true;
  const cont = $("#resultado-ic");
  cont.innerHTML = "";
  const linhas = {};
  const tarefas = [];
  const frag = document.createDocumentFragment();
  empresasSelecionadas.forEach((emp) => {
    servicos.forEach((svc) => {
      const id = `${emp.cnpj}-${svc.chave}`;
      const linha = document.createElement("div");
      linha.className = "ic-resultado-item";
      linha.innerHTML = `<span class="ic-resultado-nome"><b>${escaparHtml(emp.nome)}</b><small>${escaparHtml(svc.rotulo)}</small></span><span class="ic-badge"></span>`;
      definirBadge(linha.querySelector(".ic-badge"), "aguardando", "Na fila");
      frag.appendChild(linha);
      linhas[id] = linha;
      tarefas.push({ id, emp, svc });
    });
  });
  cont.appendChild(frag);

  // Barra de progresso
  const progresso = $("#ic-progresso");
  const progTexto = $("#ic-progresso-texto");
  const progBarra = $("#ic-progresso-barra");
  let concluidas = 0, sucesso = 0, falhas = 0;
  const atualizarProgresso = () => {
    progTexto.textContent = `${concluidas} de ${tarefas.length} concluídas · ${sucesso} baixadas${falhas ? ` · ${falhas} com erro` : ""}`;
    progBarra.style.transform = `scaleX(${tarefas.length ? concluidas / tarefas.length : 0})`;
  };
  progresso.classList.remove("oculto");
  atualizarProgresso();

  let loteInterrompido = false;
  const LIMITE_PARALELO = 3;

  async function processarTarefa({ id, emp, svc }) {
    const linha = linhas[id];
    const badge = linha.querySelector(".ic-badge");
    if (loteInterrompido) {
      definirBadge(badge, "cancelado", "Cancelado", "Não enviado: o erro anterior afetaria todas as empresas.");
      concluidas++; atualizarProgresso();
      return;
    }
    definirBadge(badge, "baixando", "Baixando...");
    try {
      const chamar = (protocolo) => api(svc.endpoint, {
        method: "POST",
        body: JSON.stringify({ cnpj: emp.cnpj, nomeEmpresa: emp.nome, ...(protocolo ? { protocolo } : {}) }),
      });
      const resp = await obterRelatorioComEspera(chamar, {
        aoAguardar: (n, max) => definirBadge(badge, "baixando", `Aguardando o SERPRO (${n}/${max})`),
      });
      if (resp && resp.ok && resp.pdfBase64) {
        configuracaoConfirmada = true;
        baixarBase64ComoArquivo(resp.pdfBase64, resp.nomeArquivo || `${svc.rotulo}-${emp.cnpj}.pdf`);
        definirBadge(badge, "ok", "Baixado");
        sucesso++;
        if (resp.avisoSalvar) mostrarAvisoNaLinha(linha, resp.avisoSalvar);
      } else if (resp && resp.processando) {
        falhas++;
        mostrarErroNaLinha(linha, badge, { ...resp, erro: "O SERPRO ainda está gerando esse relatório depois de várias tentativas. Tente de novo em alguns minutos." }, emp, svc);
      } else {
        falhas++;
        const info = resp || { erro: "Resposta vazia do servidor." };
        mostrarErroNaLinha(linha, badge, info, emp, svc);
        if (erroAfetaTodas(info)) loteInterrompido = true;
      }
    } catch (err) {
      falhas++;
      mostrarErroNaLinha(linha, badge, err, emp, svc);
      if (erroAfetaTodas(err)) loteInterrompido = true;
    }
    concluidas++;
    atualizarProgresso();
  }

  try {
    const fila = [...tarefas];
    // Enquanto não sabemos se a configuração está certa, testa uma empresa primeiro:
    // se for erro de certificado/credencial, não gasta chamadas com as outras.
    if (!configuracaoConfirmada && fila.length > 1) await processarTarefa(fila.shift());
    async function trabalhador() {
      while (fila.length) await processarTarefa(fila.shift());
    }
    await Promise.all(Array.from({ length: Math.min(LIMITE_PARALELO, fila.length) }, trabalhador));
    if (loteInterrompido) notificar("Lote interrompido: o mesmo erro afetaria todas as empresas. Veja o motivo na primeira linha com erro.", "erro");
    else if (falhas === 0) notificar(`${sucesso} relatório(s) baixado(s)`, "ok");
    else notificar(`${sucesso} baixado(s), ${falhas} com erro — veja os detalhes abaixo`, "aviso");
  } finally {
    botao.disabled = false;
    renderizarRelatoriosSalvos();
  }
});

iniciarPagina();
