// src/db.js
// ==========================================================================
// CAMADA DE DADOS - isolada de proposito.
// Hoje usa SQLite (better-sqlite3). Se um dia trocar para Firebase, voce
// reescreve SO este arquivo, mantendo as mesmas funcoes exportadas:
//   carregarHistorico(jid), salvarMensagem(jid, role, content),
//   salvarLead(jid, dados), podeRegistrarLead(jid), marcarLeadRegistrado(jid)
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

  CREATE TABLE IF NOT EXISTS leads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    jid             TEXT NOT NULL,
    nome            TEXT,
    intencao        TEXT,
    tipo_imovel     TEXT,
    bairro          TEXT,
    quartos         TEXT,
    faixa_valor     TEXT,
    forma_pagamento TEXT,
    urgencia        TEXT,
    telefone_contato TEXT,
    resumo          TEXT,
    criado_em       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leads_jid ON leads(jid);

  -- Imoveis (catalogo + disponibilidade num lugar so).
  -- O CATALOGO tem semente no config-cliente.js (facil de editar), mas a partir do
  -- boot o BANCO passa a ser a fonte da verdade: quem le imoveis SEMPRE le daqui.
  -- Migracao idempotente: roda no boot, deploy continua sendo so pull + restart.
  CREATE TABLE IF NOT EXISTS imoveis (
    id            TEXT PRIMARY KEY,           -- ex.: "1", "IMOVEL 02"
    tipo          TEXT,
    local         TEXT,
    valor         TEXT,
    detalhes      TEXT,
    regras        TEXT,                       -- legado; nao mais usado
    dormitorios   INTEGER,
    suites        INTEGER,
    banheiros     INTEGER,
    tamanho       TEXT,
    link          TEXT,
    disponivel    INTEGER NOT NULL DEFAULT 1, -- 1 = disponivel, 0 = indisponivel
    atualizado_em INTEGER NOT NULL
  );
  -- Substituida pela tabela "imoveis" acima (que ja tem disponivel).
  DROP TABLE IF EXISTS disponibilidade;
`);

// Migracao idempotente: adiciona colunas novas em bancos que ja existem.
// `ALTER TABLE ADD COLUMN` do SQLite falha se a coluna ja existe - por isso o try/catch.
// Bancos novos ja tem as colunas pelo CREATE TABLE acima; aqui e so pra bancos velhos.
for (const col of [
  'dormitorios INTEGER',
  'suites INTEGER',
  'banheiros INTEGER',
  'tamanho TEXT',
  'link TEXT',
]) {
  try {
    db.exec(`ALTER TABLE imoveis ADD COLUMN ${col}`);
  } catch (e) {
    if (!/duplicate column name/i.test(e?.message || '')) throw e;
  }
}

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
// Chame de vez em quando (o index.js chama ao iniciar).
export function podarMensagensAntigas(dias = 30) {
  const limite = Date.now() - dias * 24 * 60 * 60 * 1000;
  const r = db.prepare(`DELETE FROM mensagens WHERE criado_em < ?`).run(limite);
  return r.changes; // quantas linhas removidas
}

// --- Leads ---
export function salvarLead(jid, d) {
  db.prepare(
    `INSERT INTO leads
       (jid, nome, intencao, tipo_imovel, bairro, quartos, faixa_valor,
        forma_pagamento, urgencia, telefone_contato, resumo, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    jid,
    d.nome || null,
    d.intencao || null,
    d.tipo_imovel || null,
    d.bairro || null,
    d.quartos || null,
    d.faixa_valor || null,
    d.forma_pagamento || null,
    d.urgencia || null,
    d.telefone_contato || null,
    d.resumo || null,
    Date.now()
  );
}

// Evita notificar o corretor varias vezes pela MESMA conversa.
// Regra: so bloqueia se ja houve um lead deste contato nas ultimas X horas.
// Assim, se a pessoa volta dias depois com outra intencao, um novo lead pode
// ser registrado normalmente.
const JANELA_ANTI_DUPLICADO_MS = 12 * 60 * 60 * 1000; // 12 horas

