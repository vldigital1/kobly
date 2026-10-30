// Saudação personalizada: "Bom dia / Boa tarde / Boa noite" (ou em espanhol e inglês) conforme a hora no país.
//   {{saudacao_personalizada}}       português, no fuso do país do lead (pelo DDI) ou da empresa
//   {{saudacao_personalizada_es}}    espanhol genérico (idem)      {{saudacao_personalizada_en}} inglês genérico
//   {{saudacao_personalizada_es_mx}} espanhol no horário da Cidade do México … (lista abaixo)
// A tela do editor tem a mesma lista em src/lib/flowVars.js.

export const GREETING_WORDS = {
  pt: ['Bom dia', 'Boa tarde', 'Boa noite'],
  es: ['Buenos días', 'Buenas tardes', 'Buenas noches'],
  en: ['Good morning', 'Good afternoon', 'Good evening'],
};

// código → [idioma, fuso]
export const GREETING_PLACES = {
  pt_br: ['pt', 'America/Sao_Paulo'], pt_pt: ['pt', 'Europe/Lisbon'], pt_ao: ['pt', 'Africa/Luanda'], pt_mz: ['pt', 'Africa/Maputo'],
  es_mx: ['es', 'America/Mexico_City'], es_gt: ['es', 'America/Guatemala'], es_sv: ['es', 'America/El_Salvador'], es_hn: ['es', 'America/Tegucigalpa'],
  es_ni: ['es', 'America/Managua'], es_cr: ['es', 'America/Costa_Rica'], es_pa: ['es', 'America/Panama'], es_cu: ['es', 'America/Havana'],
  es_do: ['es', 'America/Santo_Domingo'], es_pr: ['es', 'America/Puerto_Rico'], es_co: ['es', 'America/Bogota'], es_ve: ['es', 'America/Caracas'],
  es_ec: ['es', 'America/Guayaquil'], es_pe: ['es', 'America/Lima'], es_bo: ['es', 'America/La_Paz'], es_cl: ['es', 'America/Santiago'],
  es_ar: ['es', 'America/Argentina/Buenos_Aires'], es_uy: ['es', 'America/Montevideo'], es_py: ['es', 'America/Asuncion'], es_es: ['es', 'Europe/Madrid'],
  en_us_et: ['en', 'America/New_York'], en_us_ct: ['en', 'America/Chicago'], en_us_mt: ['en', 'America/Denver'], en_us_pt: ['en', 'America/Los_Angeles'],
  en_ca: ['en', 'America/Toronto'], en_gb: ['en', 'Europe/London'], en_ie: ['en', 'Europe/Dublin'], en_au: ['en', 'Australia/Sydney'],
  en_nz: ['en', 'Pacific/Auckland'], en_za: ['en', 'Africa/Johannesburg'], en_in: ['en', 'Asia/Kolkata'], en_ng: ['en', 'Africa/Lagos'], en_ph: ['en', 'Asia/Manila'],
};

// DDI → fuso (para a saudação genérica pelo país do telefone do lead)
const DDI_TZ = [
  ['1809', 'America/Santo_Domingo'], ['1829', 'America/Santo_Domingo'], ['1849', 'America/Santo_Domingo'], ['1787', 'America/Puerto_Rico'], ['1939', 'America/Puerto_Rico'],
  ['351', 'Europe/Lisbon'], ['244', 'Africa/Luanda'], ['258', 'Africa/Maputo'], ['502', 'America/Guatemala'], ['503', 'America/El_Salvador'], ['504', 'America/Tegucigalpa'],
  ['505', 'America/Managua'], ['506', 'America/Costa_Rica'], ['507', 'America/Panama'], ['591', 'America/La_Paz'], ['593', 'America/Guayaquil'], ['595', 'America/Asuncion'],
  ['598', 'America/Montevideo'], ['353', 'Europe/Dublin'], ['234', 'Africa/Lagos'],
  ['55', 'America/Sao_Paulo'], ['52', 'America/Mexico_City'], ['53', 'America/Havana'], ['57', 'America/Bogota'], ['58', 'America/Caracas'], ['51', 'America/Lima'],
  ['56', 'America/Santiago'], ['54', 'America/Argentina/Buenos_Aires'], ['34', 'Europe/Madrid'], ['44', 'Europe/London'], ['61', 'Australia/Sydney'], ['64', 'Pacific/Auckland'],
  ['27', 'Africa/Johannesburg'], ['91', 'Asia/Kolkata'], ['63', 'Asia/Manila'], ['1', 'America/New_York'],
];
export function tzOfPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 10) return null;
  const hit = DDI_TZ.find(([ddi]) => d.startsWith(ddi));
  return hit ? hit[1] : null;
}

function hourIn(date, tz) {
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(date)) % 24; } catch { return date.getUTCHours(); }
}
export function greetingAt(lang, tz, date = new Date()) {
  const h = hourIn(date, tz);
  const w = GREETING_WORDS[lang] || GREETING_WORDS.pt;
  return h >= 5 && h < 12 ? w[0] : h >= 12 && h < 18 ? w[1] : w[2];
}

// valor da variável (ou undefined se o nome não for de saudação)
export function greetingVar(name, ctx) {
  if (!/^saudacao_personalizada(_|$)/.test(name)) return undefined;
  const date = ctx.agora || new Date();
  const rest = name.slice('saudacao_personalizada'.length).replace(/^_/, '');
  const fallbackTz = tzOfPhone(ctx.lead && ctx.lead.telefone) || ctx.tz || 'America/Sao_Paulo';
  if (!rest) return greetingAt('pt', fallbackTz, date);
  if (GREETING_WORDS[rest]) return greetingAt(rest, fallbackTz, date);
  const place = GREETING_PLACES[rest];
  return place ? greetingAt(place[0], place[1], date) : undefined;
}
