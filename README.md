# SFC — Sistema Fiscal Contábil (versão Web)

Versão web do sistema, feita para rodar 100% no **Cloudflare Workers** (com Assets estáticos + KV),
publicável direto do **GitHub**.

## ⚠️ Antes de tudo: troque a senha do Gmail

O código Java original tinha a senha de app do Gmail escrita diretamente no arquivo.
Essa senha **precisa ser revogada agora**, mesmo que você não use mais o app antigo:

1. Acesse https://myaccount.google.com/apppasswords
2. Revogue a senha de app antiga (a que aparecia no `MainController.java`)
3. Gere uma **nova senha de app** — você vai usá-la no passo 4 abaixo (nunca vai ficar escrita em nenhum arquivo)

## O que já funciona nesta versão (agora com paridade completa com o app Java)

- Login multiusuário (funcionários), sessão por cookie
- **Tela de login com duas abas**: "Entrar" e "Criar conta", separadas — qualquer pessoa com o link pode clicar em "Criar conta" a qualquer momento (não é mais só a primeira vez). Toda conta nova só consegue entrar depois de clicar no link de confirmação enviado por e-mail
- Grupos e empresas em formato sanfona (clique para abrir/fechar), exatamente como no app original
- **Status por empresa**: 3 botões independentes (OK / PENDENTE / ATENÇÃO) — clicar pinta a empresa inteira daquela cor, clicar de novo no mesmo desliga
- Checkboxes reais de **NFS / NFE / NFC / FECHADO**
- Botões de cópia rápida (CNPJ, CPF, IE, senha da Prefeitura, senha do Regularize) — clique copia pra área de transferência
- Comentários com data/hora automática
- **Anexos de verdade**: upload e download reais, guardados no Cloudflare KV (limite de ~18MB por arquivo)
- Tarefas do dia (checklist) com comentários
- **Parcelamentos**, sincronizados automaticamente com as empresas (por CNPJ), com os 4 botões de alternância (Vazio → Simples Receita → Simples PGFN → Previdência Receita → Previdência PGFN) + status geral (OK/PENDENTE/ATENÇÃO) + comentários + anexos
- Dashboard com contagem de OK/ATENÇÃO/PENDENTE por grupo, igual ao app original
- Botão **Salvar** (grava tudo no Cloudflare KV)
- **Exportar Backup / Importar Backup**: baixa um `.json` autocontido (com os anexos embutidos) para arquivar um período inteiro, e permite restaurar esse período depois — substitui o backup em ZIP do app original
- Botão **Nova Lista**: mantém nome + dados de acesso (CNPJ, senhas, IE, e-mail) de cada empresa, mas zera status, checkboxes, comentários e anexos (e apaga os anexos antigos do KV)
- Envio de e-mail pelo Gmail, direto do Worker (usando `worker-mailer`, sem depender de Resend/SendGrid)

## O que fica para a próxima fase (avise quando quiser que eu monte)

- Importação de planilha Excel para cadastro em massa (hoje você cadastra empresa por empresa, ou via "Importar Backup")
- Importação/leitura de PDF fiscal (o parser de "Operações" com regex, e o gerador de PDF resumo)
- Regras finas de permissão entre funcionários (hoje todo usuário logado pode tudo)

## ⚠️ Cadastro aberto

Como pedido, a aba "Criar conta" fica sempre disponível — qualquer pessoa com o link do sistema pode se cadastrar (mas só entra depois de confirmar o e-mail). Se algum dia quiser fechar isso (por exemplo, só administradores podendo criar login pelo botão "Usuários"), é só avisar que eu tiro a aba "Criar conta" da tela pública.

## Passo a passo para publicar

### 1. Criar o namespace do KV
```bash
npm install -g wrangler
wrangler login
wrangler kv namespace create SFC_KV
```
Copie o `id` que aparecer e cole em `wrangler.toml`, no lugar de `COLE_AQUI_O_ID_DO_KV`.

### 2. Configurar o e-mail (Gmail) — obrigatório antes de criar o 1º usuário
```bash
wrangler secret put GMAIL_USER
# digite: ferrarezicontabilidadegestao@gmail.com (ou o e-mail que preferir)

wrangler secret put GMAIL_APP_PASSWORD
# digite a senha de app NOVA que você gerou no passo "antes de tudo"
```
Para testar **localmente** (`npm run dev`), crie um arquivo `.dev.vars` na raiz do projeto (ele já está no `.gitignore`, não vai pro GitHub):
```
GMAIL_USER=seuemail@gmail.com
GMAIL_APP_PASSWORD=sua-senha-de-app
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
