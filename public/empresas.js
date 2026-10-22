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
let filtroStatus = "";               // "" | "VERMELHO" | "ATENÇÃO" | "SEM_MOVIMENTO" | "fechado" (abas Todas/Pendentes/Atenção/Fechadas)
const SELECIONADAS = new Set();      // ids marcados para ação em lote

function renderizarPagina() {
  renderizarDashboard();
  renderizarGrupos();
  renderizarChecklist();
  atualizarRotuloMes();
  atualizarBarraSelecao();
}

function grupoDaEmpresa(empresa) {
  return ESTADO.grupos.find((g) => g.empresas.includes(empresa));
}

// ---------------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------------
// Indicadores: na primeira vez os números contam a partir do zero e as barras crescem;
// depois, cada mudança só atualiza o que mudou (o número "anda" até o valor novo) — nada é redesenhado.
const _semMovimento = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function _contar(el, de, para, ms = 650) {
  if (de === para || _semMovimento()) { el.textContent = para; return; }
  const t0 = performance.now();
  const passo = (t) => {
    const k = Math.min(1, (t - t0) / ms), suave = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(de + (para - de) * suave);
    if (k < 1) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}
function renderizarDashboard() {
  const cont = $("#dashboard");
  const todas = ESTADO.grupos.flatMap((g) => g.empresas);
  const total = todas.length;
  const fechadas = todas.filter((e) => e.fechado).length;
  const atencao = todas.filter((e) => e.status === "ATENÇÃO").length;
  const pendentes = todas.filter((e) => e.status === "VERMELHO").length;
  // grupo com mais empresas pedindo atenção
  const grupoAtencao = ESTADO.grupos.map((g) => [g.nome, g.empresas.filter((e) => e.status === "ATENÇÃO").length]).sort((a, b) => b[1] - a[1])[0];
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const dados = [
    { tom: "cobre", ic: "empresas", nome: "Empresas ativas", num: total, barra: 100, sub: `${ESTADO.grupos.length} grupo${ESTADO.grupos.length === 1 ? "" : "s"}` },
    { tom: "ok", ic: "check", nome: "Fechadas no mês", num: fechadas, barra: pct(fechadas), sub: `${pct(fechadas)}% do mês`, anel: true },
    { tom: "atencao", ic: "alerta", nome: "Requer atenção", num: atencao, barra: pct(atencao), sub: atencao && grupoAtencao ? escaparHtml(grupoAtencao[0]) : "nenhuma" },
    { tom: "erro", ic: "relogio", nome: "Pendentes", num: pendentes, barra: pct(pendentes), sub: "DAS vence dia 20" },
  ];
  const largura = (b) => Math.max(b, b ? 3 : 0) + "%";
  if (!cont.querySelector(".kpi2")) {
    // primeira vez: monta zerado e anima até os valores
    cont.innerHTML = dados.map((d) => `
      <div class="kpi2 kpi2-${d.tom}${d.anel ? " kpi2-com-anel" : ""}">
        ${d.anel
          ? `<span class="kpi2-icone kpi2-anel" title="${d.barra}% fechadas"><svg viewBox="0 0 44 44" aria-hidden="true"><circle class="anel-fundo" cx="22" cy="22" r="18"/><circle class="anel-valor" cx="22" cy="22" r="18" pathLength="100" style="stroke-dasharray:0 100"/></svg>${icone("check")}</span>`
          : `<span class="kpi2-icone">${icone(d.ic)}</span>`}
        <div class="kpi2-txt">
          <div class="kpi2-linha"><span class="kpi2-nome">${d.nome}</span><span class="kpi2-barra"><i style="width:0%"></i></span></div>
          <div class="kpi2-linha"><b class="kpi2-num">0</b><small>${d.sub}</small></div>
        </div>
      </div>`).join("");
    cont.getBoundingClientRect(); // aplica o "zero" antes de animar
  }
  [...cont.querySelectorAll(".kpi2")].forEach((el, i) => {
    const d = dados[i];
    const num = el.querySelector(".kpi2-num");
    _contar(num, Number(num.textContent) || 0, d.num);
    el.querySelector(".kpi2-barra i").style.width = largura(d.barra);
    el.querySelector("small").innerHTML = d.sub;
    const anel = el.querySelector(".anel-valor");
    if (anel) { anel.style.strokeDasharray = `${d.barra} 100`; el.querySelector(".kpi2-anel").title = `${d.barra}% fechadas`; el.classList.toggle("completo", d.barra === 100 && total > 0); }
  });
  const nav = $("#nav-cont-empresas");
  if (nav) nav.textContent = total || "";
  renderizarCardsGrupos();
}

// Um cartão por grupo: quantas empresas, quantas já fechadas no mês e a
// distribuição de status. Atualiza no lugar (sem piscar); clicar abre o grupo.
function renderizarCardsGrupos() {
  const cont = $("#dashboard-grupos");
  if (!cont) return;
  // grupos sem nenhuma empresa não ganham cartão
  const grupos = ESTADO.grupos.filter((g) => g.empresas.length);
  const chave = grupos.map((g) => g.nome + "\u0002" + ESTADO.grupos.indexOf(g)).join("\u0001");
  if (cont.dataset.chave !== chave) {
    const primeira = !cont.dataset.chave;
    cont.dataset.chave = chave;
    cont.innerHTML = grupos.map((g, i) => `
      <button type="button" class="grupo-kpi${primeira ? " entrando" : ""}" data-grupo-idx="${ESTADO.grupos.indexOf(g)}" style="--i:${i}" title="Abrir o grupo ${escaparHtml(g.nome)}">
        <span class="gk-topo"><span class="gk-ic">${icone("pasta")}</span><span class="gk-id"><span class="gk-nome">${escaparHtml(g.nome)}</span><span class="gk-total"><b>0</b> <small>empresas</small></span></span></span>
        <span class="gk-fech"><span>Fechadas <b class="gk-fech-n">0</b><small class="gk-fech-de"></small></span><span class="gk-pct">0%</span><span class="gk-selo">${icone("check")}Tudo fechado</span></span>
        <span class="gk-prog"><i style="width:0%"></i></span>
        <span class="gk-status"><span class="kpi-barra"></span><span class="gk-legenda"></span></span>
      </button>`).join("");
    cont.getBoundingClientRect();
  }
  cont.hidden = !grupos.length;
  [...cont.querySelectorAll(".grupo-kpi")].forEach((el, i) => {
    const g = grupos[i];
    const total = g.empresas.length;
    const fechadas = g.empresas.filter((e) => e.fechado).length;
    const { verde, vermelho, atencao, semMov } = contarStatus(g.empresas, "status");
    const sem = Math.max(total - verde - atencao - vermelho, 0);
    const pct = total ? Math.round((fechadas / total) * 100) : 0;
    const totalEl = el.querySelector(".gk-total b");
    _contar(totalEl, Number(totalEl.textContent) || 0, total);
    el.querySelector(".gk-total small").textContent = total === 1 ? "empresa" : "empresas";
    const fn = el.querySelector(".gk-fech-n");
    _contar(fn, Number(fn.textContent) || 0, fechadas);
    el.querySelector(".gk-fech-de").textContent = ` de ${total}`;
    el.querySelector(".gk-pct").textContent = `${pct}%`;
    el.querySelector(".gk-prog i").style.width = `${pct}%`;
    el.classList.toggle("completo", total > 0 && fechadas === total);
    const seg = (classe, n) => (n ? `<span class="${classe}" style="flex-grow:${n}"></span>` : "");
    const barra = el.querySelector(".kpi-barra");
    barra.title = `${verde} OK · ${atencao} atenção · ${vermelho} pendente · ${semMov} sem movimento · ${sem} sem status`;
    barra.innerHTML = `${seg("b-ok", verde)}${seg("b-atencao", atencao)}${seg("b-erro", vermelho)}${seg("b-sem", sem)}${total ? "" : '<span class="b-sem" style="flex-grow:1"></span>'}`;
    el.querySelector(".gk-legenda").innerHTML =
      `<span class="ok" title="OK">${icone("check")}${verde}</span><span class="atencao" title="Atenção">${icone("alerta")}${atencao}</span><span class="erro" title="Pendente">${icone("x")}${vermelho}</span>${semMov ? `<span class="semmov" title="Sem movimento">${icone("proibido")}${semMov}</span>` : ""}`;
  });
}
$("#dashboard-grupos")?.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-grupo-idx]");
  if (!b) return;
  const grupo = ESTADO.grupos[Number(b.dataset.grupoIdx)];
  if (!grupo) return;
  if (!GRUPOS_ABERTOS.has(grupo)) { GRUPOS_ABERTOS.add(grupo); redesenharGrupo(grupo); }
  const card = EL_GRUPO.get(grupo);
  if (card) {
    // os cartões de empresa usam content-visibility: o tamanho real só aparece
    // quando entram na tela, então confere a posição e corrige se preciso
    const ir = () => card.scrollIntoView({ behavior: _semMovimento() ? "auto" : "smooth", block: "start" });
    ir();
    let tentativas = 0;
    const conferir = () => {
      const topo = card.getBoundingClientRect().top;
      const alvo = parseFloat(getComputedStyle(card).scrollMarginTop) || 0;
      const noFim = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
      if (Math.abs(topo - alvo) > 12 && !noFim && tentativas++ < 3) { ir(); setTimeout(conferir, 450); }
    };
    setTimeout(conferir, 500);
    card.classList.remove("destacado"); card.getBoundingClientRect(); card.classList.add("destacado");
    setTimeout(() => card.classList.remove("destacado"), 1600);
  } else notificar("Esse grupo não aparece com o filtro atual.", "info");
});

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
  if (filtroStatus === "fechado" ? !e.fechado : filtroStatus === "SEM_MOVIMENTO" ? !e.semMovimento : filtroStatus && e.status !== filtroStatus) return false;
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
    const nomeAba = { VERMELHO: "pendente", "ATENÇÃO": "em atenção", SEM_MOVIMENTO: "sem movimento", fechado: "fechada" }[filtroStatus];
    cont.innerHTML = filtroAtual || filtroStatus
      ? `<div class="vazio">${icone("busca", "ico-xl")}<strong>Nada encontrado</strong><p>${filtroAtual ? `Nenhuma empresa${nomeAba ? " " + nomeAba : ""} com “${escaparHtml(filtroAtual)}” no nome ou CNPJ.` : `Nenhuma empresa ${nomeAba} no momento.`}</p></div>`
      : `<div class="vazio">${icone("camadas", "ico-xl")}<strong>Nenhum grupo ainda</strong><p>Crie um grupo (ex.: Simples Nacional, Lucro Presumido) e adicione as empresas dentro dele.</p></div>`;
  }
}

