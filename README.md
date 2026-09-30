# SFC — Sistema Fiscal Contábil (versão Web)

Versão web do sistema, rodando 100% no **Cloudflare Workers**, com o armazenamento dividido em:

- **KV `SFC_KV`** — usuários e sessões de login
- **KV `KV_EMPRESAS`** — cadastro/status das empresas e parcelamentos + índice de períodos salvos
- **KV `KV_COMENTARIOS`** — comentários e as tarefas do dia (checklist)
- **R2 `sfc-anexos`** — os arquivos anexados de verdade (upload/download binário, sem base64)

E a interface dividida em **páginas separadas**: `index.html` (login/cadastro), `empresas.html` (grupos, empresas, tarefas do dia) e `parcelamentos.html` — em vez de tudo numa página só.

## ⚠️ Antes de tudo: troque a senha do Gmail

O código Java original tinha a senha de app do Gmail escrita diretamente no arquivo. Revogue essa senha antiga em https://myaccount.google.com/apppasswords e gere uma nova (você vai usá-la no passo 3 abaixo).

## O que já funciona nesta versão

- **3 páginas separadas**: `/` (login/cadastro), `/empresas.html`, `/parcelamentos.html` — navegação por link de verdade, não por abas escondidas
- Login multiusuário com **duas abas** (Entrar / Criar conta), sempre disponíveis
- **Confirmação por e-mail** obrigatória para toda conta nova. Se o login falhar por conta não confirmada, aparece um aviso com **botão de reenvio** — e se a conta for antiga e não tiver e-mail cadastrado, é pedido um e-mail ali mesmo antes de reenviar
- Grupos e empresas em formato sanfona, com status (OK/PENDENTE/ATENÇÃO), checkboxes NFS/NFE/NFC/FECHADO, botões de cópia rápida, comentários e anexos
- **Anexos reais via Cloudflare R2** — upload e download binário direto, sem transformar em base64 pra guardar (arquivo até ~95MB)
- Parcelamentos sincronizados automaticamente com as empresas (por CNPJ), com os 4 botões de alternância + status geral + comentários + anexos
- **Importar PDFs em lote**: seleciona vários PDFs de uma vez (guias DAS na página de Empresas, guias de parcelamento na página de Parcelamentos) — o sistema lê o texto de cada PDF no próprio navegador, acha o CNPJ, identifica automaticamente a empresa/parcelamento correspondente, anexa o arquivo e registra um comentário com a competência e o valor encontrados (igual ao "processarPdfDas"/"processarPdfParcelamento" do app original)
- **Situação Fiscal (novo)**: página separada pra importar relatórios de situação fiscal do ECAC em PDF (vários de uma vez, até de empresas diferentes) e ver um raio-x organizado por categoria (Receita Federal, PGFN, parcelamentos, processos, declarações pendentes). É **só leitura local no navegador** — nada é enviado ou salvo no Cloudflare; ao recarregar a página, é preciso importar de novo
- **Consultar Simples Nacional**: botão em cada empresa que verifica se ela é optante pelo Simples Nacional (e/ou MEI) direto nos dados públicos da Receita Federal (via BrasilAPI) — não precisa de certificado nem contrato, é gratuito. O resultado fica registrado como comentário na empresa
- **Importar Resumo (Relatório Fiscal)**: igual ao app original — importa o PDF do "Resumo" do PGDAS, extrai faturamento e natureza das operações, e gera automaticamente um **Relatório Fiscal formatado e bonito** (cabeçalho, tabelas de faturamento e de natureza/impostos), anexando na própria empresa
- Tarefas do dia (checklist) com comentários
- Dashboard com contagem de OK/ATENÇÃO/PENDENTE por grupo
- Botão **Salvar**
- **Salvar Período / Abrir Período**: dá um nome (ex: `07-2026`) e salva um retrato completo dos dados no próprio servidor; depois é só abrir a lista de períodos salvos e clicar em "Restaurar" pra trazer aqueles dados de volta como os dados atuais
- **Exportar Backup / Importar Backup**: continua existindo como opção de arquivo `.json` pra guardar uma cópia fora do servidor
- Botão **Nova Lista**: mantém nome + dados de acesso de cada empresa, zera status/checkboxes/comentários/anexos (os arquivos em si continuam no R2, caso algum período salvo ainda precise deles — apague pela lixeira se quiser remover de vez)
- Envio de e-mail pelo Gmail, direto do Worker

## Migração automática

Se você já estava usando a versão anterior (tudo num único KV, anexos em base64), não precisa fazer nada manual: na primeira vez que o app rodar depois desse upgrade, ele detecta o formato antigo e migra sozinho — copia os dados pros novos KVs, sobe os anexos pro R2 e limpa o formato antigo. Só não esqueça de criar os novos KVs e o bucket R2 (passo 1 abaixo) antes de publicar, senão a migração não tem onde gravar.

## Passo a passo para publicar

