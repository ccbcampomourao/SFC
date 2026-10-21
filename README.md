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
- **Consultar Simples Nacional**: botão em cada empresa que verifica se ela é optante pelo Simples Nacional (e/ou MEI) nos dados públicos da Receita — gratuito, sem certificado nem contrato. O resultado fica registrado como comentário na empresa (com a fonte e a data). Como funciona por baixo:
  - Tenta **BrasilAPI → Minha Receita → CNPJ.ws**, nessa ordem; se uma limitar as requisições (erro 429) ou cair, passa pra próxima
  - Cada consulta fica em **cache por 24h** no KV (não gasta o limite das fontes se você consultar a mesma empresa de novo)
  - Valida os dígitos do CNPJ antes de consultar (CNPJ digitado errado não gasta consulta)
  - Mostra **três** resultados: ✅ optante, ❌ não optante, ou ⚠️ "sem registro na base pública" (a base às vezes simplesmente não tem o registro — isso não é a mesma coisa que "não optante")
  - ⚠️ É uma **base pública atualizada mensalmente**: uma opção feita há poucos dias pode ainda não aparecer. Para decisão fiscal crítica, confirme no portal do Simples Nacional
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
    ├── icones.js          # ícones SVG do sistema + estado do menu lateral (carrega antes de tudo)
    ├── common.js          # utilitários e ações compartilhadas (salvar, período, backup, usuários, diálogos)
    ├── login.js            # lógica exclusiva da tela de login
    ├── empresas.js          # lógica exclusiva da página de empresas
    ├── parcelamentos.js      # lógica exclusiva da página de parcelamentos
    └── style.css              # visual (cores da logo: navy + azul)
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

| `SERPRO_SITFIS_VERSAO` *(opcional)* | Versão do serviço de Situação Fiscal. Padrão `2.0`; só mude (ex.: `1.0`) se o erro disser que a versão é inválida |

A página `/integracontador.html` mostra em tempo real o que já está configurado (✅/⚠️) pra cada parte.

**3. Procuração eletrônica de cada empresa.** Para baixar a Situação Fiscal de um cliente, ele precisa ter
cadastrado no e-CAC uma **procuração eletrônica** para o CNPJ do seu escritório, incluindo o serviço de
Situação Fiscal. Sem isso o SERPRO recusa só aquela empresa (as outras funcionam). Atenção: o SERPRO
cobra também as chamadas recusadas, então não fique repetindo uma empresa que está dando erro.

**Quando der erro:** a linha da empresa mostra a mensagem exata do SERPRO, uma dica 💡 do que fazer e o
botão **📋 Copiar detalhes**. Se o erro for de configuração (certificado, credenciais, CNPJ do contratante),
o lote para na primeira empresa para não gastar chamadas à toa.

## Próxima fase (quando quiser)

- Importação de planilha Excel para cadastro em massa
- Importação/leitura de PDF fiscal (parser de "Operações" + gerador de PDF resumo)
- Regras finas de permissão entre funcionários

## Atalhos e recursos de uso

