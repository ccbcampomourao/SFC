// ============================================================================
// nfae.js — NFA-e (Nota Fiscal Avulsa eletrônica da Receita-PR) emitida pelo
// robô do escritório (Agente Prumo). Aqui: montar a nota, acompanhar a fila,
// manter os cadastros (emitentes, clientes, produtos) e vincular o computador.
// ============================================================================
const NF = {
  cad: { emitentes: [], clientes: {}, produtos: {} },
  tarefas: [],
  robos: [],
  fila: [],              // itens da nota que está sendo montada
  cliente: null,         // destinatário escolhido
  emitenteId: localStorage.getItem("prumo_nfae_emitente") || "",
  aba: "emitir",
  timer: 0,
};
const moeda = (n) => (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const valorNum = (v) => { const t = String(v ?? "").trim(); return Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t) || 0; };
const valorTxt = (n) => (Number(n) || 0).toFixed(2).replace(".", ",");
const precosDe = (p) => (Array.isArray(p.valor) ? p.valor : [p.valor]).map(String).filter((v) => valorNum(v) > 0);
const quando = (iso) => { if (!iso) return "—"; const d = new Date(iso); return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); };
const haQuanto = (iso) => { if (!iso) return "nunca"; const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 90 ? "agora há pouco" : s < 3600 ? `há ${Math.round(s / 60)} min` : s < 86400 ? `há ${Math.round(s / 3600)} h` : `há ${Math.round(s / 86400)} dia(s)`; };
const ROTULO_ST = { pendente: ["Na fila", "aviso"], em_andamento: ["Emitindo…", "info"], concluida: ["Emitida", "ok"], erro: ["Erro", "erro"], interrompida: ["Interrompida", "erro"], conferir: ["Conferir", "aviso"], cancelada: ["Cancelada", "neutro"] };

// ---------------------------------------------------------------------------
// Carregamento
// ---------------------------------------------------------------------------
function garantirEmitente() {
  if (!NF.cad.emitentes.some((e) => e.id === NF.emitenteId)) NF.emitenteId = NF.cad.emitentes[0]?.id || "";
}
async function carregarCadastros() {
  NF.cad = await api("/api/nfae/cadastros");
  garantirEmitente();
}
async function carregarTarefas() {
  const r = await api("/api/nfae/tarefas");
  NF.tarefas = r.tarefas; NF.robos = r.robos;
  atualizarTopo();
}
function atualizarTopo() {
  const online = NF.robos.filter((r) => r.online);
  const el = $("#robo-status-topo");
  el.className = "robo-status " + (online.length ? "on" : NF.robos.length ? "off" : "nenhum");
  el.innerHTML = online.length ? `<i></i>Robô online` : NF.robos.length ? `<i></i>Robô offline` : `<i></i>Nenhum robô vinculado`;
  el.title = NF.robos.map((r) => `${r.nome}: ${r.online ? "online" : "offline, visto " + haQuanto(r.vistoEm)}`).join("\n") || "Vincule um computador na aba Robô";
  const andamento = NF.tarefas.filter((t) => t.status === "pendente" || t.status === "em_andamento").length;
  $("#nfae-cont-andamento").textContent = andamento || "";
}
// enquanto houver nota na fila, confere a cada 10 s (só com a aba visível)
function agendarAtualizacao() {
  clearTimeout(NF.timer);
  const andando = NF.tarefas.some((t) => t.status === "pendente" || t.status === "em_andamento");
  NF.timer = setTimeout(async () => {
    if (document.visibilityState === "visible") {
      const antes = JSON.stringify(NF.tarefas.map((t) => [t.id, t.status]));
      await carregarTarefas().catch(() => {});
      if (JSON.stringify(NF.tarefas.map((t) => [t.id, t.status])) !== antes) {
        if (NF.aba === "historico") desenharHistorico();
        const nova = NF.tarefas.find((t) => t.status === "concluida" && !antes.includes(`"${t.id}","concluida"`));
        if (nova && antes.includes(`"${nova.id}"`)) notificar(`NFA-e emitida${nova.numeroNota ? " — nº " + nova.numeroNota : ""}`, "ok");
      }
    }
    agendarAtualizacao();
  }, andando ? 10000 : 60000);
}

// ---------------------------------------------------------------------------
// Abas
// ---------------------------------------------------------------------------
function mostrarAba(aba) {
  NF.aba = aba;
  $$("#nfae-abas [data-aba]").forEach((b) => { const a = b.dataset.aba === aba; b.classList.toggle("ativo", a); b.setAttribute("aria-selected", a); });
  $$(".nfae-painel").forEach((p) => (p.hidden = p.dataset.painel !== aba));
  ({ emitir: desenharEmitir, historico: desenharHistorico, cadastros: desenharCadastros, robo: desenharRobo })[aba]();
}
$("#nfae-abas").addEventListener("click", (e) => { const b = e.target.closest("[data-aba]"); if (b) mostrarAba(b.dataset.aba); });

