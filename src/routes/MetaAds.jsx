import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Card, DataTable, IconButton, Input, MetricCard, PageHeader, Select } from '@/ds';
import { EmptyState, ErrorState, SkeletonTable } from '@/lib/ui.jsx';
import { fmtDateTime, useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';
import { MetaLogo } from '@/lib/brandLogos.jsx';

// Kobly — Facebook Ads ao vivo. Campanhas da conta de anúncios (gasto, cliques, compras e ROAS que a Meta
// reporta) ao lado do que a Kobly mediu para a mesma campanha: leads, compras e vendas recuperadas pelo
// WhatsApp. Casa pelo utm_campaign (nome ou ID da campanha). Atualiza sozinho a cada minuto. KoblyMetaAds

const PRESETS = [['today', 'Hoje'], ['yesterday', 'Ontem'], ['last_7d', 'Últimos 7 dias'], ['last_14d', 'Últimos 14 dias'], ['last_30d', 'Últimos 30 dias']];
const LIVE_MS = 60_000;
const money = (v, cur) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: cur || 'BRL' }));
const int = (v) => Number(v || 0).toLocaleString('pt-BR');
const roas = (v) => (v == null ? '—' : `${v.toFixed(2)}x`);

const STEPS = [
  ['Clique em "Conectar com Facebook"', 'Abre uma janelinha do próprio Facebook. Entre com o perfil que administra os seus anúncios.'],
  ['Autorize a Kobly', 'O Facebook pergunta se a Kobly pode ler os resultados das campanhas. A Kobly só lê: não cria, não pausa e não gasta nada.'],
  ['Escolha as contas de anúncios', 'Marque as contas que você quer acompanhar aqui. Pronto: as campanhas aparecem ao vivo.'],
  ['Marque as campanhas (opcional, mas recomendado)', 'No anúncio, em Parâmetros de URL, cole utm_campaign={{campaign.name}}. Assim a Kobly sabe de qual campanha veio cada venda.'],
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
              ['Dê acesso à conta de anúncios', 'Em Atribuir ativos, escolha Contas de anúncios, marque a sua e ligue "Ver desempenho".'],
              ['Gere o token e cole aqui', 'Clique em Gerar token, marque a permissão ads_read e cole o token no campo abaixo.'],
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

function KoblyMetaAds() {
  const store = useKobly();
  const { orgId, picker, canEdit } = useTargetOrg();
  const [accs, setAccs] = useState({ loading: true, list: [], error: null });
  const [sel, setSel] = useState('');
  const [preset, setPreset] = useState('today');
  const [live, setLive] = useState(true);
  const [data, setData] = useState({ loading: false, error: null, d: null });
  const [adding, setAdding] = useState(false);
  const inFlight = useRef(false);

  const loadAccs = useCallback(async () => {
    if (!orgId) { setAccs({ loading: false, list: [], error: null }); return; }
    const r = await KoblyApi.metaAds('accounts', {}, orgId);
    setAccs({ loading: false, list: r.accounts || [], error: r.error });
    setSel((s) => s || ((r.accounts || [])[0] || {}).id || '');
  }, [orgId]);
  useEffect(() => { loadAccs(); }, [loadAccs]);

  const loadInsights = useCallback(async (force = false, quiet = false) => {
    if (!sel || inFlight.current) return;
    inFlight.current = true;
    if (!quiet) setData((s) => ({ ...s, loading: true }));
    const r = await KoblyApi.metaAds('insights', { id: sel, date_preset: preset, force }, orgId);
    inFlight.current = false;
    setData((s) => (r.error ? { loading: false, error: r.error, d: quiet ? s.d : null } : { loading: false, error: null, d: r }));
  }, [sel, preset, orgId]);
  useEffect(() => { loadInsights(); }, [loadInsights]);
  useEffect(() => {
    if (!live || !sel) return undefined;
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadInsights(false, true); }, LIVE_MS);
    return () => clearInterval(t);
  }, [live, sel, loadInsights]);

  async function disconnect() {
    const a = accs.list.find((x) => x.id === sel);
    if (!a || !confirm(`Desconectar a conta "${a.name}"?`)) return;
    const r = await KoblyApi.metaAds('disconnect', { id: a.id }, orgId);
    if (r.error) store.notify('danger', r.error); else { setSel(''); setData({ loading: false, error: null, d: null }); loadAccs(); }
  }

  const d = data.d, cur = d && d.currency;
  const acc = accs.list.find((x) => x.id === sel);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader style={{ marginBottom: 0 }} action={canEdit && orgId && accs.list.length > 0 ? <Button variant="secondary" iconLeft="plus" onClick={() => setAdding((v) => !v)}>Outra conta</Button> : null}>
        Suas campanhas do Facebook e Instagram ao vivo, com o resultado real na Kobly: leads, compras e vendas recuperadas pelo WhatsApp. Para casar, use utm_campaign={'{{campaign.name}}'} nos parâmetros de URL dos anúncios.
      </PageHeader>
      {picker}
      {!orgId ? <EmptyState icon="users" title="Selecione uma conta" message="Escolha a conta do cliente acima." /> : accs.loading ? <SkeletonTable rows={3} /> : (<>
        {(accs.list.length === 0 || adding) && canEdit && <Connect orgId={orgId} notify={store.notify} onDone={(a) => { setAdding(false); setSel(a.id); loadAccs(); }} />}
        {accs.list.length === 0 && !canEdit && <EmptyState icon="target" title="Nenhuma conta de anúncios conectada" message="Peça a um administrador para conectar." />}
        {accs.list.length > 0 && (<>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Select label="Conta de anúncios" value={sel} onChange={(e) => setSel(e.target.value)} style={{ minWidth: 260 }} options={accs.list.map((a) => ({ value: a.id, label: `${a.name || a.ad_account_id} · ${a.ad_account_id}` }))} />
            <Select label="Período" value={preset} onChange={(e) => setPreset(e.target.value)} style={{ width: 190 }} options={PRESETS.map(([value, label]) => ({ value, label }))} />
            <Button variant={live ? 'primary' : 'secondary'} iconLeft={live ? 'radio' : 'pause'} onClick={() => setLive((v) => !v)}>{live ? 'Ao vivo' : 'Pausado'}</Button>
            <IconButton icon="refresh-cw" aria-label="Atualizar agora" onClick={() => loadInsights(true)} />
            {canEdit && <IconButton icon="unplug" aria-label="Desconectar conta" onClick={disconnect} />}
            {d && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', paddingBottom: 10 }}>atualizado {fmtDateTime(d.fetched_at)}</span>}
          </div>
          {acc && acc.status === 'error' && <Banner tone="danger">{acc.last_error}</Banner>}
          {data.error ? <ErrorState message={data.error} onRetry={() => loadInsights(true)} /> : data.loading && !d ? <SkeletonTable /> : d && (<>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <MetricCard label="Gasto" value={money(d.totals.spend, cur)} />
              <MetricCard label="Compras (Meta)" value={int(d.totals.compras_meta)} />
              <MetricCard label="ROAS (Meta)" value={roas(d.totals.spend ? d.totals.receita_meta / d.totals.spend : null)} />
              <MetricCard label="Recuperadas pela Kobly" value={`${int(d.totals.recuperadas)} · ${money(d.totals.receita_recuperada, cur)}`} />
            </div>
            <Card pad={false}>
              <DataTable rowKey="campaign_id" zebra rows={d.campaigns}
                empty={<EmptyState compact icon="target" title="Sem campanhas com entrega no período" message="Troque o período ou confira se há campanhas ativas nesta conta." />}
                columns={[
                  { key: 'campaign_name', header: 'Campanha', render: (c) => (
                    <div><span style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{c.campaign_name}</span>
                      {!c.kobly && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>sem leads com este utm_campaign</div>}</div>
                  ) },
                  { key: 'spend', header: 'Gasto', align: 'end', render: (c) => money(c.spend, cur) },
                  { key: 'clicks', header: 'Cliques', align: 'end', render: (c) => `${int(c.clicks)} · CTR ${c.ctr.toFixed(2)}%` },
                  { key: 'cpc', header: 'CPC', align: 'end', render: (c) => money(c.cpc, cur) },
                  { key: 'compras', header: 'Compras (Meta)', align: 'end', render: (c) => int(c.compras_meta) },
                  { key: 'roas', header: 'ROAS Meta', align: 'end', render: (c) => roas(c.roas_meta) },
                  { key: 'kleads', header: 'Leads Kobly', align: 'end', render: (c) => (c.kobly ? int(c.kobly.leads) : '—') },
                  { key: 'krec', header: 'Recuperadas', align: 'end', render: (c) => (c.kobly ? <span style={{ color: c.kobly.recuperadas ? 'var(--status-success-fg)' : 'var(--text-muted)', fontWeight: 'var(--fw-semibold)' }}>{c.kobly.recuperadas} · {money(c.kobly.receita_recuperada, cur)}</span> : '—') },
                  { key: 'kroas', header: 'ROAS real', align: 'end', render: (c) => (c.roas_kobly == null ? '—' : <Badge tone={c.roas_kobly >= 1 ? 'success' : 'warning'}>{roas(c.roas_kobly)}</Badge>) },
                ]} />
            </Card>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>ROAS real = (compras aprovadas no checkout + vendas recuperadas pelo fluxo, medidas pela Kobly) ÷ gasto. Os números da Meta são estimativas dela e podem levar alguns minutos para atualizar.</div>
          </>)}
        </>)}
      </>)}
    </div>
  );
}

export { KoblyMetaAds };
