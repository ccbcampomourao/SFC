// ============================================================================
// exportar-clientes.js — "Exportar planilha" na página Empresas.
// Gera um Excel (.xlsx) com todos os clientes cadastrados, uma linha por empresa,
// com as colunas da tela de cadastro do outro sistema (mesma ordem):
// Razão social, Nome fantasia, Apelido, CPF/CNPJ/CEI, Código empresa, Tipo, Situação,
// Insc. estadual, Insc. municipal, Situação cadastral, Regime tributário,
// Natureza jurídica, Cliente desde, Início atividades, Pasta de arquivos, Notas internas.
// O que o Prumo não guarda é completado pela consulta pública de CNPJ (cache de 24 h,
// não gasta KV). Senhas NUNCA vão para a planilha.
// ============================================================================
const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
const COLUNAS_EXPORTACAO = ["Razão social", "Nome fantasia", "Apelido", "CPF / CNPJ / CEI", "Código empresa", "Tipo", "Situação",
  "Insc. estadual", "Insc. municipal", "Situação cadastral", "Regime tributário", "Natureza jurídica", "Cliente desde",
  "Início atividades", "Pasta de arquivos", "Notas internas"];

function carregarXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((ok, falha) => {
    const s = document.createElement("script");
    s.src = XLSX_URL;
    s.onload = () => (window.XLSX ? ok(window.XLSX) : falha(new Error("biblioteca de planilha não carregou")));
    s.onerror = () => falha(new Error("sem internet para carregar a biblioteca de planilha"));
    document.head.appendChild(s);
  });
}

function _docFormatado(d) {
  d = limparDigitos(d);
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  return d;
}

function _todasEmpresas() {
  const vistos = new Set(), lista = [];
  for (const g of ESTADO.grupos || []) for (const e of g.empresas || []) {
    if (vistos.has(e)) continue;
    vistos.add(e); lista.push({ e, grupo: g.nome });
  }
  return lista;
}

function abrirExportarClientes() {
  const total = _todasEmpresas().length;
  if (!total) return notificar("Não há empresas cadastradas para exportar.", "aviso");
  abrirModal(`
    <form id="form-exportar" class="form-exportar">
      <h2>Exportar clientes para planilha</h2>
      <p class="modal-sub">Gera um Excel com as <b>${total}</b> empresas cadastradas, uma por linha, nas mesmas colunas da tela de cadastro
        (razão social, nome fantasia, CNPJ, inscrições, situação cadastral, regime, natureza jurídica, início das atividades…).</p>
      <label class="check-linha"><input type="checkbox" id="exp-receita" checked>
        <span><b>Completar com os dados públicos da Receita</b><small>Razão social, nome fantasia, situação cadastral, regime (Simples/MEI), natureza jurídica e início das atividades. Leva alguns segundos por empresa.</small></span></label>
      <p class="modal-sub exp-aviso">As senhas não vão para a planilha.</p>
      <div id="exp-progresso" class="exp-progresso oculto"><div class="exp-barra"><div></div></div><span></span></div>
      <div class="modal-rodape">
        <button type="button" class="btn-secundario" id="exp-cancelar">Cancelar</button>
        <button type="submit" class="btn-primario" id="exp-gerar">${icone("baixar")}Gerar planilha</button>
      </div>
    </form>`);
  let cancelado = false;
  $("#exp-cancelar").addEventListener("click", () => { cancelado = true; fecharModal(); });
  $("#form-exportar").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const comReceita = $("#exp-receita").checked;
    $("#exp-gerar").disabled = true; $("#exp-receita").disabled = true;
    $("#exp-progresso").classList.remove("oculto");
    const progresso = (feitos, total, txt) => {
      const barra = $("#exp-progresso .exp-barra div"), rotulo = $("#exp-progresso span");
      if (barra) barra.style.width = `${Math.round((feitos / Math.max(total, 1)) * 100)}%`;
      if (rotulo) rotulo.textContent = txt;
    };
    try {
      const XLSX = await carregarXlsx();
      const linhas = await montarLinhasExportacao(comReceita, progresso, () => cancelado);
      if (cancelado) return;
      const nome = `clientes-fzcont-${new Date().toISOString().slice(0, 10)}.xlsx`;
      gerarXlsxClientes(XLSX, linhas.dados, nome);
      fecharModal();
      notificar(linhas.falhas ? `Planilha gerada. ${linhas.falhas} empresa(s) ficaram sem os dados da Receita (consulta falhou) — o resto está completo.` : "Planilha gerada.", linhas.falhas ? "aviso" : "sucesso");
    } catch (err) {
      notificar("Não consegui gerar a planilha: " + err.message, "erro");
      $("#exp-gerar") && ($("#exp-gerar").disabled = false);
    }
  });
}

