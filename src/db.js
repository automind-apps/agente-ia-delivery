// src/db.js
// ==========================================================================
// CAMADA DE DADOS - isolada de proposito.
// Hoje usa SQLite (better-sqlite3). Se um dia trocar para Firebase, voce
// reescreve SO este arquivo, mantendo as mesmas funcoes exportadas.
//   carregarHistorico(jid), salvarMensagem(jid, role, content),
//   salvarPedido(jid, dados) / listarPedidos(),
//   pausarAtendimento(jid, horas) / estaEmPausa(jid),
//   podarMensagensAntigas(dias) / limparContato(jid).
// O resto do projeto nao muda.
// ==========================================================================
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// O arquivo do banco fica na RAIZ do projeto (um nivel acima de src/).
// Pode ser sobrescrito via env DB_PATH - usado nos testes para isolar o banco.
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'dados.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // melhor desempenho e seguranca contra corrupcao

// Cria as tabelas se ainda nao existirem.
db.exec(`
  CREATE TABLE IF NOT EXISTS mensagens (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    jid       TEXT NOT NULL,
    role      TEXT NOT NULL,         -- 'user' ou 'assistant'
    content   TEXT NOT NULL,
    criado_em INTEGER NOT NULL       -- timestamp em ms
  );
  CREATE INDEX IF NOT EXISTS idx_mensagens_jid ON mensagens(jid);

  CREATE TABLE IF NOT EXISTS pedidos (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    jid               TEXT NOT NULL,
    cliente_nome      TEXT,
    cliente_telefone  TEXT,
    itens_json        TEXT NOT NULL,     -- JSON: [{nome, quantidade, observacoes, preco_unitario, subtotal}]
    subtotal          REAL NOT NULL,
    taxa_entrega      REAL NOT NULL,
    total             REAL NOT NULL,
    endereco          TEXT,
    bairro            TEXT,
    referencia        TEXT,
    forma_pagamento   TEXT,
    troco_para        REAL,              -- so quando pagamento = dinheiro
    observacoes       TEXT,              -- observacoes gerais do pedido
    status            TEXT DEFAULT 'aguardando_confirmacao',
    criado_em         INTEGER NOT NULL,  -- timestamp ms: quando o pedido foi confirmado
    previsao_entrega  INTEGER            -- timestamp ms: previsao de entrega (criado_em + tempoMedioEntrega)
  );
  CREATE INDEX IF NOT EXISTS idx_pedidos_jid ON pedidos(jid);
`);

// Migracao idempotente: adiciona coluna previsao_entrega em bancos que ja existem
// sem essa coluna. ALTER TABLE ADD COLUMN falha se a coluna ja existe - try/catch trata.
try {
  db.exec(`ALTER TABLE pedidos ADD COLUMN previsao_entrega INTEGER`);
} catch (e) {
  if (!/duplicate column name/i.test(e?.message || '')) throw e;
}

db.exec(`

  -- Handoff humano: quando cliente pede pra falar com atendente humano OU o
  -- pedido e complexo, o bot pausa aquela conversa por N horas. Enquanto
  -- estiver aqui e nao expirou, o bot NAO responde (o dono conversa manualmente).
  CREATE TABLE IF NOT EXISTS pausas_atendimento (
    jid         TEXT PRIMARY KEY,
    ate         INTEGER NOT NULL,       -- timestamp em ms (expira depois disso)
    motivo      TEXT,
    criado_em   INTEGER NOT NULL
  );
`);

// Quantas mensagens recentes recarregar como contexto ao retomar a conversa.
const LIMITE_CONTEXTO = 20;

// --- Historico ---
export function carregarHistorico(jid) {
  const linhas = db
    .prepare(
      `SELECT role, content FROM mensagens
       WHERE jid = ? ORDER BY id DESC LIMIT ?`
    )
    .all(jid, LIMITE_CONTEXTO);
  // veio do mais novo para o mais antigo; inverte para ordem cronologica
  return linhas.reverse().map((l) => ({ role: l.role, content: l.content }));
}

export function salvarMensagem(jid, role, content) {
  db.prepare(
    `INSERT INTO mensagens (jid, role, content, criado_em) VALUES (?, ?, ?, ?)`
  ).run(jid, role, content, Date.now());
}