// ---------------------------------------------------------------------------
// EMITIR
// ---------------------------------------------------------------------------
function desenharEmitir() {
  const p = $('[data-painel="emitir"]');
  garantirEmitente();
  const emit = NF.cad.emitentes;
  if (!emit.length) {
    p.innerHTML = `<div class="vazio">${icone("documento", "ico-xl")}<strong>Cadastre um emitente primeiro</strong><p>O emitente é o login da Receita-PR que vai emitir as notas. Vá em <b>Cadastros</b>.</p><button class="btn-primario" data-ir="cadastros">${icone("mais")}Cadastrar emitente</button></div>`;
    p.querySelector("[data-ir]").onclick = () => mostrarAba("cadastros");
    return;
  }
  const comSenha = NF.robos.some((r) => r.emitentesComSenha.includes(NF.emitenteId));
  p.innerHTML = `
    <div class="nfae-grade">
      <div class="nfae-col">
        <div class="cartao-nf">
          <h3>${icone("usuario")}Emitente</h3>
          <select id="nf-emitente">${emit.map((e) => `<option value="${escaparHtml(e.id)}"${e.id === NF.emitenteId ? " selected" : ""}>${escaparHtml(e.nome)} · ${escaparHtml(e.usuario)}</option>`).join("")}</select>
          ${NF.robos.length && !comSenha ? `<p class="nf-aviso">${icone("alerta")}A senha deste emitente ainda não foi cadastrada no robô. Cadastre no computador do robô (janela do Agente Prumo → Senhas).</p>` : ""}
        </div>
        <div class="cartao-nf">
          <h3>${icone("empresas")}Destinatário</h3>
          <div id="nf-cliente-escolhido"></div>
          <label class="campo-busca nf-busca">${icone("busca")}<input type="search" id="nf-busca-cliente" placeholder="Buscar cliente por nome, CNPJ ou cidade" autocomplete="off"></label>
          <div class="nf-lista-clientes" id="nf-lista-clientes"></div>
          <button type="button" class="btn-ghost btn-sm" id="nf-novo-cliente">${icone("mais")}Novo cliente</button>
        </div>
      </div>
      <div class="nfae-col">
        <div class="cartao-nf">
          <h3>${icone("tarefas")}Produtos</h3>
          <form class="nf-add" id="nf-add">
            <input id="nf-cod" placeholder="Código do produto" autocomplete="off" list="nf-codigos">
            <datalist id="nf-codigos">${Object.entries(NF.cad.produtos).map(([c, pr]) => `<option value="${escaparHtml(c)}">${escaparHtml(pr.descricao)}</option>`).join("")}</datalist>
            <input id="nf-qtd" type="number" min="1" step="1" value="1" title="Quantidade">
            <button class="btn-secundario" type="submit">${icone("mais")}Adicionar</button>
          </form>
          <div id="nf-fila"></div>
          <div class="campo-form"><label>Observação (opcional)</label><textarea id="nf-obs" rows="2" maxlength="500" placeholder="Vai junto com a tarefa do robô"></textarea></div>
          <div class="nf-rodape">
            <div class="nf-total"><small id="nf-linhas">0 itens</small><b id="nf-total">R$ 0,00</b></div>
            <button class="btn-primario" id="nf-enviar">${icone("enviar")}Emitir pelo robô</button>
          </div>
          <p class="nf-dica">${icone("info")}O robô transmite a nota sozinho. Confira destinatário, quantidades e preços antes de enviar.</p>
        </div>
      </div>
    </div>`;
  $("#nf-emitente").onchange = (e) => { NF.emitenteId = e.target.value; try { localStorage.setItem("prumo_nfae_emitente", NF.emitenteId); } catch {} desenharEmitir(); };
  $("#nf-busca-cliente").oninput = desenharListaClientes;
  $("#nf-novo-cliente").onclick = () => editarCliente(null, (c) => { NF.cliente = c; desenharEmitir(); });
  $("#nf-add").onsubmit = (e) => { e.preventDefault(); adicionarProduto($("#nf-cod").value.trim(), Number($("#nf-qtd").value) || 1); };
  $("#nf-enviar").onclick = (e) => comCarregando(e.currentTarget, enviarNota);
  desenharClienteEscolhido();
  desenharListaClientes();
  desenharFila();
}

function textoCliente(c) { return `${c.nome || c.razao_social} ${c.razao_social || ""} ${c.cnpj} ${c.municipio || ""}`.toLowerCase(); }
function desenharListaClientes() {
  const termo = ($("#nf-busca-cliente")?.value || "").trim().toLowerCase();
  const dig = termo.replace(/\D/g, "");
  const lista = Object.values(NF.cad.clientes)
    .filter((c) => !termo || textoCliente(c).includes(termo) || (dig.length >= 3 && String(c.cnpj).includes(dig)))
    .sort((a, b) => String(a.nome || a.razao_social).localeCompare(String(b.nome || b.razao_social)));
  const caixa = $("#nf-lista-clientes");
  if (!caixa) return;
  caixa.hidden = !!NF.cliente && !termo;
  caixa.innerHTML = lista.slice(0, 40).map((c) => `
    <button type="button" class="nf-cli" data-cnpj="${escaparHtml(c.cnpj)}">
      <b>${escaparHtml(c.nome || c.razao_social)}</b>
      <small><span class="mono">${escaparHtml(formatarDocumento(c.cnpj))}</span> · ${escaparHtml(c.municipio || "")}</small>
    </button>`).join("") || `<div class="nf-vazio">Nenhum cliente encontrado.</div>`;
  caixa.onclick = (e) => { const b = e.target.closest("[data-cnpj]"); if (!b) return; NF.cliente = NF.cad.clientes[b.dataset.cnpj]; $("#nf-busca-cliente").value = ""; desenharClienteEscolhido(); desenharListaClientes(); };
}
function desenharClienteEscolhido() {
  const c = NF.cliente, box = $("#nf-cliente-escolhido");
  if (!box) return;
  box.innerHTML = c ? `
    <div class="nf-escolhido">
      <div><b>${escaparHtml(c.nome || c.razao_social)}</b>
        <small>${escaparHtml(c.razao_social && c.razao_social !== c.nome ? c.razao_social + " · " : "")}CNPJ <span class="mono">${escaparHtml(formatarDocumento(c.cnpj))}</span> · IE <span class="mono">${escaparHtml(c.ie || "—")}</span></small>
        <small>${escaparHtml([c.logradouro, c.numero, c.complemento, c.bairro].filter(Boolean).join(", "))} — ${escaparHtml(c.municipio || "")}/${escaparHtml(c.estado || "")} · CEP ${escaparHtml(c.cep || "")}</small></div>
      <span class="nf-esc-acoes"><button type="button" class="btn-ghost btn-sm" data-ed>${icone("documento")}Editar</button><button type="button" class="btn-ghost btn-sm" data-troca>${icone("x")}Trocar</button></span>
    </div>` : "";
  box.querySelector("[data-troca]")?.addEventListener("click", () => { NF.cliente = null; desenharClienteEscolhido(); desenharListaClientes(); $("#nf-busca-cliente").focus(); });
  box.querySelector("[data-ed]")?.addEventListener("click", () => editarCliente(c, (novo) => { NF.cliente = novo; desenharClienteEscolhido(); }));
}

