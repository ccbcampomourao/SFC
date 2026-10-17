// ============================================================================
// login.js — lógica da tela de login/cadastro (index.html)
// ============================================================================
async function iniciarLogin() {
  const sessao = await api("/api/session").catch(() => ({ logado: false }));
  if (sessao.logado) location.replace("/empresas.html");
}

function alternarModoLogin(modo) {
  $("#form-login").dataset.modo = modo;
  $$(".tab-login-btn").forEach((b) => b.classList.toggle("ativa", b.dataset.modo === modo));
  $("#login-erro").classList.add("oculto");
  $("#form-login").reset();
  if (modo === "cadastro") {
    $("#login-titulo").textContent = "Criar conta";
    $("#login-subtitulo").textContent = "Você vai receber um link de confirmação no e-mail";
    $("#campo-nome-setup").classList.remove("oculto");
    $("#campo-email-setup").classList.remove("oculto");
    $("#login-email").required = true;
    $("#login-senha").autocomplete = "new-password";
    $("#btn-login-submit").innerHTML = "<span>Criar conta</span>";
  } else {
    $("#login-titulo").textContent = "Bem-vindo de volta";
    $("#login-subtitulo").textContent = "Entre com seu usuário e senha";
    $("#campo-nome-setup").classList.add("oculto");
    $("#campo-email-setup").classList.add("oculto");
    $("#login-email").required = false;
    $("#login-senha").autocomplete = "current-password";
    $("#btn-login-submit").innerHTML = "<span>Entrar</span>";
  }
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
    if ($("#form-login").dataset.modo === "cadastro") {
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
