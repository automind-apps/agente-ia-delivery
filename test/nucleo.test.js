// test/nucleo.test.js
// ==========================================================================
// TESTES DETERMINISTICOS DO NUCLEO.
// Rodar: npm test
//
// Cobrem SO o que e codigo/fato duro: SQLite (persistencia), roteamento por
// numero (ehDono), resolucao de ID e normalizacao de bool. NAO testam:
//  - o modelo (nao deterministico, cobrado por chamada);
//  - o WhatsApp (I/O externo);
//  - formatadores de texto do agent.js (baixo risco, mudam com o prompt).
//
// Isolamento: usa DB_PATH = dados.test.db (arquivo separado). O DB real
// (dados.db) NAO e tocado. Cada execucao comeca com o arquivo de teste zerado.
// ==========================================================================
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = join(__dirname, '..', 'dados.test.db');

// IMPORTANTE: setar DB_PATH ANTES de importar db.js/core.js (o db.js le no load).
process.env.DB_PATH = TEST_DB;

// Zera qualquer resto de execucao anterior (WAL/SHM tambem).
for (const p of [TEST_DB, TEST_DB + '-shm', TEST_DB + '-wal']) {
  if (existsSync(p)) unlinkSync(p);
}

// Silencia console.log durante testes - o atualizarDisponibilidade e ruidoso.
// (Erros continuam aparecendo via console.error/assert.)
console.log = () => {};

const db = await import('../src/db.js');
const core = await import('../src/core.js');
const agent = await import('../src/agent.js');
const { CLIENTE } = await import('../src/config-cliente.js');

// ============================================================================
// db.js - persistencia
// ============================================================================
describe('db.js - imoveis (catalogo + disponibilidade)', () => {
  test('seedImoveis insere novo imovel com disponivel=1 (default)', () => {
    db.seedImoveis([{ id: 'T-INSERT', tipo: 'apto', local: 'x', valor: '1' }]);
    const r = db.consultarImovel('T-INSERT');
    assert.equal(r.id, 'T-INSERT');
    assert.equal(r.disponivel, 1);
    assert.equal(r.tipo, 'apto');
  });

  test('seedImoveis persiste os campos NOVOS (dormitorios, suites, banheiros, tamanho, link)', () => {
    db.seedImoveis([
      {
        id: 'T-CAMPOS',
        tipo: 'Casa',
        local: 'Rua X, 1',
        valor: '500000',
        dormitorios: '3',   // config vem como string
        suites: '1',
        banheiros: '2',
        tamanho: '150 m2',
        detalhes: 'garagem',
        link: 'https://exemplo.com/imovel/1',
      },
    ]);
    const r = db.consultarImovel('T-CAMPOS');
    assert.equal(r.dormitorios, 3);   // string convertida para numero
    assert.equal(r.suites, 1);
    assert.equal(r.banheiros, 2);
    assert.equal(r.tamanho, '150 m2');
    assert.equal(r.link, 'https://exemplo.com/imovel/1');
    assert.equal(r.detalhes, 'garagem');
  });

  test('seedImoveis e IDEMPOTENTE: preserva disponivel do banco e atualiza descricao', () => {
    // Cenario chave para deploy: config muda tipo/valor, mas o dono ja marcou
    // como indisponivel via chat. O restart NAO pode zerar isso.
    db.seedImoveis([{ id: 'T-UPSERT', tipo: 'v1' }]);
    db.setDisponibilidade('T-UPSERT', false);
    db.seedImoveis([{ id: 'T-UPSERT', tipo: 'v2', valor: 'novo' }]);
    const r = db.consultarImovel('T-UPSERT');
    assert.equal(r.disponivel, 0, 'disponivel do dono deve ser preservado');
    assert.equal(r.tipo, 'v2', 'descricao deve ser atualizada pelo config');
    assert.equal(r.valor, 'novo');
  });

  test('setDisponibilidade retorna true quando linha existe e escreve o valor', () => {
    db.seedImoveis([{ id: 'T-SET-OK', tipo: 't' }]);
    assert.equal(db.setDisponibilidade('T-SET-OK', false), true);
    assert.equal(db.consultarImovel('T-SET-OK').disponivel, 0);
    assert.equal(db.setDisponibilidade('T-SET-OK', true), true);
    assert.equal(db.consultarImovel('T-SET-OK').disponivel, 1);
  });

  test('setDisponibilidade retorna false para ID inexistente (nao cria linha)', () => {
    assert.equal(db.setDisponibilidade('T-NAO-EXISTE', true), false);
    assert.equal(db.consultarImovel('T-NAO-EXISTE'), undefined);
  });

  test('listarImoveis retorna TODOS os imoveis com o campo disponivel', () => {
    // Filosofia atual: nao filtra por disponibilidade - o prompt decide como
    // apresentar (frisa indisponivel + oferece lista de espera).
    db.seedImoveis([
      { id: 'T-LIST-A', tipo: 't' },
      { id: 'T-LIST-B', tipo: 't' },
    ]);
    db.setDisponibilidade('T-LIST-B', false);
    const rows = db.listarImoveis();
    const a = rows.find((r) => r.id === 'T-LIST-A');
    const b = rows.find((r) => r.id === 'T-LIST-B');
    assert.equal(a.disponivel, 1);
    assert.equal(b.disponivel, 0, 'indisponivel PRECISA aparecer na lista');
  });
});

