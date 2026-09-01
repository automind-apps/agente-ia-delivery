// src/agent.js
// O "cerebro" do atendente de delivery:
//  - conhecimento do estabelecimento (config-cliente.js)
//  - tool use: o modelo consulta cardapio, valida area/horario, e finaliza
//    o pedido chamando "registrar_pedido" (o CODIGO calcula preco/subtotal/total).
//  - GARANTIA dos campos minimos do pedido: eles sao OBRIGATORIOS no schema
//    da ferramenta, entao o modelo nao consegue registrar sem coletar cada um.
import Anthropic from '@anthropic-ai/sdk';
import { CLIENTE } from './config-cliente.js';

const MOCK = process.env.MOCK === 'true';
const MODEL = 'claude-haiku-4-5-20251001';

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

// ---------- Utilitarios exportados (usados no core.js) ----------

// Normaliza texto para comparacao: minusculo, sem acento, trim.
export function normalizarTexto(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

// Casa um item por nome (case/acento-insensitive). Retorna { nome, descricao,
// preco, categoria, disponivel } ou null.
export function acharItemCardapio(nome) {
  const alvo = normalizarTexto(nome);
  if (!alvo) return null;
  for (const cat of CLIENTE.cardapio || []) {
    for (const it of cat.itens || []) {
      if (normalizarTexto(it.nome) === alvo) {
        return { ...it, categoria: cat.categoria };
      }
    }
  }
  return null;
}

// Formata BRL simples (R$ 12,00).
export function formatarBRL(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Bairro esta na lista de bairros atendidos? (case/acento-insensitive)
export function bairroAtendido(bairro) {
  const alvo = normalizarTexto(bairro);
  if (!alvo) return false;
  return (CLIENTE.bairrosAtendidos || []).some((b) => normalizarTexto(b) === alvo);
}

// ---------- Horario de funcionamento ----------
const DIAS_SEMANA = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

function paraMinutos(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Retorna { aberto: bool, proximoHorario: string|null, hoje: string }.
// "proximoHorario" so aparece quando fechado (frase para o modelo mostrar).
export function statusHorario(now = new Date()) {
  const cfg = CLIENTE.horarioFuncionamento || {};
  const diaIdx = now.getDay();
  const dia = DIAS_SEMANA[diaIdx];
  const minutosAgora = now.getHours() * 60 + now.getMinutes();

  const hoje = cfg[dia];
  if (hoje && !hoje.fechado) {
    const abre = paraMinutos(hoje.abre);
    const fecha = paraMinutos(hoje.fecha);
    if (abre != null && fecha != null) {
      // fecha <= abre = vira o dia (ex.: 18:00 -> 00:00 vira 18:00 -> 24:00)
      const fechaAjustado = fecha <= abre ? fecha + 24 * 60 : fecha;
      if (minutosAgora >= abre && minutosAgora < fechaAjustado) {
        return { aberto: true, proximoHorario: null, hoje: dia };
      }
      // fechado agora mas ainda vai abrir HOJE
      if (minutosAgora < abre) {
        return { aberto: false, proximoHorario: `hoje as ${hoje.abre}`, hoje: dia };
      }
    }
  }

  // procura o proximo dia que abre (ate 7 dias a frente)
  for (let i = 1; i <= 7; i++) {
    const idx = (diaIdx + i) % 7;
    const nome = DIAS_SEMANA[idx];
    const info = cfg[nome];
    if (info && !info.fechado && info.abre) {
      const quando = i === 1 ? 'amanha' : nome;
      return { aberto: false, proximoHorario: `${quando} as ${info.abre}`, hoje: dia };
    }
  }
  return { aberto: false, proximoHorario: null, hoje: dia };
}

// ---------- Formatadores de tool_result (o modelo le e parafraseia) ----------
function formatarCardapio(categoriaFiltro) {
  const cardapio = CLIENTE.cardapio || [];
  const cats = categoriaFiltro
    ? cardapio.filter((c) => normalizarTexto(c.categoria) === normalizarTexto(categoriaFiltro))
    : cardapio;
  if (!cats.length) {
    return categoriaFiltro
      ? `Categoria "${categoriaFiltro}" nao encontrada. Categorias disponiveis: ${cardapio
          .map((c) => c.categoria)
          .join(', ')}.`
      : 'Cardapio vazio.';
  }
  const linhas = ['CARDAPIO (parafraseie para o cliente - nao repita bruto):'];
  for (const cat of cats) {
    linhas.push(`\n== ${cat.categoria} ==`);
    for (const it of cat.itens || []) {
      const disp = it.disponivel === false ? ' [ESGOTADO]' : '';
      const desc = it.descricao ? ` - ${it.descricao}` : '';
      linhas.push(`- ${it.nome}${desc} - ${formatarBRL(it.preco)}${disp}`);
    }
  }
  return linhas.join('\n');
}

function formatarStatusHorario() {
  const s = statusHorario();
  if (s.aberto) return 'ABERTO agora.';
  if (s.proximoHorario) return `FECHADO agora. Proximo horario: ${s.proximoHorario}.`;
  return 'FECHADO agora.';
}

function formatarAreaEntrega(bairro) {
  if (bairroAtendido(bairro)) {
    return `SIM, entregamos em "${bairro}". Taxa: ${formatarBRL(CLIENTE.taxaEntregaPadrao)}. Tempo medio: ${CLIENTE.tempoMedioEntrega}.`;
  }
  const lista = (CLIENTE.bairrosAtendidos || []).join(', ') || 'nenhum bairro cadastrado';
  return `NAO entregamos em "${bairro}". Bairros atendidos: ${lista}.`;
}

// ---------- System prompt ----------
function horarioFuncionamentoFormatado() {
  const cfg = CLIENTE.horarioFuncionamento || {};
  return DIAS_SEMANA.map((d) => {
    const info = cfg[d];
    if (!info || info.fechado) return `${d}: fechado`;
    return `${d}: ${info.abre} as ${info.fecha}`;
  }).join('; ');
}

function montarSystemPrompt() {
  const observacoes = (CLIENTE.observacoesEspeciais || []).map((o) => `- ${o}`).join('\n');
  const bairros = (CLIENTE.bairrosAtendidos || []).join(', ');
  const pagamentos = (CLIENTE.formasPagamento || []).join(', ');

  return `
Voce e o atendente virtual da ${CLIENTE.nomeEstabelecimento}, uma ${CLIENTE.tipoEstabelecimento} em ${CLIENTE.cidade}${CLIENTE.bairro ? ` (${CLIENTE.bairro})` : ''}. Atende no WhatsApp, 24 horas por dia.

SEU OBJETIVO: ajudar o cliente a fazer o pedido de forma RAPIDA, natural e sem atrito. Cliente com fome nao quer conversa longa.

REGRAS DE COMPORTAMENTO:
1. Fale como atendente amigavel brasileiro, informal mas educado. NUNCA use menus numerados forcados ("Digite 1 para..."). Deixe o cliente se expressar livremente.
2. Mensagens CURTAS estilo WhatsApp: 1 a 3 frases. Sem markdown. Emojis leves ok (nao exagere).
3. Se cliente perguntar cardapio, CHAME "consultar_cardapio". Nao invente item nem preco.
4. Se cliente perguntar se entregam num bairro, CHAME "verificar_area_entrega".
5. Se cliente perguntar horario / "estao abertos?", CHAME "verificar_horario_funcionamento".
6. Se cliente pedir para falar com humano OU o pedido virar complexo (evento, encomenda grande, duvida detalhada sobre alergia/ingrediente), CHAME "passar_para_humano" e ai PARE - nao continue coletando pedido.

FLUXO DO PEDIDO:
Colete de forma natural, uma coisa por vez (nao pareca formulario):
  a) ITENS que o cliente quer (com observacoes se houver: sem cebola, ponto da carne, etc).
  b) NOME do cliente.
  c) ENDERECO completo: rua, numero, complemento (se houver), bairro, ponto de referencia.
  d) FORMA DE PAGAMENTO (${pagamentos}).
  e) Se pagar em dinheiro: TROCO PRA QUANTO.

Antes de finalizar, SEMPRE confirme repetindo tudo (itens com quantidades, subtotal, taxa de entrega, TOTAL, endereco, forma de pagamento, tempo estimado). So chame "registrar_pedido" DEPOIS que o cliente confirmar explicitamente ("pode ser", "confirma", "isso mesmo", "ok").

REGRAS DURAS (voce NAO PODE):
- Inventar item, preco, tempo de entrega ou taxa. Se nao esta no cardapio (resultado da ferramenta), diga que nao tem e sugira algo parecido.
- CALCULAR o total de cabeca. O CODIGO calcula quando voce chama "registrar_pedido" - voce so passa os itens com nome e quantidade. Mas voce PODE dizer o subtotal e total ao cliente na hora de confirmar (usando os precos que ja viu no cardapio); se estiver em duvida, chame "consultar_cardapio" de novo.
- Aceitar pedido para bairro fora da area (${bairros || 'lista vazia'}). Se cliente estiver fora, informe educadamente e nao insista.
- Aceitar pedido abaixo do valor minimo (${formatarBRL(CLIENTE.valorMinimoPedido)}). Se for menor, informe e sugira adicionar item para atingir.
- Prometer coisa fora da politica (desconto especial, item nao listado, alteracao de receita).

REGRAS DE HORARIO:
- Se cliente escrever fora do horario de funcionamento, informe educadamente que estao fechados e diga o proximo horario (verificar com a ferramenta). MAS AINDA colete o pedido se ele quiser - o dono processa quando abrir. Deixe claro que "vai entrar quando abrir".

REGRAS DE PAGAMENTO:
- Formas aceitas: ${pagamentos}.
- Chave PIX: SO informar quando o cliente escolher PIX. Chave: ${CLIENTE.chavePix || '(nao configurada)'}.
- Se cliente escolher dinheiro, PERGUNTAR troco pra quanto. Se disser "sem troco" ou "valor exato", registrar sem troco.

REGRAS DE ENTREGA:
- Taxa padrao: ${formatarBRL(CLIENTE.taxaEntregaPadrao)} (adicionada ao total).
- Tempo medio: ${CLIENTE.tempoMedioEntrega}.
- Bairros atendidos: ${bairros || '(nao configurados)'}.
- Valor minimo: ${formatarBRL(CLIENTE.valorMinimoPedido)}.

OBSERVACOES DO ESTABELECIMENTO:
${observacoes || '(sem observacoes especiais)'}

HORARIO DE FUNCIONAMENTO:
${horarioFuncionamentoFormatado()}

TOM:
- Amigavel, brasileiro, natural. Nao muito formal, nao muito informal.
- Rapido e objetivo. Uma pergunta por vez.
- Acompanhe o tom do cliente (se ele for informal, seja informal).
`;
}

// ---------- Ferramentas ----------
const TOOL_CONSULTAR_CARDAPIO = {
  name: 'consultar_cardapio',
  description:
    'Retorna o cardapio (todos os itens com preco). Use SEMPRE que o cliente ' +
    'pedir para ver o cardapio, perguntar o que tem, ou pedir sugestao. Pode ' +
    'filtrar por categoria (ex.: "Hamburgueres", "Bebidas") passando o parametro ' +
    'categoria; sem parametro retorna o cardapio inteiro. Itens marcados ' +
    '[ESGOTADO] nao devem ser oferecidos.',
  input_schema: {
    type: 'object',
    properties: {
      categoria: {
        type: 'string',
        description: 'Opcional. Nome da categoria (ex.: "Hamburgueres").',
      },
    },
    required: [],
  },
};

const TOOL_VERIFICAR_HORARIO = {
  name: 'verificar_horario_funcionamento',
  description:
    'Verifica se o estabelecimento esta aberto AGORA. Se fechado, retorna o ' +
    'proximo horario de abertura. Use quando o cliente perguntar "estao abertos?", ' +
    '"que horas abre?", ou quando ele estiver iniciando um pedido fora do horario obvio.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

const TOOL_VERIFICAR_AREA = {
  name: 'verificar_area_entrega',
  description:
    'Verifica se um bairro esta na area de entrega. Use SEMPRE antes de aceitar ' +
    'endereco em um bairro que voce ainda nao confirmou. Retorna se entrega e, se ' +
    'nao entrega, lista os bairros atendidos.',
  input_schema: {
    type: 'object',
    properties: {
      bairro: { type: 'string', description: 'Nome do bairro que o cliente informou.' },
    },
    required: ['bairro'],
  },
};

const TOOL_PASSAR_PARA_HUMANO = {
  name: 'passar_para_humano',
  description:
    'Transfere a conversa para atendimento humano. Use quando o cliente pedir ' +
    'explicitamente ("quero falar com uma pessoa", "chamar humano") OU quando o ' +
    'pedido for complexo (evento, encomenda grande, duvida detalhada sobre ' +
    'ingrediente/alergia). Depois de chamar, o bot ficara silencioso naquela ' +
    'conversa por algumas horas para o dono responder.',
  input_schema: {
    type: 'object',
    properties: {
      motivo: {
        type: 'string',
        description: 'Motivo curto (1 frase) para o dono entender por que passou.',
      },
    },
    required: ['motivo'],
  },
};

const TOOL_REGISTRAR_PEDIDO = {
  name: 'registrar_pedido',
  description:
    'Registra o pedido no sistema e notifica o dono. So chame DEPOIS que o cliente ' +
    'confirmou o pedido completo (itens, endereco, pagamento). O CODIGO calcula ' +
    'subtotal, taxa e total a partir dos itens - voce so passa nome e quantidade. ' +
    'Se algum item nao existir no cardapio, a ferramenta devolve erro e voce ajusta.',
  input_schema: {
    type: 'object',
    properties: {
      cliente_nome: { type: 'string', description: 'Nome do cliente.' },
      itens: {
        type: 'array',
        description:
          'Lista de itens do pedido. Cada item precisa do NOME exato como aparece no cardapio.',
        items: {
          type: 'object',
          properties: {
            nome: { type: 'string', description: 'Nome do item (igual ao cardapio).' },
            quantidade: { type: 'integer', description: 'Quantidade (>= 1).' },
            observacoes: {
              type: 'string',
              description: 'Observacoes deste item (ex.: "sem cebola"). Opcional.',
            },
          },
          required: ['nome', 'quantidade'],
        },
      },
      endereco: {
        type: 'string',
        description: 'Endereco completo: rua, numero, complemento (se houver).',
      },
      bairro: { type: 'string', description: 'Bairro da entrega.' },
      referencia: {
        type: 'string',
        description: 'Ponto de referencia (opcional).',
      },
      forma_pagamento: {
        type: 'string',
        description: 'Uma das formas aceitas (dinheiro, cartao na entrega, pix).',
      },
      troco_para: {
        type: 'number',
        description:
          'Se pagamento = dinheiro, valor para o qual precisa de troco. Omita se sem troco ou nao aplicavel.',
      },
      observacoes: {
        type: 'string',
        description: 'Observacoes gerais do pedido (opcional).',
      },
    },
    required: ['cliente_nome', 'itens', 'endereco', 'bairro', 'forma_pagamento'],
  },
};

const TOOLS = [
  TOOL_CONSULTAR_CARDAPIO,
  TOOL_VERIFICAR_HORARIO,
  TOOL_VERIFICAR_AREA,
  TOOL_PASSAR_PARA_HUMANO,
  TOOL_REGISTRAR_PEDIDO,
];

// --- ANTI-VACUO ---
// Padroes que sinalizam "vou consultar depois" - o bot NAO tem depois. Se o modelo
// mandou algo assim SEM chamar ferramenta, o codigo forca uma nova iteracao com um
// lembrete. Faz isso NO MAXIMO 1x por resposta pra nao entrar em loop.
const PATTERNS_VACUO = [
  /\bum\s+momentinho\b/i,
  /\baguard[ea]\s+(um|so|so\s+um)/i,
  /\bdeixa\s+(eu|-me)\s+(ver|consultar|verificar|checar|olhar|pesquisar)/i,
  /\bvou\s+(consultar|verificar|checar|olhar|pesquisar|dar\s+uma\s+olhada|buscar|procurar)/i,
  /\bj[aá]\s+(te\s+)?(retorno|volto|aviso|respondo|falo)/i,
  /\bassim\s+que\s+(eu\s+)?(souber|descobrir|verificar)/i,
];
export function pareceVacuo(texto) {
  if (!texto) return false;
  return PATTERNS_VACUO.some((r) => r.test(texto));
}

// ---------- Calculo do pedido (CODIGO, nao modelo) ----------
// Recebe o input do tool_use "registrar_pedido" e devolve:
//   { ok: true, dados: { ...pedido calculado } }  para o core salvar
//   { ok: false, mensagem: '...' }                para voltar ao modelo como erro
// Nunca deixe o modelo somar precos.
export function calcularPedido(input) {
  if (!Array.isArray(input.itens) || input.itens.length === 0) {
    return { ok: false, mensagem: 'Pedido sem itens. Peca ao cliente o que ele quer.' };
  }

  const itensCalc = [];
  for (const it of input.itens) {
    const encontrado = acharItemCardapio(it.nome);
    if (!encontrado) {
      return {
        ok: false,
        mensagem: `Item "${it.nome}" nao existe no cardapio. Chame consultar_cardapio e ajuste.`,
      };
    }
    if (encontrado.disponivel === false) {
      return {
        ok: false,
        mensagem: `Item "${encontrado.nome}" esta ESGOTADO. Ofereca outra coisa ao cliente.`,
      };
    }
    const qtd = Number(it.quantidade);
    if (!Number.isInteger(qtd) || qtd < 1) {
      return {
        ok: false,
        mensagem: `Quantidade invalida para "${it.nome}". Precisa ser inteiro >= 1.`,
      };
    }
    itensCalc.push({
      nome: encontrado.nome,
      quantidade: qtd,
      observacoes: it.observacoes || null,
      preco_unitario: encontrado.preco,
      subtotal: Number((encontrado.preco * qtd).toFixed(2)),
    });
  }

  const subtotal = Number(itensCalc.reduce((s, it) => s + it.subtotal, 0).toFixed(2));

  // Valor minimo do pedido (subtotal, sem taxa).
  const min = Number(CLIENTE.valorMinimoPedido || 0);
  if (subtotal < min) {
    return {
      ok: false,
      mensagem: `Subtotal ${formatarBRL(subtotal)} abaixo do minimo ${formatarBRL(min)}. Peca ao cliente para adicionar item.`,
    };
  }

  // Area de entrega.
  if (!bairroAtendido(input.bairro)) {
    const lista = (CLIENTE.bairrosAtendidos || []).join(', ') || '(sem bairros)';
    return {
      ok: false,
      mensagem: `Bairro "${input.bairro}" fora da area. Bairros atendidos: ${lista}. Nao aceite este pedido.`,
    };
  }

  const taxa = Number(CLIENTE.taxaEntregaPadrao || 0);
  const total = Number((subtotal + taxa).toFixed(2));

  return {
    ok: true,
    dados: {
      cliente_nome: input.cliente_nome || null,
      itens: itensCalc,
      subtotal,
      taxa_entrega: taxa,
      total,
      endereco: input.endereco || null,
      bairro: input.bairro || null,
      referencia: input.referencia || null,
      forma_pagamento: input.forma_pagamento || null,
      troco_para: input.troco_para != null ? Number(input.troco_para) : null,
      observacoes: input.observacoes || null,
    },
  };
}

// ---------- Loop principal ----------
// gerarResposta(historico, opcoes)
//  - opcoes.onPedido({ pedido, id }): chamado quando um pedido e registrado com sucesso.
//    Recebe o pedido ja calculado e o id gerado pelo banco. Deve enviar o resumo ao dono.
//  - opcoes.onPassarHumano({ motivo }): chamado quando o modelo transfere para humano.
export async function gerarResposta(historico, opcoes = {}) {
  if (MOCK) {
    return '[MOCK] Oi! Aqui e o atendente de teste (sem gastar API). O que voce vai querer?';
  }

  const system = montarSystemPrompt();

  const mensagens = historico.map((m) => ({ ...m }));
  let textoFinal = '';
  let jaRePromptouPorVacuo = false;
  const respostaPadrao = 'Certo! Me diga o que voce vai querer.';

  for (let i = 0; i < 6; i++) {
    const resp = await getClient().messages.create({
      model: MODEL,
      max_tokens: 600,
      system,
      tools: TOOLS,
      messages: mensagens,
    });

    const textos = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (textos) textoFinal = textos;

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');

    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
      if (!jaRePromptouPorVacuo && pareceVacuo(textos)) {
        console.warn('[anti-vacuo] resposta parece promessa sem tool_use - re-promptando');
        jaRePromptouPorVacuo = true;
        mensagens.push({ role: 'assistant', content: resp.content });
        mensagens.push({
          role: 'user',
          content:
            '[LEMBRETE INTERNO - o cliente NAO viu esta mensagem] Voce respondeu ' +
            'prometendo consultar/verificar, mas nao chamou nenhuma ferramenta. Chame ' +
            'AGORA a ferramenta apropriada (consultar_cardapio, verificar_area_entrega, ' +
            'verificar_horario_funcionamento) e ja escreva a resposta ao cliente com o ' +
            'resultado, terminando com um proximo passo claro. Nao repita a frase de espera.',
        });
        continue;
      }
      break;
    }

    mensagens.push({ role: 'assistant', content: resp.content });

    const resultados = [];
    for (const tu of toolUses) {
      let conteudo = 'Operacao concluida.';

      if (tu.name === 'consultar_cardapio') {
        conteudo = formatarCardapio(tu.input?.categoria);
      } else if (tu.name === 'verificar_horario_funcionamento') {
        conteudo = formatarStatusHorario();
      } else if (tu.name === 'verificar_area_entrega') {
        conteudo = formatarAreaEntrega(tu.input?.bairro || '');
      } else if (tu.name === 'passar_para_humano') {
        try {
          if (typeof opcoes.onPassarHumano === 'function') {
            await opcoes.onPassarHumano({ motivo: tu.input?.motivo || 'sem motivo informado' });
          }
          conteudo =
            'Transferido para atendimento humano. Diga ao cliente algo como "vou passar pro atendente humano, ' +
            'ele vai te responder em instantes" e ENCERRE a conversa (nao continue coletando pedido).';
        } catch (e) {
          console.error('Erro no onPassarHumano:', e?.message || e);
          conteudo = 'Nao consegui transferir agora. Pergunte de novo em instantes.';
        }
      } else if (tu.name === 'registrar_pedido') {
        const calc = calcularPedido(tu.input || {});
        if (!calc.ok) {
          conteudo = `ERRO: ${calc.mensagem}`;
        } else {
          try {
            const idPedido =
              typeof opcoes.onPedido === 'function'
                ? await opcoes.onPedido({ pedido: calc.dados })
                : null;
            const numero = idPedido ? `#${idPedido}` : '';
            conteudo =
              `Pedido ${numero} registrado com sucesso. Subtotal ${formatarBRL(calc.dados.subtotal)}, ` +
              `taxa ${formatarBRL(calc.dados.taxa_entrega)}, TOTAL ${formatarBRL(calc.dados.total)}. ` +
              `Tempo estimado: ${CLIENTE.tempoMedioEntrega}. ` +
              `Confirme ao cliente com o numero do pedido e o tempo estimado.`;
          } catch (e) {
            console.error('Erro no onPedido:', e?.message || e);
            conteudo = 'Erro ao registrar o pedido. Peca desculpas ao cliente e pergunte de novo.';
          }
        }
      }

      resultados.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: conteudo,
      });
    }
    mensagens.push({ role: 'user', content: resultados });
  }

  return textoFinal || respostaPadrao;
}
