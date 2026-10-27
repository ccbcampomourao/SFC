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


function htmlReconsolidacoes(a) {
  const l = a.reconsolidacoes || [];
  if (!l.length) return "";
  return l.map((x) => `Reconsolidado em ${dataBr(x.data)}: ${brl(x.valor)} em ${x.remanescentes} parcela(s) restante(s) de ${brl(x.parcelaBasica)}`).join(" · ") +
    (a.parcelaBasicaOriginal ? ` (consolidação original: ${brl(a.valorConsolidado)} em ${a.qtdParcelas}x de ${brl(a.parcelaBasicaOriginal)})` : "");
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
    ${(a.reconsolidacoes || []).length ? `<p class="ac-debitos">${icone("atualizar")}${htmlReconsolidacoes(a)}</p>` : ""}
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

// Nome do escritório no relatório (o relatório vai para o cliente: sem a marca do sistema)
const ESCRITORIO_RELATORIO = { nome: "FZ CONT", sub: "Contabilidade e Consultoria" };

// logo do escritório embutida no relatório (aparece também no PDF salvo)
let _logoEscritorio = null;
async function logoEscritorioDataUri() {
  if (_logoEscritorio !== null) return _logoEscritorio;
  try {
    const blob = await (await fetch("/img/logo-full.png")).blob();
    _logoEscritorio = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => ok(""); fr.readAsDataURL(blob); });
  } catch (_) { _logoEscritorio = ""; }
  return _logoEscritorio;
}
logoEscritorioDataUri();

function abrirRelatorioParcelamentos(opcoes) {
  // a janela abre na hora do clique (senão o navegador bloqueia) e o conteúdo entra em seguida
  const w = window.open("", "_blank");
  if (!w) return avisar("O navegador bloqueou a janela do relatório. Permita pop-ups e tente de novo.", { titulo: "Relatório bloqueado", tipo: "aviso" });
  w.document.write('<p style="font:14px sans-serif;color:#6E665B;padding:40px">Montando o relatório…</p>'); w.document.close();
  logoEscritorioDataUri().then((logo) => montarRelatorioParcelamentos(w, opcoes, logo));
}

