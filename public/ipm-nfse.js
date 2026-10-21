// ============================================================================
// ipm-nfse.js — baixa os XML das NFS-e emitidas no Atende.Net (IPM) de Campo Mourão.
//
// O webservice da IPM só consulta UMA nota por vez (número + série + cadastro econômico).
// Como a numeração é sequencial e as datas crescem com o número, o sistema:
//   1. descobre a última nota existente (saltos 1, 2, 4, 8... e depois busca no intervalo);
//   2. procura a primeira nota do mês escolhido (busca no intervalo pelas datas);
//   3. baixa as notas seguintes até sair do mês.
// Assim, para um mês com 30 notas, são só ~45 consultas, em ~5 chamadas ao Worker.
// O número da última nota fica guardado na empresa, e a próxima busca começa dali.
// ============================================================================
const IPM_POR_CHAMADA = 15;
const IPM_PONTOS_BUSCA = 3;   // pontos testados por rodada na busca (menos consultas à prefeitura)
const IPM_SALTOS_POR_RODADA = 4;

function _dataNum(br) { // "21/09/2026" → 20260921
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(br || "");
  return m ? +(m[3] + m[2] + m[1]) : null;
}
function _pontosEntre(lo, hi, qtd) { // até "qtd" inteiros espalhados em (lo, hi), sem repetir
  const pts = new Set();
  for (let i = 1; i <= qtd; i++) {
    const p = Math.round(lo + ((hi - lo) * i) / (qtd + 1));
    if (p > lo && p < hi) pts.add(p);
  }
  return [...pts].sort((a, b) => a - b);
}
const _brl = (v) => (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const _ipmUrl = {}; // por município: endereço do webservice que funcionou
class BuscaNfseIpm {
  constructor(empresa) {
    this.e = empresa;
    this.municipio = municipioNfse(empresa).chave;
    this.cache = new Map(); // numero -> { existe, dados, xmlBase64 }
    this.chamadas = 0;
  }

  // Sempre traz o XML junto: as notas achadas durante a busca já servem para o download,
  // sem consultar a mesma nota duas vezes.
  async consultar(numeros) {
    const faltam = numeros.filter((n) => !this.cache.has(n));
    for (let i = 0; i < faltam.length; i += IPM_POR_CHAMADA) {
      const lote = faltam.slice(i, i + IPM_POR_CHAMADA);
      this.chamadas++;
      const r = await api("/api/ipm/consultar", {
        method: "POST",
        body: JSON.stringify({ municipio: this.municipio, cnpj: this.e.cnpj, login: limparDigitos(this.e.loginPrefeitura) || undefined, senha: this.e.senhaPrefeitura, cadastro: this.e.cadastroMunicipal, serie: this.e.nfseSerie || "1", numeros: lote, comXml: true, url: _ipmUrl[this.municipio] || undefined }),
      });
      if (r.url) _ipmUrl[this.municipio] = r.url; // endereço do webservice que funcionou: as próximas chamadas já vão direto nele
      for (const nota of r.notas) this.cache.set(nota.numero, nota);
    }
    return numeros.map((n) => this.cache.get(n) || { numero: n, existe: false });
  }

  menorExistente() {
    let m = Infinity;
    for (const r of this.cache.values()) if (r.existe && r.numero < m) m = r.numero;
    return m;
  }

  async ultimaNota() {
    let base = Number(this.e.nfseIpm && this.e.nfseIpm.ultimo) || 0;
    if (base > 0 && !(await this.consultar([base]))[0].existe) base = 0;
    if (base === 0) {
      // A numeração normalmente começa em 1, mas empresas que vieram de outro sistema
      // podem começar mais adiante: testa alguns pontos e parte do maior que existir.
      const pontos = [1, 2, 3, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 20000, 50000];
      const res = await this.consultar(pontos);
      const achados = pontos.filter((_, i) => res[i].existe);
      if (!achados.length) {
        throw Object.assign(new Error("A prefeitura não encontrou nenhuma NFS-e dessa empresa com esse cadastro e essa série."), {
          dica: "Confira nos dados da empresa: (1) “Cadastro econômico (prefeitura)” — o número do cadastro econômico/inscrição municipal como aparece no Atende.Net (se tiver um dígito depois do traço, tente sem ele); (2) “Série da NFS-e” — veja a série impressa numa nota emitida (normalmente 1). Se a empresa ainda não emitiu nenhuma nota no Atende.Net, isso é normal. Se o cadastro e a série estão certos, a numeração pode começar num número alto: informe abaixo o nº de uma nota que você sabe que existe.",
          pedirNumero: true,
        });
      }
      base = achados[achados.length - 1];
    }
    // Saltos: base+1, +2, +4 ... até achar um número que não existe
    let lo = base, hi = null, expoente = 0;
    while (hi === null) {
      const saltos = Array.from({ length: IPM_SALTOS_POR_RODADA }, (_, k) => base + 2 ** (expoente + k));
      expoente += IPM_SALTOS_POR_RODADA;
      const res = await this.consultar(saltos);
      const i = res.findIndex((r) => !r.existe);
      if (i === -1) lo = saltos[saltos.length - 1];
      else { hi = saltos[i]; lo = i === 0 ? lo : saltos[i - 1]; }
    }
    // Busca no intervalo (lo existe, hi não existe)
    while (hi - lo > 1) {
      const pts = _pontosEntre(lo, hi, IPM_PONTOS_BUSCA);
      const res = await this.consultar(pts);
      for (const [k, p] of pts.entries()) {
        if (res[k].existe) lo = p; else { hi = p; break; }
      }
    }
    return lo;
  }

  async primeiraDoMes(ultima, inicio) {
    const dataDe = (r) => (r && r.existe ? _dataNum(r.dados.data) : null);
    if ((dataDe((await this.consultar([ultima]))[0]) ?? 0) < inicio) return null; // nenhuma nota desse mês em diante
    let lo = 0, hi = ultima; // lo: data < início (ou "antes da nº 1"); hi: data >= início
    while (hi - lo > 1) {
      const pts = _pontosEntre(lo, hi, IPM_PONTOS_BUSCA);
      const res = await this.consultar(pts);
      let mudou = false;
      for (const [k, p] of pts.entries()) {
        const d = dataDe(res[k]);
        if (d === null) {
          // Abaixo da menor nota conhecida: a numeração ainda não tinha começado (conta como "antes do mês").
          // Acima dela: é um número pulado, ignora.
          if (p < this.menorExistente()) { lo = p; mudou = true; }
          continue;
        }
        if (d >= inicio) { hi = p; mudou = true; break; }
        lo = p; mudou = true;
      }
      if (!mudou) break;
    }
    return hi;
  }

  async notasDoMes(anoMes, aoProgredir) {
    const [ano, mes] = anoMes.split("-").map(Number);
    const inicio = ano * 10000 + mes * 100 + 1;
    const fim = ano * 10000 + mes * 100 + 31;
    aoProgredir && aoProgredir("procurando a última nota emitida...");
    const ultima = await this.ultimaNota();
    aoProgredir && aoProgredir(`última nota: nº ${ultima} — procurando o início do mês...`);
    const primeira = await this.primeiraDoMes(ultima, inicio);
    const notas = [];
    if (primeira !== null) {
      let n = primeira;
      while (n <= ultima) {
        const lote = [];
        for (let k = 0; k < IPM_POR_CHAMADA && n + k <= ultima; k++) lote.push(n + k);
        aoProgredir && aoProgredir(`baixando notas nº ${lote[0]} a ${lote[lote.length - 1]}...`);
        const res = await this.consultar(lote);
        let saiu = false;
        for (const r of res) {
          if (!r.existe) continue;
          const d = _dataNum(r.dados.data);
          if (d > fim) { saiu = true; break; }
          if (d >= inicio) notas.push(r);
        }
        if (saiu) break;
        n += lote.length;
      }
    }
    return { notas, ultima };
  }
}

// ---------------------------------------------------------------------------
// ZIP (JSZip carregado só quando precisa)
// ---------------------------------------------------------------------------
let _jszipCarregando = null;
function carregarJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!_jszipCarregando) {
    _jszipCarregando = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => { _jszipCarregando = null; reject(new Error("Não consegui carregar o gerador de ZIP. Confira a internet e tente de novo.")); };
      document.head.appendChild(s);
    });
  }
  return _jszipCarregando;
}

