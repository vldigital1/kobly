// Catálogo das plataformas em Integrações → Plataformas: o que cada uma faz na Kobly, como conectar e o
// passo a passo no painel dela. `logo`: ícone oficial (site da própria plataforma) em /public/assets/platforms;
// `logoBg`: fundo do quadro quando o ícone é branco;
// sem logo, o cartão mostra as iniciais na cor da marca.
export const SALES_PLATFORMS = [
  { id: 'hotmart', logo: '/assets/platforms/hotmart.png', name: 'Hotmart', color: '#F04E23', mono: 'H', mode: 'manual', docs: 'https://developers.hotmart.com/docs/pt-BR/',
    desc: 'Vendas, Pix/boleto gerado, abandono, reembolso e chargeback pelo webhook 2.0.',
    secretLabel: 'Hottok', secretHint: 'A Hotmart manda o Hottok no cabeçalho X-HOTMART-HOTTOK; com ele salvo, aviso sem Hottok é recusado.',
    steps: ['Na Hotmart, abra Ferramentas → Webhook (API e notificações).', 'Clique em Cadastrar webhook, cole a URL da Kobly e escolha a versão 2.0.', 'Marque os eventos: compra aprovada, boleto impresso, compra cancelada, expirada, reembolso, chargeback e abandono de carrinho.', 'Copie o Hottok da sua conta e cole aqui.'] },
  { id: 'kiwify', logo: '/assets/platforms/kiwify.svg', name: 'Kiwify', color: '#00B37E', mono: 'K', mode: 'api', docs: 'https://docs.kiwify.com.br/api-reference/general',
    desc: 'Conecta pela API: a Kobly cria o webhook na sua conta e confere a assinatura de cada aviso.',
    fields: [['client_id', 'Client ID'], ['client_secret', 'Client Secret', true], ['account_id', 'Account ID']],
    steps: ['Na Kiwify, abra Apps → API e crie uma API Key.', 'Copie Client ID, Client Secret e Account ID e cole aqui.', 'A Kobly cria o webhook "Kobly — recuperação" com todos os produtos e eventos de venda.'] },
  { id: 'cakto', logo: '/assets/platforms/cakto.svg', name: 'Cakto', color: '#16A34A', mono: 'C', mode: 'api', docs: 'https://docs.cakto.com.br/introduction',
    desc: 'Conecta pela API: a Kobly cria o webhook com todos os seus produtos e confere o secret de cada aviso.',
    fields: [['client_id', 'Client ID'], ['client_secret', 'Client Secret', true]],
    steps: ['No painel da Cakto, crie uma chave de API com acesso a produtos e webhooks.', 'Copie Client ID e Client Secret (o secret aparece uma vez só) e cole aqui.', 'A Kobly cria o webhook com Pix gerado, boleto, compra aprovada/recusada, abandono, reembolso e chargeback.'] },
  { id: 'kirvano', logo: '/assets/platforms/kirvano.ico', name: 'Kirvano', color: '#7C3AED', mono: 'K', mode: 'manual', docs: 'https://help.kirvano.com/hc/central-de-ajuda/pt_BR/categories/integracoes',
    desc: 'Pix gerado, venda aprovada, recusada, reembolso, chargeback e carrinho abandonado.',
    steps: ['Na Kirvano, abra Integrações → Webhooks e crie um webhook.', 'Cole a URL da Kobly e selecione os eventos (PIX gerado, venda aprovada, carrinho abandonado e os demais).', 'Salve e use "Enviar teste": o evento aparece aqui em "Último aviso".'] },
  { id: 'perfectpay', logo: '/assets/platforms/perfectpay.png', name: 'PerfectPay', color: '#2563EB', mono: 'P', mode: 'manual', docs: 'https://help.perfectpay.com.br/article/597-integracao-via-webhook-com-a-perfect-pay',
    desc: 'Aprovadas, boleto/Pix pendente, abandono (checkout salvo), reembolso e chargeback, com UTMs.',
    secretLabel: 'Token do postback', secretHint: 'A PerfectPay manda o token no corpo do aviso; com ele salvo, aviso com outro token é recusado.',
    steps: ['Na PerfectPay, abra Ferramentas → Postback/Webhook e crie uma nova configuração.', 'Escolha os produtos, cole a URL da Kobly, marque todos os status e o formato PerfectPay.', 'Copie o token mostrado na configuração e cole aqui.'] },
  { id: 'payt', logo: '/assets/platforms/payt.png', logoBg: '#111827', name: 'Payt', color: '#F59E0B', mono: 'P', mode: 'manual', docs: 'https://help.payt.com.br/article/155-postback',
    desc: 'Aguardando pagamento (Pix/boleto), aprovadas, expiradas, abandono e reembolsos, com UTMs.',
    secretLabel: 'Chave de integração (integration_key)', secretHint: 'A Payt manda a integration_key no corpo do postback; com ela salva, aviso com outra chave é recusado.',
    steps: ['Na Payt, abra Configurações → Postbacks e cadastre um postback (V1).', 'Cole a URL da Kobly e marque os eventos de venda e de carrinho abandonado.', 'Copie a chave de integração e cole aqui.'] },
];

export const GATEWAYS = [
  { id: 'xpag', logo: '/assets/platforms/xpag.png', name: 'XPag', color: '#111827', mono: 'X', desc: 'Pix (BRL), SPEI e OXXO (MXN), Nequi e Bre-B (COP), transferência (ARS) e Chile (CLP).', id_label: 'Client ID', secret: 'Client Secret', where: 'Painel da XPag → Integrações → API.' },
  { id: 'mercadopago', logo: '/assets/platforms/mercadopago.svg', name: 'Mercado Pago', color: '#00B1EA', mono: 'MP', desc: 'Pix (BRL).', secret: 'Access Token', where: 'Mercado Pago Developers → Suas integrações → Credenciais de produção. Credencial de teste começa com TEST-.' },
  { id: 'pushinpay', logo: '/assets/platforms/pushinpay.png', name: 'PushinPay', color: '#6D28D9', mono: 'PP', desc: 'Pix (BRL), a partir de R$ 0,50.', secret: 'Token da API', where: 'Painel da PushinPay → Configurações → API (a liberação da API pode precisar de pedido ao suporte).' },
  { id: 'syncpay', logo: '/assets/platforms/syncpay.svg', name: 'SyncPay', color: '#2563EB', mono: 'S', desc: 'Pix (BRL), a partir de R$ 1,00.', id_label: 'Client ID', secret: 'Client Secret', where: 'Painel da SyncPay → Credenciais de API (o Client Secret aparece uma vez só).' },
  { id: 'woovi', logo: '/assets/platforms/woovi.webp', name: 'Woovi', color: '#03D69D', mono: 'W', desc: 'Pix (BRL).', secret: 'AppID', where: 'Painel da Woovi → API/Plugins → Nova API. Depois cadastre o webhook "Cobrança paga" com o endereço copiado aqui.' },
  { id: 'zenith', logo: '/assets/platforms/zenith.png', name: 'Zenith', color: '#0F172A', mono: 'Z', desc: 'SPEI (MXN) e outros métodos locais. A Kobly registra o webhook sozinha.', id_label: 'Chave pública (X-API-Key)', secret: 'Chave secreta (X-API-Secret)', where: 'Painel da Zenith → Integrações. Use as chaves de sandbox para testar.', sandbox: true },
];

export const gatewayOf = (id) => GATEWAYS.find((g) => g.id === id) || null;
export const platformOf = (id) => SALES_PLATFORMS.find((p) => p.id === id) || null;
