// ============================================================================
// Estado em memória (carregado do servidor, editado aqui, salvo no clique de "Salvar")
// ============================================================================
let ESTADO = { grupos: [], checklist: [], parcelamentos: [] };
let GRUPOS_ABERTOS = new Set();
let EMPRESAS_ABERTAS = new Set();
let PARCELAMENTOS_ABERTOS = new Set();

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

async function api(caminho, opcoes = {}) {
  const resp = await fetch(caminho, { headers: { "Content-Type": "application/json" }, ...opcoes });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(dados.erro || "Erro na requisição");
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

// ============================================================================
// LOGIN / SETUP
// ============================================================================
async function iniciar() {
  const { necessario } = await api("/api/setup/necessario");
  if (necessario) {
    $("#login-subtitulo").textContent = "Crie o primeiro acesso do sistema";
    $("#campo-nome-setup").classList.remove("oculto");
    $("#campo-email-setup").classList.remove("oculto");
    $("#btn-login-submit").textContent = "Criar conta";
    $("#form-login").dataset.modo = "setup";
  } else {
    const { logado } = await api("/api/session");
    if (logado) return mostrarApp();
  }
}

$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const usuario = $("#login-usuario").value.trim();
  const senha = $("#login-senha").value;
  const nome = $("#login-nome").value.trim();
  const email = $("#login-email").value.trim();
  const erroBox = $("#login-erro");
  erroBox.classList.remove("mensagem-sucesso");
  erroBox.classList.add("mensagem-erro");
  erroBox.classList.add("oculto");
  try {
    if ($("#form-login").dataset.modo === "setup") {
      const resp = await api("/api/setup", { method: "POST", body: JSON.stringify({ username: usuario, password: senha, nome, email }) });
      erroBox.classList.remove("mensagem-erro");
      erroBox.classList.add("mensagem-sucesso");
      erroBox.textContent = resp.emailFalhou
        ? `Conta criada, mas não consegui enviar o e-mail de confirmação (${resp.erroEmail}). Avise o administrador para configurar o Gmail no servidor.`
        : `Conta criada! Enviamos um link de confirmação para ${email}. Abra seu e-mail (e o spam) e clique no link antes de entrar.`;
      erroBox.classList.remove("oculto");
      $("#form-login").reset();
      $("#form-login").dataset.modo = "login";
      $("#campo-nome-setup").classList.add("oculto");
      $("#campo-email-setup").classList.add("oculto");
      $("#login-subtitulo").textContent = "Entre com seu usuário e senha";
      $("#btn-login-submit").textContent = "Entrar";
      return;
    }
    await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: usuario, password: senha }) });
    mostrarApp();
  } catch (err) {
    erroBox.textContent = err.message;
    erroBox.classList.remove("oculto");
  }
});

async function mostrarApp() {
  $("#tela-login").classList.add("oculto");
  $("#app").classList.remove("oculto");
  const sessao = await api("/api/session");
  $("#usuario-logado").textContent = sessao.username ? `Logado como ${sessao.username}` : "";
  await carregarDados();
}

$("#btn-sair").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.reload();
});

// ============================================================================
// CARREGAR / SALVAR
// ============================================================================
async function carregarDados() {
  ESTADO = await api("/api/data");
  ESTADO.parcelamentos = ESTADO.parcelamentos || [];
  renderTudo();
}

function renderTudo() {
  renderizarDashboard();
  renderizarGrupos();
  renderizarChecklist();
  sincronizarParcelamentosComEmpresas();
  renderizarParcelamentos();
}

$("#btn-salvar").addEventListener("click", salvar);

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

