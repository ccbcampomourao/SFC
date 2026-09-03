# SFC — Sistema Fiscal Contábil (versão Web)

Versão web do sistema, feita para rodar 100% no **Cloudflare Workers** (com Assets estáticos + KV),
publicável direto do **GitHub**.

## ⚠️ Antes de tudo: troque a senha do Gmail

O código Java original tinha a senha de app do Gmail escrita diretamente no arquivo.
Essa senha **precisa ser revogada agora**, mesmo que você não use mais o app antigo:

1. Acesse https://myaccount.google.com/apppasswords
2. Revogue a senha de app antiga (a que aparecia no `MainController.java`)
3. Gere uma **nova senha de app** — você vai usá-la no passo 4 abaixo (nunca vai ficar escrita em nenhum arquivo)

## O que já funciona nesta primeira versão

- Login multiusuário (funcionários), sessão por cookie
- Grupos e empresas (cadastro, edição, exclusão)
- Status por empresa (SEM / PENDENTE / OK) + checkboxes NFS/NFE/NFC/Fechado
- Comentários por empresa
- Tarefas do dia (checklist) com comentários
- Parcelamentos com os 4 status alternáveis + status geral + comentários
- Botão **Salvar** (grava tudo no Cloudflare KV)
- Botão **Nova Lista**: mantém nome + dados de acesso (CNPJ, senhas, IE, e-mail) de cada empresa,
  mas zera status, checkboxes, comentários e anexos — exatamente como você pediu
- Envio de e-mail pelo Gmail, direto do Worker (usando `worker-mailer`, sem depender de Resend/SendGrid)

## O que fica para a próxima fase (avise quando quiser que eu monte)

- **Anexos de arquivo de verdade** (upload/download) — precisa de um bucket Cloudflare R2
- **Importação de planilha Excel** (hoje feita com Apache POI em Java) — dá pra portar com a lib `xlsx` (SheetJS)
- **Importação/leitura de PDF fiscal** (o parser de "Operações" com regex) — precisa reimplementar com `pdf.js` ou similar
- Regras finas de permissão entre funcionários (hoje todo usuário logado pode tudo)

## Passo a passo para publicar

### 1. Criar o namespace do KV
```bash
npm install -g wrangler
wrangler login
wrangler kv namespace create SFC_KV
```
Copie o `id` que aparecer e cole em `wrangler.toml`, no lugar de `COLE_AQUI_O_ID_DO_KV`.

### 2. Configurar o e-mail (Gmail)
```bash
wrangler secret put GMAIL_USER
# digite: ferrarezicontabilidadegestao@gmail.com (ou o e-mail que preferir)

wrangler secret put GMAIL_APP_PASSWORD
# digite a senha de app NOVA que você gerou no passo "antes de tudo"
```

### 3. Ativar Sockets TCP no Worker (necessário para o envio de e-mail)
No painel da Cloudflare: **Workers & Pages > seu Worker > Settings > Bindings** — os sockets TCP
via `cloudflare:sockets` já vêm habilitados por padrão em contas com Workers Paid. Se o envio de
e-mail falhar com erro de conexão, confirme no dashboard se sua conta tem esse recurso disponível.

### 4. Instalar dependências e testar localmente
```bash
npm install
npm run dev
```
Acesse `http://localhost:8787`, crie o primeiro usuário (tela de setup) e teste.

### 5. Subir para o GitHub
```bash
git init
git add .
git commit -m "Versão web do SFC"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/sfc-web.git
git push -u origin main
```

### 6. Publicar no Cloudflare (via GitHub)
No painel da Cloudflare: **Workers & Pages > Create > Import from Git** e selecione o repositório.
A Cloudflare vai detectar o `wrangler.toml` automaticamente. Configure:
- **Build command:** `npm install`
- **Deploy command:** `npx wrangler deploy`

Depois disso, todo `git push` na branch `main` publica automaticamente uma nova versão.

Ou, se preferir publicar direto da sua máquina sem integração automática:
```bash
npm run deploy
```

## Estrutura do projeto
```
sfc-web/
├── wrangler.toml       # configuração do Worker (KV, assets, variáveis)
├── package.json
├── src/
│   └── worker.js        # backend: login, dados, reset mensal, e-mail
└── public/
    ├── index.html        # interface
    ├── style.css         # visual (paleta índigo/violeta)
    └── app.js             # lógica do front-end
```
