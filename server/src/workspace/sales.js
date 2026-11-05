// Dashboard de vendas (rota dashboard, ação "sales"): tudo que foi vendido no período — compras aprovadas no
// checkout + vendas feitas pelos fluxos (bloco Cobrança) — com faturamento, ticket médio, taxas, reembolsos,
// e as quebras por dia, por hora, por estado/país (DDD/DDI do comprador), por número de WhatsApp, por produto,
// por origem e por forma de pagamento. Dias e horas no fuso da empresa. O gasto com anúncios vem do Facebook/
// Google na própria tela (já tem cache lá); aqui só as taxas e despesas cadastradas em Anúncios.
import { adsSettings } from '../ads/manager.js';

export const SALES_PRESETS = ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month', 'maximum'];

// ---- datas no fuso da empresa (strings AAAA-MM-DD, contas em UTC para não sofrer horário de verão) ----
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const monthStart = (s, back = 0) => { const d = new Date(`${s.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - back); return ymd(d); };
export function localToday(tz, now = new Date()) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
  catch { return ymd(now); }
}
// período atual e o anterior de mesmo tamanho (para a variação %)
export function salesPeriod(preset, today) {
  const n = { last_7d: 7, last_14d: 14, last_30d: 30 }[preset];
  if (preset === 'today') return { since: today, until: null, prev: { since: addDays(today, -1), until: today } };
  if (preset === 'yesterday') return { since: addDays(today, -1), until: today, prev: { since: addDays(today, -2), until: addDays(today, -1) } };
  if (n) { const since = addDays(today, -(n - 1)); return { since, until: null, prev: { since: addDays(since, -n), until: since } }; }
  if (preset === 'this_month') return { since: monthStart(today), until: null, prev: { since: monthStart(today, 1), until: monthStart(today) } };
  if (preset === 'last_month') return { since: monthStart(today, 1), until: monthStart(today), prev: { since: monthStart(today, 2), until: monthStart(today, 1) } };
  return { since: '2000-01-01', until: null, prev: null };
}

// ---- de onde é o comprador, pelo telefone ----
const UF_BY_DDD = {
  AC: [68], AL: [82], AP: [96], AM: [92, 97], BA: [71, 73, 74, 75, 77], CE: [85, 88], DF: [61], ES: [27, 28],
  GO: [62, 64], MA: [98, 99], MT: [65, 66], MS: [67], MG: [31, 32, 33, 34, 35, 37, 38], PA: [91, 93, 94], PB: [83],
  PR: [41, 42, 43, 44, 45, 46], PE: [81, 87], PI: [86, 89], RJ: [21, 22, 24], RN: [84], RS: [51, 53, 54, 55],
  RO: [69], RR: [95], SC: [47, 48, 49], SP: [11, 12, 13, 14, 15, 16, 17, 18, 19], SE: [79], TO: [63],
};
const DDD = Object.fromEntries(Object.entries(UF_BY_DDD).flatMap(([uf, l]) => l.map((d) => [String(d), uf])));
export const UF_NAME = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo',
  GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná',
  PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima',
  SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};
const DDI = {
  55: 'Brasil', 52: 'México', 57: 'Colômbia', 54: 'Argentina', 56: 'Chile', 51: 'Peru', 1: 'EUA / Canadá', 351: 'Portugal', 34: 'Espanha',
  593: 'Equador', 595: 'Paraguai', 598: 'Uruguai', 591: 'Bolívia', 58: 'Venezuela', 502: 'Guatemala', 503: 'El Salvador', 504: 'Honduras',
  505: 'Nicarágua', 506: 'Costa Rica', 507: 'Panamá', 53: 'Cuba', 44: 'Reino Unido', 49: 'Alemanha', 33: 'França', 39: 'Itália',
  41: 'Suíça', 31: 'Holanda', 32: 'Bélgica', 353: 'Irlanda', 61: 'Austrália', 81: 'Japão', 244: 'Angola', 258: 'Moçambique', 27: 'África do Sul', 91: 'Índia',
};
export function whereFrom(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (!d) return { pais: null, uf: null };
  if (d.length === 10 || d.length === 11) d = `55${d}`; // número brasileiro sem DDI
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return { pais: 'Brasil', uf: DDD[d.slice(2, 4)] || null };
  for (const len of [3, 2, 1]) { const p = DDI[d.slice(0, len)]; if (p) return { pais: p, uf: null }; }
  return { pais: 'Outros', uf: null };
}

// ---- de onde veio a venda ----
export function originOf(src, ctwa, fonte) {
  const s = String(src || '').trim().toLowerCase();
  if (/^(fb|facebook|ig|instagram|meta|an|msg)\b/.test(s)) return 'Facebook / Instagram';
  if (/^(google|gads|adwords|youtube|yt)\b/.test(s)) return 'Google';
  if (/^(tiktok|tt)\b/.test(s)) return 'TikTok';
  if (/^(kwai)\b/.test(s)) return 'Kwai';
  if (/^(email|e-mail|newsletter)\b/.test(s)) return 'E-mail';
  if (s) return s.length > 30 ? `${s.slice(0, 30)}…` : s;
  if (ctwa) return 'Anúncio Click-to-WhatsApp';
  return fonte === 'fluxo' ? 'WhatsApp (sem UTM)' : 'Orgânico / direto';
}
export function methodOf(m) {
  const s = String(m || '').toLowerCase();
  if (/pix/.test(s)) return 'Pix';
  if (/card|cart|credit|cr[eé]dito|d[eé]bito/.test(s)) return 'Cartão';
  if (/boleto|billet|ticket/.test(s)) return 'Boleto';
  if (/oxxo/.test(s)) return 'OXXO';
  if (/spei|transfer|nequi|bre-?b|pse/.test(s)) return 'Transferência';
  return s ? 'Outros' : 'Não informado';
}

const top = (map, limit = 12) => [...map.entries()].map(([nome, x]) => ({ nome, ...x })).sort((a, b) => b.valor - a.valor || b.vendas - a.vendas).slice(0, limit);
const bump = (map, k, valor) => { const x = map.get(k) || { vendas: 0, valor: 0 }; x.vendas += 1; x.valor += valor; map.set(k, x); };

export async function salesReport(pool, orgId, body = {}, now = new Date()) {
  const preset = SALES_PRESETS.includes(body.date_preset) ? body.date_preset : 'last_30d';
  const tz = (await pool.query(`select timezone from public.organizations where id = $1`, [orgId])).rows[0]?.timezone || 'America/Sao_Paulo';
  const today = localToday(tz, now);
  const per = salesPeriod(preset, today);
  // vendas: checkout aprovado + vendas dos fluxos
  const UNION = `
    select e.lead_id, coalesce(e.valor_produto, 0)::float as valor, nullif(trim(e.produto), '') as produto, e.metodo_pagamento as metodo,
           e.telefone as tel, e.created_at as at, 'checkout' as fonte
      from public.webhook_events e
     where e.organization_id = $1 and e.tipo_evento = 'Compra Aprovada'
       and e.created_at >= ($2::timestamp at time zone $4) and ($3::timestamp is null or e.created_at < ($3::timestamp at time zone $4))
    union all
    select f.lead_id, f.amount::float, nullif(trim(f.product), ''), c.method, null, f.created_at, 'fluxo'
      from public.flow_sales f left join public.payment_charges c on c.id = f.charge_id
     where f.organization_id = $1
       and f.created_at >= ($2::timestamp at time zone $4) and ($3::timestamp is null or f.created_at < ($3::timestamp at time zone $4))`;
  const args = (p) => [orgId, p.since, p.until, tz];

  const [rows, prev, extra, settings] = await Promise.all([
    pool.query(`with s as (${UNION})
      select s.valor, s.produto, s.metodo, s.fonte, s.lead_id, coalesce(nullif(s.tel, ''), l.telefone) as tel,
             to_char(s.at at time zone $4, 'YYYY-MM-DD') as dia, extract(hour from s.at at time zone $4)::int as hora,
             extract(isodow from s.at at time zone $4)::int as dow,
             l.utm->>'utm_source' as utm_source, (l.ad_origin is not null) as ctwa, w.inst_id, w.inst_nome
        from s left join public.leads l on l.id = s.lead_id
        left join lateral (
          select coalesce(m.instance_id, m.account_id) as inst_id,
                 coalesce(u.label || coalesce(' · ' || u.phone, ''), a.verified_name || coalesce(' · ' || a.display_phone, ''), a.display_phone, 'WhatsApp oficial') as inst_nome
            from public.whatsapp_inbound_messages m
            left join public.whatsapp_uazapi_instances u on u.id = m.instance_id
            left join public.whatsapp_accounts a on a.id = m.account_id
           where s.lead_id is not null and m.lead_id = s.lead_id and (m.instance_id is not null or m.account_id is not null)
             and m.received_at <= s.at + interval '1 day'
           order by m.received_at desc limit 1) w on true
       limit 50000`, args(per)).then((r) => r.rows),
    per.prev ? pool.query(`with s as (${UNION}) select count(*)::int as vendas, coalesce(sum(valor), 0)::float as faturamento from s`, args(per.prev)).then((r) => r.rows[0]) : null,
    pool.query(`select
        (select count(*) from public.leads where organization_id = $1 and created_at >= ($2::timestamp at time zone $4) and ($3::timestamp is null or created_at < ($3::timestamp at time zone $4)))::int as leads,
        count(*) filter (where tipo_evento in ('Compra Reembolsada', 'Chargeback'))::int as reemb_n,
        coalesce(sum(valor_produto) filter (where tipo_evento in ('Compra Reembolsada', 'Chargeback')), 0)::float as reemb_valor,
        count(*) filter (where tipo_evento in ('Pix Gerado', 'Boleto Gerado'))::int as pend_n,
        coalesce(sum(valor_produto) filter (where tipo_evento in ('Pix Gerado', 'Boleto Gerado')), 0)::float as pend_valor,
        count(*) filter (where tipo_evento = 'Abandono de carrinho')::int as abandonos
      from public.webhook_events where organization_id = $1
       and created_at >= ($2::timestamp at time zone $4) and ($3::timestamp is null or created_at < ($3::timestamp at time zone $4))`, args(per)).then((r) => r.rows[0]),
    adsSettings(pool, orgId),
  ]);

  // ---- somas ----
  let faturamento = 0, recuperadas = 0, receitaRec = 0;
  const compradores = new Set();
  const porDia = new Map(), porHora = Array.from({ length: 24 }, () => ({ vendas: 0, valor: 0 }));
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const estados = new Map(), paises = new Map(), instancias = new Map(), produtos = new Map(), origens = new Map(), metodos = new Map();
  for (const r of rows) {
    const v = Number(r.valor) || 0;
    faturamento += v;
    if (r.fonte === 'fluxo') { recuperadas += 1; receitaRec += v; }
    if (r.lead_id) compradores.add(r.lead_id); else if (r.tel) compradores.add(r.tel);
    const d = porDia.get(r.dia) || { vendas: 0, faturamento: 0 }; d.vendas += 1; d.faturamento += v; porDia.set(r.dia, d);
    porHora[r.hora].vendas += 1; porHora[r.hora].valor += v;
    heat[(r.dow + 6) % 7][r.hora] += 1; // 0 = segunda
    const w = whereFrom(r.tel);
    if (w.pais) bump(paises, w.pais, v);
    if (w.uf) bump(estados, w.uf, v);
    bump(instancias, r.inst_nome || 'Sem conversa no WhatsApp', v);
    bump(produtos, r.produto || 'Sem produto', v);
    bump(origens, originOf(r.utm_source, r.ctwa, r.fonte), v);
    bump(metodos, methodOf(r.metodo), v);
  }
  const vendas = rows.length;

  // série com todos os dias do período (até hoje), mesmo os sem venda
  const fim = per.until ? addDays(per.until, -1) : today;
  let ini = per.since;
  if (preset === 'maximum') ini = [...porDia.keys()].sort()[0] || today;
  if ((new Date(fim) - new Date(ini)) / 864e5 > 400) ini = addDays(fim, -400);
  const serie = [];
  for (let dia = ini; dia <= fim; dia = addDays(dia, 1)) serie.push({ dia, ...(porDia.get(dia) || { vendas: 0, faturamento: 0 }) });

  // taxas e despesas cadastradas (Anúncios → Taxas e despesas); o gasto com anúncios entra na tela
  const pct = settings.imposto_pct + settings.taxa_gateway_pct + settings.custo_produto_pct;
  const despesas = faturamento * pct / 100 + settings.custo_por_venda * vendas;

  return {
    date_preset: preset, timezone: tz, since: per.since, until: per.until, currency: 'BRL',
    totais: {
      faturamento, vendas, ticket_medio: vendas ? faturamento / vendas : 0, compradores: compradores.size,
      leads: extra.leads, taxa_conversao: extra.leads ? (vendas / extra.leads) * 100 : null,
      despesas, recuperadas, receita_recuperada: receitaRec,
      reembolsos: { n: extra.reemb_n, valor: extra.reemb_valor },
      pendentes: { n: extra.pend_n, valor: extra.pend_valor }, abandonos: extra.abandonos,
    },
    anterior: prev, settings, serie,
    por_hora: porHora, heatmap: heat,
    estados: top(estados, 27).map((x) => ({ ...x, uf: x.nome, nome: UF_NAME[x.nome] || x.nome })),
    paises: top(paises), instancias: top(instancias), produtos: top(produtos, 15), origens: top(origens), metodos: top(metodos),
  };
}
