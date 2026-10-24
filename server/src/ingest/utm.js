// Parâmetros de rastreio (UTM, src, sck) de um postback de checkout.
// Cada plataforma manda num lugar: no topo (Eduzz/genérico), em TrackingParameters (Kiwify), em
// purchase.origin (Hotmart: src/sck/xcod), em "utm"/"tracking", ou só na URL do checkout. Procura nos
// objetos (até 5 níveis) e, se faltar, nas URLs conhecidas. Devolve null quando não há nada.
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'src', 'sck'];
const ALIAS = { xcod: 'sck', source: 'utm_source', medium: 'utm_medium', campaign: 'utm_campaign', content: 'utm_content', term: 'utm_term' };
const ALIAS_PARENTS = /^(utm|utms|tracking|trackingparameters|tracking_parameters|origin|origem)$/i;
const URL_KEYS = /^(checkout_url|url|link|page_url|landing_page|referrer|src_url)$/i;
const clean = (v) => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim().slice(0, 200) : null;

function fromUrl(out, raw) {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw)) return;
  let u; try { u = new URL(raw); } catch { return; }
  for (const k of UTM_KEYS) if (!out[k]) { const v = clean(u.searchParams.get(k)); if (v) out[k] = v; }
}

export function extractUtm(body) {
  const out = {};
  const urls = [];
  const walk = (o, depth, parentKey) => {
    if (!o || typeof o !== 'object' || depth > 5) return;
    for (const [k, v] of Object.entries(o)) {
      const key = k.toLowerCase();
      if (v && typeof v === 'object') { walk(v, depth + 1, key); continue; }
      if (URL_KEYS.test(key)) urls.push(v);
      // utm_source etc. valem em qualquer lugar; "source"/"xcod" só dentro de um objeto de rastreio
      const target = UTM_KEYS.includes(key) ? key : (ALIAS_PARENTS.test(parentKey || '') ? ALIAS[key] : null);
      if (target && !out[target]) { const c = clean(v); if (c) out[target] = c; }
    }
  };
  walk(body, 0, null);
  for (const u of urls) fromUrl(out, u);
  return Object.keys(out).length ? out : null;
}
