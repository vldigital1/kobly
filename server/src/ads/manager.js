// Gerenciador de anúncios do Facebook (rota meta-ads): dashboard, contas, campanhas, conjuntos e anúncios
// com as vendas que a Kobly rastreou pela UTM, ligar/pausar e orçamento.
//   dashboard | accounts_overview | entities | set_status | set_budget | get_settings | save_settings
// Rastreio (como nos rastreadores de UTM): utm_campaign = campanha, utm_medium = conjunto, utm_content = anúncio,
// cada um com o nome, o ID ou "nome|id" ({{campaign.name}}|{{campaign.id}}). Venda = "Compra Aprovada" do
// checkout + venda recuperada pelo fluxo. Ligar/pausar e orçamento precisam da permissão ads_management.
import { AuthError } from '../auth.js';

export const MANAGER_ACTIONS = new Set(['dashboard', 'accounts_overview', 'entities', 'set_status', 'set_budget', 'get_settings', 'save_settings']);
const PRESETS = { today: 0, yesterday: 1, last_7d: 7, last_14d: 14, last_30d: 30, this_month: 'month', last_month: 'last_month', maximum: 'max' };
const PURCHASE = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
const LEAD = ['lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped'];
const CONVERSA = ['onsite_conversion.messaging_conversation_started_7d'];
const INSIGHT_FIELDS = 'spend,impressions,reach,clicks,ctr,cpc,cpm,actions,action_values';
// moedas sem centavos na Marketing API (orçamento vai em unidades inteiras)
const NO_CENTS = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);
const LEVELS = {
  campaign: { edge: 'campaigns', utm: 'utm_campaign', fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time' },
  adset: { edge: 'adsets', utm: 'utm_medium', fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,campaign_id,campaign{name},created_time' },
  ad: { edge: 'ads', utm: 'utm_content', fields: 'id,name,status,effective_status,adset_id,adset{name},campaign_id,campaign{name},creative{thumbnail_url},created_time' },
};
const CACHE_MS = 180_000; // 3 min: o Facebook dá pouca cota de consultas a apps em acesso padrão
const OBJ_ID = /^[0-9]{3,25}$/;

const pick = (list, types) => { for (const t of types) { const a = (list || []).find((x) => x.action_type === t); if (a) return Number(a.value) || 0; } return 0; };
export function metaMetrics(i) {
  const r = i || {};
  const spend = Number(r.spend) || 0;
  return {
    spend, impressions: Number(r.impressions) || 0, reach: Number(r.reach) || 0, clicks: Number(r.clicks) || 0,
    ctr: Number(r.ctr) || 0, cpc: Number(r.cpc) || 0, cpm: Number(r.cpm) || 0,
    compras_meta: pick(r.actions, PURCHASE), receita_meta: pick(r.action_values, PURCHASE),
    leads_meta: pick(r.actions, LEAD), conversas: pick(r.actions, CONVERSA),
  };
}
// valor da UTM → chaves que podem casar com o anúncio: o texto todo, e nome/ID quando vem "nome|id"
export function utmKeys(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return [];
  const keys = [s];
  if (s.includes('|')) { const parts = s.split('|').map((x) => x.trim()).filter(Boolean); keys.push(...parts); }
  return [...new Set(keys)];
}
// período do filtro → início e fim (fuso do servidor; a Meta usa o fuso da conta)
export function periodOf(preset, now = new Date()) {
  const p = PRESETS[preset];
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  let end = null;
  if (p === 'max') return { since: new Date(0), until: null, days: null };
  if (p === 'month') start.setDate(1);
  else if (p === 'last_month') { start.setDate(1); end = new Date(start); start.setMonth(start.getMonth() - 1); }
  else if (p === 1) { end = new Date(start); start.setDate(start.getDate() - 1); }
  else if (p > 1) start.setDate(start.getDate() - (p - 1));
  return { since: start, until: end };
}
// lucro e companhia a partir do faturamento, gasto e das taxas da empresa
export function profitOf({ faturamento, gasto, vendas, leads, conversas }, s) {
  const pct = (Number(s.imposto_pct) || 0) + (Number(s.taxa_gateway_pct) || 0) + (Number(s.custo_produto_pct) || 0);
  const despesas = faturamento * pct / 100 + (Number(s.custo_por_venda) || 0) * vendas;
  const lucro = faturamento - gasto - despesas;
  return {
    faturamento, gasto, despesas, lucro, vendas, leads,
    ticket_medio: vendas ? faturamento / vendas : null,
    margem: faturamento ? lucro / faturamento * 100 : null,
    roas: gasto ? faturamento / gasto : null,
    roi: gasto ? lucro / gasto * 100 : null,
    cpa: vendas ? gasto / vendas : null,
    taxa_conversao: leads ? vendas / leads * 100 : null,
    custo_por_conversa: conversas ? gasto / conversas : null,
  };
}

// ---- comum ao Facebook e ao Google: taxas, vendas rastreadas e casamento pela UTM ----

export async function adsSettings(pool, orgId) {
  const r = (await pool.query(`select imposto_pct, taxa_gateway_pct, custo_produto_pct, custo_por_venda from public.ads_settings where organization_id = $1`, [orgId])).rows[0];
  return r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v) || 0])) : { imposto_pct: 0, taxa_gateway_pct: 0, custo_produto_pct: 0, custo_por_venda: 0 };
}

