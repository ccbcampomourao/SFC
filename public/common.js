// ============================================================================
// common.js — utilitários e ações compartilhadas entre as páginas autenticadas.
// A tela de login (index.html) também carrega esse arquivo pelos helpers básicos.
// Depende de icones.js (carregado antes, no início do <body>).
// ============================================================================
let ESTADO = { grupos: [], checklist: [], parcelamentos: [] };

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
if (typeof window.icone !== "function") window.icone = () => ""; // segurança se icones.js faltar

async function api(caminho, opcoes = {}, _jaTentou = false) {
  const resp = await fetch(caminho, { headers: { "Content-Type": "application/json" }, ...opcoes });
  const dados = await resp.json().catch(() => ({}));
  // Sessão venceu (4h sem uso) com a página aberta: pede a senha aqui mesmo e repete o pedido,
  // sem recarregar a página — assim nada do que não foi salvo se perde.
  if (resp.status === 401 && !_jaTentou && !caminho.startsWith("/api/auth/") && caminho !== "/api/session" && document.body.classList.contains("dados-prontos")) {
    if (await entrarDeNovo()) return api(caminho, opcoes, true);
  }
  if (!resp.ok) {
    const erro = new Error(dados.erro || `Erro na requisição (HTTP ${resp.status})`);
    Object.assign(erro, dados);
    erro.status = resp.status;
    throw erro;
  }
  return dados;
}

function agora() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function arquivoParaBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Escapa também aspas — o valor vai parar dentro de atributos (value="...", title="...").
const _MAPA_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escaparHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => _MAPA_ESCAPE[c]);
}

function classeStatus(status) {
  return status === "VERDE" ? "VERDE" : status === "VERMELHO" ? "VERMELHO" : status === "ATENÇÃO" ? "ATENCAO" : "";
}

function contarStatus(lista, campoStatus) {
  let verde = 0, vermelho = 0, atencao = 0;
  lista.forEach((item) => {
    if (item[campoStatus] === "VERDE") verde++;
    else if (item[campoStatus] === "VERMELHO") vermelho++;
    else if (item[campoStatus] === "ATENÇÃO") atencao++;
  });
  return { verde, vermelho, atencao };
}

function botaoCopiaSe(valor, rotulo, classeExtra = "") {
  if (!valor) return "";
  return `<button type="button" class="chip-copia ${classeExtra}" data-copiar="${escaparHtml(rotulo)}" title="Copiar ${escaparHtml(rotulo)}: ${escaparHtml(valor)}">${icone("copiar")}${escaparHtml(rotulo)}</button>`;
}

async function copiarParaAreaDeTransferencia(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    // Fallback para navegadores/contextos sem permissão de clipboard
    const ta = document.createElement("textarea");
    ta.value = texto;
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  }
}

function copiar(rotulo, texto) {
  if (!texto) return;
  copiarParaAreaDeTransferencia(texto).then((ok) =>
    ok ? notificar(`${rotulo} copiado`, "ok") : notificar(`Não consegui copiar ${rotulo}`, "erro")
  );
}

// ============================================================================
// NOTIFICAÇÕES (toasts empilhados, com ícone por tipo)
// ============================================================================
function _containerToasts() {
  let c = $("#toasts");
  if (!c) {
    c = document.createElement("div");
    c.id = "toasts";
    c.className = "toasts";
    c.setAttribute("role", "status");
    c.setAttribute("aria-live", "polite");
    document.body.appendChild(c);
  }
  return c;
}

const _ICONE_TOAST = { ok: "ok", erro: "erro", aviso: "alerta", info: "info", carregando: "carregando" };

// tipo: "ok" | "erro" | "aviso" | "info" | "carregando". Mensagens iguais seguidas reaproveitam o mesmo toast.
function notificar(msg, tipo = "info", duracao) {
  const cont = _containerToasts();
  const tempo = duracao ?? (tipo === "erro" ? 6000 : tipo === "carregando" ? 30000 : 3200);
  // Um toast "carregando" anterior é substituído pelo próximo aviso (ex.: "Enviando..." → "Enviado!")
  const anterior = cont.querySelector(".toast[data-tipo='carregando']");
  let t = anterior || null;
  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    cont.appendChild(t);
    if (cont.children.length > 4) cont.firstElementChild.remove();
  }
  t.dataset.tipo = tipo;
  t.className = `toast toast-${tipo}`;
  t.innerHTML = `${icone(_ICONE_TOAST[tipo] || "info", tipo === "carregando" ? "girando" : "")}<span>${escaparHtml(msg)}</span>`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.classList.add("saindo");
    setTimeout(() => t.remove(), 200);
  }, tempo);
  return t;
}

// ============================================================================
// DIÁLOGOS (substituem alert/confirm/prompt nativos, no visual do sistema)
// ============================================================================
function _abrirDialogo({ titulo, mensagem, tipo = "info", campo = null, botoes }) {
  return new Promise((resolve) => {
    const fundo = document.createElement("div");
    fundo.className = "dialogo-fundo";
    const iconeTipo = { info: "info", perigo: "alerta", aviso: "alerta", ok: "ok", erro: "erro", pergunta: "comentario" }[tipo] || "info";
    fundo.innerHTML = `
      <div class="dialogo" role="dialog" aria-modal="true">
        <div class="dialogo-cabeca">
          <span class="dialogo-icone dialogo-icone-${tipo}">${icone(iconeTipo)}</span>
          <h2>${escaparHtml(titulo)}</h2>
        </div>
        ${mensagem ? `<div class="dialogo-mensagem">${escaparHtml(mensagem)}</div>` : ""}
        ${campo ? `<input class="dialogo-campo" type="text" placeholder="${escaparHtml(campo.placeholder || "")}" value="${escaparHtml(campo.valor || "")}">` : ""}
        <div class="dialogo-rodape">
          ${botoes.map((b, i) => `<button type="button" class="${b.classe}" data-i="${i}">${escaparHtml(b.texto)}</button>`).join("")}
        </div>
      </div>`;
    const anteriorFoco = document.activeElement;
    document.body.appendChild(fundo);
    const input = fundo.querySelector(".dialogo-campo");

    const fechar = (valor) => {
      document.removeEventListener("keydown", teclado, true);
      fundo.classList.add("saindo");
      setTimeout(() => fundo.remove(), 160);
      if (anteriorFoco && anteriorFoco.focus) anteriorFoco.focus({ preventScroll: true });
      resolve(valor);
    };
    const confirmarValor = () => fechar(campo ? input.value : true);
    const cancelarValor = () => fechar(campo ? null : false);
    function teclado(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelarValor(); }
      else if (e.key === "Enter" && (input ? document.activeElement === input : true)) { e.preventDefault(); e.stopPropagation(); confirmarValor(); }
    }
    document.addEventListener("keydown", teclado, true);
    fundo.addEventListener("mousedown", (e) => { if (e.target === fundo) cancelarValor(); });
    fundo.querySelectorAll("[data-i]").forEach((btn) => {
      btn.addEventListener("click", () => (botoes[+btn.dataset.i].confirma ? confirmarValor() : cancelarValor()));
    });
    requestAnimationFrame(() => {
      if (input) { input.focus(); input.select(); }
      else fundo.querySelector(".dialogo-rodape button:last-child").focus();
    });
  });
}

