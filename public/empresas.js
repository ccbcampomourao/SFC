// ============================================================================
// empresas.js — página de Grupos/Empresas + Tarefas do Dia (empresas.html)
//
// Desempenho: a lista é desenhada UMA vez; depois, cada ação atualiza só o pedaço
// que mudou (o cartão da empresa, o cabeçalho do grupo, o painel de números).
// Antes, qualquer clique apagava e redesenhava todas as empresas — era isso que
// causava os travamentos e o "pisca-pisca".
// ============================================================================
const GRUPOS_ABERTOS = new Set();   // objetos de grupo abertos
const EMPRESAS_ABERTAS = new Set(); // ids de empresas abertas
const EL_GRUPO = new Map();         // grupo -> elemento do cartão
const EL_EMPRESA = new Map();       // id da empresa -> elemento do cartão
let filtroAtual = "";

function renderizarPagina() {
  renderizarDashboard();
  renderizarGrupos();
  renderizarChecklist();
}

function grupoDaEmpresa(empresa) {
  return ESTADO.grupos.find((g) => g.empresas.includes(empresa));
}

// ---------------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------------
function renderizarDashboard() {
  const cont = $("#dashboard");
  let total = 0, tv = 0, ta = 0, te = 0;
  const cards = ESTADO.grupos.map((g) => {
    const { verde, vermelho, atencao } = contarStatus(g.empresas, "status");
    total += g.empresas.length; tv += verde; ta += atencao; te += vermelho;
    return htmlKpi({ nome: g.nome, total: g.empresas.length, verde, atencao, vermelho, iconeNome: "pasta" });
  });
  const geral = htmlKpi({ nome: "Geral", total, verde: tv, atencao: ta, vermelho: te, destaque: true, iconeNome: "grafico" });
  cont.innerHTML = geral + cards.join("");
}

// ---------------------------------------------------------------------------
// GRUPOS
// ---------------------------------------------------------------------------
$("#btn-novo-grupo").addEventListener("click", async () => {
  const nome = await perguntar("Novo grupo", { placeholder: "Ex.: Simples Nacional", textoOk: "Criar grupo" });
  if (!nome || !nome.trim()) return;
  const grupo = { nome: nome.trim(), empresas: [] };
  ESTADO.grupos.push(grupo);
  GRUPOS_ABERTOS.add(grupo);
  marcarAlterado();
  renderizarGrupos();
  renderizarDashboard();
});

$("#btn-expandir-todos")?.addEventListener("click", (e) => {
  const todosAbertos = ESTADO.grupos.every((g) => GRUPOS_ABERTOS.has(g));
  ESTADO.grupos.forEach((g) => (todosAbertos ? GRUPOS_ABERTOS.delete(g) : GRUPOS_ABERTOS.add(g)));
  e.currentTarget.innerHTML = todosAbertos ? `${icone("setaBaixo")}Abrir todos` : `${icone("seta")}Fechar todos`;
  renderizarGrupos();
});

function empresaPassaFiltro(e) {
  if (!filtroAtual) return true;
  const f = filtroAtual;
  return (e.nome || "").toLowerCase().includes(f) || (e.cnpj || "").includes(f) || limparDigitos(e.cnpj).includes(limparDigitos(f) || "\u0000");
}

function renderizarGrupos() {
  const cont = $("#lista-grupos");
  EL_GRUPO.clear();
  EL_EMPRESA.clear();
  const frag = document.createDocumentFragment();
  ESTADO.grupos.forEach((grupo) => {
    const card = criarGrupoCard(grupo);
    if (card) frag.appendChild(card);
  });
  cont.replaceChildren(frag);
  if (!cont.children.length) {
    cont.innerHTML = filtroAtual
      ? `<div class="vazio">${icone("busca", "ico-xl")}<strong>Nada encontrado</strong><p>Nenhuma empresa com “${escaparHtml(filtroAtual)}” no nome ou CNPJ.</p></div>`
      : `<div class="vazio">${icone("camadas", "ico-xl")}<strong>Nenhum grupo ainda</strong><p>Crie um grupo (ex.: Simples Nacional, Lucro Presumido) e adicione as empresas dentro dele.</p></div>`;
  }
}

function htmlCabecalhoGrupo(grupo, aberto) {
  const { verde, vermelho, atencao } = contarStatus(grupo.empresas, "status");
  return `
    ${icone("seta", "chevron")}
    ${icone(aberto ? "pastaAberta" : "pasta", "ico-pasta")}
    <h3>${escaparHtml(grupo.nome)}</h3>
    <span class="mini-status">
      ${verde ? `<span class="ok" title="OK">${verde}</span>` : ""}
      ${atencao ? `<span class="atencao" title="Atenção">${atencao}</span>` : ""}
      ${vermelho ? `<span class="erro" title="Pendente">${vermelho}</span>` : ""}
    </span>
    <span class="contador-pilula">${grupo.empresas.length}</span>`;
}

function criarGrupoCard(grupo) {
  const visiveis = grupo.empresas.filter(empresaPassaFiltro);
  if (filtroAtual && visiveis.length === 0) return null;
  const aberto = GRUPOS_ABERTOS.has(grupo) || !!filtroAtual;

  const card = document.createElement("div");
  card.className = "grupo-card" + (aberto ? " aberto" : "");
  const cab = document.createElement("div");
  cab.className = "grupo-cabecalho";
  cab.setAttribute("role", "button");
  cab.tabIndex = 0;
  cab.setAttribute("aria-expanded", aberto);
  cab.innerHTML = htmlCabecalhoGrupo(grupo, aberto);
  const alternar = () => alternarGrupo(grupo);
  cab.addEventListener("click", alternar);
  cab.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alternar(); } });
  card.appendChild(cab);
  if (aberto) card.appendChild(criarCorpoGrupo(grupo, visiveis, false));
  EL_GRUPO.set(grupo, card);
  return card;
}

function criarCorpoGrupo(grupo, visiveis, animar) {
  const corpo = document.createElement("div");
  corpo.className = "grupo-corpo" + (animar ? " anim-surgir" : "");
  const acoes = document.createElement("div");
  acoes.className = "grupo-acoes";
  acoes.innerHTML = `
    <button type="button" class="btn-secundario btn-sm" data-acao="add">${icone("mais")}Empresa</button>
    <span class="painel-acoes">
      <button type="button" class="btn-ghost btn-sm" data-acao="renomear" title="Renomear grupo">${icone("documento")}Renomear</button>
      <button type="button" class="btn-ghost btn-sm" data-acao="excluir" title="Excluir grupo">${icone("lixeira")}Excluir grupo</button>
    </span>`;
  acoes.addEventListener("click", (e) => {
    const acao = e.target.closest("[data-acao]")?.dataset.acao;
    if (acao === "add") abrirFormNovaEmpresa(grupo);
    else if (acao === "renomear") renomearGrupo(grupo);
    else if (acao === "excluir") excluirGrupo(grupo);
  });
  corpo.appendChild(acoes);
  const lista = document.createElement("div");
  lista.className = "lista-empresas";
  visiveis.forEach((empresa) => lista.appendChild(criarEmpresaCard(empresa)));
  if (!visiveis.length) lista.innerHTML = '<p class="vazio-mini">Nenhuma empresa neste grupo ainda.</p>';
  corpo.appendChild(lista);
  return corpo;
}

function alternarGrupo(grupo) {
  const card = EL_GRUPO.get(grupo);
  if (!card) return;
  const abrir = !card.classList.contains("aberto");
  if (abrir) GRUPOS_ABERTOS.add(grupo); else GRUPOS_ABERTOS.delete(grupo);
  card.classList.toggle("aberto", abrir);
  const cab = card.querySelector(".grupo-cabecalho");
  cab.setAttribute("aria-expanded", abrir);
  cab.innerHTML = htmlCabecalhoGrupo(grupo, abrir);
  const corpoAtual = card.querySelector(".grupo-corpo");
  if (abrir && !corpoAtual) card.appendChild(criarCorpoGrupo(grupo, grupo.empresas.filter(empresaPassaFiltro), true));
  if (!abrir && corpoAtual) {
    corpoAtual.querySelectorAll(".empresa-card").forEach((el) => EL_EMPRESA.delete(el.dataset.id));
    corpoAtual.remove();
  }
}

function atualizarCabecalhoGrupo(grupo) {
  const card = EL_GRUPO.get(grupo);
  if (card) card.querySelector(".grupo-cabecalho").innerHTML = htmlCabecalhoGrupo(grupo, card.classList.contains("aberto"));
}

function redesenharGrupo(grupo) {
  const antigo = EL_GRUPO.get(grupo);
  const novo = criarGrupoCard(grupo);
  if (antigo && novo) antigo.replaceWith(novo);
  else renderizarGrupos();
}

async function renomearGrupo(grupo) {
  const nome = await perguntar("Renomear grupo", { valor: grupo.nome, textoOk: "Renomear" });
  if (!nome || !nome.trim() || nome.trim() === grupo.nome) return;
  grupo.nome = nome.trim();
  marcarAlterado();
  atualizarCabecalhoGrupo(grupo);
  renderizarDashboard();
}