### 1. Criar os KVs e o bucket R2
```bash
npm install -g wrangler
wrangler login

wrangler kv namespace create SFC_KV
wrangler kv namespace create KV_EMPRESAS
wrangler kv namespace create KV_COMENTARIOS
wrangler r2 bucket create sfc-anexos
```
Copie os três `id` retornados e cole em `wrangler.toml`, cada um no lugar do respectivo `COLE_AQUI_O_ID_DO_...`.

### 2. Instalar dependências
```bash
npm install
```

### 3. Configurar o e-mail (Gmail)
```bash
wrangler secret put GMAIL_USER
wrangler secret put GMAIL_APP_PASSWORD
```
Para testar localmente com `npm run dev`, crie um `.dev.vars` (já está no `.gitignore`):
```
GMAIL_USER=seuemail@gmail.com
GMAIL_APP_PASSWORD=sua-senha-de-app
```

### 4. Publicar
```bash
npx wrangler deploy
```
Se preferir deploy automático via GitHub, veja a seção "Publicar no Cloudflare (via GitHub)" — mas em caso de instabilidade no build automático, `npx wrangler deploy` direto do terminal sempre funciona.

### 5. Subir para o GitHub
```bash
git init
git add .
git commit -m "Versão web do SFC"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/sfc-web.git
git push -u origin main
```

## Estrutura do projeto
```
sfc-web/
├── wrangler.toml       # KVs, bucket R2, assets, variáveis
├── package.json
├── src/
│   └── worker.js        # backend: login, dados, anexos (R2), períodos, e-mail
└── public/
    ├── index.html        # página de login/cadastro
    ├── empresas.html      # página de grupos/empresas + tarefas do dia
    ├── parcelamentos.html # página de parcelamentos
    ├── situacao-fiscal.html # importador de relatórios ECAC (só leitura local)
    ├── common.js          # utilitários e ações compartilhadas (salvar, período, backup, usuários)
    ├── login.js            # lógica exclusiva da tela de login
    ├── empresas.js          # lógica exclusiva da página de empresas
    ├── parcelamentos.js      # lógica exclusiva da página de parcelamentos
    └── style.css              # visual (paleta índigo/violeta)
```

## IntegraContador (SERPRO) — Situação Fiscal e CND

Página nova (`/integracontador.html`) pra baixar relatórios direto do SERPRO, escolhendo quais empresas usar (marcar/desmarcar todas ou uma a uma). Os arquivos baixam na sua máquina — nada fica salvo no Cloudflare.

⚠️ **Duas ressalvas técnicas importantes:**
- O contrato da **Situação Fiscal (SITFIS)** foi confirmado na documentação oficial do SERPRO — os endpoints e IDs de serviço usados no código são os reais.
- O da **CND** eu só encontrei documentado o ambiente de **homologação**; inferi a URL de produção a partir do padrão do SERPRO. Se ao testar der erro 404/401 estranho na CND, me avisa que a gente ajusta a URL exata em `src/worker.js` (constante `CND_CONSULTA_URL`).

### O que você precisa configurar

**1. Certificado digital (e-CNPJ) — só pra Situação Fiscal**
Não precisa de terminal: entre em `/integracontador.html`, clique em **"Configurar certificado (.pfx)"**, suba o arquivo e a senha (tudo é lido no seu navegador, o arquivo original nunca sai da sua máquina). O sistema te devolve um **ID de certificado**.

Só falta um passo manual: abra o `wrangler.toml` no GitHub, descomente o bloco perto do final:
```toml
[[mtls_certificates]]
binding = "SERPRO_CERT"
certificate_id = "COLE_AQUI_O_CERTIFICATE_ID"
```
cole o ID ali no lugar, salve — o deploy automático cuida do resto.

**2. Secrets no Cloudflare** (Settings → Variables and Secrets do seu Worker):

| Secret | Pra que serve |
|---|---|
| `CF_API_TOKEN` | Token da Cloudflare com permissão "SSL and Certificates: Edit", usado só pra subir o certificado (criado em [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)) |
| `CF_ACCOUNT_ID` | Aparece na barra lateral direita do painel da Cloudflare, na página do seu domínio/conta |
| `SERPRO_CONSUMER_KEY` / `SERPRO_CONSUMER_SECRET` | Credenciais do seu contrato do Integra Contador (Loja de Apps do SERPRO) |
| `SERPRO_CONTRATANTE_CNPJ` | CNPJ do seu escritório contábil (o mesmo do certificado) |
| `CND_CONSUMER_KEY` / `CND_CONSUMER_SECRET` | Credenciais do seu contrato do produto "Consulta CND" (separado do Integra Contador — não precisa de certificado) |

A página `/integracontador.html` mostra em tempo real o que já está configurado (✅/⚠️) pra cada parte.

## Próxima fase (quando quiser)

- Importação de planilha Excel para cadastro em massa
- Importação/leitura de PDF fiscal (parser de "Operações" + gerador de PDF resumo)
- Regras finas de permissão entre funcionários