function confirmar(mensagem, { titulo = "Confirmar", textoOk = "Confirmar", perigo = false } = {}) {
  return _abrirDialogo({
    titulo, mensagem, tipo: perigo ? "perigo" : "pergunta",
    botoes: [
      { texto: "Cancelar", classe: "btn-ghost" },
      { texto: textoOk, classe: perigo ? "btn-perigo" : "btn-primario", confirma: true },
    ],
  });
}

function perguntar(titulo, { mensagem = "", valor = "", placeholder = "", textoOk = "OK" } = {}) {
  return _abrirDialogo({
    titulo, mensagem, tipo: "pergunta", campo: { valor, placeholder },
    botoes: [
      { texto: "Cancelar", classe: "btn-ghost" },
      { texto: textoOk, classe: "btn-primario", confirma: true },
    ],
  });
}

function avisar(mensagem, { titulo = "Aviso", tipo = "info" } = {}) {
  return _abrirDialogo({ titulo, mensagem, tipo, botoes: [{ texto: "OK", classe: "btn-primario", confirma: true }] });
}

// Deixa um botão em estado "carregando" enquanto a ação roda (impede clique duplo).
async function comCarregando(botao, acao) {
  if (!botao) return acao();
  if (botao.dataset.ocupado === "1") return;
  botao.dataset.ocupado = "1";
  botao.classList.add("ocupado");
  botao.setAttribute("aria-busy", "true");
  try {
    return await acao();
  } finally {
    delete botao.dataset.ocupado;
    botao.classList.remove("ocupado");
    botao.removeAttribute("aria-busy");
  }
}

// Debounce simples — usado nas buscas pra não redesenhar a cada tecla.
function atrasar(fn, ms = 140) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function limparDigitos(s) { return (s || "").replace(/[^0-9]/g, ""); }

function buscarEmpresaPorCnpj(cnpj) {
  const alvo = limparDigitos(cnpj);
  if (!alvo) return null;
  for (const g of ESTADO.grupos) {
    const emp = g.empresas.find((e) => limparDigitos(e.cnpj) === alvo);
    if (emp) return emp;
  }
  return null;
}

function buscarParcelamentoPorCnpj(cnpj) {
  const alvo = limparDigitos(cnpj);
  if (!alvo) return null;
  return ESTADO.parcelamentos.find((p) => limparDigitos(p.cnpj) === alvo) || null;
}