async function excluirGrupo(grupo) {
  const qtd = grupo.empresas.length;
  const ok = await confirmar(
    qtd ? `O grupo "${grupo.nome}" e as ${qtd} empresa(s) dentro dele serão removidos da lista.` : `O grupo "${grupo.nome}" será removido.`,
    { titulo: "Excluir grupo?", textoOk: "Excluir", perigo: true }
  );
  if (!ok) return;
  ESTADO.grupos.splice(ESTADO.grupos.indexOf(grupo), 1);
  GRUPOS_ABERTOS.delete(grupo);
  marcarAlterado();
  renderizarGrupos();
  renderizarDashboard();
}

function abrirFormNovaEmpresa(grupo) {
  abrirModal(`
    <h2>Nova empresa</h2>
    <p class="modal-sub">Grupo: <b>${escaparHtml(grupo.nome)}</b>. Os demais dados podem ser preenchidos depois, abrindo a empresa.</p>
    <form id="form-nova-empresa">
      <div class="campo-form"><label>CNPJ</label><input id="ne-cnpj" inputmode="numeric" placeholder="00.000.000/0000-00"></div>
      <div class="campo-form"><label>Nome</label><input id="ne-nome" placeholder="Razão social ou apelido"></div>
      <div class="campo-form"><label>WhatsApp do cliente (opcional)</label><input id="ne-whatsapp" type="tel" placeholder="(44) 99999-9999"></div>
      <div id="ne-erro" class="mensagem-erro oculto"></div>
      <div class="modal-rodape">
        <button type="button" class="btn-ghost" id="ne-cancelar">Cancelar</button>
        <button type="submit" class="btn-primario">${icone("mais")}Adicionar</button>
      </div>
    </form>`);
  $("#ne-cancelar").addEventListener("click", fecharModal);
  $("#form-nova-empresa").addEventListener("submit", (e) => {
    e.preventDefault();
    const cnpj = $("#ne-cnpj").value.trim();
    const nome = $("#ne-nome").value.trim();
    const erro = $("#ne-erro");
    if (!cnpj && !nome) { erro.textContent = "Informe ao menos o CNPJ ou o nome."; erro.classList.remove("oculto"); return; }
    if (cnpj && buscarEmpresaPorCnpj(cnpj)) { erro.textContent = "Já existe uma empresa com esse CNPJ."; erro.classList.remove("oculto"); return; }
    const empresa = {
      id: crypto.randomUUID(),
      nome: nome || "Empresa sem nome",
      status: "SEM", nfs: false, nfe: false, nfc: false, fechado: false,
      cnpj, cpf: "", senhaPrefeitura: "", senhaRegularize: "", inscricaoEstadual: "", email: "",
      whatsapp: $("#ne-whatsapp").value.trim() ? formatarTelefone($("#ne-whatsapp").value.trim()) : "",
      comentarios: [], anexos: [],
    };
    grupo.empresas.push(empresa);
    fecharModal();
    GRUPOS_ABERTOS.add(grupo);
    EMPRESAS_ABERTAS.add(empresa.id);
    marcarAlterado();
    redesenharGrupo(grupo);
    renderizarDashboard();
    requestAnimationFrame(() => EL_EMPRESA.get(empresa.id)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  });
}

// ---------------------------------------------------------------------------
// CARTÃO DA EMPRESA
// ---------------------------------------------------------------------------
function htmlSelosEmpresa(empresa) {
  return [
    empresa.anexos.length ? `<span class="selo selo-anexado" title="${empresa.anexos.length} documento(s)">${icone("clipe")}ANEXADO${empresa.anexos.length > 1 ? " · " + empresa.anexos.length : ""}</span>` : "",
    empresa.nfs ? '<span class="selo selo-tag">NFS</span>' : "",
    empresa.nfe ? '<span class="selo selo-tag">NFE</span>' : "",
    empresa.nfc ? '<span class="selo selo-tag">NFC</span>' : "",
    empresa.fechado ? `<span class="selo selo-cadeado" title="Fechado">${icone("cadeado")}</span>` : "",
  ].join("");
}

function htmlCabecalhoEmpresa(empresa) {
  return `
    <div class="empresa-nome-wrap">
      <span class="empresa-nome">${icone("seta", "chevron")}<span class="texto">${escaparHtml(empresa.nome)}</span></span>
      <div class="selos-linha">${htmlSelosEmpresa(empresa)}</div>
    </div>
    <div class="chips-acesso">
      ${botaoCopiaSe(empresa.cnpj, "CNPJ")}
      ${botaoCopiaSe(empresa.cpf, "CPF")}
      ${botaoCopiaSe(empresa.inscricaoEstadual, "IE")}
      ${botaoCopiaSe(empresa.senhaPrefeitura, "Prefeitura")}
      ${botaoCopiaSe(empresa.senhaRegularize, "Regularize")}
      ${empresa.email ? `<button type="button" class="chip-copia chip-email" data-email title="Enviar documentos para ${escaparHtml(empresa.email)}">${icone("email")}Enviar e-mail</button>` : ""}
      ${empresa.whatsapp ? `<button type="button" class="chip-copia chip-whatsapp" data-whatsapp title="Enviar documentos pelo WhatsApp para ${escaparHtml(empresa.whatsapp)}">${icone("conversa")}WhatsApp</button>` : ""}
    </div>
    <button type="button" class="btn-icone" data-excluir title="Excluir empresa">${icone("lixeira")}</button>`;
}

function criarEmpresaCard(empresa) {
  const aberto = EMPRESAS_ABERTAS.has(empresa.id);
  const wrap = document.createElement("div");
  wrap.className = `empresa-card ${classeStatus(empresa.status)}${aberto ? " aberto" : ""}`;
  wrap.dataset.id = empresa.id;

  const header = document.createElement("div");
  header.className = "empresa-header";
  header.setAttribute("role", "button");
  header.tabIndex = 0;
  header.setAttribute("aria-expanded", aberto);
  header.innerHTML = htmlCabecalhoEmpresa(empresa);
  // Um único listener por cabeçalho (delegação) — sobrevive às atualizações do innerHTML.
  header.addEventListener("click", (e) => {
    const copia = e.target.closest("[data-copiar]");
    if (copia) {
      const mapa = { CNPJ: empresa.cnpj, CPF: empresa.cpf, IE: empresa.inscricaoEstadual, Prefeitura: empresa.senhaPrefeitura, Regularize: empresa.senhaRegularize };
      return copiar(copia.dataset.copiar, mapa[copia.dataset.copiar]);
    }
    if (e.target.closest("[data-email]")) return enviarEmailEmpresaOriginal(empresa, e.target.closest("[data-email]"));
    if (e.target.closest("[data-whatsapp]")) return enviarWhatsAppEmpresa(empresa);
    if (e.target.closest("[data-excluir]")) return excluirEmpresa(empresa);
    alternarEmpresa(empresa);
  });
  header.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === header) { e.preventDefault(); alternarEmpresa(empresa); }
  });
  wrap.appendChild(header);
  if (aberto) wrap.appendChild(criarCorpoEmpresa(empresa));
  EL_EMPRESA.set(empresa.id, wrap);
  return wrap;
}

function alternarEmpresa(empresa) {
  const wrap = EL_EMPRESA.get(empresa.id);
  if (!wrap) return;
  const abrir = !wrap.classList.contains("aberto");
  if (abrir) EMPRESAS_ABERTAS.add(empresa.id); else EMPRESAS_ABERTAS.delete(empresa.id);
  wrap.classList.toggle("aberto", abrir);
  wrap.querySelector(".empresa-header").setAttribute("aria-expanded", abrir);
  const corpo = wrap.querySelector(".empresa-corpo");
  if (abrir && !corpo) wrap.appendChild(criarCorpoEmpresa(empresa));
  if (!abrir && corpo) corpo.remove();
}

// Atualiza o cabeçalho (nome, selos, chips) e a cor de status — sem mexer no corpo aberto.
function atualizarEmpresa(empresa) {
  const wrap = EL_EMPRESA.get(empresa.id);
  if (!wrap) return;
  wrap.className = `empresa-card ${classeStatus(empresa.status)}${wrap.classList.contains("aberto") ? " aberto" : ""}`;
  wrap.querySelector(".empresa-header").innerHTML = htmlCabecalhoEmpresa(empresa);
}

function mudouStatus(empresa) {
  atualizarEmpresa(empresa);
  const wrap = EL_EMPRESA.get(empresa.id);
  const barra = wrap && wrap.querySelector(".barra-opcoes");
  if (barra) atualizarBotoesStatus(barra, empresa.status);
  const grupo = grupoDaEmpresa(empresa);
  if (grupo) atualizarCabecalhoGrupo(grupo);
  renderizarDashboard();
  marcarAlterado();
}

async function excluirEmpresa(empresa) {
  const ok = await confirmar(`"${empresa.nome}" será removida da lista. Essa ação não pode ser desfeita depois de salvar.`, { titulo: "Excluir empresa?", textoOk: "Excluir", perigo: true });
  if (!ok) return;
  const grupo = grupoDaEmpresa(empresa);
  if (!grupo) return;
  grupo.empresas.splice(grupo.empresas.indexOf(empresa), 1);
  EMPRESAS_ABERTAS.delete(empresa.id);
  const wrap = EL_EMPRESA.get(empresa.id);
  EL_EMPRESA.delete(empresa.id);
  if (wrap) wrap.remove();
  atualizarCabecalhoGrupo(grupo);
  renderizarDashboard();
  marcarAlterado();
  notificar(`"${empresa.nome}" excluída — clique em Salvar para confirmar`, "info");
}

