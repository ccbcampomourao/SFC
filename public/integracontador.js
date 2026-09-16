// ============================================================================
// integracontador.js — página do IntegraContador (SERPRO): certificado,
// seleção de empresas e download de relatórios (Situação Fiscal / CND)
// ============================================================================

function renderizarPagina() {
  carregarStatusIntegraContador();
  renderizarListaEmpresasIC();
  renderizarRelatoriosSalvos();
}

// ---------------------------------------------------------------------------
// CERTIFICADO DIGITAL (.pfx lido no navegador com node-forge; nunca sobe o
// arquivo original nem a senha — só o certificado/chave já convertidos)
// ---------------------------------------------------------------------------
async function carregarStatusIntegraContador() {
  const box = $("#certificado-status");
  try {
    const status = await api("/api/integracontador/status");
    box.innerHTML = `
      <div class="ic-linha-status">${status.certificadoConfigurado ? "✅" : "⚠️"} Certificado digital: ${status.certificadoConfigurado ? "configurado" : "não configurado"}</div>
      <div class="ic-linha-status">${status.sitfisConfigurado ? "✅" : "⚠️"} Situação Fiscal (SITFIS): ${status.sitfisConfigurado ? "pronto" : "faltam credenciais (Consumer Key/Secret + CNPJ do escritório)"}</div>
      <div class="ic-linha-status">${status.cndConfigurado ? "✅" : "⚠️"} CND: ${status.cndConfigurado ? "pronto" : "faltam credenciais (Consumer Key/Secret)"}</div>
      <button class="btn-secundario" id="btn-config-certificado" style="margin-top:10px;align-self:flex-start;">🔐 Configurar certificado (.pfx)</button>
      <button class="btn-secundario" id="btn-testar-cf" style="margin-top:6px;align-self:flex-start;">🧪 Testar credenciais Cloudflare</button>
      <div id="teste-cf-resultado" class="oculto" style="margin-top:8px;white-space:pre-wrap;"></div>
    `;
    $("#btn-config-certificado").addEventListener("click", abrirModalCertificado);
    $("#btn-testar-cf").addEventListener("click", async () => {
      const cx = $("#teste-cf-resultado");
      cx.className = "mensagem-sucesso";
      cx.textContent = "Testando...";
      try {
        const r = await api("/api/integracontador/testar-credenciais-cf");
        if (r.ok) {
          cx.className = "mensagem-sucesso";
          cx.textContent = "✅ " + r.mensagem;
        } else {
          cx.className = "mensagem-erro";
          cx.textContent = "❌ " + r.erro + (r.detalhe ? "\n\nDetalhe técnico: " + r.detalhe : "");
        }
      } catch (err) {
        cx.className = "mensagem-erro";
        cx.textContent = "❌ " + err.message;
      }
    });
  } catch (err) {
    box.textContent = "Erro ao carregar status: " + err.message;
  }
}

function arrayBufferParaStringBinaria(buf) {
  const bytes = new Uint8Array(buf);
  let binario = "";
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + passo));
  }
  return binario;
}

async function extrairCertificadoDoPfx(arquivo, senha) {
  const buf = await arquivo.arrayBuffer();
  const binario = arrayBufferParaStringBinaria(buf);
  const p12Asn1 = forge.asn1.fromDer(binario);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
  let keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag];
  if (!keyBags || !keyBags.length) keyBags = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag];

  if (!certBags || !certBags.length || !keyBags || !keyBags.length) {
    throw new Error("Não consegui ler o certificado ou a chave privada do arquivo. Confira a senha.");
  }
  return {
    certPem: forge.pki.certificateToPem(certBags[0].cert),
    keyPem: forge.pki.privateKeyToPem(keyBags[0].key),
  };
}