// ---------------------------------------------------------------------------
// LEITURA DE PDF (pdf.js) — usada pela importação em lote de guias/DAS.
// ---------------------------------------------------------------------------
function garantirWorkerPdfJs() {
  if (window.pdfjsLib && pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    const versaoPdfJs = pdfjsLib.version || "3.11.174";
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${versaoPdfJs}/pdf.worker.min.js`;
  }
}

async function extrairTextoPdf(arquivo) {
  if (!window.pdfjsLib) throw new Error("O leitor de PDF ainda está carregando. Tente de novo em alguns segundos.");
  garantirWorkerPdfJs();
  const buf = await arquivo.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let texto = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const pagina = await pdf.getPage(i);
    const conteudo = await pagina.getTextContent();
    texto += conteudo.items.map((it) => it.str).join(" ") + "\n";
  }
  return texto;
}

function extrairCnpjDoTexto(texto) {
  const formatado = texto.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
  if (formatado) return formatado[0];
  const cru = texto.match(/\d{14}/);
  return cru ? cru[0] : null;
}

function extrairCompetenciaDoTexto(texto) {
  const m = texto.match(/(Janeiro|Fevereiro|Março|Abril|Maio|Junho|Julho|Agosto|Setembro|Outubro|Novembro|Dezembro)\/\d{4}/);
  return m ? m[0] : "";
}

function extrairValorDoTexto(texto) {
  const todos = texto.match(/\d{1,3}(\.\d{3})*,\d{2}/g);
  return todos && todos.length ? todos[todos.length - 1] : "";
}

async function anexarArquivoNaLista(lista, arquivo) {
  const jaExiste = lista.some((a) => a.nome === arquivo.name);
  if (jaExiste) return null;
  const dataB64 = await arquivoParaBase64(arquivo);
  const resp = await api("/api/anexos", { method: "POST", body: JSON.stringify({ nome: arquivo.name, tipo: arquivo.type || "application/pdf", dataB64 }) });
  lista.push({ id: resp.id, nome: resp.nome, tipo: resp.tipo });
  return resp;
}

function baixarAnexo(a) {
  window.open(`/api/anexos/${a.id}`, "_blank");
}

async function enviarEmailBruto({ destinatario, assunto, mensagem, html = false, anexoIds = [], remetenteNome = "Bruno - Fiscal - FZ CONT" }) {
  return api("/api/email", {
    method: "POST",
    body: JSON.stringify({ destinatario, assunto, mensagem, html, anexoIds, remetenteNome }),
  });
}

// ============================================================================
// MODAL GENÉRICO (Esc fecha, clique fora fecha, foco no primeiro campo)
// ============================================================================
function abrirModal(html) {
  const fundo = $("#modal-fundo");
  $("#modal-conteudo").innerHTML = `<button type="button" class="modal-fechar" aria-label="Fechar">${icone("x")}</button>${html}`;
  $("#modal-conteudo .modal-fechar").addEventListener("click", fecharModal);
  fundo.classList.remove("oculto", "saindo");
  requestAnimationFrame(() => {
    const primeiro = $("#modal-conteudo input:not([type=file]):not([type=checkbox]), #modal-conteudo textarea");
    if (primeiro) primeiro.focus();
  });
}
function fecharModal() {
  const fundo = $("#modal-fundo");
  if (!fundo || fundo.classList.contains("oculto")) return;
  fundo.classList.add("saindo");
  setTimeout(() => {
    fundo.classList.add("oculto");
    fundo.classList.remove("saindo");
    $("#modal-conteudo").innerHTML = "";
  }, 150);
}
$("#modal-fundo")?.addEventListener("mousedown", (e) => { if (e.target.id === "modal-fundo") fecharModal(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.querySelector(".dialogo-fundo")) fecharModal();
});

// ============================================================================
// ALTERAÇÕES NÃO SALVAS — indicador no botão "Salvar", Ctrl+S e aviso ao sair
// ============================================================================
let _alteracoesPendentes = false;
function marcarAlterado() {
  if (_alteracoesPendentes) return;
  _alteracoesPendentes = true;
  $("#btn-salvar")?.classList.add("pendente");
}
function limparAlterado() {
  _alteracoesPendentes = false;
  $("#btn-salvar")?.classList.remove("pendente");
}
window.addEventListener("beforeunload", (e) => {
  if (_alteracoesPendentes && $("#btn-salvar")) { e.preventDefault(); e.returnValue = ""; }
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && $("#btn-salvar")) {
    e.preventDefault();
    salvar();
  }
});

// ============================================================================
// SESSÃO / BOOTSTRAP DE PÁGINA PROTEGIDA
// ============================================================================
async function iniciarPagina() {
  // Sessão e dados em paralelo (antes era um depois do outro) — a página abre mais rápido.
  const [sessao, dados] = await Promise.all([
    api("/api/session").catch(() => ({ logado: false })),
    api("/api/data").catch((err) => ({ __erro: err })),
  ]);
  if (!sessao.logado) { location.href = "/"; return; }
  const label = $("#usuario-logado");
  if (label) label.textContent = sessao.username;
  const avatar = $("#usuario-avatar");
  if (avatar) avatar.textContent = (sessao.username || "?").charAt(0).toUpperCase();
  if (dados.__erro) {
    notificar("Erro ao carregar os dados: " + dados.__erro.message, "erro");
    return;
  }
  aplicarDados(dados);
}

function aplicarDados(dados) {
  ESTADO = dados || { grupos: [], checklist: [], parcelamentos: [] };
  ESTADO.grupos = ESTADO.grupos || [];
  ESTADO.checklist = ESTADO.checklist || [];
  ESTADO.parcelamentos = ESTADO.parcelamentos || [];
  ESTADO.grupos.forEach((g) => (g.empresas || (g.empresas = [])).forEach((e) => {
    e.id = e.id || crypto.randomUUID();
    e.comentarios = e.comentarios || [];
    e.anexos = e.anexos || [];
  }));
  ESTADO.parcelamentos.forEach((p) => {
    p.id = p.id || crypto.randomUUID();
    p.comentarios = p.comentarios || [];
    p.anexos = p.anexos || [];
  });
  limparAlterado();
  // contadores do menu lateral
  const navEmp = $("#nav-cont-empresas"), navPar = $("#nav-cont-parcelamentos");
  if (navEmp) navEmp.textContent = ESTADO.grupos.reduce((n, g) => n + g.empresas.length, 0) || "";
  if (navPar) navPar.textContent = ESTADO.parcelamentos.length || "";
  document.body.classList.add("dados-prontos");
  if (typeof renderizarPagina === "function") renderizarPagina();
}

async function carregarDados() {
  aplicarDados(await api("/api/data"));
}

$("#btn-sair")?.addEventListener("click", async () => {
  if (_alteracoesPendentes && $("#btn-salvar")) {
    const ok = await confirmar("Você tem alterações que ainda não foram salvas. Sair mesmo assim?", { titulo: "Sair sem salvar?", textoOk: "Sair", perigo: true });
    if (!ok) return;
    _alteracoesPendentes = false;
  }
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  location.href = "/";
});

// ============================================================================
// MENU LATERAL (estado já aplicado por icones.js antes da pintura — sem flicker)
// ============================================================================
const _telaPequena = window.matchMedia("(max-width: 900px)");
$("#btn-toggle-sidebar")?.addEventListener("click", () => {
  const raiz = document.documentElement;
  if (_telaPequena.matches) { raiz.classList.toggle("sidebar-mobile-aberta"); return; } // no celular: gaveta, não salva preferência
  const fechada = raiz.classList.toggle("sidebar-fechada");
  try { localStorage.setItem("fzcont_sidebar_fechada", fechada ? "1" : "0"); } catch {}
});
if ($("#barra-lateral")) {
  const veu = document.createElement("div");
  veu.className = "sidebar-veu";
  veu.addEventListener("click", () => document.documentElement.classList.remove("sidebar-mobile-aberta"));
  document.body.appendChild(veu);
}
// Atalho "/" foca a busca da página (como no Gmail/GitHub)
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey) return;
  const alvo = e.target;
  if (alvo && (alvo.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(alvo.tagName))) return;
  const busca = $("#busca") || $("#busca-global") || $("#search-input:not([hidden])");
  if (busca && busca.offsetParent !== null) { e.preventDefault(); busca.focus(); }
});

// ============================================================================
// SALVAR / NOVA LISTA
// ============================================================================
$("#btn-salvar")?.addEventListener("click", () => salvar());

async function salvar() {
  return comCarregando($("#btn-salvar"), async () => {
    try {
      await api("/api/data", { method: "POST", body: JSON.stringify(ESTADO) });
      limparAlterado();
      notificar("Tudo salvo", "ok");
      return true;
    } catch (err) {
      notificar("Erro ao salvar: " + err.message, "erro");
      return false;
    }
  });
}

$("#btn-nova-lista")?.addEventListener("click", async () => {
  const ok = await confirmar(
    "Mantém o nome e os dados de acesso de cada empresa, mas apaga status, checkboxes (NFS/NFE/NFC/Fechado), comentários e anexos de todas elas.\n\nAs tarefas do dia e os parcelamentos NÃO são afetados.",
    { titulo: "Criar uma nova lista?", textoOk: "Criar nova lista", perigo: true }
  );
  if (!ok) return;
  try {
    await api("/api/reset", { method: "POST" });
    await carregarDados();
    notificar("Nova lista criada", "ok");
  } catch (err) {
    notificar("Erro: " + err.message, "erro");
  }
});

// ============================================================================
// PERÍODOS NOMEADOS (ex: "07-2026") — salvar e restaurar no próprio servidor
// ============================================================================
$("#btn-salvar-periodo")?.addEventListener("click", async () => {
  const hoje = new Date();
  const [anoT, mesT] = /^\d{4}-\d{2}$/.test(ESTADO.mesTrabalho || "") ? ESTADO.mesTrabalho.split("-") : [hoje.getFullYear(), String(hoje.getMonth() + 1).padStart(2, "0")];
  const sugestao = `${mesT}-${anoT}`;
  const nome = await perguntar("Salvar período", { mensagem: "Dê um nome para essa cópia (ex: 07-2026).", valor: sugestao, textoOk: "Salvar" });
  if (!nome || !nome.trim()) return;
  try {
    const salvou = await salvar();
    if (salvou === false) return;
    await api("/api/periodos", { method: "POST", body: JSON.stringify({ nome: nome.trim() }) });
    notificar(`Período "${nome.trim()}" salvo`, "ok");
  } catch (err) {
    notificar("Erro ao salvar período: " + err.message, "erro");
  }
});

$("#btn-abrir-periodo")?.addEventListener("click", async () => {
  let periodos = [];
  try {
    ({ periodos } = await api("/api/periodos"));
  } catch (err) {
    notificar(err.message, "erro");
    return;
  }
  abrirModal(`
    <h2>Períodos salvos</h2>
    <p class="modal-sub">Restaurar substitui os dados atuais pelos do período escolhido.</p>
    ${periodos.length === 0 ? `<div class="vazio">${icone("arquivo")}<p>Nenhum período salvo ainda. Use “Salvar período” no menu.</p></div>` : ""}
    <div id="lista-periodos" class="lista-linhas"></div>
  `);
  const lista = $("#lista-periodos");
  periodos.forEach((p) => {
    const item = document.createElement("div");
    item.className = "linha-item";
    const data = new Date(p.criadoEm).toLocaleString("pt-BR");
    item.innerHTML = `
      <span class="linha-icone">${icone("arquivo")}</span>
      <span class="linha-texto"><b>${escaparHtml(p.nome)}</b><small>Salvo em ${escaparHtml(data)}</small></span>
      <button type="button" class="btn-secundario btn-sm" data-restaurar>${icone("atualizar")}Restaurar</button>
      <button type="button" class="btn-icone" data-apagar title="Apagar período">${icone("lixeira")}</button>
    `;
    item.querySelector("[data-restaurar]").addEventListener("click", async (ev) => {
      const ok = await confirmar(`Os dados atuais (empresas, tarefas e parcelamentos) serão SUBSTITUÍDOS pelos do período "${p.nome}".`, { titulo: "Restaurar período?", textoOk: "Restaurar", perigo: true });
      if (!ok) return;
      await comCarregando(ev.currentTarget || item.querySelector("[data-restaurar]"), async () => {
        try {
          await api("/api/periodos/importar", { method: "POST", body: JSON.stringify({ nome: p.nome }) });
          fecharModal();
          await carregarDados();
          notificar(`Período "${p.nome}" restaurado`, "ok");
        } catch (err) {
          notificar(err.message, "erro");
        }
      });
    });
    item.querySelector("[data-apagar]").addEventListener("click", async () => {
      const ok = await confirmar(`Isso não afeta os dados atuais, só remove a cópia "${p.nome}".`, { titulo: "Apagar período salvo?", textoOk: "Apagar", perigo: true });
      if (!ok) return;
      try {
        await api(`/api/periodos/${encodeURIComponent(p.nome)}`, { method: "DELETE" });
        item.classList.add("saindo");
        setTimeout(() => item.remove(), 180);
      } catch (err) {
        notificar(err.message, "erro");
      }
    });
    lista.appendChild(item);
  });
});

// ============================================================================
// BACKUP EM ARQUIVO (exportar/importar .json — cópia offline, fora do servidor)
// ============================================================================
$("#btn-exportar-backup")?.addEventListener("click", async () => {
  const salvou = await salvar();
  if (salvou === false) return;
  const a = document.createElement("a");
  a.href = "/api/backup/export";
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
});

$("#btn-importar-backup")?.addEventListener("click", () => $("#input-importar-backup").click());
$("#input-importar-backup")?.addEventListener("change", async (e) => {
  const arquivo = e.target.files[0];
  if (!arquivo) return;
  const ok = await confirmar("Todos os dados atuais (empresas, checklist e parcelamentos) serão SUBSTITUÍDOS pelo conteúdo do arquivo.", { titulo: "Importar backup?", textoOk: "Importar", perigo: true });
  if (!ok) { e.target.value = ""; return; }
  try {
    const backup = JSON.parse(await arquivo.text());
    await api("/api/backup/import", { method: "POST", body: JSON.stringify(backup) });
    await carregarDados();
    notificar("Backup importado com sucesso", "ok");
  } catch (err) {
    avisar("Erro ao importar backup: " + err.message, { titulo: "Não deu certo", tipo: "erro" });
  }
  e.target.value = "";
});

// ============================================================================
// USUÁRIOS
// ============================================================================
$("#btn-usuarios")?.addEventListener("click", async () => {
  let usuarios = [];
  try {
    ({ usuarios } = await api("/api/users"));
  } catch (err) {
    notificar(err.message, "erro");
    return;
  }
  abrirModal(`
    <h2>Usuários do sistema</h2>
    <div class="lista-linhas" style="margin-bottom:18px">
      ${usuarios.map((u) => `
        <div class="linha-item">
          <span class="avatar-mini">${escaparHtml((u.nome || u.username || "?").charAt(0).toUpperCase())}</span>
          <span class="linha-texto"><b>${escaparHtml(u.nome || u.username)}</b><small>${escaparHtml(u.username)} · ${escaparHtml(u.email || "sem e-mail")}</small></span>
          ${u.confirmado
            ? `<span class="etiqueta etiqueta-ok">${icone("check")}Ativo</span>`
            : `<span class="etiqueta etiqueta-aviso">${icone("relogio")}Aguardando e-mail</span>`}
        </div>`).join("")}
    </div>
    <h3 class="modal-secao">Adicionar funcionário</h3>
    <p class="modal-sub">A pessoa só consegue entrar depois de confirmar o link enviado para o e-mail informado.</p>
    <div class="linha-dois-campos">
      <div class="campo-form"><label>Nome</label><input id="uu-nome" autocomplete="off"></div>
      <div class="campo-form"><label>Usuário (login)</label><input id="uu-usuario" autocomplete="off"></div>
    </div>
    <div class="linha-dois-campos">
      <div class="campo-form"><label>E-mail</label><input id="uu-email" type="email" autocomplete="off"></div>
      <div class="campo-form"><label>Senha (mín. 6 caracteres)</label><input id="uu-senha" type="password" autocomplete="new-password"></div>
    </div>
    <div id="uu-status" class="mensagem-sucesso oculto"></div>
    <div class="modal-rodape">
      <button class="btn-ghost" id="uu-cancelar">Fechar</button>
      <button class="btn-primario" id="uu-salvar">${icone("mais")}Adicionar</button>
    </div>
  `);
  $("#uu-cancelar").addEventListener("click", fecharModal);
  $("#uu-salvar").addEventListener("click", (ev) => comCarregando(ev.currentTarget, async () => {
    const status = $("#uu-status");
    try {
      const resp = await api("/api/users", {
        method: "POST",
        body: JSON.stringify({ username: $("#uu-usuario").value.trim(), password: $("#uu-senha").value, nome: $("#uu-nome").value.trim(), email: $("#uu-email").value.trim() }),
      });
      status.className = "mensagem-sucesso";
      status.textContent = resp.emailFalhou ? `Usuário criado, mas o e-mail de confirmação falhou (${resp.erroEmail}).` : "Usuário criado! Um link de confirmação foi enviado para o e-mail informado.";
    } catch (err) {
      status.className = "mensagem-erro";
      status.textContent = err.message;
    }
  }));
});

// ============================================================================
// BLOCOS DE DETALHE (Comentários e Documentos) — usados em Empresas e Parcelamentos.
// Cada bloco atualiza SÓ a própria lista ao mudar (nada de redesenhar a página).
// ============================================================================
const _RE_DATA_FINAL = /\n(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})\s*$/;

function _htmlComentario(c) {
  const m = _RE_DATA_FINAL.exec(c);
  const texto = m ? c.slice(0, m.index) : c;
  return `<span class="comentario-texto">${escaparHtml(texto)}${m ? `<span class="comentario-data">${escaparHtml(m[1])}</span>` : ""}</span>`;
}

function montarColunaComentarios(entidade, { aoMudar } = {}) {
  const col = document.createElement("div");
  col.className = "coluna-detalhe";
  col.innerHTML = `
    <h4 class="bloco-titulo">${icone("comentario", "ico-sm")}Comentários <span class="contador-pilula"></span></h4>
    <div class="lista-comentarios"></div>
    <form class="form-inline">
      <input placeholder="Escrever comentário..." class="input-comentario" maxlength="2000">
      <button type="submit" class="btn-secundario btn-sm">${icone("mais")}Adicionar</button>
    </form>`;
  const lista = col.querySelector(".lista-comentarios");
  const contador = col.querySelector(".contador-pilula");

  function desenhar() {
    const itens = entidade.comentarios || [];
    contador.textContent = itens.length || "";
    contador.classList.toggle("oculto", !itens.length);
    if (!itens.length) { lista.innerHTML = '<p class="vazio-mini">Nenhum comentário ainda.</p>'; return; }
    lista.innerHTML = itens.map((c, i) => `
      <div class="comentario-item"><span class="comentario-marca"></span>${_htmlComentario(c)}
        <button type="button" class="btn-icone" data-remover="${i}" title="Apagar comentário">${icone("lixeira", "ico-sm")}</button>
      </div>`).join("");
  }
  lista.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remover]");
    if (!btn) return;
    entidade.comentarios.splice(+btn.dataset.remover, 1);
    desenhar();
    marcarAlterado();
    aoMudar && aoMudar();
  });
  col.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const inp = col.querySelector(".input-comentario");
    const texto = inp.value.trim();
    if (!texto) return;
    entidade.comentarios = entidade.comentarios || [];
    entidade.comentarios.push(`${texto}\n${agora()}`);
    inp.value = "";
    desenhar();
    lista.scrollTop = lista.scrollHeight;
    marcarAlterado();
    aoMudar && aoMudar();
  });
  desenhar();
  col.atualizar = desenhar;
  return col;
}

function montarColunaAnexos(entidade, { aoMudar, nomeAlvo = "neste cadastro" } = {}) {
  const col = document.createElement("div");
  col.className = "coluna-detalhe";
  col.innerHTML = `
    <h4 class="bloco-titulo">${icone("clipe", "ico-sm")}Documentos <span class="contador-pilula"></span></h4>
    <div class="lista-anexos"></div>
    <label class="zona-upload">${icone("nuvem")}<span>Arraste arquivos aqui ou <b>clique para escolher</b></span><input type="file" multiple></label>`;
  const lista = col.querySelector(".lista-anexos");
  const contador = col.querySelector(".contador-pilula");
  const zona = col.querySelector(".zona-upload");
  const input = zona.querySelector("input");

  function desenhar() {
    const itens = entidade.anexos || [];
    contador.textContent = itens.length || "";
    contador.classList.toggle("oculto", !itens.length);
    if (!itens.length) { lista.innerHTML = '<p class="vazio-mini">Nenhum documento anexado.</p>'; return; }
    lista.innerHTML = itens.map((a, i) => `
      <div class="anexo-item">${icone("documento", "ico-arquivo")}
        <button type="button" class="anexo-link" data-abrir="${i}" title="${escaparHtml(a.nome)}">${escaparHtml(a.nome)}</button>
        <button type="button" class="btn-icone" data-remover="${i}" title="Remover documento">${icone("lixeira", "ico-sm")}</button>
      </div>`).join("");
  }
  lista.addEventListener("click", async (e) => {
    const abrir = e.target.closest("[data-abrir]");
    if (abrir) return baixarAnexo(entidade.anexos[+abrir.dataset.abrir]);
    const rem = e.target.closest("[data-remover]");
    if (!rem) return;
    const anexo = entidade.anexos[+rem.dataset.remover];
    const ok = await confirmar(`"${anexo.nome}" será removido ${nomeAlvo}.`, { titulo: "Remover documento?", textoOk: "Remover", perigo: true });
    if (!ok) return;
    try { await api(`/api/anexos/${anexo.id}`, { method: "DELETE" }); } catch {}
    const idx = entidade.anexos.indexOf(anexo);
    if (idx >= 0) entidade.anexos.splice(idx, 1);
    desenhar();
    marcarAlterado();
    aoMudar && aoMudar();
  });

  async function enviarArquivos(arquivos) {
    if (!arquivos.length) return;
    entidade.anexos = entidade.anexos || [];
    let enviados = 0, repetidos = 0;
    zona.classList.add("ocupado");
    try {
      for (const arquivo of arquivos) {
        if (entidade.anexos.some((a) => a.nome === arquivo.name)) { repetidos++; continue; }
        notificar(`Enviando "${arquivo.name}"...`, "carregando");
        await anexarArquivoNaLista(entidade.anexos, arquivo);
        enviados++;
        desenhar();
      }
      if (enviados) notificar(enviados === 1 ? "Documento anexado" : `${enviados} documentos anexados`, "ok");
      if (repetidos) notificar(`${repetidos} arquivo(s) já estavam anexados ${nomeAlvo}`, "aviso");
    } catch (err) {
      notificar("Erro ao anexar: " + err.message, "erro");
    } finally {
      zona.classList.remove("ocupado");
      if (enviados) { marcarAlterado(); aoMudar && aoMudar(); }
    }
  }
  input.addEventListener("change", () => { enviarArquivos([...input.files]); input.value = ""; });
  zona.addEventListener("dragover", (e) => { e.preventDefault(); zona.classList.add("arrastando"); });
  zona.addEventListener("dragleave", () => zona.classList.remove("arrastando"));
  zona.addEventListener("drop", (e) => {
    e.preventDefault();
    zona.classList.remove("arrastando");
    enviarArquivos([...(e.dataTransfer?.files || [])]);
  });
  desenhar();
  col.atualizar = desenhar;
  return col;
}

// Botões de status (OK / Pendente / Atenção) — clique de novo desmarca.
function htmlBotoesStatus(atual) {
  const b = (valor, base, ic, rotulo) =>
    `<button type="button" class="pill-toggle ${atual === valor ? base + "-on" : base + "-off"}" data-status="${valor}" aria-pressed="${atual === valor}">${icone(ic)}${rotulo}</button>`;
  return `<span class="segmentado">${b("VERDE", "ok", "check", "OK") + b("VERMELHO", "erro", "x", "Pendente") + b("ATENÇÃO", "atencao", "alerta", "Atenção")}</span>`;
}
function atualizarBotoesStatus(barra, atual) {
  barra.querySelectorAll("[data-status]").forEach((btn) => {
    const base = { VERDE: "ok", VERMELHO: "erro", "ATENÇÃO": "atencao" }[btn.dataset.status];
    const ligado = btn.dataset.status === atual;
    btn.className = `pill-toggle ${base}-${ligado ? "on" : "off"}`;
    btn.setAttribute("aria-pressed", ligado);
  });
}

// Card de KPI com barra segmentada (verde/atenção/pendente/sem status)
function htmlKpi({ nome, total, verde, atencao, vermelho, destaque = false, iconeNome = "pasta" }) {
  const sem = Math.max(total - verde - atencao - vermelho, 0);
  const seg = (classe, n) => (n ? `<span class="${classe}" style="flex-grow:${n}"></span>` : "");
  return `
    <div class="kpi-card${destaque ? " destaque" : ""}">
      <div class="kpi-topo"><span class="kpi-nome" title="${escaparHtml(nome)}">${escaparHtml(nome)}</span><span class="kpi-icone">${icone(iconeNome, "ico-sm")}</span></div>
      <div class="kpi-numero">${total}<small>${total === 1 ? "empresa" : "empresas"}</small></div>
      <div class="kpi-barra" title="${verde} OK · ${atencao} atenção · ${vermelho} pendente · ${sem} sem status">${seg("b-ok", verde)}${seg("b-atencao", atencao)}${seg("b-erro", vermelho)}${seg("b-sem", sem)}${total ? "" : '<span class="b-sem" style="flex-grow:1"></span>'}</div>
      <div class="kpi-legenda">
        <span class="ok">${icone("check")}${verde}</span>
        <span class="atencao">${icone("alerta")}${atencao}</span>
        <span class="erro">${icone("x")}${vermelho}</span>
      </div>
    </div>`;
}

// ============================================================================
// WHATSAPP — abre a conversa já com a mensagem pronta e um link de download
// das guias (link público com validade, gerado pelo Worker). Gratuito e oficial:
// usa os links "clique para conversar" do próprio WhatsApp, sem API.
// ============================================================================
function normalizarWhatsapp(valor) {
  let d = limparDigitos(valor).replace(/^0+/, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;
  return /^55\d{10,11}$/.test(d) ? d : null;
}

function formatarTelefone(valor) {
  let d = limparDigitos(valor);
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return valor || "";
}

function competenciaMesAnterior() {
  const hoje = new Date();
  const m = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  return `${String(m.getMonth() + 1).padStart(2, "0")}/${m.getFullYear()}`;
}

function _lerPref(chave, padrao) { try { return localStorage.getItem(chave) || padrao; } catch { return padrao; } }
function _gravarPref(chave, valor) { try { localStorage.setItem(chave, valor); } catch {} }

// opcoes: { destino, telefone, anexos, tituloLink, montarMensagem(link, validadeTexto), aoEnviar() }
function abrirEnvioWhatsApp({ destino, telefone, anexos, tituloLink, montarMensagem, aoEnviar }) {
  const numero = normalizarWhatsapp(telefone);
  if (!numero) {
    avisar(`O WhatsApp cadastrado (${telefone || "vazio"}) não parece um celular válido. Use DDD + número, ex.: (44) 99999-9999.`, { titulo: "Número inválido", tipo: "aviso" });
    return;
  }
  if (!anexos || !anexos.length) {
    notificar("Não há documentos anexados para enviar.", "aviso");
    return;
  }
  // Data padrão: hoje + último intervalo usado (7 dias na primeira vez)
  const hojeLocal = new Date();
  const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const somarDias = (n) => { const d = new Date(hojeLocal); d.setDate(d.getDate() + n); return d; };
  const diasPadrao = Math.min(Math.max(Number(_lerPref("fzcont_wa_dias", "7")) || 7, 0), 365);
  const brDeIso = (iso) => iso.split("-").reverse().join("/");
  const modoPadrao = _lerPref("fzcont_wa_modo", "web");
  abrirModal(`
    <h2>Enviar por WhatsApp</h2>
    <p class="modal-sub">Para <b>${escaparHtml(destino)}</b> · ${escaparHtml(formatarTelefone(numero))}</p>
    <div class="wa-arquivos">
      <div class="bloco-titulo">${icone("clipe", "ico-sm")}Arquivos no link <span class="contador-pilula">${anexos.length}</span></div>
      ${anexos.map((a) => `<div class="wa-arquivo">${icone("documento", "ico-sm")}<span>${escaparHtml(a.nome)}</span></div>`).join("")}
    </div>
    <div class="linha-dois-campos">
      <div class="campo-form"><label>Arquivos disponíveis até</label>
        <input type="date" id="wa-ate" value="${isoLocal(somarDias(diasPadrao))}" min="${isoLocal(hojeLocal)}" max="${isoLocal(somarDias(365))}" required>
      </div>
      <div class="campo-form"><label>Abrir no</label>
        <select id="wa-modo">
          <option value="web"${modoPadrao === "web" ? " selected" : ""}>WhatsApp Web (navegador)</option>
          <option value="app"${modoPadrao === "app" ? " selected" : ""}>Aplicativo do computador</option>
        </select>
      </div>
    </div>
    <div class="campo-form"><label>Mensagem <span class="wa-status" id="wa-status">${icone("carregando", "girando ico-sm")}gerando link...</span></label>
      <textarea id="wa-mensagem" rows="9" spellcheck="true"></textarea>
    </div>
    <div class="modal-rodape">
      <button type="button" class="btn-ghost" id="wa-cancelar">Cancelar</button>
      <button type="button" class="btn-secundario" id="wa-copiar" disabled>${icone("copiar")}Copiar mensagem</button>
      <button type="button" class="btn-primario btn-whatsapp" id="wa-abrir" disabled>${icone("conversa")}Abrir no WhatsApp</button>
    </div>`);

  const txt = $("#wa-mensagem"), status = $("#wa-status"), btnAbrir = $("#wa-abrir"), btnCopiar = $("#wa-copiar");
  let atual = null; // { url, validadeTexto }
  let geracao = 0;

  async function gerarLink() {
    const minha = ++geracao;
    const ate = $("#wa-ate").value;
    btnAbrir.disabled = btnCopiar.disabled = true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ate) || ate < isoLocal(hojeLocal)) {
      status.innerHTML = `${icone("alerta", "ico-sm")}escolha uma data de hoje em diante`;
      return;
    }
    status.innerHTML = `${icone("carregando", "girando ico-sm")}gerando link...`;
    try {
      const r = await api("/api/compartilhar", { method: "POST", body: JSON.stringify({ anexoIds: anexos.map((a) => a.id), titulo: tituloLink, ate }) });
      if (minha !== geracao || !document.body.contains(txt)) return;
      const novo = { url: r.url, validadeTexto: brDeIso(ate) };
      if (!atual || !txt.value.trim()) txt.value = montarMensagem(novo.url, novo.validadeTexto);
      else txt.value = txt.value.split(atual.url).join(novo.url).split(atual.validadeTexto).join(novo.validadeTexto);
      atual = novo;
      status.innerHTML = `${icone("link", "ico-sm")}link válido até ${escaparHtml(novo.validadeTexto)}`;
      btnAbrir.disabled = btnCopiar.disabled = false;
      if (r.arquivos < anexos.length) notificar(`${anexos.length - r.arquivos} arquivo(s) não estavam mais no armazenamento e ficaram de fora do link.`, "aviso");
    } catch (err) {
      if (minha !== geracao) return;
      status.innerHTML = `${icone("erro", "ico-sm")}${escaparHtml(err.message)}`;
    }
  }

  $("#wa-ate").addEventListener("change", (e) => {
    const [a, m, d] = e.target.value.split("-").map(Number);
    if (a) _gravarPref("fzcont_wa_dias", String(Math.round((new Date(a, m - 1, d) - new Date(hojeLocal.getFullYear(), hojeLocal.getMonth(), hojeLocal.getDate())) / 86400000)));
    gerarLink();
  });
  $("#wa-modo").addEventListener("change", (e) => _gravarPref("fzcont_wa_modo", e.target.value));
  $("#wa-cancelar").addEventListener("click", fecharModal);
  btnCopiar.addEventListener("click", async () => {
    const ok = await copiarParaAreaDeTransferencia(txt.value);
    notificar(ok ? "Mensagem copiada" : "Não consegui copiar", ok ? "ok" : "erro");
  });
  btnAbrir.addEventListener("click", async () => {
    const texto = encodeURIComponent(txt.value);
    const destinoUrl = $("#wa-modo").value === "app"
      ? `whatsapp://send?phone=${numero}&text=${texto}`
      : `https://web.whatsapp.com/send?phone=${numero}&text=${texto}`;
    // Abre de forma síncrona no clique (senão o navegador bloqueia como pop-up)
    if ($("#wa-modo").value === "app") window.location.href = destinoUrl;
    else window.open(destinoUrl, "fzcont_whatsapp");
    fecharModal();
    if (aoEnviar) {
      const marcar = await confirmar("Depois de apertar enviar no WhatsApp, quer registrar o envio?", { titulo: "Mensagem aberta no WhatsApp", textoOk: "Registrar envio" });
      if (marcar) aoEnviar(formatarTelefone(numero));
    }
  });
  gerarLink();
}

