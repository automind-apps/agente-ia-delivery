# Contexto do projeto "agente-ia-imobiliaria" (resumo para retomar no Claude Code)

## O que e
Atendente de IA no WhatsApp para imobiliarias/corretores. Atende leads 24/7,
qualifica (garantindo campos minimos) e notifica o corretor com um resumo do lead.
Modelo de negocio: vender como servico para corretores AUTONOMOS e imobiliarias
pequenas, posicionado como "a opcao simples e barata" (sem CRM caro, no ar em ~2 dias).
Preco: R$200/mes no plano anual ou R$300/mes mensal.

## Stack
- Node.js (ESM, "type": "module")
- @whiskeysockets/baileys (WhatsApp NAO oficial - so para demo/validacao)
- @anthropic-ai/sdk, modelo "claude-haiku-4-5-20251001", com tool use
- better-sqlite3 (persistencia local em dados.db)
- dotenv, pino, qrcode-terminal
- Roda 24/7 num VPS Hetzner (Ubuntu) gerenciado com PM2 (processo "corretor-ia").
  Scripts: setup-vps.sh, start-bot.sh, update-bot.sh (update roda `npm test` como
  gate antes do restart - se algum teste quebra, o bot em producao continua na
  versao anterior).
- Testes deterministicos em `test/nucleo.test.js` (node:test embutido). Rodar
  `npm test`. Cobrem SO o codigo (persistencia, roteamento por numero, normalizacao,
  atualizacao de estoque) - nao o modelo nem o WhatsApp.

## Estrutura de arquivos
```
agente-ia-imobiliaria/   (repo privado em github.com/automind-apps)
├── .env (ANTHROPIC_API_KEY, CORRETOR_WHATSAPP, MOCK, RESUME_WINDOW_HOURS, LIMPAR_HISTORICO_ANTIGO)
├── .env.example
├── .gitattributes (forca LF nos .sh)
├── setup-vps.sh / start-bot.sh / update-bot.sh
├── MARCO4.md (plano + esqueleto da API oficial)
├── src/
│   ├── index.js          adaptador Baileys (transporte). Mapeia jid -> contactId e chama o core
│   ├── core.js           NUCLEO: cache em memoria + regras + roteamento lead/dono
│   │                     (1 notificacao por conversa via flag conv.notificado)
│   ├── agent.js          prompt + IA + tool use (registrar_lead, listar_imoveis_disponiveis,
│   │                     consultar_imovel, listar_todos_imoveis, atualizar_disponibilidade)
│   ├── config-cliente.js  base de conhecimento por cliente (dados, politicas, FAQ, naoFaca,
│   │                     donosWhatsApp, imoveis - catalogo de estoque)
│   ├── db.js             camada de dados SQLite (isolada; trocar por Firestore = so este arquivo)
│   ├── test.js           chat no terminal usando o mesmo core (npm run chat | npm run chat dono)
│   └── check.js          diagnostico do .env (npm run check)
└── test/
    └── nucleo.test.js    testes deterministicos (npm test)
```

## Decisoes de arquitetura ja tomadas
- "Cerebro" (core/agent/db) separado do "transporte" (index.js). Migrar para API
  oficial = criar novo adaptador chamando o MESMO core. NAO mexer no nucleo.
- Cache em memoria evita ler o banco a cada mensagem; le 1x no cache miss.
  RESUME_WINDOW_HOURS decide se retoma contexto antigo. Importante para o futuro Firestore.
- Notificacao ao corretor: EXATAMENTE 1x por conversa (flag em memoria) + trava de
  12h cross-restart no banco.
- Campos minimos (nome, intencao, tipo_imovel, bairro, faixa_valor) sao OBRIGATORIOS
  no input_schema da ferramenta registrar_lead. Se a pessoa nao sabe, registra
  "nao definido" (valido), mas o modelo e forcado a perguntar.
- Poda automatica de mensagens com +30 dias (LGPD).
- O bot ja IGNORA mensagens fromMe (nao responde a si mesmo; sem loop).
- PRINCIPIO GERAL (vale para tudo que vier): o MODELO conversa, o CODIGO decide os
  fatos duros. Preco, quantidade, disponibilidade, filtros = deterministico, em codigo
  (tool use). Linguagem natural, empatia, reformular pedido = modelo. Nunca deixar o
  modelo "calcular" ou "escolher" fato duro de cabeca (ele alucina/"quase acerta").
