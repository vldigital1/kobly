import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Banner, Button, Card, Icon, IconButton, Input, PageHeader, Select } from '@/ds';
import { EmptyState, ErrorState, Modal, SkeletonTable } from '@/lib/ui.jsx';
import { useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';
import { GoogleAdsLogo, MetaLogo } from '@/lib/brandLogos.jsx';

// Kobly — gerenciador do Facebook Ads: dashboard (faturamento, gasto, lucro, ROAS...), contas, campanhas,
// conjuntos e anúncios com as vendas rastreadas pela UTM; liga/pausa e muda orçamento direto no Facebook.
// Atualiza sozinho a cada minuto. KoblyMetaAds

const money = (v, cur) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: cur || 'BRL' }));
const int = (v) => Number(v || 0).toLocaleString('pt-BR');
const roas = (v) => (v == null ? '—' : `${v.toFixed(2)}x`);

const STEPS = [
  ['Clique em "Conectar com Facebook"', 'Abre uma janelinha do próprio Facebook. Entre com o perfil que administra os seus anúncios.'],
  ['Autorize a Kobly', 'O Facebook pergunta se a Kobly pode ver as campanhas e alterá-las. A Kobly só liga, pausa ou muda orçamento quando você clica.'],
  ['Escolha as contas de anúncios', 'Marque as contas que você quer acompanhar aqui. Pronto: as campanhas aparecem ao vivo.'],
  ['Marque as campanhas (opcional, mas recomendado)', 'No anúncio, em Parâmetros de URL, cole os parâmetros que aparecem no fim desta página. Assim a Kobly sabe de qual campanha, conjunto e anúncio veio cada venda.'],
];