// ============================================================================
// MUNICÍPIOS DA NFS-e — cada empresa escolhe o seu (campo "Município da NFS-e").
// IPM (Atende.Net) já funciona; Elotech e Nacional ainda em preparação.
// ============================================================================
const MUNICIPIOS_NFSE = {
  campomourao: { nome: "Campo Mourão", sistema: "ipm" },
  cascavel: { nome: "Cascavel", sistema: "ipm" },
  farol: { nome: "Farol", sistema: "elotech" },
  icaraima: { nome: "Icaraíma", sistema: "elotech" },
  fozdoiguacu: { nome: "Foz do Iguaçu", sistema: "elotech" },
  maringa: { nome: "Maringá", sistema: "nacional" },
  itajai: { nome: "Itajaí", sistema: "nacional" },
};
const SISTEMAS_NFSE = { ipm: "IPM / Atende.Net", elotech: "Elotech", nacional: "NFS-e Nacional" };
const MUNICIPIO_NFSE_PADRAO = "campomourao";
function municipioNfse(e) { const k = MUNICIPIOS_NFSE[e.municipioNfse] ? e.municipioNfse : MUNICIPIO_NFSE_PADRAO; return { chave: k, ...MUNICIPIOS_NFSE[k] }; }

// ============================================================================
// SESSÃO VENCIDA — janela para entrar de novo sem sair da página
// ============================================================================
let _entrandoDeNovo = null;
function entrarDeNovo() {
  if (_entrandoDeNovo) return _entrandoDeNovo; // vários pedidos ao mesmo tempo: uma janela só
  _entrandoDeNovo = new Promise((resolve) => {
    const usuario = ($("#usuario-logado")?.textContent || "").trim();
    const fundo = document.createElement("div");
    fundo.className = "dialogo-fundo";
    fundo.innerHTML = `
      <form class="dialogo" role="dialog" aria-modal="true">
        <div class="dialogo-cabeca">
          <span class="dialogo-icone dialogo-icone-aviso">${icone("cadeado")}</span>
          <h2>Sua sessão expirou</h2>
        </div>
        <div class="dialogo-mensagem">Você ficou mais de 4 horas sem usar o sistema. Entre de novo para continuar — o que está na tela não se perde.</div>
        <input class="dialogo-campo" name="usuario" placeholder="Usuário" autocomplete="username" value="${escaparHtml(usuario)}" required>
        <input class="dialogo-campo" name="senha" type="password" placeholder="Senha" autocomplete="current-password" required>
        <div class="dialogo-erro oculto"></div>
        <div class="dialogo-rodape">
          <button type="button" class="btn-ghost" data-sair>Ir para o login</button>
          <button type="submit" class="btn-primario">Entrar</button>
        </div>
      </form>`;
    document.body.appendChild(fundo);
    const form = fundo.querySelector("form");
    const erro = fundo.querySelector(".dialogo-erro");
    requestAnimationFrame(() => (usuario ? form.senha : form.usuario).focus());
    const fechar = (ok) => { fundo.remove(); _entrandoDeNovo = null; resolve(ok); };
    fundo.querySelector("[data-sair]").addEventListener("click", async () => {
      if (_alteracoesPendentes && !(await confirmar("As alterações que ainda não foram salvas vão se perder.", { titulo: "Ir para o login?", textoOk: "Ir mesmo assim", perigo: true }))) return;
      _alteracoesPendentes = false;
      location.href = "/";
    });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const btn = form.querySelector("[type=submit]");
      btn.disabled = true;
      try {
        const r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: form.usuario.value.trim(), password: form.senha.value }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.erro || "Não foi possível entrar.");
        notificar("Sessão renovada", "ok");
        fechar(true);
      } catch (e) {
        erro.textContent = e.message;
        erro.classList.remove("oculto");
        form.senha.select();
        btn.disabled = false;
      }
    });
  });
  return _entrandoDeNovo;
}