function htmlCabecalhoGrupo(grupo, aberto) {
  const { verde, vermelho, atencao, semMov } = contarStatus(grupo.empresas, "status");
  const total = grupo.empresas.length;
  const sem = Math.max(total - verde - vermelho - atencao, 0);
  const seg = (cls, n) => (n ? `<i class="${cls}" style="flex-grow:${n}"></i>` : "");
  return `
    ${icone("seta", "chevron")}
    <h3>${escaparHtml(grupo.nome)}</h3>
    <span class="pilula-qtd">${total} empresa${total === 1 ? "" : "s"}</span>
    <span class="grupo-contagens">
      ${verde ? `<span class="cont cont-ok" title="OK">${verde} OK</span>` : ""}
      ${atencao ? `<span class="cont cont-atencao" title="Atenção">${atencao} atenção</span>` : ""}
      ${vermelho ? `<span class="cont cont-erro" title="Pendente">${vermelho} pend.</span>` : ""}
      ${semMov ? `<span class="cont cont-semmov" title="Sem movimento">${semMov} s/ mov.</span>` : ""}
    </span>
    <span class="grupo-barra" title="${verde} OK · ${atencao} atenção · ${vermelho} pendente · ${semMov} sem movimento · ${sem} sem status">${seg("b-ok", verde)}${seg("b-atencao", atencao)}${seg("b-erro", vermelho)}${seg("b-sem", sem)}${total ? "" : '<i class="b-sem" style="flex-grow:1"></i>'}</span>
    <button type="button" class="btn-icone neutro" data-grupo-menu title="Opções do grupo" aria-label="Opções do grupo">${icone("maisOpcoes")}</button>`;
}

function criarGrupoCard(grupo) {
  const visiveis = grupo.empresas.filter(empresaPassaFiltro);
  const filtrando = !!(filtroAtual || filtroStatus);
  if (filtrando && visiveis.length === 0) return null;
  const aberto = GRUPOS_ABERTOS.has(grupo) || filtrando;

  const card = document.createElement("div");
  card.className = "grupo-card" + (aberto ? " aberto" : "");
  const cab = document.createElement("div");
  cab.className = "grupo-cabecalho";
  cab.setAttribute("role", "button");
  cab.tabIndex = 0;
  cab.setAttribute("aria-expanded", aberto);
  cab.innerHTML = htmlCabecalhoGrupo(grupo, aberto);
  const alternar = () => alternarGrupo(grupo);
  cab.addEventListener("click", (e) => {
    const menu = e.target.closest("[data-grupo-menu]");
    if (menu) return abrirMenuAcoes(menu, grupo.nome, [
      { ic: "mais", rotulo: "Adicionar empresa", acao: () => abrirFormNovaEmpresa(grupo) },
      { ic: "documento", rotulo: "Renomear grupo", acao: () => renomearGrupo(grupo) },
      { ic: "lixeira", rotulo: "Excluir grupo", perigo: true, acao: () => excluirGrupo(grupo) },
    ]);
    alternar();
  });
  cab.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alternar(); } });
  card.appendChild(cab);
  if (aberto) card.appendChild(criarCorpoGrupo(grupo, visiveis, false));
  EL_GRUPO.set(grupo, card);
  return card;
}

