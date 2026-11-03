// ============================================================================
// nfse-emitir.js — emissão de NFS-e Nacional pelo robô do escritório.
// Tudo o que é da emissão (configuração da empresa, serviços, tomadores e as
// notas) fica no banco do COMPUTADOR DO ROBÔ: cada ação aqui vira um pedido
// pelo canal direto (/api/emissao). Nada disso grava no KV da Cloudflare.
// ============================================================================
const EM = {
  inicio: null,            // certificados e empresas configuradas no robô
  cnpj: localStorage.getItem("prumo_emissao_cnpj") || "",
  cad: null,               // { emitente, servicos, tomadores, proximoDps, certificado }
  aba: "emitir",
  tomador: null,           // tomador escolhido no formulário
  servicoId: "",
  enviadas: [],            // notas mandadas nesta tela (acompanha até sair)
  filtro: { de: "", ate: "", status: "", texto: "", pagina: 0 },
  timer: 0,
  copia: null,             // pedido copiado de uma nota anterior
  erroRobo: null,
};
const _m = (n) => (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const _so = (v) => String(v || "").replace(/\D/g, "");
const _hojeISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const _quando = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
function _doc(d) {
  d = _so(d);
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  return d;
}
const ST = { fila: ["Na fila", "aviso"], enviando: ["Enviando…", "info"], verificar: ["Conferindo…", "info"], emitida: ["Emitida", "ok"], erro: ["Recusada", "erro"], descartada: ["Descartada", "neutra"] };
const _etq = (st) => { const [t, c] = ST[st] || [st, "neutra"]; return `<span class="etiqueta etiqueta-${c}">${["fila", "enviando", "verificar"].includes(st) ? icone("carregando", "girando") : ""}${t}</span>`; };

// Pedido ao robô (passa pelo Prumo, que só repassa)
async function robo(acao, dados = {}) {
  return (await api("/api/emissao", { method: "POST", body: JSON.stringify({ acao: "emissao." + acao, dados }) })).dados;
}

// ---------------------------------------------------------------------------
// Empresas: as da página Empresas que têm certificado A1 no robô
// ---------------------------------------------------------------------------
function empresasEmissao() {
  const certs = (EM.inicio && EM.inicio.certificados) || [];
  const conf = (EM.inicio && EM.inicio.emitentes) || {};
  const lista = new Map();
  (ESTADO.grupos || []).forEach((g) => g.empresas.forEach((e) => {
    const d = _so(e.cnpj);
    if (d.length === 14 && certs.some((c) => c.cnpj.slice(0, 8) === d.slice(0, 8))) lista.set(d, { cnpj: d, nome: e.nome, configurada: !!conf[d], empresa: e });
  }));
  Object.values(conf).forEach((c) => { if (!lista.has(c.cnpj)) lista.set(c.cnpj, { cnpj: c.cnpj, nome: c.nome || _doc(c.cnpj), configurada: true }); });
  return [...lista.values()].sort((a, b) => String(a.nome).localeCompare(String(b.nome), "pt-BR"));
}
const empresaAtual = () => empresasEmissao().find((x) => x.cnpj === EM.cnpj) || null;

async function carregarInicio() {
  try {
    EM.inicio = await robo("inicio");
    EM.erroRobo = null;
  } catch (err) { EM.erroRobo = err; EM.inicio = null; }
}
async function carregarCadastros() {
  EM.cad = null;
  if (!EM.cnpj) return;
  EM.cad = await robo("cadastros", { cnpj: EM.cnpj });
  if (!EM.cad.servicos.some((s) => s.id === EM.servicoId)) EM.servicoId = (EM.cad.servicos[0] || {}).id || "";
}

function desenharTopo() {
  const sel = $("#emi-empresa"), lista = empresasEmissao();
  if (lista.length && !lista.some((x) => x.cnpj === EM.cnpj)) EM.cnpj = lista[0].cnpj;
  sel.innerHTML = lista.length ? lista.map((x) => `<option value="${x.cnpj}"${x.cnpj === EM.cnpj ? " selected" : ""}>${escaparHtml(x.nome)} · ${_doc(x.cnpj)}${x.configurada ? "" : " (falta configurar)"}</option>`).join("")
    : `<option value="">Nenhuma empresa com certificado A1 no robô</option>`;
  sel.disabled = !lista.length;
  const em = EM.cad && EM.cad.emitente;
  const amb = $("#emi-ambiente");
  amb.className = "emi-ambiente " + (!em ? "" : em.ambiente === "producao" ? "producao" : "teste");
  amb.innerHTML = !em ? "" : em.ambiente === "producao" ? `${icone("check", "ico-sm")}PRODUÇÃO — notas com valor fiscal` : `${icone("teste", "ico-sm")}PRODUÇÃO RESTRITA — notas de teste, sem valor fiscal`;
}
$("#emi-empresa").addEventListener("change", async (ev) => {
  EM.cnpj = ev.target.value; localStorage.setItem("prumo_emissao_cnpj", EM.cnpj);
  EM.tomador = null; EM.copia = null; EM.filtro.pagina = 0;
  await recarregarEmpresa();
});
async function recarregarEmpresa() {
  try { await carregarCadastros(); } catch (err) { notificar(err.message, "erro"); }
  desenharTopo(); mostrarAba(EM.aba);
}

// ---------------------------------------------------------------------------
// Abas
// ---------------------------------------------------------------------------
function mostrarAba(aba) {
  EM.aba = aba;
  $$("#emi-abas [data-aba]").forEach((b) => { const a = b.dataset.aba === aba; b.classList.toggle("ativo", a); b.setAttribute("aria-selected", a); });
  $$(".nfae-painel").forEach((p) => (p.hidden = p.dataset.painel !== aba));
  if (!EM.inicio) return desenharSemRobo();
  ({ emitir: desenharEmitir, notas: desenharNotas, config: desenharConfig })[aba]();
}
$("#emi-abas").addEventListener("click", (e) => { const b = e.target.closest("[data-aba]"); if (b) mostrarAba(b.dataset.aba); });
function desenharSemRobo() {
  const p = $(`[data-painel="${EM.aba}"]`);
  const e = EM.erroRobo;
  p.innerHTML = `<div class="vazio">${icone("alerta", "ico-xl")}<strong>${e && e.semRobo ? "O robô do escritório está desligado" : "Não consegui falar com o robô"}</strong>
    <p>${escaparHtml(e ? e.message : "")}</p><p>As notas ficam guardadas no computador do robô: com ele desligado, a emissão e o histórico não abrem.</p>
    <button class="btn-secundario" id="emi-tentar">${icone("atualizar")}Tentar de novo</button></div>`;
  $("#emi-tentar").onclick = (ev) => comCarregando(ev.currentTarget, async () => { await carregarInicio(); if (EM.inicio) await recarregarEmpresa(); else desenharSemRobo(); });
}

// ---------------------------------------------------------------------------
// EMITIR
// ---------------------------------------------------------------------------
function desenharEmitir() {
  const p = $('[data-painel="emitir"]');
  const emp = empresaAtual();
  if (!emp) {
    p.innerHTML = `<div class="vazio">${icone("chave", "ico-xl")}<strong>Nenhuma empresa com certificado A1 no robô</strong><p>No computador do robô: janela do Agente Prumo → aba <b>Certificados</b> → Adicionar certificado A1 (.pfx). A empresa também precisa estar cadastrada na página Empresas, com o CNPJ.</p></div>`;
    return;
  }
  const c = EM.cad;
  if (!c || !c.emitente || !c.servicos.length) {
    p.innerHTML = `<div class="vazio">${icone("documento", "ico-xl")}<strong>${!c || !c.emitente ? "Configure a empresa para emitir" : "Cadastre pelo menos um serviço"}</strong>
      <p>Na aba <b>Configuração</b>: ${!c || !c.emitente ? "regime e município já vêm do CNPJ — é só conferir e salvar" : "procure o código do serviço pela descrição (como no Emissor Nacional)"}.</p>
      <button class="btn-primario" data-ir="config">${icone("mais")}Abrir a configuração</button></div>`;
    p.querySelector("[data-ir]").onclick = () => mostrarAba("config");
    return;
  }
  const em = c.emitente;
  const copia = EM.copia;
  if (copia) { EM.servicoId = copia.servicoId && c.servicos.some((s) => s.id === copia.servicoId) ? copia.servicoId : EM.servicoId; EM.tomador = copia.tomador || null; }
  const serv = c.servicos.find((s) => s.id === EM.servicoId) || c.servicos[0];
  const t = EM.tomador, e = (t && t.end) || {};
  p.innerHTML = `
    ${copia ? `<p class="nf-aviso emi-copia">${icone("copiar")}Copiando a nota ${copia._numero ? "nº " + escaparHtml(copia._numero) : "anterior"}: confira e clique em Emitir NFS-e. <button type="button" class="btn-ghost btn-sm" id="emi-limpar-copia">${icone("x")}Limpar</button></p>` : ""}
    <div class="emi-layout">
      <form id="emi-form" class="emi-principal" autocomplete="off">
        <section class="cartao-nf emi-etapa">
          <header class="emi-etapa-cab"><span class="emi-num">1</span><div><h3>Pessoas</h3><small>Competência, emitente e tomador do serviço</small></div></header>
          <div class="emi-linha emi-linha-2">
            <div class="campo-form"><label for="emi-comp">Data de competência <i>*</i></label><input id="emi-comp" type="date" max="${_hojeISO()}" value="${_hojeISO()}"></div>
            <div class="campo-form"><label>Emitente</label><div class="emi-fixo"><b>${escaparHtml(em.nome || emp.nome)}</b><small>${_doc(em.cnpj)} · ${em.regime === "mei" ? "MEI" : "Simples Nacional (ME/EPP)"}${em.municipio ? " · " + escaparHtml(em.municipio) : ""}</small></div></div>
          </div>
          <div class="emi-grupo">
            <div class="emi-grupo-cab"><span>Tomador do serviço</span>
              <div class="segmentado emi-tipo-tom" role="radiogroup">
                <label class="chip-check"><input type="radio" name="emi-tipo-tom" value="brasil"${!(copia && !t) ? " checked" : ""}><span class="caixa">${icone("check")}</span>Brasil</label>
                <label class="chip-check"><input type="radio" name="emi-tipo-tom" value="nao"${copia && !t ? " checked" : ""}><span class="caixa">${icone("check")}</span>Não informado</label>
              </div>
            </div>
            <div id="emi-tomador-campos">
              <div class="campo-form emi-doc-campo"><label for="emi-t-doc">CPF/CNPJ <i>*</i> <span class="emi-origem" id="emi-origem"></span></label><input id="emi-t-doc" class="mono emi-doc" placeholder="digite o CPF ou CNPJ — ou o nome, para buscar os salvos" value="${escaparHtml(t ? _doc(t.doc) : "")}"></div>
              <div class="nf-lista-clientes emi-sugestoes" id="emi-t-lista"></div>
              <div class="campo-form"><label for="emi-t-nome">Nome/Nome Empresarial <i>*</i></label><input id="emi-t-nome" value="${escaparHtml(t ? t.nome : "")}"></div>
              <div class="emi-linha emi-linha-2">
                <div class="campo-form"><label for="emi-t-fone">Telefone</label><input id="emi-t-fone" class="mono" value="${escaparHtml(t ? t.fone || "" : "")}"></div>
                <div class="campo-form"><label for="emi-t-email">E-mail</label><input id="emi-t-email" type="email" value="${escaparHtml(t ? t.email || "" : "")}"></div>
              </div>
              <details class="emi-end" id="emi-end">
                <summary><span class="emi-end-titulo">${icone("empresas", "ico-sm")}Endereço</span><span class="emi-end-resumo" id="emi-end-resumo"></span><span class="emi-end-acao">editar</span></summary>
                <div class="emi-end-grade">
                  <div class="campo-form"><label for="emi-e-cep">CEP</label><input id="emi-e-cep" class="mono" maxlength="9" value="${escaparHtml(e.cep || "")}"></div>
                  <div class="campo-form emi-cidade"><label>Município</label><div class="emi-fixo" id="emi-e-cidade">${escaparHtml(e.xMun || (e.cMun ? "código " + e.cMun : "— preenche pelo CEP"))}</div><input type="hidden" id="emi-e-cmun" value="${escaparHtml(e.cMun || "")}"></div>
                  <div class="campo-form emi-largo"><label for="emi-e-lgr">Logradouro</label><input id="emi-e-lgr" value="${escaparHtml(e.xLgr || "")}"></div>
                  <div class="campo-form"><label for="emi-e-nro">Número</label><input id="emi-e-nro" value="${escaparHtml(e.nro || "")}"></div>
                  <div class="campo-form"><label for="emi-e-cpl">Complemento</label><input id="emi-e-cpl" value="${escaparHtml(e.xCpl || "")}"></div>
                  <div class="campo-form emi-largo"><label for="emi-e-bairro">Bairro</label><input id="emi-e-bairro" value="${escaparHtml(e.xBairro || "")}"></div>
                </div>
              </details>
            </div>
          </div>
        </section>
        <section class="cartao-nf emi-etapa">
          <header class="emi-etapa-cab"><span class="emi-num">2</span><div><h3>Serviço</h3><small>O que foi prestado</small></div></header>
          <div class="campo-form"><label for="emi-servico">Serviço <i>*</i></label><select id="emi-servico">${c.servicos.map((s) => `<option value="${s.id}"${s.id === serv.id ? " selected" : ""}>${escaparHtml(s.nome)} · ${fmtCodigoServ(s.cTribNac)}</option>`).join("")}</select></div>
          <p class="emi-codigo" id="emi-codigo-desc"></p>
          <div class="campo-form"><label for="emi-desc">Descrição do serviço <i>*</i></label><textarea id="emi-desc" rows="3" maxlength="2000">${escaparHtml(copia ? copia.descricao : serv.descricao)}</textarea></div>
        </section>
        <section class="cartao-nf emi-etapa">
          <header class="emi-etapa-cab"><span class="emi-num">3</span><div><h3>Valores</h3><small>Valor e tributação municipal</small></div></header>
          <div class="emi-linha emi-linha-2">
            <div class="campo-form"><label for="emi-valor">Valor do serviço prestado (R$) <i>*</i></label><input id="emi-valor" class="mono emi-valor" inputmode="decimal" placeholder="0,00" value="${copia ? escaparHtml(String(copia.valor).replace(".", ",")) : ""}"></div>
            <div class="campo-form"><label>Tributação municipal</label><div class="emi-fixo">Operação tributável<small>ISSQN ${em.regime === "mei" ? "pelo SIMEI" : "pelo Simples Nacional"}</small></div></div>
          </div>
          ${em.regime === "simples" ? `<label class="chip-check azul emi-retido"><input type="checkbox" id="emi-retido"${copia && copia.issRetido ? " checked" : ""}${serv.pAliq ? "" : " disabled"}><span class="caixa">${icone("check")}</span><span id="emi-retido-txt"></span></label>` : ""}
        </section>
      </form>
      <aside class="emi-lateral">
        <section class="cartao-nf emi-etapa emi-final">
          <header class="emi-etapa-cab"><span class="emi-num">4</span><div><h3>Emitir NFS-e</h3><small>Confira antes de enviar</small></div></header>
          <dl class="emi-resumo-nota" id="emi-resumo-nota"></dl>
          <div class="emi-total-bloco"><small>Valor da nota</small><b id="emi-total">${copia ? _m(copia.valor) : "R$ 0,00"}</b></div>
          <button class="btn-primario emi-btn-emitir" type="submit" form="emi-form" id="emi-enviar">${icone("enviar")}Emitir NFS-e</button>
          <p class="nf-dica">${icone("info")}O robô transmite na hora para a Sefin Nacional. O formulário fica pronto para a próxima, com o mesmo serviço.</p>
        </section>
        <section class="cartao-nf emi-enviadas-card" id="emi-enviadas-card"${EM.enviadas.length ? "" : " hidden"}>
          <header class="emi-enviadas-cab"><h3>${icone("relogio")}Enviadas agora</h3><button type="button" class="btn-ghost btn-sm" data-ir-notas>Ver todas</button></header>
          <div id="emi-enviadas" class="emi-enviadas"></div>
        </section>
      </aside>
    </div>`;
  EM.copia = null;
  desenharEnviadas();
  const f = $("#emi-form");
  const semTomador = () => (p.querySelector('[name="emi-tipo-tom"]:checked') || {}).value === "nao";
  const ligarTomador = () => { $("#emi-tomador-campos").hidden = semTomador(); atualizarResumoNota(); };
  p.querySelectorAll('[name="emi-tipo-tom"]').forEach((r) => (r.onchange = ligarTomador)); ligarTomador();
  $("#emi-limpar-copia")?.addEventListener("click", () => { EM.tomador = null; desenharEmitir(); });
  const mostrarCodigo = () => { const s = c.servicos.find((x) => x.id === $("#emi-servico").value); $("#emi-codigo-desc").textContent = s ? `${fmtCodigoServ(s.cTribNac)} — ${descricaoCodigoServ(s.cTribNac) || "código de tributação nacional"}${s.cNBS ? " · NBS " + s.cNBS : ""}` : ""; };
  mostrarCodigo();
  // retenção do ISS: só com a alíquota cadastrada no serviço (E0621)
  const textoRetencao = () => {
    const s = c.servicos.find((x) => x.id === $("#emi-servico").value) || {}, r = $("#emi-retido"), txt = $("#emi-retido-txt");
    if (!r) return;
    r.disabled = !s.pAliq; if (!s.pAliq) r.checked = false;
    txt.textContent = s.pAliq ? `Retenção do ISSQN pelo tomador (${String(s.pAliq).replace(".", ",")}%)` : "Retenção do ISSQN pelo tomador — cadastre a alíquota neste serviço para usar";
  };
  textoRetencao();
  $("#emi-servico").onchange = (ev) => {
    EM.servicoId = ev.target.value;
    const s = c.servicos.find((x) => x.id === EM.servicoId);
    $("#emi-desc").value = s.descricao;
    mostrarCodigo(); textoRetencao(); atualizarResumoNota();
  };
  $("#emi-valor").oninput = (ev) => { $("#emi-total").textContent = _m(valorBr(ev.target.value)); atualizarResumoNota(); };
  ["#emi-t-nome", "#emi-desc", "#emi-e-lgr", "#emi-e-nro", "#emi-e-bairro", "#emi-comp"].forEach((sel) => $(sel).addEventListener("input", atualizarResumoNota));
  $("#emi-retido")?.addEventListener("change", (ev) => { if (ev.target.checked) $("#emi-end").open = true; atualizarResumoNota(); });
  p.querySelector("[data-ir-notas]")?.addEventListener("click", () => mostrarAba("notas"));
  // CPF/CNPJ: completo e válido → puxa sozinho (primeiro dos salvos no robô; CNPJ novo, da Receita). Texto → busca nos salvos.
  let espera = 0, ultimoDoc = "";
  $("#emi-t-doc").oninput = (ev) => {
    clearTimeout(espera);
    const texto = ev.target.value.trim(), d = _so(texto);
    const soNumeros = d && d.length === texto.replace(/[.\-/\s]/g, "").length;
    if (soNumeros && (d.length === 11 || d.length === 14) && cpfCnpjValido(d)) {
      if (d !== ultimoDoc) { ultimoDoc = d; ev.target.value = _doc(d); puxarTomador(d); }
      return;
    }
    ultimoDoc = "";
    if (soNumeros && (d.length === 11 || d.length === 14)) { origem("erro", "CPF/CNPJ com dígito errado — confira"); return; }
    origem("", "");
    if (texto.length < 3) { $("#emi-t-lista").innerHTML = ""; return; }
    espera = setTimeout(() => buscarSalvos(texto), 300);
  };
  $("#emi-e-cep").oninput = (ev) => { const cep = _so(ev.target.value); if (cep.length === 8) { ev.target.value = cep.replace(/^(\d{5})(\d{3})$/, "$1-$2"); cidadePeloCep(true); } };
  f.onsubmit = (ev) => { ev.preventDefault(); emitirDoFormulario(); };
  atualizarResumoNota();
  ($("#emi-valor").value ? $("#emi-enviar") : (EM.tomador || semTomador() ? $("#emi-valor") : $("#emi-t-doc"))).focus();
}
function cpfCnpjValido(d) {
  d = _so(d);
  const todosIguais = /^(\d)\1+$/.test(d);
  if (d.length === 11 && !todosIguais) {
    for (const n of [9, 10]) { let soma = 0; for (let i = 0; i < n; i++) soma += +d[i] * (n + 1 - i); if ((soma * 10 % 11) % 10 !== +d[n]) return false; }
    return true;
  }
  if (d.length === 14 && !todosIguais) {
    for (const n of [12, 13]) { const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; let soma = 0; for (let i = 0; i < n; i++) soma += +d[i] * pesos[i]; const dv = 11 - soma % 11; if ((dv >= 10 ? 0 : dv) !== +d[n]) return false; }
    return true;
  }
  return false;
}
function origem(tipo, texto) {
  const el = $("#emi-origem"); if (!el) return;
  el.className = "emi-origem" + (tipo ? " " + tipo : "");
  el.innerHTML = !texto ? "" : `${tipo === "carregando" ? icone("carregando", "girando ico-sm") : tipo === "erro" ? icone("alerta", "ico-sm") : icone("check", "ico-sm")}${escaparHtml(texto)}`;
}
async function buscarSalvos(texto) {
  try {
    const r = await robo("tomador.buscar", { cnpj: EM.cnpj, texto });
    $("#emi-t-lista").innerHTML = r.tomadores.map((t, i) => `<button type="button" class="nf-cli" data-t="${i}"><b>${escaparHtml(t.nome)}</b><small>${_doc(t.doc)}${t.usos ? ` · ${t.usos} nota(s)` : ""}</small></button>`).join("");
    $("#emi-t-lista").onclick = (e2) => { const b = e2.target.closest("[data-t]"); if (b) preencherTomador(r.tomadores[+b.dataset.t], "salvo"); };
  } catch {}
}
// igual ao Emissor Nacional: digitou o CPF/CNPJ, os dados aparecem
async function puxarTomador(d) {
  origem("carregando", "buscando…");
  // documento novo: se os campos eram de OUTRO tomador puxado antes, limpa (para não sair nota com o nome errado)
  if (EM.tomador && EM.tomador.doc !== d && $("#emi-t-nome").value === EM.tomador.nome) {
    ["#emi-t-nome", "#emi-t-email", "#emi-t-fone", "#emi-e-cep", "#emi-e-lgr", "#emi-e-nro", "#emi-e-cpl", "#emi-e-bairro", "#emi-e-cmun"].forEach((x) => ($(x).value = ""));
    $("#emi-e-cidade").textContent = "— preenche pelo CEP";
    EM.tomador = null;
  }
  const nomeAntes = $("#emi-t-nome").value; // se a pessoa digitar o nome enquanto busca, o que ela digitou fica
  try {
    const r = await robo("tomador.buscar", { cnpj: EM.cnpj, texto: d });
    const salvo = r.tomadores.find((x) => x.doc === d);
    if (_so($("#emi-t-doc").value) !== d) return; // já trocou o número
    if (salvo) return preencherTomador(salvo, "salvo", $("#emi-t-nome").value !== nomeAntes);
  } catch {}
  if (d.length === 11) {
    $("#emi-t-lista").innerHTML = "";
    origem("aviso", "CPF novo: a Receita não divulga dados de CPF — digite o nome");
    if (!$("#emi-t-nome").value) $("#emi-t-nome").focus();
    return;
  }
  try {
    const x = await api(`/api/consulta-cnpj/cadastro?cnpj=${d}`);
    if (_so($("#emi-t-doc").value) !== d) return; // já trocou o número
    preencherTomador({ doc: d, nome: x.razao_social || x.nome || "", fone: x.fone || "", email: x.email || "",
      end: x.cep ? { cep: x.cep, cMun: x.ibge || "", xMun: x.municipio ? `${x.municipio}/${x.estado}` : "", xLgr: x.logradouro || "", nro: x.numero || "", xCpl: x.complemento || "", xBairro: x.bairro || "" } : null }, "receita", $("#emi-t-nome").value !== nomeAntes);
    if (x.situacao && !/ativa/i.test(x.situacao)) origem("erro", `Receita Federal: situação ${x.situacao}`);
    if (x.cep && !x.ibge) cidadePeloCep(false);
  } catch (err) {
    origem("erro", err.message || "não achei esse CNPJ — preencha à mão");
    $("#emi-t-nome").focus();
  }
}
// ViaCEP devolve o código IBGE e o nome da cidade (consulta direta do navegador, só com o CEP)
async function cidadePeloCep(preencherRua) {
  const cep = _so($("#emi-e-cep").value);
  if (cep.length !== 8) return;
  try {
    const r = await (await fetch(`https://viacep.com.br/ws/${cep}/json/`)).json();
    if (r && !r.erro) {
      $("#emi-e-cmun").value = r.ibge || "";
      $("#emi-e-cidade").textContent = r.localidade ? `${r.localidade}/${r.uf}` : "";
      if (preencherRua || !$("#emi-e-lgr").value) $("#emi-e-lgr").value = r.logradouro || $("#emi-e-lgr").value;
      if (preencherRua || !$("#emi-e-bairro").value) $("#emi-e-bairro").value = r.bairro || $("#emi-e-bairro").value;
      if (preencherRua) $("#emi-e-nro").focus();
    } else { $("#emi-e-cidade").textContent = "CEP não encontrado"; }
    atualizarResumoNota();
  } catch {}
}
function preencherTomador(t, de, manterNome = false) {
  EM.tomador = manterNome ? { ...t, nome: $("#emi-t-nome").value } : t;
  $("#emi-t-doc").value = _doc(t.doc); if (!manterNome) $("#emi-t-nome").value = t.nome || ""; $("#emi-t-email").value = t.email || ""; $("#emi-t-fone").value = t.fone || "";
  const e = t.end || {};
  $("#emi-e-cep").value = e.cep ? String(e.cep).replace(/^(\d{5})(\d{3})$/, "$1-$2") : ""; $("#emi-e-cmun").value = e.cMun || "";
  $("#emi-e-cidade").textContent = e.xMun || (e.cMun ? "código " + e.cMun : "— preenche pelo CEP");
  $("#emi-e-lgr").value = e.xLgr || ""; $("#emi-e-nro").value = e.nro || ""; $("#emi-e-cpl").value = e.xCpl || ""; $("#emi-e-bairro").value = e.xBairro || "";
  $("#emi-t-lista").innerHTML = "";
  origem("ok", de === "receita" ? "dados da Receita Federal" : "tomador já usado antes");
  atualizarResumoNota();
  if (!manterNome) $("#emi-valor").focus();
}
function atualizarResumoNota() {
  const el = $("#emi-resumo-nota"); if (!el) return;
  const sem = (document.querySelector('[name="emi-tipo-tom"]:checked') || {}).value === "nao";
  const nome = sem ? "Não informado" : $("#emi-t-nome").value.trim() || "—";
  const doc = !sem && _so($("#emi-t-doc").value) ? _doc($("#emi-t-doc").value) : "";
  const s = EM.cad.servicos.find((x) => x.id === $("#emi-servico").value) || {};
  const retido = $("#emi-retido") && $("#emi-retido").checked;
  el.innerHTML = `<dt>Tomador</dt><dd><b>${escaparHtml(nome)}</b>${doc ? `<small>${doc}</small>` : ""}</dd>
    <dt>Serviço</dt><dd><b>${escaparHtml(s.nome || "")}</b><small>${fmtCodigoServ(s.cTribNac || "")}</small></dd>
    <dt>Competência</dt><dd><b>${escaparHtml(($("#emi-comp").value || "").split("-").reverse().join("/"))}</b></dd>
    <dt>ISS</dt><dd><b>${retido ? "Retido pelo tomador" : "Sem retenção"}</b></dd>`;
  // endereço recolhido: mostra o resumo em uma linha
  const r = $("#emi-end-resumo");
  if (r) {
    const partes = [[$("#emi-e-lgr").value, $("#emi-e-nro").value].filter(Boolean).join(", "), $("#emi-e-bairro").value, /código|preenche|não encontrado/.test($("#emi-e-cidade").textContent) ? "" : $("#emi-e-cidade").textContent].map((x) => String(x || "").trim()).filter(Boolean);
    r.textContent = partes.length ? partes.join(" · ") : "não informado (opcional)";
    r.classList.toggle("sem-dados", !partes.length);
  }
}
function lerFormulario() {
  const semTom = (document.querySelector('[name="emi-tipo-tom"]:checked') || {}).value === "nao";
  const tomador = semTom ? null : {
    doc: _so($("#emi-t-doc").value), nome: $("#emi-t-nome").value.trim(), email: $("#emi-t-email").value.trim(), fone: $("#emi-t-fone").value.trim(),
    end: { cep: _so($("#emi-e-cep").value), cMun: _so($("#emi-e-cmun").value), xMun: /código|preenche|não encontrado/.test($("#emi-e-cidade").textContent) ? "" : $("#emi-e-cidade").textContent.trim(), xLgr: $("#emi-e-lgr").value.trim(), nro: $("#emi-e-nro").value.trim(), xCpl: $("#emi-e-cpl").value.trim(), xBairro: $("#emi-e-bairro").value.trim() },
  };
  return { servicoId: $("#emi-servico").value, descricao: $("#emi-desc").value.trim(), valor: $("#emi-valor").value.trim(), dCompet: $("#emi-comp").value,
    issRetido: !!($("#emi-retido") && $("#emi-retido").checked), tomador };
}
async function emitirDoFormulario() {
  const pedido = lerFormulario();
  if (!pedido.tomador && !confirm("Emitir com o tomador não informado?")) return;
  if (pedido.tomador && !pedido.tomador.doc) return notificar("Digite o CPF/CNPJ do tomador (ou escolha “Não informado”).", "aviso");
  if (!(valorBr(pedido.valor) > 0)) { $("#emi-valor").focus(); return notificar("Digite o valor do serviço.", "aviso"); }
  // trava de clique duplo: a mesma nota de novo em menos de 3 s não sai duas vezes
  const assinatura = JSON.stringify(pedido);
  if (EM._ultimo && EM._ultimo.a === assinatura && Date.now() - EM._ultimo.t < 3000) return;
  EM._ultimo = { a: assinatura, t: Date.now() };
  // O formulário limpa NA HORA (dá para digitar a próxima enquanto esta vai para o robô);
  // se o robô recusar, a nota aparece em "Enviadas agora" com o motivo e o botão Corrigir.
  const local = { id: "local-" + Date.now() + Math.random().toString(36).slice(2, 6), status: "fila", tomadorNome: pedido.tomador ? pedido.tomador.nome : "Tomador não informado", valor: valorBr(pedido.valor), pedido };
  EM.enviadas.unshift(local);
  EM.enviadas = EM.enviadas.slice(0, 15);
  limparFormulario(pedido.servicoId);
  $("#emi-enviadas-card").hidden = false;
  desenharEnviadas();
  try {
    const r = await robo("emitir", { cnpj: EM.cnpj, notas: [pedido] });
    const res = r.resultado[0];
    if (res.erro) { Object.assign(local, { status: "erro", erro: res.erro }); notificar(res.erro, "erro"); }
    else { local.id = res.id; acompanhar(); }
  } catch (err) {
    Object.assign(local, { status: "erro", erro: err.message });
    notificar(err.message, "erro");
  }
  desenharEnviadas();
}
// pronto para a próxima: mesmo serviço; tomador e valor em branco
function limparFormulario(servicoId) {
  EM.tomador = null;
  $("#emi-t-doc").value = ""; $("#emi-t-nome").value = ""; $("#emi-t-email").value = ""; $("#emi-t-fone").value = "";
  ["cep", "cmun", "lgr", "nro", "cpl", "bairro"].forEach((k) => ($(`#emi-e-${k}`).value = ""));
  $("#emi-e-cidade").textContent = "— preenche pelo CEP"; origem("", "");
  $("#emi-valor").value = ""; $("#emi-total").textContent = "R$ 0,00";
  $("#emi-t-lista").innerHTML = "";
  $(".emi-copia")?.remove(); // a cópia já virou nota: o aviso sai
  const s = EM.cad.servicos.find((x) => x.id === servicoId); if (s) $("#emi-desc").value = s.descricao;
  const r = $("#emi-retido"); if (r) r.checked = false;
  ((document.querySelector('[name="emi-tipo-tom"]:checked') || {}).value === "nao" ? $("#emi-valor") : $("#emi-t-doc")).focus();
  atualizarResumoNota();
}
function desenharEnviadas() {
  const alvo = $("#emi-enviadas");
  if (!alvo) return;
  alvo.innerHTML = EM.enviadas.map((n) => `<div class="emi-enviada${n.status === "erro" ? " com-erro" : ""}">
      <div class="emi-enviada-info"><b>${escaparHtml(n.tomadorNome || "Tomador não informado")}</b><small>${_m(n.valor)}${n.numero ? ` · nº ${escaparHtml(n.numero)}` : ""}</small>${n.erro ? `<span class="emi-erro">${escaparHtml(n.erro)}</span>` : ""}</div>
      <div class="emi-acoes">${_etq(n.status)}${n.status === "emitida" ? `<button type="button" class="btn-ghost btn-sm emi-icone" data-xml="${n.id}" title="Baixar o XML">${icone("baixar")}</button>` : ""}${n.status === "erro" ? `<button type="button" class="btn-ghost btn-sm" data-copiar="${n.id}" title="Abrir de novo no formulário para corrigir">${icone("copiar")}Corrigir</button>` : ""}</div>
    </div>`).join("");
  const aberto = EM.enviadas.filter((n) => ["fila", "enviando", "verificar"].includes(n.status)).length;
  $("#emi-cont-fila").textContent = aberto || "";
}

// Acompanha as notas que ainda estão na fila (só enquanto houver alguma; pergunta ao robô, não ao KV)
function acompanhar() {
  clearTimeout(EM.timer);
  const abertas = EM.enviadas.filter((n) => ["fila", "enviando", "verificar"].includes(n.status) && !n.id.startsWith("local-"));
  if (!abertas.length) return;
  EM.timer = setTimeout(async () => {
    try {
      const r = await robo("situacao", { ids: abertas.map((n) => n.id) });
      for (const s of r.notas) {
        const n = EM.enviadas.find((x) => x.id === s.id);
        if (!n) continue;
        if (n.status !== s.status) {
          if (s.status === "emitida") notificar(`NFS-e nº ${s.numero} emitida — ${s.tomadorNome || "sem tomador"} · ${_m(s.valor)}`, "ok");
          if (s.status === "erro") notificar(`Nota recusada: ${s.erro}`, "erro");
        }
        Object.assign(n, s);
      }
      desenharEnviadas();
      if (EM.aba === "notas" && r.notas.some((s) => !["fila", "enviando", "verificar"].includes(s.status))) desenharNotas();
    } catch {}
    acompanhar();
  }, 2500);
}

// ---------------------------------------------------------------------------
// NOTAS (histórico no banco do robô)
// ---------------------------------------------------------------------------
async function desenharNotas() {
  const p = $('[data-painel="notas"]');
  if (!empresaAtual()) { p.innerHTML = `<div class="vazio">${icone("documento", "ico-xl")}<p>Escolha uma empresa.</p></div>`; return; }
  const f = EM.filtro;
  if (!f.de) { const d = new Date(); f.de = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; f.ate = _hojeISO(); }
  if (!p.querySelector("#emi-filtro")) {
    p.innerHTML = `
      <form class="cartao-nf emi-filtro" id="emi-filtro">
        <div class="campo-form"><label>De</label><input type="date" id="emi-f-de"></div>
        <div class="campo-form"><label>Até</label><input type="date" id="emi-f-ate"></div>
        <div class="campo-form"><label>Situação</label><select id="emi-f-status"><option value="">Todas</option><option value="emitida">Emitidas</option><option value="erro">Recusadas</option><option value="fila">Na fila</option><option value="descartada">Descartadas</option></select></div>
        <div class="campo-form emi-f-texto"><label>Tomador ou nº da nota</label><input id="emi-f-texto" placeholder="nome, CPF/CNPJ ou número"></div>
        <button class="btn-secundario" type="submit">${icone("busca")}Buscar</button>
      </form>
      <div id="emi-notas"></div>`;
    $("#emi-filtro").onsubmit = (ev) => { ev.preventDefault(); Object.assign(EM.filtro, { de: $("#emi-f-de").value, ate: $("#emi-f-ate").value, status: $("#emi-f-status").value, texto: $("#emi-f-texto").value.trim(), pagina: 0 }); desenharNotas(); };
  }
  $("#emi-f-de").value = f.de; $("#emi-f-ate").value = f.ate; $("#emi-f-status").value = f.status; $("#emi-f-texto").value = f.texto;
  const alvo = $("#emi-notas");
  alvo.innerHTML = `<div class="esqueleto esqueleto-linha"></div><div class="esqueleto esqueleto-linha"></div>`;
  let r;
  try { r = await robo("notas", { cnpj: EM.cnpj, ...f }); } catch (err) { alvo.innerHTML = `<div class="nf-erro"><b>${escaparHtml(err.message)}</b></div>`; return; }
  EM.ultimaLista = r.notas;
  const paginas = Math.max(1, Math.ceil(r.total / 50));
  alvo.innerHTML = !r.notas.length ? `<div class="vazio">${icone("documento", "ico-xl")}<p>Nenhuma nota nesse período.</p></div>` : `
    <div class="emi-resumo"><b>${r.emitidas}</b> emitida(s) · <b>${_m(r.valorEmitido)}</b> <small>(${r.total} no filtro)</small></div>
    <div class="xml-tabela-wrap"><table class="xml-tabela emi-tabela">
      <thead><tr><th>Data</th><th>Nº</th><th>Tomador</th><th>Serviço</th><th class="num">Valor</th><th>Situação</th><th></th></tr></thead>
      <tbody>${r.notas.map((n) => `<tr class="${n.status === "descartada" ? "cancelada" : ""}">
        <td>${_quando(n.emitidaEm || n.criadoEm)}${n.ambiente !== "producao" ? `<small class="emi-teste">teste</small>` : ""}</td>
        <td class="num-nota">${escaparHtml(n.numero || "—")}</td>
        <td class="tomador">${escaparHtml(n.tomadorNome || "Sem tomador")}${n.tomadorDoc ? `<small>${_doc(n.tomadorDoc)}</small>` : ""}</td>
        <td>${escaparHtml(n.servico || "")}</td>
        <td class="num">${_m(n.valor)}</td>
        <td>${_etq(n.status)}${n.erro && n.status !== "emitida" ? `<small class="emi-erro">${escaparHtml(n.erro)}</small>` : ""}</td>
        <td class="acoes-nota">
          <button type="button" class="btn-ghost btn-sm" data-copiar="${n.id}" title="Copiar para uma nota nova">${icone("copiar")}Copiar</button>
          ${n.status === "emitida" ? `<button type="button" class="btn-ghost btn-sm" data-xml="${n.id}" title="Baixar o XML">${icone("baixar")}XML</button>` : ""}
          ${n.status === "erro" ? `<button type="button" class="btn-ghost btn-sm" data-reenviar="${n.id}" title="Mandar de novo como está">${icone("atualizar")}Reenviar</button><button type="button" class="btn-ghost btn-sm" data-descartar="${n.id}" title="Tirar da lista de pendências">${icone("x")}</button>` : ""}
        </td></tr>`).join("")}</tbody></table></div>
    ${paginas > 1 ? `<div class="emi-paginas"><button class="btn-ghost btn-sm" data-pag="-1"${f.pagina ? "" : " disabled"}>${icone("seta")}Anteriores</button><span>página ${f.pagina + 1} de ${paginas}</span><button class="btn-ghost btn-sm" data-pag="1"${f.pagina + 1 < paginas ? "" : " disabled"}>Próximas</button></div>` : ""}`;
  alvo.querySelectorAll("[data-pag]").forEach((b) => (b.onclick = () => { EM.filtro.pagina += +b.dataset.pag; desenharNotas(); }));
}

// ações nas listas (Notas e "Enviadas agora")
document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-copiar],[data-xml],[data-reenviar],[data-descartar]");
  if (!b || !b.closest(".nfae-painel")) return;
  const id = b.dataset.copiar || b.dataset.xml || b.dataset.reenviar || b.dataset.descartar;
  try {
    if (b.dataset.copiar && id.startsWith("local-")) {
      const n = EM.enviadas.find((x) => x.id === id);
      if (n) { EM.copia = { ...n.pedido }; mostrarAba("emitir"); }
    } else if (b.dataset.copiar) {
      const r = await robo("nota", { id });
      EM.copia = { ...r.pedido, _numero: r.nota.numero };
      mostrarAba("emitir");
    } else if (b.dataset.xml) {
      await comCarregando(b, async () => {
        const r = await robo("xml", { id });
        const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "text/xml" }));
        const a = document.createElement("a"); a.href = url; a.download = r.nome; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 20000);
      });
    } else if (b.dataset.reenviar) {
      await robo("reenviar", { id });
      const lista = EM.ultimaLista || [];
      const n = lista.find((x) => x.id === id);
      EM.enviadas.unshift({ id, status: "fila", tomadorNome: n ? n.tomadorNome : "", valor: n ? n.valor : 0 });
      notificar("Mandada de novo para a fila", "info");
      acompanhar(); desenharNotas();
    } else if (b.dataset.descartar) {
      if (!confirm("Descartar esta nota recusada? (ela não foi emitida; só sai da lista de pendências)")) return;
      await robo("descartar", { id });
      desenharNotas();
    }
  } catch (err) { notificar(err.message, "erro"); }
});