// Topo fixo ganha uma linha de separação quando a página rola
(() => {
  const topo = document.querySelector(".faixa-superior");
  if (!topo) return;
  let pendente = false;
  addEventListener("scroll", () => {
    if (pendente) return;
    pendente = true;
    requestAnimationFrame(() => { topo.classList.toggle("rolou", scrollY > 8); pendente = false; });
  }, { passive: true });
})();

// CNPJ/CPF para exibição: só pontua quando o número está completo (o valor salvo não muda).
function formatarDocumento(v) {
  const d = limparDigitos(v);
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  return String(v || "").trim();
}

// ============================================================================
// PALETA DE COMANDOS (Ctrl+K / ⌘K) — acha qualquer empresa, página ou ação digitando.
// Enter abre · Ctrl+Enter copia o CNPJ da empresa · Esc fecha.
// ============================================================================
const _PAGINAS_PALETA = [
  { rotulo: "Empresas", ic: "empresas", href: "/empresas.html" },
  { rotulo: "Parcelamentos", ic: "parcelamentos", href: "/parcelamentos.html" },
  { rotulo: "Situação Fiscal", ic: "situacao", href: "/situacao-fiscal.html" },
  { rotulo: "XML NFS-e", ic: "xml", href: "/xml-nfse.html" },
  { rotulo: "IntegraContador", ic: "governo", href: "/integracontador.html" },
];
// Ações: só aparecem quando o botão existe na página atual (reaproveita o que o botão já faz).
const _ACOES_PALETA = [
  { rotulo: "Nova empresa", ic: "mais", sel: "#btn-nova-empresa", chaves: "adicionar cadastrar" },
  { rotulo: "Salvar", ic: "salvar", sel: "#btn-salvar", chaves: "gravar" },
  { rotulo: "WhatsApp em lote", ic: "conversa", sel: "#btn-whatsapp-lote", chaves: "mensagem enviar" },
  { rotulo: "Verificar exclusões do Simples", ic: "proibido", sel: "#btn-verificar-exclusoes", chaves: "simples nacional" },
  { rotulo: "Nova tarefa", ic: "tarefas", sel: "#btn-nova-tarefa", chaves: "tarefa lembrete" },
  { rotulo: "Novo parcelamento", ic: "mais", sel: "#btn-novo-parcelamento", chaves: "adicionar" },
  { rotulo: "Mês de trabalho e períodos", ic: "calendario", sel: "#btn-competencia", chaves: "competencia periodo mes" },
  { rotulo: "Salvar período", ic: "arquivo", sel: "#btn-salvar-periodo", chaves: "competencia" },
  { rotulo: "Abrir período", ic: "pastaAberta", sel: "#btn-abrir-periodo", chaves: "restaurar competencia" },
  { rotulo: "Importar PDFs em lote", ic: "arquivos", sel: "#btn-importar-pdfs", chaves: "guias das" },
  { rotulo: "Exportar backup", ic: "baixar", sel: "#btn-exportar-backup", chaves: "copia" },
  { rotulo: "Usuários", ic: "usuarios", sel: "#btn-usuarios", chaves: "equipe acesso" },
  { rotulo: "Sair", ic: "sair", sel: "#btn-sair", chaves: "logout deslogar" },
];
const _semAcento = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function _itensPaleta(termo) {
  const t = _semAcento(termo).trim();
  const td = limparDigitos(termo);
  const pontua = (texto) => { const x = _semAcento(texto); if (!t) return 1; if (x.startsWith(t)) return 3; if (x.includes(" " + t)) return 2; return x.includes(t) ? 1 : 0; };
  const empresas = (ESTADO.grupos || []).flatMap((g) => (g.empresas || []).map((e) => ({ e, g })))
    .map(({ e, g }) => {
      let p = pontua(e.nome);
      if (td.length >= 3 && limparDigitos(e.cnpj).includes(td)) p = Math.max(p, 2);
      return { tipo: "empresa", e, grupo: g.nome, p };
    })
    .filter((x) => x.p > 0 && (t || td))
    .sort((a, b) => b.p - a.p || String(a.e.nome).localeCompare(String(b.e.nome), "pt-BR"))
    .slice(0, 7);
  const acoes = _ACOES_PALETA.filter((a) => { const el = $(a.sel); return el && el.offsetParent !== null && !el.disabled; })
    .map((a) => ({ tipo: "acao", ...a, p: Math.max(pontua(a.rotulo), pontua(a.chaves)) })).filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p).slice(0, t ? 5 : 6);
  const aqui = location.pathname;
  const paginas = _PAGINAS_PALETA.filter((pg) => pg.href !== aqui).map((pg) => ({ tipo: "pagina", ...pg, p: pontua(pg.rotulo) })).filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p);
  return [
    ...(empresas.length ? [{ cab: "Empresas" }, ...empresas] : []),
    ...(acoes.length ? [{ cab: "Ações" }, ...acoes] : []),
    ...(paginas.length ? [{ cab: "Ir para" }, ...paginas] : []),
  ];
}

