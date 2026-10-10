// ============================================================================
// empresas.js — lógica da página de Grupos/Empresas + Tarefas do Dia (empresas.html)
// ============================================================================
let GRUPOS_ABERTOS = new Set();
let EMPRESAS_ABERTAS = new Set();
let GRUPOS_ANIMADOS = new Set(); // controla quem já tocou a animação de abrir, pra não repetir a cada re-render
let EMPRESAS_ANIMADAS = new Set();

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
      <div class="dash-nome">${escaparHtml(g.nome)}</div>
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
    cabecalho.innerHTML = `<h3>📁 ${escaparHtml(grupo.nome)}</h3><span class="contagem">${grupo.empresas.length} empresa(s) ${aberto ? "▾" : "▸"}</span>`;
    cabecalho.addEventListener("click", () => {
      if (GRUPOS_ABERTOS.has(gi)) { GRUPOS_ABERTOS.delete(gi); GRUPOS_ANIMADOS.delete(gi); }
      else GRUPOS_ABERTOS.add(gi);
      renderizarGrupos(filtro);
    });
    card.appendChild(cabecalho);

    if (aberto) {
      const corpo = document.createElement("div");
      corpo.className = "grupo-corpo";
      if (!GRUPOS_ANIMADOS.has(gi)) {
        corpo.classList.add("anim-surgir");
        GRUPOS_ANIMADOS.add(gi);
      }

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
      <span class="empresa-nome">🏢 ${escaparHtml(empresa.nome)}</span>
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
    if (EMPRESAS_ABERTAS.has(chaveAberta)) { EMPRESAS_ABERTAS.delete(chaveAberta); EMPRESAS_ANIMADAS.delete(chaveAberta); }
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
  const chaveEmpresa = `${gi}:${ei}`;
  if (!EMPRESAS_ANIMADAS.has(chaveEmpresa)) {
    corpo.classList.add("anim-surgir");
    EMPRESAS_ANIMADAS.add(chaveEmpresa);
  }

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
    <div class="campo-form"><label>Nome</label><input data-campo="nome" value="${escaparHtml(empresa.nome)}"></div>
    <div class="campo-form"><label>CNPJ</label><input data-campo="cnpj" value="${escaparHtml(empresa.cnpj || "")}"></div>
    <div class="campo-form"><label>CPF</label><input data-campo="cpf" value="${escaparHtml(empresa.cpf || "")}"></div>
    <div class="campo-form"><label>E-mail</label><input data-campo="email" type="email" value="${escaparHtml(empresa.email || "")}"></div>
    <div class="campo-form"><label>Senha Prefeitura</label><input data-campo="senhaPrefeitura" value="${escaparHtml(empresa.senhaPrefeitura || "")}"></div>
    <div class="campo-form"><label>Senha Regularize</label><input data-campo="senhaRegularize" value="${escaparHtml(empresa.senhaRegularize || "")}"></div>
    <div class="campo-form"><label>Inscrição Estadual</label><input data-campo="inscricaoEstadual" value="${escaparHtml(empresa.inscricaoEstadual || "")}"></div>
  `;
  camposWrap.querySelectorAll("[data-campo]").forEach((inp) => {
    inp.addEventListener("change", () => {
      empresa[inp.dataset.campo] = inp.value.trim();
      renderizarGrupos($("#busca")?.value.toLowerCase() || "");
    });
  });
  corpo.appendChild(camposWrap);

  const acoesExtra = document.createElement("div");
  acoesExtra.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px;";
  acoesExtra.innerHTML = `
    <button type="button" class="btn-secundario btn-consultar-simples">🔎 Consultar Simples Nacional</button>
    <button type="button" class="btn-secundario btn-importar-resumo">📄 Importar Resumo</button>
    <input type="file" accept="application/pdf" class="input-resumo oculto">
    <span class="ic-resultado-simples" style="font-size:12.5px;color:var(--ink-soft);"></span>
  `;
  acoesExtra.querySelector(".btn-consultar-simples").addEventListener("click", () => consultarSimplesNacional(empresa, acoesExtra.querySelector(".ic-resultado-simples")));
  acoesExtra.querySelector(".btn-importar-resumo").addEventListener("click", () => acoesExtra.querySelector(".input-resumo").click());
  acoesExtra.querySelector(".input-resumo").addEventListener("change", (e) => importarResumoPdf(empresa, e.target.files[0], e.target));
  corpo.appendChild(acoesExtra);

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
    if ((empresa.anexos || []).some((a) => a.nome === arquivo.name)) {
      notificar(`"${arquivo.name}" já está anexado nesta empresa.`);
      e.target.value = "";
      return;
    }
    notificar("Enviando arquivo...");
    try {
      empresa.anexos = empresa.anexos || [];
      await anexarArquivoNaLista(empresa.anexos, arquivo);
      notificar("Arquivo anexado!");
      renderizarGrupos($("#busca")?.value.toLowerCase() || "");
    } catch (err) {
      alert("Erro ao anexar: " + err.message);
    }
    e.target.value = "";
  });

  duasColunas.appendChild(colComentarios);
  duasColunas.appendChild(colAnexos);
  corpo.appendChild(duasColunas);

  return corpo;
}

// ---------------------------------------------------------------------------
// CONSULTAR SIMPLES NACIONAL (dados públicos da Receita, via BrasilAPI)
// ---------------------------------------------------------------------------
const CONSULTANDO_SIMPLES = new Set(); // evita clique duplo gerando consultas repetidas (a fonte limita requisições)

// "2018-01-01" → "01/01/2018". Feito na mão de propósito: new Date("2018-01-01") é interpretado
// como meia-noite UTC e, no horário do Brasil, aparece como 31/12/2017 (um dia a menos).
function formatarDataISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

function descreverSimples(r) {
  let texto;
  if (r.optanteSimples === true) {
    texto = `✅ Optante pelo Simples Nacional${r.dataOpcaoSimples ? " desde " + formatarDataISO(r.dataOpcaoSimples) : ""}`;
  } else if (r.optanteSimples === false) {
    texto = "❌ Não é optante pelo Simples Nacional";
    if (r.dataExclusaoSimples) texto += ` (excluída em ${formatarDataISO(r.dataExclusaoSimples)})`;
  } else {
    // A base pública não tem registro de opção — isso NÃO é a mesma coisa que "não optante".
    texto = "⚠️ Sem registro de opção pelo Simples Nacional na base pública (provavelmente não optante — confirme no portal da Receita se for decisivo)";
  }
  if (r.optanteMei === true) texto += " · também é MEI";
  return texto;
}

async function consultarSimplesNacional(empresa, elResultado) {
  if (!empresa.cnpj) { elResultado.textContent = "Informe o CNPJ da empresa primeiro."; return; }
  if (CONSULTANDO_SIMPLES.has(empresa.cnpj)) return;
  CONSULTANDO_SIMPLES.add(empresa.cnpj);
  elResultado.textContent = "Consultando...";
  try {
    const r = await api(`/api/consulta-cnpj?cnpj=${encodeURIComponent(empresa.cnpj)}`);
    const texto = descreverSimples(r);
    const origem = `Fonte: ${r.fonte} (base pública da Receita, atualizada mensalmente)` +
      (r.doCache && r.consultadoEm ? ` · consulta de ${new Date(r.consultadoEm).toLocaleString("pt-BR")}` : "");
    elResultado.textContent = `${texto} — ${origem}`;
    empresa.comentarios = empresa.comentarios || [];
    empresa.comentarios.push(`🔎 ${texto}\n${origem}\n${agora()}`);
    renderizarGrupos($("#busca")?.value.toLowerCase() || "");
  } catch (err) {
    elResultado.textContent = "Erro: " + err.message;
  } finally {
    CONSULTANDO_SIMPLES.delete(empresa.cnpj);
  }
}

// ---------------------------------------------------------------------------
// IMPORTAR RESUMO PDF (porta a funcionalidade original: lê o Resumo do PGDAS
// e monta um Relatório Fiscal formatado, anexando na própria empresa)
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

async function importarResumoPdf(empresa, arquivo, inputEl) {
  if (!arquivo) return;
  notificar("Lendo o Resumo...");
  try {
    const textoPdf = await extrairTextoPdf(arquivo);
    if (!textoPdf || !textoPdf.trim()) throw new Error("Não foi possível extrair texto desse PDF.");

    const dados = processarTextoResumo(textoPdf);
    notificar("Montando o Relatório Fiscal...");
    const blob = gerarRelatorioFiscalPDF(empresa.nome, dados);

    const nomeArquivo = `RelatorioFiscal_${empresa.nome.replace(/[^a-zA-Z0-9]+/g, "_")}_${Date.now()}.pdf`;
    const arquivoGerado = new File([blob], nomeArquivo, { type: "application/pdf" });

    empresa.anexos = empresa.anexos || [];
    await anexarArquivoNaLista(empresa.anexos, arquivoGerado);

    empresa.comentarios = empresa.comentarios || [];
    empresa.comentarios.push(`📄 Extrato Profissional gerado em: ${agora()}`);

    notificar("✅ Relatório Fiscal gerado e anexado!");
    renderizarGrupos($("#busca")?.value.toLowerCase() || "");
  } catch (err) {
    alert("Erro ao gerar o Relatório Fiscal: " + err.message);
  } finally {
    if (inputEl) inputEl.value = "";
  }
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

  let vinculados = 0, jaExistiam = 0, semCnpj = 0, semEmpresa = 0, comErro = 0;

  for (const arquivo of arquivos) {
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
  if (jaExistiam) msg += ` ${jaExistiam} já estavam anexados (ignorados).`;
  if (semCnpj) msg += ` ${semCnpj} sem CNPJ localizado.`;
  if (semEmpresa) msg += ` ${semEmpresa} sem empresa cadastrada com esse CNPJ.`;
  if (comErro) msg += ` ${comErro} com erro de leitura.`;
  notificar(msg);
  alert(msg + "\n\nLembre-se de clicar em Salvar para gravar os comentários e status.");
  e.target.value = "";
});

$("#busca")?.addEventListener("input", (e) => renderizarGrupos(e.target.value.toLowerCase()));

iniciarPagina();
