import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Card, DataTable, IconButton, Input, MetricCard, PageHeader, Select } from '@/ds';
import { EmptyState, ErrorState, SkeletonTable } from '@/lib/ui.jsx';
import { fmtDateTime, useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Facebook Ads ao vivo. Campanhas da conta de anúncios (gasto, cliques, compras e ROAS que a Meta
// reporta) ao lado do que a Kobly mediu para a mesma campanha: leads, compras e vendas recuperadas pelo
// WhatsApp. Casa pelo utm_campaign (nome ou ID da campanha). Atualiza sozinho a cada minuto. KoblyMetaAds

const PRESETS = [['today', 'Hoje'], ['yesterday', 'Ontem'], ['last_7d', 'Últimos 7 dias'], ['last_14d', 'Últimos 14 dias'], ['last_30d', 'Últimos 30 dias']];
const LIVE_MS = 60_000;
const money = (v, cur) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: cur || 'BRL' }));
const int = (v) => Number(v || 0).toLocaleString('pt-BR');
const roas = (v) => (v == null ? '—' : `${v.toFixed(2)}x`);

function Connect({ orgId, notify, onDone }) {
  const [token, setToken] = useState('');
  const [found, setFound] = useState(null);
  const [act, setAct] = useState('');
  const [busy, setBusy] = useState(false);
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
  return (
    <Card title="Conectar conta de anúncios" subtitle="Use um token de usuário do sistema (Gerenciador de Negócios → Configurações → Usuários do sistema → Gerar token) com a permissão ads_read. Ele fica cifrado.">
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