// Vendas e leads rastreados pela Kobly no período, com as UTMs do lead
export async function koblyFacts(pool, orgId, per) {
  const p = [orgId, per.since.toISOString(), per.until ? per.until.toISOString() : null];
  const { rows } = await pool.query(`
    with ev as (
      select e.lead_id, count(*)::int as aprovadas, coalesce(sum(e.valor_produto), 0)::float as receita, min(e.created_at) as quando
        from public.webhook_events e where e.organization_id = $1 and e.tipo_evento = 'Compra Aprovada' and e.lead_id is not null
         and e.created_at >= $2 and ($3::timestamptz is null or e.created_at < $3) group by e.lead_id),
    fs as (
      select s.lead_id, count(*)::int as recuperadas, coalesce(sum(s.amount), 0)::float as receita, min(s.created_at) as quando
        from public.flow_sales s where s.organization_id = $1 and s.lead_id is not null
         and s.created_at >= $2 and ($3::timestamptz is null or s.created_at < $3) group by s.lead_id)
    select l.id, l.utm->>'utm_source' as utm_source, l.utm->>'utm_campaign' as utm_campaign, l.utm->>'utm_medium' as utm_medium, l.utm->>'utm_content' as utm_content,
           (l.created_at >= $2 and ($3::timestamptz is null or l.created_at < $3)) as lead_novo,
           coalesce(ev.aprovadas, 0) as aprovadas, coalesce(ev.receita, 0) as receita_checkout,
           coalesce(fs.recuperadas, 0) as recuperadas, coalesce(fs.receita, 0) as receita_recuperada,
           least(ev.quando, fs.quando) as venda_em
      from public.leads l left join ev on ev.lead_id = l.id left join fs on fs.lead_id = l.id
     where l.organization_id = $1 and l.utm is not null and (l.utm ? 'utm_campaign' or l.utm ? 'utm_medium' or l.utm ? 'utm_content')
       and (ev.lead_id is not null or fs.lead_id is not null or (l.created_at >= $2 and ($3::timestamptz is null or l.created_at < $3)))`, p);
  return rows;
}

// utm_source que claramente é da outra rede não casa (lead do Google não entra numa campanha do Facebook de mesmo nome)
const FROM_META = /^(fb|facebook|ig|instagram|meta|an|msg)\b/i;
const FROM_GOOGLE = /^(google|gads|adwords|youtube|yt)\b/i;
export const sourceOk = (src, platform) => { const s = String(src || '').trim(); return !s || (platform === 'google' ? !FROM_META.test(s) : !FROM_GOOGLE.test(s)); };

// soma por anúncio/conjunto/campanha: casa a UTM do lead com o nome ou o ID
export function attribute(items, facts, utmField, platform = 'meta') {
  const byKey = new Map();
  for (const it of items) for (const k of [String(it.id), String(it.name || '').trim().toLowerCase()]) if (k) byKey.set(k, it);
  const out = new Map(items.map((it) => [it.id, { leads: 0, vendas: 0, faturamento: 0, recuperadas: 0, receita_recuperada: 0 }]));
  for (const f of facts) {
    if (!sourceOk(f.utm_source, platform)) continue;
    const it = utmKeys(f[utmField]).map((k) => byKey.get(k)).find(Boolean);
    if (!it) continue;
    const o = out.get(it.id);
    if (f.lead_novo) o.leads += 1;
    o.vendas += f.aprovadas + f.recuperadas;
    o.faturamento += f.receita_checkout + f.receita_recuperada;
    o.recuperadas += f.recuperadas; o.receita_recuperada += f.receita_recuperada;
  }
  return out;
}

