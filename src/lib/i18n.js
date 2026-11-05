// Tradução da tela (PT → ES/EN) sem mexer em cada componente.
// O app é escrito em português; aqui um observador troca os textos que
// aparecem na tela pelo dicionário do idioma escolhido. Campos de digitação,
// áreas editáveis e tudo que estiver dentro de [data-no-i18n] ficam como estão
// (mensagens de clientes, nomes, conteúdo do usuário).

const KEY = 'kobly:lang';
export const LANGS = [
  { id: 'pt', label: 'Português', html: 'pt-BR' },
  { id: 'es', label: 'Español', html: 'es' },
  { id: 'en', label: 'English', html: 'en' },
];

export function getLang() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'es' || v === 'en' || v === 'pt') return v;
  } catch { /* sem storage */ }
  return 'pt';
}

export function setLang(lang) {
  try { localStorage.setItem(KEY, lang); } catch { /* sem storage */ }
  // Recarrega para todo texto (inclusive o que já está na tela) sair no idioma novo.
  window.location.reload();
}

let dict = null;
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE', 'svg', 'SVG']);
const mine = new WeakMap(); // nó → último valor que nós escrevemos

// Moldes com partes variáveis: "{0} venda(s) no checkout" → regex. Cada molde
// é guardado pelo maior pedaço fixo, para só testar a regex quando o texto o contém.
let templates = [];
function buildTemplates() {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  templates = [];
  for (const [k, v] of Object.entries(dict)) {
    if (!/\{\d\}/.test(k)) continue;
    const pieces = k.split(/\{\d\}/);
    const anchor = pieces.reduce((a, b) => (b.trim().length > a.length ? b.trim() : a), '');
    if (anchor.length < 3) continue;
    const order = [...k.matchAll(/\{(\d)\}/g)].map((m) => Number(m[1]));
    const re = new RegExp('^' + pieces.map(esc).join('(.+?)') + '$');
    templates.push({ anchor, re, order, out: v });
  }
}
function fromTemplate(t) {
  for (const tp of templates) {
    if (!t.includes(tp.anchor)) continue;
    const m = t.match(tp.re);
    if (!m) continue;
    const vals = {};
    tp.order.forEach((n, i) => { const g = m[i + 1]; vals[n] = dict[g.trim()] ?? g; });
    return tp.out.replace(/\{(\d)\}/g, (_, n) => (vals[n] ?? ''));
  }
  return null;
}

function lookup(raw) {
  if (!raw) return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (t.length < 2) return null;
  const hit = dict[t] ?? fromTemplate(t);
  if (hit == null) return null;
  const lead = raw.match(/^\s*/)[0];
  const tail = raw.match(/\s*$/)[0];
  return lead + hit + tail;
}

function skipped(el) {
  if (!el || el.nodeType !== 1) return false;
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.isContentEditable) return true;
  return !!el.closest('[data-no-i18n],[translate="no"]');
}

function doText(node) {
  if (mine.get(node) === node.nodeValue) return;
  const parent = node.parentElement;
  if (!parent || skipped(parent)) return;
  const out = lookup(node.nodeValue);
  if (out != null && out !== node.nodeValue) {
    node.nodeValue = out;
    mine.set(node, out);
  }
}

function doAttrs(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    const k = 'a:' + a;
    if (el[k] === v) continue;
    const out = lookup(v);
    if (out != null && out !== v) {
      el.setAttribute(a, out);
      el[k] = out;
    }
  }
}

function walk(root) {
  if (root.nodeType === 3) { doText(root); return; }
  if (root.nodeType !== 1 || skipped(root)) return;
  doAttrs(root);
  const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === 1 && skipped(n)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n = it.nextNode();
  while (n) {
    if (n.nodeType === 3) doText(n); else doAttrs(n);
    n = it.nextNode();
  }
}

/** Traduz uma frase solta (para alert/confirm nativos ou textos montados em JS). */
export function tr(text) {
  if (!dict || typeof text !== 'string') return text;
  return lookup(text) ?? text;
}

/** Carrega o dicionário e liga o observador. Resolve antes do primeiro render. */
export async function initI18n() {
  const lang = getLang();
  const meta = LANGS.find((l) => l.id === lang) || LANGS[0];
  document.documentElement.setAttribute('lang', meta.html);
  if (lang === 'pt') return;
  try {
    const mod = lang === 'es' ? await import('../i18n/es.json') : await import('../i18n/en.json');
    dict = mod.default || mod;
    buildTemplates();
  } catch {
    return; // sem dicionário: segue em português
  }
  const titleEl = document.querySelector('title');
  if (titleEl) walk(titleEl);
  walk(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') { if (!skipped(m.target)) doAttrs(m.target); }
      else for (const n of m.addedNodes) walk(n);
    }
  }).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ATTRS,
  });
}