function adicionarProduto(codigo, qtd) {
  const p = NF.cad.produtos[codigo];
  if (!p) { notificar(`Produto “${codigo}” não está cadastrado.`, "aviso"); return; }
  const precos = precosDe(p);
  const existente = NF.fila.find((i) => i.codigo === codigo);
  if (existente) existente.qtd += qtd;
  else NF.fila.push({ codigo, descricao: p.descricao, ncm: p.ncm, qtd, valor: precos[0] || "", precos });
  $("#nf-cod").value = ""; $("#nf-qtd").value = 1; $("#nf-cod").focus();
  desenharFila();
}
function desenharFila() {
  const box = $("#nf-fila");
  if (!box) return;
  box.innerHTML = NF.fila.length ? `
    <table class="nf-tabela"><thead><tr><th>Produto</th><th class="num">Qtd</th><th class="num">Preço</th><th class="num">Subtotal</th><th></th></tr></thead>
    <tbody>${NF.fila.map((i, n) => `
      <tr data-n="${n}">
        <td><b>${escaparHtml(i.descricao)}</b><small><span class="mono">${escaparHtml(i.codigo)}</span> · NCM <span class="mono">${escaparHtml(i.ncm)}</span></small></td>
        <td class="num"><input type="number" min="1" step="1" value="${i.qtd}" data-qtd></td>
        <td class="num">${i.precos.length > 1
          ? `<select data-preco>${i.precos.map((v) => `<option${v === i.valor ? " selected" : ""}>${escaparHtml(v)}</option>`).join("")}<option value="__outro">Outro…</option></select>`
          : `<input value="${escaparHtml(i.valor)}" data-valor inputmode="decimal" placeholder="0,00">`}</td>
        <td class="num"><b>${moeda(i.qtd * valorNum(i.valor))}</b></td>
        <td><button type="button" class="btn-icone" data-rem title="Remover">${icone("x", "ico-sm")}</button></td>
      </tr>`).join("")}</tbody></table>` : `<div class="nf-vazio">Digite o código do produto e aperte Enter.</div>`;
  const total = NF.fila.reduce((s, i) => s + i.qtd * valorNum(i.valor), 0);
  $("#nf-total").textContent = moeda(total);
  $("#nf-linhas").textContent = `${NF.fila.length} ${NF.fila.length === 1 ? "item" : "itens"}`;
  box.oninput = box.onchange = (e) => {
    const tr = e.target.closest("tr[data-n]"); if (!tr) return;
    const it = NF.fila[+tr.dataset.n];
    if (e.target.matches("[data-qtd]")) it.qtd = Math.max(1, Math.round(Number(e.target.value) || 1));
    if (e.target.matches("[data-valor]")) it.valor = e.target.value;
    if (e.target.matches("[data-preco]") && e.type === "change") {
      if (e.target.value === "__outro") { it.precos = []; it.valor = ""; return desenharFila(); }
      it.valor = e.target.value;
    }
    if (e.type === "change") desenharFila();
    else { $("#nf-total").textContent = moeda(NF.fila.reduce((s, i) => s + i.qtd * valorNum(i.valor), 0)); }
  };
  box.onclick = (e) => { const b = e.target.closest("[data-rem]"); if (!b) return; NF.fila.splice(+b.closest("tr").dataset.n, 1); desenharFila(); };
}

async function enviarNota() {
  if (!NF.cliente) return notificar("Escolha o destinatário.", "aviso");
  if (!NF.fila.length) return notificar("Adicione os produtos.", "aviso");
  const total = NF.fila.reduce((s, i) => s + i.qtd * valorNum(i.valor), 0);
  const emit = NF.cad.emitentes.find((e) => e.id === NF.emitenteId);
  const ok = await confirmar(`${emit.nome} → ${NF.cliente.nome || NF.cliente.razao_social}\n${NF.fila.length} item(ns) · ${moeda(total)}\n\nO robô vai transmitir esta nota sozinho.`, { titulo: "Emitir NFA-e?", textoOk: "Emitir" });
  if (!ok) return;
  try {
    await api("/api/nfae/tarefas", { method: "POST", body: JSON.stringify({ emitenteId: NF.emitenteId, cliente: NF.cliente, itens: NF.fila.map(({ precos, ...i }) => i), observacao: $("#nf-obs").value }) });
    notificar("Nota enviada para o robô", "ok");
    NF.fila = []; NF.cliente = null;
    await carregarTarefas();
    agendarAtualizacao();
    mostrarAba("historico");
  } catch (err) {
    avisar(err.message, { titulo: "Não deu para enviar", tipo: "erro" });
  }
}