$("#btn-nova-lista").addEventListener("click", async () => {
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
// BACKUP (exportar/importar entre períodos)
// ============================================================================
$("#btn-exportar-backup").addEventListener("click", async () => {
  await salvar();
  const a = document.createElement("a");
  a.href = "/api/backup/export";
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
});

$("#btn-importar-backup").addEventListener("click", () => $("#input-importar-backup").click());
$("#input-importar-backup").addEventListener("change", async (e) => {
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
// NAVEGAÇÃO ENTRE ABAS
// ============================================================================
$$(".topo-acoes [data-aba]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const aba = btn.dataset.aba;
    $$(".conteudo").forEach((c) => c.classList.add("oculto"));
    $(`#aba-${aba}`).classList.remove("oculto");
    if (aba === "parcelamentos") {
      sincronizarParcelamentosComEmpresas();
      renderizarParcelamentos();
    }
  });
});

$("#busca-empresa").addEventListener("input", (e) => renderizarGrupos(e.target.value.toLowerCase()));

// ============================================================================
// DASHBOARD
// ============================================================================
function contarStatus(lista, campoStatus) {
  let verde = 0, vermelho = 0, atencao = 0;
  lista.forEach((item) => {
    if (item[campoStatus] === "VERDE") verde++;
    else if (item[campoStatus] === "VERMELHO") vermelho++;
    else if (item[campoStatus] === "ATENÇÃO") atencao++;
  });
  return { verde, vermelho, atencao };
}

function renderizarDashboard() {
  const cont = $("#dashboard");
  cont.innerHTML = "";
  let totalGlobal = 0;

  ESTADO.grupos.forEach((g) => {
    totalGlobal += g.empresas.length;
    const { verde, vermelho, atencao } = contarStatus(g.empresas, "status");
    const card = document.createElement("div");
    card.className = "dash-card";
    card.innerHTML = `
      <div class="dash-nome">${g.nome}</div>
      <div class="dash-total">Total: ${g.empresas.length}</div>
      <div class="dash-contadores">
        <span class="ok">✓ ${verde}</span>
        <span class="atencao">! ${atencao}</span>
        <span class="erro">✕ ${vermelho}</span>
      </div>
    `;
    cont.appendChild(card);
  });

  const cardTotal = document.createElement("div");
  cardTotal.className = "dash-card total";
  cardTotal.innerHTML = `
    <div class="dash-nome">GERAL</div>
    <div class="dash-total-num">${totalGlobal}</div>
  `;
  cont.insertBefore(cardTotal, cont.children[Math.floor(cont.children.length / 2)] || null);
}

function renderizarDashboardParcelamentos() {
  const cont = $("#dashboard-parcelamentos");
  const { verde, vermelho, atencao } = contarStatus(ESTADO.parcelamentos, "statusGeral");
  cont.innerHTML = `
    <div class="dash-card total">
      <div class="dash-nome">PARCELAMENTOS</div>
      <div class="dash-total-num">${ESTADO.parcelamentos.length}</div>
      <div class="dash-contadores" style="margin-top:6px">
        <span class="ok">✓ ${verde}</span>
        <span class="atencao">! ${atencao}</span>
        <span class="erro">✕ ${vermelho}</span>
      </div>
    </div>
  `;
}

// ============================================================================
// UTILITÁRIOS DE CÓPIA / NOTIFICAÇÃO
// ============================================================================
function copiar(rotulo, texto) {
  if (!texto) return;
  navigator.clipboard.writeText(texto).then(() => notificar(`${rotulo} copiado para a área de transferência`));
}
function notificar(msg) {
  const box = $("#status-salvar");
  box.textContent = msg;
  box.classList.remove("oculto");
  setTimeout(() => box.classList.add("oculto"), 2200);
}

// ============================================================================
// GRUPOS / EMPRESAS
// ============================================================================
function classeStatus(status) {
  return status === "VERDE" ? "VERDE" : status === "VERMELHO" ? "VERMELHO" : status === "ATENÇÃO" ? "ATENCAO" : "";
}

$("#btn-novo-grupo").addEventListener("click", () => {
  const nome = prompt("Nome do novo grupo:");
  if (!nome) return;
  ESTADO.grupos.push({ nome, empresas: [] });
  renderizarGrupos();
  renderizarDashboard();
});

function renderizarGrupos(filtro = "") {
  const cont = $("#lista-grupos");
  cont.innerHTML = "";

  ESTADO.grupos.forEach((grupo, gi) => {
    const empresasFiltradas = grupo.empresas.filter(
      (e) => e.nome.toLowerCase().includes(filtro) || (e.cnpj || "").includes(filtro)
    );
    if (filtro && empresasFiltradas.length === 0) return;

    const aberto = GRUPOS_ABERTOS.has(gi) || !!filtro;

    const card = document.createElement("div");
    card.className = "grupo-card";

    const cabecalho = document.createElement("div");
    cabecalho.className = "grupo-cabecalho";
    cabecalho.innerHTML = `<h3>📁 ${grupo.nome}</h3><span class="contagem">${grupo.empresas.length} empresa(s) ${aberto ? "▾" : "▸"}</span>`;
    cabecalho.addEventListener("click", () => {
      if (GRUPOS_ABERTOS.has(gi)) GRUPOS_ABERTOS.delete(gi);
      else GRUPOS_ABERTOS.add(gi);
      renderizarGrupos(filtro);
    });
    card.appendChild(cabecalho);

    if (aberto) {
      const corpo = document.createElement("div");
      corpo.className = "grupo-corpo";

      const btnAdd = document.createElement("button");
      btnAdd.className = "btn-secundario";
      btnAdd.textContent = "+ Empresa";
      btnAdd.style.alignSelf = "flex-start";
      btnAdd.addEventListener("click", () => abrirFormNovaEmpresa(gi));
      corpo.appendChild(btnAdd);

      empresasFiltradas.forEach((empresa) => {
        const ei = grupo.empresas.indexOf(empresa);
        corpo.appendChild(criarEmpresaCard(empresa, gi, ei));
      });

      card.appendChild(corpo);
    }
    cont.appendChild(card);
  });
}

function abrirFormNovaEmpresa(gi) {
  const html = `
    <h2>Nova empresa</h2>
    <div class="campo-form"><label>CNPJ (apenas números)</label><input id="ne-cnpj"></div>
    <div class="campo-form"><label>Nome (opcional)</label><input id="ne-nome"></div>
    <div class="modal-rodape">
      <button class="btn-ghost" id="ne-cancelar">Cancelar</button>
      <button class="btn-primario" id="ne-salvar">Adicionar</button>
    </div>
  `;
  abrirModal(html);
  $("#ne-cancelar").addEventListener("click", fecharModal);
  $("#ne-salvar").addEventListener("click", () => {
    const cnpj = $("#ne-cnpj").value.trim();
    const nome = $("#ne-nome").value.trim();
    if (!cnpj && !nome) return alert("Informe ao menos o CNPJ ou o nome.");
    ESTADO.grupos[gi].empresas.push({
      nome: nome || "Empresa sem nome",
      status: "SEM", nfs: false, nfe: false, nfc: false, fechado: false,
      cnpj, cpf: "", senhaPrefeitura: "", senhaRegularize: "", inscricaoEstadual: "", email: "",
      comentarios: [], anexos: [],
    });
    fecharModal();
    GRUPOS_ABERTOS.add(gi);
    renderizarGrupos();
    renderizarDashboard();
  });
}

function botaoCopiaSe(valor, rotulo, classeExtra = "") {
  if (!valor) return "";
  return `<button type="button" class="chip-copia ${classeExtra}" data-copiar="${rotulo}" title="${rotulo}: ${valor}">${rotulo}</button>`;
}

function criarEmpresaCard(empresa, gi, ei) {
  const wrap = document.createElement("div");
  wrap.className = `empresa-card ${classeStatus(empresa.status)}`;
  const chaveAberta = `${gi}:${ei}`;
  const aberto = EMPRESAS_ABERTAS.has(chaveAberta);

  const header = document.createElement("div");
  header.className = "empresa-header";
  header.innerHTML = `
    <div class="empresa-nome-wrap">
      ${empresa.anexos.length ? '<span class="selo-anexado">ANEXADO</span>' : ""}
      <span class="empresa-nome">🏢 ${empresa.nome}</span>
    </div>
    ${botaoCopiaSe(empresa.cnpj, "CNPJ")}
    ${botaoCopiaSe(empresa.cpf, "CPF")}
    ${botaoCopiaSe(empresa.inscricaoEstadual, "IE")}
    ${botaoCopiaSe(empresa.senhaPrefeitura, "Prefeitura")}
    ${botaoCopiaSe(empresa.senhaRegularize, "Regularize")}
    ${empresa.email ? `<button type="button" class="chip-copia chip-email" data-email="1">Enviar E-mail</button>` : ""}
    <span style="flex:1"></span>
    <button type="button" class="btn-icone" data-excluir="1" title="Excluir empresa">🗑</button>
  `;
  header.addEventListener("click", (e) => {
    if (e.target.closest("[data-copiar]") || e.target.closest("[data-email]") || e.target.closest("[data-excluir]")) return;
    if (EMPRESAS_ABERTAS.has(chaveAberta)) EMPRESAS_ABERTAS.delete(chaveAberta);
    else EMPRESAS_ABERTAS.add(chaveAberta);
    renderizarGrupos($("#busca-empresa").value.toLowerCase());
  });

  header.querySelectorAll("[data-copiar]").forEach((btn) => {
    const rotulo = btn.dataset.copiar;
    const mapa = { CNPJ: empresa.cnpj, CPF: empresa.cpf, IE: empresa.inscricaoEstadual, Prefeitura: empresa.senhaPrefeitura, Regularize: empresa.senhaRegularize };
    btn.addEventListener("click", (e) => { e.stopPropagation(); copiar(rotulo, mapa[rotulo]); });
  });
  const btnEmail = header.querySelector("[data-email]");
  if (btnEmail) btnEmail.addEventListener("click", (e) => { e.stopPropagation(); enviarEmailEmpresa(empresa); });
  header.querySelector("[data-excluir]").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!confirm(`Excluir "${empresa.nome}"? Essa ação não pode ser desfeita.`)) return;
    ESTADO.grupos[gi].empresas.splice(ei, 1);
    const p = encontrarParcelamentoDe(empresa);
    if (p) ESTADO.parcelamentos.splice(ESTADO.parcelamentos.indexOf(p), 1);
    renderizarGrupos($("#busca-empresa").value.toLowerCase());
    renderizarDashboard();
  });

  wrap.appendChild(header);

  if (aberto) {
    wrap.appendChild(criarCorpoEmpresa(empresa, gi, ei));
  }
  return wrap;
}

