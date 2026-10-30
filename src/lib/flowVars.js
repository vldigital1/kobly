// Variáveis que o editor de fluxo oferece no seletor "Clique para inserir variável…".
// Saudação personalizada: mesma lista do servidor (server/src/flows/greetings.js).

export const SYSTEM_VARS = [
  ['nome', 'Nome completo'], ['primeiro_nome', 'Primeiro nome'], ['telefone', 'Telefone'], ['email', 'E-mail'],
  ['produto', 'Produto'], ['valor', 'Valor da compra'], ['cta_link', 'Link do checkout / recuperação'], ['evento', 'Evento do checkout'],
  ['ultima_mensagem', 'Última mensagem do lead'], ['mensagem_inicial', 'Mensagem que iniciou o fluxo'],
  ['data_atual', 'Data de hoje'], ['hora_atual', 'Hora agora'], ['dia_semana', 'Dia da semana'],
  ['pagamento_codigo', 'Pix copia e cola (bloco Cobrança)'], ['pagamento_qr', 'QR Code do Pix (bloco Cobrança)'], ['pagamento_link', 'Link de pagamento (bloco Cobrança)'], ['pagamento_valor', 'Valor cobrado (bloco Cobrança)'],
].map(([code, label]) => ({ code, label }));

export const AD_VARS = [
  ['source_id', 'ID de origem do anúncio'], ['ctwa_clid', 'ID do clique no anúncio (Meta)'], ['ad_source_url', 'Link do anúncio'],
  ['ad_title', 'Título do anúncio'], ['ad_body', 'Texto do anúncio'],
].map(([code, label]) => ({ code, label }));

const G = (code, flag, label) => ({ code: `saudacao_personalizada${code ? `_${code}` : ''}`, flag, label });
export const GREETING_VARS = [
  G('', '🇧🇷', 'Português · pelo país do lead'), G('pt_br', '🇧🇷', 'Brasil · Português · Brasília'), G('pt_pt', '🇵🇹', 'Portugal · Português · Lisboa'),
  G('pt_ao', '🇦🇴', 'Angola · Português · Luanda'), G('pt_mz', '🇲🇿', 'Moçambique · Português · Maputo'),
  G('es', '🌎', 'Espanhol genérico · pelo país do lead'), G('es_mx', '🇲🇽', 'México · Espanhol · Cidade do México'), G('es_gt', '🇬🇹', 'Guatemala · Espanhol · Cidade da Guatemala'),
  G('es_sv', '🇸🇻', 'El Salvador · Espanhol · San Salvador'), G('es_hn', '🇭🇳', 'Honduras · Espanhol · Tegucigalpa'), G('es_ni', '🇳🇮', 'Nicarágua · Espanhol · Manágua'),
  G('es_cr', '🇨🇷', 'Costa Rica · Espanhol · San José'), G('es_pa', '🇵🇦', 'Panamá · Espanhol · Cidade do Panamá'), G('es_cu', '🇨🇺', 'Cuba · Espanhol · Havana'),
  G('es_do', '🇩🇴', 'Rep. Dominicana · Espanhol · Santo Domingo'), G('es_pr', '🇵🇷', 'Porto Rico · Espanhol · San Juan'), G('es_co', '🇨🇴', 'Colômbia · Espanhol · Bogotá'),
  G('es_ve', '🇻🇪', 'Venezuela · Espanhol · Caracas'), G('es_ec', '🇪🇨', 'Equador · Espanhol · Guayaquil'), G('es_pe', '🇵🇪', 'Peru · Espanhol · Lima'),
  G('es_bo', '🇧🇴', 'Bolívia · Espanhol · La Paz'), G('es_cl', '🇨🇱', 'Chile · Espanhol · Santiago'), G('es_ar', '🇦🇷', 'Argentina · Espanhol · Buenos Aires'),
  G('es_uy', '🇺🇾', 'Uruguai · Espanhol · Montevidéu'), G('es_py', '🇵🇾', 'Paraguai · Espanhol · Assunção'), G('es_es', '🇪🇸', 'Espanha · Espanhol · Madri'),
  G('en', '🌐', 'Inglês genérico · pelo país do lead'), G('en_us_et', '🇺🇸', 'EUA · Inglês · Nova York (leste)'), G('en_us_ct', '🇺🇸', 'EUA · Inglês · Chicago (centro)'),
  G('en_us_mt', '🇺🇸', 'EUA · Inglês · Denver (montanha)'), G('en_us_pt', '🇺🇸', 'EUA · Inglês · Los Angeles (pacífico)'), G('en_ca', '🇨🇦', 'Canadá · Inglês · Toronto'),
  G('en_gb', '🇬🇧', 'Reino Unido · Inglês · Londres'), G('en_ie', '🇮🇪', 'Irlanda · Inglês · Dublin'), G('en_au', '🇦🇺', 'Austrália · Inglês · Sydney'),
  G('en_nz', '🇳🇿', 'Nova Zelândia · Inglês · Auckland'), G('en_za', '🇿🇦', 'África do Sul · Inglês · Joanesburgo'), G('en_in', '🇮🇳', 'Índia · Inglês · Nova Délhi'),
  G('en_ng', '🇳🇬', 'Nigéria · Inglês · Lagos'), G('en_ph', '🇵🇭', 'Filipinas · Inglês · Manila'),
];

