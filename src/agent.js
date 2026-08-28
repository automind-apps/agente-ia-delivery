// src/agent.js
// O "cerebro" do atendente:
//  - conhecimento do cliente (config-cliente.js)
//  - tool use: o modelo chama "registrar_lead" para notificar o corretor
//  - GARANTIA dos campos minimos: eles sao OBRIGATORIOS no schema da ferramenta,
//    entao o modelo nao consegue registrar o lead sem perguntar cada um.
//    Se a pessoa nao souber, registra "nao definido" (resposta valida).
import Anthropic from '@anthropic-ai/sdk';
import { CLIENTE } from './config-cliente.js';

const MOCK = process.env.MOCK === 'true';
const MODEL = 'claude-haiku-4-5-20251001';

// ===== Campos MINIMOS que devem ser perguntados antes de registrar o lead =====
// (fonte unica da verdade: alimenta o prompt E os obrigatorios da ferramenta)
const CAMPOS_MINIMOS = ['nome', 'intencao', 'tipo_imovel', 'bairro', 'faixa_valor'];
// ==============================================================================

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

// Formata o campo "valor" do imovel para exibicao BR (R$ com separador de milhar).
// O config guarda como string tipo "639000 + IPTU de 1208,52". Aqui extraimos o
// primeiro numero e formatamos; o restante do texto (IPTU/condominio) fica junto.
function formatarValor(v) {
  if (!v) return null;
  const s = String(v);
  const m = s.match(/([\d.,]+)/);
  if (!m) return s;
  const num = Number(m[1].replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(num)) return s;
  const brl = num.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const resto = s.slice(m.index + m[1].length).trim();
  return resto ? `${brl} ${resto}` : brl;
}

// Formata uma linha de imovel (retornada ao modelo via tool_result).
// SEMPRE inclui status - o modelo/prompt decide como apresentar (frisar
// indisponivel + lista de espera; oferecer normalmente se disponivel).
function linhaImovel(r) {
  const partes = [`[${r.id}]`];
  const cabecalho = [r.tipo, r.local].filter(Boolean).join(' - ');
  if (cabecalho) partes.push(cabecalho);

  const valor = formatarValor(r.valor);
  if (valor) partes.push(`Valor: ${valor}`);

  // Caracteristicas: dormitorios/suites/banheiros/tamanho, em bloco unico.
  const carac = [];
  if (r.dormitorios != null) {
    let s = `${r.dormitorios} dorm.`;
    if (r.suites) s += ` (${r.suites} suite${r.suites > 1 ? 's' : ''})`;
    carac.push(s);
  }
  if (r.banheiros != null) carac.push(`${r.banheiros} banh.`);
  if (r.tamanho) carac.push(String(r.tamanho).replace(/m2/gi, 'm²'));
  if (carac.length) partes.push(carac.join(' | '));

  if (r.detalhes) partes.push(r.detalhes);
  if (r.link) partes.push(`Link: ${r.link}`);
  partes.push(`STATUS: ${r.disponivel ? 'DISPONIVEL' : 'INDISPONIVEL'}`);
  return partes.join(' | ');
}

// Retornos formatados para as tool_results (o modelo le como texto e parafraseia).
function formatarListaImoveis(rows) {
  if (!rows?.length) return 'Nenhum imovel cadastrado.';
  return (
    'IMOVEIS DA IMOBILIARIA (todos - respeite o STATUS de cada um):\n' +
    rows.map((r) => linhaImovel(r)).join('\n')
  );
}
function formatarConsultaImovel(rec) {
  if (!rec) return 'Imovel nao encontrado. Verifique o ID.';
  return linhaImovel(rec);
}

