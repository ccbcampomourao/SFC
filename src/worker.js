import { WorkerMailer } from "worker-mailer";

const SESSION_COOKIE = "sfc_session";
const SESSION_TTL_SEGUNDOS = 60 * 60 * 24 * 7; // 7 dias

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function lerCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  header.split(";").forEach((parte) => {
    const [k, ...v] = parte.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  });
  return out;
}

function cookieDeSessao(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function bufParaHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashSenha(senha, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex
    ? new Uint8Array(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const chaveBase = await crypto.subtle.importKey("raw", enc.encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 120000, hash: "SHA-256" },
    chaveBase,
    256
  );
  return { hash: bufParaHex(bits), salt: bufParaHex(salt) };
}

async function conferirSenha(senha, hashSalvo, saltSalvo) {
  const { hash } = await hashSenha(senha, saltSalvo);
  return hash === hashSalvo;
}

async function usuarioLogado(request, env) {
  const cookies = lerCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const sessao = await env.SFC_KV.get(`session:${token}`, "json");
  return sessao ? sessao.username : null;
}

function estadoVazio() {
  return {
    grupos: [
      { nome: "LUCRO PRESUMIDO", empresas: [] },
      { nome: "FATOR R", empresas: [] },
      { nome: "ANEXO III", empresas: [] },
      { nome: "ANEXO IV", empresas: [] },
      { nome: "COMERCIO E SERVIÇO", empresas: [] },
      { nome: "COMERCIO E INDÚSTRIA", empresas: [] },
    ],
    checklist: [],
  };
}

function empresaLimpa(base) {
  return {
    nome: base.nome || "",
    status: "SEM",
    nfs: false,
    nfe: false,
    nfc: false,
    fechado: false,
    cnpj: base.cnpj || "",
    cpf: base.cpf || "",
    senhaPrefeitura: base.senhaPrefeitura || "",
    senhaRegularize: base.senhaRegularize || "",
    inscricaoEstadual: base.inscricaoEstadual || "",
    email: base.email || "",
    comentarios: [],
    anexos: [],
  };
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // ---------- SETUP: cria o primeiro usuário (só funciona se não houver nenhum) ----------
      if (pathname === "/api/setup" && request.method === "POST") {
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        if (usuarios.length > 0) {
          return json({ erro: "Sistema já configurado. Peça a um administrador para criar seu login." }, 400);
        }
        const { username, password, nome } = await request.json();
        if (!username || !password || password.length < 6) {
          return json({ erro: "Usuário e senha (mín. 6 caracteres) são obrigatórios." }, 400);
        }
        const { hash, salt } = await hashSenha(password);
        usuarios.push({ username, nome: nome || username, hash, salt });
        await env.SFC_KV.put("users", JSON.stringify(usuarios));
        await env.SFC_KV.put("dados", JSON.stringify(estadoVazio()));
        await env.SFC_KV.put("parcelamentos", JSON.stringify({ parcelamentos: [] }));
        return json({ ok: true });
      }

      if (pathname === "/api/setup/necessario" && request.method === "GET") {
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        return json({ necessario: usuarios.length === 0 });
      }

      // ---------- LOGIN ----------
      if (pathname === "/api/auth/login" && request.method === "POST") {
        const { username, password } = await request.json();
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        const usuario = usuarios.find((u) => u.username === username);
        if (!usuario || !(await conferirSenha(password, usuario.hash, usuario.salt))) {
          return json({ erro: "Usuário ou senha inválidos." }, 401);
        }
        const token = crypto.randomUUID();
        await env.SFC_KV.put(`session:${token}`, JSON.stringify({ username }), {
          expirationTtl: SESSION_TTL_SEGUNDOS,
        });
        return new Response(JSON.stringify({ ok: true, nome: usuario.nome }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": cookieDeSessao(token, SESSION_TTL_SEGUNDOS),
          },
        });
      }

      if (pathname === "/api/auth/logout" && request.method === "POST") {
        const cookies = lerCookies(request);
        const token = cookies[SESSION_COOKIE];
        if (token) await env.SFC_KV.delete(`session:${token}`);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": cookieDeSessao("", 0),
          },
        });
      }

      if (pathname === "/api/session" && request.method === "GET") {
        const username = await usuarioLogado(request, env);
        return json({ logado: !!username, username });
      }

      // A partir daqui, tudo exige login
      const username = await usuarioLogado(request, env);
      if (!username) return json({ erro: "Não autenticado." }, 401);

      // ---------- USUÁRIOS (adicionar novo funcionário) ----------
      if (pathname === "/api/users" && request.method === "GET") {
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        return json({ usuarios: usuarios.map((u) => ({ username: u.username, nome: u.nome })) });
      }

      if (pathname === "/api/users" && request.method === "POST") {
        const { username: novoUser, password, nome } = await request.json();
        if (!novoUser || !password || password.length < 6) {
          return json({ erro: "Usuário e senha (mín. 6 caracteres) são obrigatórios." }, 400);
        }
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        if (usuarios.some((u) => u.username === novoUser)) {
          return json({ erro: "Esse usuário já existe." }, 400);
        }
        const { hash, salt } = await hashSenha(password);
        usuarios.push({ username: novoUser, nome: nome || novoUser, hash, salt });
        await env.SFC_KV.put("users", JSON.stringify(usuarios));
        return json({ ok: true });
      }

      // ---------- DADOS PRINCIPAIS (grupos/empresas/checklist) ----------
      if (pathname === "/api/data" && request.method === "GET") {
        const dados = (await env.SFC_KV.get("dados", "json")) || estadoVazio();
        const parcelamentos = (await env.SFC_KV.get("parcelamentos", "json")) || { parcelamentos: [] };
        return json({ ...dados, parcelamentos: parcelamentos.parcelamentos });
      }

      if (pathname === "/api/data" && request.method === "POST") {
        const body = await request.json();
        const dados = { grupos: body.grupos || [], checklist: body.checklist || [] };
        await env.SFC_KV.put("dados", JSON.stringify(dados));
        if (body.parcelamentos) {
          await env.SFC_KV.put("parcelamentos", JSON.stringify({ parcelamentos: body.parcelamentos }));
        }
        return json({ ok: true, salvoEm: new Date().toISOString() });
      }

      // ---------- NOVA LISTA (reset mensal) ----------
      // Mantém nome + dados de acesso de cada empresa (cnpj, senhas, etc),
      // mas zera status, checkboxes, comentários e anexos.
      if (pathname === "/api/reset" && request.method === "POST") {
        const dados = (await env.SFC_KV.get("dados", "json")) || estadoVazio();
        const novosGrupos = dados.grupos.map((g) => ({
          nome: g.nome,
          empresas: g.empresas.map((e) => empresaLimpa(e)),
        }));
        const novosDados = { grupos: novosGrupos, checklist: dados.checklist || [] };
        await env.SFC_KV.put("dados", JSON.stringify(novosDados));
        return json({ ok: true });
      }

      // ---------- ENVIO DE E-MAIL (via Gmail, usando conexão TCP direta) ----------
      if (pathname === "/api/email" && request.method === "POST") {
        const { destinatario, assunto, mensagem } = await request.json();
        if (!destinatario || !assunto) {
          return json({ erro: "Destinatário e assunto são obrigatórios." }, 400);
        }
        if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
          return json(
            { erro: "E-mail não configurado. Rode: wrangler secret put GMAIL_USER / GMAIL_APP_PASSWORD" },
            500
          );
        }
        try {
          await WorkerMailer.send(
            {
              host: "smtp.gmail.com",
              port: 465,
              secure: true,
              credentials: { username: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD },
            },
            {
              from: env.GMAIL_USER,
              to: destinatario,
              subject: assunto,
              text: mensagem || "",
            }
          );
          return json({ ok: true });
        } catch (err) {
          return json({ erro: "Falha ao enviar e-mail: " + err.message }, 500);
        }
      }

      // Nenhuma rota de API bateu — deixa cair pro handler de assets estáticos
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ erro: "Erro interno: " + err.message }, 500);
    }
  },
};
