// ============================================================================
// parcelamentos.js — lógica da página de Parcelamentos (parcelamentos.html)
// ============================================================================
let PARCELAMENTOS_ABERTOS = new Set();
const CICLO_ALTERNANCIA = ["VAZIO", "Simples Receita", "Simples PGFN", "Previdencia Receita", "Previdencia PGFN"];

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
      } else {
        p.nome = empresa.nome;
        if (empresa.cnpj) p.cnpj = empresa.cnpj;
        if (empresa.senhaRegularize) p.senhaRegularize = empresa.senhaRegularize;
      }
    });
  });
}

function renderizarPagina() {
  sincronizarParcelamentosComEmpresas();
  renderizarDashboardParcelamentos();
  renderizarParcelamentos($("#busca")?.value.toLowerCase() || "");
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

// ---------------------------------------------------------------------------
// E-MAIL (igual ao "enviarEmailExclusivoParcelamento" do app original: busca
// o e-mail pela empresa cadastrada com o mesmo CNPJ, pede uma mensagem/nota
// e manda um corpo HTML fixo com o nome do parcelamento no assunto)
// ---------------------------------------------------------------------------
async function enviarEmailParcelamentoOriginal(p) {
  const empresa = buscarEmpresaPorCnpj(p.cnpj);
  if (!empresa || !empresa.email) {
    alert("Não foi possível enviar o e-mail.\nNenhuma empresa cadastrada em Empresas com este CNPJ ou o campo de e-mail está vazio!");
    return;
  }
  const nota = prompt("Mensagem para o cliente:", "Olá, segue atualização sobre o andamento do seu Parcelamento.");
  if (nota === null) return;

  const assunto = `PARCELAMENTOS - ${p.nome}`;
  const corpoHtml = `<h3>Parcelamentos</h3>${escaparHtml(p.nome)}<p>Prezado cliente<b></b>,</p><p>Segue em anexo as guias dos parcelamentos</p><br><p>Atenciosamente,<br>Departamento Fiscal e Contábil</p>`;

  notificar(`A enviar e-mail para ${empresa.nome}...`);
  try {
    const resp = await enviarEmailBruto({
      destinatario: empresa.email,
      assunto,
      mensagem: corpoHtml,
      html: true,
      anexoIds: (p.anexos || []).map((a) => a.id),
    });
    notificar(
      `✅ E-mail de parcelamento enviado para ${empresa.email}` +
        (resp.anexados ? ` (${resp.anexados} anexo(s))` : "")
    );
  } catch (err) {
    alert("Falha ao enviar e-mail: " + err.message);
  }
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
      id: crypto.randomUUID(),
      nome: nome || "Parcelamento sem nome", cnpj, senhaRegularize: $("#np-senha").value.trim(),
      statusAlternancia: "VAZIO", statusAlternancia2: "VAZIO", statusAlternancia3: "VAZIO", statusAlternancia4: "VAZIO",
      statusGeral: "SEM", comentarios: [], anexos: [],
    });
    fecharModal();
    renderizarParcelamentos();
  });
});

function renderizarParcelamentos(filtro = "") {
  const cont = $("#lista-parcelamentos");
  cont.innerHTML = "";
  ESTADO.parcelamentos
    .filter((p) => p.nome.toLowerCase().includes(filtro) || (p.cnpj || "").includes(filtro))
    .forEach((p) => cont.appendChild(criarParcelamentoCard(p, ESTADO.parcelamentos.indexOf(p))));
}

