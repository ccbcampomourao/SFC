// ============================================================================
// login.js — lógica da tela de login/cadastro (index.html)
// ============================================================================
let _tokenRedefinicao = null;
async function iniciarLogin() {
  // Link do e-mail "criar nova senha": /?redefinir=<token>
  const token = new URLSearchParams(location.search).get("redefinir");
  if (token) {
    _tokenRedefinicao = token;
    const r = await api("/api/auth/redefinir?token=" + encodeURIComponent(token)).catch(() => ({ valido: false }));
    if (r.valido) { alternarModoLogin("redefinir"); $("#login-nova-senha").focus(); return; }
    history.replaceState(null, "", "/");
    alternarModoLogin("recuperar");
    mostrarMensagemLogin("Esse link de nova senha expirou ou já foi usado. Peça outro abaixo.", false);
    return;
  }
  const sessao = await api("/api/session").catch(() => ({ logado: false }));
  if (sessao.logado) return location.replace("/empresas.html");
  // "Criar conta" só aparece no primeiro acesso (sistema ainda sem nenhum usuário)
  const { cadastroAberto } = await api("/api/auth/pode-cadastrar").catch(() => ({ cadastroAberto: false }));
  const abas = $("#tabs-login");
  if (abas) abas.hidden = !cadastroAberto;
}

function alternarModoLogin(modo) {
  $("#form-login").dataset.modo = modo;
  $$(".tab-login-btn").forEach((b) => b.classList.toggle("ativa", b.dataset.modo === modo));
  $("#login-erro").classList.add("oculto");
  $("#form-login").reset();
  const ver = (sel, sim) => $(sel).classList.toggle("oculto", !sim);
  const cadastro = modo === "cadastro", recuperar = modo === "recuperar", redefinir = modo === "redefinir";
  ver("#campo-nome-setup", cadastro);
  ver("#campo-email-setup", cadastro);
  ver("#campo-usuario", !redefinir);
  ver("#campo-senha", !recuperar && !redefinir);
  ver("#campo-nova-senha", redefinir);
  ver("#campo-confirma-senha", redefinir);
  $("#login-email").required = cadastro;
  $("#login-usuario").required = !redefinir;
  $("#login-senha").required = !recuperar && !redefinir;
  $("#login-nova-senha").required = redefinir;
  $("#login-confirma-senha").required = redefinir;
  $("#login-senha").autocomplete = cadastro ? "new-password" : "current-password";
  $("#rotulo-usuario").textContent = recuperar ? "Usuário ou e-mail" : "Usuário";
  $("#btn-esqueci").textContent = recuperar || redefinir ? "Voltar para o login" : "Esqueci minha senha";
  $("#btn-esqueci").classList.toggle("oculto", cadastro);
  const textos = {
    cadastro: ["Criar conta", "Você vai receber um link de confirmação no e-mail", "Criar conta"],
    recuperar: ["Esqueci minha senha", "Informe seu usuário ou e-mail. Vamos mandar um link para você criar uma senha nova.", "Enviar link"],
    redefinir: ["Criar nova senha", "Escolha uma senha nova com pelo menos 8 caracteres.", "Salvar nova senha"],
    login: ["Bem-vindo de volta", "Entre com seu usuário e senha", "Entrar"],
  }[modo] || [];
  $("#login-titulo").textContent = textos[0];
  $("#login-subtitulo").textContent = textos[1];
  $("#btn-login-submit").innerHTML = `<span>${textos[2]}</span>`;
}
$("#btn-esqueci").addEventListener("click", () => {
  const modo = $("#form-login").dataset.modo;
  if (modo === "redefinir") history.replaceState(null, "", "/");
  alternarModoLogin(modo === "login" ? "recuperar" : "login");
  $("#login-usuario").focus();
});

function mostrarMensagemLogin(texto, ok) {
  const box = $("#login-erro");
  box.className = ok ? "mensagem-sucesso" : "mensagem-erro";
  box.textContent = texto;
}

$$(".tab-login-btn").forEach((btn) => btn.addEventListener("click", () => alternarModoLogin(btn.dataset.modo)));

$("#form-login").addEventListener("submit", (e) => {
  e.preventDefault();
  comCarregando($("#btn-login-submit"), enviarFormularioLogin);
});