function montarRelatorioParcelamentos(w, opcoes, logo = "") {
  const { empresas, tot } = dadosRelatorio(opcoes);
  const esc = escaparHtml;
  const hojeIso = new Date().toISOString().slice(0, 10);
  const hoje = new Date().toLocaleDateString("pt-BR");
  const hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const titulos = { abertos: "Parcelamentos em aberto", quitados: "Parcelamentos quitados", todos: "Parcelamentos" };
  const ordemSt = { atraso: 0, em_dia: 1, quitado: 2, rescindido: 3 };
  const pct = (r) => Math.round((r.progresso || 0) * 100);
  const termino = (r) => (r.termino ? (r.estimado ? mesBr(r.termino.slice(0, 7)) : dataBr(r.termino)) : "—");
  const proxTxt = (r) => (r.status === "quitado" || !r.proxima ? "—" : r.proxima.ref ? mesBr(r.proxima.ref) : dataBr(r.proxima.vencimento));
  const saldoTxt = (r) => (r.status === "quitado" ? brl(0) : (r.estimado ? "≈ " : "") + brl(r.saldo));
  const pill = (r) => { const [rot] = ROTULO_STATUS_ACORDO[r.status] || [r.status]; return `<span class="pill st-${r.status}">${rot}</span>`; };

  // ordena: empresas com atraso primeiro, depois por saldo
  for (const e of empresas) {
    e.acordos.sort((x, y) => (ordemSt[x.r.status] - ordemSt[y.r.status]) || ((y.r.saldo || 0) - (x.r.saldo || 0)));
    e.saldo = e.acordos.filter(({ r }) => r.status === "em_dia" || r.status === "atraso").reduce((s, { r }) => s + (r.saldo || 0), 0);
    e.abertas = e.acordos.filter(({ r }) => r.status === "em_dia" || r.status === "atraso").reduce((s, { r }) => s + (r.abertas || 0), 0);
    e.atraso = e.acordos.some(({ r }) => r.status === "atraso");
    e.estimado = e.acordos.some(({ r }) => r.estimado && r.status !== "quitado");
  }
  empresas.sort((x, y) => (y.atraso - x.atraso) || (y.saldo - x.saldo) || x.p.nome.localeCompare(y.p.nome, "pt-BR"));

  const mapaParcelas = (r) => (r.listaParcelas || []).length ? `
    <div class="mapa" aria-label="Mapa das parcelas">
      ${r.listaParcelas.map((x) => {
        const cls = x.paga ? "pg" : x.vencimento && x.vencimento < hojeIso ? "vc" : r.proxima && x.vencimento === r.proxima.vencimento ? "px" : "ab";
        const quando = x.ref ? mesBr(x.ref) : dataBr(x.vencimento);
        return `<i class="${cls}" title="${x.n} · ${quando} · ${brl(x.saldo != null && !x.paga ? x.saldo : x.valor)}${x.paga ? " · paga" : ""}">${x.n}</i>`;
      }).join("")}
    </div>` : "";

  const tabelaParcelas = (r) => {
    const l = r.listaParcelas || [];
    if (!l.length) return "";
    const metade = Math.ceil(l.length / 2);
    const col = (itens) => `<table class="tparc"><thead><tr><th>Nº</th><th>Vencimento</th><th class="n">Valor</th><th>Situação</th></tr></thead><tbody>${itens.map((x) => `
      <tr class="${x.paga ? "pg" : x.vencimento < hojeIso ? "vc" : ""}"><td>${x.n}</td><td>${x.ref ? mesBr(x.ref) : dataBr(x.vencimento)}</td><td class="n">${brl(x.saldo != null && !x.paga ? x.saldo : x.valor)}</td>
      <td>${x.paga ? `Paga${x.dataPagamento ? " " + dataBr(x.dataPagamento) : ""}` : x.vencimento < hojeIso ? "Vencida" : "Em aberto"}</td></tr>`).join("")}</tbody></table>`;
    return `<div class="tparc-wrap">${col(l.slice(0, metade))}${col(l.slice(metade))}</div>`;
  };

  const cartaoAcordo = ({ a, r }) => `
    <article class="acordo st-${r.status}">
      <div class="acordo-topo">
      <header>
        <span class="orgao o-${esc(a.orgao || "")}">${esc(nomeOrgao(a))}</span>
        <div class="tit"><b>${esc(a.tipo || "Parcelamento")}</b>
          <small>${[a.numero ? "Nº " + esc(a.numero) : "", a.situacao ? esc(a.situacao) : "", a.dataAdesao ? "adesão " + dataBr(a.dataAdesao) : ""].filter(Boolean).join(" · ")}</small></div>
        ${pill(r)}
      </header>
      <div class="prog"><div class="barra"><i style="width:${pct(r)}%"></i></div><span><b>${r.pagas ?? "—"}</b> de ${r.total ?? "?"} pagas · ${pct(r)}%</span></div>
      <div class="grade">
        <div><span>Valor consolidado</span><b>${brl(a.valorConsolidado)}</b></div>
        <div><span>Valor da parcela</span><b>${brl(r.valorParcela)}</b></div>
        <div><span>Total já pago</span><b>${brl(r.totalPago)}</b></div>
        <div class="forte"><span>${r.estimado && r.status !== "quitado" ? "Saldo estimado" : "Saldo devedor"}</span><b>${saldoTxt(r)}</b></div>
        <div><span>Em aberto</span><b>${r.status === "quitado" ? 0 : r.abertas ?? "—"}${r.atrasadas ? ` <em>${r.atrasadas} vencida(s)</em>` : ""}</b></div>
        <div><span>Próxima parcela</span><b>${proxTxt(r)}${r.proxima && r.status !== "quitado" ? ` <small>${brl(r.proxima.valor)}</small>` : ""}</b></div>
        <div><span>Término previsto</span><b>${termino(r)}</b></div>
        <div><span>Atualizado em</span><b>${dataBr(a.atualizadoEm)}</b></div>
      </div>
      </div>
      ${(a.debitos || []).length ? `<p class="debitos"><span>Débitos parcelados</span> ${a.debitos.map((d) => mesBr(d.periodo)).join(" · ")}</p>` : ""}
      ${(a.reconsolidacoes || []).length ? `<p class="debitos"><span>Alteração de dívida</span> ${htmlReconsolidacoes(a)}</p>` : ""}
      ${mapaParcelas(r)}
      ${opcoes.detalhado ? tabelaParcelas(r) : ""}
    </article>`;

  const resumoEmpresas = empresas.length > 1 ? `
    <section class="bloco resumo">
      <h2>Resumo por empresa</h2>
      <table class="tres">
        <thead><tr><th>Empresa</th><th class="c">Parcelamentos</th><th class="c">Parcelas em aberto</th><th class="n">Saldo em aberto</th><th>Situação</th></tr></thead>
        <tbody>${empresas.map((e) => `
          <tr><td><b>${esc(e.p.nome)}</b><small>${esc(e.p.cnpj || "")}</small></td>
            <td class="c">${e.acordos.length}</td><td class="c">${e.abertas}</td>
            <td class="n"><b>${e.estimado ? "≈ " : ""}${brl(e.saldo)}</b></td>
            <td>${e.atraso ? '<span class="pill st-atraso">Em atraso</span>' : e.acordos.every(({ r }) => r.status === "quitado") ? '<span class="pill st-quitado">Quitado</span>' : '<span class="pill st-em_dia">Em dia</span>'}</td></tr>`).join("")}
        </tbody>
        <tfoot><tr><td>Total</td><td class="c">${tot.acordos}</td><td class="c">${tot.abertas}</td><td class="n">${tot.estimado ? "≈ " : ""}${brl(tot.saldo)}</td><td></td></tr></tfoot>
      </table>
    </section>` : "";

  const blocosEmpresa = empresas.map((e) => `
    <section class="empresa">
      <div class="emp-cab">
        <div><h2>${esc(e.p.nome)}</h2><small>CNPJ ${esc(e.p.cnpj || "—")}</small></div>
        <div class="emp-tot"><span>${e.abertas} parcela(s) em aberto</span><b>${e.estimado ? "≈ " : ""}${brl(e.saldo)}</b></div>
      </div>
      ${e.acordos.map(cartaoAcordo).join("")}
    </section>`).join("");

  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>${titulos[opcoes.filtro] || "Parcelamentos"} — ${hoje}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --tinta:#16202E; --tinta2:#22304A; --cobre:#B4532A; --cobre2:#E3955C; --marfim:#F3EFE7; --linha:#E6DFD3; --suave:#6E665B; --fraco:#9C9285;
          --verde:#3E6B37; --verdebg:#E6EEDF; --verm:#B23B29; --vermbg:#F6E2DA; --roxo:#6A5A93; --roxobg:#ECE8F4; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; background: #E9E4DA; font: 13px/1.45 "IBM Plex Sans", "Segoe UI", Arial, sans-serif; color: #241F1A; }
  .barra-acoes { position: sticky; top: 0; z-index: 5; display: flex; justify-content: flex-end; gap: 8px; padding: 10px 24px; background: rgba(233,228,218,.92); backdrop-filter: blur(6px); }
  .barra-acoes button { font: 600 13px inherit; font-family: inherit; padding: 9px 16px; border-radius: 9px; border: 1px solid #D6CCBC; background: #fff; color: var(--tinta); cursor: pointer; }
  .barra-acoes button.pri { background: var(--cobre); border-color: var(--cobre); color: #fff; }
  .folha { max-width: 920px; margin: 0 auto 40px; background: #fff; box-shadow: 0 10px 40px rgba(29,26,22,.12); border-radius: 14px; overflow: hidden; }
  .capa { background: radial-gradient(120% 140% at 100% 0%, #2B3B58 0%, var(--tinta) 55%); color: #fff; padding: 30px 40px 28px; position: relative; }
  .capa::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: linear-gradient(90deg, var(--cobre), var(--cobre2)); }
  .capa-topo { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
  .escritorio { display: flex; align-items: center; gap: 14px; }
  .logo-esc { flex: none; display: grid; place-items: center; width: 64px; height: 64px; background: #fff; border-radius: 12px; padding: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
  .logo-esc img { max-width: 100%; max-height: 100%; display: block; } .escritorio b { display: block; font: 600 24px/1.1 "Fraunces", Georgia, serif; letter-spacing: .02em; } .escritorio span { display: block; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #E3955C; margin-top: 3px; }
  .capa-data { text-align: right; font-size: 12px; color: #C9BFAE; } .capa-data b { display: block; color: #fff; font-size: 13px; }
  .capa h1 { font: 600 30px/1.15 "Fraunces", Georgia, serif; margin: 22px 0 4px; letter-spacing: -.01em; }
  .capa p { margin: 0; color: #C9BFAE; }
  .kpis { display: grid; grid-template-columns: 1.5fr repeat(4, 1fr); gap: 10px; margin-top: 22px; }
  .kpi { background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12); border-radius: 10px; padding: 12px 14px; }
  .kpi span { display: block; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: #C9BFAE; }
  .kpi b { display: block; font-size: 20px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .kpi.saldo { background: #fff; border-color: #fff; } .kpi.saldo span { color: var(--suave); } .kpi.saldo b { color: var(--cobre); font-size: 24px; }
  .kpi.alerta b { color: #FFB4A3; }
  .conteudo { padding: 26px 40px 34px; }
  h2 { font: 600 17px "Fraunces", Georgia, serif; color: var(--tinta); margin: 0; }
  .bloco { margin-bottom: 26px; } .bloco h2 { margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; }
  .tres th { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--suave); text-align: left; padding: 8px 10px; border-bottom: 1.5px solid var(--tinta); }
  .tres td { padding: 9px 10px; border-bottom: 1px solid var(--linha); vertical-align: middle; }
  .tres td small { display: block; color: var(--fraco); font-size: 11.5px; }
  .tres tfoot td { font-weight: 700; border-bottom: 0; border-top: 1.5px solid var(--tinta); color: var(--tinta); }
  .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; } .c { text-align: center; }
  .pill { display: inline-block; font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
  .pill.st-em_dia { background: var(--verdebg); color: var(--verde); } .pill.st-atraso { background: var(--vermbg); color: var(--verm); }
  .pill.st-quitado { background: var(--roxobg); color: var(--roxo); } .pill.st-rescindido { background: var(--marfim); color: var(--suave); }
  .empresa { margin-top: 8px; padding-top: 18px; border-top: 1px solid var(--linha); }
  .empresa:first-of-type { border-top: 0; padding-top: 0; }
  .emp-cab { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-bottom: 12px; }
  .emp-cab small { color: var(--suave); font-size: 12px; }
  .emp-tot { text-align: right; } .emp-tot span { display: block; font-size: 11.5px; color: var(--suave); } .emp-tot b { font-size: 18px; color: var(--tinta); font-variant-numeric: tabular-nums; }
  .acordo { border: 1px solid var(--linha); border-left: 5px solid var(--verde); border-radius: 10px; padding: 16px 18px 14px; margin-bottom: 14px; }
  .acordo-topo, .mapa, .tparc tr, .tres tr, .emp-cab { break-inside: avoid; page-break-inside: avoid; }
  .acordo.st-atraso { border-left-color: var(--verm); } .acordo.st-quitado { border-left-color: var(--roxo); } .acordo.st-rescindido { border-left-color: var(--fraco); }
  .acordo header { display: flex; align-items: flex-start; gap: 12px; }
  .orgao { flex: none; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; padding: 4px 9px; border-radius: 6px; background: #F6E8DD; color: #96421E; }
  .orgao.o-PGFN { background: #E4E8F0; color: var(--tinta); }
  .tit { flex: 1; min-width: 0; } .tit b { display: block; font-size: 14px; color: var(--tinta); } .tit small { color: var(--suave); font-size: 12px; }
  .prog { display: flex; align-items: center; gap: 12px; margin: 14px 0 12px; }
  .prog .barra { flex: 1; height: 8px; background: var(--marfim); border-radius: 999px; overflow: hidden; }
  .prog .barra i { display: block; height: 100%; background: linear-gradient(90deg, var(--verde), #6E9E62); border-radius: inherit; }
  .acordo.st-atraso .prog .barra i { background: var(--verm); } .acordo.st-quitado .prog .barra i { background: var(--roxo); }
  .prog span { font-size: 12px; color: var(--suave); white-space: nowrap; } .prog span b { color: var(--tinta); }
  .grade { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--linha); border: 1px solid var(--linha); border-radius: 8px; overflow: hidden; }
  .grade > div { background: #FBF9F5; padding: 9px 12px; }
  .grade span { display: block; font-size: 10px; letter-spacing: .07em; text-transform: uppercase; color: var(--fraco); }
  .grade b { font-size: 14px; color: #241F1A; font-variant-numeric: tabular-nums; } .grade b small { font-weight: 500; color: var(--suave); font-size: 11.5px; }
  .grade b em { font-style: normal; font-size: 11px; color: var(--verm); font-weight: 600; }
  .grade .forte { background: var(--tinta); } .grade .forte span { color: #C9BFAE; } .grade .forte b { color: #fff; font-size: 15px; }
  .debitos { margin: 10px 0 0; font-size: 12px; color: var(--suave); } .debitos span { font-weight: 600; color: var(--tinta); margin-right: 4px; }
  .mapa { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 12px; }
  .mapa i { width: 22px; height: 18px; display: grid; place-items: center; font: 600 9px inherit; font-style: normal; border-radius: 4px; border: 1px solid var(--linha); color: var(--fraco); background: #fff; }
  .mapa i.pg { background: var(--verde); border-color: var(--verde); color: #fff; }
  .mapa i.vc { background: var(--verm); border-color: var(--verm); color: #fff; }
  .mapa i.px { border: 1.5px solid var(--cobre); color: var(--cobre); }
  .legenda { display: flex; gap: 14px; font-size: 11px; color: var(--suave); margin: 6px 0 18px; }
  .legenda i { display: inline-block; width: 11px; height: 11px; border-radius: 3px; vertical-align: -1px; margin-right: 4px; border: 1px solid var(--linha); }
  .legenda .pg { background: var(--verde); border-color: var(--verde); } .legenda .vc { background: var(--verm); border-color: var(--verm); } .legenda .px { border: 1.5px solid var(--cobre); }
  .tparc-wrap { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 12px; }
  .tparc th { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--suave); text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--linha); }
  .tparc td { font-size: 11.5px; padding: 3px 6px; border-bottom: 1px solid #F3EFE7; }
  .tparc tr.pg td { color: var(--suave); } .tparc tr.pg td:last-child { color: var(--verde); } .tparc tr.vc td { color: var(--verm); font-weight: 600; }
  .nota { margin-top: 22px; padding: 12px 14px; background: var(--marfim); border-radius: 8px; font-size: 11.5px; color: var(--suave); }
  .rodape { display: flex; justify-content: space-between; padding: 12px 40px; border-top: 1px solid var(--linha); font-size: 11px; color: var(--fraco); }
  .vazio { padding: 50px 0; text-align: center; color: var(--suave); }
  @page { size: A4; margin: 10mm; }
  @media print {
    body { background: #fff; } .barra-acoes { display: none; }
    .folha { max-width: none; margin: 0; box-shadow: none; border-radius: 0; }
    .capa, .conteudo, .rodape { padding-left: 6mm; padding-right: 6mm; }
    .empresa { break-before: auto; } .emp-cab { break-after: avoid; }
    .capa { padding-top: 18px; padding-bottom: 18px; } .capa h1 { font-size: 24px; margin-top: 14px; }
    .kpis { grid-template-columns: 1.5fr 1fr 1fr 0.8fr 1.3fr; gap: 6px; }
    .kpi { padding: 8px 10px; } .kpi span { font-size: 8.5px; letter-spacing: .04em; white-space: nowrap; }
    .kpi b { font-size: 15px; } .kpi.saldo b { font-size: 17px; }
    .grade b { font-size: 12.5px; } .grade .forte b { font-size: 13px; }
  }
  @media (max-width: 760px) { .kpis { grid-template-columns: 1fr 1fr; } .grade { grid-template-columns: 1fr 1fr; } .capa, .conteudo { padding: 22px; } .tparc-wrap { grid-template-columns: 1fr; } }
</style></head><body>
<div class="barra-acoes"><button onclick="window.close()">Fechar</button><button class="pri" onclick="window.print()">Imprimir / salvar PDF</button></div>
<div class="folha">
  <div class="capa">
    <div class="capa-topo"><div class="escritorio">${logo ? `<div class="logo-esc"><img src="${logo}" alt="${esc(ESCRITORIO_RELATORIO.nome)}"></div>` : ""}<div><b>${esc(ESCRITORIO_RELATORIO.nome)}</b><span>${esc(ESCRITORIO_RELATORIO.sub)}</span></div></div><div class="capa-data">Gerado em<b>${hoje} às ${hora}</b></div></div>
    <h1>${titulos[opcoes.filtro] || "Parcelamentos"}</h1>
    <p>${empresas.length === 1 ? esc(empresas[0].p.nome) + " · CNPJ " + esc(empresas[0].p.cnpj || "—") : `${tot.empresas} empresa(s) · ${tot.acordos} parcelamento(s)`}${opcoes.detalhado ? " · com a lista de parcelas" : ""}</p>
    ${empresas.length ? `<div class="kpis">
      <div class="kpi saldo"><span>Saldo em aberto</span><b>${tot.estimado ? "≈ " : ""}${brl(tot.saldo)}</b></div>
      <div class="kpi"><span>Parcelas em aberto</span><b>${tot.abertas}</b></div>
      <div class="kpi"><span>Parcelamentos ativos</span><b>${tot.ativos}</b></div>
      <div class="kpi${tot.atraso ? " alerta" : ""}"><span>Em atraso</span><b>${tot.atraso}</b></div>
      <div class="kpi"><span>Total já pago</span><b>${brl(tot.pago)}</b></div>
    </div>` : ""}
  </div>
  <div class="conteudo">
    ${empresas.length ? `${resumoEmpresas}
      <div class="legenda"><span><i class="pg"></i>Paga</span><span><i class="px"></i>Próxima</span><span><i></i>Em aberto</span><span><i class="vc"></i>Vencida</span></div>
      ${blocosEmpresa}
      <div class="nota">Valores conforme os extratos importados do e-CAC / PGFN (data de atualização em cada parcelamento) ou informados pelo escritório.
        No Simples Nacional a parcela é corrigida pela Selic todo mês — o saldo marcado com ≈ é estimado com o valor da última parcela paga.
        ${tot.quitados ? ` ${tot.quitados} parcelamento(s) quitado(s) neste relatório.` : ""}</div>`
      : `<div class="vazio">Nenhum parcelamento neste filtro.</div>`}
  </div>
  <div class="rodape"><span>${esc(ESCRITORIO_RELATORIO.nome)} · ${esc(ESCRITORIO_RELATORIO.sub)}</span><span>Relatório de parcelamentos · ${hoje}</span></div>
</div></body></html>`;
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