async function _consultaReceita(cnpj, cancelado) {
  for (let tentativa = 0; tentativa < 4 && !cancelado(); tentativa++) {
    try {
      const r = await fetch(`/api/consulta-cnpj/cadastro?cnpj=${cnpj}`, { signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
      if (r.status === 404 || r.status === 400) return null;
      if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 15000)); continue; } // sites gratuitos limitando: espera e tenta de novo
    } catch {}
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  return null;
}

async function montarLinhasExportacao(comReceita, progresso, cancelado) {
  const lista = _todasEmpresas(), dados = [];
  let falhas = 0, feitos = 0;
  const receita = new Map();
  if (comReceita) {
    const cnpjs = [...new Set(lista.map(({ e }) => limparDigitos(e.cnpj)).filter((d) => d.length === 14))];
    let i = 0;
    const trabalhador = async () => {
      while (i < cnpjs.length && !cancelado()) {
        const c = cnpjs[i++];
        const r = await _consultaReceita(c, cancelado);
        if (r) receita.set(c, r); else falhas++;
        feitos++;
        progresso(feitos, cnpjs.length, `Consultando a Receita: ${feitos} de ${cnpjs.length}…`);
      }
    };
    progresso(0, cnpjs.length, `Consultando a Receita: 0 de ${cnpjs.length}…`);
    await Promise.all([trabalhador(), trabalhador()]); // 2 por vez: os sites gratuitos limitam
  }
  for (const { e } of lista) {
    const doc = limparDigitos(e.cnpj);
    const r = receita.get(doc) || {};
    const regime = r.optanteMei === true ? "MEI" : r.optanteSimples === true ? "Simples Nacional" : "";
    dados.push([
      r.razao_social || e.nome || "",
      r.nome || "",
      e.nome || "",
      _docFormatado(e.cnpj || e.cpf || ""),
      "",
      "",
      "Ativo",
      e.inscricaoEstadual || r.ie || "",
      e.cadastroMunicipal || "",
      r.situacao ? r.situacao.charAt(0).toUpperCase() + r.situacao.slice(1).toLowerCase() : "",
      regime,
      r.naturezaJuridica || "",
      "",
      r.inicioAtividade ? new Date(r.inicioAtividade + "T12:00:00") : "",
      "",
      "",
    ]);
  }
  dados.sort((a, b) => String(a[0]).localeCompare(String(b[0]), "pt-BR"));
  return { dados, falhas };
}

function gerarXlsxClientes(XLSX, dados, nomeArquivo) {
  const ws = XLSX.utils.aoa_to_sheet([COLUNAS_EXPORTACAO, ...dados], { cellDates: true, dateNF: "dd/mm/yyyy" });
  // CNPJ e inscrições como TEXTO (o Excel não come zeros à esquerda); datas no formato brasileiro
  const ref = XLSX.utils.decode_range(ws["!ref"]);
  for (let R = 1; R <= ref.e.r; R++) {
    for (const C of [3, 4, 7, 8]) { const cel = ws[XLSX.utils.encode_cell({ r: R, c: C })]; if (cel && cel.v !== "") { cel.t = "s"; cel.v = String(cel.v); } }
    for (const C of [12, 13]) { const cel = ws[XLSX.utils.encode_cell({ r: R, c: C })]; if (cel && cel.t === "d") cel.z = "dd/mm/yyyy"; }
  }
  ws["!cols"] = [44, 30, 30, 21, 14, 14, 10, 16, 16, 18, 18, 42, 14, 16, 30, 30].map((wch) => ({ wch }));
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: ref.e.r, c: ref.e.c } }) };
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Clientes");
  XLSX.writeFile(wb, nomeArquivo, { compression: true });
}