function criarCorpoEmpresa(empresa, gi, ei) {
  const corpo = document.createElement("div");
  corpo.className = "empresa-corpo";

  // ---- Barra de opções: status (3 botões independentes) + checkboxes ----
  const barra = document.createElement("div");
  barra.className = "barra-opcoes";
  barra.innerHTML = `
    <button type="button" class="pill-toggle ${empresa.status === "VERDE" ? "ok-on" : "ok-off"}" data-status="VERDE">✓ OK</button>
    <button type="button" class="pill-toggle ${empresa.status === "VERMELHO" ? "erro-on" : "erro-off"}" data-status="VERMELHO">✕ PENDENTE</button>
    <button type="button" class="pill-toggle ${empresa.status === "ATENÇÃO" ? "atencao-on" : "atencao-off"}" data-status="ATENÇÃO">! ATENÇÃO</button>
    <span class="separador-v"></span>
    <label class="chip-check ${empresa.nfs ? "marcado" : ""}"><input type="checkbox" data-cb="nfs" ${empresa.nfs ? "checked" : ""}> NFS</label>
    <label class="chip-check ${empresa.nfe ? "marcado" : ""}"><input type="checkbox" data-cb="nfe" ${empresa.nfe ? "checked" : ""}> NFE</label>
    <label class="chip-check ${empresa.nfc ? "marcado" : ""}"><input type="checkbox" data-cb="nfc" ${empresa.nfc ? "checked" : ""}> NFC</label>
    <label class="chip-check fechado ${empresa.fechado ? "marcado" : ""}"><input type="checkbox" data-cb="fechado" ${empresa.fechado ? "checked" : ""}> 🔒 FECHADO</label>
  `;
  barra.querySelectorAll("[data-status]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const novo = btn.dataset.status;
      empresa.status = empresa.status === novo ? "SEM" : novo;
      renderizarGrupos($("#busca-empresa").value.toLowerCase());
      renderizarDashboard();
    });
  });
  barra.querySelectorAll("[data-cb]").forEach((chk) => {
    chk.addEventListener("change", () => {
      empresa[chk.dataset.cb] = chk.checked;
      renderizarGrupos($("#busca-empresa").value.toLowerCase());
    });
  });
  corpo.appendChild(barra);

  // ---- Campos cadastrais (editáveis) ----
  const camposWrap = document.createElement("div");
  camposWrap.className = "linha-dois-campos";
  camposWrap.style.marginBottom = "14px";
  camposWrap.innerHTML = `
    <div class="campo-form"><label>Nome</label><input data-campo="nome" value="${empresa.nome}"></div>
    <div class="campo-form"><label>CNPJ</label><input data-campo="cnpj" value="${empresa.cnpj || ""}"></div>
    <div class="campo-form"><label>CPF</label><input data-campo="cpf" value="${empresa.cpf || ""}"></div>
    <div class="campo-form"><label>E-mail</label><input data-campo="email" type="email" value="${empresa.email || ""}"></div>
    <div class="campo-form"><label>Senha Prefeitura</label><input data-campo="senhaPrefeitura" value="${empresa.senhaPrefeitura || ""}"></div>
    <div class="campo-form"><label>Senha Regularize</label><input data-campo="senhaRegularize" value="${empresa.senhaRegularize || ""}"></div>
    <div class="campo-form"><label>Inscrição Estadual</label><input data-campo="inscricaoEstadual" value="${empresa.inscricaoEstadual || ""}"></div>
  `;
  camposWrap.querySelectorAll("[data-campo]").forEach((inp) => {
    inp.addEventListener("change", () => {
      empresa[inp.dataset.campo] = inp.value.trim();
      renderizarGrupos($("#busca-empresa").value.toLowerCase());
    });
  });
  corpo.appendChild(camposWrap);

  // ---- Comentários + Anexos, lado a lado ----
  const duasColunas = document.createElement("div");
  duasColunas.className = "duas-colunas-detalhe";

  const colComentarios = document.createElement("div");
  colComentarios.className = "coluna-detalhe";
  colComentarios.innerHTML = `<h4>Comentários</h4><div class="lista-comentarios"></div>
    <div class="form-inline"><input placeholder="Escrever comentário..." class="input-comentario"><button type="button" class="btn-secundario btn-add-comentario">Adicionar</button></div>`;
  const listaC = colComentarios.querySelector(".lista-comentarios");
  if (empresa.comentarios.length === 0) listaC.innerHTML = '<p class="comentario-linha">Nenhum comentário ainda.</p>';
  empresa.comentarios.forEach((c, ci) => {
    const item = document.createElement("div");
    item.className = "comentario-item";
    item.innerHTML = `<span class="comentario-texto">• ${escaparHtml(c)}</span><button type="button" class="btn-icone">🗑</button>`;
    item.querySelector("button").addEventListener("click", () => {
      empresa.comentarios.splice(ci, 1);
      renderizarGrupos($("#busca-empresa").value.toLowerCase());
    });
    listaC.appendChild(item);
  });
  const addComentario = () => {
    const inp = colComentarios.querySelector(".input-comentario");
    if (!inp.value.trim()) return;
    empresa.comentarios.push(`${inp.value.trim()}\n${agora()}`);
    renderizarGrupos($("#busca-empresa").value.toLowerCase());
  };
  colComentarios.querySelector(".btn-add-comentario").addEventListener("click", addComentario);
  colComentarios.querySelector(".input-comentario").addEventListener("keydown", (e) => { if (e.key === "Enter") addComentario(); });

  const colAnexos = document.createElement("div");
  colAnexos.className = "coluna-detalhe";
  colAnexos.innerHTML = `<h4>Documentos</h4><div class="lista-anexos"></div>
    <div class="form-inline"><input type="file" class="input-anexo"></div>`;
  const listaA = colAnexos.querySelector(".lista-anexos");
  if (empresa.anexos.length === 0) listaA.innerHTML = '<p class="comentario-linha">Nenhum documento anexado.</p>';
  empresa.anexos.forEach((a, ai) => {
    const item = document.createElement("div");
    item.className = "anexo-item";
    item.innerHTML = `<button type="button" class="anexo-link">📄 ${escaparHtml(a.nome)}</button><button type="button" class="btn-icone">🗑</button>`;
    item.querySelector(".anexo-link").addEventListener("click", () => baixarAnexo(a));
    item.querySelectorAll(".btn-icone")[0].addEventListener("click", async () => {
      try { await api(`/api/anexos/${a.id}`, { method: "DELETE" }); } catch (e) {}
      empresa.anexos.splice(ai, 1);
      renderizarGrupos($("#busca-empresa").value.toLowerCase());
    });
    listaA.appendChild(item);
  });
  colAnexos.querySelector(".input-anexo").addEventListener("change", async (e) => {
    const arquivo = e.target.files[0];
    if (!arquivo) return;
    notificar("Enviando arquivo...");
    try {
      const dataB64 = await arquivoParaBase64(arquivo);
      const resp = await api("/api/anexos", { method: "POST", body: JSON.stringify({ nome: arquivo.name, tipo: arquivo.type, dataB64 }) });
      empresa.anexos.push({ id: resp.id, nome: resp.nome, tipo: resp.tipo });
      notificar("Arquivo anexado!");
      renderizarGrupos($("#busca-empresa").value.toLowerCase());
    } catch (err) {
      alert("Erro ao anexar: " + err.message);
    }
  });

  duasColunas.appendChild(colComentarios);
  duasColunas.appendChild(colAnexos);
  corpo.appendChild(duasColunas);

  return corpo;
}

function escaparHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function baixarAnexo(a) {
  try {
    const anexo = await api(`/api/anexos/${a.id}`);
    const link = document.createElement("a");
    link.href = `data:${anexo.tipo};base64,${anexo.dataB64}`;
    link.download = anexo.nome;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (err) {
    alert(err.message);
  }
}

async function enviarEmailEmpresa(empresa) {
  const assunto = prompt("Assunto do e-mail:", `Aviso - ${empresa.nome}`);
  if (!assunto) return;
  const mensagem = prompt("Mensagem:", "");
  try {
    await api("/api/email", { method: "POST", body: JSON.stringify({ destinatario: empresa.email, assunto, mensagem }) });
    notificar("✅ E-mail enviado para " + empresa.nome);
  } catch (err) {
    alert("Erro ao enviar: " + err.message);
  }
}

// ============================================================================
// CHECKLIST (TAREFAS DO DIA)
// ============================================================================
function renderizarChecklist() {
  const cont = $("#lista-checklist");
  cont.innerHTML = "";
  ESTADO.checklist.forEach((item, i) => {
    const div = document.createElement("div");
    div.className = "tarefa-item";
    div.innerHTML = `
      <div class="tarefa-topo">
        <input type="checkbox" ${item.concluido ? "checked" : ""} data-i="${i}" class="tarefa-check">
        <span class="tarefa-texto ${item.concluido ? "feita" : ""}">${escaparHtml(item.texto)}</span>
        <button class="btn-icone tarefa-remover" data-i="${i}">×</button>
      </div>
      <div class="tarefa-comentarios">
        ${(item.comentarios || []).map((c) => `<div class="comentario-linha">• ${escaparHtml(c)}</div>`).join("")}
        <input placeholder="Comentar..." data-i="${i}" class="tarefa-comentario-input">
      </div>
    `;
    cont.appendChild(div);
  });

  $$(".tarefa-check").forEach((chk) => chk.addEventListener("change", (e) => { ESTADO.checklist[+e.target.dataset.i].concluido = e.target.checked; renderizarChecklist(); }));
  $$(".tarefa-remover").forEach((btn) => btn.addEventListener("click", (e) => { ESTADO.checklist.splice(+e.target.dataset.i, 1); renderizarChecklist(); }));
  $$(".tarefa-comentario-input").forEach((inp) => inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.trim()) {
      const item = ESTADO.checklist[+e.target.dataset.i];
      item.comentarios = item.comentarios || [];
      item.comentarios.push(e.target.value.trim());
      renderizarChecklist();
    }
  }));
}

