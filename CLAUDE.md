# Contexto do projeto "agente-ia-delivery" (resumo para retomar no Claude Code)

## O que e
Atendente de IA no WhatsApp para lanchonetes, pizzarias, hamburguerias e
restaurantes pequenos que recebem pedidos pelo WhatsApp. Atende 24/7, passa
cardapio, anota o pedido (com observacoes tipo "sem cebola"), valida area de
entrega e horario, confirma tudo com o cliente e notifica o dono com o resumo
estruturado do pedido. Se o pedido virar complexo ou o cliente pedir, passa
para atendimento humano e pausa o bot na conversa por algumas horas.

**Publico-alvo**: dono de lanchonete/pizzaria/hamburgueria/restaurante pequeno
que perde pedido por nao conseguir responder no WhatsApp na hora (esta no
caixa/cozinha; cliente vai pro concorrente que respondeu primeiro).

Preco/modelo: MVP para testar em 2 prospects reais em Araras. Se funcionar,
expande. Se nao, aprende rapido.

## Stack
- Node.js (ESM, "type": "module")
- @whiskeysockets/baileys (WhatsApp NAO oficial - so para demo/validacao)
- @anthropic-ai/sdk, modelo "claude-haiku-4-5-20251001", com tool use
- better-sqlite3 (persistencia local em dados.db)
- dotenv, pino, qrcode-terminal
- Roda 24/7 num VPS Hetzner (Ubuntu) gerenciado com PM2 (processo "delivery-ia").
  Scripts: setup-vps.sh, start-bot.sh, update-bot.sh (update roda `npm test` como
  gate antes do restart - se algum teste quebra, o bot em producao continua na
  versao anterior).
- Testes deterministicos em `test/nucleo.test.js` (node:test embutido). Rodar
  `npm test`. Cobrem SO o codigo (persistencia, calculo de pedido, validacao de
  area/horario/minimo, roteamento por numero) - nao o modelo nem o WhatsApp.

## Estrutura de arquivos
```
agente-ia-delivery/    (repo privado)
├── .env (ANTHROPIC_API_KEY, DONO_WHATSAPP, MOCK, PAUSA_HANDOFF_HORAS,
│         RESUME_WINDOW_HOURS, LIMPAR_HISTORICO_ANTIGO)
├── .env.example
├── .gitattributes (forca LF nos .sh)
├── setup-vps.sh / start-bot.sh / update-bot.sh
├── MARCO4.md (plano + esqueleto da API oficial adaptado para pedidos)
├── src/
│   ├── index.js          adaptador Baileys (transporte). Mapeia jid -> contactId e chama o core
│   ├── core.js           NUCLEO: cache em memoria, pausa por handoff humano, callbacks das tools
│   ├── agent.js          prompt + IA + tool use (5 ferramentas) + calculo de pedido em codigo
│   ├── config-cliente.js base por cliente (estabelecimento, horario, entrega, cardapio, pagamento, donos)
│   ├── db.js             camada de dados SQLite (isolada; trocar por Firestore = so este arquivo)
│   ├── test.js           chat no terminal usando o mesmo core (npm run chat)
│   └── check.js          diagnostico do .env (npm run check)
└── test/
    └── nucleo.test.js    testes deterministicos (npm test)
```

## Decisoes de arquitetura ja tomadas
- "Cerebro" (core/agent/db) separado do "transporte" (index.js). Migrar para API
  oficial = criar novo adaptador chamando o MESMO core. NAO mexer no nucleo.
- Cache em memoria evita ler o banco a cada mensagem; le 1x no cache miss.
  RESUME_WINDOW_HOURS decide se retoma contexto antigo. Importante para o futuro Firestore.
- Poda automatica de mensagens com +30 dias (LGPD).
- O bot ja IGNORA mensagens fromMe e mensagens vindas dos numeros do dono
  (evita loop e conversa acidental com o dono).
- PRINCIPIO GERAL (vale para tudo que vier): o MODELO conversa, o CODIGO decide os
  fatos duros. Preco, subtotal, total, area de entrega, horario, valor minimo,
  esgotamento de item = deterministico, em codigo. Linguagem natural, empatia,
  reformular pedido = modelo. Nunca deixar o modelo "calcular" ou "escolher"
  fato duro de cabeca (ele alucina/"quase acerta").