function montarSystemPromptLead() {
  const politicas = CLIENTE.politicas.map((p) => `- ${p}`).join('\n');
  const naoFaca = CLIENTE.naoFaca.map((p) => `- ${p}`).join('\n');
  const faq = CLIENTE.faq.map((f) => `P: ${f.pergunta}\nR: ${f.resposta}`).join('\n\n');

  const secaoImoveis = `
REGRA CRITICA - NUNCA DEIXAR NO VACUO:
Voce e um bot em UMA turn por vez: o que voce escrever agora e a ULTIMA coisa que
o cliente vai ler ate ele mandar outra mensagem. Voce NAO tem "segunda etapa"
automatica. Consequencias:
- NUNCA prometa consulta futura ("vou consultar", "deixa eu ver", "um momentinho",
  "ja te retorno", "vou verificar"). Se precisa de dado do banco, CHAME A FERRAMENTA
  AGORA (nesta mesma turn) e ja responda com o resultado.
- Toda mensagem sua ao cliente deve terminar com um PROXIMO PASSO CLARO: uma pergunta,
  uma opcao para escolher, ou o encerramento (registro de lead + "o corretor entra em
  contato"). NUNCA termine com uma frase de espera.
- Se ainda precisa consultar, chame a ferramenta ANTES de responder. Se ja consultou
  e nao achou, DIGA o que achou e ofereca uma proxima acao (ver ver secao imoveis abaixo
  sobre "sem match na faixa").

IMOVEIS - COMO VOCE SABE O QUE TEMOS:
Voce NAO sabe de memoria quais imoveis existem, nem valores, nem disponibilidade.
Toda informacao vem das ferramentas, que consultam o banco AGORA:
- Sempre que a pessoa pedir para ver/listar/mostrar/oferecer imoveis (ex.: "quais
  voces tem?", "me mostra as opcoes", "lista", "quais estao a venda?"), CHAME
  a ferramenta "listar_imoveis". Ela devolve TODOS os imoveis, cada um com um
  campo STATUS.
- Sempre que a pessoa perguntar sobre UM imovel especifico (por ID como "1", por
  descricao como "a casa da Rua Colibri"), CHAME "consultar_imovel" com o ID exato.
- Ao responder, use APENAS os dados retornados pela ferramenta. Parafraseie de
  forma humana; NAO invente valor, tamanho, quartos, etc.
- IGNORE o historico da conversa quando falar de imoveis. So vale o que a
  ferramenta acabou de devolver nesta mensagem.

COMO APRESENTAR CADA IMOVEL AO CLIENTE:
- Se STATUS: DISPONIVEL -> apresente normalmente (tipo, local, valor, quartos,
  tamanho). Se ele pedir mais informacoes ou fotos, envie o LINK do imovel.
- Se STATUS: INDISPONIVEL -> apresente o imovel MAS DEIXE MUITO CLARO que ele
  esta INDISPONIVEL no momento (ex.: "esse ja foi vendido/reservado"). Em seguida,
  OFERECA lista de espera: "quer que o corretor te avise se voltar a ficar disponivel
  ou aparecer algo parecido?". Se a pessoa aceitar, siga coletando os itens
  minimos e, ao registrar o lead, marque no campo "resumo" "LISTA DE ESPERA para
  <ID>". Nao pule esta oferta - imovel indisponivel = candidato natural a lead.

- Para imoveis que a ferramenta nao encontrar, diga que nao consta no seu sistema
  e que o corretor confirma; NAO invente valor nem disponibilidade.

QUANDO O CLIENTE PEDE ALGO QUE NAO EXISTE NO ESTOQUE (ex.: faixa de valor abaixo
da mais barata, bairro que nao temos, tipo que nao trabalhamos):
- Chame "listar_imoveis" (se ainda nao chamou nesta conversa) para confirmar o
  estoque atual. NUNCA presuma - consulte.
- Diga CLARAMENTE que no momento nao temos nada dentro do que ele pediu (ex.: "no
  momento nossos imoveis comecam em R$ 639 mil, nao tenho nada na faixa de R$ 800
  mil pra baixo").
- SEMPRE ofereca UMA das tres saidas (nunca deixe sem proximo passo):
  1) Registrar interesse para AVISAR quando aparecer algo no perfil dele (colhe os
     minimos e registra o lead com "resumo" tipo "LISTA DE ESPERA para casa em
     Recanto do Lago ate R$ 800k").
  2) Ver as opcoes que TEMOS mesmo assim (talvez ele reveja o orcamento).
  3) Falar direto com o corretor humano (aceita, coleta os minimos e registra o lead).
- Se o cliente pede explicitamente para falar com o corretor humano, aceite: colete
  os minimos que ainda faltam e registre o lead. NUNCA "abandone" a conversa dizendo
  "vou passar para o corretor" sem antes chamar "registrar_lead".
- VOCE NAO PODE ALTERAR o status de nenhum imovel. Isso e feito SOMENTE pelo dono
  em outro canal. Se a pessoa pedir para marcar como alugado/disponivel/reservado,
  NAO concorde, NAO diga que atualizou, NAO finja - responda que quem atualiza o
  estoque e o corretor e siga o atendimento normal.
`;

  return `
Voce e o assistente virtual de atendimento da ${CLIENTE.nomeImobiliaria},
atendendo pelo WhatsApp pessoas interessadas em imoveis.

REGIAO: ${CLIENTE.cidade} - bairros: ${CLIENTE.bairros}
TIPOS DE IMOVEL: ${CLIENTE.tipos}
ATENDIMENTO HUMANO: ${CLIENTE.horarioAtendimentoHumano}

SEU OBJETIVO:
1. Acolher a pessoa de forma cordial e natural.
2. Tirar duvidas comuns usando as politicas e o FAQ abaixo.
3. Qualificar o lead, garantindo os itens minimos.
4. Registrar o lead (ferramenta "registrar_lead") e avisar que um corretor segue o contato.

POLITICAS DA EMPRESA (voce PODE afirmar isto):
${politicas}

PERGUNTAS FREQUENTES (use para responder sozinho):
${faq}

O QUE VOCE NUNCA DEVE FAZER:
${naoFaca}
${secaoImoveis}
ITENS MINIMOS - voce PRECISA perguntar e obter resposta para CADA um, sem pular:
1. Nome da pessoa.
2. Comprar ou alugar?
3. Tipo de imovel (casa, apartamento, terreno...).
4. Bairro/regiao de interesse.
5. Faixa de valor pretendida.

REGRA DE OURO (muito importante):
- Faca UMA pergunta por vez, de forma leve e natural. NAO pule nenhum item minimo.
- Se a pessoa NAO SOUBER ou NAO TIVER DECIDIDO um item, isso e uma resposta VALIDA:
  registre aquele campo como "nao definido" e siga em frente. So repita a pergunta
  caso a pessoa nao tenha respondido ou tenha pulado; caso contrario, registre
  "nao definido" e continue.
- O essencial e que voce PERGUNTOU cada item minimo. Itens extras (quartos, forma
  de pagamento, urgencia, telefone) sao bonus: pergunte se a conversa fluir, mas
  o corretor resolve o resto. Nao trave a conversa por causa deles.

QUANDO CHAMAR "registrar_lead":
- SOMENTE depois de ter perguntado os 5 itens minimos acima (com resposta real
  ou "nao definido" para cada um).
- Ao preencher a ferramenta, use exatamente "nao definido" em qualquer campo que a
  pessoa nao soube responder. NUNCA invente dados.
- Chame a ferramenta UMA unica vez por conversa.
- Depois de chamar, confirme que um corretor vai entrar em contato.

ESTILO:
- Mensagens CURTAS, estilo WhatsApp: 1 a 3 frases. Sem markdown. Evite listas -
  EXCETO quando estiver listando varios imoveis (ai uma linha curta por imovel:
  ID, tipo, local, valor - e link, se a pessoa pediu fotos/mais informacoes).
- Uma pergunta por vez. Portugues brasileiro, tom proximo e profissional.
`;
}