- ESTOQUE / DISPONIBILIDADE: implementado via TOOL USE, nao via prompt. O bot NAO
  ve a lista de imoveis no system prompt - ele CHAMA `listar_imoveis` /
  `consultar_imovel` a cada mensagem que pergunta sobre imoveis, e o codigo retorna
  o estado real do banco. Lecao pratica desta sessao: tentativas de "colocar a lista
  no prompt e pedir pro modelo filtrar" falharam repetidamente por vies do historico
  (ex.: bot ja disse "so temos IMOVEL 02", continuava dizendo isso mesmo com prompt
  atualizado). Tool use resolve porque o resultado da ferramenta e a informacao mais
  RECENTE no contexto, sem competir com o historico. Regra: qualquer fato duro
  consultavel = ferramenta, nunca prompt.
- FERRAMENTA UNICA `listar_imoveis`: retorna TODOS os imoveis com o campo STATUS
  de cada um. Nao ha versao "so disponiveis" - o prompt do modo LEAD instrui o bot
  a apresentar disponivel normalmente e, quando INDISPONIVEL, frisar e oferecer
  LISTA DE ESPERA (imovel indisponivel = candidato natural a lead). O modo DONO
  usa a mesma ferramenta + `atualizar_disponibilidade` para escrever. Escolha de
  design: filtragem por disponibilidade e responsabilidade do PROMPT (comportamento
  ao apresentar), nao do codigo (que so devolve o estado bruto do banco).
- MODO DONO: roteado ja na entrada do core, pelo NUMERO em `CLIENTE.donosWhatsApp`
  (nunca por texto). Modo dono recebe TOOLS_DONO (listar_imoveis, consultar_imovel,
  atualizar_disponibilidade); modo lead recebe TOOLS_LEAD (registrar_lead,
  listar_imoveis, consultar_imovel). Defesa em camadas contra cliente se passar
  por dono: (1) ehDono decide em codigo; (2) `atualizar_disponibilidade` nem entra
  no set enviado ao modelo em modo lead; (3) handler no agent.js recusa se o modo
  escapar; (4) callback no core.js e `undefined` no modo lead - sem funcao para
  chamar. Todos os 4 sao cobertos por teste.
- NORMALIZACAO DE INPUT DA FERRAMENTA: `normalizarBool` aceita boolean, "true"/"false",
  0/1, "sim"/"nao" e "disponivel"/"indisponivel". Retorna null se nao souber - FALHA
  ABERTO em vez de gravar valor errado. Padrao para toda ferramenta nova que receba
  algo mais complexo que string: normalizar em codigo, rejeitar bizarro sem tocar
  no banco, devolver mensagem clara para o modelo tentar de novo.
- BANCO IDEMPOTENTE: `seedImoveis` no boot usa `INSERT ... ON CONFLICT DO UPDATE`
  que atualiza descricao mas PRESERVA o disponivel do banco. Config e semente;
  banco vira fonte da verdade a partir do 1o boot. Deploy continua sendo pull +
  restart mesmo alterando o catalogo do config.
- TESTES: `test/nucleo.test.js` cobre o que quebra silencioso (persistencia,
  seguranca, escrita). NAO cobre modelo/prompt/formatadores. Regra ao adicionar
  codigo: se decide FATO DURO, escreva 2-3 testes; se so CONVERSA, ignora. Cada
  bug de codigo cacado deve virar teste de regressao. `npm test` roda em
  `dados.test.db` isolado do `dados.db` real.

## Marcos
- [x] 1. MVP que responde no WhatsApp
- [x] 2. Notificar o corretor com resumo do lead (tool use)
- [x] 3. Persistencia SQLite + retomar contexto + cache em memoria
- [x] 3b. Nucleo separado do transporte + 1 notificacao por conversa
- [x] 3c. Campos minimos garantidos (obrigatorios no schema)
- [x] 3d. Persistencia de leads no banco (salvarLead + trava anti-duplicidade 12h)
- [x] 3e. Deploy 24/7 em VPS com PM2
- [x] 3f. Disponibilidade dinamica por imovel + atualizacao por chat pelo proprio
       dono (reconhecido por NUMERO). Precursor MINIMO do marco 8 (sem filtro
       buscar_unidades, sem fotos, sem painel visual). Consulta via tool use, nao
       via prompt.
- [x] 3g. Testes deterministicos do nucleo (`npm test`), gate no update-bot.sh.
- [ ] 4. Migrar para WhatsApp Cloud API (oficial) -> ver MARCO4.md.
       So entra DEPOIS do primeiro cliente pagante. Exige Business Manager
       verificado, WABA, numero dedicado, webhook HTTPS, templates aprovados.
- [ ] 5. Firestore + painel de leads para o corretor. Manter o cache para nao
       pagar leitura a toa. Reescrever apenas db.js mantendo as funcoes exportadas.
