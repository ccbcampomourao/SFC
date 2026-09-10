// ============================================================================
// common.js — utilitários e ações compartilhadas entre as páginas autenticadas
// (empresas.html e parcelamentos.html). A tela de login (index.html) também
// carrega esse arquivo só pelos helpers básicos ($, $$, api).
// ============================================================================
let ESTADO = { grupos: [], checklist: [], parcelamentos: [] };

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

async function api(caminho, opcoes = {}) {
  const resp = await fetch(caminho, { headers: { "Content-Type": "application/json" }, ...opcoes });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = new Error(dados.erro || "Erro na requisição");
    Object.assign(erro, dados);
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

function escaparHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
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
  return `<button type="button" class="chip-copia ${classeExtra}" data-copiar="${rotulo}" title="${rotulo}: ${valor}">${rotulo}</button>`;
}

function copiar(rotulo, texto) {
  if (!texto) return;
  navigator.clipboard.writeText(texto).then(() => notificar(`${rotulo} copiado para a área de transferência`));
}

function notificar(msg) {
  const box = $("#status-salvar");
  if (!box) return;
  box.textContent = msg;
  box.classList.remove("oculto");
  setTimeout(() => box.classList.add("oculto"), 2200);
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
// LEITURA DE PDF (pdf.js) — usada pela importação em lote de guias/DAS,
// igual ao "processarPdfDas"/"processarPdfParcelamento" do app original.
// ---------------------------------------------------------------------------
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

async function extrairTextoPdf(arquivo) {
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
// MODAL GENÉRICO
// ============================================================================
function abrirModal(html) {
  $("#modal-conteudo").innerHTML = html;
  $("#modal-fundo").classList.remove("oculto");
}
function fecharModal() {
  $("#modal-fundo").classList.add("oculto");
  $("#modal-conteudo").innerHTML = "";
}
$("#modal-fundo")?.addEventListener("click", (e) => { if (e.target.id === "modal-fundo") fecharModal(); });

// ============================================================================
// SESSÃO / BOOTSTRAP DE PÁGINA PROTEGIDA (chamado por empresas.js e parcelamentos.js)
// ============================================================================
async function iniciarPagina() {
  const sessao = await api("/api/session").catch(() => ({ logado: false }));
  if (!sessao.logado) { location.href = "/"; return; }
  const label = $("#usuario-logado");
  if (label) label.textContent = `Logado como ${sessao.username}`;
  await carregarDados();
}

async function carregarDados() {
  ESTADO = await api("/api/data");
  ESTADO.parcelamentos = ESTADO.parcelamentos || [];
  if (typeof renderizarPagina === "function") renderizarPagina();
}

$("#btn-sair")?.addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.href = "/";
});

// ============================================================================
// ABRIR/FECHAR A BARRA LATERAL (preferência salva no navegador, vale pras 3 páginas)
// ============================================================================
function inicializarBarraLateral() {
  const barra = $("#barra-lateral");
  const botao = $("#btn-toggle-sidebar");
  if (!barra || !botao) return;

  const fechada = localStorage.getItem("fzcont_sidebar_fechada") === "1";
  barra.classList.toggle("colapsada", fechada);

  botao.addEventListener("click", () => {
    const agoraFechada = barra.classList.toggle("colapsada");
    localStorage.setItem("fzcont_sidebar_fechada", agoraFechada ? "1" : "0");
  });
}
inicializarBarraLateral();

// ============================================================================
// SALVAR / NOVA LISTA
// ============================================================================
$("#btn-salvar")?.addEventListener("click", salvar);

async function salvar() {
  const box = $("#status-salvar");
  try {
    await api("/api/data", { method: "POST", body: JSON.stringify(ESTADO) });
    box.textContent = "✓ Salvo com sucesso";
    box.classList.remove("oculto");
    setTimeout(() => box.classList.add("oculto"), 2200);
  } catch (err) {
    box.textContent = "Erro ao salvar: " + err.message;
    box.classList.remove("oculto");
  }
}

$("#btn-nova-lista")?.addEventListener("click", async () => {
  const ok = confirm(
    "Isso cria uma NOVA LISTA: mantém o nome e os dados de acesso de cada empresa, " +
    "mas apaga status, checkboxes (NFS/NFE/NFC/Fechado), comentários e anexos de todas elas.\n\n" +
    "As tarefas do dia e os parcelamentos NÃO são afetados. Deseja continuar?"
  );
  if (!ok) return;
  await api("/api/reset", { method: "POST" });
  await carregarDados();
});

// ============================================================================
// PERÍODOS NOMEADOS (ex: "07-2026") — salvar e restaurar no próprio servidor
// ============================================================================
$("#btn-salvar-periodo")?.addEventListener("click", async () => {
  const nome = prompt("Nome do período (ex: 07-2026):");
  if (!nome || !nome.trim()) return;
  try {
    await salvar();
    await api("/api/periodos", { method: "POST", body: JSON.stringify({ nome: nome.trim() }) });
    notificar(`✅ Período "${nome.trim()}" salvo`);
  } catch (err) {
    alert("Erro ao salvar período: " + err.message);
  }
});

