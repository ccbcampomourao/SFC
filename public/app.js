// ============================================================================
// Estado em memória (carregado do servidor, editado aqui, salvo no clique de "Salvar")
// ============================================================================
let ESTADO = { grupos: [], checklist: [], parcelamentos: [] };
let GRUPO_ABERTO = null;

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

async function api(caminho, opcoes = {}) {
  const resp = await fetch(caminho, {
    headers: { "Content-Type": "application/json" },
    ...opcoes,
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(dados.erro || "Erro na requisição");
  return dados;
}

// ============================================================================
// LOGIN / SETUP
// ============================================================================
async function iniciar() {
  const { necessario } = await api("/api/setup/necessario");
  if (necessario) {
    $("#login-subtitulo").textContent = "Crie o primeiro acesso do sistema";
    $("#campo-nome-setup").classList.remove("oculto");
    $("#btn-login-submit").textContent = "Criar conta e entrar";
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
  const erroBox = $("#login-erro");
  erroBox.classList.add("oculto");
  try {
    if ($("#form-login").dataset.modo === "setup") {
      await api("/api/setup", { method: "POST", body: JSON.stringify({ username: usuario, password: senha, nome }) });
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
  renderizarGrupos();
  renderizarChecklist();
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
// NAVEGAÇÃO ENTRE ABAS
// ============================================================================
$$(".topo-acoes [data-aba]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const aba = btn.dataset.aba;
    $$(".conteudo").forEach((c) => c.classList.add("oculto"));
    $(`#aba-${aba}`).classList.remove("oculto");
  });
});

$("#busca-empresa").addEventListener("input", (e) => renderizarGrupos(e.target.value.toLowerCase()));

// ============================================================================
// GRUPOS / EMPRESAS
// ============================================================================
function renderizarGrupos(filtro = "") {
  const cont = $("#lista-grupos");
  cont.innerHTML = "";
  ESTADO.grupos.forEach((grupo, gi) => {
    const empresasFiltradas = grupo.empresas.filter((e) => e.nome.toLowerCase().includes(filtro));
    if (filtro && empresasFiltradas.length === 0) return;

    const card = document.createElement("div");
    card.className = "grupo-card";

    const cabecalho = document.createElement("div");
    cabecalho.className = "grupo-cabecalho";
    cabecalho.innerHTML = `
      <h3>${grupo.nome}</h3>
      <span class="contagem">${grupo.empresas.length} empresa(s)</span>
    `;
    cabecalho.addEventListener("click", () => {
      GRUPO_ABERTO = GRUPO_ABERTO === gi ? null : gi;
      renderizarGrupos(filtro);
    });
    card.appendChild(cabecalho);

    if (GRUPO_ABERTO === gi || filtro) {
      const corpo = document.createElement("div");
      corpo.className = "grupo-empresas";

      const btnAdd = document.createElement("button");
      btnAdd.className = "btn-secundario";
      btnAdd.textContent = "+ Empresa";
      btnAdd.style.alignSelf = "flex-start";
      btnAdd.addEventListener("click", () => abrirModalEmpresa(gi, null));
      corpo.appendChild(btnAdd);

      empresasFiltradas.forEach((empresa) => {
        const ei = grupo.empresas.indexOf(empresa);
        const linha = document.createElement("div");
        linha.className = `empresa-linha ${empresa.status === "OK" ? "marcada" : ""}`;
        linha.innerHTML = `
          <button class="botao-status ${empresa.status === "OK" ? "ligado" : ""}" title="Clique para marcar/desmarcar" data-gi="${gi}" data-ei="${ei}"></button>
          <span class="empresa-nome">${empresa.nome}</span>
          <span class="empresa-tags">
            ${empresa.nfs ? '<span class="tag-mini ativa">NFS</span>' : ""}
            ${empresa.nfe ? '<span class="tag-mini ativa">NFE</span>' : ""}
            ${empresa.nfc ? '<span class="tag-mini ativa">NFC</span>' : ""}
            ${empresa.fechado ? '<span class="tag-mini ativa">FECHADO</span>' : ""}
          </span>
        `;
        linha.querySelector(".botao-status").addEventListener("click", (e) => {
          e.stopPropagation();
          empresa.status = empresa.status === "OK" ? "SEM" : "OK";
          renderizarGrupos(filtro);
        });
        linha.addEventListener("click", () => abrirModalEmpresa(gi, ei));
        corpo.appendChild(linha);
      });

      card.appendChild(corpo);
    }
    cont.appendChild(card);
  });
}

$("#btn-novo-grupo").addEventListener("click", () => {
  const nome = prompt("Nome do novo grupo:");
  if (!nome) return;
  ESTADO.grupos.push({ nome, empresas: [] });
  renderizarGrupos();
});

function abrirModalEmpresa(gi, ei) {
  const novo = ei === null;
  const empresa = novo
    ? { nome: "", status: "SEM", nfs: false, nfe: false, nfc: false, fechado: false, cnpj: "", cpf: "", senhaPrefeitura: "", senhaRegularize: "", inscricaoEstadual: "", email: "", comentarios: [], anexos: [] }
    : ESTADO.grupos[gi].empresas[ei];

  const html = `
    <h2>${novo ? "Nova empresa" : empresa.nome}</h2>
    <div class="aba-modal-topo">
      <button class="aba-modal-btn ativa" data-tab="dados">Dados</button>
      <button class="aba-modal-btn" data-tab="comentarios">Comentários</button>
      <button class="aba-modal-btn" data-tab="anexos">Anexos</button>
    </div>

    <div data-painel="dados">
      <div class="campo-form"><label>Nome</label><input id="mp-nome" value="${empresa.nome}"></div>
      <div class="linha-dois-campos">
        <div class="campo-form"><label>CNPJ</label><input id="mp-cnpj" value="${empresa.cnpj}"></div>
        <div class="campo-form"><label>CPF</label><input id="mp-cpf" value="${empresa.cpf}"></div>
      </div>
      <div class="linha-dois-campos">
        <div class="campo-form"><label>Senha Prefeitura</label><input id="mp-senhaPrefeitura" value="${empresa.senhaPrefeitura}"></div>
        <div class="campo-form"><label>Senha Regularize</label><input id="mp-senhaRegularize" value="${empresa.senhaRegularize}"></div>
      </div>
      <div class="linha-dois-campos">
        <div class="campo-form"><label>Inscrição Estadual</label><input id="mp-inscricaoEstadual" value="${empresa.inscricaoEstadual}"></div>
        <div class="campo-form"><label>E-mail</label><input id="mp-email" type="email" value="${empresa.email}"></div>
      </div>
      <div class="campo-form">
        <label>Status</label>
        <button type="button" class="botao-status-grande ${empresa.status === "OK" ? "ligado" : ""}" id="mp-status-toggle">
          ${empresa.status === "OK" ? "✓ Marcada" : "Clique para marcar"}
        </button>
      </div>
      <div class="grade-toggles">
        <label class="toggle-check"><input type="checkbox" id="mp-nfs" ${empresa.nfs ? "checked" : ""}> NFS emitida</label>
        <label class="toggle-check"><input type="checkbox" id="mp-nfe" ${empresa.nfe ? "checked" : ""}> NFE emitida</label>
        <label class="toggle-check"><input type="checkbox" id="mp-nfc" ${empresa.nfc ? "checked" : ""}> NFC emitida</label>
        <label class="toggle-check"><input type="checkbox" id="mp-fechado" ${empresa.fechado ? "checked" : ""}> Fechado</label>
      </div>
      <div class="campo-form">
        <button class="btn-secundario" id="mp-enviar-email" type="button">Enviar e-mail para a empresa</button>
      </div>
    </div>

    <div data-painel="comentarios" class="oculto">
      <div id="mp-lista-comentarios">
        ${empresa.comentarios.map((c) => `<div class="comentario-linha">• ${c}</div>`).join("") || '<p class="comentario-linha">Nenhum comentário ainda.</p>'}
      </div>
      <div class="campo-form" style="margin-top:10px">
        <input id="mp-novo-comentario" placeholder="Escreva um comentário e pressione Enter">
      </div>
    </div>

    <div data-painel="anexos" class="oculto">
      <p class="aviso-fase2">Upload de arquivos ainda não está ligado nesta primeira versão web
        (vai precisar de um bucket Cloudflare R2). Por enquanto os anexos ficam só como lista de nomes.</p>
      <div id="mp-lista-anexos">
        ${empresa.anexos.map((a) => `<div class="comentario-linha">📎 ${a.nome}</div>`).join("") || '<p class="comentario-linha">Nenhum anexo.</p>'}
      </div>
      <div class="campo-form" style="margin-top:10px">
        <input id="mp-novo-anexo" placeholder="Nome do arquivo e pressione Enter">
      </div>
    </div>

    <div class="modal-rodape">
      ${!novo ? '<button class="btn-perigo-outline" id="mp-excluir">Excluir empresa</button>' : ""}
      <button class="btn-ghost" id="mp-cancelar">Cancelar</button>
      <button class="btn-primario" id="mp-salvar">${novo ? "Adicionar" : "Salvar alterações"}</button>
    </div>
  `;
  abrirModal(html);

  let statusAtual = empresa.status;
  $("#mp-status-toggle").addEventListener("click", () => {
    statusAtual = statusAtual === "OK" ? "SEM" : "OK";
    const btn = $("#mp-status-toggle");
    btn.classList.toggle("ligado", statusAtual === "OK");
    btn.textContent = statusAtual === "OK" ? "✓ Marcada" : "Clique para marcar";
  });

  $$(".aba-modal-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".aba-modal-btn").forEach((b) => b.classList.remove("ativa"));
      btn.classList.add("ativa");
      $$("[data-painel]").forEach((p) => p.classList.add("oculto"));
      $(`[data-painel="${btn.dataset.tab}"]`).classList.remove("oculto");
    });
  });

  $("#mp-novo-comentario").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.trim()) {
      empresa.comentarios.push(e.target.value.trim());
      e.target.value = "";
      abrirModalEmpresa(gi, ei);
      $$(".aba-modal-btn")[1].click();
    }
  });
  $("#mp-novo-anexo").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.trim()) {
      empresa.anexos.push({ nome: e.target.value.trim() });
      e.target.value = "";
      abrirModalEmpresa(gi, ei);
      $$(".aba-modal-btn")[2].click();
    }
  });

  $("#mp-enviar-email").addEventListener("click", async () => {
    const destinatario = $("#mp-email").value.trim();
    if (!destinatario) return alert("Preencha o e-mail da empresa primeiro.");
    const assunto = prompt("Assunto do e-mail:", `Aviso - ${empresa.nome}`);
    if (!assunto) return;
    const mensagem = prompt("Mensagem:", "");
    try {
      await api("/api/email", { method: "POST", body: JSON.stringify({ destinatario, assunto, mensagem }) });
      alert("E-mail enviado!");
    } catch (err) {
      alert("Erro ao enviar: " + err.message);
    }
  });

  $("#mp-cancelar").addEventListener("click", fecharModal);
  if (!novo) {
    $("#mp-excluir").addEventListener("click", () => {
      if (!confirm(`Excluir "${empresa.nome}"? Essa ação não pode ser desfeita.`)) return;
      ESTADO.grupos[gi].empresas.splice(ei, 1);
      fecharModal();
      renderizarGrupos();
    });
  }
  $("#mp-salvar").addEventListener("click", () => {
    const atualizada = {
      ...empresa,
      nome: $("#mp-nome").value.trim(),
      cnpj: $("#mp-cnpj").value.trim(),
      cpf: $("#mp-cpf").value.trim(),
      senhaPrefeitura: $("#mp-senhaPrefeitura").value,
      senhaRegularize: $("#mp-senhaRegularize").value,
      inscricaoEstadual: $("#mp-inscricaoEstadual").value.trim(),
      email: $("#mp-email").value.trim(),
      status: statusAtual,
      nfs: $("#mp-nfs").checked,
      nfe: $("#mp-nfe").checked,
      nfc: $("#mp-nfc").checked,
      fechado: $("#mp-fechado").checked,
    };
    if (!atualizada.nome) return alert("Informe o nome da empresa.");
    if (novo) {
      ESTADO.grupos[gi].empresas.push(atualizada);
    } else {
      ESTADO.grupos[gi].empresas[ei] = atualizada;
    }
    fecharModal();
    renderizarGrupos();
  });
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
        <span class="tarefa-texto ${item.concluido ? "feita" : ""}">${item.texto}</span>
        <button class="tarefa-remover" data-i="${i}">×</button>
      </div>
      <div class="tarefa-comentarios">
        ${(item.comentarios || []).map((c) => `<div class="comentario-linha">• ${c}</div>`).join("")}
        <input placeholder="Comentar..." data-i="${i}" class="tarefa-comentario-input">
      </div>
    `;
    cont.appendChild(div);
  });

  $$(".tarefa-check").forEach((chk) =>
    chk.addEventListener("change", (e) => {
      ESTADO.checklist[+e.target.dataset.i].concluido = e.target.checked;
      renderizarChecklist();
    })
  );
  $$(".tarefa-remover").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      ESTADO.checklist.splice(+e.target.dataset.i, 1);
      renderizarChecklist();
    })
  );
  $$(".tarefa-comentario-input").forEach((inp) =>
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.value.trim()) {
        const item = ESTADO.checklist[+e.target.dataset.i];
        item.comentarios = item.comentarios || [];
        item.comentarios.push(e.target.value.trim());
        renderizarChecklist();
      }
    })
  );
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
function renderizarParcelamentos() {
  const cont = $("#lista-parcelamentos");
  cont.innerHTML = "";
  ESTADO.parcelamentos.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "parcelamento-card";
    card.innerHTML = `
      <h4>${p.nome}</h4>
      <div class="parcelamento-status-linha">
        <span class="pill-status ${p.statusAlternancia}">${p.statusAlternancia}</span>
        <span class="pill-status ${p.statusAlternancia2}">${p.statusAlternancia2}</span>
        <span class="pill-status ${p.statusAlternancia3}">${p.statusAlternancia3}</span>
        <span class="pill-status ${p.statusAlternancia4}">${p.statusAlternancia4}</span>
      </div>
      <span class="pill-geral ${p.statusGeral}">${p.statusGeral}</span>
    `;
    card.addEventListener("click", () => abrirModalParcelamento(i));
    cont.appendChild(card);
  });
}

$("#btn-novo-parcelamento").addEventListener("click", () => abrirModalParcelamento(null));

function cicloStatus(atual) {
  return atual === "VAZIO" ? "PENDENTE" : atual === "PENDENTE" ? "OK" : "VAZIO";
}

function abrirModalParcelamento(i) {
  const novo = i === null;
  const p = novo
    ? { nome: "", statusAlternancia: "VAZIO", statusAlternancia2: "VAZIO", statusAlternancia3: "VAZIO", statusAlternancia4: "VAZIO", statusGeral: "SEM", cnpj: "", senhaRegularize: "", comentarios: [], anexos: [] }
    : ESTADO.parcelamentos[i];

  const html = `
    <h2>${novo ? "Novo parcelamento" : p.nome}</h2>
    <div class="campo-form"><label>Nome</label><input id="pp-nome" value="${p.nome}"></div>
    <div class="linha-dois-campos">
      <div class="campo-form"><label>CNPJ</label><input id="pp-cnpj" value="${p.cnpj}"></div>
      <div class="campo-form"><label>Senha Regularize</label><input id="pp-senhaRegularize" value="${p.senhaRegularize}"></div>
    </div>
    <div class="campo-form">
      <label>Status geral</label>
      <select id="pp-statusGeral">
        <option value="SEM" ${p.statusGeral === "SEM" ? "selected" : ""}>Sem status</option>
        <option value="PENDENTE" ${p.statusGeral === "PENDENTE" ? "selected" : ""}>Pendente</option>
        <option value="OK" ${p.statusGeral === "OK" ? "selected" : ""}>OK</option>
      </select>
    </div>
    <p style="font-size:12px;color:var(--texto-suave)">Clique nos status abaixo para alternar: Vazio → Pendente → OK</p>
    <div class="grade-toggles">
      <button type="button" class="toggle-check" id="pp-alt1">Parcela 1: <b>&nbsp;${p.statusAlternancia}</b></button>
      <button type="button" class="toggle-check" id="pp-alt2">Parcela 2: <b>&nbsp;${p.statusAlternancia2}</b></button>
      <button type="button" class="toggle-check" id="pp-alt3">Parcela 3: <b>&nbsp;${p.statusAlternancia3}</b></button>
      <button type="button" class="toggle-check" id="pp-alt4">Parcela 4: <b>&nbsp;${p.statusAlternancia4}</b></button>
    </div>
    <div class="campo-form">
      <label>Comentários</label>
      <div id="pp-lista-comentarios">
        ${p.comentarios.map((c) => `<div class="comentario-linha">• ${c}</div>`).join("") || '<p class="comentario-linha">Nenhum comentário.</p>'}
      </div>
      <input id="pp-novo-comentario" placeholder="Escreva e pressione Enter">
    </div>
    <div class="modal-rodape">
      ${!novo ? '<button class="btn-perigo-outline" id="pp-excluir">Excluir</button>' : ""}
      <button class="btn-ghost" id="pp-cancelar">Cancelar</button>
      <button class="btn-primario" id="pp-salvar">${novo ? "Adicionar" : "Salvar alterações"}</button>
    </div>
  `;
  abrirModal(html);

  const alternar = (campo, btnId) => {
    $(btnId).addEventListener("click", () => {
      p[campo] = cicloStatus(p[campo]);
      abrirModalParcelamento(i);
    });
  };
  alternar("statusAlternancia", "#pp-alt1");
  alternar("statusAlternancia2", "#pp-alt2");
  alternar("statusAlternancia3", "#pp-alt3");
  alternar("statusAlternancia4", "#pp-alt4");

  $("#pp-novo-comentario").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.trim()) {
      p.comentarios.push(e.target.value.trim());
      e.target.value = "";
      abrirModalParcelamento(i);
    }
  });

  $("#pp-cancelar").addEventListener("click", fecharModal);
  if (!novo) {
    $("#pp-excluir").addEventListener("click", () => {
      if (!confirm(`Excluir "${p.nome}"?`)) return;
      ESTADO.parcelamentos.splice(i, 1);
      fecharModal();
      renderizarParcelamentos();
    });
  }
  $("#pp-salvar").addEventListener("click", () => {
    const nome = $("#pp-nome").value.trim();
    if (!nome) return alert("Informe o nome.");
    const atualizado = {
      ...p,
      nome,
      cnpj: $("#pp-cnpj").value.trim(),
      senhaRegularize: $("#pp-senhaRegularize").value,
      statusGeral: $("#pp-statusGeral").value,
    };
    if (novo) ESTADO.parcelamentos.push(atualizado);
    else ESTADO.parcelamentos[i] = atualizado;
    fecharModal();
    renderizarParcelamentos();
  });
}

// ============================================================================
// USUÁRIOS
// ============================================================================
$("#btn-usuarios").addEventListener("click", async () => {
  const { usuarios } = await api("/api/users");
  const html = `
    <h2>Usuários do sistema</h2>
    <div id="lista-usuarios">
      ${usuarios.map((u) => `<div class="comentario-linha">👤 ${u.nome} (${u.username})</div>`).join("")}
    </div>
    <hr style="margin:16px 0;border:none;border-top:1px solid var(--borda)">
    <h3 style="font-size:13px">Adicionar funcionário</h3>
    <div class="campo-form"><label>Nome</label><input id="uu-nome"></div>
    <div class="campo-form"><label>Usuário (login)</label><input id="uu-usuario"></div>
    <div class="campo-form"><label>Senha (mín. 6 caracteres)</label><input id="uu-senha" type="password"></div>
    <div class="modal-rodape">
      <button class="btn-ghost" id="uu-cancelar">Fechar</button>
      <button class="btn-primario" id="uu-salvar">Adicionar</button>
    </div>
  `;
  abrirModal(html);
  $("#uu-cancelar").addEventListener("click", fecharModal);
  $("#uu-salvar").addEventListener("click", async () => {
    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          username: $("#uu-usuario").value.trim(),
          password: $("#uu-senha").value,
          nome: $("#uu-nome").value.trim(),
        }),
      });
      alert("Usuário criado!");
      fecharModal();
    } catch (err) {
      alert(err.message);
    }
  });
});

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
$("#modal-fundo").addEventListener("click", (e) => {
  if (e.target.id === "modal-fundo") fecharModal();
});

iniciar();