async function enviarFormularioLogin() {
  const usuario = $("#login-usuario").value.trim();
  const senha = $("#login-senha").value;
  const nome = $("#login-nome").value.trim();
  const email = $("#login-email").value.trim();
  const erroBox = $("#login-erro");
  erroBox.classList.remove("mensagem-sucesso");
  erroBox.classList.add("mensagem-erro");
  erroBox.classList.add("oculto");
  try {
    const modo = $("#form-login").dataset.modo;
    if (modo === "recuperar") {
      const r = await api("/api/auth/esqueci", { method: "POST", body: JSON.stringify({ identificador: usuario }) });
      return mostrarMensagemLogin(r.mensagem, true);
    }
    if (modo === "redefinir") {
      const nova = $("#login-nova-senha").value, conf = $("#login-confirma-senha").value;
      if (nova !== conf) return mostrarMensagemLogin("As duas senhas não são iguais.", false);
      const r = await api("/api/auth/redefinir", { method: "POST", body: JSON.stringify({ token: _tokenRedefinicao, senha: nova }) });
      history.replaceState(null, "", "/");
      alternarModoLogin("login");
      $("#login-usuario").value = r.usuario || "";
      mostrarMensagemLogin("Senha nova salva! Entre com ela agora.", true);
      $("#login-senha").focus();
      return;
    }
    if (modo === "cadastro") {
      const resp = await api("/api/auth/cadastro", { method: "POST", body: JSON.stringify({ username: usuario, password: senha, nome, email }) });
      erroBox.classList.remove("mensagem-erro");
      erroBox.classList.add("mensagem-sucesso");
      erroBox.textContent = resp.emailFalhou
        ? `Conta criada, mas não consegui enviar o e-mail de confirmação (${resp.erroEmail}). Avise o administrador para configurar o Gmail no servidor.`
        : `Conta criada! Enviamos um link de confirmação para ${email}. Abra seu e-mail (e o spam) e clique no link antes de entrar.`;
      erroBox.classList.remove("oculto");
      alternarModoLogin("login");
      return;
    }
    await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: usuario, password: senha }) });
    location.replace("/empresas.html");
  } catch (err) {
    if (err.naoConfirmado) {
      mostrarAvisoNaoConfirmado(usuario, err.temEmail);
      return;
    }
    erroBox.textContent = err.message;
    erroBox.classList.remove("oculto");
  }
}

function mostrarAvisoNaoConfirmado(usuario, temEmail) {
  const erroBox = $("#login-erro");
  erroBox.classList.remove("mensagem-erro");
  erroBox.classList.add("mensagem-sucesso");
  erroBox.innerHTML = temEmail
    ? `Essa conta ainda não foi confirmada. Confira seu e-mail (e o spam) ou <button type="button" id="btn-reenviar-conf" class="btn-secundario btn-sm" style="margin-top:8px">Reenviar link de confirmação</button>`
    : `Essa conta não tem e-mail cadastrado ainda. Informe um e-mail para receber o link:
       <div class="form-inline" style="margin-top:8px">
         <input type="email" id="reenvio-email" placeholder="seu@email.com">
         <button type="button" id="btn-reenviar-conf" class="btn-secundario">Enviar</button>
       </div>`;
  erroBox.classList.remove("oculto");

  $("#btn-reenviar-conf").addEventListener("click", (ev) => comCarregando(ev.currentTarget, async () => {
    const email = temEmail ? undefined : $("#reenvio-email").value.trim();
    if (!temEmail && !email) return;
    try {
      const resp = await api("/api/auth/reenviar-confirmacao", { method: "POST", body: JSON.stringify({ username: usuario, email }) });
      erroBox.innerHTML = resp.emailFalhou
        ? `Não consegui enviar o e-mail (${resp.erroEmail}). Avise o administrador.`
        : "Link de confirmação reenviado! Confira seu e-mail (e o spam).";
    } catch (err) {
      erroBox.textContent = err.message;
    }
  }));
}

iniciarLogin();