$("#btn-abrir-periodo")?.addEventListener("click", async () => {
  let periodos = [];
  try {
    ({ periodos } = await api("/api/periodos"));
  } catch (err) {
    alert(err.message);
    return;
  }
  const html = `
    <h2>Períodos salvos</h2>
    ${periodos.length === 0 ? '<p class="comentario-linha">Nenhum período salvo ainda. Use "Salvar Período" na barra de cima.</p>' : ""}
    <div id="lista-periodos"></div>
  `;
  abrirModal(html);
  const lista = $("#lista-periodos");
  periodos.forEach((p) => {
    const item = document.createElement("div");
    item.className = "comentario-item";
    const data = new Date(p.criadoEm).toLocaleString("pt-BR");
    item.innerHTML = `
      <span class="comentario-texto"><b>${escaparHtml(p.nome)}</b> — salvo em ${data}</span>
      <button type="button" class="btn-secundario" data-restaurar="${escaparHtml(p.nome)}">Restaurar</button>
      <button type="button" class="btn-icone" data-apagar="${escaparHtml(p.nome)}">🗑</button>
    `;
    item.querySelector("[data-restaurar]").addEventListener("click", async () => {
      if (!confirm(`Restaurar o período "${p.nome}"? Isso vai SUBSTITUIR os dados atuais (empresas, tarefas e parcelamentos).`)) return;
      try {
        await api("/api/periodos/importar", { method: "POST", body: JSON.stringify({ nome: p.nome }) });
        fecharModal();
        await carregarDados();
        notificar(`✅ Período "${p.nome}" restaurado`);
      } catch (err) {
        alert(err.message);
      }
    });
    item.querySelector("[data-apagar]").addEventListener("click", async () => {
      if (!confirm(`Apagar o período salvo "${p.nome}"? Isso não afeta os dados atuais, só remove esse arquivo salvo.`)) return;
      try {
        await api(`/api/periodos/${encodeURIComponent(p.nome)}`, { method: "DELETE" });
        item.remove();
      } catch (err) {
        alert(err.message);
      }
    });
    lista.appendChild(item);
  });
});

// ============================================================================
// BACKUP EM ARQUIVO (exportar/importar .json — cópia offline, fora do servidor)
// ============================================================================
$("#btn-exportar-backup")?.addEventListener("click", async () => {
  await salvar();
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
  const ok = confirm("Importar esse backup vai SUBSTITUIR todos os dados atuais (empresas, checklist e parcelamentos). Deseja continuar?");
  if (!ok) { e.target.value = ""; return; }
  try {
    const texto = await arquivo.text();
    const backup = JSON.parse(texto);
    await api("/api/backup/import", { method: "POST", body: JSON.stringify(backup) });
    await carregarDados();
    alert("Backup importado com sucesso!");
  } catch (err) {
    alert("Erro ao importar backup: " + err.message);
  }
  e.target.value = "";
});

// ============================================================================
// USUÁRIOS
// ============================================================================
$("#btn-usuarios")?.addEventListener("click", async () => {
  const { usuarios } = await api("/api/users");
  const html = `
    <h2>Usuários do sistema</h2>
    <div id="lista-usuarios">
      ${usuarios.map((u) => `<div class="comentario-linha">${u.confirmado ? "✅" : "⏳"} ${u.nome} (${u.username}) — ${u.email || "sem e-mail"} ${u.confirmado ? "" : "<i>(aguardando confirmação por e-mail)</i>"}</div>`).join("")}
    </div>
    <hr style="margin:16px 0;border:none;border-top:1px solid var(--borda)">
    <h3 style="font-size:13px">Adicionar funcionário</h3>
    <p style="font-size:12px;color:var(--texto-suave);margin-top:-4px">A pessoa só consegue entrar depois de confirmar o link que vai chegar no e-mail informado.</p>
    <div class="campo-form"><label>Nome</label><input id="uu-nome"></div>
    <div class="campo-form"><label>Usuário (login)</label><input id="uu-usuario"></div>
    <div class="campo-form"><label>E-mail</label><input id="uu-email" type="email"></div>
    <div class="campo-form"><label>Senha (mín. 6 caracteres)</label><input id="uu-senha" type="password"></div>
    <div id="uu-status" class="mensagem-sucesso oculto" style="margin-bottom:10px"></div>
    <div class="modal-rodape">
      <button class="btn-ghost" id="uu-cancelar">Fechar</button>
      <button class="btn-primario" id="uu-salvar">Adicionar</button>
    </div>
  `;
  abrirModal(html);
  $("#uu-cancelar").addEventListener("click", fecharModal);
  $("#uu-salvar").addEventListener("click", async () => {
    const status = $("#uu-status");
    try {
      const resp = await api("/api/users", {
        method: "POST",
        body: JSON.stringify({ username: $("#uu-usuario").value.trim(), password: $("#uu-senha").value, nome: $("#uu-nome").value.trim(), email: $("#uu-email").value.trim() }),
      });
      status.textContent = resp.emailFalhou ? `Usuário criado, mas o e-mail de confirmação falhou (${resp.erroEmail}).` : "Usuário criado! Um link de confirmação foi enviado para o e-mail informado.";
      status.classList.remove("oculto");
    } catch (err) { alert(err.message); }
  });
});