const CAMPOS_EMPRESA = [
  ["nome", "Nome"], ["cnpj", "CNPJ"], ["cpf", "CPF"], ["email", "E-mail", "email"],
  ["whatsapp", "WhatsApp do cliente", "tel", "(44) 99999-9999"],
  ["senhaPrefeitura", "Senha Prefeitura"], ["senhaRegularize", "Senha Regularize"], ["inscricaoEstadual", "Inscrição Estadual"],
];

function criarCorpoEmpresa(empresa) {
  const corpo = document.createElement("div");
  corpo.className = "empresa-corpo";

  // Status + checkboxes
  const barra = document.createElement("div");
  barra.className = "barra-opcoes";
  const chk = (campo, rotulo, extra = "") =>
    `<label class="chip-check ${extra}"><input type="checkbox" data-cb="${campo}" ${empresa[campo] ? "checked" : ""}><span class="caixa">${icone("check")}</span>${rotulo}</label>`;
  barra.innerHTML = `${htmlBotoesStatus(empresa.status)}<span class="separador-v"></span>${chk("nfs", "NFS")}${chk("nfe", "NFE")}${chk("nfc", "NFC")}${chk("fechado", `${icone("cadeado", "ico-sm")}Fechado`, "fechado")}`;
  barra.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-status]");
    if (!btn) return;
    empresa.status = empresa.status === btn.dataset.status ? "SEM" : btn.dataset.status;
    mudouStatus(empresa);
  });
  barra.addEventListener("change", (e) => {
    const cb = e.target.closest("[data-cb]");
    if (!cb) return;
    empresa[cb.dataset.cb] = cb.checked;
    atualizarEmpresa(empresa);
    marcarAlterado();
  });
  corpo.appendChild(barra);

  // Dados de acesso
  const campos = document.createElement("div");
  campos.className = "grade-campos";
  campos.innerHTML = CAMPOS_EMPRESA.map(([campo, rotulo, tipo, placeholder]) =>
    `<div class="campo-form"><label>${rotulo}</label><input data-campo="${campo}" ${tipo ? `type="${tipo}"` : ""} ${placeholder ? `placeholder="${placeholder}"` : ""} value="${escaparHtml(empresa[campo] || "")}" autocomplete="off" spellcheck="false"></div>`
  ).join("");
  campos.addEventListener("change", (e) => {
    const inp = e.target.closest("[data-campo]");
    if (!inp) return;
    let valor = inp.value.trim();
    if (inp.dataset.campo === "nome" && !valor) { inp.value = empresa.nome; return; }
    if (inp.dataset.campo === "whatsapp" && valor) {
      valor = formatarTelefone(valor);
      inp.value = valor;
      if (!normalizarWhatsapp(valor)) notificar("Esse WhatsApp não parece um celular válido (use DDD + número).", "aviso");
    }
    empresa[inp.dataset.campo] = valor;
    atualizarEmpresa(empresa); // só o cabeçalho — o foco continua no próximo campo
    marcarAlterado();
    inp.classList.add("salvo");
    setTimeout(() => inp.classList.remove("salvo"), 700);
  });
  corpo.appendChild(campos);

  // Ações extras
  const acoesExtra = document.createElement("div");
  acoesExtra.className = "acoes-extra";
  acoesExtra.innerHTML = `
    <button type="button" class="btn-secundario btn-sm btn-consultar-simples">${icone("busca")}Consultar Simples Nacional</button>
    <button type="button" class="btn-secundario btn-sm btn-consultar-exclusao">${icone("proibido")}Consultar exclusão</button>
    <button type="button" class="btn-secundario btn-sm btn-importar-resumo">${icone("documento")}Importar Resumo (PGDAS)</button>
    <input type="file" accept="application/pdf" class="input-resumo oculto">
    <span class="resultado-simples"></span>`;
  const colComentarios = montarColunaComentarios(empresa);
  const colAnexos = montarColunaAnexos(empresa, { aoMudar: () => atualizarEmpresa(empresa), nomeAlvo: "desta empresa" });
  const btnSimples = acoesExtra.querySelector(".btn-consultar-simples");
  btnSimples.addEventListener("click", () =>
    comCarregando(btnSimples, () => consultarSimplesNacional(empresa, acoesExtra.querySelector(".resultado-simples"), colComentarios)));
  const btnExclusao = acoesExtra.querySelector(".btn-consultar-exclusao");
  btnExclusao.addEventListener("click", () =>
    comCarregando(btnExclusao, () => consultarSimplesNacional(empresa, acoesExtra.querySelector(".resultado-simples"), colComentarios, "exclusao")));
  const btnResumo = acoesExtra.querySelector(".btn-importar-resumo");
  const inputResumo = acoesExtra.querySelector(".input-resumo");
  btnResumo.addEventListener("click", () => inputResumo.click());
  inputResumo.addEventListener("change", (e) =>
    comCarregando(btnResumo, () => importarResumoPdf(empresa, e.target.files[0], e.target, { colComentarios, colAnexos })));
  corpo.appendChild(acoesExtra);

  const duas = document.createElement("div");
  duas.className = "duas-colunas-detalhe";
  duas.append(colComentarios, colAnexos);
  corpo.appendChild(duas);
  return corpo;
}

// ---------------------------------------------------------------------------
// CONSULTAR SIMPLES NACIONAL (dados públicos da Receita, via BrasilAPI e reservas)
// ---------------------------------------------------------------------------
const CONSULTANDO_SIMPLES = new Set(); // evita consultas repetidas (a fonte limita requisições)

// "2018-01-01" → "01/01/2018". Feito na mão de propósito: new Date("2018-01-01") é interpretado
// como meia-noite UTC e, no horário do Brasil, aparece como 31/12/2017 (um dia a menos).
// Aceita também datas que já vierem como "01/01/2018".
function formatarDataISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(iso || "");
  return br ? br[0] : "";
}

// Data da base pública → Date no horário local (meia-noite), para comparar com "hoje".
function dataLocal(valor) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(valor || "") || null;
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(valor || "");
  return br ? new Date(+br[3], +br[2] - 1, +br[1]) : null;
}

function hojeMeiaNoite() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function descreverSimples(r) {
  let texto, tipo;
  if (r.optanteSimples === true) {
    texto = `Optante pelo Simples Nacional${r.dataOpcaoSimples ? " desde " + formatarDataISO(r.dataOpcaoSimples) : ""}`;
    tipo = "ok";
    const ex = dataLocal(r.dataExclusaoSimples);
    if (ex && ex > hojeMeiaNoite()) { texto += ` — com exclusão marcada para ${formatarDataISO(r.dataExclusaoSimples)}`; tipo = "erro"; }
  } else if (r.optanteSimples === false) {
    texto = "Não é optante pelo Simples Nacional";
    if (r.dataExclusaoSimples) texto += ` (excluída em ${formatarDataISO(r.dataExclusaoSimples)})`;
    tipo = "erro";
  } else {
    // A base pública não tem registro de opção — isso NÃO é a mesma coisa que "não optante".
    texto = "Sem registro de opção pelo Simples Nacional na base pública (provavelmente não optante — confirme no portal da Receita se for decisivo)";
    tipo = "aviso";
  }
  if (r.optanteMei === true) texto += " · também é MEI";
  return { texto, tipo };
}

// Foco na EXCLUSÃO: se/quando a empresa foi excluída do Simples (e desenquadrada do MEI).
// situacao: "excluida" | "agendada" | "voltou" | "sem_exclusao" | "nao_optante" | "sem_registro"
function descreverExclusao(r) {
  const hoje = hojeMeiaNoite();
  const exS = dataLocal(r.dataExclusaoSimples);
  const opS = dataLocal(r.dataOpcaoSimples);
  const fEx = formatarDataISO(r.dataExclusaoSimples);
  const fOp = formatarDataISO(r.dataOpcaoSimples);
  let texto, tipo, situacao, rotulo;

  if (exS && exS > hoje) {
    situacao = "agendada"; tipo = "erro"; rotulo = `Exclusão em ${fEx}`;
    texto = `Exclusão do Simples Nacional já registrada, com efeito em ${fEx} (até lá ainda é optante)`;
  } else if (exS && r.optanteSimples === true && opS && opS > exS) {
    situacao = "voltou"; tipo = "aviso"; rotulo = "Voltou a optar";
    texto = `Já foi excluída do Simples em ${fEx}, mas voltou a optar em ${fOp}`;
  } else if (exS) {
    situacao = "excluida"; tipo = "erro"; rotulo = `Excluída em ${fEx}`;
    texto = `Excluída do Simples Nacional em ${fEx}${fOp ? ` (era optante desde ${fOp})` : ""}`;
  } else if (r.optanteSimples === true) {
    situacao = "sem_exclusao"; tipo = "ok"; rotulo = "Sem exclusão";
    texto = `Nenhuma exclusão registrada — optante desde ${fOp || "data não informada"}`;
  } else if (r.optanteSimples === false) {
    situacao = "nao_optante"; tipo = "aviso"; rotulo = "Não optante";
    texto = "Não é optante e a base pública não traz data de exclusão (provavelmente nunca optou)";
  } else {
    situacao = "sem_registro"; tipo = "aviso"; rotulo = "Sem registro";
    texto = "A base pública não tem registro de opção nem de exclusão do Simples para esse CNPJ";
  }

  const exM = dataLocal(r.dataExclusaoMei);
  if (exM) {
    const fM = formatarDataISO(r.dataExclusaoMei);
    texto += exM > hoje ? ` · desenquadramento do MEI com efeito em ${fM}` : ` · desenquadrada do MEI em ${fM}`;
    if (situacao === "sem_exclusao" || situacao === "nao_optante" || situacao === "sem_registro") {
      situacao = "mei"; tipo = "aviso"; rotulo = exM > hoje ? `Sai do MEI em ${fM}` : `Saiu do MEI em ${fM}`;
    }
  }
  return { texto, tipo, situacao, rotulo, teveExclusao: !!(exS || exM) };
}