- **Ctrl+S** salva de qualquer página (Empresas/Parcelamentos). Uma bolinha laranja no botão **Salvar** indica alterações ainda não salvas, e o navegador avisa se você tentar sair sem salvar.
- **/** coloca o cursor na busca.
- Em **Documentos** de cada empresa/parcelamento dá para **arrastar arquivos** direto para a área tracejada (vários de uma vez).
- Grupos podem ser **renomeados** e **excluídos** pelos botões dentro do grupo aberto.
- No IntegraContador, lotes com mais de 10 consultas pedem confirmação antes (o SERPRO cobra por consulta).

## Consulta de exclusão do Simples Nacional

- **Dentro de cada empresa:** botão **Consultar exclusão** (ao lado de "Consultar Simples Nacional"). Mostra se e quando a empresa foi excluída do Simples, se voltou a optar, e se foi desenquadrada do MEI. O resultado fica registrado nos comentários.
- **Todas de uma vez:** botão **Verificar exclusões** no painel "Grupos e empresas". Consulta uma empresa por vez, mostra as excluídas primeiro e (opcionalmente) registra nos comentários. Clicar numa linha abre a empresa.
- Fonte: base pública da Receita (BrasilAPI → Minha Receita → CNPJ.ws), gratuita, sem certificado, com cache de 24h.
- **Limite importante:** essa base é atualizada uma vez por mês e só mostra a exclusão depois que ela entra em vigor. Exclusões por débito notificadas no fim do ano (Termo de Exclusão no DTE-SN, com efeito em 1º de janeiro) só aparecem depois dessa data — para vê-las antes, é preciso olhar a caixa postal do e-CAC.

## Situação Fiscal — como o relatório é lido

O leitor (`public/sitfis-parser.js`) segue as seções do próprio relatório da Receita:
- **Pendências** (impedem a certidão): débitos em aberto (agrupados por tributo, com as competências seguidas resumidas), inscrições em dívida ativa em cobrança, parcelamentos com parcelas em atraso, declarações omissas.
- **Parcelamentos e transações**: um cartão por parcelamento (PARCSN, SIEFPAR, SISPAR…), com as inscrições negociadas dentro da negociação da PGFN da mesma categoria (Simples / Previdenciário / Demais). Quando há mais de uma conta da mesma categoria, o relatório não diz qual inscrição está em qual conta — elas aparecem juntas, com aviso.
- **A vencer e outras suspensões**: não impedem a certidão e não entram no total em aberto.
- **Simples Nacional e certidão**: histórico de opção/exclusão (inclusive exclusão agendada) e a última certidão emitida.

## Envio pelo WhatsApp (gratuito, sem API)

- Em cada empresa há o campo **WhatsApp do cliente** (formatado automaticamente). Com ele preenchido, aparece o botão **WhatsApp** no cabeçalho da empresa — e também no parcelamento com o mesmo CNPJ.
- O botão abre uma janela com a mensagem pronta (editável), cria um **link de download** com os documentos anexados e abre o WhatsApp Web (ou o aplicativo do computador) na conversa do cliente, com tudo preenchido. Basta apertar enviar.
- O link leva a uma página com a marca FZ CONT onde o cliente baixa os arquivos, sem login. Ele **expira sozinho** no fim do dia que você escolher no calendário (até 1 ano), tem um código impossível de adivinhar, não aparece em buscadores e só dá acesso aos arquivos daquele envio.
- Depois de enviar, o sistema pergunta se quer registrar o envio: na empresa, marca como OK e anota nos comentários (como o e-mail faz).
- Não usa API do WhatsApp: são os links oficiais "clique para conversar" — sem custo, sem cadastro e sem risco de bloqueio do número.

### WhatsApp em lote

Na página Empresas, botão **WhatsApp em lote** (no painel "Grupos e empresas"):
1. Mostra as empresas que têm WhatsApp e documentos anexados (as que faltam algo aparecem em "fora do lote", com o motivo). "Só as não enviadas" desmarca as que já estão OK.
2. Escolha a data de validade dos links e ajuste a mensagem — `{empresa}`, `{competencia}`, `{link}` e `{validade}` são trocados para cada cliente. A mensagem fica guardada para a próxima vez.
3. **Preparar envios** gera todos os links numa chamada só.
4. Na fila, **Abrir no WhatsApp** abre a primeira conversa já preenchida. No WhatsApp, aperte Enter para enviar e volte: **Enviado, abrir o próximo** registra o envio (empresa fica OK + comentário) e abre o cliente seguinte. Também dá para **Pular** ou **Abrir de novo**.

Sem a API paga do WhatsApp não existe envio 100% automático: cada mensagem precisa do "enviar" no próprio WhatsApp. Dica: o **aplicativo do WhatsApp para computador** troca de conversa mais rápido que o WhatsApp Web.

## XML NFS-e (IPM / Atende.Net) — página própria

Página **"XML NFS-e"** no menu lateral (também há um atalho na página Empresas). Ela usa as **mesmas empresas** cadastradas em Empresas: não precisa cadastrar nada de novo nela.

Escolha o mês, marque as empresas e clique em **Buscar**. Para cada empresa o sistema baixa o XML de cada NFS-e **emitida** no mês, direto do webservice da prefeitura (manual IPM NTE 35/2021), e:
- mostra a lista de notas (nº, data, tomador, valor, ISS retido, situação), com download de cada XML e link para a nota no site da prefeitura;
- anexa um ZIP nos documentos da empresa (buscar de novo o mesmo mês substitui o ZIP e apaga o antigo do armazenamento);
- anota o resumo nos comentários (uma anotação por mês);
- guarda o resumo do mês na empresa (últimos 24 meses) e salva sozinho no fim da busca.

Ao reabrir a página, o que já foi buscado aparece de novo sem consultar a prefeitura: a lista de notas é lida do ZIP anexado. "Só as pendentes" seleciona as empresas que ainda não foram buscadas no mês ou que deram erro. "ZIP de todas" junta os XML do mês, com uma pasta por empresa.

**Município de cada empresa:** no cadastro da empresa, o campo **"Município da NFS-e"** define de qual prefeitura buscar. Quando fica em branco, vale Campo Mourão.

| Município | Sistema | Situação |
|---|---|---|
| Campo Mourão, Cascavel | IPM / Atende.Net | funcionando |
| Farol, Icaraíma, Foz do Iguaçu | Elotech | em preparação |
| Maringá, Itajaí | NFS-e Nacional | em preparação |

**Para cada empresa funcionar:**
1. No **Portal do Cidadão** da prefeitura (logado como a empresa), abra o serviço **"Emissão de NFS-e por WebService"** e clique em **"Liberar Acesso ao Usuário"**.
2. Em Empresas, preencha **CNPJ**, **Senha Prefeitura** (a senha do Atende.Net; o login é o CNPJ), **Cadastro econômico (prefeitura)** e **Série da NFS-e** (normalmente 1).

**Limites:** só notas emitidas pela empresa (o webservice não lista notas tomadas). A primeira busca de cada empresa gasta mais consultas; depois o sistema guarda o último número e fica mais rápido. Há uma chamada ao Worker a cada 15 consultas, longe dos limites do plano gratuito.

**Erro "Acesso Negado" (401):** a prefeitura recusou o login antes de chegar nas notas. Confira se o login e a senha entram em campomourao.atende.net, e se o serviço "Emissão de NFS-e por WebService" está com "Liberar Acesso ao Usuário" marcado. Se a empresa entra no portal com CPF, preencha o campo "Login prefeitura (se não for o CNPJ)". O sistema tenta sozinho também o endereço alternativo `ws-campomourao.atende.net`.

Outro município IPM: crie a variável `IPM_MUNICIPIO` no Worker (ex.: `maringa`). O padrão é `campomourao`. Para fixar o endereço exato do webservice, use a variável `IPM_URL`.

## Sessão: só desloga depois de 4h sem uso

Enquanto o sistema está sendo usado, a sessão não vence. Depois de **4 horas sem uso** (entre 4h e 4h30, para economizar gravações no KV: a renovação acontece no máximo a cada 30 min, cerca de 16 gravações num dia inteiro de uso), o próximo clique abre a janela **"Sua sessão expirou"**. Basta digitar a senha para continuar: a página não recarrega e o que ainda não foi salvo continua na tela.

## Visual Prumo e recursos da tela Empresas

Identidade visual Prumo (tinta, cobre e papel; Fraunces nos títulos, IBM Plex Sans no sistema e Plex Mono em CNPJ/CPF), aplicada em todas as páginas, inclusive no login. Logos e ícones ficam em `public/img/prumo-*`.

Recursos novos na tela Empresas:
- **Topo:** mês de trabalho (guardado junto com os dados e nos períodos salvos), WhatsApp em lote, Salvar e **Nova empresa** (escolhendo o grupo).
- **Indicadores:** empresas ativas, fechadas no mês, que requerem atenção e pendentes.
- **Filtros** Todas / Pendentes / Atenção / Fechadas, e busca no menu lateral (de qualquer página, leva para Empresas já filtrado).
- **Linha do grupo:** quantidade de empresas, contagem por status, barra de progresso e menu ⋯ (renomear, excluir, adicionar empresa).
- **Linha da empresa:** CNPJ, selos, status, valor do DAS, comentário, menu de copiar (CNPJ, CPF de cada sócio, IE, IM e senhas, com as senhas escondidas) e menu ⋯.
- **Empresa aberta:** status em botões, NFS/NFE/NFC, Fechado, senhas com botão de mostrar/esconder.
- **Seleção em lote:** marque várias empresas para mudar status, Fechado ou NFS de uma vez. O botão diz o que vai fazer ("Fechado" ou "Reabrir").
- **Tarefas do dia:** "X de Y concluídas" com barra, descrição, prazo (HOJE, DIA 20), contador de comentários e campo para adicionar com Enter.

## Mudar a ordem das empresas

Passe o mouse na empresa: aparece uma alça (⋮⋮) à esquerda. Arraste para cima ou para baixo e uma vaga mostra onde ela vai cair. Perto do topo ou do fim da tela, a página rola sozinha. Dá para soltar:
- **em outro grupo aberto**, na posição que quiser;
- **no cabeçalho de um grupo fechado**, e a empresa vai para o fim dele sem abrir o grupo.

A lista não é redesenhada: o próprio cartão é movido, então nada pisca e as empresas abertas continuam abertas. **Esc** cancela. Pelo teclado, com a alça em foco, ↑ e ↓ sobem e descem a empresa. Com busca ou filtro ativo, o arraste fica desligado, porque a lista visível não é a lista inteira. Depois, clique em **Salvar**.
