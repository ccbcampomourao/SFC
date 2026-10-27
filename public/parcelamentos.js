// ============================================================================
// parcelamentos.js — página de Parcelamentos (parcelamentos.html)
// Mesmo princípio da página de Empresas: desenha a lista uma vez e depois
// atualiza só o cartão que mudou.
// ============================================================================
const PARCELAMENTOS_ABERTOS = new Set(); // ids abertos
const EL_PARC = new Map();               // id -> elemento
let filtroParc = "";
const CICLO_ALTERNANCIA = ["VAZIO", "Simples Receita", "Simples PGFN", "Previdencia Receita", "Previdencia PGFN"];
const ROTULO_ALTERNANCIA = { "VAZIO": "Vazio", "Simples Receita": "Simples · Receita", "Simples PGFN": "Simples · PGFN", "Previdencia Receita": "Previdência · Receita", "Previdencia PGFN": "Previdência · PGFN" };

function proximoAlternancia(atual) {
  const i = CICLO_ALTERNANCIA.indexOf(atual || "VAZIO");
  return CICLO_ALTERNANCIA[(i + 1) % CICLO_ALTERNANCIA.length];
}
function classeAlternancia(status) {
  const mapa = { "Simples Receita": "a-simples-receita", "Simples PGFN": "a-simples-pgfn", "Previdencia Receita": "a-previdencia-receita", "Previdencia PGFN": "a-previdencia-pgfn" };
  return mapa[status] || "";
}
function encontrarParcelamentoDe(empresa) {
  const cnpjLimpo = limparDigitos(empresa.cnpj);
  return ESTADO.parcelamentos.find((p) => {
    const pCnpj = limparDigitos(p.cnpj);
    if (cnpjLimpo && cnpjLimpo === pCnpj) return true;
    if (!cnpjLimpo && !pCnpj && p.nome.toLowerCase() === empresa.nome.toLowerCase()) return true;
    return false;
  });
}

function sincronizarParcelamentosComEmpresas() {
  let mudou = false;
  ESTADO.grupos.forEach((g) => {
    g.empresas.forEach((empresa) => {
      let p = encontrarParcelamentoDe(empresa);
      if (!p) {
        p = {
          id: crypto.randomUUID(),
          nome: empresa.nome, statusAlternancia: "VAZIO", statusAlternancia2: "VAZIO", statusAlternancia3: "VAZIO", statusAlternancia4: "VAZIO",
          statusGeral: "SEM", cnpj: empresa.cnpj || "", senhaRegularize: empresa.senhaRegularize || "", comentarios: [], anexos: [],
        };
        ESTADO.parcelamentos.push(p);
        mudou = true;
      } else {
        if (p.nome !== empresa.nome) { p.nome = empresa.nome; mudou = true; }
        if (empresa.cnpj && p.cnpj !== empresa.cnpj) { p.cnpj = empresa.cnpj; mudou = true; }
        if (empresa.senhaRegularize && p.senhaRegularize !== empresa.senhaRegularize) { p.senhaRegularize = empresa.senhaRegularize; mudou = true; }
      }
    });
  });
  // Não marca como "não salvo": a sincronização é refeita sozinha toda vez que a página abre.
  return mudou;
}

function renderizarPagina() {
  sincronizarParcelamentosComEmpresas();
  renderizarDashboardParcelamentos();
  renderizarParcelamentos();
}

function renderizarDashboardParcelamentos() {
  const lista = ESTADO.parcelamentos;
  const { verde, vermelho, atencao } = contarStatus(lista, "statusGeral");
  const porTipo = (rotulo) => lista.filter((p) => [p.statusAlternancia, p.statusAlternancia2, p.statusAlternancia3, p.statusAlternancia4].some((s) => (s || "").startsWith(rotulo))).length;
  const kpiSimples = (nome, n, ic) => `
    <div class="kpi-card">
      <div class="kpi-topo"><span class="kpi-nome">${nome}</span><span class="kpi-icone">${icone(ic, "ico-sm")}</span></div>
      <div class="kpi-numero">${n}<small>com parcelamento</small></div>
    </div>`;
  $("#dashboard-parcelamentos").innerHTML =
    htmlKpi({ nome: "Parcelamentos", total: lista.length, verde, atencao, vermelho, destaque: true, iconeNome: "parcelamentos" }) +
    kpiSimples("Simples Nacional", porTipo("Simples"), "documento") +
    kpiSimples("Previdência", porTipo("Previdencia"), "escudo") +
    kpiAcordos(lista);
  const cont = $("#contador-parcelamentos");
  if (cont) cont.textContent = lista.length;
}

// ---------------------------------------------------------------------------
// E-MAIL (igual ao "enviarEmailExclusivoParcelamento" do app original)
// ---------------------------------------------------------------------------
async function enviarEmailParcelamentoOriginal(p, botao) {
  const empresa = buscarEmpresaPorCnpj(p.cnpj);
  if (!empresa || !empresa.email) {
    avisar("Nenhuma empresa cadastrada em Empresas com este CNPJ, ou o campo de e-mail dela está vazio.", { titulo: "Não foi possível enviar", tipo: "aviso" });
    return;
  }
  const nota = await perguntar("Mensagem para o cliente", { valor: "Olá, segue atualização sobre o andamento do seu Parcelamento.", textoOk: "Enviar e-mail" });
  if (nota === null) return;

  const assunto = `PARCELAMENTOS - ${p.nome}`;
  const corpoHtml = `<h3>Parcelamentos</h3>${escaparHtml(p.nome)}<p>Prezado cliente<b></b>,</p><p>Segue em anexo as guias dos parcelamentos</p><br><p>Atenciosamente,<br>Departamento Fiscal e Contábil</p>`;

  await comCarregando(botao, async () => {
    notificar(`Enviando e-mail para ${empresa.nome}...`, "carregando");
    try {
      const resp = await enviarEmailBruto({ destinatario: empresa.email, assunto, mensagem: corpoHtml, html: true, anexoIds: (p.anexos || []).map((a) => a.id) });
      notificar(`E-mail de parcelamento enviado para ${empresa.email}` + (resp.anexados ? ` (${resp.anexados} anexo(s))` : ""), "ok");
    } catch (err) {
      avisar("Falha ao enviar e-mail: " + err.message, { titulo: "E-mail não enviado", tipo: "erro" });
    }
  });
}

// WhatsApp do parcelamento: usa o número cadastrado na empresa com o mesmo CNPJ (igual ao e-mail)
function enviarWhatsAppParcelamento(p) {
  const empresa = buscarEmpresaPorCnpj(p.cnpj);
  if (!empresa || !empresa.whatsapp) {
    avisar("Nenhuma empresa com este CNPJ tem WhatsApp cadastrado. Cadastre o número em Empresas → abrir a empresa → WhatsApp do cliente.", { titulo: "WhatsApp não cadastrado", tipo: "aviso" });
    return;
  }
  abrirEnvioWhatsApp({
    destino: empresa.nome,
    telefone: empresa.whatsapp,
    anexos: p.anexos || [],
    tituloLink: `${p.nome} — guias de parcelamento`,
    montarMensagem: (link, validade) =>
      `Olá, tudo bem?\n\nSegue as guias dos parcelamentos de ${p.nome}.\n\n` +
      `Para baixar os arquivos, acesse:\n${link}\n(link disponível até ${validade})\n\nAtenciosamente,\nDepartamento Fiscal e Contábil — FZ CONT`,
    aoEnviar: (telefone) => {
      p.comentarios = p.comentarios || [];
      p.comentarios.push(`Guias enviadas pelo WhatsApp para ${telefone}\n${agora()}`);
      marcarAlterado();
      const wrap = EL_PARC.get(p.id);
      if (wrap && wrap.classList.contains("aberto")) { wrap.querySelector(".empresa-corpo")?.remove(); wrap.appendChild(criarCorpoParcelamento(p)); }
      notificar(`Envio registrado para ${p.nome}`, "ok");
    },
  });
}