// ============================================================================
// db.js - leads (anti-spam do corretor)
// ============================================================================
describe('db.js - leads / anti-duplicidade', () => {
  test('podeRegistrarLead retorna true para contato novo', () => {
    assert.equal(db.podeRegistrarLead('novo@teste.com'), true);
  });

  test('podeRegistrarLead retorna false imediatamente apos salvarLead', () => {
    // Impede reavisar o corretor 2x no mesmo lead / mesma janela de 12h.
    db.salvarLead('recem@teste.com', { nome: 'Fulano', intencao: 'alugar' });
    assert.equal(db.podeRegistrarLead('recem@teste.com'), false);
  });
});

// ============================================================================
// core.js - roteamento por numero (SEGURANCA)
// ============================================================================
describe('core.js - ehDono (quem pode alterar estoque)', () => {
  const primeiroDono = (CLIENTE.donosWhatsApp || [])[0];

  test('ehDono retorna false para entrada vazia ou lixo', () => {
    assert.equal(core.ehDono(''), false);
    assert.equal(core.ehDono(null), false);
    assert.equal(core.ehDono(undefined), false);
    assert.equal(core.ehDono('semnumero@terminal'), false);
  });

  test('ehDono retorna false para numero NAO cadastrado', () => {
    // Blindagem do bug "lead se passar por dono".
    assert.equal(core.ehDono('5511000000000@s.whatsapp.net'), false);
    assert.equal(core.ehDono('teste@terminal'), false);
  });

  test('ehDono retorna true para jid do dono cadastrado', (t) => {
    if (!primeiroDono) {
      t.skip('CLIENTE.donosWhatsApp esta vazio no config; preencha para testar.');
      return;
    }
    const digitos = String(primeiroDono).replace(/\D/g, '');
    assert.equal(core.ehDono(`${digitos}@s.whatsapp.net`), true);
    assert.equal(core.ehDono(`${digitos}@terminal`), true);
  });

  test('ehDono ignora formatacao (+, hifen, espacos) no contactId', (t) => {
    if (!primeiroDono) {
      t.skip('CLIENTE.donosWhatsApp esta vazio no config.');
      return;
    }
    const digitos = String(primeiroDono).replace(/\D/g, '');
    // "+55 11 99999-9999" ou "+5511999999999" precisa casar tambem.
    assert.equal(core.ehDono(`+${digitos}@s.whatsapp.net`), true);
  });
});

// ============================================================================
// core.js - normalizarBool (defesa contra o modelo mandar tipo errado)
// ============================================================================
describe('core.js - normalizarBool', () => {
  test('aceita boolean puro', () => {
    assert.equal(core.normalizarBool(true), true);
    assert.equal(core.normalizarBool(false), false);
  });

  test('aceita string "true"/"false" (case-insensitive)', () => {
    assert.equal(core.normalizarBool('true'), true);
    assert.equal(core.normalizarBool('False'), false);
    assert.equal(core.normalizarBool('TRUE'), true);
  });

  test('aceita numero 0/1', () => {
    assert.equal(core.normalizarBool(1), true);
    assert.equal(core.normalizarBool(0), false);
  });

  test('aceita sinonimos em portugues ("sim"/"nao", "disponivel"/"indisponivel")', () => {
    assert.equal(core.normalizarBool('sim'), true);
    assert.equal(core.normalizarBool('nao'), false);
    assert.equal(core.normalizarBool('não'), false);
    assert.equal(core.normalizarBool('disponivel'), true);
    assert.equal(core.normalizarBool('indisponível'), false);
  });

  test('retorna null para valor desconhecido (falha aberto, nao chuta)', () => {
    // Preferimos NAO gravar do que gravar valor errado silenciosamente.
    assert.equal(core.normalizarBool('talvez'), null);
    assert.equal(core.normalizarBool(undefined), null);
    assert.equal(core.normalizarBool({}), null);
  });
});