function _nomeArquivoSeguro(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || "empresa";
}
function _bytesDeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function _baixarBlob(blob, nome) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function resumirNotas(notas) {
  const emitidas = notas.filter((n) => !n.dados.cancelada);
  return {
    total: notas.length,
    emitidas: emitidas.length,
    canceladas: notas.length - emitidas.length,
    valor: emitidas.reduce((s, n) => s + n.dados.valorTotal, 0),
    issRetido: emitidas.reduce((s, n) => s + n.dados.issRetido, 0),
    primeira: notas.length ? notas[0].numero : null,
    ultimaDoMes: notas.length ? notas[notas.length - 1].numero : null,
  };
}

async function zipDaEmpresa(JSZip, notas, pasta = null) {
  const zip = new JSZip();
  const alvo = pasta ? zip.folder(pasta) : zip;
  for (const n of notas) alvo.file(`NFSe_${String(n.numero).padStart(6, "0")}${n.dados.cancelada ? "_CANCELADA" : ""}.xml`, _bytesDeBase64(n.xmlBase64));
  return zip;
}


// ---------------------------------------------------------------------------
// LEITURA DO XML NO NAVEGADOR (para abrir ZIPs já anexados, sem consultar a prefeitura)
// ---------------------------------------------------------------------------
const _reTag = (t, g = "") => new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, "i" + g);
const _tagX = (xml, t) => { const m = _reTag(t).exec(xml || ""); return m ? m[1].trim() : ""; };
const _blocosX = (xml, t) => [...(xml || "").matchAll(_reTag(t, "g"))].map((m) => m[1]);
function _valorX(s) {
  s = String(s || "").trim();
  if (!s) return 0;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}