$("#btn-novo-parcelamento").addEventListener("click", () => {
  abrirModal(`
    <h2>Novo parcelamento</h2>
    <p class="modal-sub">Empresas cadastradas em “Empresas” já aparecem aqui automaticamente.</p>
    <form id="form-novo-parc">
      <div class="campo-form"><label>Nome</label><input id="np-nome"></div>
      <div class="linha-dois-campos">
        <div class="campo-form"><label>CNPJ</label><input id="np-cnpj" inputmode="numeric"></div>
        <div class="campo-form"><label>Senha do Regularize</label><input id="np-senha" autocomplete="off"></div>
      </div>
      <div id="np-erro" class="mensagem-erro oculto"></div>
      <div class="modal-rodape">
        <button type="button" class="btn-ghost" id="np-cancelar">Cancelar</button>
        <button type="submit" class="btn-primario">${icone("mais")}Adicionar</button>
      </div>
    </form>`);
  $("#np-cancelar").addEventListener("click", fecharModal);
  $("#form-novo-parc").addEventListener("submit", (e) => {
    e.preventDefault();
    const nome = $("#np-nome").value.trim();
    const cnpj = $("#np-cnpj").value.trim();
    if (!nome && !cnpj) { $("#np-erro").textContent = "Informe nome ou CNPJ."; $("#np-erro").classList.remove("oculto"); return; }
    const p = {
      id: crypto.randomUUID(),
      nome: nome || "Parcelamento sem nome", cnpj, senhaRegularize: $("#np-senha").value.trim(),
      statusAlternancia: "VAZIO", statusAlternancia2: "VAZIO", statusAlternancia3: "VAZIO", statusAlternancia4: "VAZIO",
      statusGeral: "SEM", comentarios: [], anexos: [],
    };
    ESTADO.parcelamentos.push(p);
    PARCELAMENTOS_ABERTOS.add(p.id);
    fecharModal();
    marcarAlterado();
    renderizarParcelamentos();
    renderizarDashboardParcelamentos();
    requestAnimationFrame(() => EL_PARC.get(p.id)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  });
});

function parcPassaFiltro(p) {
  if (!filtroParc) return true;
  return (p.nome || "").toLowerCase().includes(filtroParc) || (p.cnpj || "").includes(filtroParc) || limparDigitos(p.cnpj).includes(limparDigitos(filtroParc) || "\u0000");
}

function renderizarParcelamentos() {
  const cont = $("#lista-parcelamentos");
  EL_PARC.clear();
  const visiveis = ESTADO.parcelamentos.filter(parcPassaFiltro);
  if (!visiveis.length) {
    cont.innerHTML = filtroParc
      ? `<div class="vazio">${icone("busca", "ico-xl")}<strong>Nada encontrado</strong><p>Nenhum parcelamento com “${escaparHtml(filtroParc)}”.</p></div>`
      : `<div class="vazio">${icone("parcelamentos", "ico-xl")}<strong>Nenhum parcelamento</strong><p>Cadastre empresas na página Empresas ou clique em “+ Parcelamento”.</p></div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  visiveis.forEach((p) => frag.appendChild(criarParcelamentoCard(p)));
  cont.replaceChildren(frag);
}

const CAMPOS_ALT = ["statusAlternancia", "statusAlternancia2", "statusAlternancia3", "statusAlternancia4"];

function htmlCabecalhoParc(p) {
  const tipos = CAMPOS_ALT.map((c) => p[c]).filter((s) => s && s !== "VAZIO");
  return `
    <div class="empresa-nome-wrap">
      <span class="empresa-nome">${icone("seta", "chevron")}<span class="texto">${escaparHtml(p.nome)}</span></span>
      <div class="selos-linha">${seloAcordos(p)}${(p.anexos || []).length ? `<span class="selo selo-anexado">${icone("clipe")}ANEXADO${p.anexos.length > 1 ? " · " + p.anexos.length : ""}</span>` : ""}${tipos.map((t) => `<span class="selo selo-alt">${escaparHtml(ROTULO_ALTERNANCIA[t] || t)}</span>`).join("")}</div>
    </div>
    <div class="chips-acesso">
      ${botaoCopiaSe(p.cnpj, "CNPJ")}
      ${botaoCopiaSe(p.senhaRegularize, "Regularize")}
      <button type="button" class="chip-copia chip-email" data-email title="Enviar e-mail com as guias">${icone("email")}Enviar e-mail</button>
      <button type="button" class="chip-copia chip-whatsapp" data-whatsapp title="Enviar as guias pelo WhatsApp do cliente">${icone("conversa")}WhatsApp</button>
    </div>
    <button type="button" class="btn-icone" data-excluir title="Excluir">${icone("lixeira")}</button>`;
}

function criarParcelamentoCard(p) {
  const aberto = PARCELAMENTOS_ABERTOS.has(p.id);
  const wrap = document.createElement("div");
  wrap.className = `empresa-card ${classeStatus(p.statusGeral)}${aberto ? " aberto" : ""}`;
  wrap.dataset.id = p.id;
  const header = document.createElement("div");
  header.className = "parcelamento-header";
  header.setAttribute("role", "button");
  header.tabIndex = 0;
  header.setAttribute("aria-expanded", aberto);
  header.innerHTML = htmlCabecalhoParc(p);
  header.addEventListener("click", (e) => {
    const copia = e.target.closest("[data-copiar]");
    if (copia) return copiar(copia.dataset.copiar, { CNPJ: p.cnpj, Regularize: p.senhaRegularize }[copia.dataset.copiar]);
    if (e.target.closest("[data-email]")) return enviarEmailParcelamentoOriginal(p, e.target.closest("[data-email]"));
    if (e.target.closest("[data-whatsapp]")) return enviarWhatsAppParcelamento(p);
    if (e.target.closest("[data-excluir]")) return excluirParcelamento(p);
    alternarParcelamento(p);
  });
  header.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === header) { e.preventDefault(); alternarParcelamento(p); }
  });
  wrap.appendChild(header);
  if (aberto) wrap.appendChild(criarCorpoParcelamento(p));
  EL_PARC.set(p.id, wrap);
  return wrap;
}

function alternarParcelamento(p) {
  const wrap = EL_PARC.get(p.id);
  if (!wrap) return;
  const abrir = !wrap.classList.contains("aberto");
  if (abrir) PARCELAMENTOS_ABERTOS.add(p.id); else PARCELAMENTOS_ABERTOS.delete(p.id);
  wrap.classList.toggle("aberto", abrir);
  wrap.querySelector(".parcelamento-header").setAttribute("aria-expanded", abrir);
  const corpo = wrap.querySelector(".empresa-corpo");
  if (abrir && !corpo) wrap.appendChild(criarCorpoParcelamento(p));
  if (!abrir && corpo) corpo.remove();
}

function atualizarParcelamento(p) {
  const wrap = EL_PARC.get(p.id);
  if (!wrap) return;
  wrap.className = `empresa-card ${classeStatus(p.statusGeral)}${wrap.classList.contains("aberto") ? " aberto" : ""}`;
  wrap.querySelector(".parcelamento-header").innerHTML = htmlCabecalhoParc(p);
}

async function excluirParcelamento(p) {
  const ok = await confirmar(`"${p.nome}" será removido da lista de parcelamentos.`, { titulo: "Excluir parcelamento?", textoOk: "Excluir", perigo: true });
  if (!ok) return;
  const i = ESTADO.parcelamentos.indexOf(p);
  if (i >= 0) ESTADO.parcelamentos.splice(i, 1);
  PARCELAMENTOS_ABERTOS.delete(p.id);
  EL_PARC.get(p.id)?.remove();
  EL_PARC.delete(p.id);
  renderizarDashboardParcelamentos();
  marcarAlterado();
  if (!ESTADO.parcelamentos.some(parcPassaFiltro)) renderizarParcelamentos();
}

// ---------------------------------------------------------------------------
// IMPORTAR PDFs EM LOTE (igual ao "processarPdfParcelamento" do app original)
// ---------------------------------------------------------------------------
$("#btn-importar-pdfs")?.addEventListener("click", () => $("#input-importar-pdfs").click());
$("#input-importar-pdfs")?.addEventListener("change", async (e) => {
  const arquivos = [...e.target.files];
  e.target.value = "";
  if (!arquivos.length) return;

  let vinculados = 0, jaExistiam = 0, semCnpj = 0, semParcelamento = 0, comErro = 0, extratos = 0;
  await comCarregando($("#btn-importar-pdfs"), async () => {
    for (const [i, arquivo] of arquivos.entries()) {
      notificar(`Analisando PDF ${i + 1} de ${arquivos.length}...`, "carregando");
      try {
        const texto = await extrairTextoPdf(arquivo);
        if (!texto.trim()) { comErro++; continue; }
        const extrato = lerExtratoParcelamento(texto);
        if (extrato) {
          const alvo = extrato.cnpj && buscarParcelamentoPorCnpj(extrato.cnpj);
          if (!alvo) { semParcelamento++; continue; }
          await registrarExtrato(alvo, extrato, arquivo);
          extratos++;
          continue;
        }
        const cnpjEncontrado = extrairCnpjDoTexto(texto);
        if (!cnpjEncontrado) { semCnpj++; continue; }
        const parcelamento = buscarParcelamentoPorCnpj(cnpjEncontrado);
        if (!parcelamento) { semParcelamento++; continue; }

        parcelamento.anexos = parcelamento.anexos || [];
        const resp = await anexarArquivoNaLista(parcelamento.anexos, arquivo);
        if (!resp) { jaExistiam++; continue; }

        const competencia = extrairCompetenciaDoTexto(texto);
        const valor = extrairValorDoTexto(texto);
        let comentario = "Guia de Parcelamento processada via PDF.";
        if (competencia) comentario += `\nCompetência: ${competencia}`;
        if (valor) comentario += `\nValor Total: R$ ${valor}`;
        parcelamento.comentarios.push(`${comentario}\n${agora()}`);
        vinculados++;
      } catch (err) {
        console.error("Erro ao processar PDF", arquivo.name, err);
        comErro++;
      }
    }
  });

  if (vinculados || extratos) marcarAlterado();
  renderizarParcelamentos();
  renderizarDashboardParcelamentos();

  const linhas = [`${vinculados} guia(s) vinculada(s) aos parcelamentos.`];
  if (extratos) linhas.unshift(`${extratos} extrato(s) de parcelamento lido(s) (parcelas pagas e em aberto atualizadas).`);
  if (jaExistiam) linhas.push(`${jaExistiam} já estavam anexados (ignorados).`);
  if (semCnpj) linhas.push(`${semCnpj} sem CNPJ localizado no PDF.`);
  if (semParcelamento) linhas.push(`${semParcelamento} sem parcelamento cadastrado com esse CNPJ.`);
  if (comErro) linhas.push(`${comErro} com erro de leitura.`);
  if (vinculados || extratos) linhas.push("\nClique em Salvar para gravar.");
  notificar(`Lote processado: ${vinculados + extratos} arquivo(s) aproveitado(s)`, vinculados || extratos ? "ok" : "aviso");
  avisar(linhas.join("\n"), { titulo: "Importação concluída", tipo: vinculados || extratos ? "ok" : "aviso" });
});

// ---------------------------------------------------------------------------
// ACORDOS (extratos do e-CAC / PGFN): parcelas pagas, em aberto, saldo e relatório
// ---------------------------------------------------------------------------
const brl = (n) => (n == null || !Number.isFinite(Number(n)) ? "—" : Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const dataBr = (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
const mesBr = (aaaaMm) => (aaaaMm ? aaaaMm.slice(5, 7) + "/" + aaaaMm.slice(0, 4) : "—");
const ROTULO_STATUS_ACORDO = { em_dia: ["Em dia", "ok"], atraso: ["Em atraso", "erro"], quitado: ["Quitado", "quitado"], rescindido: ["Rescindido", "neutro"] };
const nomeOrgao = (a) => ({ RFB: "Receita Federal", PGFN: "PGFN", SEFAZ: "Estado (SEFAZ)", MUN: "Município", OUTRO: "Outro" })[a.orgao] || a.orgao || "—";

function acordosDe(p) { return Array.isArray(p.acordos) ? p.acordos : []; }

function seloAcordos(p) {
  const lista = acordosDe(p);
  if (!lista.length) return "";
  const resumos = lista.map((a) => resumoAcordo(a));
  const ativos = resumos.filter((r) => r.status === "em_dia" || r.status === "atraso");
  const abertas = ativos.reduce((s, r) => s + (r.abertas || 0), 0);
  const atraso = resumos.some((r) => r.status === "atraso");
  if (!ativos.length) return `<span class="selo selo-acordo quitado">${icone("check")}Quitado</span>`;
  return `<span class="selo selo-acordo${atraso ? " atraso" : ""}" title="${ativos.length} acordo(s) ativo(s)">${icone(atraso ? "alerta" : "calendario")}${abertas} parc. em aberto${atraso ? " · atraso" : ""}</span>`;
}

function kpiAcordos(lista) {
  let saldo = 0, abertas = 0, ativos = 0, estimado = false;
  for (const p of lista) for (const a of acordosDe(p)) {
    const r = resumoAcordo(a);
    if (r.status !== "em_dia" && r.status !== "atraso") continue;
    ativos++; abertas += r.abertas || 0; saldo += r.saldo || 0; estimado = estimado || r.estimado;
  }
  return `
    <div class="kpi-card">
      <div class="kpi-topo"><span class="kpi-nome">Saldo em aberto</span><span class="kpi-icone">${icone("grafico", "ico-sm")}</span></div>
      <div class="kpi-numero kpi-numero-moeda">${ativos ? (estimado ? "≈ " : "") + brl(saldo) : "—"}<small>${ativos ? `${abertas} parcela(s) · ${ativos} acordo(s)` : "envie os extratos"}</small></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// CORPO DO CARD EM ABAS: "Visão geral" + uma aba por parcelamento (acordo) + "+ Parcelamento"
// ---------------------------------------------------------------------------
const ABA_PARC = new Map(); // id do parcelamento -> "geral" | id do acordo | "novo"
const ORGAOS = { RFB: "Receita Federal", PGFN: "PGFN", SEFAZ: "Estado (SEFAZ)", MUN: "Município", OUTRO: "Outro" };
const ORGAO_CURTO = { RFB: "Receita", PGFN: "PGFN", SEFAZ: "Estado", MUN: "Município", OUTRO: "Outro" };

function tipoCurto(a) {
  let t = String(a.tipo || "Parcelamento").replace(/^\d+\s*-\s*/, "").replace(/^Parcelamento (d[oae]s?|de)\s+/i, "");
  if (t === t.toUpperCase() && t.length > 12) t = t.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()).replace(/\b(Do|Da|De|Dos|Das|E|Ao|Até)\b/g, (c) => c.toLowerCase());
  if (t.length > 26) t = t.slice(0, 24).trimEnd() + "…";
  return t;
}
function rotuloAba(a) {
  if (a.orgao === "PGFN" && a.numero) return `PGFN · nº ${a.numero}`;
  return `${ORGAO_CURTO[a.orgao] || a.orgao} · ${tipoCurto(a)}`;
}

function criarCorpoParcelamento(p) {
  const corpo = document.createElement("div");
  corpo.className = "empresa-corpo";
  const nav = document.createElement("nav");
  nav.className = "abas-parc";
  nav.setAttribute("role", "tablist");
  const painel = document.createElement("div");
  painel.className = "painel-aba-parc";
  corpo.append(nav, painel);

  const desenhar = () => {
    const lista = acordosDe(p);
    let aba = ABA_PARC.get(p.id) || "geral";
    if (aba !== "geral" && aba !== "novo" && !lista.some((a) => a.id === aba)) aba = "geral";
    ABA_PARC.set(p.id, aba);
    nav.innerHTML = `
      <button type="button" role="tab" class="aba-parc${aba === "geral" ? " ativa" : ""}" data-aba="geral">${icone("empresas")}Visão geral</button>
      ${lista.map((a) => { const r = resumoAcordo(a); return `
        <button type="button" role="tab" class="aba-parc st-${r.status}${aba === a.id ? " ativa" : ""}" data-aba="${a.id}" title="${escaparHtml(a.tipo || "")}">
          <i class="ponto-st"></i>${escaparHtml(rotuloAba(a))}<em>${r.status === "quitado" ? "quitado" : `${r.abertas ?? "?"} em aberto`}</em>
        </button>`; }).join("")}
      <button type="button" role="tab" class="aba-parc aba-nova${aba === "novo" ? " ativa" : ""}" data-aba="novo">${icone("mais")}Parcelamento</button>`;
    painel.replaceChildren(aba === "geral" ? painelGeral(p, irPara) : aba === "novo" ? painelNovo(p, irPara) : painelAcordo(p, lista.find((a) => a.id === aba), irPara));
  };
  const irPara = (aba) => { ABA_PARC.set(p.id, aba); desenhar(); atualizarParcelamento(p); renderizarDashboardParcelamentos(); };
  nav.addEventListener("click", (e) => { const b = e.target.closest("[data-aba]"); if (b) { ABA_PARC.set(p.id, b.dataset.aba); desenhar(); } });
  desenhar();
  corpo.redesenhar = desenhar;
  return corpo;
}

// ---------------- Visão geral ----------------
function painelGeral(p, irPara) {
  const box = document.createElement("div");
  const barra = document.createElement("div");
  barra.className = "barra-opcoes";
  const alt = (campo) => `<button type="button" class="alternancia-btn ${classeAlternancia(p[campo])}" data-alt="${campo}" title="Clique para alternar o tipo">${escaparHtml(ROTULO_ALTERNANCIA[p[campo] || "VAZIO"] || p[campo])}</button>`;
  barra.innerHTML = `${htmlBotoesStatus(p.statusGeral)}<span class="separador-v"></span>${CAMPOS_ALT.map(alt).join("")}`;
  barra.addEventListener("click", (e) => {
    const st = e.target.closest("[data-status]");
    if (st) {
      p.statusGeral = p.statusGeral === st.dataset.status ? "SEM" : st.dataset.status;
      atualizarBotoesStatus(barra, p.statusGeral); atualizarParcelamento(p); renderizarDashboardParcelamentos(); marcarAlterado();
      return;
    }
    const a = e.target.closest("[data-alt]");
    if (a) {
      const campo = a.dataset.alt;
      p[campo] = proximoAlternancia(p[campo]);
      a.className = `alternancia-btn ${classeAlternancia(p[campo])}`;
      a.textContent = ROTULO_ALTERNANCIA[p[campo]] || p[campo];
      atualizarParcelamento(p); renderizarDashboardParcelamentos(); marcarAlterado();
    }
  });
  box.appendChild(barra);

  const campos = document.createElement("div");
  campos.className = "grade-campos";
  campos.innerHTML = [["nome", "Nome"], ["cnpj", "CNPJ"], ["senhaRegularize", "Senha do Regularize"]].map(([c, r]) =>
    `<div class="campo-form"><label>${r}</label><input data-campo="${c}" value="${escaparHtml(p[c] || "")}" autocomplete="off" spellcheck="false"></div>`).join("");
  campos.addEventListener("change", (e) => {
    const inp = e.target.closest("[data-campo]");
    if (!inp) return;
    const valor = inp.value.trim();
    if (inp.dataset.campo === "nome" && !valor) { inp.value = p.nome; return; }
    p[inp.dataset.campo] = valor;
    atualizarParcelamento(p); marcarAlterado();
    inp.classList.add("salvo"); setTimeout(() => inp.classList.remove("salvo"), 700);
  });
  box.appendChild(campos);

  // resumo dos parcelamentos desta empresa
  const lista = acordosDe(p);
  const res = document.createElement("div");
  res.className = "resumo-acordos";
  if (lista.length) {
    res.innerHTML = `<h4 class="bloco-titulo">${icone("calendario", "ico-sm")}Parcelamentos desta empresa <span class="contador-pilula">${lista.length}</span>
        <button type="button" class="btn-ghost btn-sm" data-rel>${icone("imprimir")}Relatório da empresa</button></h4>
      <div class="mini-acordos">${lista.map((a) => { const r = resumoAcordo(a); const [rot, tom] = ROTULO_STATUS_ACORDO[r.status] || [r.status, "neutro"]; return `
        <button type="button" class="mini-acordo st-${r.status}" data-ir="${a.id}">
          <span class="ma-topo"><b>${escaparHtml(rotuloAba(a))}</b><span class="ac-status ${tom}">${rot}</span></span>
          <span class="ac-progresso"><i style="width:${Math.round(r.progresso * 100)}%"></i></span>
          <span class="ma-linha"><span>${r.pagas ?? "—"}/${r.total ?? "?"} pagas · ${r.abertas ?? "—"} em aberto</span><b>${r.status === "quitado" ? "quitado" : (r.estimado ? "≈ " : "") + brl(r.saldo)}</b></span>
        </button>`; }).join("")}</div>`;
    res.addEventListener("click", (e) => {
      const b = e.target.closest("[data-ir]"); if (b) return irPara(b.dataset.ir);
      if (e.target.closest("[data-rel]")) abrirRelatorioParcelamentos({ ids: [p.id], filtro: "todos", detalhado: true });
    });
  } else {
    res.innerHTML = `<div class="acordos-vazio">${icone("calendario")}<p>Nenhum parcelamento lançado nesta empresa. Clique em <b>+ Parcelamento</b> para importar o extrato (e-CAC / PGFN) ou cadastrar à mão — cada parcelamento ganha a sua aba.</p>
      <button type="button" class="btn-secundario btn-sm" data-novo>${icone("mais")}Parcelamento</button></div>`;
    res.addEventListener("click", (e) => { if (e.target.closest("[data-novo]")) irPara("novo"); });
  }
  box.appendChild(res);

  const duas = document.createElement("div");
  duas.className = "duas-colunas-detalhe";
  duas.append(montarColunaComentarios(p), montarColunaAnexos(p, { aoMudar: () => atualizarParcelamento(p), nomeAlvo: "desta empresa" }));
  box.appendChild(duas);
  return box;
}

// ---------------- Aba de um parcelamento ----------------
function painelAcordo(p, a, irPara) {
  const box = document.createElement("div");
  box.className = "painel-acordo";
  const r = resumoAcordo(a);
  const [rot, tom] = ROTULO_STATUS_ACORDO[r.status] || [r.status, "neutro"];
  const prox = r.proxima ? `${r.proxima.ref ? mesBr(r.proxima.ref) : dataBr(r.proxima.vencimento)} · ${brl(r.proxima.valor)}` : "—";
  const dado = (rotulo, valor, extra = "") => `<div class="ac-dado${extra}"><span>${rotulo}</span><b>${valor}</b></div>`;
  const hoje = new Date().toISOString().slice(0, 10);
  const linhas = (r.listaParcelas || []).map((x, i) => `
    <tr class="${x.paga ? "paga" : x.vencimento && x.vencimento < hoje ? "vencida" : ""}">
      <td>${x.n}</td><td>${x.ref ? mesBr(x.ref) : escaparHtml(x.tipo || "")}</td><td>${dataBr(x.vencimento)}</td><td class="num">${brl(x.valor)}</td>
      <td>${x.paga ? `${icone("check")}Paga${x.dataPagamento ? " em " + dataBr(x.dataPagamento) : ""}` : x.saldo != null ? `Em aberto · ${brl(x.saldo)}` : "Em aberto"}</td>
      ${a.manual ? `<td class="acao"><button type="button" class="btn-ghost btn-xs" data-pagar="${i}">${x.paga ? "Desmarcar" : "Marcar paga"}</button></td>` : ""}
    </tr>`).join("");
  box.innerHTML = `
    <header class="acordo-cab">
      <span class="ac-orgao ${a.orgao === "PGFN" ? "pgfn" : "rfb"}">${escaparHtml(ORGAOS[a.orgao] || a.orgao)}</span>
      <div class="ac-titulo"><b>${escaparHtml(a.tipo || "Parcelamento")}</b>
        <small>${[a.numero ? `Nº ${escaparHtml(a.numero)}` : "", a.situacao ? escaparHtml(a.situacao) : "", a.dataAdesao ? "adesão " + dataBr(a.dataAdesao) : "", a.manual ? "cadastrado à mão" : ""].filter(Boolean).join(" · ")}</small></div>
      <span class="ac-status ${tom}">${rot}</span>
    </header>
    <div class="acordo-acoes">
      <button type="button" class="btn-secundario btn-sm" data-atualizar>${icone("enviar")}${a.manual ? "Importar extrato (PDF)" : "Atualizar com extrato (PDF)"}</button>
      <input type="file" accept="application/pdf" multiple class="oculto" data-arquivo>
      <button type="button" class="btn-ghost btn-sm" data-editar>${icone("chave")}Editar dados</button>
      <button type="button" class="btn-ghost btn-sm" data-rel>${icone("imprimir")}Relatório</button>
      <button type="button" class="btn-ghost btn-sm btn-ac-remover" data-remover>${icone("lixeira")}Excluir parcelamento</button>
    </div>
    <div class="ac-progresso" title="${r.pagas ?? 0} de ${r.total ?? "?"} parcelas pagas"><i style="width:${Math.round(r.progresso * 100)}%"></i></div>
    <div class="ac-dados">
      ${dado("Valor consolidado", brl(a.valorConsolidado))}
      ${dado("Parcelas pagas", `${r.pagas ?? "—"} <small>de ${r.total ?? "?"}</small>`)}
      ${dado("Em aberto", `${r.abertas ?? "—"}${r.atrasadas ? ` <em class="ac-atraso">${r.atrasadas} vencida(s)</em>` : ""}`)}
      ${dado("Valor da parcela", brl(r.valorParcela) + (r.estimado ? ' <small title="A parcela do Simples Nacional é corrigida pela Selic todo mês">últ. paga</small>' : ""))}
      ${dado("Total já pago", brl(r.totalPago))}
      ${dado(r.estimado ? "Saldo estimado" : "Saldo devedor", (r.status === "quitado" ? brl(0) : (r.estimado ? "≈ " : "") + brl(r.saldo)), " destaque")}
      ${dado("Próxima parcela", r.status === "quitado" ? "—" : prox)}
      ${dado("Termina em", r.termino ? (r.estimado ? mesBr(r.termino.slice(0, 7)) : dataBr(r.termino)) : "—")}
    </div>
    ${(a.debitos || []).length ? `<p class="ac-debitos">${icone("documento")}Débitos parcelados: ${a.debitos.map((d) => mesBr(d.periodo)).join(", ")}</p>` : ""}
    ${linhas ? `<div class="acordo-parcelas"><table><thead><tr><th>Nº</th><th>Referência</th><th>Vencimento</th><th class="num">Valor</th><th>Situação</th>${a.manual ? "<th></th>" : ""}</tr></thead><tbody>${linhas}</tbody></table></div>` : ""}
    <p class="ac-rodape-txt">${a.atualizadoEm ? "Atualizado em " + dataBr(a.atualizadoEm) : ""}${(a.fontes || []).length ? " · extratos: " + a.fontes.map(escaparHtml).join(", ") : ""}${r.estimado ? " · saldo estimado = parcelas restantes × última parcela paga" : ""}</p>`;
  const duas = document.createElement("div");
  duas.className = "duas-colunas-detalhe";
  duas.append(montarColunaComentarios(a), montarColunaAnexos(a, { aoMudar: () => {}, nomeAlvo: "deste parcelamento" }));
  box.appendChild(duas);

  box.addEventListener("click", async (e) => {
    if (e.target.closest("[data-atualizar]")) return box.querySelector("[data-arquivo]").click();
    if (e.target.closest("[data-rel]")) return abrirRelatorioParcelamentos({ ids: [p.id], filtro: "todos", detalhado: true, acordoId: a.id });
    if (e.target.closest("[data-editar]")) return abrirFormAcordo(p, a, irPara);
    const pg = e.target.closest("[data-pagar]");
    if (pg && a.manual) {
      const parc = a.parcelas[+pg.dataset.pagar];
      const paga = !((parc.saldo || 0) > 0.004);
      parc.saldo = paga ? parc.valor : 0;
      parc.dataPagamento = paga ? null : new Date().toISOString().slice(0, 10);
      a.atualizadoEm = new Date().toISOString();
      marcarAlterado(); irPara(a.id);
      return;
    }
    if (e.target.closest("[data-remover]")) {
      if (!(await confirmar(`O parcelamento “${rotuloAba(a)}” e a aba dele saem desta empresa (os documentos anexados nele também).`, { titulo: "Excluir parcelamento?", textoOk: "Excluir", perigo: true }))) return;
      for (const anexo of a.anexos || []) { try { await api(`/api/anexos/${anexo.id}`, { method: "DELETE" }); } catch (_) {} }
      p.acordos = acordosDe(p).filter((x) => x !== a);
      marcarAlterado(); irPara("geral");
    }
  });
  box.querySelector("[data-arquivo]").addEventListener("change", async (e) => {
    const arquivos = [...e.target.files]; e.target.value = "";
    const ids = await importarExtratosNaEmpresa(p, arquivos, box.querySelector("[data-atualizar]"));
    if (ids.length) irPara(ids[ids.length - 1]);
  });
  return box;
}

// ---------------- "+ Parcelamento" ----------------
function painelNovo(p, irPara) {
  const box = document.createElement("div");
  box.className = "painel-novo";
  box.innerHTML = `
    <div class="opcoes-novo">
      <label class="opcao-novo">
        <span class="on-ico">${icone("enviar")}</span>
        <b>Importar extrato (PDF)</b>
        <small>e-CAC: <i>Consulta Pedidos de Parcelamento</i> ou <i>Recibo de adesão</i> · PGFN: <i>Consulta de Negociações</i>. Cada parcelamento vira uma aba, com as parcelas pagas e em aberto.</small>
        <input type="file" accept="application/pdf" multiple class="oculto" data-arquivo>
      </label>
      <button type="button" class="opcao-novo" data-manual>
        <span class="on-ico">${icone("mais")}</span>
        <b>Cadastrar à mão</b>
        <small>Para parcelamentos do Estado, do Município ou quando não tiver o PDF: informe o valor, o nº de parcelas e o 1º vencimento — depois é só marcar as pagas.</small>
      </button>
    </div>`;
  box.querySelector("[data-arquivo]").addEventListener("change", async (e) => {
    const arquivos = [...e.target.files]; e.target.value = "";
    const ids = await importarExtratosNaEmpresa(p, arquivos, box.querySelector(".opcao-novo"));
    if (ids.length) irPara(ids[ids.length - 1]);
  });
  box.querySelector("[data-manual]").addEventListener("click", () => abrirFormAcordo(p, null, irPara));
  return box;
}

function abrirFormAcordo(p, a, irPara) {
  const novo = !a;
  const v = a || { orgao: "RFB" };
  const r = a ? resumoAcordo(a) : null;
  const podeParcelas = novo || a.manual;
  abrirModal(`
    <h2>${novo ? "Novo parcelamento" : "Editar parcelamento"}</h2>
    <p class="modal-sub">${escaparHtml(p.nome)}${!novo && !a.manual ? " · os números vêm do extrato: para mudar parcelas e saldo, importe um extrato novo." : ""}</p>
    <form id="form-acordo">
      <div class="linha-dois-campos">
        <div class="campo-form"><label>Órgão</label><select id="fa-orgao">${Object.entries(ORGAOS).map(([k, n]) => `<option value="${k}"${v.orgao === k ? " selected" : ""}>${n}</option>`).join("")}</select></div>
        <div class="campo-form"><label>Nº do parcelamento / negociação</label><input id="fa-numero" value="${escaparHtml(v.numero || "")}"></div>
      </div>
      <div class="campo-form"><label>Modalidade</label><input id="fa-tipo" value="${escaparHtml(v.tipo || "")}" placeholder="Ex.: Parcelamento do Simples Nacional, PERT, Transação PGFN, ICMS..."></div>
      <div class="linha-dois-campos">
        <div class="campo-form"><label>Situação</label><input id="fa-situacao" value="${escaparHtml(v.situacao || "")}" placeholder="Ex.: Em parcelamento"></div>
        <div class="campo-form"><label>Data da adesão</label><input id="fa-adesao" type="date" value="${v.dataAdesao || ""}"></div>
      </div>
      <div class="campo-form"><label>Valor consolidado (R$)</label><input id="fa-valor" inputmode="decimal" value="${v.valorConsolidado != null ? String(v.valorConsolidado).replace(".", ",") : ""}"></div>
      ${podeParcelas ? `
      <div class="linha-dois-campos">
        <div class="campo-form"><label>Nº de parcelas</label><input id="fa-qtd" inputmode="numeric" value="${v.qtdParcelas || ""}"></div>
        <div class="campo-form"><label>Valor da parcela (R$)</label><input id="fa-parcela" inputmode="decimal" value="${v.parcelaBasica != null ? String(v.parcelaBasica).replace(".", ",") : ""}"></div>
      </div>
      <div class="linha-dois-campos">
        <div class="campo-form"><label>Vencimento da 1ª parcela</label><input id="fa-venc" type="date" value="${(v.parcelas && v.parcelas[0] && v.parcelas[0].vencimento) || ""}"></div>
        <div class="campo-form"><label>Parcelas já pagas</label><input id="fa-pagas" inputmode="numeric" value="${r ? r.pagas : 0}"></div>
      </div>` : ""}
      <div id="fa-erro" class="mensagem-erro oculto"></div>
      <div class="modal-rodape">
        <button type="button" class="btn-ghost" id="fa-cancelar">Cancelar</button>
        <button type="submit" class="btn-primario">${icone("salvar")}${novo ? "Criar aba" : "Salvar"}</button>
      </div>
    </form>`);
  $("#fa-cancelar").addEventListener("click", fecharModal);
  const n = (id) => { const t = ($(id)?.value || "").trim(); if (!t) return null; const x = Number(t.replace(/\./g, "").replace(",", ".")); return Number.isFinite(x) ? x : NaN; };
  $("#form-acordo").addEventListener("submit", (e) => {
    e.preventDefault();
    const erro = (m) => { $("#fa-erro").textContent = m; $("#fa-erro").classList.remove("oculto"); };
    const dados = {
      orgao: $("#fa-orgao").value, numero: $("#fa-numero").value.trim() || null, tipo: $("#fa-tipo").value.trim() || "Parcelamento",
      situacao: $("#fa-situacao").value.trim() || null, dataAdesao: $("#fa-adesao").value || null, valorConsolidado: n("#fa-valor"),
    };
    if (Number.isNaN(dados.valorConsolidado)) return erro("Valor consolidado inválido.");
    if (podeParcelas) {
      const qtd = n("#fa-qtd"), parcela = n("#fa-parcela"), pagas = n("#fa-pagas") || 0, venc = $("#fa-venc").value;
      if (!qtd || qtd < 1 || qtd > 600 || !Number.isInteger(qtd)) return erro("Informe o nº de parcelas (1 a 600).");
      if (!parcela || Number.isNaN(parcela)) return erro("Informe o valor da parcela.");
      if (!venc) return erro("Informe o vencimento da 1ª parcela.");
      if (pagas < 0 || pagas > qtd || !Number.isInteger(pagas)) return erro("Parcelas já pagas: de 0 até o nº de parcelas.");
      const mesmo = a && a.parcelas && a.qtdParcelas === qtd && a.parcelaBasica === parcela && a.parcelas[0] && a.parcelas[0].vencimento === venc && resumoAcordo(a).pagas === pagas;
      Object.assign(dados, { qtdParcelas: qtd, parcelaBasica: parcela, manual: true });
      if (!mesmo) dados.parcelas = gerarParcelasManuais({ qtd, valor: parcela, primeiroVencimento: venc, jaPagas: pagas });
      if (!dados.valorConsolidado) dados.valorConsolidado = Math.round(qtd * parcela * 100) / 100;
    }
    if (novo) {
      const acordo = { id: crypto.randomUUID(), ...dados, pagamentos: [], comentarios: [], anexos: [], fontes: [], atualizadoEm: new Date().toISOString() };
      p.acordos = acordosDe(p); p.acordos.push(acordo);
      fecharModal(); marcarAlterado(); irPara(acordo.id);
    } else {
      Object.assign(a, dados, { atualizadoEm: new Date().toISOString() });
      fecharModal(); marcarAlterado(); irPara(a.id);
    }
  });
}

// Importa um ou mais extratos para esta empresa; devolve os ids dos acordos (abas) criados/atualizados.
async function importarExtratosNaEmpresa(p, arquivos, botao) {
  const ids = [], problemas = [];
  await comCarregando(botao, async () => {
    for (const arquivo of arquivos) {
      try {
        const texto = await extrairTextoPdf(arquivo);
        const extrato = lerExtratoParcelamento(texto);
        if (!extrato) { problemas.push(`${arquivo.name}: não parece um extrato de parcelamento do e-CAC ou da PGFN. (Para guardar como documento, use a área Documentos.)`); continue; }
        if (extrato.cnpj && limparDigitos(p.cnpj) && limparDigitos(extrato.cnpj) !== limparDigitos(p.cnpj)) {
          const seguir = await confirmar(`${arquivo.name} é do CNPJ ${extrato.cnpj}, mas esta empresa é do CNPJ ${p.cnpj}.`, { titulo: "CNPJ diferente", textoOk: "Importar mesmo assim" });
          if (!seguir) continue;
        }
        const acordo = await registrarExtrato(p, extrato, arquivo);
        ids.push(acordo.id);
      } catch (err) { problemas.push(`${arquivo.name}: ${err.message}`); }
    }
  });
  if (ids.length) { marcarAlterado(); notificar(`${ids.length} extrato(s) lido(s). Clique em Salvar para gravar.`, "ok"); }
  if (problemas.length) avisar(problemas.join("\n"), { titulo: "Alguns arquivos não foram lidos", tipo: "aviso" });
  return ids;
}

async function registrarExtrato(p, extrato, arquivo) {
  p.acordos = acordosDe(p);
  const { acordo, novo } = mesclarAcordo(p.acordos, extrato.acordo, { arquivo: arquivo.name });
  acordo.anexos = acordo.anexos || [];
  acordo.comentarios = acordo.comentarios || [];
  try { await anexarArquivoNaLista(acordo.anexos, arquivo); } catch (_) { /* o parcelamento vale mesmo sem o anexo */ }
  const r = resumoAcordo(acordo);
  acordo.comentarios.push(`${novo ? "Parcelamento importado" : "Atualizado"} pelo extrato ${arquivo.name}.\n` +
    `Parcelas: ${r.pagas ?? "?"} pagas de ${r.total ?? "?"} · ${r.abertas ?? "?"} em aberto · saldo ${r.estimado ? "≈ " : ""}${brl(r.saldo)}\n${agora()}`);
  return acordo;
}

// ------------------------------- RELATÓRIO -------------------------------
$("#btn-relatorio-parc")?.addEventListener("click", () => {
  const com = ESTADO.parcelamentos.filter((p) => acordosDe(p).length).length;
  abrirModal(`
    <h2>Relatório de parcelamentos</h2>
    <p class="modal-sub">${com ? `${com} empresa(s) com acordos importados.` : "Nenhum extrato importado ainda — importe os PDFs do e-CAC/PGFN em cada parcelamento (ou em lote)."}</p>
    <form id="form-rel-parc">
      <div class="campo-form"><label>Mostrar</label>
        <div class="segmentado" id="rel-filtro">
          <button type="button" class="pill-toggle ativo" data-f="abertos">Em aberto</button>
          <button type="button" class="pill-toggle" data-f="quitados">Quitados</button>
          <button type="button" class="pill-toggle" data-f="todos">Todos</button>
        </div>
      </div>
      <label class="check-linha"><input type="checkbox" id="rel-detalhado"> Incluir a lista de parcelas de cada acordo</label>
      <label class="check-linha"><input type="checkbox" id="rel-filtro-busca" ${filtroParc ? "checked" : ""} ${filtroParc ? "" : "disabled"}> Só as empresas da busca atual${filtroParc ? ` (“${escaparHtml(filtroParc)}”)` : ""}</label>
      <div class="modal-rodape">
        <button type="button" class="btn-ghost" id="rel-csv">${icone("baixar")}Planilha (CSV)</button>
        <button type="submit" class="btn-primario" ${com ? "" : "disabled"}>${icone("imprimir")}Gerar relatório</button>
      </div>
    </form>`);
  let filtro = "abertos";
  $("#rel-filtro").addEventListener("click", (e) => {
    const b = e.target.closest("[data-f]"); if (!b) return;
    filtro = b.dataset.f; $("#rel-filtro").querySelectorAll("[data-f]").forEach((x) => x.classList.toggle("ativo", x === b));
  });
  const ids = () => ($("#rel-filtro-busca").checked ? ESTADO.parcelamentos.filter(parcPassaFiltro).map((p) => p.id) : null);
  $("#rel-csv").addEventListener("click", () => baixarCsvParcelamentos({ ids: ids(), filtro }));
  $("#form-rel-parc").addEventListener("submit", (e) => {
    e.preventDefault();
    abrirRelatorioParcelamentos({ ids: ids(), filtro, detalhado: $("#rel-detalhado").checked });
    fecharModal();
  });
});

function dadosRelatorio({ ids = null, filtro = "abertos", acordoId = null } = {}) {
  const empresas = [];
  for (const p of ESTADO.parcelamentos) {
    if (ids && !ids.includes(p.id)) continue;
    const acordos = acordosDe(p).filter((a) => !acordoId || a.id === acordoId).map((a) => ({ a, r: resumoAcordo(a) })).filter(({ r }) =>
      filtro === "todos" ? true : filtro === "quitados" ? r.status === "quitado" : r.status === "em_dia" || r.status === "atraso");
    if (acordos.length) empresas.push({ p, acordos });
  }
  empresas.sort((x, y) => x.p.nome.localeCompare(y.p.nome, "pt-BR"));
  const todos = empresas.flatMap((e) => e.acordos);
  const ativos = todos.filter(({ r }) => r.status === "em_dia" || r.status === "atraso");
  return {
    empresas,
    tot: {
      empresas: empresas.length, acordos: todos.length,
      ativos: ativos.length, quitados: todos.filter(({ r }) => r.status === "quitado").length,
      atraso: todos.filter(({ r }) => r.status === "atraso").length,
      consolidado: todos.reduce((s, { a }) => s + (a.valorConsolidado || 0), 0),
      pago: todos.reduce((s, { r }) => s + (r.totalPago || 0), 0),
      saldo: ativos.reduce((s, { r }) => s + (r.saldo || 0), 0),
      abertas: ativos.reduce((s, { r }) => s + (r.abertas || 0), 0),
      estimado: ativos.some(({ r }) => r.estimado),
    },
  };
}

function abrirRelatorioParcelamentos(opcoes) {
  const { empresas, tot } = dadosRelatorio(opcoes);
  const titulos = { abertos: "Parcelamentos em aberto", quitados: "Parcelamentos quitados", todos: "Todos os parcelamentos" };
  const hoje = new Date().toLocaleDateString("pt-BR");
  const esc = escaparHtml;
  const blocos = empresas.map(({ p, acordos }) => `
    <section class="emp">
      <h2>${esc(p.nome)} <small>${esc(p.cnpj || "")}</small></h2>
      <table class="acordos">
        <thead><tr><th>Órgão / modalidade</th><th>Situação</th><th class="n">Consolidado</th><th class="n">Pagas</th><th class="n">Em aberto</th><th class="n">Parcela</th><th class="n">Já pago</th><th class="n">Saldo</th><th>Próxima</th><th>Término</th></tr></thead>
        <tbody>${acordos.map(({ a, r }) => `
          <tr class="st-${r.status}">
            <td><b>${nomeOrgao(a)}</b>${a.numero ? ` · nº ${esc(a.numero)}` : ""}<br><span class="mod">${esc(a.tipo || "")}</span></td>
            <td><span class="st">${(ROTULO_STATUS_ACORDO[r.status] || [r.status])[0]}</span>${r.atrasadas ? `<br><span class="vencidas">${r.atrasadas} vencida(s)</span>` : ""}</td>
            <td class="n">${brl(a.valorConsolidado)}</td>
            <td class="n">${r.pagas ?? "—"}/${r.total ?? "?"}</td>
            <td class="n">${r.abertas ?? "—"}</td>
            <td class="n">${brl(r.valorParcela)}</td>
            <td class="n">${brl(r.totalPago)}</td>
            <td class="n"><b>${r.estimado && r.status !== "quitado" ? "≈ " : ""}${r.status === "quitado" ? brl(0) : brl(r.saldo)}</b></td>
            <td>${r.proxima ? `${r.proxima.ref ? mesBr(r.proxima.ref) : dataBr(r.proxima.vencimento)}` : "—"}</td>
            <td>${r.termino ? (r.estimado ? mesBr(r.termino.slice(0, 7)) : dataBr(r.termino)) : "—"}</td>
          </tr>
          ${opcoes.detalhado && (r.listaParcelas || []).length ? `<tr class="det"><td colspan="10">
            <div class="parcelas">${r.listaParcelas.map((x) => `<span class="${x.paga ? "ok" : x.vencimento < new Date().toISOString().slice(0, 10) ? "venc" : "ab"}" title="${x.paga ? "Paga" : "Em aberto"}"><b>${x.n}</b> ${x.ref ? mesBr(x.ref) : dataBr(x.vencimento)} · ${brl(x.saldo != null && !x.paga ? x.saldo : x.valor)}</span>`).join("")}</div>
          </td></tr>` : ""}`).join("")}
        </tbody>
      </table>
    </section>`).join("");
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de parcelamentos — ${hoje}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.45 "IBM Plex Sans", "Segoe UI", Arial, sans-serif; color: #241F1A; margin: 0; padding: 24px; background: #F3EFE7; }
  .folha { max-width: 1180px; margin: 0 auto; background: #fff; padding: 28px 32px; border-radius: 10px; box-shadow: 0 6px 18px rgba(29,26,22,.08); }
  header.top { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #16202E; padding-bottom: 12px; margin-bottom: 16px; }
  h1 { font: 600 22px Georgia, serif; margin: 0; color: #16202E; } header.top p { margin: 2px 0 0; color: #6E665B; }
  .acoes button { font: inherit; padding: 8px 14px; border-radius: 7px; border: 1px solid #D6CCBC; background: #fff; cursor: pointer; margin-left: 6px; }
  .acoes button.pri { background: #B4532A; border-color: #B4532A; color: #fff; }
  .kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 18px; }
  .kpi { border: 1px solid #E6DFD3; border-radius: 8px; padding: 10px 12px; } .kpi span { display: block; color: #6E665B; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; } .kpi b { font-size: 17px; color: #16202E; }
  .kpi.saldo { background: #16202E; border-color: #16202E; } .kpi.saldo span { color: #C9BFAE; } .kpi.saldo b { color: #fff; }
  section.emp { margin-bottom: 18px; break-inside: avoid; }
  h2 { font-size: 14px; margin: 0 0 6px; color: #16202E; } h2 small { color: #9C9285; font-weight: 400; margin-left: 6px; }
  table { width: 100%; border-collapse: collapse; } th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: #6E665B; border-bottom: 1px solid #D6CCBC; padding: 5px 6px; }
  td { padding: 6px; border-bottom: 1px solid #EFE9DF; vertical-align: top; } .n { text-align: right; white-space: nowrap; }
  .mod { color: #6E665B; font-size: 11px; } .st { font-weight: 600; } .st-em_dia .st { color: #3E6B37; } .st-atraso .st, .vencidas { color: #B23B29; } .st-quitado .st { color: #6A5A93; } .st-rescindido .st { color: #6E665B; }
  tr.det td { background: #FBF9F5; } .parcelas { display: flex; flex-wrap: wrap; gap: 4px; }
  .parcelas span { font-size: 10.5px; padding: 2px 6px; border-radius: 4px; border: 1px solid #E6DFD3; white-space: nowrap; }
  .parcelas .ok { background: #E6EEDF; border-color: #C3D5B8; color: #3E6B37; } .parcelas .venc { background: #F6E2DA; border-color: #EAC0B2; color: #8F2C1C; }
  .nota { color: #6E665B; font-size: 11px; margin-top: 14px; } .vazio { padding: 40px; text-align: center; color: #6E665B; }
  @media print { body { background: #fff; padding: 0; } .folha { box-shadow: none; padding: 0; max-width: none; } .acoes { display: none; } }
</style></head><body><div class="folha">
  <header class="top"><div><h1>${titulos[opcoes.filtro] || "Parcelamentos"}</h1><p>Gerado em ${hoje} pelo Prumo · ${tot.empresas} empresa(s) · ${tot.acordos} acordo(s)</p></div>
    <div class="acoes"><button onclick="window.close()">Fechar</button><button class="pri" onclick="window.print()">Imprimir / salvar PDF</button></div></header>
  ${empresas.length ? `<div class="kpis">
    <div class="kpi"><span>Acordos ativos</span><b>${tot.ativos}</b></div>
    <div class="kpi"><span>Em atraso</span><b>${tot.atraso}</b></div>
    <div class="kpi"><span>Quitados</span><b>${tot.quitados}</b></div>
    <div class="kpi"><span>Parcelas em aberto</span><b>${tot.abertas}</b></div>
    <div class="kpi saldo"><span>Saldo em aberto</span><b>${tot.estimado ? "≈ " : ""}${brl(tot.saldo)}</b></div>
  </div>${blocos}
  <p class="nota">Total consolidado: ${brl(tot.consolidado)} · total já pago: ${brl(tot.pago)}.
  Valores conforme os extratos importados do e-CAC/PGFN (veja a data de atualização de cada acordo no Prumo). No Simples Nacional a parcela é corrigida pela Selic: o saldo (≈) é estimado com o valor da última parcela paga.</p>`
    : `<div class="vazio">Nenhum acordo neste filtro.</div>`}
</div></body></html>`;
  const w = window.open("", "_blank");
  if (!w) return avisar("O navegador bloqueou a janela do relatório. Permita pop-ups para o Prumo e tente de novo.", { titulo: "Relatório bloqueado", tipo: "aviso" });
  w.document.open(); w.document.write(html); w.document.close();
}

function baixarCsvParcelamentos(opcoes) {
  const { empresas } = dadosRelatorio(opcoes);
  const c = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const n = (v) => (v == null ? "" : Number(v).toFixed(2).replace(".", ","));
  const linhas = [["Empresa", "CNPJ", "Órgão", "Modalidade", "Nº", "Situação", "Status", "Valor consolidado", "Parcelas", "Pagas", "Em aberto", "Vencidas", "Valor da parcela", "Total pago", "Saldo", "Saldo estimado?", "Próxima parcela", "Término", "Atualizado em"].map(c).join(";")];
  for (const { p, acordos } of empresas) for (const { a, r } of acordos) {
    linhas.push([p.nome, p.cnpj, nomeOrgao(a), a.tipo, a.numero, a.situacao, (ROTULO_STATUS_ACORDO[r.status] || [r.status])[0], n(a.valorConsolidado), r.total, r.pagas, r.abertas, r.atrasadas, n(r.valorParcela), n(r.totalPago), n(r.status === "quitado" ? 0 : r.saldo), r.estimado ? "sim" : "não",
      r.proxima ? (r.proxima.ref ? mesBr(r.proxima.ref) : dataBr(r.proxima.vencimento)) : "", r.termino ? dataBr(r.termino) : "", dataBr(a.atualizadoEm)].map(c).join(";"));
  }
  const blob = new Blob(["﻿" + linhas.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `parcelamentos-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

$("#busca")?.addEventListener("input", atrasar((e) => {
  filtroParc = e.target.value.trim().toLowerCase();
  renderizarParcelamentos();
}, 150));

iniciarPagina();