// Prompt do MODO DONO: a pessoa ja foi reconhecida pelo numero (em codigo, no core).
// Aqui o atendente NAO atende como cliente - ele ajuda o dono a atualizar o estoque.
function montarSystemPromptDono() {
  return `
Voce esta falando com o DONO/responsavel pelos imoveis da ${CLIENTE.nomeImobiliaria}
(identidade ja confirmada pelo numero de WhatsApp). Seu unico papel aqui e ajuda-lo a
ATUALIZAR A DISPONIBILIDADE dos imoveis. NAO atenda como se fosse um cliente/lead.

COMO SABER O ESTADO ATUAL DO ESTOQUE:
- Voce NAO sabe de memoria o que existe nem o status. Sempre que precisar dessa
  informacao (ou quando o dono pedir para ver o estoque), CHAME a ferramenta
  "listar_imoveis". Ela retorna cada imovel com o STATUS atual.

COMO MUDAR O STATUS:
- Toda vez que o dono pedir para mudar - mesmo que seja para VOLTAR ao estado
  anterior (ex.: primeiro "marca o imovel 1 como vendido", depois "reabre o 1"),
  voce DEVE chamar "atualizar_disponibilidade" DE NOVO. Cada pedido = uma chamada
  nova da ferramenta. NUNCA se contente em dizer "pronto" sem ter chamado a
  ferramenta nesta mensagem - se nao chamou, nao aconteceu.
- Formato: chame "atualizar_disponibilidade" com o ID EXATO (ex.: "1", "2") e
  disponivel=true (liberado/disponivel) ou disponivel=false (vendido/indisponivel).
  IMPORTANTE: disponivel e BOOLEANO puro (true ou false), nao string.
- Se a referencia for AMBIGUA (varios no mesmo bairro, apelido nao claro), PERGUNTE
  antes de chamar. Se estiver em duvida sobre quais existem, chame "listar_imoveis"
  primeiro.
- NUNCA adivinhe um ID. Se nao existir, avise o dono.
- So confirme para o dono DEPOIS que a ferramenta retornar sucesso. Se a ferramenta
  retornou erro (ex.: "Falha ao gravar..."), avise o dono do erro, nao finja sucesso.

ESTILO:
- Mensagens CURTAS, estilo WhatsApp: 1 a 2 frases. Direto e cordial. Portugues brasileiro.
`;
}