function textoOrigemConsulta(r) {
  return `Fonte: ${r.fonte} (base pública da Receita, atualizada mensalmente)` +
    (r.doCache && r.consultadoEm ? ` · consulta de ${new Date(r.consultadoEm).toLocaleString("pt-BR")}` : "");
}

// modo "optante" (botão Consultar Simples Nacional) ou "exclusao" (botão Consultar exclusão)
async function consultarSimplesNacional(empresa, elResultado, colComentarios, modo = "optante") {
  if (!empresa.cnpj) { elResultado.className = "resultado-simples aviso"; elResultado.innerHTML = `${icone("alerta")}Informe o CNPJ da empresa primeiro.`; return; }
  if (CONSULTANDO_SIMPLES.has(empresa.cnpj)) return;
  CONSULTANDO_SIMPLES.add(empresa.cnpj);
  elResultado.className = "resultado-simples";
  elResultado.innerHTML = `${icone("carregando", "girando")}Consultando...`;
  try {
    const r = await api(`/api/consulta-cnpj?cnpj=${encodeURIComponent(empresa.cnpj)}`);
    const { texto, tipo } = modo === "exclusao" ? descreverExclusao(r) : descreverSimples(r);
    const origem = textoOrigemConsulta(r);
    elResultado.className = `resultado-simples ${tipo}`;
    elResultado.innerHTML = `${icone(tipo === "ok" ? "ok" : tipo === "erro" ? "erro" : "alerta")}<span>${escaparHtml(texto)}</span>`;
    elResultado.title = origem + (modo === "exclusao" ? "\nExclusões por débito notificadas agora (Termo de Exclusão) só aparecem na base depois de entrarem em vigor." : "");
    empresa.comentarios = empresa.comentarios || [];
    empresa.comentarios.push(`${modo === "exclusao" ? "Consulta exclusão do Simples" : "Consulta Simples Nacional"}: ${texto}\n${origem}\n${agora()}`);
    colComentarios?.atualizar();
    marcarAlterado();
  } catch (err) {
    elResultado.className = "resultado-simples erro";
    elResultado.innerHTML = `${icone("erro")}<span>${escaparHtml(err.message)}</span>`;
  } finally {
    CONSULTANDO_SIMPLES.delete(empresa.cnpj);
  }
}

// ---------------------------------------------------------------------------
// VERIFICAR EXCLUSÕES DE TODAS AS EMPRESAS (lote, uma consulta por vez)
// ---------------------------------------------------------------------------
function irParaEmpresa(empresa) {
  const grupo = grupoDaEmpresa(empresa);
  if (!grupo) return;
  if (filtroAtual && !empresaPassaFiltro(empresa)) {
    filtroAtual = "";
    const busca = $("#busca");
    if (busca) busca.value = "";
    renderizarGrupos();
  }
  GRUPOS_ABERTOS.add(grupo);
  EMPRESAS_ABERTAS.add(empresa.id);
  redesenharGrupo(grupo);
  requestAnimationFrame(() => EL_EMPRESA.get(empresa.id)?.scrollIntoView({ block: "center", behavior: "smooth" }));
}

const ORDEM_SITUACAO = { agendada: 0, excluida: 1, mei: 2, voltou: 3, erro: 4, nao_optante: 5, sem_registro: 6, sem_exclusao: 7 };
const ETIQUETA_SITUACAO = { agendada: "erro", excluida: "erro", mei: "aviso", voltou: "aviso", erro: "neutra", nao_optante: "neutra", sem_registro: "neutra", sem_exclusao: "ok" };

$("#btn-verificar-exclusoes")?.addEventListener("click", () => {
  const empresas = [];
  ESTADO.grupos.forEach((g) => g.empresas.forEach((e) => { if (limparDigitos(e.cnpj).length === 14) empresas.push(e); }));
  abrirModal(`
    <h2>Verificar exclusões do Simples Nacional</h2>
    <p class="modal-sub">Consulta a base pública da Receita para as <b>${empresas.length}</b> empresa(s) com CNPJ cadastrado, uma de cada vez. Gratuito e sem certificado.
    <br><b>Atenção:</b> a base é atualizada uma vez por mês e só mostra a exclusão depois que ela entra em vigor. Exclusões por débito notificadas agora (Termo de Exclusão no DTE-SN, com efeito em 1º de janeiro) ainda não aparecem aqui.</p>
    <label class="chip-check azul" style="margin-bottom:14px"><input type="checkbox" id="vx-comentar" checked><span class="caixa">${icone("check")}</span>Registrar nos comentários das empresas com exclusão</label>
    <div class="ic-progresso oculto" id="vx-progresso" style="margin-bottom:12px">
      <span id="vx-progresso-texto"></span>
      <div class="ic-progresso-barra"><span id="vx-progresso-barra"></span></div>
    </div>
    <div id="vx-resultado" class="lista-linhas" style="max-height:46vh;overflow-y:auto"></div>
    <div class="modal-rodape">
      <button type="button" class="btn-ghost" id="vx-fechar">Fechar</button>
      <button type="button" class="btn-primario" id="vx-iniciar"${empresas.length ? "" : " disabled"}>${icone("busca")}Verificar ${empresas.length} empresa(s)</button>
    </div>`);
  $("#vx-fechar").addEventListener("click", fecharModal);
  $("#vx-iniciar").addEventListener("click", (ev) => comCarregando(ev.currentTarget, () => verificarExclusoesEmLote(empresas)));
});

async function verificarExclusoesEmLote(empresas) {
  const lista = $("#vx-resultado");
  const comentar = $("#vx-comentar").checked;
  const prog = $("#vx-progresso"), progTexto = $("#vx-progresso-texto"), progBarra = $("#vx-progresso-barra");
  prog.classList.remove("oculto");
  lista.innerHTML = "";
  const resultados = [];
  let comExclusao = 0, falhas = 0, comentados = 0;
  const modalAberto = () => document.body.contains(lista) && !$("#modal-fundo").classList.contains("oculto");
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

  const desenhar = () => {
    resultados.sort((a, b) => (ORDEM_SITUACAO[a.situacao] - ORDEM_SITUACAO[b.situacao]) || a.empresa.nome.localeCompare(b.empresa.nome, "pt-BR"));
    lista.innerHTML = resultados.map((x, i) => `
      <div class="linha-item">
        <span class="linha-icone">${icone(x.situacao === "sem_exclusao" ? "ok" : x.situacao === "erro" ? "info" : "alerta", "ico-sm")}</span>
        <span class="linha-texto"><b>${escaparHtml(x.empresa.nome)}</b><small title="${escaparHtml(x.texto)}">${escaparHtml(x.empresa.cnpj)} · ${escaparHtml(x.texto)}</small></span>
        <span class="etiqueta etiqueta-${ETIQUETA_SITUACAO[x.situacao]}">${escaparHtml(x.rotulo)}</span>
        <button type="button" class="btn-icone neutro" data-ir="${i}" title="Abrir empresa">${icone("seta")}</button>
      </div>`).join("");
  };
  lista.onclick = (e) => {
    const b = e.target.closest("[data-ir]");
    if (!b) return;
    const emp = resultados[+b.dataset.ir].empresa;
    fecharModal();
    irParaEmpresa(emp);
  };

  for (let i = 0; i < empresas.length; i++) {
    if (!modalAberto()) break; // fechou a janela = cancelou
    const empresa = empresas[i];
    progTexto.textContent = `Consultando ${i + 1} de ${empresas.length}: ${empresa.nome}`;
    progBarra.style.transform = `scaleX(${i / empresas.length})`;
    let r = null, erro = null;
    for (let tentativa = 0; tentativa < 4 && modalAberto(); tentativa++) {
      try {
        r = await api(`/api/consulta-cnpj?cnpj=${encodeURIComponent(empresa.cnpj)}`);
        break;
      } catch (err) {
        erro = err;
        if (err.status !== 429) break;
        // Fonte limitando: espera e tenta de novo (as já consultadas ficam em cache 24h)
        for (let s = 20; s > 0 && modalAberto(); s--) {
          progTexto.textContent = `A fonte pública pediu uma pausa — continuando em ${s}s (${i + 1} de ${empresas.length})`;
          await esperar(1000);
        }
      }
    }
    if (r) {
      const d = descreverExclusao(r);
      resultados.push({ empresa, ...d });
      if (d.teveExclusao) {
        comExclusao++;
        if (comentar) {
          const linha = `Consulta exclusão do Simples: ${d.texto}`;
          const ja = (empresa.comentarios || []).some((c) => c.startsWith(linha));
          if (!ja) {
            empresa.comentarios = empresa.comentarios || [];
            empresa.comentarios.push(`${linha}\n${textoOrigemConsulta(r)}\n${agora()}`);
            comentados++;
          }
        }
      }
      if (!r.doCache) await esperar(400); // gentil com a fonte gratuita
    } else if (erro) {
      falhas++;
      resultados.push({ empresa, situacao: "erro", rotulo: "Não consultada", texto: erro.message });
    }
    desenhar();
  }

  progBarra.style.transform = "scaleX(1)";
  const consultadas = resultados.length;
  progTexto.textContent = `${consultadas} de ${empresas.length} consultadas · ${comExclusao} com exclusão${falhas ? ` · ${falhas} não consultada(s)` : ""}`;
  if (comentados) {
    marcarAlterado();
    renderizarGrupos(); // atualiza os comentários das empresas abertas
  }
  notificar(comExclusao ? `${comExclusao} empresa(s) com exclusão do Simples encontrada(s)` : "Nenhuma exclusão encontrada na base pública", comExclusao ? "aviso" : "ok");
}

