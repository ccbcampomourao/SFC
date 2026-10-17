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
    kpiSimples("Previdência", porTipo("Previdencia"), "escudo");
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
      <div class="selos-linha">${(p.anexos || []).length ? `<span class="selo selo-anexado">${icone("clipe")}ANEXADO${p.anexos.length > 1 ? " · " + p.anexos.length : ""}</span>` : ""}${tipos.map((t) => `<span class="selo selo-alt">${escaparHtml(ROTULO_ALTERNANCIA[t] || t)}</span>`).join("")}</div>
    </div>
    <div class="chips-acesso">
      ${botaoCopiaSe(p.cnpj, "CNPJ")}
      ${botaoCopiaSe(p.senhaRegularize, "Regularize")}
      <button type="button" class="chip-copia chip-email" data-email title="Enviar e-mail com as guias">${icone("email")}Enviar e-mail</button>
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

function criarCorpoParcelamento(p) {
  const corpo = document.createElement("div");
  corpo.className = "empresa-corpo";

  const barra = document.createElement("div");
  barra.className = "barra-opcoes";
  const alt = (campo) => `<button type="button" class="alternancia-btn ${classeAlternancia(p[campo])}" data-alt="${campo}" title="Clique para alternar o tipo">${escaparHtml(ROTULO_ALTERNANCIA[p[campo] || "VAZIO"] || p[campo])}</button>`;
  barra.innerHTML = `${htmlBotoesStatus(p.statusGeral)}<span class="separador-v"></span>${CAMPOS_ALT.map(alt).join("")}`;
  barra.addEventListener("click", (e) => {
    const st = e.target.closest("[data-status]");
    if (st) {
      p.statusGeral = p.statusGeral === st.dataset.status ? "SEM" : st.dataset.status;
      atualizarBotoesStatus(barra, p.statusGeral);
      atualizarParcelamento(p);
      renderizarDashboardParcelamentos();
      marcarAlterado();
      return;
    }
    const a = e.target.closest("[data-alt]");
    if (a) {
      const campo = a.dataset.alt;
      p[campo] = proximoAlternancia(p[campo]);
      a.className = `alternancia-btn ${classeAlternancia(p[campo])}`;
      a.textContent = ROTULO_ALTERNANCIA[p[campo]] || p[campo];
      atualizarParcelamento(p);
      renderizarDashboardParcelamentos();
      marcarAlterado();
    }
  });
  corpo.appendChild(barra);

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
    atualizarParcelamento(p);
    marcarAlterado();
    inp.classList.add("salvo");
    setTimeout(() => inp.classList.remove("salvo"), 700);
  });
  corpo.appendChild(campos);

  const duas = document.createElement("div");
  duas.className = "duas-colunas-detalhe";
  duas.append(
    montarColunaComentarios(p),
    montarColunaAnexos(p, { aoMudar: () => atualizarParcelamento(p), nomeAlvo: "deste parcelamento" })
  );
  corpo.appendChild(duas);
  return corpo;
}

// ---------------------------------------------------------------------------
// IMPORTAR PDFs EM LOTE (igual ao "processarPdfParcelamento" do app original)
// ---------------------------------------------------------------------------
$("#btn-importar-pdfs")?.addEventListener("click", () => $("#input-importar-pdfs").click());
$("#input-importar-pdfs")?.addEventListener("change", async (e) => {
  const arquivos = [...e.target.files];
  e.target.value = "";
  if (!arquivos.length) return;

  let vinculados = 0, jaExistiam = 0, semCnpj = 0, semParcelamento = 0, comErro = 0;
  await comCarregando($("#btn-importar-pdfs"), async () => {
    for (const [i, arquivo] of arquivos.entries()) {
      notificar(`Analisando PDF ${i + 1} de ${arquivos.length}...`, "carregando");
      try {
        const texto = await extrairTextoPdf(arquivo);
        if (!texto.trim()) { comErro++; continue; }
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

  if (vinculados) marcarAlterado();
  renderizarParcelamentos();
  renderizarDashboardParcelamentos();

  const linhas = [`${vinculados} arquivo(s) vinculado(s) aos parcelamentos.`];
  if (jaExistiam) linhas.push(`${jaExistiam} já estavam anexados (ignorados).`);
  if (semCnpj) linhas.push(`${semCnpj} sem CNPJ localizado no PDF.`);
  if (semParcelamento) linhas.push(`${semParcelamento} sem parcelamento cadastrado com esse CNPJ.`);
  if (comErro) linhas.push(`${comErro} com erro de leitura.`);
  if (vinculados) linhas.push("\nClique em Salvar para gravar os comentários e anexos.");
  notificar(`Lote processado: ${vinculados} vinculado(s)`, vinculados ? "ok" : "aviso");
  avisar(linhas.join("\n"), { titulo: "Importação concluída", tipo: vinculados ? "ok" : "aviso" });
});

$("#busca")?.addEventListener("input", atrasar((e) => {
  filtroParc = e.target.value.trim().toLowerCase();
  renderizarParcelamentos();
}, 150));

iniciarPagina();