function abrirModalCertificado() {
  const html = `
    <h2>Configurar certificado digital</h2>
    <p style="font-size:12.5px;color:var(--ink-soft);margin-top:-6px;">
      O arquivo .pfx é lido aqui no seu navegador — só o certificado convertido é enviado pro servidor (nunca o arquivo original nem a senha).
    </p>
    <div class="campo-form"><label>Arquivo .pfx / .p12</label><input type="file" id="cert-arquivo" accept=".pfx,.p12"></div>
    <div class="campo-form"><label>Senha do certificado</label><input type="password" id="cert-senha"></div>
    <div id="cert-status" class="mensagem-erro oculto" style="white-space:pre-wrap;"></div>
    <div class="modal-rodape">
      <button class="btn-ghost" id="cert-cancelar">Cancelar</button>
      <button class="btn-primario" id="cert-enviar">Enviar</button>
    </div>
  `;
  abrirModal(html);
  $("#cert-cancelar").addEventListener("click", fecharModal);
  $("#cert-enviar").addEventListener("click", async () => {
    const arquivo = $("#cert-arquivo").files[0];
    const senha = $("#cert-senha").value;
    const status = $("#cert-status");
    status.classList.remove("oculto", "mensagem-erro", "mensagem-sucesso");

    if (!arquivo) {
      status.classList.add("mensagem-erro");
      status.textContent = "Selecione o arquivo .pfx.";
      return;
    }
    try {
      status.classList.add("mensagem-sucesso");
      status.textContent = "Lendo o certificado no navegador...";
      const { certPem, keyPem } = await extrairCertificadoDoPfx(arquivo, senha);
      status.textContent = "Enviando para a Cloudflare...";
      const resp = await api("/api/integracontador/certificado", {
        method: "POST",
        body: JSON.stringify({ certPem, keyPem, nome: "serpro-integracontador" }),
      });
      status.textContent =
        `✅ Certificado enviado! ID: ${resp.certificateId}\n\n` +
        `Falta um último passo: abra o wrangler.toml no GitHub, descomente o bloco [[mtls_certificates]] ` +
        `perto do fim do arquivo, cole esse ID no lugar de COLE_AQUI_O_CERTIFICATE_ID, e salve. ` +
        `O deploy roda sozinho a partir daí.`;
    } catch (err) {
      status.classList.remove("mensagem-sucesso");
      status.classList.add("mensagem-erro");
      status.textContent = "Erro: " + err.message;
    }
  });
}

// ---------------------------------------------------------------------------
// RELATÓRIOS SALVOS (área própria do IntegraContador — sempre a versão mais
// recente por empresa+serviço, sobrescrita automaticamente ao baixar de novo)
// ---------------------------------------------------------------------------
const ROTULO_SERVICO = { sitfis: "Situação Fiscal", cnd: "CND" };

