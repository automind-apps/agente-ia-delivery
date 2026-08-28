# Corretor IA - atendente de WhatsApp para imobiliarias

Atende leads no WhatsApp 24/7: acolhe, tira duvidas, **qualifica**, **avisa o corretor**
com um resumo, e agora **gerencia o estoque de imoveis** (dono atualiza a disponibilidade
pelo proprio chat, cliente ve so os disponiveis).

Guarda tudo em SQLite local: retoma a conversa de onde parou, mesmo apos reiniciar.

---

## Arquitetura em uma linha

**Transporte** (Baileys/WhatsApp) -> **Nucleo** (regras) -> **Cerebro** (IA + tool use)
-> **DB** (SQLite). O modelo conversa; o **codigo decide os fatos duros**
(disponibilidade, filtro, quem e dono, ID valido).

Migrar transporte (API oficial) = escrever outro adaptador chamando o mesmo nucleo.
Migrar DB (Firestore) = reescrever `src/db.js` mantendo as mesmas funcoes exportadas.

## Estrutura do projeto

```
corretor-ia/
├── package.json
├── .env.example         modelo -> copie para ".env"
├── .env                 VOCE cria. Chave API + numero do corretor
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
│   ├── core.js           *** NUCLEO: cache, roteamento (lead vs dono), callbacks das ferramentas
│   ├── agent.js          cerebro: prompts + IA + tool use
│   ├── config-cliente.js *** PERSONALIZE por cliente *** (identidade, politicas, FAQ, imoveis, donos)
│   ├── db.js             *** CAMADA DE DADOS (SQLite). Trocar p/ Firestore = so este arquivo
│   ├── test.js           chat no terminal (modo lead ou "dono", sem WhatsApp)
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
   - `CORRETOR_WHATSAPP` = numero (com DDI+DDD) que recebera os resumos de lead.
4. `npm run check` (confere o .env).

## Configuracao por cliente (`src/config-cliente.js`)

E onde a personalizacao mora. Editar aqui + `git commit + git push` + no VPS
`bash update-bot.sh` e o bot ja atende com as novas informacoes. Campos:

| Campo | Uso |
|---|---|
| `nomeImobiliaria`, `cidade`, `bairros`, `tipos`, `horarioAtendimentoHumano` | Identidade / regiao. Vai pro system prompt. |
| `politicas[]` | O que o bot PODE afirmar sozinho. |
| `naoFaca[]` | O que o bot nunca deve fazer. |
| `faq[]` | Perguntas frequentes -> respostas prontas. |
| `donosWhatsApp[]` | **Numeros (so digitos, DDI+DDD)** reconhecidos como DONO. Podem atualizar estoque pelo chat. Deixe `[]` se ninguem for. |
| `imoveis[]` | **Catalogo do estoque**: `id`, `tipo`, `local`, `valor`, `detalhes`, `regras`. O `id` (ex.: `"IMOVEL 02"`) e o identificador estavel usado nas conversas. |

O `disponivel` **nao** mora no config - vive no banco, atualizado pelo dono via chat.

---

## Modo cliente vs modo dono

Roteamento e feito **em codigo, pelo numero** de origem (jamais por alguem dizer "sou o dono").

| | Modo cliente (lead) | Modo dono |
|---|---|---|
| Quem entra | Qualquer numero fora de `donosWhatsApp` | Numeros em `CLIENTE.donosWhatsApp` |
| O que o bot faz | Qualifica, oferece imoveis DISPONIVEIS, registra lead, avisa o corretor | So ajuda a atualizar o estoque |
| Ferramentas disponiveis (tool use) | `registrar_lead`, `listar_imoveis`, `consultar_imovel` | `listar_imoveis`, `consultar_imovel`, `atualizar_disponibilidade` |
| Pode escrever no estoque? | **Nao** (a ferramenta nem existe pra ele) | Sim |

O modelo **nao decide** disponibilidade nem existencia de imovel: **chama a ferramenta**
que consulta o banco AGORA, e repete o resultado. Isso elimina o vies do historico
("ah, mas antes so tinha o IMOVEL 02...") - fato duro sempre vem do codigo.

**Filosofia de apresentacao:** `listar_imoveis` devolve **todos** com status. O bot
mostra os DISPONIVEIS normalmente; para os INDISPONIVEIS, frisa que estao indisponiveis
e oferece **lista de espera** ao cliente (registra no `resumo` do lead como
"LISTA DE ESPERA para <ID>"). Ninguem sai da conversa sem virar lead.

**Defesas em camadas contra "cliente se passar por dono"**:
1. `ehDono(contactId)` decide em codigo pelo numero (nada de texto).
2. `TOOLS_DONO` so vao pro modelo quando `modo === 'dono'`.
3. Handler em `agent.js` recusa se o modo escapar.
4. Callback em `core.js` fica `undefined` no modo lead: sem funcao pra chamar.

---

## Como o salvamento funciona

- **Onde**: arquivo `dados.db` na maquina que roda o bot. No VPS, garanta disco
  persistente e backup regular.
- **Cache em memoria**: enquanto a conversa esta ativa, o bot NAO le o banco a cada
  mensagem. So le UMA vez no cache miss (1a mensagem, reinicio, ou contato sumido).
- **RESUME_WINDOW_HOURS**: ao reabrir uma conversa, se a ultima mensagem foi dentro
  dessa janela, retoma o contexto; se foi ha mais tempo, comeca fresco (o historico
  antigo continua salvo, so nao entra no contexto). Default: 168h (7 dias).
- **Poda LGPD**: mensagens com +30 dias sao removidas ao iniciar.
- **Anti-spam do corretor**: leads sao salvos sempre, mas o corretor so e re-notificado
  se nao houve lead do mesmo contato nas ultimas 12h.
- Cada mensagem loga `[ctx] <jid> -> memoria | banco | contato novo [dono]`.

**Tabelas no `dados.db`**:
- `mensagens` (jid, role, content, criado_em) - historico.
- `leads` (todos os campos capturados) - registros dos leads.
- `imoveis` (id PK, tipo, local, valor, detalhes, dormitorios, suites, banheiros,
  tamanho, link, disponivel, atualizado_em) - catalogo + estado atual. Semeado do
  config, atualizado pelo dono via chat.

Custo? SQLite e local, leitura em microsegundos, sem cobranca. Texto e minusculo
(milhares de conversas = poucos MB).

---

## Testar sem gastar (nesta ordem)

1. `npm run check` (zero) - confere a chave.
2. `MOCK=true npm start` (zero) - testa QR/conexao/resposta.
3. `npm test` (zero) - roda os testes automatizados do nucleo.
4. `MOCK=false npm run chat` (centavos) - chat no terminal como CLIENTE. Ajusta prompt
   e testa persistencia. "sair" e rode de novo -> ele lembra da conversa.
5. `MOCK=false npm run chat dono` (centavos) - chat no terminal como DONO
   (usa o 1o numero de `CLIENTE.donosWhatsApp`). Testa atualizacao de estoque.
6. `MOCK=false npm start` - teste real no WhatsApp.

### Testes automatizados

Rodar: `npm test`. Cobrem SO o codigo deterministico (o que quebra silencioso):
- `db.js`: persistencia de imoveis (idempotencia do seed, leitura, escrita), anti-spam de leads.
- `core.js`: `ehDono` (seguranca), `normalizarBool`, `atualizarDisponibilidade` (fato duro end-to-end).

**NAO testam** o modelo (nao deterministico) nem WhatsApp (I/O externo) - isso e teste manual.

Isolamento: os testes usam `dados.test.db` (fora do `dados.db` real) e sao zerados a cada
`npm test`. Regra ao adicionar codigo novo: se decide **fato duro**, escreva 2-3 testes;
se so **conversa**, deixe pra teste manual.

---

## Comandos

| Script | Faz |
|---|---|
| `npm start` | Liga o atendente no WhatsApp (Ctrl+C para parar). |
| `npm run chat` | Chat no terminal, **modo cliente** (usa o mesmo nucleo). |
| `npm run chat dono` | Chat no terminal, **modo dono** (simula mensagem de `donosWhatsApp[0]`). |
| `npm run check` | Confere se o `.env` esta lido corretamente. |
| `npm test` | Roda os testes automatizados do nucleo. |

Variaveis de `.env`: `ANTHROPIC_API_KEY`, `CORRETOR_WHATSAPP`, `MOCK`,
`RESUME_WINDOW_HOURS`, `LIMPAR_HISTORICO_ANTIGO`.

---

## Deploy no VPS (Hetzner Ubuntu + PM2)

```
bash setup-vps.sh       # 1a vez: instala Node, git, PM2, deps
nano .env               # cole ANTHROPIC_API_KEY e CORRETOR_WHATSAPP
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
- Schema do SQLite -> ja idempotente no boot (`CREATE TABLE IF NOT EXISTS`). Nada manual.