// Condição "País": DDI do telefone do lead
export const COUNTRIES = [
  ['55', '🇧🇷', 'Brasil'], ['351', '🇵🇹', 'Portugal'], ['52', '🇲🇽', 'México'], ['57', '🇨🇴', 'Colômbia'], ['54', '🇦🇷', 'Argentina'], ['56', '🇨🇱', 'Chile'],
  ['51', '🇵🇪', 'Peru'], ['593', '🇪🇨', 'Equador'], ['591', '🇧🇴', 'Bolívia'], ['595', '🇵🇾', 'Paraguai'], ['598', '🇺🇾', 'Uruguai'], ['58', '🇻🇪', 'Venezuela'],
  ['502', '🇬🇹', 'Guatemala'], ['503', '🇸🇻', 'El Salvador'], ['504', '🇭🇳', 'Honduras'], ['505', '🇳🇮', 'Nicarágua'], ['506', '🇨🇷', 'Costa Rica'], ['507', '🇵🇦', 'Panamá'],
  ['1809', '🇩🇴', 'Rep. Dominicana'], ['34', '🇪🇸', 'Espanha'], ['1', '🇺🇸', 'EUA / Canadá'], ['44', '🇬🇧', 'Reino Unido'], ['91', '🇮🇳', 'Índia'], ['244', '🇦🇴', 'Angola'],
].map(([ddi, flag, nome]) => ({ ddi, flag, nome }));

export const REACTION_SUGGESTIONS = ['👍', '❤️', '😂', '🙏'];
export const EMOJIS = ['😀', '😁', '😂', '🤣', '😊', '😍', '🥰', '😘', '😉', '😎', '🤩', '🥳', '🤔', '😅', '😢', '😭', '😱', '🙄', '😴', '🤗',
  '👍', '👏', '🙌', '🙏', '💪', '👉', '👇', '✌️', '🤝', '👋', '❤️', '🧡', '💛', '💚', '💙', '💜', '🔥', '✨', '⭐', '🎉',
  '🎁', '💰', '💸', '✅', '❌', '⚠️', '📌', '📣', '⏰', '🚀', '💡', '📲', '💬', '🛒', '🏷️', '📦', '🎯', '💎', '🆓', '👀'];

// variáveis criadas pelos blocos do próprio fluxo (Aguardar resposta, Botões, Definir variável, IA, Cobrança, Webhook)
export function flowVarsOf(nodes) {
  const out = new Set();
  for (const n of nodes || []) {
    const t = n.data && n.data.type, d = (n.data && n.data.data) || {};
    if (t === 'wait_reply' || t === 'send_buttons') out.add(d.save_as || 'resposta');
    if (t === 'set_var' && d.name) out.add(d.name);
    if (t === 'ai_extract') for (const f of d.fields || []) if (f.name) out.add(f.name);
    if (t === 'payment') { const p = d.save_as || 'pagamento'; ['codigo', 'qr', 'link', 'valor', 'status'].forEach((k) => out.add(`${p}_${k}`)); }
    if (t === 'webhook') { const p = d.save_as || 'webhook'; out.add(`${p}_status`); out.add(`${p}_resposta`); }
  }
  return [...out].filter((v) => /^[a-z][a-z0-9_]*$/.test(v)).sort().map((code) => ({ code, label: '' }));
}
