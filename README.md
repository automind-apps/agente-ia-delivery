# Agente IA Delivery - atendente de WhatsApp para lanchonetes/pizzarias/restaurantes

Atende clientes no WhatsApp 24/7: acolhe, passa cardapio, **anota o pedido**,
valida area de entrega e horario, confirma tudo com o cliente, e **avisa o dono**
com o resumo estruturado do pedido. Se o pedido virar complexo, **passa pra
atendimento humano** e pausa o bot na conversa.

Guarda tudo em SQLite local: retoma a conversa de onde parou, mesmo apos reiniciar.

---

## Arquitetura em uma linha

**Transporte** (Baileys/WhatsApp) -> **Nucleo** (regras) -> **Cerebro** (IA + tool use)
-> **DB** (SQLite). O modelo conversa; o **codigo decide os fatos duros**
(preco, subtotal, total, valida area de entrega, valida horario, valida valor minimo).

Migrar transporte (API oficial) = escrever outro adaptador chamando o mesmo nucleo.
Migrar DB (Firestore) = reescrever `src/db.js` mantendo as mesmas funcoes exportadas.

## Estrutura do projeto

```
agente-ia-delivery/
├── package.json
├── .env.example         modelo -> copie para ".env"
├── .env                 VOCE cria. Chave API + numero do dono
├── .gitignore
├── dados.db             criado sozinho no 1o uso (SQLite). NAO vai pro git
├── dados.test.db        criado pelos testes. NAO vai pro git
├── auth/                sessao do WhatsApp (criada no 1o login)
├── MARCO4.md            plano da migracao para a API oficial
├── setup-vps.sh         provisiona VPS Ubuntu (Node/PM2/deps)
├── start-bot.sh         1a conexao (QR) + poe no PM2 24/7
├── update-bot.sh        pull + install + restart no VPS
├── src/
│   ├── index.js          ADAPTADOR Baileys (transporte). Fino: recebe/envia e chama o nucleo
│   ├── core.js           *** NUCLEO: cache, pausa por handoff, callbacks das ferramentas
│   ├── agent.js          cerebro: prompts + IA + tool use + calculo do pedido
│   ├── config-cliente.js *** PERSONALIZE por cliente *** (identidade, cardapio, entrega, pagamento)
│   ├── db.js             *** CAMADA DE DADOS (SQLite). Trocar p/ Firestore = so este arquivo
│   ├── test.js           chat no terminal (sem WhatsApp)
│   └── check.js          diagnostico da chave .env
└── test/
    └── nucleo.test.js    testes deterministicos (npm test)
```

---

## Instalacao (uma vez)

1. Node.js 20+.
2. `npm install` (traz `better-sqlite3` e o resto).
3. Copie `.env.example` para `.env` e preencha:
   - `ANTHROPIC_API_KEY` = sua chave da API.
   - `DONO_WHATSAPP` = numero (com DDI+DDD) que recebera os resumos de pedido.
4. `npm run check` (confere o .env).

## Configuracao por cliente (`src/config-cliente.js`)

E onde a personalizacao mora. Editar aqui + `git commit + git push` + no VPS
`bash update-bot.sh` e o bot ja atende com o novo cardapio/regras. Campos:

| Campo | Uso |
|---|---|
| `nomeEstabelecimento`, `tipoEstabelecimento`, `cidade`, `bairro` | Identidade. Vai pro system prompt. |
| `horarioFuncionamento` | Por dia da semana (`{ abre: "HH:MM", fecha: "HH:MM" }`). Vira o dia se `fecha <= abre`. |
| `bairrosAtendidos[]` | Lista dos bairros que o estabelecimento entrega (comparacao ignora acento/caixa). |
| `taxaEntregaPadrao` | R$ somado a todo pedido. |
| `tempoMedioEntrega` | String livre (ex.: `"40-60 minutos"`). |
| `valorMinimoPedido` | R$. Se o SUBTOTAL for menor, `registrar_pedido` recusa. |
| `cardapio[]` | Categorias -> itens `{ nome, descricao, preco, disponivel? }`. `nome` e o identificador (case/acento-insensitive). |
| `formasPagamento[]`, `chavePix` | Chave PIX so e informada quando o cliente escolhe PIX. |
| `observacoesEspeciais[]` | Bullets que o bot pode citar. |
| `donosWhatsApp[]` | **Numeros (so digitos, DDI+DDD)**. O 1o recebe as notificacoes; o env `DONO_WHATSAPP` sobrepoe. Mensagens vindas destes numeros SAO IGNORADAS pelo bot (evita loop). |

