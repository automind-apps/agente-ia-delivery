// src/config-cliente.js
// ==========================================================================
// ESTE E O ARQUIVO QUE VOCE PERSONALIZA PARA CADA CLIENTE (LANCHONETE/
// PIZZARIA/HAMBURGUERIA/RESTAURANTE). Tudo aqui vira o "conhecimento" do
// atendente. Quanto melhor preenchido, melhor ele atende. Os textos abaixo
// sao GENERICOS - troque pelos dados reais do estabelecimento quando fechar
// o cliente.
// ==========================================================================

export const CLIENTE = {
  // ---- Identidade ----
  nomeEstabelecimento: 'Lanchonete do Joao',
  tipoEstabelecimento: 'lanchonete', // lanchonete | pizzaria | hamburgueria | restaurante | marmita
  cidade: 'Araras',
  bairro: 'Centro',

  // ---- Horario de funcionamento ----
  // Chaves: segunda, terca, quarta, quinta, sexta, sabado, domingo.
  // Formato "HH:MM". Se um dia nao abre, use fechado: true.
  // Se abrir e fechar no mesmo dia (o padrao), so preencher abre/fecha.
  // Para virar madrugada (ex.: 18:00 -> 02:00 do dia seguinte), coloque
  // fecha maior que 24 (ex.: "26:00") OU fecha menor que abre - o codigo
  // interpreta isso como "vira o dia".
  horarioFuncionamento: {
    segunda: { abre: '18:00', fecha: '23:00' },
    terca: { abre: '18:00', fecha: '23:00' },
    quarta: { abre: '18:00', fecha: '23:00' },
    quinta: { abre: '18:00', fecha: '23:00' },
    sexta: { abre: '18:00', fecha: '00:00' },
    sabado: { abre: '18:00', fecha: '00:00' },
    domingo: { abre: '18:00', fecha: '23:00' },
  },

  // ---- Entrega ----
  // bairrosAtendidos: lista de bairros que o estabelecimento entrega.
  // Comparacao e case-insensitive e ignora acentos.
  bairrosAtendidos: ['Centro', 'Vila Nova', 'Jardim Europa'],
  taxaEntregaPadrao: 5.0, // R$ (adicionado a todo pedido)
  tempoMedioEntrega: '40-60 minutos',
  valorMinimoPedido: 20.0, // R$ (0 se nao tiver minimo)

  // ---- Cardapio ----
  // Estrutura: array de categorias, cada categoria tem itens { nome, descricao, preco }.
  // O NOME e o identificador - deve ser unico dentro do cardapio inteiro (o codigo
  // usa nome para casar o item do pedido e pegar o preco - modelo NAO calcula preco).
  // Se um item estiver esgotado, marque disponivel: false (padrao true).
  cardapio: [
    {
      categoria: 'Hamburgueres',
      itens: [
        { nome: 'X-Burguer', descricao: 'Pao, carne, queijo, alface, tomate', preco: 18.0 },
        { nome: 'X-Bacon', descricao: 'Pao, carne, queijo, bacon, alface, tomate', preco: 22.0 },
        { nome: 'X-Tudo', descricao: 'Pao, 2 carnes, queijo, bacon, ovo, alface, tomate', preco: 28.0 },
      ],
    },
    {
      categoria: 'Porcoes',
      itens: [
        { nome: 'Batata frita M', descricao: '300g', preco: 15.0 },
        { nome: 'Batata frita G', descricao: '500g', preco: 22.0 },
      ],
    },
    {
      categoria: 'Bebidas',
      itens: [
        { nome: 'Coca-Cola lata', descricao: '350ml', preco: 6.0 },
        { nome: 'Guarana lata', descricao: '350ml', preco: 6.0 },
        { nome: 'Agua sem gas', descricao: '500ml', preco: 4.0 },
      ],
    },
  ],

  // ---- Pagamento ----
  formasPagamento: ['Dinheiro', 'Cartao na entrega (debito/credito)', 'PIX'],
  chavePix: '19999999999', // chave PIX - so informar quando o cliente escolher PIX
  aceitaVoucher: false, // vale-refeicao etc.

  // ---- Regras / observacoes especiais que o atendente pode citar ----
  observacoesEspeciais: [
    'Nao fazemos entrega para bairros fora da lista.',
    'Pedidos depois das 22h30 podem ter tempo maior de entrega.',
  ],

  // ---- Donos / responsaveis que RECEBEM as notificacoes de pedido ----
  // SO DIGITOS, com DDI+DDD. Ex.: '5519999998888'. O PRIMEIRO da lista e para
  // onde vai o resumo do pedido pelo WhatsApp (index.js). Se voce quiser um
  // canal separado (grupo, outro numero), use DONO_WHATSAPP no .env - o env
  // sobrepoe esta lista.
  // Mensagens vindas destes numeros SAO IGNORADAS pelo bot (evita loop e
  // conversa acidental com o dono).
  donosWhatsApp: [
    '5519999998888',
  ],
};