// Timestamp (ms) da ultima mensagem deste contato, ou null se nao houver.
export function ultimaMensagemMs(jid) {
  const linha = db
    .prepare(`SELECT MAX(criado_em) AS ultima FROM mensagens WHERE jid = ?`)
    .get(jid);
  return linha?.ultima || null;
}

// Remove mensagens mais antigas que X dias (privacidade/LGPD + nao acumular).
// Chame de vez em quando (o core.js chama ao iniciar).
export function podarMensagensAntigas(dias = 30) {
  const limite = Date.now() - dias * 24 * 60 * 60 * 1000;
  const r = db.prepare(`DELETE FROM mensagens WHERE criado_em < ?`).run(limite);
  return r.changes;
}

// Remove todas as mensagens de um contato (usado ao iniciar nova conversa apos
// gap longo, se LIMPAR_HISTORICO_ANTIGO=true). Nao apaga os pedidos.
export function limparContato(jid) {
  const r = db.prepare(`DELETE FROM mensagens WHERE jid = ?`).run(jid);
  return r.changes;
}

// --- Pedidos ---
// Salva o pedido ja com valores CALCULADOS pelo codigo (nao pelo modelo).
// itens = [{nome, quantidade, observacoes, preco_unitario, subtotal}].
// Retorna o id do pedido (numero visivel pro dono).
export function salvarPedido(jid, d) {
  const agora = Date.now();
  const r = db
    .prepare(
      `INSERT INTO pedidos
         (jid, cliente_nome, cliente_telefone, itens_json, subtotal, taxa_entrega,
          total, endereco, bairro, referencia, forma_pagamento, troco_para,
          observacoes, status, criado_em, previsao_entrega)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      jid,
      d.cliente_nome || null,
      d.cliente_telefone || null,
      JSON.stringify(d.itens || []),
      Number(d.subtotal || 0),
      Number(d.taxa_entrega || 0),
      Number(d.total || 0),
      d.endereco || null,
      d.bairro || null,
      d.referencia || null,
      d.forma_pagamento || null,
      d.troco_para != null ? Number(d.troco_para) : null,
      d.observacoes || null,
      d.status || 'aguardando_confirmacao',
      agora,
      d.previsao_entrega != null ? Number(d.previsao_entrega) : null
    );
  return { id: r.lastInsertRowid, criado_em: agora };
}

// Retorna o ultimo pedido registrado para este contato (ou null). Usado quando
// o cliente pergunta "cade meu pedido?" - o bot precisa dos timestamps para
// responder com data/hora reais, nao chutar.
export function ultimoPedidoDoContato(jid) {
  return db
    .prepare(`SELECT * FROM pedidos WHERE jid = ? ORDER BY id DESC LIMIT 1`)
    .get(jid);
}

// Utilitario opcional: listar pedidos (para um futuro painel / relatorio).
export function listarPedidos(limite = 50) {
  return db
    .prepare(`SELECT * FROM pedidos ORDER BY id DESC LIMIT ?`)
    .all(limite);
}

// --- Pausas de atendimento (handoff humano) ---
// Marca a conversa como "humano assumiu" por N horas. Se ja houver pausa
// ativa, ATUALIZA o vencimento (renova).
export function pausarAtendimento(jid, horas = 4, motivo = null) {
  const ate = Date.now() + horas * 60 * 60 * 1000;
  db.prepare(
    `INSERT INTO pausas_atendimento (jid, ate, motivo, criado_em)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       ate = excluded.ate,
       motivo = excluded.motivo,
       criado_em = excluded.criado_em`
  ).run(jid, ate, motivo, Date.now());
  return ate;
}

// Retorna { ate, motivo } se ha pausa ativa, ou null. Se a pausa expirou,
// remove e retorna null (limpa sozinho, sem cron).
export function estaEmPausa(jid) {
  const linha = db
    .prepare(`SELECT ate, motivo FROM pausas_atendimento WHERE jid = ?`)
    .get(jid);
  if (!linha) return null;
  if (Date.now() >= linha.ate) {
    db.prepare(`DELETE FROM pausas_atendimento WHERE jid = ?`).run(jid);
    return null;
  }
  return { ate: linha.ate, motivo: linha.motivo };
}

// Remove pausa manualmente (utilitario; nao exposto ao modelo).
export function retomarAtendimento(jid) {
  const r = db.prepare(`DELETE FROM pausas_atendimento WHERE jid = ?`).run(jid);
  return r.changes > 0;
}
