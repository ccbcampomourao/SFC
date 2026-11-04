// ============================================================================
// ficha-empresa.js — "Ficha da empresa": página bonita, com a marca do escritório,
// só com os dados cadastrados na aba Empresas (CNPJ, IE, IM, senhas, sócios...),
// pronta para imprimir ou salvar em PDF. Não consulta nada fora do Prumo.
// ============================================================================
const FICHA_ESCRITORIO = { nome: "FZ CONT", sub: "Contabilidade e Consultoria" };

let _logoFicha = null;
async function logoFichaDataUri() {
  if (_logoFicha !== null) return _logoFicha;
  try {
    const blob = await (await fetch("/img/logo-full.png")).blob();
    _logoFicha = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => ok(""); fr.readAsDataURL(blob); });
  } catch (_) { _logoFicha = ""; }
  return _logoFicha;
}

// Gera direto (sem perguntas): só o que está cadastrado na aba Empresas.
function abrirOpcoesFicha(empresa) { abrirFichaEmpresa(empresa); }

function abrirFichaEmpresa(empresa) {
  // a janela abre na hora do clique (senão o navegador bloqueia) e o conteúdo entra em seguida
  const w = window.open("", "_blank");
  if (!w) return notificar("O navegador bloqueou a janela da ficha. Permita pop-ups para o Prumo e tente de novo.", "aviso");
  w.document.write('<p style="font:14px sans-serif;color:#6E665B;padding:40px">Montando a ficha da empresa…</p>'); w.document.close();
  logoFichaDataUri().then((logo) => {
    try { w.document.open(); w.document.write(htmlFichaEmpresa(empresa, logo)); w.document.close(); }
    catch (err) { w.document.body.innerHTML = `<p style="font:14px sans-serif;color:#B23B29;padding:40px">Não consegui montar a ficha: ${escaparHtml(err.message)}</p>`; }
  });
}