let _paletaAberta = false;
async function abrirPaleta() {
  if (_paletaAberta) return;
  _paletaAberta = true;
  // páginas que ainda não carregaram as empresas (ex.: Situação Fiscal) buscam uma vez
  if (!(ESTADO.grupos || []).length) { try { const d = await api("/api/data"); if (d && d.grupos) ESTADO.grupos = d.grupos; } catch {} }
  const fundo = document.createElement("div");
  fundo.className = "paleta-fundo";
  fundo.innerHTML = `
    <div class="paleta" role="dialog" aria-modal="true" aria-label="Paleta de comandos">
      <label class="paleta-busca">${icone("busca")}<input type="text" placeholder="Buscar empresa, CNPJ, página ou ação…" autocomplete="off" spellcheck="false" aria-label="Buscar"><kbd>Esc</kbd></label>
      <div class="paleta-lista" role="listbox"></div>
      <div class="paleta-rodape"><span><kbd>↑</kbd><kbd>↓</kbd> navegar</span><span><kbd>Enter</kbd> abrir</span><span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> copiar CNPJ</span></div>
    </div>`;
  document.body.appendChild(fundo);
  const input = fundo.querySelector("input"), lista = fundo.querySelector(".paleta-lista");
  let itens = [], ativo = 0;
  const selecionaveis = () => itens.filter((x) => !x.cab);
  const desenhar = () => {
    itens = _itensPaleta(input.value);
    const sel = selecionaveis();
    ativo = Math.min(ativo, Math.max(sel.length - 1, 0));
    let i = -1;
    lista.innerHTML = itens.length ? itens.map((x) => {
      if (x.cab) return `<div class="paleta-cab">${x.cab}</div>`;
      i++;
      const atual = i === ativo ? " ativo" : "";
      if (x.tipo === "empresa") {
        const st = { VERDE: "ok", VERMELHO: "erro", "ATENÇÃO": "atencao" }[x.e.status];
        return `<button type="button" class="paleta-item${atual}" data-i="${i}" role="option"><span class="paleta-ic empresa">${escaparHtml(String(x.e.nome || "?").trim().charAt(0).toUpperCase())}</span><span class="paleta-txt"><b>${escaparHtml(x.e.nome)}</b><small>${escaparHtml(formatarDocumento(x.e.cnpj) || "sem CNPJ")} · ${escaparHtml(x.grupo)}</small></span>${st ? `<span class="paleta-st st-${st}"></span>` : ""}</button>`;
      }
      return `<button type="button" class="paleta-item${atual}" data-i="${i}" role="option"><span class="paleta-ic">${icone(x.ic)}</span><span class="paleta-txt"><b>${escaparHtml(x.rotulo)}</b></span><span class="paleta-tipo">${x.tipo === "acao" ? "ação" : "página"}</span></button>`;
    }).join("") : `<div class="paleta-vazio">Nada encontrado para “${escaparHtml(input.value)}”.</div>`;
    lista.querySelector(".ativo")?.scrollIntoView({ block: "nearest" });
  };
  const fechar = () => { _paletaAberta = false; fundo.classList.add("saindo"); setTimeout(() => fundo.remove(), 130); document.removeEventListener("keydown", tecla, true); };
  const executar = (x, copiarCnpj) => {
    if (!x) return;
    fechar();
    if (x.tipo === "empresa") {
      if (copiarCnpj) return x.e.cnpj ? copiar("CNPJ", x.e.cnpj) : notificar("Essa empresa não tem CNPJ cadastrado.", "aviso");
      if (typeof irParaEmpresa === "function" && location.pathname.endsWith("/empresas.html")) return irParaEmpresa(x.e);
      location.href = "/empresas.html?empresa=" + encodeURIComponent(x.e.id);
    } else if (x.tipo === "acao") { setTimeout(() => $(x.sel)?.click(), 140); }
    else location.href = x.href;
  };
  function tecla(e) {
    const sel = selecionaveis();
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); fechar(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); ativo = (ativo + 1) % Math.max(sel.length, 1); desenhar(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); ativo = (ativo - 1 + sel.length) % Math.max(sel.length, 1); desenhar(); }
    else if (e.key === "Enter") { e.preventDefault(); executar(sel[ativo], e.ctrlKey || e.metaKey); }
  }
  document.addEventListener("keydown", tecla, true);
  input.addEventListener("input", () => { ativo = 0; desenhar(); });
  lista.addEventListener("mousemove", (e) => { const b = e.target.closest("[data-i]"); if (b && +b.dataset.i !== ativo) { ativo = +b.dataset.i; lista.querySelectorAll(".paleta-item").forEach((x) => x.classList.toggle("ativo", +x.dataset.i === ativo)); } });
  lista.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) executar(selecionaveis()[+b.dataset.i], e.ctrlKey || e.metaKey); });
  fundo.addEventListener("mousedown", (e) => { if (e.target === fundo) fechar(); });
  desenhar();
  requestAnimationFrame(() => input.focus());
}
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); abrirPaleta(); }
});
// no menu lateral: o "/" vira "Ctrl K" e abre a paleta (o campo continua filtrando como antes)
(() => {
  const kbd = document.querySelector(".busca-menu kbd");
  if (!kbd) return;
  kbd.textContent = "Ctrl K";
  kbd.classList.add("kbd-paleta");
  kbd.title = "Buscar tudo: empresas, páginas e ações (Ctrl+K)";
  kbd.addEventListener("mousedown", (e) => { e.preventDefault(); abrirPaleta(); });
})();