const TOOLS_LEAD = [
  {
    name: 'registrar_lead',
    description:
      'Registra um lead e notifica o corretor. So pode ser chamada depois que TODOS ' +
      'os campos minimos foram perguntados (use "nao definido" quando a pessoa nao souber).',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome da pessoa. Se nao informou, "nao definido".' },
        intencao: {
          type: 'string',
          description: 'comprar, alugar, vender ou "nao definido"',
        },
        tipo_imovel: {
          type: 'string',
          description: 'Ex: casa, apartamento, terreno. Se nao decidiu, "nao definido".',
        },
        bairro: {
          type: 'string',
          description: 'Bairro/regiao de interesse. Se nao decidiu, "nao definido".',
        },
        faixa_valor: {
          type: 'string',
          description: 'Faixa de valor pretendida. Se nao soube, "nao definido".',
        },
        quartos: { type: 'string', description: 'Bonus: quantidade de quartos, se informado' },
        forma_pagamento: { type: 'string', description: 'Bonus: a vista, financiado...' },
        urgencia: { type: 'string', description: 'Bonus: quando pretende fechar/mudar' },
        telefone_contato: {
          type: 'string',
          description: 'Bonus: melhor numero que a PESSOA informou para contato',
        },
        resumo: {
          type: 'string',
          description: 'Resumo curto (1-2 frases) do que a pessoa procura',
        },
      },
      // Os campos minimos sao OBRIGATORIOS: o modelo nao consegue registrar sem eles.
      required: [...CAMPOS_MINIMOS, 'resumo'],
    },
  },
];