function Connect({ orgId, notify, onDone }) {
  const [oauth, setOauth] = useState(null); // null = conferindo; true/false = login com Facebook ligado?
  const [pending, setPending] = useState(null); // contas encontradas depois do login
  const [pick, setPick] = useState([]);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [token, setToken] = useState('');
  const [found, setFound] = useState(null);
  const [act, setAct] = useState('');
  const popup = useRef(null);

  useEffect(() => {
    let on = true;
    KoblyApi.metaAds('oauth_status', {}, orgId).then((r) => { if (on) setOauth(!!(r && r.enabled)); });
    return () => { on = false; };
  }, [orgId]);

  const loadPending = useCallback(async () => {
    const r = await KoblyApi.metaAds('oauth_accounts', {}, orgId);
    if (r.error) { notify('danger', r.error); return; }
    setPending(r); setPick(r.accounts.filter((a) => a.active).map((a) => a.ad_account_id));
    if (!r.accounts.length) notify('warning', 'Este perfil do Facebook não tem nenhuma conta de anúncios.');
  }, [orgId, notify]);

  // a janelinha do Facebook avisa quando termina
  useEffect(() => {
    function onMsg(e) {
      if (!e.data || e.data.kobly !== 'meta-oauth' || e.source !== popup.current) return;
      setBusy(false); popup.current = null;
      if (e.data.ok) loadPending(); else notify('warning', e.data.message);
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [loadPending, notify]);

  async function start() {
    // abre a janela já no clique (senão o navegador bloqueia) e depois manda para o Facebook
    const w = window.open('', 'kobly-facebook', 'width=600,height=720');
    if (!w) { notify('warning', 'O navegador bloqueou a janelinha. Libere pop-ups para a Kobly e tente de novo.'); return; }
    w.document.title = 'Conectando ao Facebook…';
    popup.current = w; setBusy(true);
    const r = await KoblyApi.metaAds('oauth_start', {}, orgId);
    if (r.error) { w.close(); popup.current = null; setBusy(false); notify('danger', r.error); return; }
    w.location.href = r.url;
    const t = setInterval(() => { if (w.closed) { clearInterval(t); if (popup.current === w) { popup.current = null; setBusy(false); } } }, 700);
  }
  async function connectPicked() {
    setBusy(true);
    const r = await KoblyApi.metaAds('oauth_connect', { ad_account_ids: pick }, orgId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', r.accounts.length > 1 ? `${r.accounts.length} contas conectadas.` : `Conta "${r.accounts[0].name}" conectada.`);
    setPending(null); onDone(r.accounts[0]);
  }
  async function discover() {
    setBusy(true);
    const r = await KoblyApi.metaAds('discover', { access_token: token }, orgId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    setFound(r.accounts); setAct((r.accounts[0] || {}).ad_account_id || '');
    if (!r.accounts.length) notify('warning', 'Este token não enxerga nenhuma conta de anúncios.');
  }
  async function connect() {
    setBusy(true);
    const r = await KoblyApi.metaAds('connect', { access_token: token, ad_account_id: act }, orgId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', `Conta "${r.account.name}" conectada.`); onDone(r.account);
  }

  const toggle = (id) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <MetaLogo size={48} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>Conecte o Facebook Ads</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Em um clique, sem copiar token. A Kobly só lê os resultados das campanhas.</div>
          </div>
          {oauth && !pending && (
            <button type="button" onClick={start} disabled={busy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderRadius: 12, border: 0, cursor: busy ? 'wait' : 'pointer',
                background: '#1877F2', color: '#fff', fontWeight: 700, fontSize: 15, fontFamily: 'var(--font-sans)', opacity: busy ? 0.7 : 1 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M24 12a12 12 0 1 0-13.9 11.9v-8.4H7.1V12h3V9.4c0-3 1.8-4.7 4.5-4.7 1.3 0 2.7.2 2.7.2v2.9h-1.5c-1.5 0-2 .9-2 1.9V12h3.4l-.5 3.5h-2.9v8.4A12 12 0 0 0 24 12z" /></svg>
              {busy ? 'Aguardando o Facebook…' : 'Conectar com Facebook'}
            </button>
          )}
        </div>

        {oauth === false && !manual && (
          <Banner tone="info">O login com um clique ainda está sendo ativado na Kobly. Enquanto isso, dá para conectar colando um token (passo a passo abaixo).</Banner>
        )}

        {pending && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>
              {pending.user_name ? <>Entrou como <b>{pending.user_name}</b>. </> : null}Marque as contas de anúncios que a Kobly vai acompanhar:
            </div>
            {pending.accounts.map((a) => (
              <label key={a.ad_account_id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                border: `1px solid ${pick.includes(a.ad_account_id) ? 'var(--accent)' : 'var(--border-subtle)'}`, background: pick.includes(a.ad_account_id) ? 'var(--accent-soft)' : 'transparent' }}>
                <input type="checkbox" checked={pick.includes(a.ad_account_id)} onChange={() => toggle(a.ad_account_id)} style={{ accentColor: 'var(--accent)', width: 16, height: 16 }} />
                <span style={{ flex: 1, color: 'var(--text-strong)', fontWeight: 'var(--fw-semibold)' }}>{a.name}</span>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>{a.ad_account_id} · {a.currency}{a.active ? '' : ' · inativa'}</span>
              </label>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="primary" iconLeft="plug" disabled={busy || !pick.length} onClick={connectPicked}>{pick.length > 1 ? `Conectar ${pick.length} contas` : 'Conectar conta'}</Button>
              <Button variant="ghost" onClick={() => setPending(null)}>Cancelar</Button>
            </div>
          </div>
        )}

        {!pending && (
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {(manual || oauth === false ? [
              ['Abra o Gerenciador de Negócios', 'Em business.facebook.com, vá em Configurações → Usuários → Usuários do sistema.'],
              ['Crie um usuário do sistema', 'Clique em Adicionar, dê um nome (ex.: Kobly) e escolha a função Funcionário.'],
              ['Dê acesso à conta de anúncios', 'Em Atribuir ativos, escolha Contas de anúncios, marque a sua e dê controle total (para a Kobly poder pausar e mudar orçamento).'],
              ['Gere o token e cole aqui', 'Clique em Gerar token, marque as permissões ads_read e ads_management e cole o token no campo abaixo.'],
            ] : STEPS).map(([t, d], i) => (
              <div key={t} style={{ display: 'flex', gap: 10, padding: 12, borderRadius: 12, border: '1px solid var(--border-subtle)', background: 'var(--surface-raised, rgba(255,255,255,.02))' }}>
                <span style={{ flex: 'none', width: 26, height: 26, borderRadius: 8, display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 13, color: '#1b0d02', background: 'linear-gradient(135deg, #f39200, #ff6201)' }}>{i + 1}</span>
                <div><div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', fontSize: 'var(--text-sm)' }}>{t}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.5 }}>{d}</div></div>
              </div>
            ))}
          </div>
        )}

        {!pending && (manual || oauth === false) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Input label="Token de acesso" type="password" autoComplete="off" value={token} onChange={(e) => { setToken(e.target.value); setFound(null); }} style={{ flex: 1, minWidth: 260 }} />
              <Button variant="secondary" disabled={busy || token.trim().length < 20} onClick={discover}>Buscar contas</Button>
            </div>
            {found && found.length > 0 && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Select label="Conta de anúncios" value={act} onChange={(e) => setAct(e.target.value)} style={{ flex: 1, minWidth: 260 }}
                  options={found.map((a) => ({ value: a.ad_account_id, label: `${a.name} · ${a.ad_account_id} · ${a.currency}${a.active ? '' : ' (inativa)'}` }))} />
                <Button variant="primary" iconLeft="plug" disabled={busy || !act} onClick={connect}>Conectar</Button>
              </div>
            )}
          </div>
        )}
        {oauth && !pending && (
          <button type="button" onClick={() => setManual((v) => !v)} style={{ alignSelf: 'flex-start', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--text-link)', fontSize: 'var(--text-xs)' }}>
            {manual ? 'Voltar para o login com Facebook' : 'Prefere colar um token de usuário do sistema? Clique aqui'}
          </button>
        )}
      </div>
    </Card>
  );
}

// ---- Gerenciador: dashboard, contas, campanhas, conjuntos e anúncios -------------------------------

const CSS = `
.ka { display: flex; flex-direction: column; gap: 16px; }
.ka-plat { display: inline-flex; gap: 6px; padding: 5px; border-radius: 14px; border: 1px solid var(--border-subtle); background: rgba(255,255,255,.02); width: fit-content; max-width: 100%; overflow-x: auto; }
.ka-plat button { display: inline-flex; align-items: center; gap: 9px; padding: 7px 14px 7px 8px; border-radius: 10px; border: 1px solid transparent; background: none; cursor: pointer; color: var(--text-muted); font: 600 14px var(--font-sans); white-space: nowrap; }
.ka-plat button.on { background: var(--accent-soft); border-color: rgba(255,98,1,.45); color: var(--text-strong); }
.ka-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border-subtle); overflow-x: auto; }
.ka-tab { display: inline-flex; align-items: center; gap: 8px; padding: 11px 16px; border: 0; background: none; cursor: pointer; color: var(--text-muted);
  font: 600 14px var(--font-sans); border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
.ka-tab:hover { color: var(--text-strong); }
.ka-tab.on { color: var(--accent); border-bottom-color: var(--accent); }
.ka-tab .n { font-size: 11px; padding: 1px 7px; border-radius: 99px; background: rgba(255,255,255,.07); color: var(--text-body); }
.ka-bar { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; padding: 14px; border-radius: 16px; border: 1px solid var(--border-subtle);
  background: linear-gradient(180deg, rgba(255,98,1,.05), transparent 70%), var(--surface-card, #121212); }
.ka-upd { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-subtle); padding-bottom: 10px; }
.ka-upd i { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 8px #22c55e; }
.ka-kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; }
.ka-kpi { position: relative; padding: 16px 18px; border-radius: 14px; border: 1px solid var(--border-subtle); background: var(--surface-card, #121212); overflow: hidden; }
.ka-kpi::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--c, var(--accent)); }
.ka-kpi .l { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-subtle); font-weight: 700; }
.ka-kpi .v { margin-top: 8px; font-size: 26px; font-weight: 800; color: var(--text-strong); font-variant-numeric: tabular-nums; }
.ka-kpi .v.neg { color: #f87171; }
.ka-kpi .s { margin-top: 2px; font-size: 12px; color: var(--text-muted); }
.ka-seg { display: inline-flex; padding: 3px; border-radius: 10px; border: 1px solid var(--border-subtle); background: rgba(255,255,255,.02); }
.ka-seg button { border: 0; background: none; color: var(--text-muted); font: 600 12px var(--font-sans); padding: 7px 12px; border-radius: 8px; cursor: pointer; }
.ka-seg button.on { background: var(--accent); color: #1b0d02; }
.ka-card { border-radius: 16px; border: 1px solid var(--border-subtle); background: var(--surface-card, #121212); }
.ka-tablewrap { overflow-x: auto; }
.ka-table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
.ka-table th { text-align: right; padding: 11px 14px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--text-subtle); font-weight: 700;
  border-bottom: 1px solid var(--border-subtle); white-space: nowrap; position: sticky; top: 0; background: var(--surface-card, #121212); }
.ka-table th.l, .ka-table td.l { text-align: left; }
.ka-table td { text-align: right; padding: 11px 14px; border-bottom: 1px solid rgba(255,255,255,.04); color: var(--text-body); white-space: nowrap; }
.ka-table tr:hover td { background: rgba(255,98,1,.035); }
.ka-table tfoot td { font-weight: 700; color: var(--text-strong); border-top: 1px solid var(--border-subtle); border-bottom: 0; }
.ka-name { display: flex; flex-direction: column; gap: 3px; min-width: 220px; max-width: 340px; white-space: normal; }
.ka-name b { color: var(--text-strong); font-weight: 600; }
.ka-name button { all: unset; cursor: pointer; color: var(--text-strong); font-weight: 600; }
.ka-name button:hover { color: var(--accent); }
.ka-name span { font-size: 11px; color: var(--text-subtle); }
.ka-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 99px; width: fit-content; }
.ka-pill.on { color: #4ade80; background: rgba(74,222,128,.1); } .ka-pill.off { color: #fca5a5; background: rgba(248,113,113,.1); } .ka-pill.mid { color: #fbbf24; background: rgba(251,191,36,.1); }
.ka-sw { position: relative; width: 38px; height: 22px; border-radius: 99px; border: 1px solid var(--border-subtle); background: rgba(255,255,255,.08); cursor: pointer; transition: .2s; flex: none; }
.ka-sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #9ca3af; transition: .2s; }
.ka-sw.on { background: linear-gradient(135deg, #f39200, #ff6201); border-color: transparent; }
.ka-sw.on::after { left: 18px; background: #fff; }
.ka-sw:disabled { opacity: .5; cursor: wait; }
.ka-bud { display: inline-flex; align-items: center; gap: 6px; }
.ka-bud button { all: unset; cursor: pointer; color: var(--text-subtle); display: inline-grid; }
.ka-bud button:hover { color: var(--accent); }
.ka-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 99px; font-size: 12px; background: var(--accent-soft); color: var(--accent); }
.ka-chip button { all: unset; cursor: pointer; display: inline-grid; }
.ka-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; }
.ka-cols label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-body); cursor: pointer; padding: 4px 0; }
.ka-cols h5 { grid-column: 1 / -1; margin: 10px 0 0; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-subtle); }
@media (max-width: 640px) { .ka-cols { grid-template-columns: 1fr; } .ka-kpi .v { font-size: 22px; } }
`;

const PERIODS = [['today', 'Hoje'], ['yesterday', 'Ontem'], ['last_7d', 'Últimos 7 dias'], ['last_14d', 'Últimos 14 dias'], ['last_30d', 'Últimos 30 dias'], ['this_month', 'Este mês'], ['last_month', 'Mês passado'], ['maximum', 'Todo o período']];
const pct = (v) => (v == null ? '—' : `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`);
const num2 = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

// colunas que a pessoa liga e desliga (como nos rastreadores de UTM)
const COLS = [
  { key: 'budget', label: 'Orçamento', group: 'Financeiras', levels: ['campaign', 'adset'] },
  { key: 'spend', label: 'Gasto', group: 'Financeiras', money: true },
  { key: 'faturamento', label: 'Faturamento', group: 'Financeiras', money: true },
  { key: 'lucro', label: 'Lucro', group: 'Financeiras', money: true, sign: true },
  { key: 'roas', label: 'ROAS', group: 'Financeiras', fmt: (v) => roas(v) },
  { key: 'roi', label: 'ROI', group: 'Financeiras', fmt: pct },
  { key: 'margem', label: 'Margem', group: 'Financeiras', fmt: pct },
  { key: 'cpa', label: 'CPA', group: 'Financeiras', money: true },
  { key: 'vendas', label: 'Vendas', group: 'Vendas', fmt: int },
  { key: 'compras_meta', label: 'Vendas (Meta)', group: 'Vendas', fmt: int },
  { key: 'leads', label: 'Leads (Kobly)', group: 'Vendas', fmt: int },
  { key: 'conversas', label: 'Conversas iniciadas', group: 'Mensagens', fmt: int },
  { key: 'custo_por_conversa', label: 'Custo por conversa', group: 'Mensagens', money: true },
  { key: 'impressions', label: 'Impressões', group: 'Tráfego', fmt: int },
  { key: 'reach', label: 'Alcance', group: 'Tráfego', fmt: int },
  { key: 'clicks', label: 'Cliques', group: 'Tráfego', fmt: int },
  { key: 'ctr', label: 'CTR', group: 'Tráfego', fmt: pct },
  { key: 'cpc', label: 'CPC', group: 'Tráfego', money: true },
  { key: 'cpm', label: 'CPM', group: 'Tráfego', money: true },
];
const DEFAULT_COLS = ['budget', 'spend', 'faturamento', 'lucro', 'roas', 'vendas', 'cpa', 'conversas', 'custo_por_conversa', 'ctr', 'cpc'];
const COLS_KEY = 'kobly:ads-cols';
const readCols = () => { try { const v = JSON.parse(localStorage.getItem(COLS_KEY)); return Array.isArray(v) && v.length ? v : DEFAULT_COLS; } catch { return DEFAULT_COLS; } };

const STATUS_PILL = { ACTIVE: ['on', 'Ativo'], PAUSED: ['off', 'Pausado'], CAMPAIGN_PAUSED: ['off', 'Campanha pausada'], ADSET_PAUSED: ['off', 'Conjunto pausado'],
  PENDING_REVIEW: ['mid', 'Em análise'], IN_PROCESS: ['mid', 'Processando'], WITH_ISSUES: ['mid', 'Com problema'], DISAPPROVED: ['off', 'Reprovado'], PENDING_BILLING_INFO: ['mid', 'Pagamento pendente'] };
const PLATFORMS = {
  meta: { id: 'meta', name: 'Facebook Ads', api: (...a) => KoblyApi.metaAds(...a), where: 'no Facebook', hide: [], conv: 'Vendas (Meta)',
    level: { campaign: 'Campanha', adset: 'Conjunto', ad: 'Anúncio' }, plural: { campaign: 'campanhas', adset: 'conjuntos', ad: 'anúncios' }, tabs: { campaign: 'Campanhas', adset: 'Conjuntos', ad: 'Anúncios' },
    utmWhere: 'nos Parâmetros de URL dos anúncios', utm: 'utm_source=FB&utm_campaign={{campaign.name}}|{{campaign.id}}&utm_medium={{adset.name}}|{{adset.id}}&utm_content={{ad.name}}|{{ad.id}}&utm_term={{placement}}' },
  google: { id: 'google', name: 'Google Ads', api: (...a) => KoblyApi.googleAds(...a), where: 'no Google Ads', hide: ['conversas', 'custo_por_conversa', 'reach'], conv: 'Conversões (Google)',
    level: { campaign: 'Campanha', adset: 'Grupo de anúncios', ad: 'Anúncio' }, plural: { campaign: 'campanhas', adset: 'grupos de anúncios', ad: 'anúncios' }, tabs: { campaign: 'Campanhas', adset: 'Grupos de anúncios', ad: 'Anúncios' },
    utmWhere: 'no Modelo de acompanhamento da conta do Google Ads (Configurações da conta → Opções de URL)', utm: '{lpurl}?utm_source=google&utm_campaign={campaignid}&utm_medium={adgroupid}&utm_content={creative}&utm_term={keyword}' },
};

function Kpi({ label, value, sub, color, neg }) {
  return <div className="ka-kpi" style={{ '--c': color }}><div className="l">{label}</div><div className={`v${neg ? ' neg' : ''}`}>{value}</div>{sub && <div className="s">{sub}</div>}</div>;
}

// gráfico de linhas simples (gasto x faturamento por dia), em SVG
function Chart({ serie, fonte, cur }) {
  const [hover, setHover] = useState(null);
  if (!serie.length) return <EmptyState compact icon="chart-line" title="Sem dados no período" message="Troque o período para ver a evolução." />;
  const W = 900, H = 240, P = { l: 56, r: 16, t: 16, b: 28 };
  const fat = serie.map((d) => (fonte === 'meta' ? d.faturamento_meta : d.faturamento));
  const max = Math.max(1, ...serie.map((d) => d.gasto), ...fat) * 1.1;
  const x = (i) => P.l + (serie.length === 1 ? (W - P.l - P.r) / 2 : (i * (W - P.l - P.r)) / (serie.length - 1));
  const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const line = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = (vals) => `${line(vals)} L${x(vals.length - 1)},${H - P.b} L${x(0)},${H - P.b} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => max * t);
  const dia = (s) => s.slice(8, 10) + '/' + s.slice(5, 7);
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="ka-g1" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ff6201" stopOpacity=".35" /><stop offset="1" stopColor="#ff6201" stopOpacity="0" /></linearGradient>
          <linearGradient id="ka-g2" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#22c55e" stopOpacity=".25" /><stop offset="1" stopColor="#22c55e" stopOpacity="0" /></linearGradient>
        </defs>
        {ticks.map((t) => <g key={t}><line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="rgba(255,255,255,.06)" strokeDasharray="3 4" />
          <text x={P.l - 8} y={y(t) + 4} textAnchor="end" fontSize="10" fill="rgba(255,255,255,.4)">{Math.round(t).toLocaleString('pt-BR')}</text></g>)}
        <path d={area(fat)} fill="url(#ka-g2)" /><path d={line(fat)} fill="none" stroke="#22c55e" strokeWidth="2.2" />
        <path d={area(serie.map((d) => d.gasto))} fill="url(#ka-g1)" /><path d={line(serie.map((d) => d.gasto))} fill="none" stroke="#ff6201" strokeWidth="2.2" />
        {serie.map((d, i) => (serie.length <= 16 || i % Math.ceil(serie.length / 12) === 0) && <text key={d.dia} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="rgba(255,255,255,.4)">{dia(d.dia)}</text>)}
        {serie.map((d, i) => <rect key={`h${d.dia}`} x={x(i) - (W / serie.length) / 2} y={0} width={W / serie.length} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />)}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} stroke="rgba(255,255,255,.25)" />}
      </svg>
      {hover != null && (
        <div style={{ position: 'absolute', top: 8, left: `${Math.min(70, (x(hover) / W) * 100)}%`, padding: '8px 12px', borderRadius: 10, background: '#1a1a1a', border: '1px solid var(--border-subtle)', fontSize: 12, pointerEvents: 'none' }}>
          <div style={{ color: 'var(--text-strong)', fontWeight: 700, marginBottom: 4 }}>{dia(serie[hover].dia)}</div>
          <div style={{ color: '#ff9452' }}>Gasto: {money(serie[hover].gasto, cur)}</div>
          <div style={{ color: '#4ade80' }}>Faturamento: {money(fat[hover], cur)}</div>
          <div style={{ color: 'var(--text-muted)' }}>Vendas: {int(fonte === 'meta' ? serie[hover].vendas_meta : serie[hover].vendas)}</div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-muted)', padding: '6px 0 0 56px' }}>
        <span><i style={{ display: 'inline-block', width: 10, height: 3, background: '#ff6201', marginRight: 6, verticalAlign: 'middle' }} />Gasto</span>
        <span><i style={{ display: 'inline-block', width: 10, height: 3, background: '#22c55e', marginRight: 6, verticalAlign: 'middle' }} />Faturamento</span>
      </div>
    </div>
  );
}

function Dashboard({ P, orgId, conta, preset, tick, onSettings }) {
  const [st, setSt] = useState({ loading: true });
  const [fonte, setFonte] = useState('sistema');
  useEffect(() => {
    let on = true;
    P.api('dashboard', { id: conta, date_preset: preset, force: tick.force }, orgId).then((r) => { if (on) setSt(r.error ? { error: r.error } : { d: r }); });
    return () => { on = false; };
  }, [P, orgId, conta, preset, tick]);
  if (st.error) return <ErrorState message={st.error} />;
  if (!st.d) return <SkeletonTable rows={4} />;
  const d = st.d, cur = d.currency, m = fonte === 'meta' ? d.meta_ads : d.sistema;
  return (
    <div className="ka">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{fonte === 'meta' ? `Vendas e faturamento que o ${P.name} informa (estimativa dele).` : 'Vendas que a Kobly rastreou pela UTM: checkout aprovado + recuperadas pelo fluxo.'}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button size="sm" variant="ghost" iconLeft="settings" onClick={onSettings}>Taxas e despesas</Button>
          <div className="ka-seg"><button className={fonte === 'sistema' ? 'on' : ''} onClick={() => setFonte('sistema')}>Kobly (rastreado)</button><button className={fonte === 'meta' ? 'on' : ''} onClick={() => setFonte('meta')}>{P.name}</button></div>
        </div>
      </div>
      <div className="ka-kpis">
        <Kpi label="Faturamento" value={money(m.faturamento, cur)} color="#22c55e" />
        <Kpi label={`Gasto ${P.name}`} value={money(m.gasto, cur)} color="#ff6201" />
        <Kpi label="Lucro" value={money(m.lucro, cur)} color={m.lucro < 0 ? '#f87171' : '#22c55e'} neg={m.lucro < 0} sub={m.despesas ? `já descontados ${money(m.despesas, cur)} de taxas` : null} />
        <Kpi label="Ticket médio" value={money(m.ticket_medio, cur)} color="#f39200" />
        <Kpi label="Margem de lucro" value={pct(m.margem)} color={m.margem != null && m.margem < 0 ? '#f87171' : '#22c55e'} neg={m.margem != null && m.margem < 0} />
        <Kpi label="ROAS" value={roas(m.roas)} color={m.roas != null && m.roas < 1 ? '#f87171' : '#22c55e'} neg={m.roas != null && m.roas < 1} />
        <Kpi label="Leads" value={int(m.leads)} color="#ffb485" />
        <Kpi label="Vendas" value={int(m.vendas)} color="#22c55e" />
        <Kpi label="Taxa de conversão" value={pct(m.taxa_conversao)} color="#ffb485" />
        <Kpi label="Custo por venda" value={money(m.cpa, cur)} color="#f39200" />
        {P.id === 'meta' && <Kpi label="Custo por conversa" value={money(m.custo_por_conversa, cur)} color="#ff9452" sub={`${int(d.meta.conversas)} conversas iniciadas`} />}
        {fonte === 'sistema' && <Kpi label="Recuperadas pela Kobly" value={money(d.sistema.receita_recuperada, cur)} color="#ff6201" sub={`${int(d.sistema.recuperadas)} venda(s) pelo fluxo`} />}
      </div>
      <div className="ka-card" style={{ padding: 18 }}>
        <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-subtle)', fontWeight: 700 }}>Gasto e faturamento por dia</div>
        <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-strong)', margin: '4px 0 12px' }}>{int(m.vendas)} venda(s) no período · {money(m.faturamento, cur)}</div>
        <Chart serie={d.serie} fonte={fonte === 'meta' ? 'meta' : 'sistema'} cur={cur} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
        <Kpi label="Impressões" value={int(d.meta.impressions)} color="#525252" />
        <Kpi label="Cliques" value={int(d.meta.clicks)} color="#525252" />
        <Kpi label="CTR" value={pct(d.meta.ctr)} color="#525252" />
        <Kpi label="CPC" value={money(d.meta.cpc, cur)} color="#525252" />
        <Kpi label="CPM" value={money(d.meta.cpm, cur)} color="#525252" />
      </div>
    </div>
  );
}

function Accounts({ P, orgId, preset, tick, canEdit, onDisconnect, onOpen }) {
  const [st, setSt] = useState({ loading: true });
  useEffect(() => {
    let on = true;
    P.api('accounts_overview', { date_preset: preset, force: tick.force }, orgId).then((r) => { if (on) setSt(r.error ? { error: r.error } : { list: r.accounts }); });
    return () => { on = false; };
  }, [P, orgId, preset, tick]);
  if (st.error) return <ErrorState message={st.error} />;
  if (!st.list) return <SkeletonTable rows={3} />;
  return (
    <div className="ka-card ka-tablewrap">
      <table className="ka-table">
        <thead><tr><th className="l">Conta</th><th className="l">Situação</th><th>Gasto</th><th>Faturamento</th><th>Lucro</th><th>Vendas</th><th>CPA</th><th>ROAS</th><th>Campanhas ativas</th><th /></tr></thead>
        <tbody>
          {st.list.map((a) => (
            <tr key={a.id}>
              <td className="l"><div className="ka-name"><button onClick={() => onOpen(a.id)}>{a.name}</button><span>{a.ad_account_id} · {a.currency}</span></div></td>
              <td className="l">{a.erro ? <span className="ka-pill off" title={a.erro}>Erro ao ler</span> : <span className={`ka-pill ${a.ativa ? 'on' : 'off'}`}>{a.ativa ? 'Ativa' : 'Desativada'}</span>}</td>
              <td>{money(a.spend, a.currency)}</td><td>{money(a.faturamento, a.currency)}</td>
              <td style={{ color: a.lucro < 0 ? '#f87171' : a.lucro > 0 ? '#4ade80' : undefined }}>{money(a.lucro, a.currency)}</td>
              <td>{a.erro ? '—' : int(a.vendas)}</td><td>{money(a.cpa, a.currency)}</td><td>{roas(a.roas)}</td><td>{a.erro ? '—' : int(a.campanhas_ativas)}</td>
              <td>{canEdit && <IconButton icon="unplug" size="sm" aria-label="Desconectar conta" onClick={() => onDisconnect(a)} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {st.list.some((a) => a.erro) && <div style={{ padding: 14 }}><Banner tone="danger">{st.list.find((a) => a.erro).erro}</Banner></div>}
    </div>
  );
}

function Entities({ P, orgId, level, conta, preset, tick, canEdit, notify, parent, onDrill, onClearParent }) {
  const [st, setSt] = useState({ loading: true });
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('any');
  const [cols, setCols] = useState(readCols);
  const [picking, setPicking] = useState(null);
  const [busy, setBusy] = useState({});
  const [budget, setBudget] = useState(null); // { item, value }
  const load = useCallback((force) => P.api('entities', { level, id: conta, date_preset: preset, force }, orgId).then((r) => setSt(r.error ? { error: r.error } : { items: r.items })), [P, orgId, level, conta, preset]);
  useEffect(() => { setSt({ loading: true }); load(tick.force); }, [load, tick]);

  async function toggle(it) {
    const next = it.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    setBusy((b) => ({ ...b, [it.id]: true }));
    const r = await P.api('set_status', { id: it.account_id, level, object_id: it.id, parent_id: it.adset_id, status: next }, orgId);
    setBusy((b) => ({ ...b, [it.id]: false }));
    if (r.error) { notify('danger', r.error); return; }
    setSt((s) => ({ items: s.items.map((x) => (x.id === it.id ? { ...x, status: next, effective_status: next } : x)) }));
    const fem = level === 'campaign';
    notify('success', `${P.level[level]} "${it.name}" ${next === 'ACTIVE' ? (fem ? 'ativada' : 'ativado') : (fem ? 'pausada' : 'pausado')}.`);
  }
  async function saveBudget() {
    const it = budget.item;
    setBudget((b) => ({ ...b, saving: true }));
    const r = await P.api('set_budget', { id: it.account_id, level, object_id: it.id, value: budget.value }, orgId);
    if (r.error) { setBudget((b) => ({ ...b, saving: false })); notify('danger', r.error); return; }
    setBudget(null); notify('success', `Orçamento atualizado ${P.where}.`); load(true);
  }

  if (st.error) return <ErrorState message={st.error} onRetry={() => load(true)} />;
  const shown = COLS.filter((c) => cols.includes(c.key) && !P.hide.includes(c.key) && (!c.levels || c.levels.includes(level) && (P.id === 'meta' || c.key !== 'budget' || level === 'campaign')))
    .map((c) => (c.key === 'compras_meta' ? { ...c, label: P.conv } : c));
  const items = (st.items || []).filter((it) => (!parent || (level === 'adset' ? it.campaign_id === parent.id : parent.type === 'campaign' ? it.campaign_id === parent.id : it.adset_id === parent.id))
    && (!q || it.name.toLowerCase().includes(q.toLowerCase()))
    && (status === 'any' || (status === 'active' ? it.effective_status === 'ACTIVE' : it.effective_status !== 'ACTIVE'))
    && (status !== 'spend' || it.spend > 0));
  const cur = (items[0] && items[0].currency) || 'BRL';
  const sum = (k) => items.reduce((s, it) => s + (Number(it[k]) || 0), 0);
  const tot = { spend: sum('spend'), faturamento: sum('faturamento'), lucro: sum('lucro'), vendas: sum('vendas'), compras_meta: sum('compras_meta'), leads: sum('leads'),
    conversas: sum('conversas'), impressions: sum('impressions'), reach: sum('reach'), clicks: sum('clicks') };
  Object.assign(tot, { roas: tot.spend ? tot.faturamento / tot.spend : null, roi: tot.spend ? tot.lucro / tot.spend * 100 : null, margem: tot.faturamento ? tot.lucro / tot.faturamento * 100 : null,
    cpa: tot.vendas ? tot.spend / tot.vendas : null, custo_por_conversa: tot.conversas ? tot.spend / tot.conversas : null,
    ctr: tot.impressions ? tot.clicks / tot.impressions * 100 : null, cpc: tot.clicks ? tot.spend / tot.clicks : null, cpm: tot.impressions ? tot.spend / tot.impressions * 1000 : null });
  const cell = (c, it) => {
    if (c.key === 'budget') {
      const b = it.daily_budget || it.lifetime_budget;
      if (!b) return <span style={{ color: 'var(--text-subtle)' }}>{level === 'adset' ? 'na campanha' : P.id === 'google' ? '—' : 'nos conjuntos'}</span>;
      return <span className="ka-bud">{money(b / it.budget_unit, it.currency)}<small style={{ color: 'var(--text-subtle)' }}>{it.daily_budget ? '/dia' : ' total'}</small>
        {canEdit && <button aria-label="Editar orçamento" onClick={() => setBudget({ item: it, value: String(b / it.budget_unit) })}><Icon name="pencil" size={13} /></button>}</span>;
    }
    const v = it[c.key];
    if (c.money) return <span style={c.sign && v ? { color: v < 0 ? '#f87171' : '#4ade80' } : undefined}>{money(v, it.currency)}</span>;
    return c.fmt ? c.fmt(v) : v;
  };
  return (
    <div className="ka">
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Input label={`Buscar ${P.level[level].toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar por nome" style={{ minWidth: 220 }} />
        <Select label="Situação" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 180 }}
          options={[{ value: 'any', label: 'Qualquer' }, { value: 'active', label: 'Ativos' }, { value: 'paused', label: 'Pausados' }, { value: 'spend', label: 'Com gasto no período' }]} />
        <Button variant="secondary" iconLeft="columns" onClick={() => setPicking(cols)}>Colunas</Button>
        {parent && <span className="ka-chip">{parent.label}: {parent.name}<button aria-label="Limpar filtro" onClick={onClearParent}><Icon name="x" size={13} /></button></span>}
      </div>
      {!st.items ? <SkeletonTable rows={5} /> : (
        <div className="ka-card ka-tablewrap">
          <table className="ka-table">
            <thead><tr>{canEdit && <th className="l" style={{ width: 60 }}>On/Off</th>}<th className="l">{P.level[level]}</th>{shown.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={shown.length + 2} className="l"><EmptyState compact icon="target" title="Nada por aqui" message="Troque o período, a conta ou o filtro de situação." /></td></tr>}
              {items.map((it) => {
                const [tone, label] = STATUS_PILL[it.effective_status] || ['mid', it.effective_status];
                return (
                  <tr key={it.id}>
                    {canEdit && <td className="l"><button type="button" className={`ka-sw${it.status === 'ACTIVE' ? ' on' : ''}`} disabled={!!busy[it.id]} aria-label={it.status === 'ACTIVE' ? 'Pausar' : 'Ativar'} onClick={() => toggle(it)} /></td>}
                    <td className="l"><div className="ka-name">
                      {level !== 'ad' ? <button onClick={() => onDrill(level, it)}>{it.name}</button> : <b>{it.name}</b>}
                      <span>{[level !== 'campaign' && it.campaign_name, level === 'ad' && it.adset_name, it.account_name].filter(Boolean).join(' · ')}</span>
                      <span className={`ka-pill ${tone}`}>{label}</span>
                    </div></td>
                    {shown.map((c) => <td key={c.key}>{cell(c, it)}</td>)}
                  </tr>
                );
              })}
            </tbody>
            {items.length > 1 && <tfoot><tr>{canEdit && <td />}<td className="l">{items.length} {P.plural[level]}</td>
              {shown.map((c) => <td key={c.key}>{c.key === 'budget' ? '' : c.money ? money(tot[c.key], cur) : c.fmt ? c.fmt(tot[c.key]) : tot[c.key]}</td>)}</tr></tfoot>}
          </table>
        </div>
      )}
      <Modal open={!!picking} onClose={() => setPicking(null)} title="Personalize as colunas" subtitle="Escolha o que aparece na tabela. Vale para campanhas, conjuntos e anúncios." width={560}
        footer={<><Button variant="ghost" iconLeft="rotate-ccw" onClick={() => setPicking(DEFAULT_COLS)}>Restaurar padrão</Button><Button variant="primary" onClick={() => { setCols(picking); try { localStorage.setItem(COLS_KEY, JSON.stringify(picking)); } catch { /* ok */ } setPicking(null); }}>Salvar</Button></>}>
        {picking && <div className="ka-cols">
          {[...new Set(COLS.map((c) => c.group))].map((g) => (
            <React.Fragment key={g}><h5>{g}</h5>
              {COLS.filter((c) => c.group === g && !P.hide.includes(c.key)).map((c) => (
                <label key={c.key}><input type="checkbox" checked={picking.includes(c.key)} style={{ accentColor: 'var(--accent)' }}
                  onChange={() => setPicking((p) => (p.includes(c.key) ? p.filter((k) => k !== c.key) : [...p, c.key]))} />{c.key === 'compras_meta' ? P.conv : c.label}</label>
              ))}
            </React.Fragment>
          ))}
        </div>}
      </Modal>
      <Modal open={!!budget} onClose={() => !(budget && budget.saving) && setBudget(null)} title="Editar orçamento" subtitle={budget ? `${P.level[level]} "${budget.item.name}" — muda direto ${P.where}.` : ''}
        footer={<><Button variant="ghost" onClick={() => setBudget(null)}>Cancelar</Button><Button variant="primary" loading={!!(budget && budget.saving)} onClick={saveBudget}>Salvar orçamento</Button></>}>
        {budget && <Input label={budget.item.daily_budget ? 'Orçamento diário' : 'Orçamento total'} value={budget.value} inputMode="decimal" autoFocus
          onChange={(e) => setBudget((b) => ({ ...b, value: e.target.value }))} hint={`Em ${budget.item.currency || 'BRL'}. Ex.: 50 ou 75,50.`} />}
      </Modal>
    </div>
  );
}

function SettingsModal({ open, orgId, notify, onClose }) {
  const [s, setS] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) KoblyApi.metaAds('get_settings', {}, orgId).then((r) => setS(r.settings || { imposto_pct: 0, taxa_gateway_pct: 0, custo_produto_pct: 0, custo_por_venda: 0 })); }, [open, orgId]);
  async function save() {
    setSaving(true);
    const r = await KoblyApi.metaAds('save_settings', Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(String(v).replace(',', '.')) || 0])), orgId);
    setSaving(false);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', 'Taxas salvas. O lucro já considera esses valores.'); onClose(true);
  }
  const f = (k, label, hint) => <Input label={label} value={s ? String(s[k]) : ''} inputMode="decimal" hint={hint} onChange={(e) => setS((x) => ({ ...x, [k]: e.target.value }))} />;
  return (
    <Modal open={open} onClose={() => onClose(false)} title="Taxas e despesas" subtitle="Usadas para calcular o lucro e a margem: saem do faturamento antes de chegar ao lucro."
      footer={<><Button variant="ghost" onClick={() => onClose(false)}>Cancelar</Button><Button variant="primary" loading={saving} disabled={!s} onClick={save}>Salvar</Button></>}>
      {!s ? <SkeletonTable rows={2} /> : <div style={{ display: 'grid', gap: 12 }}>
        {f('imposto_pct', 'Imposto (%)', 'Ex.: 6 para Simples Nacional.')}
        {f('taxa_gateway_pct', 'Taxa do checkout/gateway (%)', 'O quanto a plataforma de pagamento cobra por venda.')}
        {f('custo_produto_pct', 'Custo do produto (%)', 'Para produto físico ou coprodução. Deixe 0 se não tiver.')}
        {f('custo_por_venda', 'Custo fixo por venda', 'Frete, embalagem... em valor por venda.')}
      </div>}
    </Modal>
  );
}

