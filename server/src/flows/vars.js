// Variáveis do fluxo e avaliação de condições. Puro (sem banco): o motor monta o contexto.
//
// Contexto: { lead, evento, vars, agora, tz, tags:Set, comprou:bool, janelaAberta:bool }
// Nos textos: {{nome}}, {{primeiro_nome}}, {{produto}}, {{valor}}, {{cta_link}}, {{resposta}}…
// e caminhos explícitos: {{lead.email}}, {{evento.tipo}}, {{var.minha_variavel}}.
import { formatBRL } from '../engine/steps.js';

export const DEFAULT_TZ = 'America/Sao_Paulo';

function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz || DEFAULT_TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const hour = p.hour === '24' ? '00' : p.hour;
  return { weekday: wd, hhmm: `${hour}:${p.minute}`, date: `${p.day}/${p.month}/${p.year}` };
}
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

export function buildFields(ctx) {
  const lead = ctx.lead || {}, ev = ctx.evento || {}, vars = ctx.vars || {};
  const nome = [lead.nome, lead.sobrenome].filter(Boolean).join(' ').trim();
  const lp = localParts(ctx.agora || new Date(), ctx.tz);
  const base = {
    nome, primeiro_nome: (lead.nome || '').trim().split(/\s+/)[0] || '',
    email: lead.email || '', telefone: lead.telefone || '', produto: lead.produto || ev.produto || '',
    valor: formatBRL(lead.valor_compra ?? ev.valor), cta_link: ctx.ctaLink || '',
    evento: ev.tipo || '', data_atual: lp.date, hora_atual: lp.hhmm, dia_semana: DIAS[lp.weekday] || '',
  };
  return { ...base, ...vars };
}

function lookup(path, ctx, fields) {
  const p = path.split('.');
  if (p.length === 1) return fields[p[0]];
  const [root, ...rest] = p;
  let cur = root === 'lead' ? ctx.lead : root === 'evento' ? ctx.evento : root === 'var' ? ctx.vars : undefined;
  for (const k of rest) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[k]; }
  return cur;
}

// Troca {{caminho}} pelo valor; o que não existe vira vazio (nunca mostra a chave crua ao lead).
export function render(text, ctx) {
  if (typeof text !== 'string') return '';
  const fields = buildFields(ctx);
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]{0,80})\s*\}\}/g, (_, path) => {
    const v = lookup(path, ctx, fields);
    return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

const num = (v) => { if (typeof v === 'number') return v; const s = String(v ?? '').replace(/[^\d,.-]/g, ''); const n = Number(s.includes(',') && !s.includes('.') ? s.replace(',', '.') : s.replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; };
const norm = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

export function digitsOf(phone) { return String(phone || '').replace(/\D/g, ''); }

export function evalRule(r, ctx) {
  switch (r.kind) {
    case 'tag': { const has = !!(ctx.tags && ctx.tags.has(r.tag_id)); return r.op === 'not_has' ? !has : has; }
    case 'var': {
      const fields = buildFields(ctx);
      const raw = fields[r.name]; const a = norm(raw); const b = norm(render(String(r.value ?? ''), ctx));
      switch (r.op) {
        case 'eq': return a === b;
        case 'neq': return a !== b;
        case 'contains': return b !== '' && a.includes(b);
        case 'not_contains': return b === '' || !a.includes(b);
        case 'empty': return a === '';
        case 'not_empty': return a !== '';
        default: {
          const x = num(raw), y = num(render(String(r.value ?? ''), ctx));
          if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
          return r.op === 'gt' ? x > y : r.op === 'gte' ? x >= y : r.op === 'lt' ? x < y : x <= y;
        }
      }
    }
    case 'purchased': return !!ctx.comprou;
    case 'window_open': return !!ctx.janelaAberta;
    case 'weekday': return r.days.includes(localParts(ctx.agora || new Date(), ctx.tz).weekday);
    case 'time_between': {
      const t = localParts(ctx.agora || new Date(), ctx.tz).hhmm;
      return r.from <= r.to ? t >= r.from && t < r.to : t >= r.from || t < r.to; // atravessa a meia-noite
    }
    case 'country': { const d = digitsOf(ctx.lead && ctx.lead.telefone); return r.ddi.some((x) => d.startsWith(String(x))); }
    default: return false;
  }
}

export function evalCondition(data, ctx) {
  const rules = data.rules || [];
  return data.match === 'any' ? rules.some((r) => evalRule(r, ctx)) : rules.every((r) => evalRule(r, ctx));
}

// Bloco "Definir variável": texto com {{...}} ou conta sobre o valor atual.
export function applySetVar(data, ctx) {
  const cur = (ctx.vars || {})[data.name];
  const val = typeof data.value === 'number' ? data.value : render(String(data.value), ctx);
  const op = data.op || 'set';
  if (op === 'set') return val;
  const a = num(cur ?? 0), b = num(val);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return cur ?? '';
  const r = op === 'add' ? a + b : op === 'subtract' ? a - b : op === 'multiply' ? a * b : b === 0 ? a : a / b;
  return Math.round(r * 100) / 100;
}

// Janela de 24 h da API oficial: aberta se o lead mandou mensagem nas últimas 24 h.
export const isWindowOpen = (lastInbound, now = new Date()) => !!lastInbound && (now.getTime() - new Date(lastInbound).getTime()) < 24 * 3600 * 1000;

// Texto que o lead mandou, seja qual for o tipo de mensagem da Meta.
export function inboundText(m) {
  if (!m) return '';
  if (m.type === 'text') return (m.text && m.text.body) || '';
  if (m.type === 'button') return (m.button && (m.button.text || m.button.payload)) || '';
  if (m.type === 'interactive') { const i = m.interactive || {}; return (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || ''; }
  const media = m[m.type]; if (media && media.caption) return media.caption;
  return `[${m.type}]`;
}
