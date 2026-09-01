// test/nucleo.test.js
// ==========================================================================
// TESTES DETERMINISTICOS DO NUCLEO.
// Rodar: npm test
//
// Cobrem SO o que e codigo/fato duro: SQLite (persistencia de pedidos e pausas),
// calculo de pedido, validacao de area/horario/valor minimo, roteamento por
// numero (ehDono). NAO testam:
//  - o modelo (nao deterministico, cobrado por chamada);
//  - o WhatsApp (I/O externo);
//  - o prompt (baixo risco, muda com iteracao).
//
// Isolamento: usa DB_PATH = dados.test.db (arquivo separado). O DB real
// (dados.db) NAO e tocado. Cada execucao comeca com o arquivo de teste zerado.
// ==========================================================================
import { test, describe } from 'node:test';
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

// Silencia console.log durante testes.
console.log = () => {};

const db = await import('../src/db.js');
const core = await import('../src/core.js');
const agent = await import('../src/agent.js');
const { CLIENTE } = await import('../src/config-cliente.js');

// ============================================================================
// db.js - pedidos
// ============================================================================
describe('db.js - pedidos', () => {
  test('salvarPedido insere e retorna id incremental', () => {
    const id = db.salvarPedido('cli1@teste', {
      cliente_nome: 'Fulano',
      itens: [{ nome: 'X', quantidade: 1, preco_unitario: 10, subtotal: 10 }],
      subtotal: 10,
      taxa_entrega: 5,
      total: 15,
      endereco: 'Rua A, 1',
      bairro: 'Centro',
      forma_pagamento: 'Dinheiro',
    });
    assert.ok(id > 0, 'id do pedido deve ser positivo');

    const pedidos = db.listarPedidos(10);
    const p = pedidos.find((x) => x.id === id);
    assert.ok(p, 'pedido deve estar no banco');
    assert.equal(p.cliente_nome, 'Fulano');
    assert.equal(p.total, 15);
    // itens_json e string JSON
    const itens = JSON.parse(p.itens_json);
    assert.equal(itens.length, 1);
    assert.equal(itens[0].nome, 'X');
  });

  test('salvarPedido persiste troco_para quando dinheiro', () => {
    const id = db.salvarPedido('cli2@teste', {
      cliente_nome: 'Beltrano',
      itens: [],
      subtotal: 0,
      taxa_entrega: 0,
      total: 0,
      forma_pagamento: 'Dinheiro',
      troco_para: 50,
    });
    const p = db.listarPedidos(10).find((x) => x.id === id);
    assert.equal(p.troco_para, 50);
  });
});

// ============================================================================
// db.js - pausas (handoff humano)
// ============================================================================
describe('db.js - pausas de atendimento', () => {
  test('sem pausa registrada, estaEmPausa retorna null', () => {
    assert.equal(db.estaEmPausa('semPausa@teste'), null);
  });

  test('pausarAtendimento cria pausa ativa; estaEmPausa devolve os dados', () => {
    db.pausarAtendimento('pause1@teste', 4, 'cliente pediu humano');
    const p = db.estaEmPausa('pause1@teste');
    assert.ok(p, 'deve estar pausado');
    assert.equal(p.motivo, 'cliente pediu humano');
    assert.ok(p.ate > Date.now(), 'ate deve ser no futuro');
  });

  test('pausa expirada e removida automaticamente por estaEmPausa', () => {
    // Cria pausa com vencimento no passado (via SQL bruto seria mais direto,
    // mas aqui usamos horas negativas - o codigo aceita e coloca no passado).
    db.pausarAtendimento('exp@teste', -1, 'expirada');
    const p = db.estaEmPausa('exp@teste');
    assert.equal(p, null, 'pausa expirada deve retornar null');
  });

  test('retomarAtendimento remove a pausa', () => {
    db.pausarAtendimento('retomar@teste', 4);
    assert.ok(db.estaEmPausa('retomar@teste'));
    assert.equal(db.retomarAtendimento('retomar@teste'), true);
    assert.equal(db.estaEmPausa('retomar@teste'), null);
  });
});

// ============================================================================
// core.js - roteamento por numero (SEGURANCA)
// ============================================================================
describe('core.js - ehDono', () => {
  const primeiroDono = (CLIENTE.donosWhatsApp || [])[0];

  test('ehDono retorna false para entrada vazia ou lixo', () => {
    assert.equal(core.ehDono(''), false);
    assert.equal(core.ehDono(null), false);
    assert.equal(core.ehDono(undefined), false);
    assert.equal(core.ehDono('semnumero@terminal'), false);
  });

  test('ehDono retorna false para numero NAO cadastrado', () => {
    assert.equal(core.ehDono('5511000000000@s.whatsapp.net'), false);
  });

  test('ehDono retorna true para jid do dono cadastrado', (t) => {
    if (!primeiroDono) {
      t.skip('CLIENTE.donosWhatsApp esta vazio no config; preencha para testar.');
      return;
    }
    const digitos = String(primeiroDono).replace(/\D/g, '');
    assert.equal(core.ehDono(`${digitos}@s.whatsapp.net`), true);
  });
});