const GOOGLE_STEPS = [
  ['Clique em "Conectar com Google"', 'Abre uma janelinha do Google. Entre com o e-mail que tem acesso às suas contas do Google Ads.'],
  ['Autorize a Kobly', 'O Google pergunta se a Kobly pode ver e gerenciar suas campanhas. A Kobly só liga, pausa ou muda orçamento quando você clica.'],
  ['Escolha as contas', 'Aparecem suas contas (inclusive as de dentro de uma conta de administrador/MCC). Marque as que quer acompanhar.'],
  ['Marque as campanhas (recomendado)', 'No Google Ads, em Configurações da conta → Opções de URL → Modelo de acompanhamento, cole o modelo que aparece no fim desta página.'],
];

function GoogleConnect({ orgId, notify, onDone }) {
  const [on, setOn] = useState(null);
  const [pending, setPending] = useState(null);
  const [pick, setPick] = useState([]);
  const [busy, setBusy] = useState(false);
  const popup = useRef(null);
  useEffect(() => {
    let alive = true;
    KoblyApi.googleAds('oauth_status', {}, orgId).then((r) => { if (alive) setOn(!!(r && r.enabled)); });
    return () => { alive = false; };
  }, [orgId]);
  const loadPending = useCallback(async () => {
    setBusy(true);
    const r = await KoblyApi.googleAds('oauth_accounts', {}, orgId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    setPending(r.accounts); setPick(r.accounts.map((a) => a.customer_id));
    if (!r.accounts.length) notify('warning', 'Este login do Google não tem nenhuma conta do Google Ads.');
  }, [orgId, notify]);
  useEffect(() => {
    function onMsg(e) {
      if (!e.data || e.data.kobly !== 'google-oauth' || e.source !== popup.current) return;
      setBusy(false); popup.current = null;
      if (e.data.ok) loadPending(); else notify('warning', e.data.message);
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [loadPending, notify]);
  async function start() {
    const w = window.open('', 'kobly-google', 'width=520,height=680');
    if (!w) { notify('warning', 'O navegador bloqueou a janelinha. Libere pop-ups para a Kobly e tente de novo.'); return; }
    w.document.title = 'Conectando ao Google…';
    popup.current = w; setBusy(true);
    const r = await KoblyApi.googleAds('oauth_start', {}, orgId);
    if (r.error) { w.close(); popup.current = null; setBusy(false); notify('danger', r.error); return; }
    w.location.href = r.url;
    const t = setInterval(() => { if (w.closed) { clearInterval(t); if (popup.current === w) { popup.current = null; setBusy(false); } } }, 700);
  }
  async function connect() {
    setBusy(true);
    const r = await KoblyApi.googleAds('oauth_connect', { customer_ids: pick }, orgId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', r.accounts.length > 1 ? `${r.accounts.length} contas do Google Ads conectadas.` : `Conta "${r.accounts[0].name}" conectada.`);
    setPending(null); onDone();
  }
  const fmtId = (id) => String(id).replace(/(\d{3})(\d{3})(\d+)/, '$1-$2-$3');
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <GoogleAdsLogo size={48} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>Conecte o Google Ads</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Em um clique. Veja gasto, vendas e lucro de cada campanha e pause ou mude o orçamento daqui.</div>
          </div>
          {on && !pending && (
            <button type="button" onClick={start} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '11px 18px', borderRadius: 12, border: '1px solid #dadce0', cursor: busy ? 'wait' : 'pointer',
              background: '#fff', color: '#1f1f1f', fontWeight: 600, fontSize: 15, fontFamily: 'var(--font-sans)', opacity: busy ? 0.7 : 1 }}>
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" /><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" /><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" /><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" /></svg>
              {busy ? 'Aguardando o Google…' : 'Conectar com Google'}
            </button>
          )}
        </div>
        {on === false && <Banner tone="info">O Google Ads está sendo ativado na Kobly (falta o Google aprovar o acesso). Assim que estiver pronto, o botão "Conectar com Google" aparece aqui.</Banner>}
        {pending && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>Marque as contas do Google Ads que a Kobly vai acompanhar:</div>
            {pending.map((a) => {
              const sel = pick.includes(a.customer_id);
              return (
                <label key={a.customer_id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${sel ? 'var(--accent)' : 'var(--border-subtle)'}`, background: sel ? 'var(--accent-soft)' : 'transparent' }}>
                  <input type="checkbox" checked={sel} onChange={() => setPick((p) => (sel ? p.filter((x) => x !== a.customer_id) : [...p, a.customer_id]))} style={{ accentColor: 'var(--accent)', width: 16, height: 16 }} />
                  <span style={{ flex: 1, color: 'var(--text-strong)', fontWeight: 'var(--fw-semibold)' }}>{a.name}{a.test ? ' (teste)' : ''}</span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>{fmtId(a.customer_id)} · {a.currency}{a.via ? ` · via ${a.via}` : ''}</span>
                </label>
              );
            })}
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="primary" iconLeft="plug" disabled={busy || !pick.length} onClick={connect}>{pick.length > 1 ? `Conectar ${pick.length} contas` : 'Conectar conta'}</Button>
              <Button variant="ghost" onClick={() => setPending(null)}>Cancelar</Button>
            </div>
          </div>
        )}
        {!pending && (
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {GOOGLE_STEPS.map(([t, d], i) => (
              <div key={t} style={{ display: 'flex', gap: 10, padding: 12, borderRadius: 12, border: '1px solid var(--border-subtle)' }}>
                <span style={{ flex: 'none', width: 26, height: 26, borderRadius: 8, display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 13, color: '#1b0d02', background: 'linear-gradient(135deg, #f39200, #ff6201)' }}>{i + 1}</span>
                <div><div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', fontSize: 'var(--text-sm)' }}>{t}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.5 }}>{d}</div></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

const PLATFORM_KEY = 'kobly:ads-platform';

function KoblyMetaAds() {
  const store = useKobly();
  const { orgId, picker, canEdit } = useTargetOrg();
  const [platform, setPlatform] = useState(() => { try { return localStorage.getItem(PLATFORM_KEY) === 'google' ? 'google' : 'meta'; } catch { return 'meta'; } });
  const P = PLATFORMS[platform];
  const [accs, setAccs] = useState({ loading: true, list: [], error: null });
  const [tab, setTab] = useState('dashboard');
  const [conta, setConta] = useState('all');
  const [preset, setPreset] = useState('last_7d');
  const [tick, setTick] = useState({ n: 0, force: false });
  const [updated, setUpdated] = useState(new Date());
  const [adding, setAdding] = useState(false);
  const [drop, setDrop] = useState(null); // conta a desconectar
  const [settings, setSettings] = useState(false);
  const [parent, setParent] = useState(null); // filtro vindo do clique numa campanha/conjunto

  const loadAccs = useCallback(async () => {
    if (!orgId) { setAccs({ loading: false, list: [], error: null }); return; }
    const r = await P.api('accounts', {}, orgId);
    setAccs({ loading: false, list: r.accounts || [], error: r.error });
  }, [orgId, P]);
  useEffect(() => { setAccs((a) => ({ ...a, loading: true })); loadAccs(); }, [loadAccs]);
  const refresh = (force) => { setTick((t) => ({ n: t.n + 1, force })); setUpdated(new Date()); };
  // atualiza sozinho a cada minuto enquanto a aba está aberta
  useEffect(() => {
    if (!accs.list.length) return undefined;
    const t = setInterval(() => { if (document.visibilityState === 'visible') refresh(false); }, 60_000);
    return () => clearInterval(t);
  }, [accs.list.length]);
  function choose(p) {
    if (p === platform) return;
    setPlatform(p); setConta('all'); setParent(null); setAdding(false); setTab('dashboard');
    try { localStorage.setItem(PLATFORM_KEY, p); } catch { /* ok */ }
  }

  async function disconnect() {
    const r = await P.api('disconnect', { id: drop.id }, orgId);
    if (r.error) { store.notify('danger', r.error); return; }
    store.notify('success', `Conta "${drop.name}" desconectada.`);
    setDrop(null); setConta('all'); loadAccs(); refresh(true);
  }
  const drill = (level, it) => {
    if (level === 'campaign') { setParent({ type: 'campaign', id: it.id, name: it.name, label: 'Campanha' }); setTab('adset'); }
    else { setParent({ type: 'adset', id: it.id, name: it.name, label: P.level.adset }); setTab('ad'); }
  };
  const TABS = [['dashboard', 'Dashboard', 'layout-dashboard'], ['accounts', 'Contas', 'folder'], ['campaign', P.tabs.campaign, 'megaphone'], ['adset', P.tabs.adset, 'layout-grid'], ['ad', P.tabs.ad, 'smartphone']];
  const Conn = platform === 'google' ? GoogleConnect : Connect;

  return (
    <div className="ka">
      <style>{CSS}</style>
      <PageHeader style={{ marginBottom: 0 }} action={canEdit && orgId && accs.list.length > 0 ? <Button variant="secondary" iconLeft="plus" onClick={() => setAdding((v) => !v)}>Conectar outra conta</Button> : null}>
        Suas campanhas com as vendas que a Kobly rastreou: lucro, ROAS e custo por venda de verdade. Ligue, pause e mude o orçamento daqui.
      </PageHeader>
      <div className="ka-plat" role="tablist" aria-label="Rede de anúncios">
        {[['meta', 'Facebook Ads', <MetaLogo key="m" size={26} />], ['google', 'Google Ads', <GoogleAdsLogo key="g" size={26} />]].map(([id, label, logo]) => (
          <button key={id} type="button" role="tab" aria-selected={platform === id} className={platform === id ? 'on' : ''} onClick={() => choose(id)}>{logo}{label}</button>
        ))}
      </div>
      {picker}
      {!orgId ? <EmptyState icon="users" title="Selecione uma conta" message="Escolha a conta do cliente acima." /> : accs.loading ? <SkeletonTable rows={3} /> : (<>
        {(accs.list.length === 0 || adding) && canEdit && <Conn orgId={orgId} notify={store.notify} onDone={() => { setAdding(false); loadAccs(); refresh(true); }} />}
        {accs.list.length === 0 && !canEdit && <EmptyState icon="target" title="Nenhuma conta de anúncios conectada" message="Peça a um administrador para conectar." />}
        {accs.list.length > 0 && (<>
          <div className="ka-tabs" role="tablist">
            {TABS.map(([id, label, icon]) => <button key={id} role="tab" aria-selected={tab === id} className={`ka-tab${tab === id ? ' on' : ''}`} onClick={() => { setTab(id); if (id === 'campaign' || id === 'dashboard' || id === 'accounts') setParent(null); }}><Icon name={icon} size={15} />{label}{id === 'accounts' && <span className="n">{accs.list.length}</span>}</button>)}
          </div>
          <div className="ka-bar">
            {tab !== 'accounts' && <Select label="Conta de anúncios" value={conta} onChange={(e) => setConta(e.target.value)} style={{ minWidth: 240 }}
              options={[{ value: 'all', label: 'Todas as contas' }, ...accs.list.map((a) => ({ value: a.id, label: `${a.name || a.ad_account_id || a.customer_id}` }))]} />}
            <Select label="Período" value={preset} onChange={(e) => setPreset(e.target.value)} style={{ width: 190 }} options={PERIODS.map(([value, label]) => ({ value, label }))} />
            <Button variant="secondary" iconLeft="refresh-cw" onClick={() => refresh(true)}>Atualizar</Button>
            <span className="ka-upd" title="A tela busca os números de novo sozinha a cada 1 minuto."><i />Atualiza sozinho · {updated.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          {accs.list.some((a) => a.status === 'error') && <Banner tone="danger">{accs.list.find((a) => a.status === 'error').last_error}</Banner>}
          {tab === 'dashboard' && <Dashboard key={platform} P={P} orgId={orgId} conta={conta} preset={preset} tick={tick} onSettings={() => setSettings(true)} />}
          {tab === 'accounts' && <Accounts key={platform} P={P} orgId={orgId} preset={preset} tick={tick} canEdit={canEdit} onDisconnect={setDrop} onOpen={(id) => { setConta(id); setTab('campaign'); }} />}
          {['campaign', 'adset', 'ad'].includes(tab) && <Entities key={`${platform}:${tab}`} P={P} orgId={orgId} level={tab} conta={conta} preset={preset} tick={tick} canEdit={canEdit} notify={store.notify}
            parent={tab === 'campaign' ? null : parent} onDrill={drill} onClearParent={() => setParent(null)} />}
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', lineHeight: 1.6 }}>
            Para a Kobly saber de qual anúncio veio cada venda, use {P.utmWhere}:<br />
            <code style={{ color: 'var(--text-muted)', wordBreak: 'break-all' }}>{P.utm}</code>
          </div>
        </>)}
      </>)}
      <Modal open={!!drop} onClose={() => setDrop(null)} title="Desconectar conta de anúncios?" subtitle={drop ? `"${drop.name}" sai da Kobly. As campanhas continuam rodando normalmente ${P.where}.` : ''}
        footer={<><Button variant="ghost" onClick={() => setDrop(null)}>Cancelar</Button><Button variant="danger" iconLeft="unplug" onClick={disconnect}>Desconectar</Button></>} />
      <SettingsModal open={settings} orgId={orgId} notify={store.notify} onClose={(saved) => { setSettings(false); if (saved) refresh(false); }} />
    </div>
  );
}

export { KoblyMetaAds };