export function podeRegistrarLead(jid) {
  const ultimo = db
    .prepare(`SELECT criado_em FROM leads WHERE jid = ? ORDER BY id DESC LIMIT 1`)
    .get(jid);
  if (!ultimo) return true;
  return Date.now() - ultimo.criado_em > JANELA_ANTI_DUPLICADO_MS;
}

// Remove todas as mensagens de um contato (usado ao iniciar nova conversa apos
// gap longo, se LIMPAR_HISTORICO_ANTIGO=true). Nao apaga os leads.
export function limparContato(jid) {
  const r = db.prepare(`DELETE FROM mensagens WHERE jid = ?`).run(jid);
  return r.changes;
}

// Utilitario opcional: listar leads (para um futuro painel / relatorio).
export function listarLeads(limite = 50) {
  return db
    .prepare(`SELECT * FROM leads ORDER BY id DESC LIMIT ?`)
    .all(limite);
}

// --- Imoveis (catalogo + disponibilidade) ---
// Colunas selecionadas por todas as leituras (fonte unica). Se adicionar campo
// novo em imoveis, incluir aqui e no seedImoveis abaixo.
const COLUNAS_IMOVEL = [
  'id',
  'tipo',
  'local',
  'valor',
  'detalhes',
  'dormitorios',
  'suites',
  'banheiros',
  'tamanho',
  'link',
  'disponivel',
].join(', ');

// Semeia/atualiza o catalogo a partir do config-cliente.js.
// - Se o imovel ainda nao existe no banco, insere com disponivel=1.
// - Se ja existe, ATUALIZA a descricao mas PRESERVA o disponivel (o que o dono
//   ja ajustou no chat continua valendo entre restarts).
export function seedImoveis(imoveis = []) {
  const stmt = db.prepare(
    `INSERT INTO imoveis
       (id, tipo, local, valor, detalhes, dormitorios, suites, banheiros, tamanho, link, disponivel, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET
       tipo = excluded.tipo,
       local = excluded.local,
       valor = excluded.valor,
       detalhes = excluded.detalhes,
       dormitorios = excluded.dormitorios,
       suites = excluded.suites,
       banheiros = excluded.banheiros,
       tamanho = excluded.tamanho,
       link = excluded.link,
       atualizado_em = excluded.atualizado_em`
  );

  // Aceita string ou numero para os campos numericos (o config usa strings tipo '3').
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const agora = Date.now();
  const tx = db.transaction((lista) => {
    for (const im of lista) {
      stmt.run(
        im.id,
        im.tipo || null,
        im.local || null,
        im.valor || null,
        im.detalhes || null,
        num(im.dormitorios),
        num(im.suites),
        num(im.banheiros),
        im.tamanho || null,
        im.link || null,
        agora
      );
    }
  });
  tx(imoveis);
}

// TODOS os imoveis com status (para lead E dono). O modelo/prompt e quem decide
// como apresentar: para o cliente, disponivel se oferece normalmente, indisponivel
// se frisa "indisponivel" e oferece lista de espera; para o dono, mostra os dois.
export function listarImoveis() {
  return db
    .prepare(`SELECT ${COLUNAS_IMOVEL} FROM imoveis ORDER BY id`)
    .all();
}

// Consulta 1 imovel especifico (para o cliente perguntar "e o imovel 1?").
export function consultarImovel(imovelId) {
  return db
    .prepare(`SELECT ${COLUNAS_IMOVEL} FROM imoveis WHERE id = ?`)
    .get(imovelId);
}

// Muda o disponivel de UM imovel. Retorna true se a linha existia e foi atualizada.
export function setDisponibilidade(imovelId, disponivel) {
  const r = db
    .prepare(`UPDATE imoveis SET disponivel = ?, atualizado_em = ? WHERE id = ?`)
    .run(disponivel ? 1 : 0, Date.now(), imovelId);
  return r.changes > 0;
}