export function createAdsManager({ pool, graph, own, tokenOf, now = () => new Date() }) {
  const cache = new Map();
  const fail = (msg) => { throw new AuthError(422, 'validation_failed', msg); };
  const presetOf = (b) => (Object.prototype.hasOwnProperty.call(PRESETS, b.date_preset) ? b.date_preset : 'today');
  // guarda as respostas; se o Facebook limitar, devolve os últimos números em vez de erro
  async function cached(key, force, fn) {
    const hit = cache.get(key);
    if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.v;
    try {
      const v = await fn();
      cache.set(key, { at: Date.now(), v });
      return v;
    } catch (e) {
      if (e && e.code === 'meta_rate_limited' && hit) return hit.v;
      throw e;
    }
  }
  // depois de pausar/mudar orçamento, corrige o item nos números guardados (sem gastar consultas do Facebook)
  const patchCache = (accId, objId, patch) => {
    for (const [k, hit] of cache) if (k.startsWith(`${accId}:`) && Array.isArray(hit.v)) hit.v = hit.v.map((x) => (x.id === objId ? { ...x, ...patch } : x));
  };

  const settings = (orgId) => adsSettings(pool, orgId);
  const koblyFactsOf = (orgId, per) => koblyFacts(pool, orgId, per);
  async function accountsOf(orgId, id) {
    if (id && id !== 'all') return [await own(orgId, id)];
    const { rows } = await pool.query(`select * from public.meta_ads_accounts where organization_id = $1 order by created_at`, [orgId]);
    return rows;
  }

  // lista de campanhas / conjuntos / anúncios de uma conta, com as métricas do período
  async function listLevel(a, level, preset, force) {
    const L = LEVELS[level];
    return cached(`${a.id}:${level}:${preset}`, force, async () => {
      const token = tokenOf(a);
      const items = [];
      let after = null;
      for (let page = 0; page < 5; page++) {
        const q = { fields: `${L.fields},insights.date_preset(${preset}){${INSIGHT_FIELDS}}`, limit: '200',
          filtering: JSON.stringify([{ field: 'effective_status', operator: 'NOT_IN', value: ['DELETED', 'ARCHIVED'] }]) };
        if (after) q.after = after;
        const j = await graph(token, `/act_${a.ad_account_id}/${L.edge}`, q);
        for (const r of j.data || []) {
          items.push({
            id: r.id, name: r.name || '', status: r.status, effective_status: r.effective_status, objective: r.objective || null,
            daily_budget: r.daily_budget != null ? Number(r.daily_budget) : null, lifetime_budget: r.lifetime_budget != null ? Number(r.lifetime_budget) : null,
            campaign_id: r.campaign_id || null, campaign_name: (r.campaign && r.campaign.name) || null, adset_id: r.adset_id || null, adset_name: (r.adset && r.adset.name) || null,
            thumbnail: (r.creative && r.creative.thumbnail_url) || null, created_time: r.created_time || null,
            account_id: a.id, account_name: a.name, currency: a.currency,
            ...metaMetrics(r.insights && r.insights.data && r.insights.data[0]),
          });
        }
        after = j.paging && j.paging.next && j.paging.cursors ? j.paging.cursors.after : null;
        if (!after) break;
      }
      return items;
    });
  }
  const budgetUnit = (cur) => (NO_CENTS.has(String(cur || '').toUpperCase()) ? 1 : 100);

  async function handle(ctx, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar campanhas.'); };
    switch (body.action) {
      case 'get_settings': return { settings: await settings(orgId) };
      case 'save_settings': {
        editor();
        const n = (k, max) => { const v = Number(body[k]); if (!Number.isFinite(v) || v < 0 || v > max) fail('Valores de taxas inválidos.'); return v; };
        const s = { imposto_pct: n('imposto_pct', 100), taxa_gateway_pct: n('taxa_gateway_pct', 100), custo_produto_pct: n('custo_produto_pct', 100), custo_por_venda: n('custo_por_venda', 1e7) };
        await pool.query(`insert into public.ads_settings (organization_id, imposto_pct, taxa_gateway_pct, custo_produto_pct, custo_por_venda) values ($1,$2,$3,$4,$5)
          on conflict (organization_id) do update set imposto_pct = excluded.imposto_pct, taxa_gateway_pct = excluded.taxa_gateway_pct, custo_produto_pct = excluded.custo_produto_pct, custo_por_venda = excluded.custo_por_venda`,
          [orgId, s.imposto_pct, s.taxa_gateway_pct, s.custo_produto_pct, s.custo_por_venda]);
        return { settings: s };
      }
      case 'entities': {
        const level = LEVELS[body.level] ? body.level : 'campaign';
        const preset = presetOf(body);
        const accs = await accountsOf(orgId, body.id);
        const lists = await Promise.all(accs.map((a) => listLevel(a, level, preset, !!body.force)));
        const items = lists.flat();
        const facts = await koblyFactsOf(orgId, periodOf(preset, now()));
        const att = attribute(items, facts, LEVELS[level].utm);
        const s = await settings(orgId);
        return {
          date_preset: preset, fetched_at: now().toISOString(), level,
          items: items.map((it) => {
            const k = att.get(it.id);
            const sys = profitOf({ faturamento: k.faturamento, gasto: it.spend, vendas: k.vendas, leads: k.leads, conversas: it.conversas }, s);
            return { ...it, kobly: k, ...sys, budget_unit: budgetUnit(it.currency) };
          }),
        };
      }
      case 'accounts_overview': {
        const preset = presetOf(body);
        const accs = await accountsOf(orgId, 'all');
        const facts = await koblyFactsOf(orgId, periodOf(preset, now()));
        const s = await settings(orgId);
        const out = [];
        for (const a of accs) {
          try {
            const info = await cached(`${a.id}:info:${preset}`, !!body.force, () => graph(tokenOf(a), `/act_${a.ad_account_id}`, {
              fields: `name,account_status,currency,amount_spent,spend_cap,balance,disable_reason,insights.date_preset(${preset}){${INSIGHT_FIELDS}}` }));
            const camps = await listLevel(a, 'campaign', preset, !!body.force);
            const att = attribute(camps, facts, 'utm_campaign');
            const tot = [...att.values()].reduce((t, k) => ({ vendas: t.vendas + k.vendas, faturamento: t.faturamento + k.faturamento, leads: t.leads + k.leads }), { vendas: 0, faturamento: 0, leads: 0 });
            const m = metaMetrics(info.insights && info.insights.data && info.insights.data[0]);
            out.push({ id: a.id, ad_account_id: a.ad_account_id, name: info.name || a.name, currency: info.currency || a.currency,
              account_status: info.account_status, ativa: info.account_status === 1, disable_reason: info.disable_reason || 0,
              spend_cap: info.spend_cap != null ? Number(info.spend_cap) : null, amount_spent: info.amount_spent != null ? Number(info.amount_spent) : null,
              campanhas_ativas: camps.filter((c) => c.effective_status === 'ACTIVE').length,
              ...m, ...profitOf({ faturamento: tot.faturamento, gasto: m.spend, vendas: tot.vendas, leads: tot.leads, conversas: m.conversas }, s), erro: null });
          } catch (e) { out.push({ id: a.id, ad_account_id: a.ad_account_id, name: a.name, currency: a.currency, erro: e.message }); }
        }
        return { date_preset: preset, fetched_at: now().toISOString(), accounts: out };
      }
      case 'dashboard': {
        const preset = presetOf(body);
        const accs = await accountsOf(orgId, body.id || 'all');
        const per = periodOf(preset, now());
        const facts = await koblyFactsOf(orgId, per);
        const s = await settings(orgId);
        let meta = metaMetrics(null);
        const porDia = new Map();
        const camps = [];
        for (const a of accs) {
          const j = await cached(`${a.id}:daily:${preset}`, !!body.force, () => graph(tokenOf(a), `/act_${a.ad_account_id}/insights`, { level: 'account', date_preset: preset, time_increment: '1', fields: INSIGHT_FIELDS, limit: '400' }));
          for (const d of j.data || []) {
            const m = metaMetrics(d);
            for (const k of Object.keys(meta)) meta[k] += m[k];
            const dia = d.date_start;
            const x = porDia.get(dia) || { dia, gasto: 0, vendas_meta: 0, faturamento_meta: 0, vendas: 0, faturamento: 0 };
            x.gasto += m.spend; x.vendas_meta += m.compras_meta; x.faturamento_meta += m.receita_meta;
            porDia.set(dia, x);
          }
          camps.push(...await listLevel(a, 'campaign', preset, !!body.force));
        }
        // Kobly: só as vendas e leads que vieram das campanhas destas contas
        const att = attribute(camps, facts, 'utm_campaign');
        const byKey = new Set(camps.flatMap((c) => [String(c.id), c.name.trim().toLowerCase()]));
        let vendas = 0, faturamento = 0, leads = 0, recuperadas = 0, receitaRec = 0;
        for (const k of att.values()) { vendas += k.vendas; faturamento += k.faturamento; leads += k.leads; recuperadas += k.recuperadas; receitaRec += k.receita_recuperada; }
        for (const f of facts) {
          if (!f.venda_em || !sourceOk(f.utm_source, 'meta') || !utmKeys(f.utm_campaign).some((k) => byKey.has(k))) continue;
          const d = new Date(f.venda_em); const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const x = porDia.get(dia) || { dia, gasto: 0, vendas_meta: 0, faturamento_meta: 0, vendas: 0, faturamento: 0 };
          x.vendas += f.aprovadas + f.recuperadas; x.faturamento += f.receita_checkout + f.receita_recuperada;
          porDia.set(dia, x);
        }
        meta.ctr = meta.impressions ? meta.clicks / meta.impressions * 100 : 0;
        meta.cpc = meta.clicks ? meta.spend / meta.clicks : 0;
        meta.cpm = meta.impressions ? meta.spend / meta.impressions * 1000 : 0;
        return {
          date_preset: preset, fetched_at: now().toISOString(), currency: (accs[0] && accs[0].currency) || 'BRL', contas: accs.length, settings: s, meta,
          sistema: { ...profitOf({ faturamento, gasto: meta.spend, vendas, leads, conversas: meta.conversas }, s), recuperadas, receita_recuperada: receitaRec },
          meta_ads: profitOf({ faturamento: meta.receita_meta, gasto: meta.spend, vendas: meta.compras_meta, leads: meta.leads_meta || leads, conversas: meta.conversas }, s),
          serie: [...porDia.values()].sort((x, y) => (x.dia < y.dia ? -1 : 1)),
        };
      }
      case 'set_status':
      case 'set_budget': {
        editor();
        const a = await own(orgId, body.id);
        const obj = String(body.object_id || '');
        if (!OBJ_ID.test(obj)) fail('Item inválido.');
        const token = tokenOf(a);
        const info = await graph(token, `/${obj}`, { fields: 'account_id,daily_budget,lifetime_budget,name' });
        if (String(info.account_id) !== String(a.ad_account_id)) throw new AuthError(404, 'not_found', 'Este item não é desta conta de anúncios.');
        const post = async (form) => {
          try { await graph(token, `/${obj}`, form, 'POST'); }
          catch (e) {
            if (e.code === 'meta_permission') throw new AuthError(400, 'meta_write_permission', 'O Facebook não deixou alterar. A Kobly precisa da permissão ads_management: reconecte a conta pelo botão "Conectar com Facebook" e aceite todas as permissões.');
            throw e;
          }
        };
        if (body.action === 'set_status') {
          if (!['ACTIVE', 'PAUSED'].includes(body.status)) fail('Situação inválida.');
          await post({ status: body.status });
          patchCache(a.id, obj, { status: body.status, effective_status: body.status });
          return { ok: true, effective_status: body.status };
        }
        const kind = info.daily_budget != null && Number(info.daily_budget) > 0 ? 'daily_budget' : info.lifetime_budget != null && Number(info.lifetime_budget) > 0 ? 'lifetime_budget' : null;
        if (!kind) fail('O orçamento deste item fica no nível de cima (campanha ou conjunto). Edite lá.');
        const v = Number(String(body.value).replace(',', '.'));
        if (!Number.isFinite(v) || v <= 0 || v > 10_000_000) fail('Digite um orçamento válido.');
        const minor = Math.round(v * budgetUnit(a.currency));
        await post({ [kind]: String(minor) });
        patchCache(a.id, obj, { [kind]: minor });
        return { ok: true, [kind]: minor };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { handle };
}