$("#btn-nova-tarefa").addEventListener("click", () => {
  const texto = prompt("Descrição da tarefa:");
  if (!texto) return;
  ESTADO.checklist.push({ texto, concluido: false, comentarios: [] });
  renderizarChecklist();
});

// ============================================================================
// PARCELAMENTOS
// ============================================================================
const CICLO_ALTERNANCIA = ["VAZIO", "Simples Receita", "Simples PGFN", "Previdencia Receita", "Previdencia PGFN"];
function proximoAlternancia(atual) {
  const i = CICLO_ALTERNANCIA.indexOf(atual || "VAZIO");
  return CICLO_ALTERNANCIA[(i + 1) % CICLO_ALTERNANCIA.length];
}
function classeAlternancia(status) {
  const mapa = { "Simples Receita": "a-simples-receita", "Simples PGFN": "a-simples-pgfn", "Previdencia Receita": "a-previdencia-receita", "Previdencia PGFN": "a-previdencia-pgfn" };
  return mapa[status] || "";
}

function limparDigitos(s) { return (s || "").replace(/[^0-9]/g, ""); }

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
  ESTADO.grupos.forEach((g) => {
    g.empresas.forEach((empresa) => {
      let p = encontrarParcelamentoDe(empresa);
      if (!p) {
        p = {
          nome: empresa.nome, statusAlternancia: "VAZIO", statusAlternancia2: "VAZIO", statusAlternancia3: "VAZIO", statusAlternancia4: "VAZIO",
          statusGeral: "SEM", cnpj: empresa.cnpj || "", senhaRegularize: empresa.senhaRegularize || "", comentarios: [], anexos: [],
        };
        ESTADO.parcelamentos.push(p);
      } else {
        p.nome = empresa.nome;
        if (empresa.cnpj) p.cnpj = empresa.cnpj;
        if (empresa.senhaRegularize) p.senhaRegularize = empresa.senhaRegularize;
      }
    });
  });
}