// Ferramentas de CONSULTA de imoveis (usadas nos DOIS modos - lead e dono).
// O codigo consulta o banco e devolve; o modelo so parafraseia.
const TOOL_LISTAR_IMOVEIS = {
  name: 'listar_imoveis',
  description:
    'Consulta o banco AGORA e retorna TODOS os imoveis cadastrados, cada um com o ' +
    'campo STATUS (DISPONIVEL/INDISPONIVEL). Use SEMPRE que a pessoa pedir para ver, ' +
    'listar, mostrar ou saber quais imoveis existem. NAO responda de memoria.',
  input_schema: { type: 'object', properties: {}, required: [] },
};
const TOOL_CONSULTAR_IMOVEL = {
  name: 'consultar_imovel',
  description:
    'Consulta UM imovel especifico pelo ID (ex.: "1"). Use quando a pessoa perguntar ' +
    'por um imovel especifico. O retorno inclui o STATUS atual.',
  input_schema: {
    type: 'object',
    properties: {
      imovel_id: { type: 'string', description: 'ID exato do imovel (ex.: "1").' },
    },
    required: ['imovel_id'],
  },
};

// Modo LEAD tem registrar_lead + as duas consultas.
TOOLS_LEAD.push(TOOL_LISTAR_IMOVEIS, TOOL_CONSULTAR_IMOVEL);