function criarCorpoGrupo(grupo, visiveis, animar) {
  const corpo = document.createElement("div");
  corpo.className = "grupo-corpo" + (animar ? " anim-surgir" : "");
  const lista = document.createElement("div");
  lista.className = "lista-empresas";
  visiveis.forEach((empresa) => lista.appendChild(criarEmpresaCard(empresa)));
  if (!visiveis.length) {
    lista.innerHTML = `<div class="vazio-mini">Nenhuma empresa neste grupo ainda. <button type="button" class="btn-ghost btn-sm">${icone("mais")}Adicionar empresa</button></div>`;
    lista.querySelector("button").addEventListener("click", () => abrirFormNovaEmpresa(grupo));
  }
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

function abrirFormNovaEmpresa(grupo = null) {
  if (!grupo && !ESTADO.grupos.length) return notificar("Crie um grupo primeiro (botão “+ Grupo”).", "aviso");
  abrirModal(`
    <h2>Nova empresa</h2>
    <p class="modal-sub">${grupo ? `Grupo: <b>${escaparHtml(grupo.nome)}</b>. ` : ""}Os demais dados podem ser preenchidos depois, abrindo a empresa.</p>
    <form id="form-nova-empresa">
      ${grupo ? "" : `<div class="campo-form"><label>Grupo</label><select id="ne-grupo">${ESTADO.grupos.map((g, i) => `<option value="${i}">${escaparHtml(g.nome)}</option>`).join("")}</select></div>`}
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
    if (!grupo) grupo = ESTADO.grupos[+$("#ne-grupo").value];
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

const ROTULO_STATUS = { VERDE: ["ok", "OK"], VERMELHO: ["erro", "Pendente"], "ATENÇÃO": ["atencao", "Atenção"] };

function htmlCabecalhoEmpresa(empresa) {
  const st = ROTULO_STATUS[empresa.status];
  const das = empresa.das && empresa.das.valor ? `<span class="empresa-das" title="${escaparHtml(`Guia DAS ${empresa.das.competencia || ""} · processada em ${empresa.das.em || ""}`)}">DAS R$ ${escaparHtml(empresa.das.valor)}</span>` : `<span class="empresa-das vazio-das"></span>`;
  return `
    <button type="button" class="empresa-alca" data-alca title="Arraste para mudar a ordem (ou use as setas ↑ ↓)" aria-label="Mudar a ordem de ${escaparHtml(empresa.nome)}">${icone("alca")}</button>
    <label class="empresa-sel" title="Selecionar para ação em lote"><input type="checkbox" data-sel ${SELECIONADAS.has(empresa.id) ? "checked" : ""} aria-label="Selecionar ${escaparHtml(empresa.nome)}"></label>
    ${icone("seta", "chevron")}
    <div class="empresa-nome-wrap">
      <span class="empresa-nome"><span class="texto">${escaparHtml(empresa.nome)}</span></span>
      <span class="empresa-doc">${escaparHtml(formatarDocumento(empresa.cnpj || empresa.cpf) || "sem CNPJ")}</span>
    </div>
    <div class="selos-linha">${htmlSelosEmpresa(empresa)}</div>
    <div class="empresa-situacao">
      ${st ? `<span class="selo-st selo-st-${st[0]}">${st[1]}</span>` : ""}
      ${empresa.semMovimento ? `<span class="selo-st selo-st-semmov" title="Sem movimento">Sem mov.</span>` : ""}
      ${empresa.fechado ? `<span class="selo-fechado">${icone("cadeado")}Fechado</span>` : ""}
    </div>
    ${das}
    <div class="empresa-acoes">
      <button type="button" class="btn-icone neutro${empresa.whatsapp ? "" : " desligado"}" data-whatsapp title="${empresa.whatsapp ? `WhatsApp para ${escaparHtml(empresa.whatsapp)}` : "Cadastre o WhatsApp do cliente"}" aria-label="WhatsApp">${icone("conversa")}</button>
      <button type="button" class="btn-icone neutro" data-copiar-menu title="Copiar CNPJ, CPF, inscrições e senhas" aria-label="Copiar dados">${icone("copiar")}</button>
      <button type="button" class="btn-icone neutro" data-mais title="Mais ações" aria-label="Mais ações">${icone("maisOpcoes")}</button>
    </div>`;
}

function htmlSelosEmpresa(empresa) {
  return [
    empresa.anexos.length ? `<span class="selo selo-anexado" title="${empresa.anexos.length} documento(s)">Anexado${empresa.anexos.length > 1 ? " · " + empresa.anexos.length : ""}</span>` : "",
    empresa.nfs ? '<span class="selo selo-tag">NFS</span>' : "",
    empresa.nfe ? '<span class="selo selo-tag">NFE</span>' : "",
    empresa.nfc ? '<span class="selo selo-tag">NFC</span>' : "",
  ].join("");
}

// Tudo que dá para copiar da empresa (o botão de copiar da linha abre esta lista)
function itensCopiaEmpresa(e) {
  const itens = [];
  const add = (titulo, valor, oculto = false) => { if (valor) itens.push({ titulo, valor, mostrar: oculto ? "••••••••" : valor }); };
  add("CNPJ", e.cnpj);
  sociosDe(e).filter((s) => s.cpf).forEach((s, i, l) => add(l.length > 1 ? `CPF · ${s.nome || "Sócio " + (i + 1)}` : `CPF${s.nome ? " · " + s.nome : ""}`, s.cpf));
  add("Inscrição Estadual", e.inscricaoEstadual);
  add("Inscrição Municipal", e.cadastroMunicipal);
  add("Login prefeitura", e.loginPrefeitura);
  add("Senha Prefeitura", e.senhaPrefeitura, true);
  add("Senha Regularize", e.senhaRegularize, true);
  add("E-mail", e.email);
  add("WhatsApp", e.whatsapp);
  return itens;
}

function criarEmpresaCard(empresa) {
  const aberto = EMPRESAS_ABERTAS.has(empresa.id);
  const wrap = document.createElement("div");
  wrap.className = `empresa-card ${classeStatus(empresa.status)}${empresa.semMovimento ? " SEM_MOV" : ""}${aberto ? " aberto" : ""}${SELECIONADAS.has(empresa.id) ? " selecionada" : ""}`;
  wrap.dataset.id = empresa.id;

  const header = document.createElement("div");
  header.className = "empresa-header";
  header.setAttribute("role", "button");
  header.tabIndex = 0;
  header.setAttribute("aria-expanded", aberto);
  header.innerHTML = htmlCabecalhoEmpresa(empresa);
  // Um único listener por cabeçalho (delegação) — sobrevive às atualizações do innerHTML.
  header.addEventListener("click", (e) => {
    if (e.target.closest(".empresa-sel") || e.target.closest("[data-alca]")) return; // caixinha e alça têm comportamento próprio
    const copia = e.target.closest("[data-copiar]");
    if (copia) return copiarCampoEmpresa(empresa, copia.dataset.copiar, copia);
    const menuCopia = e.target.closest("[data-copiar-menu]");
    if (menuCopia) {
      const itens = itensCopiaEmpresa(empresa);
      if (!itens.length) return notificar("Essa empresa ainda não tem dados para copiar.", "aviso");
      return abrirMenuCopia(menuCopia, "Copiar", itens, "");
    }
    if (e.target.closest("[data-whatsapp]")) return enviarWhatsAppEmpresa(empresa);
    const mais = e.target.closest("[data-mais]");
    if (mais) return abrirMenuAcoes(mais, empresa.nome, [
      { ic: "email", rotulo: empresa.email ? "Enviar documentos por e-mail" : "Enviar e-mail (cadastre o e-mail)", acao: () => enviarEmailEmpresaOriginal(empresa, mais) },
      { ic: "conversa", rotulo: "Enviar pelo WhatsApp", acao: () => enviarWhatsAppEmpresa(empresa) },
      { ic: "comentario", rotulo: "Comentar", acao: () => abrirEComentar(empresa) },
      { ic: "lixeira", rotulo: "Excluir empresa", perigo: true, acao: () => excluirEmpresa(empresa) },
    ]);
    alternarEmpresa(empresa);
  });
  header.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-sel]");
    if (!sel) return;
    sel.checked ? SELECIONADAS.add(empresa.id) : SELECIONADAS.delete(empresa.id);
    wrap.classList.toggle("selecionada", sel.checked);
    atualizarBarraSelecao();
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
  wrap.className = `empresa-card ${classeStatus(empresa.status)}${empresa.semMovimento ? " SEM_MOV" : ""}${wrap.classList.contains("aberto") ? " aberto" : ""}${SELECIONADAS.has(empresa.id) ? " selecionada" : ""}`;
  wrap.querySelector(".empresa-header").innerHTML = htmlCabecalhoEmpresa(empresa);
  const info = wrap.querySelector(".info-das");
  if (info) info.innerHTML = htmlInfoDas(empresa);
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
  sairDoFiltroSePreciso(empresa);
}

// Numa aba filtrada (Fechadas, Pendentes, Atenção), a empresa que deixou de
// combinar com a aba sai da lista depois de um instante — dá tempo de ver o clique.
function sairDoFiltroSePreciso(empresa) {
  if (!filtroStatus || empresaPassaFiltro(empresa)) return;
  const wrap = EL_EMPRESA.get(empresa.id);
  const sair = () => {
    if (empresaPassaFiltro(empresa)) return; // marcou de novo antes de sair
    EMPRESAS_ABERTAS.delete(empresa.id);
    const grupo = grupoDaEmpresa(empresa);
    if (grupo) redesenharGrupo(grupo); else renderizarGrupos();
  };
  if (!wrap || _semMovimento()) return sair();
  wrap.classList.add("saindo-filtro");
  setTimeout(sair, 420);
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
  ["nome", "Nome"], ["cnpj", "CNPJ", null, "00.000.000/0000-00", "mono"],
  ["whatsapp", "WhatsApp", "tel", "(44) 99999-9999", "mono"], ["email", "E-mail", "email", "não informado"],
  ["municipioNfse", "Município NFS-e", "select"], ["senhaPrefeitura", "Senha prefeitura", "senha"],
  ["cadastroMunicipal", "Inscrição municipal", null, "cadastro econômico", "mono"], ["nfseSerie", "Série NFS-e", null, "1", "mono"],
  ["loginPrefeitura", "Login prefeitura", null, "se não for o CNPJ", "mono"], ["senhaRegularize", "Senha Regularize", "senha"],
  ["inscricaoEstadual", "Inscrição estadual", null, "", "mono"],
];

function criarCorpoEmpresa(empresa) {
  const corpo = document.createElement("div");
  corpo.className = "empresa-corpo";

  // Status + checkboxes
  const barra = document.createElement("div");
  barra.className = "barra-opcoes";
  const chk = (campo, rotulo, extra = "") =>
    `<label class="chip-check ${extra}"><input type="checkbox" data-cb="${campo}" ${empresa[campo] ? "checked" : ""}><span class="caixa">${icone("check")}</span>${rotulo}</label>`;
  barra.innerHTML = `${htmlBotoesStatus(empresa.status, !!empresa.semMovimento)}<span class="segmentado segmentado-checks">${chk("nfs", "NFS")}${chk("nfe", "NFE")}${chk("nfc", "NFC")}</span>${chk("fechado", `${icone("cadeado", "ico-sm")}Fechado`, "fechado")}
    <span class="barra-copias">
      ${botaoCopiaSe(empresa.cnpj, "CNPJ")}
      ${sociosDe(empresa).some((s) => s.cpf) ? `<button type="button" class="chip-copia" data-copiar="CPF">${icone("copiar")}CPF</button>` : ""}
      ${botaoCopiaSe(empresa.cadastroMunicipal, "IM")}
      ${botaoCopiaSe(empresa.senhaPrefeitura, "Prefeitura")}
    </span>`;
  barra.addEventListener("click", (e) => {
    const copia = e.target.closest("[data-copiar]");
    if (copia) return copiarCampoEmpresa(empresa, copia.dataset.copiar, copia);
    const sm = e.target.closest("[data-semmov]");
    if (sm) {
      // marcação independente: não mexe no OK / Pendente / Atenção
      empresa.semMovimento = !empresa.semMovimento;
      sm.className = `pill-toggle semmov-toggle ${empresa.semMovimento ? "semmov-on" : "semmov-off"}`;
      sm.setAttribute("aria-pressed", empresa.semMovimento);
      return mudouStatus(empresa);
    }
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
    const grupo = grupoDaEmpresa(empresa);
    if (grupo) atualizarCabecalhoGrupo(grupo);
    renderizarDashboard();
    marcarAlterado();
    sairDoFiltroSePreciso(empresa);
  });
  corpo.appendChild(barra);

  // Dados de acesso
  const campos = document.createElement("div");
  campos.className = "grade-campos";
  campos.innerHTML = CAMPOS_EMPRESA.map(([campo, rotulo, tipo, placeholder, extra]) => tipo === "select"
    ? `<div class="campo-form"><label>${rotulo}</label><select data-campo="${campo}">${Object.entries(MUNICIPIOS_NFSE).map(([k, m]) =>
        `<option value="${k}"${municipioNfse(empresa).chave === k ? " selected" : ""}>${m.nome} · ${{ ipm: "IPM", elotech: "Elotech", nacional: "Nacional" }[m.sistema]}${m.sistema === "ipm" ? "" : " (em breve)"}</option>`).join("")}</select></div>`
    : tipo === "senha"
    ? `<div class="campo-form"><label>${rotulo}</label><span class="campo-senha"><input data-campo="${campo}" type="password" class="mono" value="${escaparHtml(empresa[campo] || "")}" autocomplete="new-password" spellcheck="false"><button type="button" class="olho" data-olho title="Mostrar senha" aria-label="Mostrar senha">${icone("olho")}</button></span></div>`
    : `<div class="campo-form"><label>${rotulo}</label><input data-campo="${campo}" ${tipo ? `type="${tipo}"` : ""} ${placeholder ? `placeholder="${placeholder}"` : ""} ${extra === "mono" ? 'class="mono"' : ""} value="${escaparHtml(empresa[campo] || "")}" autocomplete="off" spellcheck="false"></div>`
  ).join("");
  campos.addEventListener("click", (e) => {
    const olho = e.target.closest("[data-olho]");
    if (!olho) return;
    const inp = olho.previousElementSibling;
    const mostrar = inp.type === "password";
    inp.type = mostrar ? "text" : "password";
    olho.innerHTML = icone(mostrar ? "olhoFechado" : "olho");
    olho.title = mostrar ? "Esconder senha" : "Mostrar senha";
  });
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
  corpo.appendChild(montarSocios(empresa));

  // Ações extras
  const acoesExtra = document.createElement("div");
  acoesExtra.className = "acoes-extra";
  acoesExtra.innerHTML = `
    <button type="button" class="btn-secundario btn-sm btn-consultar-simples">${icone("busca")}Consultar Simples</button>
    <button type="button" class="btn-secundario btn-sm btn-consultar-exclusao">${icone("proibido")}Consultar exclusão</button>
    <button type="button" class="btn-secundario btn-sm btn-importar-resumo" title="Gera o Relatório Fiscal a partir do Resumo do PGDAS">${icone("enviar")}Importar PGDAS</button>
    <input type="file" accept="application/pdf" class="input-resumo oculto">
    <span class="resultado-simples"></span>
    <span class="info-das">${htmlInfoDas(empresa)}</span>`;
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
const _MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
function _hojeIso() { return _isoLocal(new Date()); }

function htmlPrazoTarefa(item) {
  if (!item.prazo) return "";
  const [a, m, d] = item.prazo.split("-").map(Number);
  const hoje = _hojeIso();
  if (!item.concluido && item.prazo < hoje) return `<span class="tag tag-erro" title="Prazo ${d}/${m}/${a}">Atrasada · ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}</span>`;
  if (item.prazo === hoje) return `<span class="tag tag-erro">Hoje</span>`;
  const agoraD = new Date();
  const mesmoMes = a === agoraD.getFullYear() && m === agoraD.getMonth() + 1;
  return `<span class="tag tag-aviso" title="Prazo ${d}/${m}/${a}">${mesmoMes ? `Dia ${d}` : `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`}</span>`;
}

function criarTarefaEl(item) {
  const div = document.createElement("div");
  div.className = "tarefa-item" + (item.concluido ? " feita" : "");
  const desenhar = () => {
    const n = (item.comentarios || []).length;
    div.className = "tarefa-item" + (item.concluido ? " feita" : "");
    div.innerHTML = `
      <input type="checkbox" class="check-quadrado" ${item.concluido ? "checked" : ""} aria-label="Concluída">
      <div class="tarefa-corpo">
        <button type="button" class="tarefa-texto" data-editar title="Editar tarefa">${escaparHtml(item.texto)}</button>
        ${item.detalhe ? `<span class="tarefa-detalhe">${escaparHtml(item.detalhe)}</span>` : ""}
        <div class="tarefa-tags">
          ${htmlPrazoTarefa(item)}
          ${item.etiqueta ? `<span class="tag">${escaparHtml(item.etiqueta)}</span>` : ""}
          <button type="button" class="tag tag-botao${n ? "" : " tag-fantasma"}" data-coment>${n ? `${n} comentário${n > 1 ? "s" : ""}` : `${icone("comentario", "ico-sm")}Comentar`}</button>
        </div>
        <div class="tarefa-comentarios${div._comentAberto ? "" : " oculto"}">
          <div class="tarefa-lista-coment">${(item.comentarios || []).map((c) => `<div class="comentario-linha">${escaparHtml(c)}</div>`).join("")}</div>
          <input placeholder="Comentar e apertar Enter..." maxlength="500">
        </div>
      </div>
      <button type="button" class="btn-icone" data-remover title="Remover tarefa">${icone("x", "ico-sm")}</button>`;
  };
  desenhar();
  div.addEventListener("change", (e) => {
    if (!e.target.classList.contains("check-quadrado")) return;
    item.concluido = e.target.checked;
    marcarAlterado();
    renderizarChecklist();
  });
  div.addEventListener("click", async (e) => {
    if (e.target.closest("[data-remover]")) {
      const i = ESTADO.checklist.indexOf(item);
      if (i >= 0) ESTADO.checklist.splice(i, 1);
      marcarAlterado();
      return renderizarChecklist();
    }
    if (e.target.closest("[data-coment]")) {
      div._comentAberto = !div._comentAberto;
      desenhar();
      if (div._comentAberto) div.querySelector(".tarefa-comentarios input").focus();
      return;
    }
    if (e.target.closest("[data-editar]")) editarTarefa(item);
  });
  div.addEventListener("keydown", (e) => {
    const inp = e.target.closest(".tarefa-comentarios input");
    if (!inp || e.key !== "Enter" || !inp.value.trim()) return;
    item.comentarios = item.comentarios || [];
    item.comentarios.push(inp.value.trim());
    marcarAlterado();
    desenhar();
    div.querySelector(".tarefa-comentarios input").focus();
  });
  return div;
}

let _tarefasFeitasAntes = null;
const _posTarefa = new WeakMap(); // tarefa -> posição na tela (para deslizar quando a ordem muda)
function renderizarChecklist() {
  const cont = $("#lista-checklist");
  const lista = ESTADO.checklist;
  const feitas = lista.filter((t) => t.concluido).length;
  const hoje = new Date();
  const dataTxt = `${hoje.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "")}, ${hoje.getDate()} ${_MESES_CURTOS[hoje.getMonth()]}`;
  const prog = $("#tarefas-progresso");
  const pctT = lista.length ? Math.round((feitas / lista.length) * 100) : 0;
  if (prog) {
    if (!lista.length) prog.innerHTML = "";
    else if (prog.querySelector(".tarefas-barra")) {
      // atualiza no lugar: a barra desliza até o novo valor
      prog.querySelector(".tarefas-numero b").textContent = `${feitas} de ${lista.length}`;
      prog.querySelector(".tarefas-barra i").style.width = pctT + "%";
    } else {
      prog.innerHTML = `
        <div class="tarefas-numero"><b>${feitas} de ${lista.length}</b><span>concluídas · ${dataTxt}</span></div>
        <span class="tarefas-barra"><i style="width:0%"></i></span>`;
      prog.getBoundingClientRect();
      prog.querySelector(".tarefas-barra i").style.width = pctT + "%";
    }
    // concluiu a última tarefa agora: pequena celebração
    if (_tarefasFeitasAntes !== null && lista.length && feitas === lista.length && _tarefasFeitasAntes < lista.length) celebrarTarefas(prog);
  }
  _tarefasFeitasAntes = lista.length ? feitas : null;
  if (!lista.length) {
    cont.innerHTML = `<div class="vazio">${icone("tarefas", "ico-xl")}<p>Nenhuma tarefa para hoje. Adicione abaixo o que precisa ser feito.</p></div>`;
    return;
  }
  // pendentes primeiro (as com prazo mais cedo no topo), concluídas no fim
  const ordem = [...lista].sort((a, b) => (a.concluido - b.concluido) || ((a.prazo || "9") < (b.prazo || "9") ? -1 : (a.prazo || "9") > (b.prazo || "9") ? 1 : lista.indexOf(a) - lista.indexOf(b)));
  // FLIP: guarda onde cada tarefa estava, troca a lista e faz cada uma deslizar da posição antiga para a nova
  cont.querySelectorAll(".tarefa-item").forEach((el) => el._item && _posTarefa.set(el._item, el.getBoundingClientRect().top));
  const novos = ordem.map((item) => { const el = criarTarefaEl(item); el._item = item; return el; });
  cont.replaceChildren(...novos);
  if (_semMovimento()) return;
  novos.forEach((el) => {
    const antes = _posTarefa.get(el._item);
    if (antes == null) return;
    const dy = antes - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 2) return;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
  });
}

function celebrarTarefas(prog) {
  notificar("Tudo no lugar: todas as tarefas de hoje concluídas", "ok");
  if (_semMovimento()) return;
  const barra = prog.querySelector(".tarefas-barra");
  const r = barra.getBoundingClientRect();
  const cores = ["#B4532A", "#E3955C", "#4B7E43", "#16202E", "#F2B98F"];
  for (let i = 0; i < 18; i++) {
    const p = document.createElement("span");
    p.className = "faisca";
    const ang = (-Math.PI / 2) + (Math.random() - 0.5) * Math.PI * 1.1, dist = 40 + Math.random() * 70;
    p.style.cssText = `left:${r.right - 6}px;top:${r.top}px;background:${cores[i % cores.length]};--dx:${Math.cos(ang) * dist}px;--dy:${Math.sin(ang) * dist}px;--rot:${Math.random() * 360}deg`;
    document.body.appendChild(p);
    p.addEventListener("animationend", () => p.remove(), { once: true });
  }
}

function abrirFormTarefa(item = null) {
  abrirModal(`
    <h2>${item ? "Editar tarefa" : "Nova tarefa"}</h2>
    <form id="form-tarefa">
      <div class="campo-form"><label>Tarefa</label><input id="tf-texto" maxlength="200" required value="${escaparHtml(item?.texto || "")}" placeholder="Ex.: Protocolo prefeitura"></div>
      <div class="campo-form"><label>Detalhe (opcional)</label><input id="tf-detalhe" maxlength="200" value="${escaparHtml(item?.detalhe || "")}" placeholder="Ex.: Serviços prestados e tomados"></div>
      <div class="linha-dois-campos">
        <div class="campo-form"><label>Prazo (opcional)</label><input id="tf-prazo" type="date" value="${escaparHtml(item?.prazo || "")}"></div>
        <div class="campo-form"><label>Etiqueta (opcional)</label><input id="tf-etiqueta" maxlength="20" value="${escaparHtml(item?.etiqueta || "")}" placeholder="Ex.: MEI"></div>
      </div>
      <div class="modal-rodape">
        <button type="button" class="btn-ghost" id="tf-cancelar">Cancelar</button>
        <button type="submit" class="btn-primario">${icone(item ? "salvar" : "mais")}${item ? "Salvar tarefa" : "Adicionar"}</button>
      </div>
    </form>`);
  $("#tf-cancelar").addEventListener("click", fecharModal);
  $("#form-tarefa").addEventListener("submit", (e) => {
    e.preventDefault();
    const dados = { texto: $("#tf-texto").value.trim(), detalhe: $("#tf-detalhe").value.trim(), prazo: $("#tf-prazo").value, etiqueta: $("#tf-etiqueta").value.trim() };
    if (!dados.texto) return;
    if (item) Object.assign(item, dados);
    else ESTADO.checklist.push({ ...dados, concluido: false, comentarios: [] });
    fecharModal();
    marcarAlterado();
    renderizarChecklist();
  });
}
function editarTarefa(item) { abrirFormTarefa(item); }

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

$("#btn-nova-tarefa").addEventListener("click", () => abrirFormTarefa());
$("#tarefa-rapida")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.value.trim()) return;
  ESTADO.checklist.push({ texto: e.target.value.trim(), concluido: false, comentarios: [] });
  e.target.value = "";
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
        if (valor) empresa.das = { valor, competencia: competencia || "", em: agora() };
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

{
  const termo = new URLSearchParams(location.search).get("busca");
  if (termo && $("#busca")) { $("#busca").value = termo; filtroAtual = termo.trim().toLowerCase(); }
}
iniciarPagina().then(() => {
  // vindo da paleta de comandos de outra página: abre a empresa escolhida
  const id = new URLSearchParams(location.search).get("empresa");
  if (!id) return;
  const e = ESTADO.grupos.flatMap((g) => g.empresas).find((x) => x.id === id);
  if (e) irParaEmpresa(e);
  history.replaceState(null, "", location.pathname);
});

// ---------------------------------------------------------------------------
// SÓCIOS (vários CPFs por empresa)
// O primeiro sócio continua gravado também em empresa.cpf (compatível com o que já existia).
// ---------------------------------------------------------------------------
function sociosDe(e) {
  if (Array.isArray(e.socios)) return e.socios;
  return e.cpf ? [{ nome: "", cpf: e.cpf }] : [];
}
function _gravarSocios(e, lista) {
  e.socios = lista;
  e.cpf = (lista.find((s) => s.cpf) || {}).cpf || "";
}
function formatarCpf(v) {
  const d = limparDigitos(v);
  return d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4") : String(v || "").trim();
}

function htmlChipCpfs(e) {
  const comCpf = sociosDe(e).filter((s) => s.cpf);
  if (!comCpf.length) return "";
  const titulo = comCpf.length === 1 ? `Copiar CPF: ${comCpf[0].cpf}` : `${comCpf.length} sócios — escolher qual CPF copiar`;
  return `<button type="button" class="chip-copia" data-copiar="CPF" title="${escaparHtml(titulo)}">${icone("copiar")}CPF${comCpf.length > 1 ? `<span class="chip-contador">${comCpf.length}</span>` : ""}</button>`;
}

function copiarCpfSocio(e, botao) {
  const comCpf = sociosDe(e).filter((s) => s.cpf);
  if (comCpf.length === 1) return copiar("CPF", comCpf[0].cpf);
  abrirMenuCopia(botao, "Qual CPF copiar?", comCpf.map((s, i) => ({ titulo: s.nome || `Sócio ${i + 1}`, valor: s.cpf })), "CPF");
}

// Menuzinho ao lado do botão (fecha com Esc, clique fora ou depois de copiar)
function abrirMenuCopia(ancora, titulo, itens, rotulo) {
  document.querySelector(".menu-copia")?.remove();
  const menu = document.createElement("div");
  menu.className = "menu-copia";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `<div class="menu-copia-titulo">${escaparHtml(titulo)}</div>` + itens.map((it, i) =>
    `<button type="button" role="menuitem" data-i="${i}"><span><b>${escaparHtml(it.titulo)}</b><small>${escaparHtml(it.mostrar ?? it.valor)}</small></span>${icone("copiar", "ico-sm")}</button>`).join("");
  document.body.appendChild(menu);
  const r = ancora.getBoundingClientRect();
  const larg = menu.offsetWidth, alt = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(r.left, innerWidth - larg - 8)) + "px";
  menu.style.top = (r.bottom + alt + 8 > innerHeight ? Math.max(8, r.top - alt - 6) : r.bottom + 6) + "px";
  const fechar = () => { menu.remove(); document.removeEventListener("mousedown", fora, true); document.removeEventListener("keydown", tecla, true); };
  const fora = (ev) => { if (!menu.contains(ev.target)) fechar(); };
  const tecla = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); fechar(); } };
  document.addEventListener("mousedown", fora, true);
  document.addEventListener("keydown", tecla, true);
  menu.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-i]");
    if (!b) return;
    const it = itens[+b.dataset.i];
    copiar(rotulo ? `${rotulo} de ${it.titulo}` : it.titulo, it.valor);
    fechar();
  });
  menu.querySelector("button")?.focus();
}

function montarSocios(e) {
  const caixa = document.createElement("div");
  caixa.className = "socios";
  const desenhar = () => {
    const lista = sociosDe(e);
    caixa.innerHTML = `
      <div class="socios-cabeca"><span>${icone("usuarios", "ico-sm")}Sócios <small>${lista.length ? `${lista.length} cadastrado(s)` : "nenhum CPF cadastrado"}</small></span>
        <button type="button" class="btn-ghost btn-sm" data-add>${icone("mais")}Adicionar sócio</button></div>
      ${lista.map((s, i) => `
        <div class="socio-linha" data-i="${i}">
          <input data-socio="nome" placeholder="Nome do sócio (opcional)" value="${escaparHtml(s.nome || "")}" autocomplete="off" spellcheck="false">
          <input data-socio="cpf" placeholder="CPF" inputmode="numeric" value="${escaparHtml(s.cpf || "")}" autocomplete="off">
          <button type="button" class="btn-icone" data-remover title="Remover este sócio">${icone("lixeira", "ico-sm")}</button>
        </div>`).join("")}`;
  };
  const mudou = (lista, foco) => {
    _gravarSocios(e, lista);
    atualizarEmpresa(e); // atualiza o chip "CPF" do cabeçalho
    marcarAlterado();
    desenhar();
    if (foco) caixa.querySelector(foco)?.focus();
  };
  caixa.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-add]")) {
      const lista = [...sociosDe(e).map((s) => ({ ...s })), { nome: "", cpf: "" }];
      return mudou(lista, `.socio-linha[data-i="${lista.length - 1}"] [data-socio="nome"]`);
    }
    const rem = ev.target.closest("[data-remover]");
    if (rem) {
      const i = +rem.closest(".socio-linha").dataset.i;
      mudou(sociosDe(e).filter((_, k) => k !== i).map((s) => ({ ...s })));
    }
  });
  caixa.addEventListener("change", (ev) => {
    const inp = ev.target.closest("[data-socio]");
    if (!inp) return;
    const i = +inp.closest(".socio-linha").dataset.i;
    const lista = sociosDe(e).map((s) => ({ ...s }));
    let valor = inp.value.trim();
    if (inp.dataset.socio === "cpf" && valor) {
      valor = formatarCpf(valor);
      if (limparDigitos(valor).length !== 11) notificar("Esse CPF não tem 11 números — confira.", "aviso");
    }
    lista[i][inp.dataset.socio] = valor;
    _gravarSocios(e, lista);
    inp.value = valor;
    atualizarEmpresa(e);
    marcarAlterado();
    inp.classList.add("salvo");
    setTimeout(() => inp.classList.remove("salvo"), 700);
  });
  desenhar();
  return caixa;
}

// ---------------------------------------------------------------------------
// PRUMO — menus, cópia, seleção em lote, filtros por status e mês de trabalho
// ---------------------------------------------------------------------------
function copiarCampoEmpresa(e, chave, botao) {
  if (chave === "CPF") return copiarCpfSocio(e, botao);
  const mapa = { CNPJ: e.cnpj, IE: e.inscricaoEstadual, IM: e.cadastroMunicipal, Prefeitura: e.senhaPrefeitura, Regularize: e.senhaRegularize };
  const rotulos = { IM: "Inscrição Municipal", IE: "Inscrição Estadual", Prefeitura: "Senha da prefeitura", Regularize: "Senha do Regularize" };
  copiar(rotulos[chave] || chave, mapa[chave]);
}

function htmlInfoDas(e) {
  if (!e.das || !e.das.valor) return "";
  return `${icone("documento", "ico-sm")}Guia DAS processada · R$ ${escaparHtml(e.das.valor)}${e.das.competencia ? ` · ${escaparHtml(e.das.competencia)}` : ""} · ${escaparHtml((e.das.em || "").slice(0, 16))}`;
}

// Menu de ações ao lado de um botão (mesmo visual do menu de copiar)
function abrirMenuAcoes(ancora, titulo, itens) {
  document.querySelector(".menu-copia")?.remove();
  const menu = document.createElement("div");
  menu.className = "menu-copia menu-acoes";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `<div class="menu-copia-titulo">${escaparHtml(titulo)}</div>` + itens.map((it, i) =>
    `<button type="button" role="menuitem" data-i="${i}" class="${it.perigo ? "perigo" : ""}">${icone(it.ic, "ico-sm")}<span><b>${escaparHtml(it.rotulo)}</b></span></button>`).join("");
  document.body.appendChild(menu);
  const r = ancora.getBoundingClientRect();
  const larg = menu.offsetWidth, alt = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(r.right - larg, innerWidth - larg - 8)) + "px";
  menu.style.top = (r.bottom + alt + 8 > innerHeight ? Math.max(8, r.top - alt - 6) : r.bottom + 6) + "px";
  const fechar = () => { menu.remove(); document.removeEventListener("mousedown", fora, true); document.removeEventListener("keydown", tecla, true); };
  const fora = (ev) => { if (!menu.contains(ev.target)) fechar(); };
  const tecla = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); fechar(); } };
  document.addEventListener("mousedown", fora, true);
  document.addEventListener("keydown", tecla, true);
  menu.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-i]");
    if (!b) return;
    fechar();
    itens[+b.dataset.i].acao();
  });
  menu.querySelector("button")?.focus();
}

function abrirEComentar(empresa) {
  irParaEmpresa(empresa);
  requestAnimationFrame(() => {
    const inp = EL_EMPRESA.get(empresa.id)?.querySelector(".empresa-corpo .coluna-detalhe input");
    inp?.focus({ preventScroll: false });
  });
}

// ----- seleção em lote -----
function atualizarBarraSelecao() {
  const barra = $("#barra-selecao");
  if (!barra) return;
  // tira da seleção quem não existe mais
  const ids = new Set(ESTADO.grupos.flatMap((g) => g.empresas.map((e) => e.id)));
  [...SELECIONADAS].forEach((id) => { if (!ids.has(id)) SELECIONADAS.delete(id); });
  const n = SELECIONADAS.size;
  barra.classList.toggle("oculto", !n);
  if (!n) return;
  const sel = ESTADO.grupos.flatMap((g) => g.empresas).filter((e) => SELECIONADAS.has(e.id));
  const todasFechadas = sel.every((e) => e.fechado), todasNfs = sel.every((e) => e.nfs), todasSemMov = sel.every((e) => e.semMovimento);
  barra.innerHTML = `
    <span class="sel-qtd"><b>${n}</b> selecionada${n > 1 ? "s" : ""}</span>
    <span class="sel-grupo">
      <button type="button" data-lote="VERDE">${icone("check")}OK</button>
      <button type="button" data-lote="VERMELHO">${icone("x")}Pendente</button>
      <button type="button" data-lote="ATENÇÃO">${icone("alerta")}Atenção</button>
      <button type="button" data-lote="SEM" title="Tirar o status">Sem status</button>
    </span>
    <span class="sel-grupo">
      <button type="button" data-lote-flag="fechado" title="${todasFechadas ? "Todas já estão fechadas: o clique reabre" : "Marcar como fechadas"}">${icone("cadeado")}${todasFechadas ? "Reabrir" : "Fechado"}</button>
      <button type="button" data-lote-flag="semMovimento" title="${todasSemMov ? "Todas já estão sem movimento: o clique desmarca" : "Marcar sem movimento (o status continua)"}">${icone("proibido")}${todasSemMov ? "Tirar sem mov." : "Sem movimento"}</button>
      <button type="button" data-lote-flag="nfs" title="${todasNfs ? "Todas já têm NFS: o clique desmarca" : "Marcar NFS"}">${todasNfs ? "Tirar NFS" : "NFS"}</button>
    </span>
    <button type="button" class="sel-limpar" data-lote-limpar>${icone("x")}Limpar</button>`;
}
$("#barra-selecao")?.addEventListener("click", (ev) => {
  const empresas = ESTADO.grupos.flatMap((g) => g.empresas).filter((e) => SELECIONADAS.has(e.id));
  const st = ev.target.closest("[data-lote]");
  const flag = ev.target.closest("[data-lote-flag]");
  if (ev.target.closest("[data-lote-limpar]")) {
    SELECIONADAS.clear();
    renderizarGrupos();
    return atualizarBarraSelecao();
  }
  if (!st && !flag) return;
  if (st) empresas.forEach((e) => (e.status = st.dataset.lote));
  if (flag) {
    const campo = flag.dataset.loteFlag;
    const ligar = !empresas.every((e) => e[campo]); // se todas já têm, o clique desliga
    empresas.forEach((e) => (e[campo] = ligar));
  }
  marcarAlterado();
  renderizarGrupos();
  renderizarDashboard();
  atualizarBarraSelecao(); // o rótulo dos botões muda (ex.: "Fechado" ↔ "Reabrir")
  notificar(`${empresas.length} empresa(s) atualizada(s) — clique em Salvar para gravar`, "ok");
});

// ----- abas Todas / Pendentes / Atenção / Fechadas -----
$("#filtros-status")?.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-filtro]");
  if (!b) return;
  filtroStatus = b.dataset.filtro;
  $$("#filtros-status [data-filtro]").forEach((x) => { const ativo = x === b; x.classList.toggle("ativo", ativo); x.setAttribute("aria-selected", ativo); });
  renderizarGrupos();
});

// ----- botões do topo -----
$("#btn-nova-empresa")?.addEventListener("click", () => abrirFormNovaEmpresa());

function rotuloMesTrabalho() {
  const [a, m] = (ESTADO.mesTrabalho || _isoLocal(new Date()).slice(0, 7)).split("-").map(Number);
  const nome = new Date(a, m - 1, 1).toLocaleDateString("pt-BR", { month: "long" });
  return `${nome.charAt(0).toUpperCase()}${nome.slice(1)} ${a}`;
}
function atualizarRotuloMes() { const el = $("#competencia-rotulo"); if (el) el.textContent = rotuloMesTrabalho(); }
$("#btn-competencia")?.addEventListener("click", (ev) => {
  const btn = ev.currentTarget;
  abrirMenuAcoes(btn, `Mês de trabalho · ${rotuloMesTrabalho()}`, [
    { ic: "calendario", rotulo: "Trocar o mês de trabalho", acao: trocarMesTrabalho },
    { ic: "salvar", rotulo: "Salvar período", acao: () => $("#btn-salvar-periodo")?.click() },
    { ic: "pastaAberta", rotulo: "Abrir período salvo", acao: () => $("#btn-abrir-periodo")?.click() },
    { ic: "borracha", rotulo: "Nova lista (começar o próximo mês)", perigo: true, acao: () => $("#btn-nova-lista")?.click() },
  ]);
});
function trocarMesTrabalho() {
  abrirModal(`
    <h2>Mês de trabalho</h2>
    <p class="modal-sub">Aparece no topo da página e é o nome sugerido ao salvar o período.</p>
    <form id="form-mes"><div class="campo-form"><label>Mês</label><input type="month" id="mes-trabalho" value="${escaparHtml(ESTADO.mesTrabalho || _isoLocal(new Date()).slice(0, 7))}" required></div>
    <div class="modal-rodape"><button type="button" class="btn-ghost" id="mes-cancelar">Cancelar</button><button type="submit" class="btn-primario">${icone("check")}Usar este mês</button></div></form>`);
  $("#mes-cancelar").addEventListener("click", fecharModal);
  $("#form-mes").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!/^\d{4}-\d{2}$/.test($("#mes-trabalho").value)) return;
    ESTADO.mesTrabalho = $("#mes-trabalho").value;
    fecharModal();
    atualizarRotuloMes();
    marcarAlterado();
  });
}

// ---------------------------------------------------------------------------
// ARRASTAR PARA MUDAR A ORDEM DAS EMPRESAS
// A lista não é redesenhada: o próprio cartão é movido no lugar (com uma "vaga" do mesmo
// tamanho marcando onde vai cair). Empresas abertas continuam abertas; nada pisca.
// Dá para soltar em outro grupo aberto, ou no cabeçalho de um grupo fechado (vai para o fim dele).
// ---------------------------------------------------------------------------
let _arraste = null;

function _grupoDaLista(lista) {
  for (const [grupo, card] of EL_GRUPO) if (card.contains(lista)) return grupo;
  return null;
}
function _grupoDoCabecalho(cab) {
  for (const [grupo, card] of EL_GRUPO) if (card.contains(cab)) return grupo;
  return null;
}

$("#lista-grupos")?.addEventListener("pointerdown", (ev) => {
  const alca = ev.target.closest("[data-alca]");
  if (!alca || ev.button !== 0) return;
  ev.preventDefault();
  if (filtroAtual || filtroStatus) {
    notificar("Para mudar a ordem, limpe a busca e volte para a aba “Todas”.", "aviso");
    return;
  }
  const card = alca.closest(".empresa-card");
  alca.setPointerCapture(ev.pointerId);
  _arraste = { pointerId: ev.pointerId, card, alca, inicioX: ev.clientX, inicioY: ev.clientY, x: ev.clientX, y: ev.clientY, iniciado: false, grupoCab: null, rolagem: 0 };
});

function _comecarArraste() {
  const a = _arraste;
  const r = a.card.getBoundingClientRect();
  a.rect = r;
  a.vaga = document.createElement("div");
  a.vaga.className = "empresa-vaga";
  a.vaga.style.height = r.height + "px";
  a.card.parentNode.insertBefore(a.vaga, a.card);
  a.origem = _grupoDaLista(a.card.parentNode);
  a.cardGrupo = a.card.closest(".grupo-card");
  a.cardGrupo?.classList.add("origem-arraste");
  Object.assign(a.card.style, { position: "fixed", left: r.left + "px", top: r.top + "px", width: r.width + "px", zIndex: 900, pointerEvents: "none" });
  a.card.classList.add("arrastando");
  document.body.classList.add("arrastando-empresa");
  a.iniciado = true;
  a.loop = requestAnimationFrame(_passoArraste);
}

$("#lista-grupos")?.addEventListener("pointermove", (ev) => {
  const a = _arraste;
  if (!a) return;
  a.x = ev.clientX; a.y = ev.clientY;
  if (!a.iniciado && Math.hypot(a.x - a.inicioX, a.y - a.inicioY) < 5) return; // só um clique
  if (!a.iniciado) _comecarArraste();
});

// Um quadro por vez (requestAnimationFrame): mexe o cartão, acha o lugar e rola a página perto das bordas.
function _passoArraste() {
  const a = _arraste;
  if (!a || !a.iniciado) return;
  // rolagem automática perto das bordas (o topo fixo da página conta como borda)
  const topoFixo = ($(".faixa-superior")?.getBoundingClientRect().bottom || 0);
  const zona = 70;
  let vel = 0;
  if (a.y < topoFixo + zona) vel = -Math.ceil((topoFixo + zona - a.y) / 6);
  else if (a.y > innerHeight - zona) vel = Math.ceil((a.y - (innerHeight - zona)) / 6);
  if (vel) { scrollBy(0, Math.max(-24, Math.min(24, vel))); }
  // Posição do cartão: mede onde ele está e corrige até ficar sob o ponteiro. Assim funciona mesmo
  // quando algum elemento acima muda a referência do "position: fixed" (e acompanha a rolagem).
  const yVisivel = Math.min(Math.max(a.y, 0), innerHeight); // o cartão nunca sai da janela
  const atual = a.card.getBoundingClientRect();
  a.tx = (a.tx || 0) + (a.rect.left - atual.left);
  a.ty = (a.ty || 0) + (a.rect.top + (yVisivel - a.inicioY) - atual.top);
  a.card.style.transform = `translate3d(${a.tx}px, ${a.ty}px, 0)`;

  // onde soltar: sobre outro cartão (antes/depois da metade), numa lista vazia ou no cabeçalho de um grupo
  const el = document.elementFromPoint(Math.min(Math.max(a.x, 0), innerWidth - 1), Math.min(Math.max(a.y, 0), innerHeight - 1));
  const sobreCard = el && el.closest("#lista-grupos .empresa-card");
  const sobreCab = el && el.closest("#lista-grupos .grupo-cabecalho");
  const sobreLista = el && el.closest("#lista-grupos .lista-empresas");
  document.querySelectorAll(".grupo-cabecalho.alvo-soltar").forEach((c) => c !== sobreCab && c.classList.remove("alvo-soltar"));
  a.grupoCab = null;
  if (sobreCard && sobreCard !== a.card) {
    const r = sobreCard.getBoundingClientRect();
    const antes = a.y < r.top + r.height / 2;
    const ref = antes ? sobreCard : sobreCard.nextSibling;
    if (ref !== a.vaga && (antes ? sobreCard.previousSibling !== a.vaga : sobreCard.nextSibling !== a.vaga)) sobreCard.parentNode.insertBefore(a.vaga, ref);
  } else if (sobreCab) {
    const g = _grupoDoCabecalho(sobreCab);
    const card = EL_GRUPO.get(g);
    if (g && card && !card.classList.contains("aberto")) { a.grupoCab = g; sobreCab.classList.add("alvo-soltar"); }
  } else if (sobreLista && !sobreLista.contains(a.vaga) && !sobreLista.querySelector(".empresa-card:not(.arrastando)")) {
    sobreLista.querySelector(".vazio-mini")?.classList.add("oculto");
    sobreLista.appendChild(a.vaga); // grupo aberto e vazio
  }
  a.vaga.classList.toggle("apagada", !!a.grupoCab);
  a.loop = requestAnimationFrame(_passoArraste);
}

function _terminarArraste(cancelar) {
  const a = _arraste;
  _arraste = null;
  if (!a) return;
  try { a.alca.releasePointerCapture?.(a.pointerId); } catch {}
  if (!a.iniciado) return;
  cancelAnimationFrame(a.loop);
  document.body.classList.remove("arrastando-empresa");
  a.cardGrupo?.classList.remove("origem-arraste");
  document.querySelectorAll(".grupo-cabecalho.alvo-soltar").forEach((c) => c.classList.remove("alvo-soltar"));
  const empresa = ESTADO.grupos.flatMap((g) => g.empresas).find((e) => e.id === a.card.dataset.id);
  const soltarSemAnimar = () => { a.card.classList.remove("arrastando"); a.card.removeAttribute("style"); };

  if (cancelar) { a.vaga.replaceWith(a.card); soltarSemAnimar(); return; }

  // soltou no cabeçalho de um grupo fechado: vai para o fim dele (o cartão sai da tela, o grupo continua fechado)
  if (a.grupoCab) {
    a.origem.empresas.splice(a.origem.empresas.indexOf(empresa), 1);
    a.grupoCab.empresas.push(empresa);
    const listaOrigem = a.vaga.parentNode;
    a.vaga.remove(); a.card.remove(); EL_EMPRESA.delete(empresa.id);
    if (listaOrigem && !listaOrigem.querySelector(".empresa-card")) redesenharGrupo(a.origem); // ficou vazio: mostra o aviso
    atualizarCabecalhoGrupo(a.origem); atualizarCabecalhoGrupo(a.grupoCab);
    renderizarDashboard(); marcarAlterado();
    notificar(`“${empresa.nome}” foi para ${a.grupoCab.nome}`, "ok");
    return;
  }

  // soltou numa lista: o cartão desliza da posição atual até a vaga
  const destino = a.vaga.getBoundingClientRect();
  const atualTop = a.rect.top + (Math.min(Math.max(a.y, 0), innerHeight) - a.inicioY);
  const listaDestino = a.vaga.parentNode;
  a.vaga.replaceWith(a.card);
  soltarSemAnimar();
  const dy = atualTop - destino.top;
  if (Math.abs(dy) > 1) {
    a.card.style.transform = `translateY(${dy}px)`;
    a.card.getBoundingClientRect(); // aplica antes de animar
    a.card.style.transition = "transform .16s cubic-bezier(.2,.8,.2,1)";
    a.card.style.transform = "";
    a.card.addEventListener("transitionend", () => a.card.removeAttribute("style"), { once: true });
  }
  _gravarOrdem(a.origem, _grupoDaLista(listaDestino), listaDestino, empresa);
}

// A ordem na tela vira a ordem nos dados (só da lista mexida; nada é redesenhado).
function _gravarOrdem(origem, destino, lista, empresa) {
  if (!destino) return;
  const ids = [...lista.querySelectorAll(":scope > .empresa-card")].map((el) => el.dataset.id);
  const antes = destino.empresas.map((e) => e.id).join();
  if (origem !== destino) origem.empresas.splice(origem.empresas.indexOf(empresa), 1);
  const porId = new Map([...destino.empresas, empresa].map((e) => [e.id, e]));
  destino.empresas = ids.map((id) => porId.get(id)).filter(Boolean);
  lista.querySelector(".vazio-mini")?.remove();
  if (origem === destino && antes === destino.empresas.map((e) => e.id).join()) return; // voltou para o mesmo lugar
  if (origem !== destino) {
    const cardOrigem = EL_GRUPO.get(origem);
    if (cardOrigem && !cardOrigem.querySelector(".lista-empresas .empresa-card")) redesenharGrupo(origem);
    atualizarCabecalhoGrupo(origem); atualizarCabecalhoGrupo(destino); renderizarDashboard();
    notificar(`“${empresa.nome}” foi para ${destino.nome}`, "ok");
  }
  marcarAlterado();
}

$("#lista-grupos")?.addEventListener("pointerup", () => _terminarArraste(false));
$("#lista-grupos")?.addEventListener("pointercancel", () => _terminarArraste(true));
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && _arraste && _arraste.iniciado) { ev.preventDefault(); _terminarArraste(true); } }, true);

// Teclado: com a alça em foco, ↑ e ↓ sobem e descem a empresa dentro do grupo.
$("#lista-grupos")?.addEventListener("keydown", (ev) => {
  const alca = ev.target.closest("[data-alca]");
  if (!alca || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
  ev.preventDefault();
  if (filtroAtual || filtroStatus) return notificar("Para mudar a ordem, limpe a busca e volte para a aba “Todas”.", "aviso");
  const card = alca.closest(".empresa-card");
  const vizinho = ev.key === "ArrowUp" ? card.previousElementSibling : card.nextElementSibling;
  if (!vizinho || !vizinho.classList.contains("empresa-card")) return;
  const grupo = _grupoDaLista(card.parentNode);
  const empresa = grupo.empresas.find((e) => e.id === card.dataset.id);
  card.parentNode.insertBefore(card, ev.key === "ArrowUp" ? vizinho : vizinho.nextSibling);
  _gravarOrdem(grupo, grupo, card.parentNode, empresa);
  card.querySelector("[data-alca]").focus();
});