// ---------------------------------------------------------------------------
// HISTÓRICO
// ---------------------------------------------------------------------------
function desenharHistorico() {
  const p = $('[data-painel="historico"]');
  if (!NF.tarefas.length) { p.innerHTML = `<div class="vazio">${icone("documento", "ico-xl")}<strong>Nenhuma nota ainda</strong><p>As NFA-e enviadas para o robô aparecem aqui, com o PDF quando ficarem prontas.</p></div>`; return; }
  p.innerHTML = `<div class="nf-hist">${NF.tarefas.map((t) => {
    let [rot, tom] = ROTULO_ST[t.status] || [t.status, "neutro"];
    if (t.modo === "consultar" && t.status === "pendente") rot = "Na fila p/ consultar";
    if (t.modo === "consultar" && t.status === "em_andamento") rot = "Consultando…";
    const r = t.resumo || {};
    const arqs = (t.arquivos || []).map((a) => {
      const ver = /pdf|image/.test(a.tipo);
      return `<a class="chip-arq" href="/api/nfae/arquivo/${t.id}/${encodeURIComponent(a.nome)}${ver ? "?ver=1" : ""}" target="_blank" rel="noopener">${icone(/pdf/.test(a.tipo) ? "arquivoPdf" : /xml/.test(a.tipo) || /\.xml$/i.test(a.nome) ? "xml" : "arquivo")}${escaparHtml(a.nome)}</a>`;
    }).join("");
    return `
      <div class="nf-linha st-${t.status}">
        <span class="nf-st nf-st-${tom}">${t.status === "em_andamento" ? `<i class="girando-ponto"></i>` : ""}${rot}</span>
        <div class="nf-linha-txt">
          <b>${escaparHtml(r.cliente || "—")}${t.numeroNota ? ` <span class="nf-num">nº ${escaparHtml(t.numeroNota)}</span>` : ""}</b>
          <small>${quando(t.criadoEm)} · ${r.itens || 0} item(ns) · <b>${moeda(r.total)}</b> · por ${escaparHtml(t.criadoPor || "—")}${t.roboNome ? ` · robô: ${escaparHtml(t.roboNome)}` : ""}</small>
          ${t.mensagem && t.status !== "concluida" ? `<small class="nf-msg">${escaparHtml(t.mensagem)}</small>` : ""}
          ${arqs ? `<div class="nf-arqs">${arqs}</div>` : ""}
        </div>
        <span class="nf-acoes">
          ${["pendente", "em_andamento", "erro", "interrompida", "conferir"].includes(t.status) ? `<button type="button" class="btn-ghost btn-sm" data-cancelar="${t.id}">${icone("x")}Cancelar pedido</button>` : ""}
          ${["interrompida", "conferir"].includes(t.status) ? `<button type="button" class="btn-primario btn-sm" data-consultar="${t.id}" title="O robô procura esta nota na Consulta do portal e baixa a DANFE e o XML. Não emite nada.">${icone("busca")}Consultar no portal</button>` : ""}
          ${["erro", "interrompida", "conferir", "cancelada"].includes(t.status) ? `<button type="button" class="btn-secundario btn-sm" data-refazer="${t.id}">${icone("atualizar")}Mandar de novo</button>` : ""}
        </span>
      </div>`;
  }).join("")}</div>`;
  p.onclick = async (e) => {
    const q = e.target.closest("[data-consultar]");
    if (q) {
      try {
        await api(`/api/nfae/tarefas/${q.dataset.consultar}/consultar`, { method: "POST" });
        notificar("O robô vai procurar a nota na Consulta do portal (sem emitir nada).", "ok");
        await carregarTarefas(); desenharHistorico(); agendarAtualizacao();
      } catch (err) { notificar(err.message, "erro"); }
      return;
    }
    const c = e.target.closest("[data-cancelar]"), r = e.target.closest("[data-refazer]");
    if (!c && !r) return;
    const t = NF.tarefas.find((x) => x.id === (c || r).dataset[c ? "cancelar" : "refazer"]);
    if (c) {
      const msg = t.status === "pendente" ? "A nota sai da fila e o robô não vai emiti-la."
        : t.status === "em_andamento" ? "O robô está trabalhando nesta nota agora. Ele vai parar antes de clicar em “Emitir”. Se já tiver emitido, a nota aparece como Emitida."
        : "O pedido fica como Cancelado e sai das pendências. Isso NÃO cancela uma nota que já tenha sido emitida na Receita — confira no portal.";
      if (!(await confirmar(msg, { titulo: "Cancelar o pedido desta nota?", textoOk: "Cancelar pedido" }))) return;
    }
    if (r && ["interrompida", "conferir", "erro"].includes(t.status) && !(await confirmar("Antes de mandar de novo, confira no portal da Receita-PR se esta nota NÃO foi emitida — senão ela sai em duplicidade.", { titulo: "Mandar de novo?", textoOk: "Já conferi, mandar" }))) return;
    try {
      await api(`/api/nfae/tarefas/${t.id}/${c ? "cancelar" : "refazer"}`, { method: "POST" });
      await carregarTarefas(); desenharHistorico(); agendarAtualizacao();
    } catch (err) { notificar(err.message, "erro"); }
  };
}