function htmlFichaEmpresa(e, logo) {
  const esc = escaparHtml;
  const doc = (d) => { d = limparDigitos(d); return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4") : d; };
  const hoje = new Date().toLocaleDateString("pt-BR"), hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const campo = (rot, val, cls = "") => `<div class="campo ${cls}"><span>${rot}</span><b>${val ? esc(String(val)) : '<em class="nada">não informado</em>'}</b></div>`;
  const grupo = (ESTADO.grupos || []).find((g) => g.empresas.includes(e));
  const mun = typeof municipioNfse === "function" ? municipioNfse(e) : { nome: "", sistema: "" };
  const sistemas = typeof SISTEMAS_NFSE !== "undefined" ? SISTEMAS_NFSE : {};
  const munTxt = mun && mun.nome ? `${mun.nome}${sistemas[mun.sistema] ? " · " + sistemas[mun.sistema] : ""}` : "";
  const emite = [e.nfs && "NFS-e", e.nfe && "NF-e", e.nfc && "NFC-e"].filter(Boolean);
  const socios = (typeof sociosDe === "function" ? sociosDe(e) : []).filter((s) => s.nome || s.cpf);
  const razao = e.nome;
  const chips = [munTxt && `<span class="chip">${esc(mun.nome)}</span>`, ...emite.map((x) => `<span class="chip">${x}</span>`)].filter(Boolean).join("");
  const temSenha = !!(e.senhaPrefeitura || e.senhaRegularize);
  const op = { senhas: temSenha };

  const secao = (num, titulo, corpo) => `<section class="secao"><h2><span>${num}</span>${titulo}</h2>${corpo}</section>`;
  let n = 0;
  const secoes = [];
  secoes.push(secao(++n, "Identificação", `<div class="grade g2">
    ${campo("CNPJ", doc(e.cnpj))}
    ${campo("Grupo", grupo && grupo.nome)}
    ${campo("Documentos que emite", emite.join(" · "), "largo")}
  </div>`));
  secoes.push(secao(++n, "Contato", `<div class="grade g2">
    ${campo("WhatsApp", e.whatsapp)}
    ${campo("E-mail", e.email)}
  </div>`));
  secoes.push(secao(++n, "Prefeitura e NFS-e", `<div class="grade g2">
    ${campo("Município NFS-e", munTxt)}
    ${campo("Inscrição municipal", e.cadastroMunicipal)}
    ${campo("Série NFS-e", e.nfseSerie)}
    ${campo("Login prefeitura", e.loginPrefeitura || (e.cnpj ? doc(e.cnpj) + " (CNPJ)" : ""))}
    ${campo("Senha prefeitura", e.senhaPrefeitura, "senha largo")}
  </div>`));
  secoes.push(secao(++n, "Estado", `<div class="grade g2">
    ${campo("Inscrição estadual", e.inscricaoEstadual)}
    ${campo("Senha Regularize", e.senhaRegularize, "senha")}
  </div>`));
  secoes.push(secao(++n, "Sócios", socios.length ? `<table><thead><tr><th>Nome</th><th>CPF</th></tr></thead><tbody>
    ${socios.map((s) => `<tr><td>${esc(s.nome || "—")}</td><td class="mono">${esc(doc(s.cpf) || "—")}</td></tr>`).join("")}</tbody></table>` : '<p class="vazio">Nenhum sócio cadastrado.</p>'));

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Ficha da empresa — ${esc(e.nome)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  :root { --tinta:#16202E; --cobre:#B4532A; --cobre2:#E3955C; --marfim:#F3EFE7; --linha:#E6DFD3; --suave:#6E665B; --fraco:#9C9285;
          --verde:#3E6B37; --verdebg:#E6EEDF; --verm:#B23B29; --vermbg:#F6E2DA; --amar:#8A5A12; --amarbg:#F7EBD3; --roxo:#6A5A93; --roxobg:#ECE8F4; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; background: #E9E4DA; font: 13px/1.45 "IBM Plex Sans", "Segoe UI", Arial, sans-serif; color: #241F1A; }
  .barra-acoes { position: sticky; top: 0; z-index: 5; display: flex; justify-content: flex-end; gap: 8px; padding: 10px 24px; background: rgba(233,228,218,.92); backdrop-filter: blur(6px); }
  .barra-acoes button { font-family: inherit; font-weight: 600; font-size: 13px; padding: 9px 16px; border-radius: 9px; border: 1px solid #D6CCBC; background: #fff; color: var(--tinta); cursor: pointer; }
  .barra-acoes button.pri { background: var(--cobre); border-color: var(--cobre); color: #fff; }
  .folha { max-width: 920px; margin: 0 auto 40px; background: #fff; box-shadow: 0 10px 40px rgba(29,26,22,.12); border-radius: 14px; overflow: hidden; }
  .capa { background: radial-gradient(120% 140% at 100% 0%, #2B3B58 0%, var(--tinta) 55%); color: #fff; padding: 28px 40px 26px; position: relative; }
  .capa::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: linear-gradient(90deg, var(--cobre), var(--cobre2)); }
  .capa-topo { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
  .escritorio { display: flex; align-items: center; gap: 14px; }
  .logo-esc { flex: none; display: grid; place-items: center; width: 60px; height: 60px; background: #fff; border-radius: 12px; padding: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
  .logo-esc img { max-width: 100%; max-height: 100%; display: block; }
  .escritorio b { display: block; font: 600 22px/1.1 "Fraunces", Georgia, serif; letter-spacing: .02em; }
  .escritorio span { display: block; font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--cobre2); margin-top: 3px; }
  .capa-data { text-align: right; font-size: 12px; color: #C9BFAE; } .capa-data b { display: block; color: #fff; font-size: 13px; }
  .rotulo { margin: 22px 0 0; font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: var(--cobre2); font-weight: 600; }
  .capa h1 { font: 600 28px/1.15 "Fraunces", Georgia, serif; margin: 4px 0 6px; letter-spacing: -.01em; }
  .capa .cnpj { font-family: "IBM Plex Mono", monospace; color: #E8E1D5; font-size: 14px; }
  .capa .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 14px; }
  .capa .chip { background: rgba(255,255,255,.1); color: #fff; border: 1px solid rgba(255,255,255,.18); }
  .capa .chip.ok { background: #2F5A2A; border-color: #4E8446; } .capa .chip.erro { background: #7E2A1E; border-color: #A84432; }
  .conteudo { padding: 24px 40px 30px; }
  .secao { margin-bottom: 22px; break-inside: avoid; page-break-inside: avoid; }
  .secao h2 { display: flex; align-items: center; gap: 10px; font: 600 16px "Fraunces", Georgia, serif; color: var(--tinta); margin: 0 0 10px; padding-bottom: 8px; border-bottom: 1.5px solid var(--tinta); }
  .secao h2 span { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 99px; background: var(--cobre); color: #fff; font: 700 11px "IBM Plex Sans", sans-serif; }
  .grade { display: grid; gap: 0; background: #FBF9F5; border: 1px solid var(--linha); border-radius: 9px; overflow: hidden; }
  .grade.g2 { grid-template-columns: repeat(2, 1fr); }
  .campo { background: #FBF9F5; padding: 9px 12px; min-width: 0; border-left: 1px solid var(--linha); border-top: 1px solid var(--linha); margin: -1px 0 0 -1px; }
  .campo.largo { grid-column: 1 / -1; }
  .campo span { display: block; font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--fraco); font-weight: 600; }
  .campo b { display: block; font-size: 13px; font-weight: 600; color: #241F1A; margin-top: 2px; overflow-wrap: anywhere; }
  .campo.senha { background: #FFF7EE; } .campo.senha b { font-family: "IBM Plex Mono", monospace; color: var(--cobre); }
  .nada { font-style: normal; font-weight: 400; color: var(--fraco); }
  .chip { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; background: var(--marfim); color: var(--suave); white-space: nowrap; }
  .chip.ok { background: var(--verdebg); color: var(--verde); } .chip.erro { background: var(--vermbg); color: var(--verm); } .chip.aviso { background: var(--amarbg); color: var(--amar); }
  .chip.roxo { background: var(--roxobg); color: var(--roxo); } .chip.escuro { background: var(--tinta); color: #fff; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-row-group; }
  th { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--suave); text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--linha); background: #FBF9F5; }
  td { padding: 8px 10px; border-bottom: 1px solid var(--linha); vertical-align: top; }
  td small { display: block; color: var(--fraco); font-size: 11px; }
  tr { break-inside: avoid; }
  .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .mono { font-family: "IBM Plex Mono", monospace; font-size: 12px; }
  .orgao { font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; padding: 3px 8px; border-radius: 6px; background: #F6E8DD; color: #96421E; }
  .mini-kpis { display: flex; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
  .mini-kpis > div { flex: 1; min-width: 150px; background: var(--marfim); border-radius: 9px; padding: 9px 12px; }
  .mini-kpis span { display: block; font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--fraco); font-weight: 600; }
  .mini-kpis b { font-size: 15px; color: var(--tinta); font-variant-numeric: tabular-nums; } .mini-kpis b small { font-size: 11px; color: var(--suave); font-weight: 500; }
  .comentarios, .docs { list-style: none; margin: 0; padding: 0; }
  .comentarios li { border-left: 3px solid var(--cobre2); background: #FBF9F5; border-radius: 0 8px 8px 0; padding: 8px 12px; margin-bottom: 6px; break-inside: avoid; }
  .comentarios p { margin: 0; } .comentarios small { color: var(--fraco); font-size: 11px; }
  .docs { columns: 2; column-gap: 18px; } .docs li { padding: 5px 0 5px 18px; position: relative; border-bottom: 1px dashed var(--linha); break-inside: avoid; overflow-wrap: anywhere; }
  .docs li::before { content: ""; position: absolute; left: 2px; top: 10px; width: 8px; height: 10px; border: 1.5px solid var(--cobre); border-radius: 2px; }
  .vazio { margin: 0; padding: 12px 14px; background: #FBF9F5; border-radius: 9px; color: var(--fraco); }
  .obs { margin: 8px 0 0; font-size: 11.5px; color: var(--suave); }
  .aviso-conf { margin: 0 0 18px; padding: 10px 14px; border-radius: 9px; background: var(--vermbg); color: var(--verm); font-weight: 600; font-size: 12px; }
  .rodape { break-inside: avoid; display: flex; justify-content: space-between; padding: 12px 40px; border-top: 1px solid var(--linha); font-size: 11px; color: var(--fraco); }
  @page { size: A4; margin: 10mm; }
  @media print {
    body { background: #fff; } .barra-acoes { display: none; }
    .folha { max-width: none; margin: 0; box-shadow: none; border-radius: 0; }
    .capa, .conteudo, .rodape { padding-left: 6mm; padding-right: 6mm; }
    .capa { padding-top: 14px; padding-bottom: 14px; } .capa h1 { font-size: 22px; } .rotulo { margin-top: 14px; }
    .conteudo { padding-top: 16px; padding-bottom: 12px; } .secao { margin-bottom: 14px; } .secao h2 { margin-bottom: 8px; padding-bottom: 6px; }
    .campo { padding: 7px 12px; } .aviso-conf { margin-bottom: 12px; padding: 8px 12px; } td { padding: 6px 10px; }
  }
  @media (max-width: 760px) { .capa, .conteudo { padding: 22px; } .docs { columns: 1; } }
</style></head><body>
<div class="barra-acoes"><button onclick="window.close()">Fechar</button><button class="pri" onclick="window.print()">Imprimir / salvar PDF</button></div>
<div class="folha">
  <div class="capa">
    <div class="capa-topo"><div class="escritorio">${logo ? `<div class="logo-esc"><img src="${logo}" alt="${esc(FICHA_ESCRITORIO.nome)}"></div>` : ""}<div><b>${esc(FICHA_ESCRITORIO.nome)}</b><span>${esc(FICHA_ESCRITORIO.sub)}</span></div></div>
      <div class="capa-data">Gerado em<b>${hoje} às ${hora}</b></div></div>
    <p class="rotulo">Ficha cadastral da empresa</p>
    <h1>${esc(razao)}</h1>
    <div class="cnpj">CNPJ ${esc(doc(e.cnpj) || "—")}</div>
    ${chips ? `<div class="chips">${chips}</div>` : ""}
  </div>
  <div class="conteudo">
    ${op.senhas ? '<p class="aviso-conf">Documento confidencial: contém senhas de acesso. Não envie a terceiros.</p>' : ""}
    ${secoes.join("")}
  </div>
  <div class="rodape"><span>${esc(FICHA_ESCRITORIO.nome)} · ${esc(FICHA_ESCRITORIO.sub)}</span><span>Ficha da empresa · ${hoje}${op.senhas ? " · CONFIDENCIAL" : ""}</span></div>
</div></body></html>`;
}