$("#btn-novo-parcelamento").addEventListener("click", () => {
  const html = `
    <h2>Novo parcelamento</h2>
    <div class="campo-form"><label>Nome</label><input id="np-nome"></div>
    <div class="campo-form"><label>CNPJ</label><input id="np-cnpj"></div>
    <div class="campo-form"><label>Senha do Regularize</label><input id="np-senha"></div>
    <div class="modal-rodape">
      <button class="btn-ghost" id="np-cancelar">Cancelar</button>
      <button class="btn-primario" id="np-salvar">Adicionar</button>
    </div>
  `;
  abrirModal(html);
  $("#np-cancelar").addEventListener("click", fecharModal);
  $("#np-salvar").addEventListener("click", () => {
    const nome = $("#np-nome").value.trim();
    const cnpj = $("#np-cnpj").value.trim();
    if (!nome && !cnpj) return alert("Informe nome ou CNPJ.");
    ESTADO.parcelamentos.push({
      nome: nome || "Parcelamento sem nome", cnpj, senhaRegularize: $("#np-senha").value.trim(),
      statusAlternancia: "VAZIO", statusAlternancia2: "VAZIO", statusAlternancia3: "VAZIO", statusAlternancia4: "VAZIO",
      statusGeral: "SEM", comentarios: [], anexos: [],
    });
    fecharModal();
    renderizarParcelamentos();
  });
});