// ---------------------------------------------------------------------------
// CADASTROS
// ---------------------------------------------------------------------------
async function salvarCadastros(parte) {
  const r = await api("/api/nfae/cadastros", { method: "POST", body: JSON.stringify(parte) });
  NF.cad = { emitentes: r.emitentes, clientes: r.clientes, produtos: r.produtos };
  garantirEmitente();
}
function desenharCadastros() {
  const p = $('[data-painel="cadastros"]');
  const nCli = Object.keys(NF.cad.clientes).length, nPro = Object.keys(NF.cad.produtos).length;
  p.innerHTML = `
    <div class="nfae-grade tres">
      <div class="cartao-nf">
        <h3>${icone("usuario")}Emitentes <em>${NF.cad.emitentes.length}</em></h3>
        <p class="nf-sub">Logins da Receita-PR que emitem as notas. <b>A senha não fica no Prumo</b>: ela é digitada só no computador do robô.</p>
        <div class="nf-lista">${NF.cad.emitentes.map((e) => {
          const temSenha = NF.robos.some((r) => r.emitentesComSenha.includes(e.id));
          return `<div class="nf-item"><span><b>${escaparHtml(e.nome)}</b><small class="mono">${escaparHtml(e.usuario)}</small></span>
            <span class="tag ${temSenha ? "tag-ok" : "tag-aviso"}">${temSenha ? "senha no robô" : "sem senha no robô"}</span>
            <button type="button" class="btn-icone" data-rem-emit="${escaparHtml(e.id)}" title="Remover">${icone("lixeira", "ico-sm")}</button></div>`;
        }).join("") || `<div class="nf-vazio">Nenhum emitente.</div>`}</div>
        <form class="nf-form-emit" id="nf-form-emit">
          <input id="ne-nome" placeholder="Nome (ex.: Distribuidora Silva)" required maxlength="80">
          <input id="ne-usuario" placeholder="Usuário da Receita-PR (CPF/login)" required maxlength="60" class="mono">
          <button class="btn-secundario btn-sm" type="submit">${icone("mais")}Adicionar emitente</button>
        </form>
      </div>
      <div class="cartao-nf">
        <h3>${icone("empresas")}Clientes (destinatários) <em>${nCli}</em></h3>
        <p class="nf-sub">Aceita o <span class="mono">clientes.json</span> do aplicativo antigo, do jeito que está.</p>
        <div class="nf-botoes"><button type="button" class="btn-secundario btn-sm" data-importar="clientes">${icone("enviar")}Importar clientes.json</button><button type="button" class="btn-ghost btn-sm" id="nf-cli-novo">${icone("mais")}Novo</button><button type="button" class="btn-ghost btn-sm" data-exportar="clientes">${icone("baixar")}Exportar</button></div>
        <label class="campo-busca nf-busca">${icone("busca")}<input type="search" id="nf-filtro-cli" placeholder="Filtrar" autocomplete="off"></label>
        <div class="nf-lista alta" id="nf-cad-clientes"></div>
      </div>
      <div class="cartao-nf">
        <h3>${icone("tarefas")}Produtos <em>${nPro}</em></h3>
        <p class="nf-sub">Aceita o <span class="mono">produtos.json</span> (inclusive produto com vários preços).</p>
        <div class="nf-botoes"><button type="button" class="btn-secundario btn-sm" data-importar="produtos">${icone("enviar")}Importar produtos.json</button><button type="button" class="btn-ghost btn-sm" id="nf-pro-novo">${icone("mais")}Novo</button><button type="button" class="btn-ghost btn-sm" data-exportar="produtos">${icone("baixar")}Exportar</button></div>
        <label class="campo-busca nf-busca">${icone("busca")}<input type="search" id="nf-filtro-pro" placeholder="Filtrar" autocomplete="off"></label>
        <div class="nf-lista alta" id="nf-cad-produtos"></div>
      </div>
    </div>
    <input type="file" id="nf-arquivo-json" accept="application/json,.json" class="oculto">`;
  const listaCli = () => {
    const t = ($("#nf-filtro-cli").value || "").toLowerCase();
    $("#nf-cad-clientes").innerHTML = Object.values(NF.cad.clientes).filter((c) => !t || textoCliente(c).includes(t)).sort((a, b) => String(a.nome).localeCompare(String(b.nome))).slice(0, 200).map((c) => `
      <div class="nf-item"><span><b>${escaparHtml(c.nome || c.razao_social)}</b><small><span class="mono">${escaparHtml(formatarDocumento(c.cnpj))}</span> · ${escaparHtml(c.municipio || "")}</small></span>
      <button type="button" class="btn-icone neutro" data-ed-cli="${escaparHtml(c.cnpj)}" title="Editar">${icone("documento", "ico-sm")}</button>
      <button type="button" class="btn-icone" data-rem-cli="${escaparHtml(c.cnpj)}" title="Remover">${icone("lixeira", "ico-sm")}</button></div>`).join("") || `<div class="nf-vazio">Nenhum cliente.</div>`;
  };
  const listaPro = () => {
    const t = ($("#nf-filtro-pro").value || "").toLowerCase();
    $("#nf-cad-produtos").innerHTML = Object.entries(NF.cad.produtos).filter(([c, p]) => !t || `${c} ${p.descricao} ${p.ncm}`.toLowerCase().includes(t)).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).slice(0, 300).map(([c, p]) => `
      <div class="nf-item"><span><b><span class="mono nf-cod">${escaparHtml(c)}</span>${escaparHtml(p.descricao)}</b><small>NCM <span class="mono">${escaparHtml(p.ncm)}</span> · ${precosDe(p).map((v) => "R$ " + escaparHtml(v)).join(" / ") || "sem preço"}</small></span>
      <button type="button" class="btn-icone neutro" data-ed-pro="${escaparHtml(c)}" title="Editar">${icone("documento", "ico-sm")}</button>
      <button type="button" class="btn-icone" data-rem-pro="${escaparHtml(c)}" title="Remover">${icone("lixeira", "ico-sm")}</button></div>`).join("") || `<div class="nf-vazio">Nenhum produto.</div>`;
  };
  listaCli(); listaPro();
  $("#nf-filtro-cli").oninput = listaCli; $("#nf-filtro-pro").oninput = listaPro;
  $("#nf-form-emit").onsubmit = (e) => { e.preventDefault(); comCarregando(e.submitter, async () => {
    try { await salvarCadastros({ emitentes: [...NF.cad.emitentes, { id: crypto.randomUUID(), nome: $("#ne-nome").value.trim(), usuario: $("#ne-usuario").value.trim() }] }); notificar("Emitente cadastrado. Agora cadastre a senha dele no robô.", "ok"); desenharCadastros(); } catch (err) { notificar(err.message, "erro"); }
  }); };
  $("#nf-cli-novo").onclick = () => editarCliente(null, () => desenharCadastros());
  $("#nf-pro-novo").onclick = () => editarProduto(null);
  let alvoImport = null;
  p.onclick = async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.importar) { alvoImport = b.dataset.importar; $("#nf-arquivo-json").click(); }
    if (b.dataset.exportar) { const blob = new Blob([JSON.stringify(NF.cad[b.dataset.exportar], null, 4)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${b.dataset.exportar}.json`; a.click(); URL.revokeObjectURL(a.href); }
    if (b.dataset.remEmit && await confirmar("Remover este emitente? As notas já emitidas continuam no histórico.", { titulo: "Remover emitente?", textoOk: "Remover", perigo: true })) { await salvarCadastros({ emitentes: NF.cad.emitentes.filter((x) => x.id !== b.dataset.remEmit) }); desenharCadastros(); }
    if (b.dataset.edCli) editarCliente(NF.cad.clientes[b.dataset.edCli], () => desenharCadastros());
    if (b.dataset.remCli && await confirmar("Remover este cliente do cadastro?", { titulo: "Remover cliente?", textoOk: "Remover", perigo: true })) { const c = { ...NF.cad.clientes }; delete c[b.dataset.remCli]; await salvarCadastros({ clientes: c }); desenharCadastros(); }
    if (b.dataset.edPro) editarProduto(b.dataset.edPro);
    if (b.dataset.remPro && await confirmar("Remover este produto do cadastro?", { titulo: "Remover produto?", textoOk: "Remover", perigo: true })) { const c = { ...NF.cad.produtos }; delete c[b.dataset.remPro]; await salvarCadastros({ produtos: c }); desenharCadastros(); }
  };
  $("#nf-arquivo-json").onchange = async (e) => {
    const arq = e.target.files[0]; e.target.value = "";
    if (!arq || !alvoImport) return;
    try {
      const dados = JSON.parse(await arq.text());
      if (!dados || typeof dados !== "object" || Array.isArray(dados)) throw new Error("O arquivo não está no formato esperado.");
      const novos = alvoImport === "clientes" ? normalizarClientes(dados) : normalizarProdutos(dados);
      const qtd = Object.keys(novos).length;
      if (!qtd) throw new Error("Não achei nenhum registro no arquivo.");
      const atuais = NF.cad[alvoImport];
      const repetidos = Object.keys(novos).filter((k) => atuais[k]).length;
      if (!(await confirmar(`${qtd} ${alvoImport} no arquivo${repetidos ? ` (${repetidos} já existem e serão atualizados)` : ""}.`, { titulo: "Importar?", textoOk: "Importar" }))) return;
      await salvarCadastros({ [alvoImport]: { ...atuais, ...novos } });
      notificar(`${qtd} ${alvoImport} importados`, "ok");
      desenharCadastros();
    } catch (err) { avisar("Não consegui importar: " + err.message, { titulo: "Arquivo inválido", tipo: "erro" }); }
  };
}
function normalizarClientes(obj) {
  const out = {};
  for (const [chave, c] of Object.entries(obj)) {
    if (!c || typeof c !== "object") continue;
    const cnpj = String(c.cnpj || chave).replace(/\D/g, "");
    if (cnpj.length !== 14) continue;
    out[cnpj] = Object.fromEntries(["ie", "nome", "razao_social", "cep", "logradouro", "numero", "bairro", "municipio", "estado", "complemento"].map((k) => [k, String(c[k] ?? "").trim()]));
    out[cnpj].cnpj = cnpj;
    out[cnpj].estado = out[cnpj].estado || "PR";
  }
  return out;
}
function normalizarProdutos(obj) {
  const out = {};
  for (const [codigo, p] of Object.entries(obj)) {
    if (!p || typeof p !== "object" || !p.descricao) continue;
    const valores = (Array.isArray(p.valor) ? p.valor : [p.valor]).map((v) => String(v ?? "").trim()).filter(Boolean);
    out[String(codigo).trim()] = { descricao: String(p.descricao).trim(), ncm: String(p.ncm || "").replace(/\D/g, ""), valor: valores.length > 1 ? valores : valores[0] || "0,00" };
  }
  return out;
}

function editarCliente(c, aoSalvar) {
  const v = c || { estado: "PR" };
  const campos = [["cnpj", "CNPJ", "mono"], ["ie", "Inscrição estadual", "mono"], ["nome", "Nome fantasia"], ["razao_social", "Razão social"], ["cep", "CEP", "mono"], ["logradouro", "Logradouro"], ["numero", "Número"], ["complemento", "Complemento"], ["bairro", "Bairro"], ["municipio", "Município"], ["estado", "UF"]];
  abrirModal(`
    <h2>${c ? "Editar cliente" : "Novo cliente"}</h2>
    <form id="fc" class="nf-form-cli">
      ${campos.map(([k, r, cl]) => {
        const input = `<input data-k="${k}" value="${escaparHtml(v[k] || "")}" ${cl ? `class="${cl}"` : ""} ${k === "cnpj" && c ? "readonly" : ""} ${["cnpj", "ie", "cep", "logradouro", "numero", "bairro", "municipio"].includes(k) ? "required" : ""}>`;
        if (k === "cnpj") return `<div class="campo-form largo"><label>${r}</label><div class="nf-cnpj-busca">${input}<button type="button" class="btn-secundario btn-sm" id="fc-buscar" title="Busca razão social e endereço na base pública da Receita (grátis)">${icone("busca")}Buscar</button></div></div>`;
        return `<div class="campo-form${k === "logradouro" || k === "razao_social" ? " largo" : ""}"><label>${r}</label>${input}</div>`;
      }).join("")}
      <p class="nf-cnpj-aviso" id="fc-aviso" hidden></p>
      <div class="modal-rodape"><button type="button" class="btn-ghost" id="fc-cancelar">Cancelar</button><button class="btn-primario" type="submit">${icone("salvar")}Salvar</button></div>
    </form>`);
  $("#fc-cancelar").onclick = fecharModal;
  const campoCnpj = $('#fc [data-k="cnpj"]');
  let ultimoBuscado = "";
  const buscar = (botao) => comCarregando(botao, async () => {
    const cnpj = campoCnpj.value.replace(/\D/g, "");
    if (cnpj.length !== 14) return notificar("Digite o CNPJ com 14 números para buscar.", "aviso");
    ultimoBuscado = cnpj;
    try {
      const d = await api(`/api/consulta-cnpj/cadastro?cnpj=${cnpj}`);
      for (const k of ["razao_social", "nome", "cep", "logradouro", "numero", "complemento", "bairro", "municipio", "estado", "ie"]) {
        const val = String(d[k] || "").trim();
        if (val) $(`#fc [data-k="${k}"]`).value = val;
      }
      if (!$('#fc [data-k="nome"]').value.trim()) $('#fc [data-k="nome"]').value = d.razao_social || "";
      const aviso = $("#fc-aviso");
      const inativa = d.situacao && !/ativa/i.test(d.situacao);
      aviso.hidden = false;
      aviso.className = "nf-cnpj-aviso" + (inativa ? " ruim" : "");
      aviso.textContent = (inativa ? `Atenção: situação na Receita “${d.situacao}”. ` : "") +
        `Dados da ${d.fonte}. ` + (d.ie ? "A inscrição estadual também veio — confira." : "Complete a inscrição estadual (não vem na consulta gratuita).") + " Confira o número e o endereço antes de salvar.";
      (d.ie ? $('#fc [data-k="numero"]') : $('#fc [data-k="ie"]')).focus();
    } catch (err) { notificar(err.message, "erro"); }
  });
  $("#fc-buscar").onclick = (e) => buscar(e.currentTarget);
  // cliente novo: ao completar os 14 números, já busca sozinho
  if (!c) campoCnpj.addEventListener("input", () => {
    const cnpj = campoCnpj.value.replace(/\D/g, "");
    if (cnpj.length === 14 && cnpj !== ultimoBuscado) buscar($("#fc-buscar"));
  });
  $("#fc").onsubmit = (e) => { e.preventDefault(); comCarregando(e.submitter, async () => {
    const novo = {}; $$("#fc [data-k]").forEach((i) => (novo[i.dataset.k] = i.value.trim()));
    novo.cnpj = novo.cnpj.replace(/\D/g, "");
    if (novo.cnpj.length !== 14) return notificar("CNPJ precisa ter 14 números.", "aviso");
    try { await salvarCadastros({ clientes: { ...NF.cad.clientes, [novo.cnpj]: novo } }); fecharModal(); notificar("Cliente salvo", "ok"); aoSalvar && aoSalvar(NF.cad.clientes[novo.cnpj]); } catch (err) { notificar(err.message, "erro"); }
  }); };
}
function editarProduto(codigo) {
  const p = codigo ? NF.cad.produtos[codigo] : { descricao: "", ncm: "", valor: "" };
  abrirModal(`
    <h2>${codigo ? "Editar produto" : "Novo produto"}</h2>
    <form id="fp" class="nf-form-cli">
      <div class="campo-form"><label>Código</label><input id="fp-cod" class="mono" value="${escaparHtml(codigo || "")}" ${codigo ? "readonly" : ""} required></div>
      <div class="campo-form"><label>NCM (8 números)</label><input id="fp-ncm" class="mono" value="${escaparHtml(p.ncm)}" required pattern="\\d{8}"></div>
      <div class="campo-form largo"><label>Descrição</label><input id="fp-desc" value="${escaparHtml(p.descricao)}" required></div>
      <div class="campo-form largo"><label>Preço(s) — separe vários com “;”</label><input id="fp-val" value="${escaparHtml(precosDe(p).join("; "))}" placeholder="2,95; 3,10"></div>
      <div class="modal-rodape"><button type="button" class="btn-ghost" id="fp-cancelar">Cancelar</button><button class="btn-primario" type="submit">${icone("salvar")}Salvar</button></div>
    </form>`);
  $("#fp-cancelar").onclick = fecharModal;
  $("#fp").onsubmit = (e) => { e.preventDefault(); comCarregando(e.submitter, async () => {
    const valores = $("#fp-val").value.split(";").map((x) => x.trim()).filter(Boolean);
    const cod = $("#fp-cod").value.trim();
    try { await salvarCadastros({ produtos: { ...NF.cad.produtos, [cod]: { descricao: $("#fp-desc").value.trim(), ncm: $("#fp-ncm").value.replace(/\D/g, ""), valor: valores.length > 1 ? valores : valores[0] || "0,00" } } }); fecharModal(); notificar("Produto salvo", "ok"); if (NF.aba === "cadastros") desenharCadastros(); } catch (err) { notificar(err.message, "erro"); }
  }); };
}