// ---------------------------------------------------------------------------
// IMPORTAR RESUMO PDF (lê o Resumo do PGDAS e monta um Relatório Fiscal formatado,
// anexando na própria empresa) — lógica idêntica à do app original
// ---------------------------------------------------------------------------
function removerAcentosResumo(texto) {
  return (texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function extrairValoresFaturamento(linha, label) {
  const res = [label, "0,00", "0,00", "0,00"];
  const valores = linha.match(/\d{1,3}(?:\.\d{3})*,\d{2}/g) || [];
  const total = valores.length;
  if (total >= 3) { res[1] = valores[total - 3]; res[2] = valores[total - 2]; res[3] = valores[total - 1]; }
  else if (total === 2) { res[1] = valores[0]; res[3] = valores[1]; }
  else if (total === 1) { res[3] = valores[0]; }
  return res;
}

function identificarNaturezaResumo(linhaUpper) {
  const temFatorR = linhaUpper.includes("FATOR R");
  const mAnexo = linhaUpper.match(/ANEXO\s+(I|II|III|IV|V)\b/);
  const anexo = mAnexo ? mAnexo[1] : null;
  if (temFatorR) return anexo ? `Anexo ${anexo} (Fator R)` : "Fator R";
  if (anexo) return `Anexo ${anexo}`;
  if (linhaUpper.includes("INDUSTRIA")) return "Industria";
  if (linhaUpper.includes("COMERCIO")) return "Comercio";
  return "Natureza nao identificada";
}

function formatarMoedaBR(valor) {
  return valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function processarTextoResumo(textoPdfOriginal) {
  const textoNormalizado = removerAcentosResumo(textoPdfOriginal).replace(/"/g, "").replace(/\r/g, "");
  const linhas = textoNormalizado.split("\n").map((l) => {
    let s = l.replace(/\|/g, "").trim();
    if (s.startsWith(",")) s = s.slice(1).trim();
    return s;
  });

  let fat12Meses = ["DOS ULTIMOS 12 MESES", "0,00", "0,00", "0,00"];
  let fatMesAtual = ["DO MES ATUAL", "0,00", "0,00", "0,00"];
  let fatDoAno = ["DO ANO", "0,00", "0,00", "0,00"];
  let inNat = false;
  const operacoesLidas = [];

  for (const l of linhas) {
    if (!l) continue;
    const lUpper = l.toUpperCase();

    if (lUpper.includes("ULTIMO 12 MES") || lUpper.includes("ULTIMOS 12 MES")) { fat12Meses = extrairValoresFaturamento(l, "DOS ULTIMOS 12 MESES"); continue; }
    if (lUpper.startsWith("DO MES ATUAL")) { fatMesAtual = extrairValoresFaturamento(l, "DO MES ATUAL"); continue; }
    if (lUpper.startsWith("DO ANO")) { fatDoAno = extrairValoresFaturamento(l, "DO ANO"); continue; }
    if (lUpper.includes("NATUREZA DA OPERACAO")) { inNat = true; continue; }

    if (inNat) {
      if (lUpper.startsWith("TOTAL:")) { inNat = false; continue; }
      if (["CNPJ", "UF ORIGEM", "ANEXO", "RECEITA"].includes(lUpper) || lUpper.startsWith("ALIQ") || lUpper === "IMPOSTO") continue;

      const op = { natureza: identificarNaturezaResumo(lUpper), cnpj: "-", uf: "-", receita: 0, imposto: 0, isDevolucao: lUpper.includes("DEVOLUCAO") };
      const mCnpj = l.match(/\d{4}-\d{2}/);
      if (mCnpj) op.cnpj = mCnpj[0];
      const mUf = l.match(/\b([A-Z]{2})-([A-Za-zÀ-ú]+)\b/);
      if (mUf) op.uf = mUf[0];
      const vals = l.match(/\d{1,3}(?:\.\d{3})*,\d{2}/g) || [];
      if (vals.length >= 2) {
        op.receita = parseFloat(vals[0].replace(/\./g, "").replace(",", "."));
        op.imposto = parseFloat(vals[vals.length - 1].replace(/\./g, "").replace(",", "."));
      } else if (vals.length === 1) {
        op.receita = parseFloat(vals[0].replace(/\./g, "").replace(",", "."));
      }
      operacoesLidas.push(op);
    }
  }

  const consolidados = {};
  for (const op of operacoesLidas) {
    if (!consolidados[op.natureza]) consolidados[op.natureza] = { natureza: op.natureza, cnpj: op.cnpj, uf: op.uf, receita: 0, imposto: 0 };
    const cons = consolidados[op.natureza];
    if (op.isDevolucao) { cons.receita -= op.receita; cons.imposto -= op.imposto; }
    else {
      cons.receita += op.receita; cons.imposto += op.imposto;
      if (cons.cnpj === "-" && op.cnpj !== "-") cons.cnpj = op.cnpj;
      if (cons.uf === "-" && op.uf !== "-") cons.uf = op.uf;
    }
  }

  let somaReceita = 0, somaImposto = 0;
  const linhasNatureza = [];
  Object.values(consolidados).forEach((cons) => {
    if (cons.receita <= 0 && cons.imposto <= 0) return;
    somaReceita += cons.receita; somaImposto += cons.imposto;
    const aliq = cons.receita > 0 ? formatarMoedaBR((cons.imposto / cons.receita) * 100) + "%" : "-";
    linhasNatureza.push([cons.natureza, cons.cnpj, cons.uf, formatarMoedaBR(cons.receita), aliq, formatarMoedaBR(cons.imposto)]);
  });

  let totalNatureza;
  if (somaReceita > 0 || somaImposto > 0) {
    const aliqTotal = somaReceita > 0 ? formatarMoedaBR((somaImposto / somaReceita) * 100) + "%" : "-";
    totalNatureza = ["TOTAL", "-", "-", formatarMoedaBR(somaReceita), aliqTotal, formatarMoedaBR(somaImposto)];
  } else {
    totalNatureza = ["TOTAL", "-", "-", "0,00", "-", "0,00"];
  }
  if (linhasNatureza.length === 0) linhasNatureza.push(["Sem Movimentos Registrados", "-", "-", "0,00", "-", "0,00"]);

  return { fat12Meses, fatMesAtual, fatDoAno, linhasNatureza, totalNatureza };
}

function gerarRelatorioFiscalPDF(nomeEmpresa, dados) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const corHeader = [35, 42, 74];
  const corCinzaClaro = [240, 240, 240];
  const corLinha = [220, 220, 220];
  let y = 40;

  doc.setFillColor(...corHeader);
  doc.rect(30, y, 552, 35, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold"); doc.setFontSize(13);
  doc.text("RELATÓRIO FISCAL — SIMPLES NACIONAL", 40, y + 16);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9);
  doc.text(removerAcentosResumo(nomeEmpresa).toUpperCase(), 40, y + 29);
  y += 35 + 25;

  doc.setTextColor(100, 100, 100);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9);
  doc.text("Resumo do faturamento e dos impostos apurados no PGDAS referente ao período informado pela Receita Federal.", 35, y);
  y += 25;

  doc.setTextColor(...corHeader);
  doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  doc.text("1. FATURAMENTO", 35, y);
  y += 15;

  const colX1 = [35, 250, 390, 480];
  doc.setFillColor(...corCinzaClaro); doc.rect(35, y - 10, 542, 14, "F");
  doc.setTextColor(0, 0, 0); doc.setFont("helvetica", "bold"); doc.setFontSize(8);
  ["PERÍODO", "MERCADO INTERNO", "MERCADO EXTERNO", "TOTAL (R$)"].forEach((t, i) => doc.text(t, colX1[i], y));
  y += 16;

  doc.setFont("helvetica", "normal");
  const rotulosFat = ["Faturamento dos últimos 12 meses", "Faturamento do mês atual", "Faturamento acumulado no ano"];
  [dados.fat12Meses, dados.fatMesAtual, dados.fatDoAno].forEach((linha, li) => {
    doc.text(rotulosFat[li], colX1[0], y);
    for (let i = 1; i < 4; i++) doc.text("R$ " + linha[i], colX1[i], y);
    y += 15;
    doc.setDrawColor(...corLinha); doc.setLineWidth(0.5); doc.line(35, y - 5, 577, y - 5);
  });

  y += 20;
  doc.setTextColor(...corHeader);
  doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  doc.text("2. NATUREZA DA OPERAÇÃO E IMPOSTOS", 35, y);
  y += 15;

  const colX2 = [35, 230, 290, 350, 430, 500];
  doc.setFillColor(...corCinzaClaro); doc.rect(35, y - 10, 542, 14, "F");
  doc.setTextColor(0, 0, 0); doc.setFont("helvetica", "bold"); doc.setFontSize(8);
  ["NATUREZA / ANEXO", "CNPJ", "UF", "RECEITA (R$)", "ALÍQUOTA", "IMPOSTO (R$)"].forEach((t, i) => doc.text(t, colX2[i], y));
  y += 16;

  doc.setFont("helvetica", "normal");
  dados.linhasNatureza.forEach((linha) => {
    if (y > 750) { doc.addPage(); y = 50; doc.setFont("helvetica", "normal"); doc.setFontSize(8); }
    linha.forEach((valor, i) => {
      let v = String(valor);
      if (i === 0 && v.length > 30) v = v.slice(0, 27) + "...";
      if (i === 3 || i === 5) v = "R$ " + v;
      doc.text(v, colX2[i], y);
    });
    y += 15;
    doc.setDrawColor(...corLinha); doc.setLineWidth(0.5); doc.line(35, y - 5, 577, y - 5);
  });

  doc.setFillColor(245, 245, 245); doc.rect(35, y - 10, 542, 14, "F");
  doc.setTextColor(0, 0, 0); doc.setFont("helvetica", "bold"); doc.setFontSize(8);
  dados.totalNatureza.forEach((valor, i) => {
    let v = String(valor);
    if (i === 3 || i === 5) v = "R$ " + v;
    doc.text(v, colX2[i], y);
  });

  return doc.output("blob");
}

async function importarResumoPdf(empresa, arquivo, inputEl, { colComentarios, colAnexos } = {}) {
  if (!arquivo) return;
  notificar("Lendo o Resumo...", "carregando");
  try {
    if (!window.jspdf) throw new Error("O gerador de PDF ainda está carregando. Tente de novo em alguns segundos.");
    const textoPdf = await extrairTextoPdf(arquivo);
    if (!textoPdf || !textoPdf.trim()) throw new Error("Não foi possível extrair texto desse PDF.");

    const dados = processarTextoResumo(textoPdf);
    notificar("Montando o Relatório Fiscal...", "carregando");
    const blob = gerarRelatorioFiscalPDF(empresa.nome, dados);

    const nomeArquivo = `RelatorioFiscal_${empresa.nome.replace(/[^a-zA-Z0-9]+/g, "_")}_${Date.now()}.pdf`;
    const arquivoGerado = new File([blob], nomeArquivo, { type: "application/pdf" });

    empresa.anexos = empresa.anexos || [];
    await anexarArquivoNaLista(empresa.anexos, arquivoGerado);

    empresa.comentarios = empresa.comentarios || [];
    empresa.comentarios.push(`Relatório Fiscal gerado a partir do Resumo\n${agora()}`);

    colComentarios?.atualizar();
    colAnexos?.atualizar();
    atualizarEmpresa(empresa);
    marcarAlterado();
    notificar("Relatório Fiscal gerado e anexado", "ok");
  } catch (err) {
    avisar("Erro ao gerar o Relatório Fiscal: " + err.message, { titulo: "Não deu certo", tipo: "erro" });
  } finally {
    if (inputEl) inputEl.value = "";
  }
}

// ---------------------------------------------------------------------------
// CHECKLIST (TAREFAS DO DIA) — cada tarefa se atualiza sozinha
// ---------------------------------------------------------------------------
function criarTarefaEl(item) {
  const div = document.createElement("div");
  div.className = "tarefa-item" + (item.concluido ? " feita" : "");
  div.innerHTML = `
    <div class="tarefa-topo">
      <input type="checkbox" class="check-redondo" ${item.concluido ? "checked" : ""} aria-label="Concluída">
      <span class="tarefa-texto">${escaparHtml(item.texto)}</span>
      <button type="button" class="btn-icone" title="Remover tarefa">${icone("x", "ico-sm")}</button>
    </div>
    <div class="tarefa-comentarios">
      <div class="tarefa-lista-coment">${(item.comentarios || []).map((c) => `<div class="comentario-linha">• ${escaparHtml(c)}</div>`).join("")}</div>
      <input placeholder="Comentar e apertar Enter..." maxlength="500">
    </div>`;
  div.querySelector(".check-redondo").addEventListener("change", (e) => {
    item.concluido = e.target.checked;
    div.classList.toggle("feita", item.concluido);
    marcarAlterado();
  });
  div.querySelector(".btn-icone").addEventListener("click", () => {
    const i = ESTADO.checklist.indexOf(item);
    if (i >= 0) ESTADO.checklist.splice(i, 1);
    marcarAlterado();
    renderizarChecklist();
  });
  const inp = div.querySelector(".tarefa-comentarios input");
  inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !inp.value.trim()) return;
    item.comentarios = item.comentarios || [];
    item.comentarios.push(inp.value.trim());
    div.querySelector(".tarefa-lista-coment").insertAdjacentHTML("beforeend", `<div class="comentario-linha">• ${escaparHtml(inp.value.trim())}</div>`);
    inp.value = "";
    marcarAlterado();
  });
  return div;
}