function formatarDataHora(iso) {
  try {
    return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

async function renderizarRelatoriosSalvos() {
  const cont = $("#lista-relatorios-salvos");
  if (!cont) return;
  let relatorios = {};
  try {
    ({ relatorios } = await api("/api/integracontador/relatorios"));
  } catch (err) {
    cont.innerHTML = `<p class="comentario-linha">Erro ao carregar: ${escaparHtml(err.message)}</p>`;
    return;
  }

  const cnpjs = Object.keys(relatorios).filter((c) => relatorios[c].sitfis || relatorios[c].cnd);
  cont.innerHTML = "";
  if (cnpjs.length === 0) {
    cont.innerHTML = '<p class="comentario-linha">Nenhum relatório baixado ainda. Selecione empresas e serviços acima e clique em "Baixar selecionados".</p>';
    return;
  }

  cnpjs.forEach((cnpj) => {
    const item = relatorios[cnpj];
    const card = document.createElement("div");
    card.className = "ic-relatorio-card ic-surgir";
    const nomeEmpresa = item.nomeEmpresa || cnpj;

    const linhaServico = (chave) => {
      const info = item[chave];
      if (!info) return "";
      return `
        <div class="ic-relatorio-linha">
          <div>
            <div class="ic-relatorio-servico">${ROTULO_SERVICO[chave]}</div>
            <div class="ic-relatorio-data">Atualizado em ${formatarDataHora(info.atualizadoEm)}</div>
          </div>
          <div class="ic-relatorio-acoes">
            <button type="button" class="btn-icone" data-baixar="${chave}" data-cnpj="${cnpj}" title="Baixar">⬇️</button>
            <button type="button" class="btn-icone" data-apagar="${chave}" data-cnpj="${cnpj}" title="Apagar">🗑</button>
          </div>
        </div>
      `;
    };

    card.innerHTML = `
      <span class="ic-relatorio-empresa">🏢 ${escaparHtml(nomeEmpresa)}</span>
      ${linhaServico("sitfis")}
      ${linhaServico("cnd")}
    `;
    cont.appendChild(card);
  });

  cont.querySelectorAll("[data-baixar]").forEach((btn) => {
    btn.addEventListener("click", () => window.open(`/api/integracontador/arquivo/${btn.dataset.baixar}/${btn.dataset.cnpj}`, "_blank"));
  });
  cont.querySelectorAll("[data-apagar]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Apagar esse relatório salvo?")) return;
      try {
        await api(`/api/integracontador/arquivo/${btn.dataset.apagar}/${btn.dataset.cnpj}`, { method: "DELETE" });
        renderizarRelatoriosSalvos();
      } catch (err) {
        alert("Erro ao apagar: " + err.message);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// SELEÇÃO DE EMPRESAS
// ---------------------------------------------------------------------------
function todasEmpresasComCnpj() {
  const lista = [];
  ESTADO.grupos.forEach((g) => g.empresas.forEach((e) => { if (e.cnpj) lista.push(e); }));
  return lista;
}

function renderizarListaEmpresasIC() {
  const cont = $("#lista-empresas-ic");
  cont.innerHTML = "";
  const empresas = todasEmpresasComCnpj();
  if (empresas.length === 0) {
    cont.innerHTML = '<p class="comentario-linha">Nenhuma empresa com CNPJ cadastrado ainda. Cadastre em "Empresas" primeiro.</p>';
    return;
  }
  empresas.forEach((e) => {
    const linha = document.createElement("label");
    linha.className = "ic-empresa-item";
    linha.innerHTML = `
      <input type="checkbox" class="ic-empresa-check" data-cnpj="${e.cnpj}" checked>
      <span class="ic-empresa-nome">${escaparHtml(e.nome)}</span>
      <span class="ic-empresa-cnpj">${e.cnpj}</span>
    `;
    cont.appendChild(linha);
  });
}

$("#btn-marcar-todas")?.addEventListener("click", () => $$(".ic-empresa-check").forEach((c) => (c.checked = true)));
$("#btn-desmarcar-todas")?.addEventListener("click", () => $$(".ic-empresa-check").forEach((c) => (c.checked = false)));

// ---------------------------------------------------------------------------
// BAIXAR SELECIONADOS
// ---------------------------------------------------------------------------
function baixarBase64ComoArquivo(base64, nomeArquivo) {
  const link = document.createElement("a");
  link.href = `data:application/pdf;base64,${base64}`;
  link.download = nomeArquivo;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

$("#btn-baixar-selecionados")?.addEventListener("click", async () => {
  const empresasSelecionadas = $$(".ic-empresa-check:checked").map((c) => ({
    cnpj: c.dataset.cnpj,
    nome: c.closest(".ic-empresa-item").querySelector(".ic-empresa-nome").textContent,
  }));
  if (!empresasSelecionadas.length) return alert("Selecione pelo menos uma empresa.");

  const servicos = [];
  if ($("#svc-sitfis").checked) servicos.push({ chave: "sitfis", rotulo: "Situação Fiscal", endpoint: "/api/integracontador/sitfis" });
  if ($("#svc-cnd").checked) servicos.push({ chave: "cnd", rotulo: "CND", endpoint: "/api/integracontador/cnd" });
  if (!servicos.length) return alert("Selecione pelo menos um serviço.");

  const cont = $("#resultado-ic");
  cont.innerHTML = "";
  const linhas = {};
  empresasSelecionadas.forEach((emp) => {
    servicos.forEach((svc) => {
      const id = `${emp.cnpj}-${svc.chave}`;
      const linha = document.createElement("div");
      linha.className = "ic-resultado-item ic-surgir";
      linha.innerHTML = `<span>${escaparHtml(emp.nome)} — ${svc.rotulo}</span><span class="ic-badge ic-badge-aguardando">Aguardando</span>`;
      cont.appendChild(linha);
      linhas[id] = linha;
    });
  });

  for (const emp of empresasSelecionadas) {
    for (const svc of servicos) {
      const id = `${emp.cnpj}-${svc.chave}`;
      const badge = linhas[id].querySelector(".ic-badge");
      badge.textContent = "Baixando...";
      badge.className = "ic-badge ic-badge-baixando";
      try {
        const resp = await api(svc.endpoint, { method: "POST", body: JSON.stringify({ cnpj: emp.cnpj, nomeEmpresa: emp.nome }) });
        if (resp.ok && resp.pdfBase64) {
          baixarBase64ComoArquivo(resp.pdfBase64, resp.nomeArquivo || `${svc.rotulo}-${emp.cnpj}.pdf`);
          badge.textContent = "✅ Baixado";
          badge.className = "ic-badge ic-badge-ok";
        } else {
          badge.textContent = "❌ Erro";
          badge.className = "ic-badge ic-badge-erro";
          badge.title = resp.erro || "Erro desconhecido";
        }
      } catch (err) {
        badge.textContent = "❌ Erro";
        badge.className = "ic-badge ic-badge-erro";
        badge.title = err.message;
      }
    }
  }

  renderizarRelatoriosSalvos();
});

iniciarPagina();