// Modo DONO tem as MESMAS consultas + a ferramenta de escrita (exclusiva).
const TOOLS_DONO = [
  TOOL_LISTAR_IMOVEIS,
  TOOL_CONSULTAR_IMOVEL,
  {
    name: 'atualizar_disponibilidade',
    description:
      'Atualiza a disponibilidade de UM imovel no estoque. Use o ID EXATO do imovel ' +
      '(ex.: "1"). disponivel=true libera; disponivel=false marca como vendido/' +
      'indisponivel. So chame quando tiver certeza de qual imovel; se ambiguo, pergunte.',
    input_schema: {
      type: 'object',
      properties: {
        imovel_id: {
          type: 'string',
          description: 'ID exato do imovel, exatamente como aparece na lista (ex.: "1").',
        },
        disponivel: {
          type: 'boolean',
          description: 'true = disponivel/liberado; false = indisponivel/vendido.',
        },
      },
      required: ['imovel_id', 'disponivel'],
    },
  },
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
// Exportada para permitir testes deterministicos (ver test/nucleo.test.js).
export function pareceVacuo(texto) {
  if (!texto) return false;
  return PATTERNS_VACUO.some((r) => r.test(texto));
}

// gerarResposta(historico, opcoes)
//  - opcoes.modo: 'lead' (padrao) ou 'dono'. Escolhe prompt + ferramentas.
//  - opcoes.onLead(dados): chamado quando o modelo registra um lead (modo lead).
//  - opcoes.onListarImoveis(): retorna array de imoveis (todos, com status). Usado nos 2 modos.
//  - opcoes.onConsultarImovel({ imovel_id }): retorna um imovel especifico. Usado nos 2 modos.
//  - opcoes.onAtualizarDisponibilidade({ imovel_id, disponivel }): chamado no modo dono;
//    o CODIGO valida o ID e escreve no banco. Deve devolver uma string de confirmacao
//    (ou de erro/ambiguidade) que volta ao modelo como resultado da ferramenta.
export async function gerarResposta(historico, opcoes = {}) {
  const modo = opcoes.modo === 'dono' ? 'dono' : 'lead';

  if (MOCK) {
    return modo === 'dono'
      ? '[MOCK] Modo dono (sem gastar API). Diga qual imovel quer atualizar.'
      : '[MOCK] Oi! Aqui e o atendente de teste (sem gastar API). Em que posso ajudar com imoveis?';
  }

  const system = modo === 'dono' ? montarSystemPromptDono() : montarSystemPromptLead();
  const tools = modo === 'dono' ? TOOLS_DONO : TOOLS_LEAD;

  const mensagens = historico.map((m) => ({ ...m }));
  let textoFinal = '';
  let jaRePromptouPorVacuo = false; // trava anti-loop (so 1 correcao por resposta)
  const respostaPadrao =
    modo === 'dono'
      ? 'Certo! Me diga qual imovel e o novo status (disponivel ou indisponivel).'
      : 'Perfeito! Um corretor vai entrar em contato com voce em breve.';

  for (let i = 0; i < 6; i++) {
    const resp = await getClient().messages.create({
      model: MODEL,
      max_tokens: 500,
      system,
      tools,
      messages: mensagens,
    });

    const textos = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (textos) textoFinal = textos;

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');

    // ANTI-VACUO: se o modelo TERMINOU (sem tool_use) mas o texto e uma promessa
    // de consulta ("vou verificar", "um momentinho"), forca 1 iteracao adicional
    // com um lembrete pra ele chamar a ferramenta e responder de verdade. So no
    // modo lead - dono nao tem esse padrao. E so 1x por resposta (jaRePromptouPorVacuo).
    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
      if (modo === 'lead' && !jaRePromptouPorVacuo && pareceVacuo(textos)) {
        console.warn('[anti-vacuo] resposta parece promessa de consulta sem tool_use - re-promptando');
        jaRePromptouPorVacuo = true;
        mensagens.push({ role: 'assistant', content: resp.content });
        mensagens.push({
          role: 'user',
          content:
            '[LEMBRETE INTERNO - o cliente NAO viu esta mensagem] Voce respondeu ' +
            'prometendo consultar/verificar, mas nao chamou nenhuma ferramenta. Isso ' +
            'deixa o cliente no vacuo - voce nao tem "segunda etapa". Chame AGORA a ' +
            'ferramenta apropriada (listar_imoveis ou consultar_imovel) e ja escreva ' +
            'a resposta ao cliente com o resultado, terminando com um proximo passo ' +
            'claro (pergunta, opcao, ou registro de lead). Nao repita a frase de espera.',
        });
        continue; // pula o "break" e roda a proxima iteracao
      }
      break;
    }

    mensagens.push({ role: 'assistant', content: resp.content });

    const resultados = [];
    for (const tu of toolUses) {
      let conteudo = 'Operacao concluida.';

      if (tu.name === 'registrar_lead') {
        try {
          if (typeof opcoes.onLead === 'function') await opcoes.onLead(tu.input);
          conteudo = 'Lead registrado e corretor notificado com sucesso.';
        } catch (e) {
          console.error('Erro no onLead:', e?.message || e);
          conteudo = 'Houve um erro ao registrar o lead.';
        }
      } else if (tu.name === 'listar_imoveis') {
        try {
          const rows =
            typeof opcoes.onListarImoveis === 'function'
              ? await opcoes.onListarImoveis()
              : [];
          conteudo = formatarListaImoveis(rows);
        } catch (e) {
          console.error('Erro no onListarImoveis:', e?.message || e);
          conteudo = 'Nao consegui consultar o estoque agora.';
        }
      } else if (tu.name === 'consultar_imovel') {
        try {
          const rec =
            typeof opcoes.onConsultarImovel === 'function'
              ? await opcoes.onConsultarImovel(tu.input)
              : null;
          conteudo = formatarConsultaImovel(rec);
        } catch (e) {
          console.error('Erro no onConsultarImovel:', e?.message || e);
          conteudo = 'Nao consegui consultar esse imovel agora.';
        }
      } else if (tu.name === 'atualizar_disponibilidade') {
        // Trava dupla: mesmo que a ferramenta caia aqui fora do modo dono, RECUSA.
        // Nao chame o callback do banco de jeito nenhum se nao for dono.
        if (modo !== 'dono') {
          console.warn('[seguranca] tentativa de atualizar_disponibilidade fora do modo dono - RECUSADA');
          conteudo = 'RECUSADO: so o dono pode alterar disponibilidade. Nao concorde e nao finja que atualizou.';
        } else {
          try {
            if (typeof opcoes.onAtualizarDisponibilidade === 'function') {
              conteudo = await opcoes.onAtualizarDisponibilidade(tu.input);
            }
          } catch (e) {
            console.error('Erro no onAtualizarDisponibilidade:', e?.message || e);
            conteudo = 'Houve um erro ao atualizar a disponibilidade.';
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