function renderizarChecklist() {
  const cont = $("#lista-checklist");
  if (!ESTADO.checklist.length) {
    cont.innerHTML = `<div class="vazio">${icone("tarefas", "ico-xl")}<p>Nenhuma tarefa para hoje.</p></div>`;
    return;
  }
  cont.replaceChildren(...ESTADO.checklist.map(criarTarefaEl));
}

// ---------------------------------------------------------------------------
// WHATSAPP — mesma mensagem do e-mail, com link para baixar os documentos
// ---------------------------------------------------------------------------
function enviarWhatsAppEmpresa(empresa) {
  if (!empresa.whatsapp) return notificar("Cadastre o WhatsApp do cliente nos dados da empresa.", "aviso");
  const competencia = competenciaMesAnterior();
  abrirEnvioWhatsApp({
    destino: empresa.nome,
    telefone: empresa.whatsapp,
    anexos: empresa.anexos || [],
    tituloLink: `${empresa.nome} — documentos do setor Fiscal, competência ${competencia}`,
    montarMensagem: (link, validade) =>
      `Olá, tudo bem?\n\nSegue os documentos do setor Fiscal referente à competência ${competencia}.\n\n` +
      `Para baixar os arquivos, acesse:\n${link}\n(link disponível até ${validade})\n\nAtenciosamente,\nFZ CONT`,
    aoEnviar: (telefone) => {
      empresa.status = "VERDE";
      empresa.comentarios = empresa.comentarios || [];
      empresa.comentarios.push(`Documentos enviados pelo WhatsApp para ${telefone} (competência ${competencia})\n${agora()}`);
      mudouStatus(empresa);
      const wrap = EL_EMPRESA.get(empresa.id);
      if (wrap && wrap.classList.contains("aberto")) { wrap.querySelector(".empresa-corpo")?.remove(); wrap.appendChild(criarCorpoEmpresa(empresa)); }
      notificar(`Envio registrado para ${empresa.nome}`, "ok");
    },
  });
}

// ---------------------------------------------------------------------------
// WHATSAPP EM LOTE — uma fila: o sistema prepara todos os links e mensagens, e
// cada clique em "Enviado, abrir o próximo" registra o envio e abre o próximo
// cliente já com a mensagem pronta (o WhatsApp exige apertar "enviar" em cada um).
// ---------------------------------------------------------------------------
const MODELO_WA_LOTE_PADRAO =
  "Olá, tudo bem?\n\nSegue os documentos do setor Fiscal referente à competência {competencia}.\n\n" +
  "Para baixar os arquivos, acesse:\n{link}\n(link disponível até {validade})\n\nAtenciosamente,\nFZ CONT";

