// ============================================================================
// empresas.js — lógica da página de Grupos/Empresas + Tarefas do Dia (empresas.html)
// ============================================================================
let GRUPOS_ABERTOS = new Set();
let EMPRESAS_ABERTAS = new Set();

function renderizarPagina() {
  renderizarDashboard();
  renderizarGrupos($("#busca")?.value.toLowerCase() || "");
  renderizarChecklist();
}

// ---------------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// GRUPOS / EMPRESAS
// ---------------------------------------------------------------------------
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
      id: crypto.randomUUID(),
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

function criarEmpresaCard(empresa, gi, ei) {
  const wrap = document.createElement("div");
  wrap.className = `empresa-card ${classeStatus(empresa.status)}`;
  const chaveAberta = `${gi}:${ei}`;
  const aberto = EMPRESAS_ABERTAS.has(chaveAberta);

  const header = document.createElement("div");
  header.className = "empresa-header";
  header.innerHTML = `
    <div class="empresa-nome-wrap">
      <div class="selos-linha">
        ${empresa.anexos.length ? '<span class="selo-anexado">ANEXADO</span>' : ""}
        ${empresa.nfs ? '<span class="selo-tag">NFS</span>' : ""}
        ${empresa.nfe ? '<span class="selo-tag">NFE</span>' : ""}
        ${empresa.nfc ? '<span class="selo-tag">NFC</span>' : ""}
        ${empresa.fechado ? '<span class="selo-tag selo-cadeado" title="Fechado">🔒</span>' : ""}
      </div>
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
    renderizarGrupos($("#busca")?.value.toLowerCase() || "");
  });

  header.querySelectorAll("[data-copiar]").forEach((btn) => {
    const rotulo = btn.dataset.copiar;
    const mapa = { CNPJ: empresa.cnpj, CPF: empresa.cpf, IE: empresa.inscricaoEstadual, Prefeitura: empresa.senhaPrefeitura, Regularize: empresa.senhaRegularize };
    btn.addEventListener("click", (e) => { e.stopPropagation(); copiar(rotulo, mapa[rotulo]); });
  });
  const btnEmail = header.querySelector("[data-email]");
  if (btnEmail) btnEmail.addEventListener("click", (e) => { e.stopPropagation(); enviarEmailEmpresaOriginal(empresa); });
  header.querySelector("[data-excluir]").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!confirm(`Excluir "${empresa.nome}"? Essa ação não pode ser desfeita.`)) return;
    ESTADO.grupos[gi].empresas.splice(ei, 1);
    renderizarGrupos($("#busca")?.value.toLowerCase() || "");
    renderizarDashboard();
  });

  wrap.appendChild(header);
  if (aberto) wrap.appendChild(criarCorpoEmpresa(empresa, gi, ei));
  return wrap;
}

function criarCorpoEmpresa(empresa, gi, ei) {
  const corpo = document.createElement("div");
  corpo.className = "empresa-corpo";

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
      renderizarGrupos($("#busca")?.value.toLowerCase() || "");
      renderizarDashboard();
    });
  });
  barra.querySelectorAll("[data-cb]").forEach((chk) => {
    chk.addEventListener("change", () => {
      empresa[chk.dataset.cb] = chk.checked;
      renderizarGrupos($("#busca")?.value.toLowerCase() || "");
    });
  });
  corpo.appendChild(barra);

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
      renderizarGrupos($("#busca")?.value.toLowerCase() || "");
    });
  });
  corpo.appendChild(camposWrap);

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
      renderizarGrupos($("#busca")?.value.toLowerCase() || "");
    });
    listaC.appendChild(item);
  });
  const addComentario = () => {
    const inp = colComentarios.querySelector(".input-comentario");
    if (!inp.value.trim()) return;
    empresa.comentarios.push(`${inp.value.trim()}\n${agora()}`);
    renderizarGrupos($("#busca")?.value.toLowerCase() || "");
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
      renderizarGrupos($("#busca")?.value.toLowerCase() || "");
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
      renderizarGrupos($("#busca")?.value.toLowerCase() || "");
    } catch (err) {
      alert("Erro ao anexar: " + err.message);
    }
  });

  duasColunas.appendChild(colComentarios);
  duasColunas.appendChild(colAnexos);
  corpo.appendChild(duasColunas);

  return corpo;
}

// ---------------------------------------------------------------------------
// CHECKLIST (TAREFAS DO DIA)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// E-MAIL (igual ao "enviarEmailComAnexos" do app original: assunto e corpo
// automáticos com a competência do mês anterior, exige e-mail e anexo, e
// marca a empresa como VERDE ao enviar com sucesso)
// ---------------------------------------------------------------------------
async function enviarEmailEmpresaOriginal(empresa) {
  if (!empresa.email) {
    notificar("Esta empresa não possui um e-mail cadastrado.");
    return;
  }
  if (!empresa.anexos || empresa.anexos.length === 0) {
    notificar("A empresa não possui arquivos anexados para enviar.");
    return;
  }

  const hoje = new Date();
  const mesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  const competencia = `${String(mesAnterior.getMonth() + 1).padStart(2, "0")}/${mesAnterior.getFullYear()}`;
  const assunto = `Documentos Setor Fiscal - Competência ${competencia}`;
  const mensagem = `Olá, tudo bem?\n\nSegue em anexo os documentos do setor Fiscal referente à competência ${competencia}.\n\nAtenciosamente,\nFZ CONT`;

  notificar(`A enviar e-mail para ${empresa.nome}...`);
  try {
    await enviarEmailBruto({
      destinatario: empresa.email,
      assunto,
      mensagem,
      anexoIds: empresa.anexos.map((a) => a.id),
    });
    empresa.status = "VERDE";
    renderizarGrupos($("#busca")?.value.toLowerCase() || "");
    renderizarDashboard();
    notificar(`✅ E-mail enviado com sucesso para ${empresa.nome}!`);
  } catch (err) {
    alert("Erro ao enviar e-mail: " + err.message);
  }
}

$("#btn-nova-tarefa").addEventListener("click", () => {
  const texto = prompt("Descrição da tarefa:");
  if (!texto) return;
  ESTADO.checklist.push({ texto, concluido: false, comentarios: [] });
  renderizarChecklist();
});

// ---------------------------------------------------------------------------
// IMPORTAR PDFs EM LOTE (igual ao "processarPdfDas" do app original):
// lê o texto de cada PDF, acha o CNPJ, identifica a empresa correspondente,
// anexa o arquivo e registra um comentário com competência/valor encontrados.
// ---------------------------------------------------------------------------
$("#btn-importar-pdfs")?.addEventListener("click", () => $("#input-importar-pdfs").click());
$("#input-importar-pdfs")?.addEventListener("change", async (e) => {
  const arquivos = [...e.target.files];
  if (!arquivos.length) return;
  notificar(`Analisando ${arquivos.length} PDF(s)...`);

  let vinculados = 0, semCnpj = 0, semEmpresa = 0, comErro = 0;

  for (const arquivo of arquivos) {
    try {
      const texto = await extrairTextoPdf(arquivo);
      if (!texto.trim()) { comErro++; continue; }

      const cnpjEncontrado = extrairCnpjDoTexto(texto);
      if (!cnpjEncontrado) { semCnpj++; continue; }

      const empresa = buscarEmpresaPorCnpj(cnpjEncontrado);
      if (!empresa) { semEmpresa++; continue; }

      empresa.anexos = empresa.anexos || [];
      await anexarArquivoNaLista(empresa.anexos, arquivo);

      const competencia = extrairCompetenciaDoTexto(texto);
      const valor = extrairValorDoTexto(texto);
      let comentario = "📄 Guia DAS Simples Nacional processada via PDF.";
      if (competencia) comentario += `\nCompetência: ${competencia}`;
      if (valor) comentario += `\nValor Total: R$ ${valor}`;
      empresa.comentarios.push(`${comentario}\n${agora()}`);

      vinculados++;
    } catch (err) {
      console.error("Erro ao processar PDF", arquivo.name, err);
      comErro++;
    }
  }

  renderizarGrupos($("#busca")?.value.toLowerCase() || "");
  renderizarDashboard();

  let msg = `✅ Lote processado: ${vinculados} arquivo(s) vinculado(s).`;
  if (semCnpj) msg += ` ${semCnpj} sem CNPJ localizado.`;
  if (semEmpresa) msg += ` ${semEmpresa} sem empresa cadastrada com esse CNPJ.`;
  if (comErro) msg += ` ${comErro} com erro de leitura.`;
  notificar(msg);
  alert(msg + "\n\nLembre-se de clicar em Salvar para gravar os comentários e status.");
  e.target.value = "";
});

$("#busca")?.addEventListener("input", (e) => renderizarGrupos(e.target.value.toLowerCase()));

iniciarPagina();
