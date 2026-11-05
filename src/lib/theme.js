// Tema da Kobly: escuro (padrão), claro ou automático (segue o sistema). Guardado no navegador.
// O index.html aplica o tema antes do app carregar (sem piscar); aqui ficam a leitura, a troca e o aviso para a tela.
const KEY = 'kobly:theme';
const listeners = new Set();

export function getThemePref() { try { return localStorage.getItem(KEY) || 'dark'; } catch { return 'dark'; } }
export function resolvedTheme(pref = getThemePref()) {
  if (pref === 'system') return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return pref === 'light' ? 'light' : 'dark';
}
export function applyTheme(pref = getThemePref()) {
  const t = resolvedTheme(pref);
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', t);
  listeners.forEach((fn) => fn(t, pref));
  return t;
}
export function setThemePref(pref) {
  try { localStorage.setItem(KEY, pref); } catch { /* sem armazenamento: vale só nesta aba */ }
  return applyTheme(pref);
}
export function onThemeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (getThemePref() === 'system') applyTheme('system'); });
}