function _isoLocal(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function _brDeIso(iso) { return iso.split("-").reverse().join("/"); }

function empresasParaWhatsApp() {
  const aptas = [], fora = [];
  ESTADO.grupos.forEach((g) => g.empresas.forEach((e) => {
    const numero = normalizarWhatsapp(e.whatsapp);
    if (!e.whatsapp) fora.push({ e, motivo: "sem WhatsApp cadastrado" });
    else if (!numero) fora.push({ e, motivo: "WhatsApp inválido" });
    else if (!(e.anexos || []).length) fora.push({ e, motivo: "sem documentos anexados" });
    else aptas.push({ e, numero, grupo: g.nome });
  }));
  return { aptas, fora };
}

$("#btn-whatsapp-lote")?.addEventListener("click", () => abrirWhatsAppLote());

function abrirWhatsAppLote() {
  const { aptas, fora } = empresasParaWhatsApp();
  const hoje = new Date();
  const dias = Math.min(Math.max(Number(_lerPref("fzcont_wa_dias", "7")) || 7, 0), 365);
  const padrao = new Date(hoje); padrao.setDate(padrao.getDate() + dias);
  const max = new Date(hoje); max.setDate(max.getDate() + 365);
  const modo = _lerPref("fzcont_wa_modo", "web");
  const modelo = _lerPref("fzcont_wa_modelo_lote", MODELO_WA_LOTE_PADRAO);

  abrirModal(`
    <h2>Enviar WhatsApp em lote</h2>
    <p class="modal-sub">Escolha as empresas. O sistema prepara os links e as mensagens de todas de uma vez; depois você só confirma o envio de cada uma no WhatsApp.</p>
    <div class="wl-topo">
      <span class="bloco-titulo">${icone("empresas", "ico-sm")}Empresas prontas para envio <span class="contador-pilula" id="wl-contador"></span></span>
      <span class="painel-acoes">
        <button type="button" class="btn-ghost btn-sm" id="wl-todas">${icone("check")}Todas</button>
        <button type="button" class="btn-ghost btn-sm" id="wl-pendentes">${icone("relogio")}Só as não enviadas</button>
        <button type="button" class="btn-ghost btn-sm" id="wl-nenhuma">${icone("x")}Nenhuma</button>
      </span>
    </div>
    <div class="wl-lista" id="wl-lista">
      ${aptas.length ? aptas.map(({ e, numero }, i) => `
        <label class="wl-item">
          <input type="checkbox" data-i="${i}" ${e.status === "VERDE" ? "" : "checked"}>
          <span class="wl-nome"><b>${escaparHtml(e.nome)}</b><small>${escaparHtml(formatarTelefone(numero))} · ${e.anexos.length} documento(s)</small></span>
          ${e.status === "VERDE" ? '<span class="etiqueta etiqueta-ok">Já está OK</span>' : ""}
        </label>`).join("") : `<div class="vazio">${icone("conversa", "ico-xl")}<p>Nenhuma empresa tem WhatsApp cadastrado e documentos anexados ao mesmo tempo.</p></div>`}
    </div>
    ${fora.length ? `<details class="wl-fora"><summary>${fora.length} empresa(s) fora do lote</summary>
      ${fora.map(({ e, motivo }) => `<div class="wl-fora-item"><span>${escaparHtml(e.nome)}</span><small>${motivo}</small></div>`).join("")}</details>` : ""}
    <div class="linha-dois-campos" style="margin-top:14px">
      <div class="campo-form"><label>Arquivos disponíveis até</label>
        <input type="date" id="wl-ate" value="${_isoLocal(padrao)}" min="${_isoLocal(hoje)}" max="${_isoLocal(max)}">
      </div>
      <div class="campo-form"><label>Abrir no</label>
        <select id="wl-modo">
          <option value="app"${modo === "app" ? " selected" : ""}>Aplicativo do computador (mais rápido)</option>
          <option value="web"${modo === "web" ? " selected" : ""}>WhatsApp Web (navegador)</option>
        </select>
      </div>
    </div>
    <div class="campo-form"><label>Mensagem <small class="wl-marcadores">use {empresa}, {competencia}, {link} e {validade}</small></label>
      <textarea id="wl-modelo" rows="7">${escaparHtml(modelo)}</textarea>
    </div>
    <label class="chip-check azul"><input type="checkbox" id="wl-registrar" checked><span class="caixa">${icone("check")}</span>Ao confirmar cada envio, marcar a empresa como OK e anotar nos comentários</label>
    <div class="modal-rodape">
      <button type="button" class="btn-ghost" id="wl-cancelar">Cancelar</button>
      <button type="button" class="btn-primario btn-whatsapp" id="wl-preparar">${icone("conversa")}<span>Preparar envios</span></button>
    </div>`);

  const caixas = () => $$("#wl-lista input[type=checkbox]");
  const atualizarContador = () => {
    const n = caixas().filter((c) => c.checked).length;
    $("#wl-contador").textContent = `${n} de ${aptas.length}`;
    $("#wl-preparar span").textContent = n ? `Preparar ${n} envio${n > 1 ? "s" : ""}` : "Preparar envios";
    $("#wl-preparar").disabled = !n;
  };
  $("#wl-lista").addEventListener("change", atualizarContador);
  $("#wl-todas").addEventListener("click", () => { caixas().forEach((c) => (c.checked = true)); atualizarContador(); });
  $("#wl-nenhuma").addEventListener("click", () => { caixas().forEach((c) => (c.checked = false)); atualizarContador(); });
  $("#wl-pendentes").addEventListener("click", () => { caixas().forEach((c) => (c.checked = aptas[+c.dataset.i].e.status !== "VERDE")); atualizarContador(); });
  $("#wl-cancelar").addEventListener("click", fecharModal);
  atualizarContador();

  $("#wl-preparar").addEventListener("click", (ev) => comCarregando(ev.currentTarget, async () => {
    const selecionadas = caixas().filter((c) => c.checked).map((c) => aptas[+c.dataset.i]);
    const ate = $("#wl-ate").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ate) || ate < _isoLocal(hoje)) return notificar("Escolha uma data de validade de hoje em diante.", "aviso");
    const textoModelo = $("#wl-modelo").value;
    if (!textoModelo.includes("{link}")) {
      const ok = await confirmar("A mensagem não tem {link} — o cliente não vai receber o link para baixar os documentos. Continuar mesmo assim?", { titulo: "Mensagem sem link", textoOk: "Continuar" });
      if (!ok) return;
    }
    const modoEscolhido = $("#wl-modo").value;
    const registrar = $("#wl-registrar").checked;
    _gravarPref("fzcont_wa_modo", modoEscolhido);
    _gravarPref("fzcont_wa_modelo_lote", textoModelo);
    const [a, m, d] = ate.split("-").map(Number);
    _gravarPref("fzcont_wa_dias", String(Math.round((new Date(a, m - 1, d) - new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) / 86400000)));
    const competencia = competenciaMesAnterior();
    try {
      const r = await api("/api/compartilhar-lote", {
        method: "POST",
        body: JSON.stringify({
          ate,
          itens: selecionadas.map(({ e }) => ({ chave: e.id, anexoIds: e.anexos.map((x) => x.id), titulo: `${e.nome} — documentos do setor Fiscal, competência ${competencia}` })),
        }),
      });
      const porChave = new Map(r.resultados.map((x) => [x.chave, x]));
      const fila = selecionadas.map(({ e, numero }) => {
        const res = porChave.get(e.id) || { erro: "Sem resposta do servidor." };
        const mensagem = res.url
          ? textoModelo.split("{empresa}").join(e.nome).split("{competencia}").join(competencia).split("{link}").join(res.url).split("{validade}").join(_brDeIso(ate))
          : "";
        return { e, numero, url: res.url, erro: res.erro, mensagem, estado: res.url ? "fila" : "erro" };
      });
      mostrarFilaWhatsApp(fila, { modo: modoEscolhido, registrar, competencia });
    } catch (err) {
      notificar("Erro ao preparar os envios: " + err.message, "erro");
    }
  }));
}