- CARDAPIO E PRECOS: implementado via TOOL USE, nao via prompt. O bot NAO ve o
  cardapio no system prompt - ele CHAMA `consultar_cardapio` quando o cliente
  pergunta. Motivo: colocar a lista no prompt gera vies do historico ("o bot
  ja disse que tinha X, continua dizendo isso mesmo com prompt atualizado").
  A ferramenta e a informacao mais RECENTE no contexto e nao compete com o
  historico. Regra: qualquer fato duro consultavel = ferramenta, nunca prompt.
- CALCULO DO PEDIDO EM CODIGO: `registrar_pedido` recebe do modelo APENAS
  `{ nome, quantidade, observacoes }` por item. O CODIGO (`calcularPedido` em
  agent.js) casa cada nome com o cardapio (case/acento-insensitive), pega o
  preco, calcula subtotal/taxa/total. Se algum item nao existir, esta esgotado,
  o bairro estiver fora da area, o subtotal estiver abaixo do minimo, ou a
  quantidade for invalida - a ferramenta devolve ERRO pro modelo ajustar e nao
  grava nada. Isso impede alucinacao de preco e pedido inaceitavel.
- 5 FERRAMENTAS:
  - `consultar_cardapio(categoria?)` - le o config, retorna formatado.
  - `verificar_horario_funcionamento()` - `statusHorario()` decide em codigo.
  - `verificar_area_entrega(bairro)` - `bairroAtendido()` decide em codigo
    (comparacao case/acento-insensitive).
  - `passar_para_humano(motivo)` - pausa a conversa por N horas + notifica dono.
  - `registrar_pedido(...)` - valida via `calcularPedido`, salva, notifica dono.
- HANDOFF HUMANO: tabela `pausas_atendimento` (jid PK + `ate` em ms). Enquanto
  ativa, `processarMensagem` retorna `resposta: null` e o transporte NAO envia
  nada ao cliente (dono conversa manualmente). Padrao 4h; env `PAUSA_HANDOFF_HORAS`
  ajusta. Expiracao e limpada dentro de `estaEmPausa` (lazy, sem cron). Nao
  ha comando de "retomar" para o dono na V1 - se ele quiser encerrar antes,
  espera expirar ou apaga na mao (`retomarAtendimento` esta exportado mas nao
  exposto ao modelo).
- SEM MODO DONO (por enquanto): na V1 o dono so RECEBE notificacoes; nao ha
  ferramenta de escrita pelo chat. Se um dia o dono quiser marcar item como
  esgotado pelo WhatsApp, a linha de menor esforco ja esta pronta: reconhecer
  por numero via `ehDono` (ja existe) + expor uma tool exclusiva no modo dono.
- BANCO IDEMPOTENTE: `CREATE TABLE IF NOT EXISTS` no boot. Deploy continua sendo
  so `git pull` + restart mesmo mudando o cardapio do config (o cardapio nao
  mora no banco - fica no config e e lido pelo agent.js quando precisa).
- TESTES: `test/nucleo.test.js` cobre o que quebra silencioso: persistencia
  (pedidos, pausas), casamento por nome (normalizarTexto/acharItemCardapio),
  validacao (bairro, horario), CALCULO do pedido (subtotal/taxa/total, recusa
  item inexistente/esgotado/bairro-fora/minimo/qtd-invalida), roteamento por
  numero. NAO cobre modelo/prompt/formatadores de texto. Regra ao adicionar
  codigo: se decide FATO DURO, escreva 2-3 testes; se so CONVERSA, ignora.
  `npm test` roda em `dados.test.db` isolado do `dados.db` real.

## Marcos
- [x] 1. MVP que responde no WhatsApp com cardapio + pedido + resumo pro dono
- [x] 2. Validacao em codigo de area de entrega, horario, valor minimo
- [x] 3. Handoff humano: tool `passar_para_humano` + pausa temporaria do bot
- [x] 4. Testes deterministicos do nucleo (`npm test`)
- [x] 5. Deploy 24/7 em VPS com PM2 (herdado do esqueleto original)
- [ ] 6. Migrar para WhatsApp Cloud API (oficial) -> ver MARCO4.md.
       So entra DEPOIS do primeiro cliente pagante.
- [ ] 7. Consentimento LGPD na 1a mensagem (frase de aviso + registro do aceite).
- [ ] 8. Painel para o dono visualizar pedidos + acao (marcar em preparo /
       entregue). Provavelmente Firestore. Manter cache p/ nao pagar leitura a toa.
- [ ] 9. Dono marcar item como esgotado pelo WhatsApp (modo dono, se validado).
- [ ] 10. V2: integracao com iFood (importar cardapio), fidelizacao, cardapio
        digital web, impressao na cozinha, multiplos enderecos salvos por cliente.

## Deploy no VPS / Hetzner (o que muda e o que nao muda)
O MECANISMO de deploy (update-bot.sh: git pull + restart do PM2) e estavel e NAO muda
na maioria das alteracoes de codigo. "Nunca muda" e forte demais; muda nestes casos:
- NOVA dependencia npm: precisa de `npm install` no VPS, nao so pull. (better-sqlite3 e
  modulo NATIVO/compilado; pacote nativo novo ou troca de versao do Node pode exigir as
  build tools no VPS - ja previstas no setup-vps.sh.)
- NOVA variavel de .env: o .env NAO esta no git (e segredo). git pull NAO traz. Tem que
  adicionar a variavel manualmente no .env do VPS, senao o bot quebra ao ler uma var que
  nao existe. Gotcha mais comum. Rodar `npm run check` apos o deploy.
- MUDANCA de schema no SQLite: NAO precisa passo manual SE a migracao for idempotente
  (CREATE TABLE IF NOT EXISTS no boot). Nao mora historico no config, so no banco.
- GATE DE TESTES: update-bot.sh roda `npm test` antes do restart. `set -e` no topo
  garante que teste quebrado ABORTA o script - o pm2 restart nao roda e o bot em
  producao segue rodando a versao anterior (safe).
- INFRA nova (futuro): a Cloud API oficial exige webhook HTTPS publico -> reverse
  proxy/TLS (nginx/caddy) alem do PM2. Firestore exige credenciais (service account)
  via .env e egress de rede.
Regua: logica pura -> so pull + restart. Lib nova -> + npm install. Var nova -> +
editar .env no VPS (manual). Infra nova -> setup adicional.

EDITAR OS .sh (setup-vps.sh / start-bot.sh / update-bot.sh): eles rodam NO VPS (Linux),
nao na maquina local. Ao alterar qualquer .sh: manter quebra de linha LF (ver
.gitattributes - CRLF do Windows quebra o script no Linux com erro de '\r'); preservar o
nome do processo PM2 'delivery-ia' (renomear afeta deploys existentes - so muda se
apagar o processo antigo no VPS com `pm2 delete <nome-antigo>`); nao assumir caminhos
da maquina local. O efeito de um .sh
se confirma NO VPS, nao localmente.

## O que NAO fazer nesta V1 (fica pra V2 e apenas se validar demanda)
- Integracao com iFood (importar cardapio automaticamente).
- Sistema de fidelizacao/cupons.
- Cardapio digital web separado.
- Trafego pago automatizado.
- Relatorios/dashboards.
- Impressao automatica na cozinha.
- Multiplos enderecos salvos por cliente.
- Gestao de estoque de ingredientes.
- Calcular tempo de entrega automatico (dono informa manualmente).
- Gerar link de pagamento PIX (so informa a chave).

**Foco V1: fazer o essencial funcionar bem - responder, coletar pedido, entregar
pro dono. Nada mais.** Manter simplicidade acima de tudo. Este e MVP pra testar
em 2 prospects reais (donos de lanchonete em Araras). Se o produto funcionar
bem, expande. Se nao, aprende rapido. **Nao sobre-engenhar.**

## Avisos permanentes
- Baileys = nao oficial. Usar SEMPRE no numero do desenvolvedor (demo/teste).
  NUNCA no numero do cliente. Numero do cliente so na API oficial, pos-venda.
- A assinatura do Claude.ai (chat) NAO inclui API. API e cobrada por uso, a parte.
- Custo estimado por cliente: ~R$40-90/mes (API Haiku + VPS).

## Proximo passo de desenvolvimento sugerido
Trabalho comercial (fora do codigo) tem prioridade agora:
1. 2 configs-cliente de exemplo reais (uma lanchonete, uma pizzaria) para demo.
2. Gravar video demo (usa o bot com uma das configs) e subir como "nao listado".
3. Testar em 2 donos de lanchonete em Araras.

No codigo: a Cloud API oficial (MARCO4.md) quando houver primeiro cliente
pagante. Painel visual de pedidos quando o dono pedir para ver o historico
sem depender do WhatsApp. Modo dono (item esgotado pelo chat) so se algum dono
pedir explicitamente - nao construir de proativo.