// ============================================================================
// Prumo da tela de login: reage ao mouse (inclina de leve na direção do cursor,
// balança quando o cursor "esbarra" nele e pode ser puxado e solto).
// Leve: só calcula enquanto está se mexendo; parado, não gasta nada.
// ============================================================================
(function prumoInterativo() {
  const prumo = document.querySelector(".hero-prumo");
  const painel = document.querySelector(".painel-hero");
  if (!prumo || !painel) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  const peso = prumo.querySelector("img");

  let ang = 0, vel = 0, alvo = 0;       // graus, graus/s, ângulo para onde ele "quer" ir
  let ativo = false, ultimo = 0, quadro = 0, arrastando = null;
  let mouseX = 0, mouseT = 0;
  const MAX_INCLINA = 7, MAX_ANG = 38;

  const pivo = () => { const r = prumo.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top }; };
  const centroPeso = () => { const r = peso.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.55 }; };
  const desenhar = () => { prumo.style.transform = `rotate(${ang.toFixed(2)}deg)`; };

  function passo(t) {
    const dt = Math.min(0.033, (t - (ultimo || t)) / 1000) || 0.016;
    ultimo = t;
    if (!arrastando) {
      // mola amortecida: volta para o alvo balançando cada vez menos
      const acel = -38 * (ang - alvo) - 2.6 * vel;
      vel += acel * dt;
      ang += vel * dt;
    }
    desenhar();
    if (arrastando || Math.abs(vel) > 0.05 || Math.abs(ang - alvo) > 0.05) quadro = requestAnimationFrame(passo);
    else { ativo = false; ultimo = 0; ang = alvo; desenhar(); }
  }
  function acordar() { if (!ativo && document.visibilityState === "visible") { ativo = true; ultimo = 0; quadro = requestAnimationFrame(passo); } }

  // o balanço de entrada (CSS) termina e o JS assume dali em diante
  const assumir = () => { prumo.style.animation = "none"; desenhar(); };
  prumo.addEventListener("animationend", assumir, { once: true });
  setTimeout(assumir, 4200); // garantia, caso o evento não chegue

  painel.addEventListener("pointermove", (e) => {
    if (arrastando) return;
    const p = pivo();
    // inclina um pouco na direção do cursor, como se fosse atraído
    const graus = -Math.atan2(e.clientX - p.x, Math.max(80, e.clientY - p.y)) * 180 / Math.PI;
    alvo = Math.max(-MAX_INCLINA, Math.min(MAX_INCLINA, graus * 0.22));
    // esbarrão: cursor rápido passando perto do peso dá um empurrão
    const agora = performance.now();
    const vx = mouseT ? (e.clientX - mouseX) / Math.max(1, agora - mouseT) : 0; // px/ms
    mouseX = e.clientX; mouseT = agora;
    const c = centroPeso();
    if (Math.hypot(e.clientX - c.x, e.clientY - c.y) < 70 && Math.abs(vx) > 0.25) vel -= Math.max(-90, Math.min(90, vx * 55));
    acordar();
  });
  painel.addEventListener("pointerleave", () => { if (!arrastando) { alvo = 0; mouseT = 0; acordar(); } });

  // puxar e soltar o peso
  peso.style.pointerEvents = "auto";
  peso.style.cursor = "grab";
  peso.draggable = false;
  peso.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    peso.setPointerCapture(e.pointerId);
    arrastando = { ultimoAng: ang, ultimoT: performance.now() };
    peso.style.cursor = "grabbing";
    acordar();
  });
  peso.addEventListener("pointermove", (e) => {
    if (!arrastando) return;
    const p = pivo();
    const novo = Math.max(-MAX_ANG, Math.min(MAX_ANG, -Math.atan2(e.clientX - p.x, Math.max(40, e.clientY - p.y)) * 180 / Math.PI));
    const agora = performance.now();
    const dt = Math.max(8, agora - arrastando.ultimoT) / 1000;
    vel = (novo - arrastando.ultimoAng) / dt;        // velocidade do arraste vira o impulso ao soltar
    arrastando.ultimoAng = novo; arrastando.ultimoT = agora;
    ang = novo;
  });
  const soltar = () => {
    if (!arrastando) return;
    arrastando = null;
    vel = Math.max(-260, Math.min(260, vel));
    peso.style.cursor = "grab";
    alvo = 0;
    acordar();
  };
  peso.addEventListener("pointerup", soltar);
  peso.addEventListener("pointercancel", soltar);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "visible") { cancelAnimationFrame(quadro); ativo = false; } });
})();