- [ ] 6. Consentimento LGPD na 1a mensagem (frase de aviso + registro do aceite).
- [ ] 7. Handoff humano/bot: quando o corretor responde manualmente numa conversa
       (mensagem fromMe naquele contato), o bot deve PAUSAR naquela conversa por X
       horas para nao atropelar o humano (evitar bot e corretor respondendo juntos
       e se contradizendo). O bot ja ignora fromMe (nao responde a si mesmo), entao
       nao ha loop; falta a logica de pausar/retomar por conversa. Implementar junto
       com o marco 4 (so vira problema real quando o cliente opera no proprio numero).
- [ ] 8. (CONDICIONAL - so apos VALIDAR que o nicho de donos de imoveis paga; ver
       secao "Nicho secundario" abaixo.) Funcionalidades do nicho de donos:
       a) filtro de unidades via ferramenta buscar_unidades;
       b) envio de fotos por unidade via ferramenta enviar_fotos_da_unidade;
       c) painel de auto-edicao de estoque pelo proprio dono (extensao do marco 5).

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
  (CREATE TABLE IF NOT EXISTS no boot). Exemplo real: a tabela `imoveis` foi criada
  assim no marco 3f e a tabela antiga `disponibilidade` foi descartada com
  `DROP TABLE IF EXISTS` na mesma migracao - deploy foi so pull + restart.
- GATE DE TESTES: update-bot.sh roda `npm test` antes do restart. `set -e` no topo
  garante que teste quebrado ABORTA o script - o pm2 restart nao roda e o bot em
  producao segue rodando a versao anterior (safe). Custo: testes tem que passar
  localmente antes do push; nao pode ter teste flaky.
- INFRA nova (futuro): marco 4 (Cloud API) exige webhook HTTPS publico -> reverse
  proxy/TLS (nginx/caddy) alem do PM2. Marco 5 (Firestore) exige credenciais (service
  account) via .env e egress de rede. Esses SIM mudam o deploy de verdade.
Regua: logica pura -> so pull + restart. Lib nova -> + npm install. Var nova -> +
editar .env no VPS (manual). Infra nova (marco 4/5) -> setup adicional.

EDITAR OS .sh (setup-vps.sh / start-bot.sh / update-bot.sh): eles rodam NO VPS (Linux),
nao na maquina local. Ao alterar qualquer .sh: manter quebra de linha LF (ver
.gitattributes - CRLF do Windows quebra o script no Linux com erro de '\r'); preservar o
nome do processo PM2 'corretor-ia' (nome errado = restart nao acha o processo); nao
assumir caminhos da maquina local. O efeito de um .sh se confirma NO VPS, nao localmente.

## Nicho secundario (FUTURO - VALIDAR PRIMEIRO): donos de imoveis (kitnets/flats/etc)
Insight de campo: existem donos de varias unidades (kitnets, flats, apartamentos)
que NAO sao corretores, mas precisam responder todos os interessados (valor, o que
esta incluso, regras, disponibilidade) e nem sempre conseguem responder na hora.
Mesmo produto, MESMO motor (core/agent/db); muda so o config-cliente.js. A dor e
diferente da do corretor: nao e "vender mais", e "parar de ser secretaria do proprio
WhatsApp". Filtro de prospeccao tambem muda: procurar quem tem MUITAS unidades (volume
de mensagem = dor real), nao quem tem 1 so.

AVISO DE PRIORIDADE: este nicho difere do foco atual (corretores). NAO investir
desenvolvimento aqui antes de VALIDAR que ele paga. Sequencia: foco corretor primeiro
-> testar o nicho de donos com config manual em poucos clientes -> so depois construir
as funcionalidades abaixo. Reavaliar tambem o MODELO DE PRECO para donos: a dor so
existe quando ha vaga; unidade alugada = silencio = ele questiona a mensalidade. Quem
tem muitas unidades com rotatividade justifica o mensal; quem tem 2-3 estaveis, talvez
nao. Validar antes de assumir que o preco dos corretores cola igual.
NOTA: o marco 3f (disponibilidade dinamica + update por chat) ja foi construido -
era o pedaco MINIMO desse nicho que valia adiantar por ser barato. O filtro/fotos/
painel (itens abaixo) sao o que ainda espera a validacao.

### Spec tecnica (para quando o nicho for validado)

1) BASE DE DADOS DE UNIDADES (estruturada, NAO solta no prompt)
   - Cada cliente-dono tem uma LISTA de unidades; cada unidade e um objeto com campos
     padronizados. Mora no banco (via db.js), igual ao resto. NAO jogar todas as
     unidades inteiras no prompt em toda mensagem (custo de token + o modelo se perde).
     So o RECORTE relevante da conversa vai para o contexto.
   - Campos sugeridos por unidade (ajustar conforme o que o interessado pergunta):
     id, tipo (kitnet/flat/apto), bairro, endereco_aprox, valor_aluguel, condominio,
     incluso (agua/luz/internet/iptu), tamanho_m2, quartos, mobiliado (bool),
     aceita_pet (bool), garantia (fiador/caucao/seguro-fianca), contrato_minimo,
     regra_rescisao, disponivel (bool), fotos (lista de URLs), obs.