function _textoDoXml(bytes) {
  const inicio = new TextDecoder("latin1").decode(bytes.slice(0, 120));
  return new TextDecoder(/encoding=["']utf-?8/i.test(inicio) ? "utf-8" : "windows-1252").decode(bytes);
}
function lerNotaXml(xml) {
  const tomador = _tagX(xml, "tomador");
  const itens = _blocosX(xml, "item");
  return {
    numero: _tagX(xml, "numero_nfse"),
    data: _tagX(xml, "data_nfse"),
    cancelada: _tagX(xml, "situacao_codigo_nfse") === "2" || /cancelad/i.test(_tagX(xml, "situacao_descricao_nfse")),
    valorTotal: _valorX(_tagX(_tagX(xml, "nf") || xml, "valor_total")),
    issRetido: itens.reduce((s, it) => s + _valorX(_tagX(it, "valor_issrf")), 0),
    tomadorNome: _tagX(tomador, "nome_razao_social"),
    tomadorCnpj: _tagX(tomador, "cpfcnpj"),
    link: _tagX(xml, "link_nfse"),
  };
}
const _bytesDaNota = (n) => n.bytes || _bytesDeBase64(n.xmlBase64);
const _nomeXml = (n) => `NFSe_${String(n.numero).padStart(6, "0")}${n.dados.cancelada ? "_CANCELADA" : ""}.xml`;
function _fmtDoc(d) {
  d = limparDigitos(d);
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  return d;
}

// ---------------------------------------------------------------------------
// PÁGINA "XML NFS-e"
// Usa as mesmas empresas da página Empresas (CNPJ, senha da prefeitura,
// cadastro econômico e série). O resumo de cada mês fica guardado na própria
// empresa (empresa.nfseIpm.meses), então a página já abre mostrando o que foi buscado.
// ---------------------------------------------------------------------------
const XMLP = {
  mes: null,
  notas: new Map(),      // `${id}|${mes}` -> notas (desta sessão ou lidas do ZIP anexado)
  erros: new Map(),      // `${id}|${mes}` -> erro
  progresso: new Map(),  // id -> texto
  selecionadas: null,    // Set de ids
  abertas: new Set(),    // ids com a lista de notas aberta
  ocupado: false,
};
const MESES_GUARDADOS = 24;

function empresasParaNfse() {
  const aptas = [], fora = [];
  ESTADO.grupos.forEach((g) => g.empresas.forEach((e) => {
    const mun = municipioNfse(e);
    if (mun.sistema !== "ipm") { fora.push({ e, motivo: `${mun.nome} · ${SISTEMAS_NFSE[mun.sistema]} — em preparação` }); return; }
    const falta = [];
    if (limparDigitos(e.cnpj).length < 11) falta.push("CNPJ");
    if (!e.senhaPrefeitura) falta.push("senha da prefeitura");
    if (!limparDigitos(e.cadastroMunicipal)) falta.push("cadastro econômico");
    if (falta.length) fora.push({ e, motivo: "falta " + falta.join(", ") });
    else aptas.push(e);
  }));
  const porNome = (a, b) => String(a.nome || a.e?.nome).localeCompare(String(b.nome || b.e?.nome), "pt-BR");
  return { aptas: aptas.sort(porNome), fora: fora.sort(porNome) };
}
const _chave = (e, mes = XMLP.mes) => `${e.id}|${mes}`;
const _hist = (e, mes = XMLP.mes) => e.nfseIpm && e.nfseIpm.meses && e.nfseIpm.meses[mes];
const _rotuloMes = (mes) => { const [a, m] = mes.split("-"); return `${m}/${a}`; };
const _nomeMes = (mes) => { const [a, m] = mes.split("-").map(Number); return new Date(a, m - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" }); };
function _quando(iso) {
  if (!iso) return "";
  const d = new Date(iso), p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function registrarMes(e, mes, notas, anexo) {
  const r = resumirNotas(notas);
  e.nfseIpm = e.nfseIpm || {};
  const meses = { ...(e.nfseIpm.meses || {}) };
  meses[mes] = {
    emitidas: r.emitidas, canceladas: r.canceladas, valor: Math.round(r.valor * 100) / 100,
    issRetido: Math.round(r.issRetido * 100) / 100, primeira: r.primeira, ultima: r.ultimaDoMes,
    anexoId: anexo ? anexo.id : null, anexoNome: anexo ? anexo.nome : null, buscadoEm: new Date().toISOString(),
  };
  // guarda só os meses mais recentes (o cadastro da empresa não cresce para sempre)
  Object.keys(meses).sort().reverse().slice(MESES_GUARDADOS).forEach((k) => delete meses[k]);
  e.nfseIpm.meses = meses;
}

// Notas do mês: as desta sessão ou, se houver, as do ZIP que ficou anexado.
async function carregarNotas(e, mes = XMLP.mes) {
  const k = _chave(e, mes);
  if (XMLP.notas.has(k)) return XMLP.notas.get(k);
  const h = _hist(e, mes);
  if (!h || !h.anexoId) return null;
  const resp = await fetch(`/api/anexos/${h.anexoId}`);
  if (!resp.ok) throw new Error("O ZIP anexado não foi encontrado (pode ter sido apagado). Clique em “Buscar” para baixar de novo.");
  const JSZip = await carregarJSZip();
  const zip = await JSZip.loadAsync(await resp.arrayBuffer());
  const notas = [];
  for (const arq of Object.values(zip.files)) {
    if (arq.dir || !/\.xml$/i.test(arq.name)) continue;
    const bytes = await arq.async("uint8array");
    const dados = lerNotaXml(_textoDoXml(bytes));
    notas.push({ numero: Number(dados.numero) || Number((/(\d+)/.exec(arq.name) || [])[1]), existe: true, dados, bytes });
  }
  notas.sort((a, b) => a.numero - b.numero);
  XMLP.notas.set(k, notas);
  return notas;
}

// ---------- render ----------
function renderizarPagina() {
  if (!XMLP.mes) {
    const mesAnt = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
    XMLP.mes = `${mesAnt.getFullYear()}-${String(mesAnt.getMonth() + 1).padStart(2, "0")}`;
    const hoje = new Date();
    $("#xml-mes").value = XMLP.mes;
    $("#xml-mes").max = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  }
  const { aptas } = empresasParaNfse();
  if (!XMLP.selecionadas) XMLP.selecionadas = new Set(aptas.map((e) => e.id));
  renderizarKpis();
  renderizarLista();
  renderizarFora();
}

function renderizarKpis() {
  const { aptas } = empresasParaNfse();
  let notas = 0, canc = 0, valor = 0, iss = 0, buscadas = 0, comNotas = 0;
  aptas.forEach((e) => {
    const h = _hist(e);
    if (!h) return;
    buscadas++;
    if (h.emitidas + h.canceladas) comNotas++;
    notas += h.emitidas; canc += h.canceladas; valor += h.valor; iss += h.issRetido;
  });
  const erros = aptas.filter((e) => XMLP.erros.has(_chave(e))).length;
  const card = (nome, ic, numero, sub, destaque = false) => `
    <div class="kpi-card${destaque ? " destaque" : ""}">
      <div class="kpi-topo"><span class="kpi-nome">${nome}</span><span class="kpi-icone">${icone(ic, "ico-sm")}</span></div>
      <div class="kpi-numero">${numero}</div>
      <div class="xml-kpi-sub">${sub}</div>
    </div>`;
  $("#xml-kpis").innerHTML =
    card("Notas emitidas", "xml", notas, canc ? `+ ${canc} cancelada(s)` : _nomeMes(XMLP.mes), true) +
    card("Valor total", "grafico", _brl(valor), "só notas não canceladas") +
    card("ISS retido", "documento", _brl(iss), "retido pelos tomadores") +
    card("Empresas", "empresas", `${buscadas}<small>de ${aptas.length}</small>`, erros ? `<span class="xml-kpi-erro">${erros} com erro</span>` : `${comNotas} com notas no mês`);
}

function _htmlEstado(e) {
  const k = _chave(e), h = _hist(e);
  if (XMLP.progresso.has(e.id)) return `<span class="etiqueta etiqueta-info">${icone("carregando", "girando")}${escaparHtml(XMLP.progresso.get(e.id))}</span>`;
  if (XMLP.erros.has(k)) return `<span class="etiqueta etiqueta-erro">${icone("erro")}Erro na busca</span>${h ? `<small>antes: ${h.emitidas} nota(s)</small>` : ""}`;
  if (!h) return `<span class="etiqueta etiqueta-neutra">${icone("relogio")}Ainda não buscado</span>`;
  if (!(h.emitidas + h.canceladas)) return `<span class="etiqueta etiqueta-neutra">${icone("info")}Nenhuma nota no mês</span><small>buscado ${_quando(h.buscadoEm)}</small>`;
  return `<span class="etiqueta etiqueta-ok">${icone("check")}${h.emitidas} nota(s)${h.canceladas ? ` + ${h.canceladas} canc.` : ""} · ${_brl(h.valor)}</span><small>nº ${h.primeira} a ${h.ultima} · buscado ${_quando(h.buscadoEm)}</small>`;
}

function _htmlItem(e) {
  const k = _chave(e), h = _hist(e);
  const temNotas = XMLP.notas.has(k) ? XMLP.notas.get(k).length > 0 : !!(h && h.emitidas + h.canceladas);
  const aberta = XMLP.abertas.has(e.id) && temNotas;
  const err = XMLP.erros.get(k);
  const ocupada = XMLP.progresso.has(e.id);
  return `
    <div class="xml-item${aberta ? " aberta" : ""}" data-id="${e.id}">
      <div class="xml-linha">
        <label class="xml-check" title="Incluir na busca"><input type="checkbox" data-sel="${e.id}"${XMLP.selecionadas.has(e.id) ? " checked" : ""}${XMLP.ocupado ? " disabled" : ""}></label>
        <div class="xml-nome"><b title="${escaparHtml(e.nome)}">${escaparHtml(e.nome)}</b><small>${escaparHtml(municipioNfse(e).nome)} · ${_fmtDoc(e.cnpj)} · cadastro ${escaparHtml(e.cadastroMunicipal)} · série ${escaparHtml(e.nfseSerie || "1")}</small></div>
        <div class="xml-estado">${_htmlEstado(e)}</div>
        <div class="xml-acoes">
          ${temNotas ? `<button type="button" class="btn-ghost btn-sm" data-acao="ver">${icone(aberta ? "setaBaixo" : "seta")}${aberta ? "Fechar" : "Ver notas"}</button>
          <button type="button" class="btn-ghost btn-sm" data-acao="zip" title="Baixar o ZIP com os XML deste mês">${icone("baixar")}ZIP</button>` : ""}
          <button type="button" class="btn-secundario btn-sm" data-acao="buscar"${XMLP.ocupado || ocupada ? " disabled" : ""} title="Buscar só esta empresa">${icone("atualizar")}${h ? "Buscar de novo" : "Buscar"}</button>
        </div>
      </div>
      ${err ? `<div class="nf-erro"><b>${escaparHtml(err.message)}</b>${err.dica ? `<span>${icone("lampada", "ico-sm")}${escaparHtml(err.dica)}</span>` : ""}${err.pedirNumero ? `
        <form class="xml-numero" data-numero="${e.id}"><input type="number" min="1" step="1" placeholder="nº de uma NFS-e emitida" required><button type="submit" class="btn-secundario btn-sm">${icone("busca")}Buscar a partir dela</button></form>` : ""}</div>` : ""}
      ${aberta ? `<div class="xml-detalhe" data-detalhe="${e.id}">${_htmlDetalhe(e)}</div>` : ""}
    </div>`;
}

function _htmlDetalhe(e) {
  const k = _chave(e);
  if (!XMLP.notas.has(k)) {
    const h = _hist(e);
    if (h && !h.anexoId) return `<div class="xml-aviso">${icone("info", "ico-sm")}Nessa busca o ZIP não foi anexado, então a lista de notas não ficou guardada. Clique em “Buscar de novo” para ver as notas.</div>`;
    return `<div class="xml-aviso">${icone("carregando", "ico-sm girando")}Abrindo o ZIP anexado...</div>`;
  }
  const notas = XMLP.notas.get(k);
  return `<div class="xml-tabela-wrap"><table class="xml-tabela">
    <thead><tr><th>Nº</th><th>Data</th><th>Tomador</th><th class="num">Valor</th><th class="num">ISS retido</th><th>Situação</th><th></th></tr></thead>
    <tbody>${notas.map((n, i) => `
      <tr class="${n.dados.cancelada ? "cancelada" : ""}">
        <td class="num-nota">${n.numero}</td>
        <td>${escaparHtml(n.dados.data || "")}</td>
        <td class="tomador">${escaparHtml(n.dados.tomadorNome || "—")}${n.dados.tomadorCnpj ? `<small>${_fmtDoc(n.dados.tomadorCnpj)}</small>` : ""}</td>
        <td class="num">${_brl(n.dados.valorTotal)}</td>
        <td class="num">${n.dados.issRetido ? _brl(n.dados.issRetido) : "—"}</td>
        <td>${n.dados.cancelada ? `<span class="etiqueta etiqueta-erro">Cancelada</span>` : `<span class="etiqueta etiqueta-ok">Emitida</span>`}</td>
        <td class="acoes-nota">
          ${n.dados.link ? `<a class="btn-ghost btn-sm" href="${escaparHtml(n.dados.link)}" target="_blank" rel="noopener" title="Abrir a nota no site da prefeitura">${icone("link")}</a>` : ""}
          <button type="button" class="btn-ghost btn-sm" data-xml="${i}" title="Baixar o XML desta nota">${icone("baixar")}XML</button>
        </td>
      </tr>`).join("")}</tbody></table></div>`;
}

function _filtroOk(e) {
  const f = XMLP.filtro;
  if (!f) return true;
  return String(e.nome || "").toLowerCase().includes(f) || (limparDigitos(f) && limparDigitos(e.cnpj).includes(limparDigitos(f)));
}

function renderizarLista() {
  const { aptas } = empresasParaNfse();
  const visiveis = aptas.filter(_filtroOk);
  const nSel = aptas.filter((e) => XMLP.selecionadas.has(e.id)).length;
  $("#xml-contador").textContent = `${nSel} de ${aptas.length} selecionada(s)`;
  $("#xml-buscar span").textContent = nSel ? `Buscar ${_rotuloMes(XMLP.mes)} de ${nSel} empresa${nSel > 1 ? "s" : ""}` : "Buscar notas";
  $("#xml-buscar").disabled = !nSel || XMLP.ocupado;
  const algumMes = aptas.some((e) => { const h = _hist(e); return (h && h.emitidas + h.canceladas) || (XMLP.notas.get(_chave(e)) || []).length; });
  $("#xml-zip-todas").classList.toggle("oculto", !algumMes);
  $("#xml-lista").innerHTML = !aptas.length
    ? `<div class="vazio">${icone("xml")}<strong>Nenhuma empresa pronta</strong><p>Preencha CNPJ, “Senha Prefeitura” e “Cadastro econômico (prefeitura)” na página Empresas.</p><a class="btn-secundario btn-sm" href="/empresas.html">${icone("empresas")}Ir para Empresas</a></div>`
    : visiveis.length ? visiveis.map(_htmlItem).join("") : `<div class="vazio">${icone("busca")}<p>Nenhuma empresa com esse filtro.</p></div>`;
  // abre as listas que dependem do ZIP anexado
  visiveis.forEach((e) => { if (XMLP.abertas.has(e.id) && !XMLP.notas.has(_chave(e))) abrirNotas(e); });
}

function atualizarItem(e) {
  const atual = $(`#xml-lista .xml-item[data-id="${e.id}"]`);
  if (atual) atual.outerHTML = _htmlItem(e);
}

function renderizarFora() {
  const { fora } = empresasParaNfse();
  $("#xml-fora").innerHTML = fora.length ? `
    <details class="wl-fora"><summary>${fora.length} empresa(s) fora da busca — <a href="/empresas.html">ver na página Empresas</a></summary>
      ${fora.map(({ e, motivo }) => `<div class="wl-fora-item"><span>${escaparHtml(e.nome)}</span><small>${motivo}</small></div>`).join("")}
    </details>` : "";
}

async function abrirNotas(e) {
  const mes = XMLP.mes;
  try {
    await carregarNotas(e, mes);
  } catch (err) {
    XMLP.abertas.delete(e.id);
    notificar(err.message, "erro");
  }
  if (mes === XMLP.mes) atualizarItem(e);
}

// ---------- ações ----------
$("#xml-mes")?.addEventListener("change", (ev) => {
  if (!/^\d{4}-\d{2}$/.test(ev.target.value)) return;
  XMLP.mes = ev.target.value;
  XMLP.abertas.clear();
  renderizarKpis(); renderizarLista();
});
$("#busca")?.addEventListener("input", (ev) => { XMLP.filtro = ev.target.value.trim().toLowerCase(); renderizarLista(); });
$("#xml-todas")?.addEventListener("click", () => { empresasParaNfse().aptas.filter(_filtroOk).forEach((e) => XMLP.selecionadas.add(e.id)); renderizarLista(); });
$("#xml-nenhuma")?.addEventListener("click", () => { empresasParaNfse().aptas.filter(_filtroOk).forEach((e) => XMLP.selecionadas.delete(e.id)); renderizarLista(); });
$("#xml-nao-buscadas")?.addEventListener("click", () => {
  XMLP.selecionadas = new Set(empresasParaNfse().aptas.filter((e) => !_hist(e) || XMLP.erros.has(_chave(e))).map((e) => e.id));
  renderizarLista();
});

$("#xml-lista")?.addEventListener("submit", (ev) => {
  const form = ev.target.closest("[data-numero]");
  if (!form) return;
  ev.preventDefault();
  const e = empresasParaNfse().aptas.find((x) => x.id === form.dataset.numero);
  const n = Number(form.querySelector("input").value);
  if (!e || !Number.isInteger(n) || n < 1) return;
  e.nfseIpm = { ...(e.nfseIpm || {}), ultimo: n }; // a busca começa por esse número
  buscarEmpresas([e]);
});

$("#xml-lista")?.addEventListener("change", (ev) => {
  const id = ev.target.dataset.sel;
  if (!id) return;
  ev.target.checked ? XMLP.selecionadas.add(id) : XMLP.selecionadas.delete(id);
  renderizarLista();
});

$("#xml-lista")?.addEventListener("click", async (ev) => {
  const item = ev.target.closest(".xml-item");
  if (!item) return;
  const e = empresasParaNfse().aptas.find((x) => x.id === item.dataset.id);
  if (!e) return;
  const btnXml = ev.target.closest("[data-xml]");
  if (btnXml) {
    const n = (XMLP.notas.get(_chave(e)) || [])[+btnXml.dataset.xml];
    if (n) _baixarBlob(new Blob([_bytesDaNota(n)], { type: "text/xml" }), _nomeXml(n));
    return;
  }
  const btn = ev.target.closest("[data-acao]");
  if (!btn) return;
  const acao = btn.dataset.acao;
  if (acao === "ver") {
    XMLP.abertas.has(e.id) ? XMLP.abertas.delete(e.id) : XMLP.abertas.add(e.id);
    atualizarItem(e);
    if (XMLP.abertas.has(e.id) && !XMLP.notas.has(_chave(e))) abrirNotas(e);
  } else if (acao === "zip") {
    comCarregando(btn, () => baixarZipEmpresa(e));
  } else if (acao === "buscar") {
    buscarEmpresas([e]);
  }
});

async function baixarZipEmpresa(e) {
  const h = _hist(e);
  const nome = `NFSe_${_nomeArquivoSeguro(e.nome)}_${XMLP.mes.slice(5)}-${XMLP.mes.slice(0, 4)}.zip`;
  const notas = XMLP.notas.get(_chave(e));
  if (!notas && h && h.anexoId) return baixarAnexo({ id: h.anexoId });
  try {
    const lista = notas || (await carregarNotas(e));
    if (!lista || !lista.length) return notificar("Essa busca não guardou o ZIP. Clique em “Buscar de novo”.", "aviso");
    const JSZip = await carregarJSZip();
    const zip = new JSZip();
    lista.forEach((n) => zip.file(_nomeXml(n), _bytesDaNota(n)));
    _baixarBlob(await zip.generateAsync({ type: "blob", compression: "DEFLATE" }), nome);
  } catch (err) { notificar(err.message, "erro"); }
}

$("#xml-zip-todas")?.addEventListener("click", (ev) => comCarregando(ev.currentTarget, async () => {
  const JSZip = await carregarJSZip().catch((err) => { notificar(err.message, "erro"); return null; });
  if (!JSZip) return;
  const zip = new JSZip();
  let qtd = 0, falhas = 0;
  for (const e of empresasParaNfse().aptas) {
    const h = _hist(e);
    if (!XMLP.notas.has(_chave(e)) && !(h && h.anexoId && h.emitidas + h.canceladas)) continue;
    try {
      const notas = await carregarNotas(e);
      if (!notas || !notas.length) continue;
      const pasta = zip.folder(_nomeArquivoSeguro(e.nome));
      notas.forEach((n) => pasta.file(_nomeXml(n), _bytesDaNota(n)));
      qtd += notas.length;
    } catch { falhas++; }
  }
  if (!qtd) return notificar("Nenhuma nota guardada para esse mês. Faça a busca primeiro.", "aviso");
  _baixarBlob(await zip.generateAsync({ type: "blob", compression: "DEFLATE" }), `NFSe_${XMLP.mes.slice(5)}-${XMLP.mes.slice(0, 4)}_todas.zip`);
  if (falhas) notificar(`${falhas} empresa(s) ficaram de fora: o ZIP anexado não foi encontrado.`, "aviso");
}));

$("#xml-buscar")?.addEventListener("click", () => {
  const sel = empresasParaNfse().aptas.filter((e) => XMLP.selecionadas.has(e.id));
  if (sel.length) buscarEmpresas(sel);
});

async function buscarEmpresas(lista) {
  if (XMLP.ocupado) return;
  const mes = XMLP.mes;
  const rotulo = _rotuloMes(mes);
  const opcoes = { anexar: $("#xml-anexar").checked, comentar: $("#xml-comentar").checked, marcar: $("#xml-marcar").checked };
  XMLP.ocupado = true;
  $("#xml-mes").disabled = true;
  lista.forEach((e) => { XMLP.progresso.set(e.id, "Na fila"); XMLP.erros.delete(_chave(e, mes)); });
  renderizarLista(); renderizarKpis();

  let JSZip = null;
  if (opcoes.anexar) { try { JSZip = await carregarJSZip(); } catch (err) { notificar(err.message, "erro"); } }

  let mudou = false, totalNotas = 0, comErro = 0;
  const fila = [...lista];
  const trabalhador = async () => {
    while (fila.length) {
      const e = fila.shift();
      const progresso = (t) => { XMLP.progresso.set(e.id, t); atualizarItem(e); };
      progresso("Buscando...");
      try {
        const { notas, ultima } = await new BuscaNfseIpm(e).notasDoMes(mes, progresso);
        e.nfseIpm = { ...(e.nfseIpm || {}), ultimo: ultima, atualizadoEm: new Date().toISOString() };
        XMLP.notas.set(_chave(e, mes), notas);
        const resumo = resumirNotas(notas);
        totalNotas += resumo.emitidas;
        let anexo = null;
        if (notas.length) {
          if (opcoes.comentar) {
            const prefixo = `NFS-e ${rotulo} (prefeitura):`;
            e.comentarios = (e.comentarios || []).filter((c) => !String(c).startsWith(prefixo)); // uma anotação por mês
            e.comentarios.push(`${prefixo} ${resumo.emitidas} emitida(s)` + (resumo.canceladas ? `, ${resumo.canceladas} cancelada(s)` : "") +
              ` · nº ${resumo.primeira} a ${resumo.ultimaDoMes} · total ${_brl(resumo.valor)}` +
              (resumo.issRetido ? ` · ISS retido ${_brl(resumo.issRetido)}` : "") + `\n${agora()}`);
          }
          if (opcoes.marcar) e.nfs = true;
          if (opcoes.anexar && JSZip) {
            progresso("Anexando o ZIP...");
            const blob = await (await zipDaEmpresa(JSZip, notas)).generateAsync({ type: "blob", compression: "DEFLATE" });
            const arquivo = new File([blob], `NFSe_${_nomeArquivoSeguro(e.nome)}_${mes.slice(5)}-${mes.slice(0, 4)}.zip`, { type: "application/zip" });
            e.anexos = e.anexos || [];
            // a nova busca do mesmo mês substitui o ZIP anterior (e apaga o antigo do armazenamento)
            const antigos = e.anexos.filter((a) => a.nome === arquivo.name);
            const anteriorId = _hist(e, mes)?.anexoId;
            e.anexos = e.anexos.filter((a) => a.nome !== arquivo.name);
            for (const id of new Set([...antigos.map((a) => a.id), anteriorId].filter(Boolean))) api(`/api/anexos/${id}`, { method: "DELETE" }).catch(() => {});
            anexo = await anexarArquivoNaLista(e.anexos, arquivo);
          }
        }
        registrarMes(e, mes, notas, anexo);
        mudou = true;
      } catch (err) {
        comErro++;
        XMLP.erros.set(_chave(e, mes), err);
      }
      XMLP.progresso.delete(e.id);
      atualizarItem(e); renderizarKpis();
    }
  };
  await Promise.all([trabalhador(), trabalhador()]); // duas empresas por vez (logins diferentes)

  XMLP.ocupado = false;
  $("#xml-mes").disabled = false;
  renderizarLista(); renderizarKpis();
  if (mudou) { marcarAlterado(); await salvar(); } // guarda o resumo, o último nº e os anexos sem precisar lembrar de salvar
  const ok = lista.length - comErro;
  notificar(comErro ? `Busca concluída: ${ok} empresa(s) ok, ${comErro} com erro` : `Busca concluída: ${totalNotas} nota(s) em ${ok} empresa(s)`, comErro ? "aviso" : "ok");
}

iniciarPagina();