---

## Fluxo do pedido

1. Cliente manda mensagem. O bot:
   - Consulta cardapio (`consultar_cardapio`) se pedido.
   - Verifica bairro (`verificar_area_entrega`) antes de aceitar endereco.
   - Verifica horario (`verificar_horario_funcionamento`) se relevante.
2. Coleta itens, nome, endereco, forma de pagamento (e troco se dinheiro).
3. Confirma tudo com o cliente.
4. Chama `registrar_pedido`. O **CODIGO** (nao o modelo) casa cada item com o
   cardapio, pega o preco, calcula `subtotal` + `taxa` + `total`. Se algum item
   nao existir, esta esgotado, o bairro estiver fora da area, ou o subtotal
   estiver abaixo do minimo, a ferramenta devolve erro pro modelo ajustar.
5. Pedido salvo no banco -> resumo enviado ao dono no WhatsApp.

**Handoff humano**: se o cliente pedir para falar com atendente OU o pedido
virar complexo (evento, encomenda grande, duvida sobre alergia), o bot chama
`passar_para_humano`. A conversa entra em **pausa de N horas** (`PAUSA_HANDOFF_HORAS`,
padrao 4h): o bot fica silencioso e o dono conversa manualmente. Depois da pausa,
o bot volta a responder automaticamente.

---

## Filosofia: modelo conversa, codigo decide

O modelo NAO calcula preco, NAO decide se entrega num bairro, NAO decide se
esta aberto, NAO decide se o subtotal atinge o minimo. Tudo isso e ferramenta
(tool use) ou validacao pura em codigo. Vantagens:

- **Sem alucinacao de preco** (bug classico do modelo somando errado).
- **Sem oferecer pedido em bairro que nao atende** (recusa em `calcularPedido`).
- **Sem "vou verificar" sem fim**: o safety net anti-vacuo (`pareceVacuo`) forca
  o modelo a chamar a ferramenta na mesma turn quando ele tentar prometer
  consultar depois.

---

## Como o salvamento funciona

- **Onde**: arquivo `dados.db` na maquina que roda o bot. No VPS, garanta disco
  persistente e backup regular.
- **Cache em memoria**: enquanto a conversa esta ativa, o bot NAO le o banco a cada
  mensagem. So le UMA vez no cache miss (1a mensagem, reinicio, ou contato sumido).
- **RESUME_WINDOW_HOURS**: ao reabrir uma conversa, se a ultima mensagem foi dentro
  dessa janela, retoma o contexto; se foi ha mais tempo, comeca fresco. Default: 168h (7 dias).
- **Poda LGPD**: mensagens com +30 dias sao removidas ao iniciar.
- Cada mensagem loga `[ctx] <jid> -> memoria | banco | contato novo | pausado`.

**Tabelas no `dados.db`**:
- `mensagens` (jid, role, content, criado_em) - historico.
- `pedidos` (cliente, itens_json, subtotal, taxa, total, endereco, pagamento, status, ...) - todos os pedidos.
- `pausas_atendimento` (jid PK, ate, motivo) - handoff humano ativo.

Custo? SQLite e local, leitura em microsegundos, sem cobranca. Texto e minusculo
(milhares de conversas = poucos MB).

---

## Testar sem gastar (nesta ordem)