2) FILTRO DE IMOVEIS - ferramenta buscar_unidades(filtros) [NAO PODE ERRAR]
   - O FILTRO E FEITO EM CODIGO (.filter sobre a lista), nunca na cabeca do modelo.
     O modelo so APRESENTA o que a funcao retornar. (Aplica o principio geral acima.)
   - Filtros tipicos: quartos, valor_max, mobiliado, aceita_pet, bairro, tipo.
   - Por padrao filtra disponivel=true (nunca oferecer unidade indisponivel).
   - Retorno VAZIO deve ser explicito -> prompt instrui o bot a dizer "nao tenho nada
     nesse perfil agora" (e, se quiser, oferecer o mais proximo) e NAO inventar unidade.
     Esse e o cenario de alucinacao mais comum; resolver no design da ferramenta.

3) FOTOS - ferramenta enviar_fotos_da_unidade(unidade_id)
   - Cada unidade tem campo fotos (lista de URLs/caminhos). Mesma mecanica de tool use
     do registrar_lead, mas a acao e enviar midia em vez de notificar.
   - Envio de midia e NATIVO na Cloud API (marco 4) - recurso de 1a classe la. No
     Baileys (demo) tambem da, mas nao priorizar agora; brilhar com foto so na oficial.
   - Preferir envio SOB DEMANDA (interessado pede "tem foto?") a envio nao solicitado
     (foto nao pedida em conversa fria pesa no spam e na experiencia).

4) PAINEL DE AUTO-EDICAO DE ESTOQUE (extensao do marco 5 - Firestore + painel)
   - O dono marca a unidade como alugada/indisponivel por um controle VISUAL (toggle
     ou check) no painel, sem precisar te ligar. buscar_unidades passa a so devolver
     disponivel=true -> o bot NUNCA oferece unidade ja alugada/indisponivel.
   - Resolve o gargalo OPERACIONAL real do nicho: manter o estoque atualizado. Hoje
     (sem painel) quem atualiza e VOCE (manual) -> nao escala para muitos clientes.
     Assim que o nicho provar que vende, este painel vira prioridade, pois e o que
     torna o nicho operavel em escala. (O update por chat do marco 3f e a ponte
     ate o painel existir.)
   - Implementacao acompanha o marco 5: reescrever apenas db.js mantendo as funcoes
     exportadas; buscar_unidades continua chamando as mesmas funcoes, muda so de onde
     elas leem (SQLite -> Firestore). Nao retrabalha o agent.js.

5) COLETA DE DADOS (processo, nao codigo)
   - O gargalo de onboarding e coletar a info do dono (dados espalhados). Montar um
     checklist padrao (1 unidade por linha, campos fixos) e preencher JUNTO com o dono
     na reuniao - mesmo metodo de "construcao lado a lado" usado com corretor. Resolve
     a coleta e ainda fecha venda (efeito de co-criacao).

## Avisos permanentes
- Baileys = nao oficial. Usar SEMPRE no numero do desenvolvedor (demo/teste).
  NUNCA no numero do cliente. Numero do cliente so na API oficial, pos-venda.
- A assinatura do Claude.ai (chat) NAO inclui API. API e cobrada por uso, a parte.
- Custo estimado por cliente: ~R$40-90/mes (API Haiku + VPS).

## Proximo passo de desenvolvimento sugerido
Trabalho comercial (fora do codigo) tem prioridade agora:
1. 3 configs-cliente de exemplo (residencial, comercial, corretor autonomo) + um
   seletor via env (`CLIENTE_ATIVO`) para trocar entre eles na demo lado a lado.
   Barato, e ajuda no pitch. Exige criar `src/clientes/*.js` e um pequeno indice.
2. Landing simples (projeto SEPARADO, repo novo, deploy Vercel) para mandar UM link
   com video + botao WhatsApp em vez de anexar arquivo. Ver conversa em separado.
3. Gravar video demo (usa o bot com uma das 3 configs) e subir como "nao listado"
   no YouTube.

No codigo: Marco 4 (API oficial) quando houver primeiro cliente pagante; junto com
ele, o marco 7 (handoff). Marco 5 (Firestore + painel) quando a prioridade for o
corretor/dono visualizar e editar pela tela. O esqueleto do server-oficial.js esta
no MARCO4.md e ja chama processarMensagem do core.js.
O marco 8 completo (filtro + fotos + painel) so entra APOS validar que o nicho de donos
paga - ate la, atender donos com config manual + o update por chat ja construido.