// ============================================================================
// agent.js - utilitarios de cardapio / area / horario
// ============================================================================
describe('agent.js - normalizarTexto (base para comparacao)', () => {
  test('remove acento, caixa, e espacos', () => {
    assert.equal(agent.normalizarTexto('  Coração  '), 'coracao');
    assert.equal(agent.normalizarTexto('Não'), 'nao');
    assert.equal(agent.normalizarTexto('X-BURGUER'), 'x-burguer');
  });

  test('lida com null/undefined sem quebrar', () => {
    assert.equal(agent.normalizarTexto(null), '');
    assert.equal(agent.normalizarTexto(undefined), '');
  });
});

describe('agent.js - acharItemCardapio', () => {
  test('acha item existente por nome exato', () => {
    // usa o primeiro item do primeiro cardapio do config
    const primeiroItem = CLIENTE.cardapio?.[0]?.itens?.[0];
    if (!primeiroItem) {
      // sem cardapio configurado, pula
      return;
    }
    const r = agent.acharItemCardapio(primeiroItem.nome);
    assert.ok(r);
    assert.equal(r.nome, primeiroItem.nome);
    assert.equal(r.preco, primeiroItem.preco);
  });

  test('acha item ignorando caixa e acento', () => {
    const primeiroItem = CLIENTE.cardapio?.[0]?.itens?.[0];
    if (!primeiroItem) return;
    const nomeAlterado = primeiroItem.nome.toUpperCase();
    const r = agent.acharItemCardapio(nomeAlterado);
    assert.ok(r, 'deve achar mesmo com caixa diferente');
    assert.equal(r.nome, primeiroItem.nome);
  });

  test('retorna null para item inexistente', () => {
    assert.equal(agent.acharItemCardapio('Item Que Nao Existe XYZ'), null);
    assert.equal(agent.acharItemCardapio(''), null);
    assert.equal(agent.acharItemCardapio(null), null);
  });
});

describe('agent.js - bairroAtendido', () => {
  test('retorna true para bairro na lista (case/acento insensitive)', () => {
    const primeiro = (CLIENTE.bairrosAtendidos || [])[0];
    if (!primeiro) return;
    assert.equal(agent.bairroAtendido(primeiro), true);
    assert.equal(agent.bairroAtendido(primeiro.toUpperCase()), true);
  });

  test('retorna false para bairro fora da lista', () => {
    assert.equal(agent.bairroAtendido('Bairro Inexistente XYZ'), false);
    assert.equal(agent.bairroAtendido(''), false);
  });
});

describe('agent.js - statusHorario', () => {
  test('retorna aberto=true dentro do horario', () => {
    // Testa contra config real: acha um dia em que existe horario e simula meio do intervalo.
    const cfg = CLIENTE.horarioFuncionamento || {};
    const dias = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
    for (let i = 0; i < 7; i++) {
      const info = cfg[dias[i]];
      if (!info || info.fechado) continue;
      const [aH, aM] = info.abre.split(':').map(Number);
      // 30 min depois de abrir
      const d = new Date(2026, 0, 4 + i); // domingo 04/01/2026
      d.setHours(aH, aM + 30, 0, 0);
      const s = agent.statusHorario(d);
      assert.equal(s.aberto, true, `esperado aberto em ${dias[i]} as ${info.abre}+30`);
      return; // basta um caso
    }
  });

  test('retorna aberto=false e proximoHorario antes de abrir', () => {
    const cfg = CLIENTE.horarioFuncionamento || {};
    const dias = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
    for (let i = 0; i < 7; i++) {
      const info = cfg[dias[i]];
      if (!info || info.fechado) continue;
      const [aH] = info.abre.split(':').map(Number);
      if (aH === 0) continue; // se abre a 00:00, nao da pra testar "antes"
      const d = new Date(2026, 0, 4 + i);
      d.setHours(aH - 1, 0, 0, 0);
      const s = agent.statusHorario(d);
      assert.equal(s.aberto, false);
      assert.ok(s.proximoHorario, 'proximoHorario deve ter texto');
      return;
    }
  });
});