function mostrarFilaWhatsApp(fila, { modo, registrar, competencia }) {
  const ROTULO = { fila: ["Na fila", "neutra"], aberto: ["Aberto no WhatsApp", "info"], enviado: ["Enviado", "ok"], pulado: ["Pulado", "aviso"], erro: ["Erro", "erro"] };
  let atual = -1; // índice da conversa aberta agora

  abrirModal(`
    <h2>Fila de envio pelo WhatsApp</h2>
    <p class="modal-sub">${modo === "app" ? "Cada conversa abre no aplicativo do WhatsApp" : "Cada conversa abre na mesma aba do WhatsApp Web"}. Lá, aperte <b>Enter</b> para enviar e volte aqui.</p>
    <div class="wl-painel" id="wl-painel"></div>
    <div class="ic-progresso" style="margin:12px 0">
      <span id="wl-prog-texto"></span>
      <div class="ic-progresso-barra"><span id="wl-prog-barra"></span></div>
    </div>
    <div class="wl-lista wl-fila" id="wl-fila"></div>
    <div class="modal-rodape"><button type="button" class="btn-ghost" id="wl-fechar">Fechar</button></div>`);

  const proximoIndice = (depois) => fila.findIndex((x, i) => i > depois && x.estado === "fila");

  function abrir(i) {
    const item = fila[i];
    const texto = encodeURIComponent(item.mensagem);
    if (modo === "app") window.location.href = `whatsapp://send?phone=${item.numero}&text=${texto}`;
    else window.open(`https://web.whatsapp.com/send?phone=${item.numero}&text=${texto}`, "fzcont_whatsapp");
    item.estado = "aberto";
    atual = i;
  }

  function registrarEnvio(item) {
    item.estado = "enviado";
    if (!registrar) return;
    const e = item.e;
    e.status = "VERDE";
    e.comentarios = e.comentarios || [];
    e.comentarios.push(`Documentos enviados pelo WhatsApp para ${formatarTelefone(item.numero)} (competência ${competencia})\n${agora()}`);
    mudouStatus(e);
    const wrap = EL_EMPRESA.get(e.id);
    if (wrap && wrap.classList.contains("aberto")) { wrap.querySelector(".empresa-corpo")?.remove(); wrap.appendChild(criarCorpoEmpresa(e)); }
  }

  function desenhar() {
    const total = fila.length;
    const enviados = fila.filter((x) => x.estado === "enviado").length;
    const resolvidos = fila.filter((x) => x.estado !== "fila" && x.estado !== "aberto").length;
    $("#wl-prog-texto").textContent = `${enviados} enviado(s) de ${total}` + (fila.some((x) => x.estado === "pulado") ? ` · ${fila.filter((x) => x.estado === "pulado").length} pulado(s)` : "") + (fila.some((x) => x.estado === "erro") ? ` · ${fila.filter((x) => x.estado === "erro").length} com erro` : "");
    $("#wl-prog-barra").style.transform = `scaleX(${total ? resolvidos / total : 0})`;

    const painel = $("#wl-painel");
    const prox = proximoIndice(atual);
    const corrente = atual >= 0 && fila[atual].estado === "aberto" ? fila[atual] : null;
    if (corrente) {
      const seguinte = proximoIndice(atual);
      painel.innerHTML = `
        <div class="wl-agora"><small>Conversa aberta</small><b>${escaparHtml(corrente.e.nome)}</b><span>${escaparHtml(formatarTelefone(corrente.numero))}</span></div>
        <div class="wl-botoes">
          <button type="button" class="btn-primario btn-whatsapp btn-grande" id="wl-enviado">${icone("check")}<span>${seguinte >= 0 ? "Enviado, abrir o próximo" : "Enviado, concluir"}</span></button>
          <button type="button" class="btn-secundario" id="wl-reabrir">${icone("atualizar")}Abrir de novo</button>
          <button type="button" class="btn-ghost" id="wl-pular">${icone("seta")}Pular</button>
        </div>
        ${seguinte >= 0 ? `<div class="wl-seguinte">Próximo: ${escaparHtml(fila[seguinte].e.nome)}</div>` : ""}`;
    } else if (prox >= 0) {
      painel.innerHTML = `
        <div class="wl-agora"><small>${resolvidos ? "Continuar" : "Pronto para começar"}</small><b>${escaparHtml(fila[prox].e.nome)}</b><span>${escaparHtml(formatarTelefone(fila[prox].numero))}</span></div>
        <div class="wl-botoes"><button type="button" class="btn-primario btn-whatsapp btn-grande" id="wl-comecar">${icone("conversa")}<span>Abrir no WhatsApp</span></button></div>`;
    } else {
      painel.innerHTML = `<div class="wl-fim">${icone("ok")}<span><b>Fila concluída</b><small>${enviados} envio(s) registrado(s).${registrar && enviados ? " Clique em Salvar para gravar os status e comentários." : ""}</small></span></div>`;
    }

    $("#wl-fila").innerHTML = fila.map((x, i) => `
      <div class="wl-item ${i === atual && x.estado === "aberto" ? "wl-ativo" : ""}">
        <span class="wl-num">${i + 1}</span>
        <span class="wl-nome"><b>${escaparHtml(x.e.nome)}</b><small>${escaparHtml(formatarTelefone(x.numero))}${x.erro ? " · " + escaparHtml(x.erro) : ""}</small></span>
        <span class="etiqueta etiqueta-${ROTULO[x.estado][1]}">${ROTULO[x.estado][0]}</span>
        ${x.url && x.estado !== "aberto" ? `<button type="button" class="btn-icone neutro" data-abrir="${i}" title="Abrir esta conversa agora">${icone("conversa")}</button>` : '<span style="width:30px"></span>'}
      </div>`).join("");
  }

  $("#wl-painel").addEventListener("click", (e) => {
    const id = e.target.closest("button")?.id;
    if (id === "wl-comecar") { abrir(proximoIndice(atual)); desenhar(); }
    else if (id === "wl-enviado" || id === "wl-pular") {
      const item = fila[atual];
      if (id === "wl-enviado") registrarEnvio(item); else item.estado = "pulado";
      const prox = proximoIndice(atual);
      if (prox >= 0) abrir(prox); // abre na hora, no mesmo clique (o navegador não bloqueia)
      desenhar();
      if (prox < 0) notificar("Fila concluída", "ok");
    } else if (id === "wl-reabrir") { abrir(atual); desenhar(); }
  });
  $("#wl-fila").addEventListener("click", (e) => {
    const b = e.target.closest("[data-abrir]");
    if (!b) return;
    if (atual >= 0 && fila[atual].estado === "aberto") fila[atual].estado = "fila"; // volta pra fila sem marcar
    abrir(+b.dataset.abrir);
    desenhar();
  });
  $("#wl-fechar").addEventListener("click", fecharModal);
  desenhar();
}

$("#btn-nova-tarefa").addEventListener("click", async () => {
  const texto = await perguntar("Nova tarefa", { placeholder: "Descreva a tarefa", textoOk: "Adicionar" });
  if (!texto || !texto.trim()) return;
  ESTADO.checklist.push({ texto: texto.trim(), concluido: false, comentarios: [] });
  marcarAlterado();
  renderizarChecklist();
});

// ---------------------------------------------------------------------------
// E-MAIL (igual ao "enviarEmailComAnexos" do app original: assunto e corpo
// automáticos com a competência do mês anterior, exige e-mail e anexo, e
// marca a empresa como VERDE ao enviar com sucesso)
// ---------------------------------------------------------------------------
async function enviarEmailEmpresaOriginal(empresa, botao) {
  if (!empresa.email) return notificar("Esta empresa não possui um e-mail cadastrado.", "aviso");
  if (!empresa.anexos || empresa.anexos.length === 0) return notificar("A empresa não possui arquivos anexados para enviar.", "aviso");

  const hoje = new Date();
  const mesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  const competencia = `${String(mesAnterior.getMonth() + 1).padStart(2, "0")}/${mesAnterior.getFullYear()}`;
  const assunto = `Documentos Setor Fiscal - Competência ${competencia}`;
  const mensagem = `Olá, tudo bem?\n\nSegue em anexo os documentos do setor Fiscal referente à competência ${competencia}.\n\nAtenciosamente,\nFZ CONT`;

  await comCarregando(botao, async () => {
    notificar(`Enviando e-mail para ${empresa.nome}...`, "carregando");
    try {
      await enviarEmailBruto({ destinatario: empresa.email, assunto, mensagem, anexoIds: empresa.anexos.map((a) => a.id) });
      empresa.status = "VERDE";
      mudouStatus(empresa);
      notificar(`E-mail enviado para ${empresa.nome}`, "ok");
    } catch (err) {
      avisar("Erro ao enviar e-mail: " + err.message, { titulo: "E-mail não enviado", tipo: "erro" });
    }
  });
}

// ---------------------------------------------------------------------------
// IMPORTAR PDFs EM LOTE (igual ao "processarPdfDas" do app original):
// lê o texto de cada PDF, acha o CNPJ, identifica a empresa correspondente,
// anexa o arquivo e registra um comentário com competência/valor encontrados.
// ---------------------------------------------------------------------------
$("#btn-importar-pdfs")?.addEventListener("click", () => $("#input-importar-pdfs").click());
$("#input-importar-pdfs")?.addEventListener("change", async (e) => {
  const arquivos = [...e.target.files];
  e.target.value = "";
  if (!arquivos.length) return;

  let vinculados = 0, jaExistiam = 0, semCnpj = 0, semEmpresa = 0, comErro = 0;
  await comCarregando($("#btn-importar-pdfs"), async () => {
    for (const [i, arquivo] of arquivos.entries()) {
      notificar(`Analisando PDF ${i + 1} de ${arquivos.length}...`, "carregando");
      try {
        const texto = await extrairTextoPdf(arquivo);
        if (!texto.trim()) { comErro++; continue; }
        const cnpjEncontrado = extrairCnpjDoTexto(texto);
        if (!cnpjEncontrado) { semCnpj++; continue; }
        const empresa = buscarEmpresaPorCnpj(cnpjEncontrado);
        if (!empresa) { semEmpresa++; continue; }

        empresa.anexos = empresa.anexos || [];
        const resp = await anexarArquivoNaLista(empresa.anexos, arquivo);
        if (!resp) { jaExistiam++; continue; }

        const competencia = extrairCompetenciaDoTexto(texto);
        const valor = extrairValorDoTexto(texto);
        let comentario = "Guia DAS Simples Nacional processada via PDF.";
        if (competencia) comentario += `\nCompetência: ${competencia}`;
        if (valor) comentario += `\nValor Total: R$ ${valor}`;
        empresa.comentarios.push(`${comentario}\n${agora()}`);
        vinculados++;
      } catch (err) {
        console.error("Erro ao processar PDF", arquivo.name, err);
        comErro++;
      }
    }
  });

  if (vinculados) marcarAlterado();
  renderizarGrupos();
  renderizarDashboard();

  const linhas = [`${vinculados} arquivo(s) vinculado(s) às empresas.`];
  if (jaExistiam) linhas.push(`${jaExistiam} já estavam anexados (ignorados).`);
  if (semCnpj) linhas.push(`${semCnpj} sem CNPJ localizado no PDF.`);
  if (semEmpresa) linhas.push(`${semEmpresa} sem empresa cadastrada com esse CNPJ.`);
  if (comErro) linhas.push(`${comErro} com erro de leitura.`);
  if (vinculados) linhas.push("\nClique em Salvar para gravar os comentários e anexos.");
  notificar(`Lote processado: ${vinculados} vinculado(s)`, vinculados ? "ok" : "aviso");
  avisar(linhas.join("\n"), { titulo: "Importação concluída", tipo: vinculados ? "ok" : "aviso" });
});

// Busca com atraso curto — não redesenha a cada tecla.
$("#busca")?.addEventListener("input", atrasar((e) => {
  filtroAtual = e.target.value.trim().toLowerCase();
  renderizarGrupos();
}, 150));

iniciarPagina();
