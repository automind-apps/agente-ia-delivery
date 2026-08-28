// src/config-cliente.js
// ==========================================================================
// ESTE E O ARQUIVO QUE VOCE PERSONALIZA PARA CADA CLIENTE.
// Tudo aqui vira o "conhecimento" do atendente. Quanto melhor preenchido,
// melhor ele atende. Os textos abaixo sao GENERICOS - troque pelos dados
// reais da imobiliaria quando fechar o cliente.
// ==========================================================================

export const CLIENTE = {
  // ---- Identidade ----
  nomeImobiliaria: 'Remax Horizonte',
  cidade: 'São João da Boa Vista',
  bairros: 'Recanto do Lago e Terras de São José, Recanto dos Passaros',
  tipos: 'casas e apartamentos',
  horarioAtendimentoHumano: 'segunda a sexta, 9h as 18h, e sabado 9h as 13h',

  // ---- Politicas da empresa (o que o atendente PODE afirmar) ----
  // Escreva como regras curtas e verdadeiras. Se nao souber, deixe vazio
  // que o atendente vai dizer que confirma com o corretor.
  politicas: [
    'A imobiliaria trabalha com compra, venda e locacao de imoveis.',
    'As visitas sao agendadas com um corretor e acompanhadas por ele.',
    'A documentacao e analise de credito sao orientadas pelo corretor responsavel.',
    'Nao cobramos taxa para o interessado apenas visitar um imovel.',
  ],

  // ---- FAQ: perguntas frequentes e como responder ----
  // O atendente usa isto para responder sozinho as duvidas comuns.
  faq: [
    {
      pergunta: 'Quais documentos preciso para alugar?',
      resposta:
        'Em geral pedimos documento com foto, CPF, comprovante de renda e de residencia. O corretor confirma a lista completa conforme o imovel.',
    },
    {
      pergunta: 'Posso financiar a compra?',
      resposta:
        'Sim, trabalhamos com imoveis que aceitam financiamento. O corretor te orienta sobre simulacao e aprovacao de credito.',
    },
    {
      pergunta: 'Aceita pet?',
      resposta:
        'Depende do imovel e das regras do condominio. Posso anotar isso e o corretor confirma para o imovel do seu interesse.',
    },
    {
      pergunta: 'Tem taxa para visitar?',
      resposta: 'Nao. A visita acompanhada pelo corretor nao tem custo para voce.',
    },
  ],

  // ---- Limites: o que o atendente NUNCA deve fazer ----
  naoFaca: [
    'Informar precos, metragens ou disponibilidade de imoveis que NAO estejam na lista IMOVEIS abaixo (nao tem acesso a isso).',
    'Prometer aprovacao de financiamento ou condicoes de pagamento.',
    'Dar parecer juridico ou garantir prazos de contrato.',
    'Inventar imoveis ou caracteristicas.',
  ],

  // ---- Donos / responsaveis que podem ATUALIZAR a disponibilidade pelo WhatsApp ----
  // SO DIGITOS, com DDI+DDD, igual ao CORRETOR_WHATSAPP do .env. Ex.: '5511999998888'.
  // Mensagem vinda de QUALQUER numero desta lista entra em "modo dono" (atualiza
  // estoque) em vez de ser atendida como lead. O reconhecimento e feito EM CODIGO
  // pelo numero - NUNCA por alguem dizer "sou o dono" na conversa.
  // Deixe a lista vazia ([]) se ninguem for atualizar estoque por chat.
  donosWhatsApp: [
    '19997028037',
  ],

  // ---- IMOVEIS (descricao ESTATICA; a disponibilidade vive no banco) ----
  // Cada imovel tem um ID curto e ESTAVEL (ex.: 'IMOVEL 02') que tanto o lead quanto
  // o dono usam para apontar sem ambiguidade. Aqui fica so o que quase nunca muda
  // (tipo, local, valor, regras). O campo "Status:" (disponivel/indisponivel) NAO
  // mora aqui - ele e lido do banco a cada mensagem e pode ser mudado pelo dono.
  // Deixe a lista vazia ([]) para o atendente voltar a so coletar leads (sem estoque).
  imoveis: [
    {
      id: '1',
      tipo: 'Casa',
      local: 'Rua Colibri, 119, Jardim Recanto dos Pássaros, São João da Boa Vista, São Paulo, 13873504',
      valor: '639000 + IPTU de 1208,52',
      dormitorios: '3',
      suites: '1',
      banheiros: '3',
      tamanho: '182 m2',
      detalhes: 'garagem para 2 carros e area gourmet',
      link: 'https://www.remax.com.br/pt-br/imoveis/casa/venda/sao-joao-da-boa-vista/119-rua-colibri/780291010-30',
    },
    {
      id: '2',
      tipo: 'Apartamento',
      local: 'Rua Haig Mousessian, 37 - Lago do Recanto do Lago - Recanto do Lago, São João da Boa Vista, São Paulo, 13874658',
      valor: '1600000 + condominio 853 mensal',
      dormitorios: '3',
      suites: '3',
      banheiros: '5',
      tamanho: '157 m2',
      detalhes: 'estacionamento com 2 vagas',
      link: 'https://www.remax.com.br/pt-br/imoveis/apartamento/venda/sao-joao-da-boa-vista/37-rua-haig-mousessian-lago-do-recanto-do-lago/780291010-33',
    },
    {
      id: '3',
      tipo: 'Casa',
      local: 'Rua José Carlos Campos, 156, Recanto do Lago, São João da Boa Vista, São Paulo, 13874665',
      valor: '647000 + IPTU de 1211',
      dormitorios: '4',
      suites: '1',
      banheiros: '3',
      tamanho: '192 m2',
      detalhes: '',
      link: 'https://www.remax.com.br/pt-br/imoveis/casa/venda/sao-joao-da-boa-vista/156-rua-jose-carlos-campos/780291010-34',
    },
  ],
};