// ============================================================================
// core.js - atualizarDisponibilidade (fato duro end-to-end)
// ============================================================================
describe('core.js - atualizarDisponibilidade (writes)', () => {
  before(() => {
    db.seedImoveis([
      { id: 'T-ATU-01', tipo: 'flat', local: 'Centro' },
      { id: 'CASE 01', tipo: 't' },
    ]);
  });

  test('grava boolean true/false vindo do modelo', () => {
    core.atualizarDisponibilidade({ imovel_id: 'T-ATU-01', disponivel: false });
    assert.equal(db.consultarImovel('T-ATU-01').disponivel, 0);
    core.atualizarDisponibilidade({ imovel_id: 'T-ATU-01', disponivel: true });
    assert.equal(db.consultarImovel('T-ATU-01').disponivel, 1);
  });

  test('grava string "true"/"false" (modelo pode mandar string)', () => {
    core.atualizarDisponibilidade({ imovel_id: 'T-ATU-01', disponivel: 'false' });
    assert.equal(db.consultarImovel('T-ATU-01').disponivel, 0);
    core.atualizarDisponibilidade({ imovel_id: 'T-ATU-01', disponivel: 'true' });
    assert.equal(db.consultarImovel('T-ATU-01').disponivel, 1);
  });

  test('rejeita valor bizarro sem tocar no banco', () => {
    core.atualizarDisponibilidade({ imovel_id: 'T-ATU-01', disponivel: true });
    const msg = core.atualizarDisponibilidade({ imovel_id: 'T-ATU-01', disponivel: 'talvez' });
    assert.match(msg, /nao entendi/i);
    assert.equal(db.consultarImovel('T-ATU-01').disponivel, 1, 'banco nao pode ter mudado');
  });

  test('recusa ID inexistente sem criar linha', () => {
    const msg = core.atualizarDisponibilidade({ imovel_id: 'IMOVEL XYZ', disponivel: true });
    assert.match(msg, /nao encontrado/i);
    assert.equal(db.consultarImovel('IMOVEL XYZ'), undefined);
  });

  test('normaliza case do ID ("case 01" == "CASE 01")', () => {
    core.atualizarDisponibilidade({ imovel_id: 'case 01', disponivel: false });
    assert.equal(db.consultarImovel('CASE 01').disponivel, 0);
  });
});

// ============================================================================
// agent.js - pareceVacuo (safety net anti-"deixa eu consultar")
// ============================================================================
describe('agent.js - pareceVacuo (detecta promessa de consulta futura)', () => {
  test('detecta os padroes comuns de "vou consultar / momentinho"', () => {
    assert.equal(agent.pareceVacuo('Deixa eu consultar aqui pra voce, um momentinho'), true);
    assert.equal(agent.pareceVacuo('Vou verificar as opcoes e ja te aviso'), true);
    assert.equal(agent.pareceVacuo('Ja te retorno com essa informacao'), true);
    assert.equal(agent.pareceVacuo('Vou dar uma olhada no estoque'), true);
    assert.equal(agent.pareceVacuo('Assim que eu souber, te aviso'), true);
    assert.equal(agent.pareceVacuo('Deixa eu pesquisar aqui...'), true);
  });

  test('NAO dispara em respostas normais (falsos positivos)', () => {
    assert.equal(agent.pareceVacuo('O apartamento tem 3 dormitorios e custa R$ 1.6 milhao'), false);
    assert.equal(agent.pareceVacuo('Voce prefere comprar ou alugar?'), false);
    assert.equal(agent.pareceVacuo('Perfeito! Um corretor vai entrar em contato.'), false);
    assert.equal(agent.pareceVacuo('Nesse momento nao temos nada nessa faixa.'), false);
  });

  test('lida com string vazia/null sem quebrar', () => {
    assert.equal(agent.pareceVacuo(''), false);
    assert.equal(agent.pareceVacuo(null), false);
    assert.equal(agent.pareceVacuo(undefined), false);
  });
});