1. `npm run check` (zero) - confere a chave.
2. `MOCK=true npm start` (zero) - testa QR/conexao/resposta.
3. `npm test` (zero) - roda os testes automatizados do nucleo.
4. `MOCK=false npm run chat` (centavos) - chat no terminal. Simula 5-6 conversas:
   - "Boa noite, qual o cardapio?"
   - "Quero 2 X-Burguer e uma coca"
   - "Voces entregam no Jardim Europa?"
   - "Quero falar com um humano"
   - "Estao abertos?" (fora do horario)
   - Pedido completo com endereco, pagamento e confirmacao.
5. `MOCK=false npm start` - teste real no WhatsApp.

### Testes automatizados

Rodar: `npm test`. Cobrem SO o codigo deterministico (o que quebra silencioso):
- `db.js`: persistencia de pedidos e pausas.
- `agent.js`: casamento de item por nome, validacao de bairro/horario, **calculo do pedido** (subtotal/taxa/total, recusa item inexistente, esgotado, bairro fora, minimo, quantidade invalida).
- `core.js`: `ehDono` (seguranca contra loop com o proprio dono).

**NAO testam** o modelo (nao deterministico) nem WhatsApp (I/O externo) - isso e teste manual.

Isolamento: os testes usam `dados.test.db` (fora do `dados.db` real) e sao zerados a cada
`npm test`. Regra ao adicionar codigo novo: se decide **fato duro**, escreva 2-3 testes.

---

## Comandos

| Script | Faz |
|---|---|
| `npm start` | Liga o atendente no WhatsApp (Ctrl+C para parar). |
| `npm run chat` | Chat no terminal (usa o mesmo nucleo, sem WhatsApp). |
| `npm run check` | Confere se o `.env` esta lido corretamente. |
| `npm test` | Roda os testes automatizados do nucleo. |

Variaveis de `.env`: `ANTHROPIC_API_KEY`, `DONO_WHATSAPP`, `MOCK`,
`PAUSA_HANDOFF_HORAS`, `RESUME_WINDOW_HOURS`, `LIMPAR_HISTORICO_ANTIGO`.

---

## Deploy no VPS (Hetzner Ubuntu + PM2)

```
bash setup-vps.sh       # 1a vez: instala Node, git, PM2, deps
nano .env               # cole ANTHROPIC_API_KEY e DONO_WHATSAPP
bash start-bot.sh       # 1a conexao (QR) + poe no PM2 24/7
```

**Atualizar depois de um push** (na maquina local: commit + push; no VPS):
```
bash update-bot.sh      # git pull + npm install + pm2 restart
```

**Regua do que muda no deploy**:
- Logica pura -> so `git pull` + restart.
- Dependencia npm nova -> `npm install` (ja no `update-bot.sh`).
- Variavel de `.env` nova -> editar `.env` no VPS manualmente (nao vai pro git).
- Schema do SQLite -> ja idempotente no boot (`CREATE TABLE IF NOT EXISTS`).

Comandos uteis do PM2:
- `pm2 status` - ver se esta no ar.
- `pm2 logs delivery-ia` - ver conversas/erros em tempo real.
- `pm2 restart delivery-ia` - reiniciar.

---

## Avisos

- **Baileys = NAO oficial**. Numero de TESTE / desenvolvedor. Cliente pagante ->
  migrar para WhatsApp Cloud API (ver `MARCO4.md`).
- **A assinatura do Claude.ai (chat) NAO inclui API**. API e cobrada por uso, a parte.
- Custo estimado por cliente: ~R$40-90/mes (API Haiku + VPS).

---

## Marcos

- [x] 1. MVP que responde no WhatsApp
- [x] 2. Notificar o dono com resumo estruturado do pedido
- [x] 3. Cardapio + validacao de area/horario/valor minimo via tool use
- [x] 4. Registrar pedido com calculo em codigo (nunca no modelo)
- [x] 5. Handoff humano com pausa temporaria do bot
- [x] 6. Testes deterministicos do nucleo (`npm test`)
- [ ] 7. Migrar para WhatsApp Cloud API (oficial) -> ver `MARCO4.md`
- [ ] 8. Consentimento LGPD no 1o contato
- [ ] 9. Painel de pedidos (Firestore) para o dono visualizar
- [ ] 10. Integracao com iFood / gestao de estoque de itens (V2)