Comandos uteis do PM2:
- `pm2 status` - ver se esta no ar.
- `pm2 logs corretor-ia` - ver conversas/erros em tempo real.
- `pm2 restart corretor-ia` - reiniciar (apos mudar config sem `git pull`).

---

## Sobre o numero de contato do lead

O numero que vem do WhatsApp (jid) as vezes nao bate (nono digito BR / IDs internos).
Por isso o atendente PEDE o melhor numero a propria pessoa e usa esse no resumo. O
numero de origem do WhatsApp vai junto, como referencia.

## Avisos

- **Baileys = NAO oficial**. Numero de TESTE / desenvolvedor. Cliente pagante ->
  migrar para WhatsApp Cloud API (ver `MARCO4.md`).
- **A assinatura do Claude.ai (chat) NAO inclui API**. API e cobrada por uso, a parte.
- Custo estimado por cliente: ~R$40-90/mes (API Haiku + VPS).

---

## Marcos

- [x] 1. MVP que responde
- [x] 2. Notificar o corretor (tool use)
- [x] 3. Salvar conversas + leads (SQLite) e retomar contexto
- [x] 3b. Nucleo separado do transporte + 1 notificacao por conversa
- [x] 3c. Campos minimos garantidos (obrigatorios no schema)
- [x] 3d. Persistencia de leads no banco
- [x] 3e. Deploy 24/7 em VPS com PM2
- [x] 3f. Disponibilidade dinamica + atualizacao pelo dono via chat (tool use)
- [x] Testes deterministicos do nucleo (`npm test`)
- [ ] 4. Migrar para WhatsApp Cloud API (oficial) -> ver `MARCO4.md`
- [ ] 5. Painel de leads (provavelmente Firestore)
- [ ] 6. Consentimento LGPD no 1o contato
- [ ] 7. Handoff humano/bot (pausar quando o corretor responde manual)
- [ ] 8. Extensoes do nicho "donos" (filtro `buscar_unidades`, fotos, painel visual)
      - so apos VALIDAR que o nicho paga.