// ---------------------------------------------------------------------------
// CONFIGURAÇÃO (empresa + serviços) — guardada no robô
// ---------------------------------------------------------------------------
function desenharConfig() {
  const p = $('[data-painel="config"]');
  const emp = empresaAtual();
  if (!emp) { p.innerHTML = `<div class="vazio">${icone("chave", "ico-xl")}<strong>Nenhuma empresa com certificado A1 no robô</strong><p>Guarde o certificado no computador do robô (janela do Agente → Certificados).</p></div>`; return; }
  const c = EM.cad || {};
  const em = c.emitente || { regime: "simples", ambiente: "homologacao", serie: "1", pTotTribSN: "", cMun: "", im: "", nome: emp.nome, leiaute: "", infoCompl: "" };
  const cert = c.certificado;
  p.innerHTML = `
    <div class="nfae-grade">
      <form class="cartao-nf" id="emi-cfg">
        <h3>${icone("empresas")}Empresa (prestador)</h3>
        <p class="nf-sub">${escaparHtml(emp.nome)} · ${_doc(emp.cnpj)}${cert ? ` · certificado A1 até ${escaparHtml((cert.validade || "").split("-").reverse().join("/"))}` : ""}</p>
        <span class="emi-origem" id="emi-c-origem"></span>
        <div class="campo-form"><label>Regime</label>
          <div class="segmentado"><label class="chip-check"><input type="radio" name="emi-regime" value="simples"${em.regime === "simples" ? " checked" : ""}><span class="caixa">${icone("check")}</span>Simples Nacional (ME/EPP)</label>
          <label class="chip-check"><input type="radio" name="emi-regime" value="mei"${em.regime === "mei" ? " checked" : ""}><span class="caixa">${icone("check")}</span>MEI</label></div></div>
        <div class="emi-dois">
          <div class="campo-form"><label for="emi-c-cmun">Município do emitente (código IBGE)</label><input id="emi-c-cmun" class="mono" maxlength="7" value="${escaparHtml(em.cMun)}" placeholder="vem do CNPJ"><small class="emi-ajuda" id="emi-c-cidade" data-nome="${escaparHtml(em.municipio || "")}">${escaparHtml(em.municipio || "")}</small></div>
          <div class="campo-form"><label for="emi-c-im">Inscrição municipal</label><input id="emi-c-im" class="mono" value="${escaparHtml(em.im || "")}" placeholder="só se a prefeitura exigir"></div>
        </div>
        <div class="campo-form" data-so-simples><label for="emi-c-ptt">% aproximado dos tributos (Simples)</label><input id="emi-c-ptt" class="mono" inputmode="decimal" value="${escaparHtml(String(em.pTotTribSN || "").replace(".", ","))}" placeholder="ex.: 6,00 (alíquota efetiva do Simples)"></div>
        <div class="emi-dois">
          <div class="campo-form"><label for="emi-c-serie">Série da DPS</label><input id="emi-c-serie" class="mono" maxlength="5" value="${escaparHtml(em.serie)}"></div>
          <div class="campo-form"><label for="emi-c-prox">Próximo nº da DPS</label><input id="emi-c-prox" class="mono" value="${c.proximoDps || 1}"></div>
        </div>
        <div class="campo-form"><label>Ambiente</label>
          <div class="segmentado"><label class="chip-check"><input type="radio" name="emi-amb" value="homologacao"${em.ambiente !== "producao" ? " checked" : ""}><span class="caixa">${icone("check")}</span>Produção restrita (teste)</label>
          <label class="chip-check"><input type="radio" name="emi-amb" value="producao"${em.ambiente === "producao" ? " checked" : ""}><span class="caixa">${icone("check")}</span>Produção (vale de verdade)</label></div></div>
        <div class="campo-form"><label for="emi-c-info">Informação complementar padrão (opcional)</label><textarea id="emi-c-info" rows="2" maxlength="2000" placeholder="Ex.: Empresa optante pelo Simples Nacional.">${escaparHtml(em.infoCompl || "")}</textarea></div>
        <details><summary>Avançado</summary>
          <div class="campo-form"><label for="emi-c-leiaute">Leiaute da Sefin</label><select id="emi-c-leiaute"><option value="">Automático (recomendado)</option><option value="20260209"${em.leiaute === "20260209" ? " selected" : ""}>20260209 (produção atual)</option><option value="20261020"${em.leiaute === "20261020" ? " selected" : ""}>20261020 (NT 009)</option></select></div>
        </details>
        <div class="nf-rodape"><span></span><button class="btn-primario" type="submit">${icone("salvar")}Salvar no robô</button></div>
      </form>
      <div class="cartao-nf">
        <h3>${icone("tarefas")}Serviços</h3>
        ${!c.emitente ? `<p class="nf-aviso">${icone("info")}Salve a empresa primeiro.</p>` : `
        <div class="emi-servicos">${(c.servicos || []).map((s) => `<div class="emi-servico"><div><b>${escaparHtml(s.nome)}</b><small>${fmtCodigoServ(s.cTribNac)} ${escaparHtml((descricaoCodigoServ(s.cTribNac) || "").slice(0, 60))}${s.cTribMun ? " · mun. " + escaparHtml(s.cTribMun) : ""}${s.cNBS ? " · NBS " + escaparHtml(s.cNBS) : ""}${s.pAliq ? " · ISS " + escaparHtml(String(s.pAliq).replace(".", ",")) + "%" : ""}</small></div>
          <div><button type="button" class="btn-ghost btn-sm" data-editar="${s.id}">${icone("atualizar")}Editar</button><button type="button" class="btn-ghost btn-sm" data-apagar="${s.id}" title="Apagar">${icone("lixeira")}</button></div></div>`).join("") || `<p class="nf-sub">Nenhum serviço ainda.</p>`}</div>
        <form id="emi-serv" class="emi-serv-form">
          <input type="hidden" id="emi-s-id">
          <div class="campo-form"><label for="emi-s-nome">Nome curto (aparece na lista)</label><input id="emi-s-nome" placeholder="ex.: Consultoria mensal"></div>
          <div class="campo-form"><label for="emi-s-desc">Descrição padrão na nota</label><textarea id="emi-s-desc" rows="2" maxlength="2000"></textarea></div>
          <div class="emi-dois">
            <div class="campo-form emi-busca-cod"><label for="emi-s-busca">Código de Tributação Nacional</label><input id="emi-s-busca" placeholder="digite o serviço (ex.: contabilidade) ou o código"><input type="hidden" id="emi-s-ctn"><div class="nf-lista-clientes emi-cod-lista" id="emi-s-lista"></div><small class="emi-ajuda" id="emi-s-ctn-desc"></small></div>
            <div class="campo-form"><label for="emi-s-ctm">Código municipal (se houver)</label><input id="emi-s-ctm" class="mono" maxlength="3" placeholder="3 números"></div>
          </div>
          <div class="emi-dois">
            <div class="campo-form"><label for="emi-s-nbs">Código NBS (opcional)</label><input id="emi-s-nbs" class="mono" maxlength="11" placeholder="9 números"></div>
            <div class="campo-form"><label for="emi-s-aliq">Alíquota do ISS % (para ISS retido)</label><input id="emi-s-aliq" class="mono" inputmode="decimal" placeholder="ex.: 2,00"></div>
          </div>
          <div class="campo-form"><label for="emi-s-loc">Local da prestação (código IBGE)</label><input id="emi-s-loc" class="mono" maxlength="7" placeholder="em branco = cidade do emitente"></div>
          <div class="nf-rodape"><button type="button" class="btn-ghost btn-sm" id="emi-s-novo">${icone("mais")}Novo</button><button class="btn-secundario" type="submit">${icone("salvar")}Salvar serviço</button></div>
        </form>`}
      </div>
    </div>`;
  const regime = () => (p.querySelector('[name="emi-regime"]:checked') || {}).value;
  const mostrarSimples = () => p.querySelectorAll("[data-so-simples]").forEach((x) => (x.hidden = regime() !== "simples"));
  p.querySelectorAll('[name="emi-regime"]').forEach((r) => (r.onchange = mostrarSimples)); mostrarSimples();
  // nome da cidade pelo código IBGE (serviço público do IBGE)
  const nomeCidade = async () => {
    const cod = _so($("#emi-c-cmun").value);
    const el = $("#emi-c-cidade");
    el.dataset.nome = "";
    if (cod.length !== 7) { el.textContent = cod ? "precisa ter 7 números" : ""; return; }
    el.textContent = "";
    try { const m = await (await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/municipios/${cod}`)).json(); const uf = m && m.microrregiao && m.microrregiao.mesorregiao && m.microrregiao.mesorregiao.UF; if (m && m.nome) { el.dataset.nome = `${m.nome}/${uf ? uf.sigla : ""}`; el.textContent = el.dataset.nome; } else el.textContent = "código não encontrado"; } catch {}
  };
  $("#emi-c-cmun").addEventListener("change", nomeCidade);
  // empresa ainda não configurada: município e regime vêm do CNPJ (como no Emissor Nacional)
  if (!c.emitente) {
    const o = $("#emi-c-origem");
    o.className = "emi-origem carregando"; o.innerHTML = `${icone("carregando", "girando ico-sm")}buscando os dados do CNPJ…`;
    api(`/api/consulta-cnpj/cadastro?cnpj=${emp.cnpj}`).then((x) => {
      if (EM.aba !== "config" || !$("#emi-c-cmun")) return;
      if (x.ibge && !$("#emi-c-cmun").value) { $("#emi-c-cmun").value = x.ibge; const el = $("#emi-c-cidade"); el.dataset.nome = x.municipio ? `${x.municipio}/${x.estado}` : ""; el.textContent = el.dataset.nome; }
      const reg = x.optanteMei ? "mei" : x.optanteSimples ? "simples" : null;
      if (reg) { p.querySelector(`[name="emi-regime"][value="${reg}"]`).checked = true; mostrarSimples(); }
      o.className = "emi-origem ok";
      o.innerHTML = `${icone("check", "ico-sm")}Da Receita Federal: ${escaparHtml(x.municipio ? x.municipio + "/" + x.estado : "")}${reg ? " · " + (reg === "mei" ? "MEI" : "Simples Nacional") : x.optanteSimples === false ? " · NÃO optante do Simples (confira)" : ""}. Confira e salve.`;
    }).catch(() => { o.className = "emi-origem aviso"; o.innerHTML = `${icone("alerta", "ico-sm")}Não consegui consultar o CNPJ agora: preencha à mão.`; });
  }
  $("#emi-cfg").onsubmit = async (ev) => {
    ev.preventDefault();
    const amb = p.querySelector('[name="emi-amb"]:checked').value;
    if (amb === "producao" && (!c.emitente || c.emitente.ambiente !== "producao") &&
      !confirm("Passar para PRODUÇÃO?\n\nA partir daí as notas emitidas valem de verdade (só se desfazem cancelando). Use depois de testar na produção restrita.")) return;
    const emitente = { cnpj: emp.cnpj, nome: emp.nome, regime: regime(), cMun: $("#emi-c-cmun").value, municipio: $("#emi-c-cidade").dataset.nome || "", im: $("#emi-c-im").value, pTotTribSN: $("#emi-c-ptt").value || "0",
      serie: $("#emi-c-serie").value, ambiente: amb, leiaute: $("#emi-c-leiaute").value, infoCompl: $("#emi-c-info").value };
    await comCarregando(ev.submitter, async () => {
      try {
        EM.cad = await robo("emitente.salvar", { emitente, proximoDps: $("#emi-c-prox").value });
        EM.inicio = await robo("inicio");
        notificar("Configuração salva no robô", "ok");
        desenharTopo(); desenharConfig();
      } catch (err) { notificar(err.message, "erro"); }
    });
  };
  const fs = $("#emi-serv");
  if (!fs) return;
  const editar = (s = {}) => {
    $("#emi-s-id").value = s.id || ""; $("#emi-s-nome").value = s.nome || ""; $("#emi-s-desc").value = s.descricao || ""; $("#emi-s-ctn").value = s.cTribNac || "";
    $("#emi-s-busca").value = s.cTribNac ? fmtCodigoServ(s.cTribNac) : ""; $("#emi-s-ctn-desc").textContent = s.cTribNac ? descricaoCodigoServ(s.cTribNac) : ""; $("#emi-s-lista").innerHTML = "";
    $("#emi-s-ctm").value = s.cTribMun || ""; $("#emi-s-nbs").value = s.cNBS || ""; $("#emi-s-aliq").value = String(s.pAliq || "").replace(".", ","); $("#emi-s-loc").value = s.cLocPrestacao || "";
    $("#emi-s-nome").focus();
  };
  $("#emi-s-novo").onclick = () => editar();
  const escolherCodigo = (cod) => {
    $("#emi-s-ctn").value = cod; $("#emi-s-busca").value = fmtCodigoServ(cod); $("#emi-s-lista").innerHTML = "";
    const d = descricaoCodigoServ(cod); $("#emi-s-ctn-desc").textContent = d;
    if (!$("#emi-s-desc").value.trim() && d) $("#emi-s-desc").value = d.replace(/\.$/, "");
    if (!$("#emi-s-nome").value.trim() && d) $("#emi-s-nome").value = d.split(/[,(.]/)[0].slice(0, 60);
  };
  $("#emi-s-busca").oninput = (ev) => {
    const v = ev.target.value.trim(), dig = _so(v);
    $("#emi-s-ctn").value = /^[\d.\s]+$/.test(v) && dig.length === 6 ? dig : "";
    $("#emi-s-ctn-desc").textContent = $("#emi-s-ctn").value ? descricaoCodigoServ(dig) || "código fora da lista (confira com a prefeitura)" : "";
    const achados = procurarCodigosServico(v);
    $("#emi-s-lista").innerHTML = achados.map(([cod, d]) => `<button type="button" class="nf-cli" data-cod="${cod}"><b>${fmtCodigoServ(cod)}</b><small>${escaparHtml(d)}</small></button>`).join("");
  };
  $("#emi-s-lista").onclick = (ev) => { const b = ev.target.closest("[data-cod]"); if (b) escolherCodigo(b.dataset.cod); };
  p.querySelector(".emi-servicos").onclick = async (ev) => {
    const ed = ev.target.closest("[data-editar]"), ap = ev.target.closest("[data-apagar]");
    if (ed) editar(c.servicos.find((s) => s.id === ed.dataset.editar));
    if (ap && confirm("Apagar este serviço? (as notas já emitidas não mudam)")) {
      try { const r = await robo("servico.apagar", { cnpj: emp.cnpj, id: ap.dataset.apagar }); EM.cad.servicos = r.servicos; desenharConfig(); } catch (err) { notificar(err.message, "erro"); }
    }
  };
  fs.onsubmit = async (ev) => {
    ev.preventDefault();
    const servico = { id: $("#emi-s-id").value || null, nome: $("#emi-s-nome").value, descricao: $("#emi-s-desc").value, cTribNac: $("#emi-s-ctn").value,
      cTribMun: $("#emi-s-ctm").value, cNBS: $("#emi-s-nbs").value, pAliq: $("#emi-s-aliq").value, cLocPrestacao: $("#emi-s-loc").value };
    await comCarregando(ev.submitter, async () => {
      try {
        const r = await robo("servico.salvar", { cnpj: emp.cnpj, servico });
        EM.cad.servicos = r.servicos;
        if (!EM.servicoId) EM.servicoId = r.id;
        notificar("Serviço salvo", "ok");
        desenharConfig();
      } catch (err) { notificar(err.message, "erro"); }
    });
  };
}

// ---------------------------------------------------------------------------
// Início da página (depois que common.js carregou a sessão e as empresas)
// ---------------------------------------------------------------------------
function valorBr(v) { const t = String(v ?? "").trim(); return Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t) || 0; }
let _iniciou = false;
async function renderizarPagina() {
  if (_iniciou) return;
  _iniciou = true;
  $('[data-painel="emitir"]').innerHTML = `<div class="esqueleto esqueleto-linha so-carregando"></div><div class="esqueleto esqueleto-linha so-carregando"></div>`;
  await carregarInicio();
  if (!EM.inicio) { desenharTopo(); return mostrarAba(EM.aba); }
  desenharTopo();
  await recarregarEmpresa();
}
iniciarPagina();