function criarParcelamentoCard(p, i) {
  const wrap = document.createElement("div");
  wrap.className = `empresa-card ${classeStatus(p.statusGeral)}`;
  const aberto = PARCELAMENTOS_ABERTOS.has(i);

  const header = document.createElement("div");
  header.className = "parcelamento-header";
  header.innerHTML = `
    <div class="empresa-nome-wrap">
      <div class="selos-linha">
        ${p.anexos.length ? '<span class="selo-anexado">ANEXADO</span>' : ""}
      </div>
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
    renderizarParcelamentos($("#busca")?.value.toLowerCase() || "");
  });
  header.querySelectorAll("[data-copiar]").forEach((btn) => {
    const rotulo = btn.dataset.copiar;
    const mapa = { CNPJ: p.cnpj, Regularize: p.senhaRegularize };
    btn.addEventListener("click", (e) => { e.stopPropagation(); copiar(rotulo, mapa[rotulo]); });
  });
  header.querySelector("[data-email]").addEventListener("click", (e) => {
    e.stopPropagation();
    enviarEmailParcelamentoOriginal(p);
  });
  header.querySelector("[data-excluir]").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!confirm(`Excluir "${p.nome}"?`)) return;
    ESTADO.parcelamentos.splice(i, 1);
    renderizarParcelamentos($("#busca")?.value.toLowerCase() || "");
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
      renderizarParcelamentos($("#busca")?.value.toLowerCase() || "");
    }));
    barra.querySelectorAll("[data-alt]").forEach((btn) => btn.addEventListener("click", () => {
      p[btn.dataset.alt] = proximoAlternancia(p[btn.dataset.alt]);
      renderizarParcelamentos($("#busca")?.value.toLowerCase() || "");
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
    camposWrap.querySelectorAll("[data-campo]").forEach((inp) => inp.addEventListener("change", () => { p[inp.dataset.campo] = inp.value.trim(); renderizarParcelamentos($("#busca")?.value.toLowerCase() || ""); }));
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
      item.querySelector("button").addEventListener("click", () => { p.comentarios.splice(ci, 1); renderizarParcelamentos($("#busca")?.value.toLowerCase() || ""); });
      listaC.appendChild(item);
    });
    const addComentarioP = () => {
      const inp = colComentarios.querySelector(".input-comentario");
      if (!inp.value.trim()) return;
      p.comentarios.push(`${inp.value.trim()}\n${agora()}`);
      renderizarParcelamentos($("#busca")?.value.toLowerCase() || "");
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
        renderizarParcelamentos($("#busca")?.value.toLowerCase() || "");
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
        renderizarParcelamentos($("#busca")?.value.toLowerCase() || "");
      } catch (err) { alert("Erro ao anexar: " + err.message); }
    });

    duasColunas.appendChild(colComentarios);
    duasColunas.appendChild(colAnexos);
    corpo.appendChild(duasColunas);

    wrap.appendChild(corpo);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// IMPORTAR PDFs EM LOTE (igual ao "processarPdfParcelamento" do app original)
// ---------------------------------------------------------------------------
$("#btn-importar-pdfs")?.addEventListener("click", () => $("#input-importar-pdfs").click());
$("#input-importar-pdfs")?.addEventListener("change", async (e) => {
  const arquivos = [...e.target.files];
  if (!arquivos.length) return;
  notificar(`Analisando ${arquivos.length} PDF(s)...`);

  let vinculados = 0, semCnpj = 0, semParcelamento = 0, comErro = 0;

  for (const arquivo of arquivos) {
    try {
      const texto = await extrairTextoPdf(arquivo);
      if (!texto.trim()) { comErro++; continue; }

      const cnpjEncontrado = extrairCnpjDoTexto(texto);
      if (!cnpjEncontrado) { semCnpj++; continue; }

      const parcelamento = buscarParcelamentoPorCnpj(cnpjEncontrado);
      if (!parcelamento) { semParcelamento++; continue; }

      parcelamento.anexos = parcelamento.anexos || [];
      await anexarArquivoNaLista(parcelamento.anexos, arquivo);

      const competencia = extrairCompetenciaDoTexto(texto);
      const valor = extrairValorDoTexto(texto);
      let comentario = "📄 Guia de Parcelamento processada via PDF.";
      if (competencia) comentario += `\nCompetência: ${competencia}`;
      if (valor) comentario += `\nValor Total: R$ ${valor}`;
      parcelamento.comentarios.push(`${comentario}\n${agora()}`);

      vinculados++;
    } catch (err) {
      console.error("Erro ao processar PDF", arquivo.name, err);
      comErro++;
    }
  }

  renderizarParcelamentos($("#busca")?.value.toLowerCase() || "");
  renderizarDashboardParcelamentos();

  let msg = `✅ Lote de Parcelamentos processado: ${vinculados} arquivo(s) vinculado(s).`;
  if (semCnpj) msg += ` ${semCnpj} sem CNPJ localizado.`;
  if (semParcelamento) msg += ` ${semParcelamento} sem parcelamento cadastrado com esse CNPJ.`;
  if (comErro) msg += ` ${comErro} com erro de leitura.`;
  notificar(msg);
  alert(msg + "\n\nLembre-se de clicar em Salvar para gravar os comentários.");
  e.target.value = "";
});

$("#busca")?.addEventListener("input", (e) => renderizarParcelamentos(e.target.value.toLowerCase()));

iniciarPagina();