function renderizarParcelamentos() {
  renderizarDashboardParcelamentos();
  const cont = $("#lista-parcelamentos");
  cont.innerHTML = "";
  ESTADO.parcelamentos.forEach((p, i) => cont.appendChild(criarParcelamentoCard(p, i)));
}

function criarParcelamentoCard(p, i) {
  const wrap = document.createElement("div");
  wrap.className = `empresa-card ${classeStatus(p.statusGeral)}`;
  const aberto = PARCELAMENTOS_ABERTOS.has(i);

  const header = document.createElement("div");
  header.className = "parcelamento-header";
  header.innerHTML = `
    <div class="empresa-nome-wrap">
      ${p.anexos.length ? '<span class="selo-anexado">ANEXADO</span>' : ""}
      <span class="empresa-nome">📄 ${escaparHtml(p.nome)}</span>
    </div>
    ${botaoCopiaSe(p.cnpj, "CNPJ")}
    ${botaoCopiaSe(p.senhaRegularize, "Regularize")}
    <button type="button" class="chip-copia chip-email" data-email="1">Enviar E-mail</button>
    <span style="flex:1"></span>
    <button type="button" class="btn-icone" data-excluir="1" title="Excluir">🗑</button>
  `;
  header.addEventListener("click", (e) => {
    if (e.target.closest("[data-copiar]") || e.target.closest("[data-email]") || e.target.closest("[data-excluir]")) return;
    if (PARCELAMENTOS_ABERTOS.has(i)) PARCELAMENTOS_ABERTOS.delete(i); else PARCELAMENTOS_ABERTOS.add(i);
    renderizarParcelamentos();
  });
  header.querySelectorAll("[data-copiar]").forEach((btn) => {
    const rotulo = btn.dataset.copiar;
    const mapa = { CNPJ: p.cnpj, Regularize: p.senhaRegularize };
    btn.addEventListener("click", (e) => { e.stopPropagation(); copiar(rotulo, mapa[rotulo]); });
  });
  header.querySelector("[data-email]").addEventListener("click", async (e) => {
    e.stopPropagation();
    const destinatario = prompt("E-mail de destino:", "");
    if (!destinatario) return;
    const assunto = prompt("Assunto:", `Parcelamento - ${p.nome}`);
    if (!assunto) return;
    try {
      await api("/api/email", { method: "POST", body: JSON.stringify({ destinatario, assunto, mensagem: "" }) });
      notificar("✅ E-mail enviado");
    } catch (err) { alert(err.message); }
  });
  header.querySelector("[data-excluir]").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!confirm(`Excluir "${p.nome}"?`)) return;
    ESTADO.parcelamentos.splice(i, 1);
    renderizarParcelamentos();
  });

  wrap.appendChild(header);

  if (aberto) {
    const corpo = document.createElement("div");
    corpo.className = "empresa-corpo";

    const barra = document.createElement("div");
    barra.className = "barra-opcoes";
    const alt = (campo) => `<button type="button" class="alternancia-btn ${classeAlternancia(p[campo])}" data-alt="${campo}">${p[campo] === "VAZIO" ? "Vazio" : p[campo]}</button>`;
    barra.innerHTML = `
      <button type="button" class="pill-toggle ${p.statusGeral === "VERDE" ? "ok-on" : "ok-off"}" data-status="VERDE">✓ OK</button>
      <button type="button" class="pill-toggle ${p.statusGeral === "VERMELHO" ? "erro-on" : "erro-off"}" data-status="VERMELHO">✕ PENDENTE</button>
      <button type="button" class="pill-toggle ${p.statusGeral === "ATENÇÃO" ? "atencao-on" : "atencao-off"}" data-status="ATENÇÃO">! ATENÇÃO</button>
      <span class="separador-v"></span>
      ${alt("statusAlternancia")} ${alt("statusAlternancia2")} ${alt("statusAlternancia3")} ${alt("statusAlternancia4")}
    `;
    barra.querySelectorAll("[data-status]").forEach((btn) => btn.addEventListener("click", () => {
      const novo = btn.dataset.status;
      p.statusGeral = p.statusGeral === novo ? "SEM" : novo;
      renderizarParcelamentos();
    }));
    barra.querySelectorAll("[data-alt]").forEach((btn) => btn.addEventListener("click", () => {
      p[btn.dataset.alt] = proximoAlternancia(p[btn.dataset.alt]);
      renderizarParcelamentos();
    }));
    corpo.appendChild(barra);

    const camposWrap = document.createElement("div");
    camposWrap.className = "linha-dois-campos";
    camposWrap.style.marginBottom = "14px";
    camposWrap.innerHTML = `
      <div class="campo-form"><label>Nome</label><input data-campo="nome" value="${escaparHtml(p.nome)}"></div>
      <div class="campo-form"><label>CNPJ</label><input data-campo="cnpj" value="${p.cnpj || ""}"></div>
      <div class="campo-form"><label>Senha do Regularize</label><input data-campo="senhaRegularize" value="${p.senhaRegularize || ""}"></div>
    `;
    camposWrap.querySelectorAll("[data-campo]").forEach((inp) => inp.addEventListener("change", () => { p[inp.dataset.campo] = inp.value.trim(); renderizarParcelamentos(); }));
    corpo.appendChild(camposWrap);

    const duasColunas = document.createElement("div");
    duasColunas.className = "duas-colunas-detalhe";

    const colComentarios = document.createElement("div");
    colComentarios.className = "coluna-detalhe";
    colComentarios.innerHTML = `<h4>Comentários</h4><div class="lista-comentarios"></div>
      <div class="form-inline"><input placeholder="Escrever comentário..." class="input-comentario"><button type="button" class="btn-secundario btn-add-comentario">Adicionar</button></div>`;
    const listaC = colComentarios.querySelector(".lista-comentarios");
    if (p.comentarios.length === 0) listaC.innerHTML = '<p class="comentario-linha">Nenhum comentário ainda.</p>';
    p.comentarios.forEach((c, ci) => {
      const item = document.createElement("div");
      item.className = "comentario-item";
      item.innerHTML = `<span class="comentario-texto">• ${escaparHtml(c)}</span><button type="button" class="btn-icone">🗑</button>`;
      item.querySelector("button").addEventListener("click", () => { p.comentarios.splice(ci, 1); renderizarParcelamentos(); });
      listaC.appendChild(item);
    });
    const addComentarioP = () => {
      const inp = colComentarios.querySelector(".input-comentario");
      if (!inp.value.trim()) return;
      p.comentarios.push(`${inp.value.trim()}\n${agora()}`);
      renderizarParcelamentos();
    };
    colComentarios.querySelector(".btn-add-comentario").addEventListener("click", addComentarioP);
    colComentarios.querySelector(".input-comentario").addEventListener("keydown", (e) => { if (e.key === "Enter") addComentarioP(); });

    const colAnexos = document.createElement("div");
    colAnexos.className = "coluna-detalhe";
    colAnexos.innerHTML = `<h4>Documentos</h4><div class="lista-anexos"></div><div class="form-inline"><input type="file" class="input-anexo"></div>`;
    const listaA = colAnexos.querySelector(".lista-anexos");
    if (p.anexos.length === 0) listaA.innerHTML = '<p class="comentario-linha">Nenhum documento anexado.</p>';
    p.anexos.forEach((a, ai) => {
      const item = document.createElement("div");
      item.className = "anexo-item";
      item.innerHTML = `<button type="button" class="anexo-link">📄 ${escaparHtml(a.nome)}</button><button type="button" class="btn-icone">🗑</button>`;
      item.querySelector(".anexo-link").addEventListener("click", () => baixarAnexo(a));
      item.querySelectorAll(".btn-icone")[0].addEventListener("click", async () => {
        try { await api(`/api/anexos/${a.id}`, { method: "DELETE" }); } catch (e) {}
        p.anexos.splice(ai, 1);
        renderizarParcelamentos();
      });
      listaA.appendChild(item);
    });
    colAnexos.querySelector(".input-anexo").addEventListener("change", async (e) => {
      const arquivo = e.target.files[0];
      if (!arquivo) return;
      notificar("Enviando arquivo...");
      try {
        const dataB64 = await arquivoParaBase64(arquivo);
        const resp = await api("/api/anexos", { method: "POST", body: JSON.stringify({ nome: arquivo.name, tipo: arquivo.type, dataB64 }) });
        p.anexos.push({ id: resp.id, nome: resp.nome, tipo: resp.tipo });
        notificar("Arquivo anexado!");
        renderizarParcelamentos();
      } catch (err) { alert("Erro ao anexar: " + err.message); }
    });

    duasColunas.appendChild(colComentarios);
    duasColunas.appendChild(colAnexos);
    corpo.appendChild(duasColunas);

    wrap.appendChild(corpo);
  }
  return wrap;
}

// ============================================================================
// USUÁRIOS
// ============================================================================
$("#btn-usuarios").addEventListener("click", async () => {
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

// ============================================================================
// MODAL GENÉRICO
// ============================================================================
function abrirModal(html) { $("#modal-conteudo").innerHTML = html; $("#modal-fundo").classList.remove("oculto"); }
function fecharModal() { $("#modal-fundo").classList.add("oculto"); $("#modal-conteudo").innerHTML = ""; }
$("#modal-fundo").addEventListener("click", (e) => { if (e.target.id === "modal-fundo") fecharModal(); });

iniciar();