// ============================================================================
// agent.js - calcularPedido (fato duro: nunca deixa o modelo somar)
// ============================================================================
describe('agent.js - calcularPedido', () => {
  const primeiroItem = CLIENTE.cardapio?.[0]?.itens?.[0];
  const primeiroBairro = (CLIENTE.bairrosAtendidos || [])[0];

  test('calcula subtotal, taxa e total corretamente', (t) => {
    if (!primeiroItem || !primeiroBairro) {
      t.skip('config sem cardapio ou bairro para testar');
      return;
    }
    // Usa quantidade grande o bastante para passar do minimo.
    const qtd = Math.ceil((CLIENTE.valorMinimoPedido || 0) / primeiroItem.preco) + 1;
    const r = agent.calcularPedido({
      cliente_nome: 'Teste',
      itens: [{ nome: primeiroItem.nome, quantidade: qtd }],
      endereco: 'Rua X, 1',
      bairro: primeiroBairro,
      forma_pagamento: 'Dinheiro',
    });
    assert.equal(r.ok, true, r.mensagem);
    assert.equal(r.dados.subtotal, Number((primeiroItem.preco * qtd).toFixed(2)));
    assert.equal(r.dados.taxa_entrega, CLIENTE.taxaEntregaPadrao);
    assert.equal(r.dados.total, Number((r.dados.subtotal + r.dados.taxa_entrega).toFixed(2)));
    assert.equal(r.dados.itens[0].preco_unitario, primeiroItem.preco);
  });

  test('rejeita item que nao existe no cardapio', () => {
    const r = agent.calcularPedido({
      cliente_nome: 'Teste',
      itens: [{ nome: 'Item Inexistente XYZ', quantidade: 1 }],
      endereco: 'Rua X, 1',
      bairro: primeiroBairro || 'X',
      forma_pagamento: 'Dinheiro',
    });
    assert.equal(r.ok, false);
    assert.match(r.mensagem, /nao existe no cardapio/i);
  });

  test('rejeita pedido sem itens', () => {
    const r = agent.calcularPedido({
      cliente_nome: 'Teste',
      itens: [],
      endereco: 'Rua X, 1',
      bairro: primeiroBairro || 'X',
      forma_pagamento: 'Dinheiro',
    });
    assert.equal(r.ok, false);
    assert.match(r.mensagem, /sem itens/i);
  });

  test('rejeita quantidade invalida', (t) => {
    if (!primeiroItem) {
      t.skip('config sem cardapio');
      return;
    }
    const r = agent.calcularPedido({
      cliente_nome: 'Teste',
      itens: [{ nome: primeiroItem.nome, quantidade: 0 }],
      endereco: 'Rua X, 1',
      bairro: primeiroBairro || 'X',
      forma_pagamento: 'Dinheiro',
    });
    assert.equal(r.ok, false);
    assert.match(r.mensagem, /quantidade invalida/i);
  });

  test('rejeita bairro fora da area', (t) => {
    if (!primeiroItem) {
      t.skip('config sem cardapio');
      return;
    }
    const qtd = Math.ceil((CLIENTE.valorMinimoPedido || 0) / primeiroItem.preco) + 1;
    const r = agent.calcularPedido({
      cliente_nome: 'Teste',
      itens: [{ nome: primeiroItem.nome, quantidade: qtd }],
      endereco: 'Rua X, 1',
      bairro: 'Bairro Inexistente Total',
      forma_pagamento: 'Dinheiro',
    });
    assert.equal(r.ok, false);
    assert.match(r.mensagem, /fora da area/i);
  });

  test('rejeita subtotal abaixo do valor minimo', (t) => {
    if (!primeiroItem || (CLIENTE.valorMinimoPedido || 0) <= primeiroItem.preco) {
      t.skip('cardapio nao permite testar minimo (item unico ja passa do minimo)');
      return;
    }
    const r = agent.calcularPedido({
      cliente_nome: 'Teste',
      itens: [{ nome: primeiroItem.nome, quantidade: 1 }],
      endereco: 'Rua X, 1',
      bairro: primeiroBairro,
      forma_pagamento: 'Dinheiro',
    });
    assert.equal(r.ok, false);
    assert.match(r.mensagem, /abaixo do minimo/i);
  });
});

// ============================================================================
// agent.js - pareceVacuo (safety net anti-"deixa eu consultar")
// ============================================================================
describe('agent.js - pareceVacuo', () => {
  test('detecta padroes comuns de "vou consultar / momentinho"', () => {
    assert.equal(agent.pareceVacuo('Deixa eu consultar o cardapio, um momentinho'), true);
    assert.equal(agent.pareceVacuo('Vou verificar aqui e ja te aviso'), true);
    assert.equal(agent.pareceVacuo('Ja te retorno com essa informacao'), true);
    assert.equal(agent.pareceVacuo('Vou dar uma olhada'), true);
  });

  test('NAO dispara em respostas normais', () => {
    assert.equal(agent.pareceVacuo('Temos X-Burguer por R$ 18. Quer pedir?'), false);
    assert.equal(agent.pareceVacuo('Qual seu endereco?'), false);
    assert.equal(agent.pareceVacuo('Pedido #12 registrado! Chega em 40 min.'), false);
  });

  test('lida com string vazia/null sem quebrar', () => {
    assert.equal(agent.pareceVacuo(''), false);
    assert.equal(agent.pareceVacuo(null), false);
    assert.equal(agent.pareceVacuo(undefined), false);
  });
});