// ---------------------------------------------------------------------------
// ROBÔ (vincular computador)
// ---------------------------------------------------------------------------
function desenharRobo() {
  const p = $('[data-painel="robo"]');
  p.innerHTML = `
    <div class="nfae-grade">
      <div class="cartao-nf">
        <h3>${icone("camadas")}Computadores vinculados</h3>
        <div class="nf-lista">${NF.robos.map((r) => `
          <div class="nf-item robo-item">
            <span class="robo-luz ${r.online ? "on" : ""}"></span>
            <span><b>${escaparHtml(r.nome)}</b><small>${r.online ? "online" : "offline"} · visto ${haQuanto(r.vistoEm)}${r.versao ? ` · agente ${escaparHtml(r.versao)}` : ""} · ${r.emitentesComSenha.length} senha(s) cadastrada(s)</small></span>
            <button type="button" class="btn-sm btn-perigo-outline" data-desvincular="${r.id}">${icone("x")}Desvincular</button>
          </div>`).join("") || `<div class="nf-vazio">Nenhum computador vinculado ainda.</div>`}</div>
        <button type="button" class="btn-primario" id="nf-gerar-codigo">${icone("link")}Vincular computador</button>
        <div id="nf-codigo"></div>
      </div>
      <div class="cartao-nf">
        <h3>${icone("info")}Como instalar o robô</h3>
        <ol class="nf-passos">
          <li>No computador do escritório (Windows), instale o <b>Python 3.12 ou mais novo</b> marcando “Add python.exe to PATH”, e o <b>Firefox</b>.</li>
          <li>Baixe o <a href="/robo/agente-prumo.zip" download>Agente Prumo (.zip)</a>, extraia numa pasta fixa (ex.: <span class="mono">C:\\PrumoRobo</span>) e dê dois cliques em <span class="mono">instalar.bat</span>.</li>
          <li>Na janela do agente, informe o endereço do Prumo e o <b>código de vínculo</b> gerado aqui ao lado.</li>
          <li>Na aba <b>Senhas</b> do agente, digite a senha da Receita-PR de cada emitente. Ela fica protegida pelo Windows naquele computador e nunca vem para o Prumo.</li>
          <li>Deixe o computador ligado e sem suspender. O agente inicia sozinho com o Windows.</li>
        </ol>
      </div>
    </div>`;
  $("#nf-gerar-codigo").onclick = (e) => comCarregando(e.currentTarget, async () => {
    const r = await api("/api/robos/codigo", { method: "POST" });
    const fim = Date.parse(r.expiraEm);
    const box = $("#nf-codigo");
    box.innerHTML = `<div class="nf-codigo"><small>Digite no Agente Prumo:</small><b class="mono">${r.codigo}</b><small id="nf-cod-tempo"></small></div>`;
    const tick = () => { const s = Math.max(0, Math.round((fim - Date.now()) / 1000)); const t = $("#nf-cod-tempo"); if (!t) return; t.textContent = s ? `vale por mais ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "código vencido — gere outro"; if (s) setTimeout(tick, 1000); };
    tick();
    // quando o computador aparecer, atualiza a lista sozinho
    const qtd = NF.robos.length;
    const espera = async (n) => { if (n > 60 || NF.aba !== "robo") return; await carregarTarefas().catch(() => {}); if (NF.robos.length > qtd) { notificar("Computador vinculado!", "ok"); return desenharRobo(); } setTimeout(() => espera(n + 1), 5000); };
    setTimeout(() => espera(0), 5000);
  });
  p.onclick = async (e) => {
    const b = e.target.closest("[data-desvincular]"); if (!b) return;
    if (!(await confirmar("Esse computador para de receber tarefas na hora. Para usar de novo, será preciso vincular com um código novo.", { titulo: "Desvincular computador?", textoOk: "Desvincular", perigo: true }))) return;
    await api("/api/robos/" + b.dataset.desvincular, { method: "DELETE" });
    await carregarTarefas(); desenharRobo();
  };
}

// ---------------------------------------------------------------------------
async function iniciarNfae() {
  await iniciarPagina();
  try {
    await Promise.all([carregarCadastros(), carregarTarefas()]);
  } catch (err) {
    notificar("Erro ao carregar: " + err.message, "erro");
  }
  const aba = new URLSearchParams(location.search).get("aba");
  mostrarAba(["emitir", "historico", "cadastros", "robo"].includes(aba) ? aba : "emitir");
  agendarAtualizacao();
}
iniciarNfae();
