import { WorkerMailer } from "worker-mailer";

const SESSION_COOKIE = "sfc_session";
const SESSION_TTL_SEGUNDOS = 60 * 60 * 24 * 7; // 7 dias
const CONFIRMACAO_TTL_SEGUNDOS = 60 * 60 * 24; // 24h para confirmar o e-mail

function emailValido(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function enviarEmailConfirmacao(env, origin, destinatario, nome, token) {
  const link = `${origin}/api/auth/confirmar?token=${token}`;
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
      subject: "Confirme seu acesso — Sistema Fiscal Contábil",
      text:
        `Olá, ${nome}!\n\n` +
        `Para liberar seu acesso ao sistema, confirme seu e-mail clicando no link abaixo:\n\n${link}\n\n` +
        `Se você não pediu esse cadastro, pode ignorar esta mensagem.`,
    }
  );
}

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
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
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

async function apagarAnexosDeEmpresa(env, empresa) {
  if (!empresa.anexos) return;
  for (const a of empresa.anexos) {
    if (a && a.id) await env.SFC_KV.delete(`anexo:${a.id}`).catch(() => {});
  }
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
        const { username, password, nome, email } = await request.json();
        if (!username || !password || password.length < 6) {
          return json({ erro: "Usuário e senha (mín. 6 caracteres) são obrigatórios." }, 400);
        }
        if (!emailValido(email)) {
          return json({ erro: "Informe um e-mail válido." }, 400);
        }
        const { hash, salt } = await hashSenha(password);
        usuarios.push({ username, nome: nome || username, email, hash, salt, confirmado: false });
        await env.SFC_KV.put("users", JSON.stringify(usuarios));
        await env.SFC_KV.put("dados", JSON.stringify(estadoVazio()));
        await env.SFC_KV.put("parcelamentos", JSON.stringify({ parcelamentos: [] }));

        const token = crypto.randomUUID();
        await env.SFC_KV.put(`confirm:${token}`, JSON.stringify({ username }), {
          expirationTtl: CONFIRMACAO_TTL_SEGUNDOS,
        });
        try {
          await enviarEmailConfirmacao(env, url.origin, email, nome || username, token);
        } catch (err) {
          return json({ ok: true, emailFalhou: true, erroEmail: err.message });
        }
        return json({ ok: true, emailFalhou: false });
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
        if (!usuario.confirmado) {
          return json({ erro: "Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada (e o spam)." }, 403);
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

      if (pathname === "/api/auth/confirmar" && request.method === "GET") {
        const token = url.searchParams.get("token");
        const registro = token ? await env.SFC_KV.get(`confirm:${token}`, "json") : null;
        const paginaHtml = (titulo, mensagem, sucesso) => `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
          <title>${titulo}</title>
          <style>body{font-family:system-ui,sans-serif;background:#f4f5fa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
          .c{background:#fff;padding:36px;border-radius:16px;max-width:400px;text-align:center;box-shadow:0 12px 32px rgba(30,34,51,.14)}
          h1{font-size:18px;color:${sucesso ? "#16a34a" : "#dc2626"}}
          a{color:#4f46e5;font-weight:600;text-decoration:none}</style></head>
          <body><div class="c"><h1>${titulo}</h1><p>${mensagem}</p><a href="/">Ir para o login</a></div></body></html>`;

        if (!registro) {
          return new Response(paginaHtml("Link inválido ou expirado", "Peça para o administrador te cadastrar novamente.", false), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
            status: 400,
          });
        }
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        const usuario = usuarios.find((u) => u.username === registro.username);
        if (usuario) usuario.confirmado = true;
        await env.SFC_KV.put("users", JSON.stringify(usuarios));
        await env.SFC_KV.delete(`confirm:${token}`);
        return new Response(paginaHtml("E-mail confirmado! ✓", "Sua conta está liberada. Já pode fazer login normalmente.", true), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // A partir daqui, tudo exige login
      const username = await usuarioLogado(request, env);
      if (!username) return json({ erro: "Não autenticado." }, 401);

      // ---------- USUÁRIOS (adicionar novo funcionário) ----------
      if (pathname === "/api/users" && request.method === "GET") {
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        return json({ usuarios: usuarios.map((u) => ({ username: u.username, nome: u.nome, email: u.email, confirmado: !!u.confirmado })) });
      }

      if (pathname === "/api/users" && request.method === "POST") {
        const { username: novoUser, password, nome, email } = await request.json();
        if (!novoUser || !password || password.length < 6) {
          return json({ erro: "Usuário e senha (mín. 6 caracteres) são obrigatórios." }, 400);
        }
        if (!emailValido(email)) {
          return json({ erro: "Informe um e-mail válido." }, 400);
        }
        const usuarios = (await env.SFC_KV.get("users", "json")) || [];
        if (usuarios.some((u) => u.username === novoUser)) {
          return json({ erro: "Esse usuário já existe." }, 400);
        }
        const { hash, salt } = await hashSenha(password);
        usuarios.push({ username: novoUser, nome: nome || novoUser, email, hash, salt, confirmado: false });
        await env.SFC_KV.put("users", JSON.stringify(usuarios));

        const token = crypto.randomUUID();
        await env.SFC_KV.put(`confirm:${token}`, JSON.stringify({ username: novoUser }), {
          expirationTtl: CONFIRMACAO_TTL_SEGUNDOS,
        });
        try {
          await enviarEmailConfirmacao(env, url.origin, email, nome || novoUser, token);
        } catch (err) {
          return json({ ok: true, emailFalhou: true, erroEmail: err.message });
        }
        return json({ ok: true, emailFalhou: false });
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
        for (const g of dados.grupos) {
          for (const e of g.empresas) await apagarAnexosDeEmpresa(env, e);
        }
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

      // ---------- ANEXOS (upload/download/exclusão real de arquivos, guardados no KV) ----------
      if (pathname === "/api/anexos" && request.method === "POST") {
        const { nome, tipo, dataB64 } = await request.json();
        if (!nome || !dataB64) return json({ erro: "Arquivo inválido." }, 400);
        // Limite de segurança: KV aceita até 25MB por valor; base64 soma ~33% ao tamanho original.
        if (dataB64.length > 24 * 1024 * 1024) {
          return json({ erro: "Arquivo grande demais (máximo ~18MB)." }, 400);
        }
        const id = crypto.randomUUID();
        await env.SFC_KV.put(
          `anexo:${id}`,
          JSON.stringify({ nome, tipo: tipo || "application/octet-stream", dataB64 })
        );
        return json({ id, nome, tipo: tipo || "application/octet-stream" });
      }

      if (pathname.startsWith("/api/anexos/") && request.method === "GET") {
        const id = pathname.replace("/api/anexos/", "");
        const anexo = await env.SFC_KV.get(`anexo:${id}`, "json");
        if (!anexo) return json({ erro: "Anexo não encontrado (ou já foi apagado)." }, 404);
        return json(anexo);
      }

      if (pathname.startsWith("/api/anexos/") && request.method === "DELETE") {
        const id = pathname.replace("/api/anexos/", "");
        await env.SFC_KV.delete(`anexo:${id}`);
        return json({ ok: true });
      }

      // ---------- BACKUP COMPLETO (exportar/importar período — equivalente ao ZIP do app original) ----------
      if (pathname === "/api/backup/export" && request.method === "GET") {
        const dados = (await env.SFC_KV.get("dados", "json")) || estadoVazio();
        const parcelamentos = (await env.SFC_KV.get("parcelamentos", "json")) || { parcelamentos: [] };

        // Empacota o conteúdo real de cada anexo referenciado, para o backup ficar autocontido.
        const anexosEmpacotados = {};
        const coletarIds = (lista) => {
          for (const item of lista) {
            for (const a of item.anexos || []) {
              if (a && a.id) coletarIds._ids.add(a.id);
            }
          }
        };
        coletarIds._ids = new Set();
        for (const g of dados.grupos) coletarIds(g.empresas);
        coletarIds(parcelamentos.parcelamentos);

        for (const id of coletarIds._ids) {
          const anexo = await env.SFC_KV.get(`anexo:${id}`, "json");
          if (anexo) anexosEmpacotados[id] = anexo;
        }

        const backup = {
          versao: 1,
          geradoEm: new Date().toISOString(),
          grupos: dados.grupos,
          checklist: dados.checklist,
          parcelamentos: parcelamentos.parcelamentos,
          anexos: anexosEmpacotados,
        };

        const nomeArquivo = `backup-sfc-${new Date().toISOString().slice(0, 10)}.json`;
        return new Response(JSON.stringify(backup), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${nomeArquivo}"`,
          },
        });
      }

      if (pathname === "/api/backup/import" && request.method === "POST") {
        const backup = await request.json();
        if (!backup || !Array.isArray(backup.grupos)) {
          return json({ erro: "Arquivo de backup inválido." }, 400);
        }

        // Recria os anexos com IDs novos no KV, e devolve um mapa id-antigo -> id-novo.
        const mapaIds = {};
        if (backup.anexos) {
          for (const [idAntigo, anexo] of Object.entries(backup.anexos)) {
            const novoId = crypto.randomUUID();
            await env.SFC_KV.put(`anexo:${novoId}`, JSON.stringify(anexo));
            mapaIds[idAntigo] = novoId;
          }
        }
        const remapear = (lista) =>
          lista.map((item) => ({
            ...item,
            anexos: (item.anexos || [])
              .map((a) => (a && a.id && mapaIds[a.id] ? { ...a, id: mapaIds[a.id] } : a))
              .filter(Boolean),
          }));

        const novosGrupos = backup.grupos.map((g) => ({ nome: g.nome, empresas: remapear(g.empresas || []) }));
        const novosParcelamentos = remapear(backup.parcelamentos || []);

        await env.SFC_KV.put("dados", JSON.stringify({ grupos: novosGrupos, checklist: backup.checklist || [] }));
        await env.SFC_KV.put("parcelamentos", JSON.stringify({ parcelamentos: novosParcelamentos }));

        return json({ ok: true });
      }

      // Nenhuma rota de API bateu — deixa cair pro handler de assets estáticos
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ erro: "Erro interno: " + err.message }, 500);
    }
  },
};
