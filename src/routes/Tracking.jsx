import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Card, DataTable, Input, PageHeader, Select } from '@/ds';
import { EmptyState, ErrorState, SkeletonTable } from '@/lib/ui.jsx';
import { fmtDateTime, useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Trackeamento. De onde vêm os leads (UTM do 1º toque, capturado do postback do checkout)
// e quanto cada origem gera: abandonos, compras aprovadas e vendas recuperadas pelos fluxos.
// UTMify: as vendas que o fluxo gera (cobrança XPag) vão para a UTMify com os UTMs do lead. KoblyTracking

const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const GROUPS = [['utm_source', 'Origem (utm_source)'], ['utm_campaign', 'Campanha (utm_campaign)'], ['utm_medium', 'Mídia (utm_medium)'], ['utm_content', 'Anúncio (utm_content)'], ['src', 'src'], ['sck', 'sck']];

function UtmifyCard({ orgId, canEdit, notify }) {
  const [st, setSt] = useState({ loading: true, integ: null, sent: [] });
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await KoblyApi.tracking('get', {}, orgId);
    setSt({ loading: false, integ: (r.integrations || []).find((i) => i.provider === 'utmify') || null, sent: r.utmify_30d || [], error: r.error });
  }, [orgId]);
  useEffect(() => { load(); }, [load]);
  async function connect() {
    setBusy(true);
    const r = await KoblyApi.tracking('connect_utmify', { token }, orgId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    setToken(''); notify('success', 'UTMify conectada.'); load();
  }
  async function disconnect() {
    if (!confirm('Desconectar a UTMify? As próximas vendas do fluxo deixam de ser enviadas.')) return;
    const r = await KoblyApi.tracking('disconnect_utmify', {}, orgId);
    if (r.error) notify('danger', r.error); else load();
  }
  const n = (s) => (st.sent.find((x) => x.status === s) || {}).n || 0;
  return (
    <Card title="UTMify" subtitle="Vendas recuperadas pelo WhatsApp aparecem na UTMify com a origem certa do lead.">
      {st.loading ? null : st.integ ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {st.integ.status === 'connected' ? <Badge tone="success" dot>Conectada</Badge> : <Badge tone="danger" dot>Com erro</Badge>}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>credencial {st.integ.token_hint}</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>último envio {fmtDateTime(st.integ.last_sent_at)}</span>
            <span style={{ flex: 1 }} />
            {canEdit && <Button size="sm" variant="ghost" iconLeft="unplug" onClick={disconnect}>Desconectar</Button>}
          </div>
          {st.integ.last_error && <Banner tone="danger">Último erro da UTMify: {st.integ.last_error}</Banner>}
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>Últimos 30 dias: {n('waiting_payment') + n('paid')} pedido(s) enviados · {n('paid')} pago(s){n('erro') ? ` · ${n('erro')} com erro` : ''}{n('ignorado') ? ` · ${n('ignorado')} em moeda não aceita` : ''}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Na UTMify, abra Integrações → Webhooks → Credenciais de API, crie uma credencial e cole aqui. Cada cobrança gerada no fluxo vira um pedido “aguardando pagamento”; quando o pagamento confirma, vira “pago”. Vendas que nascem no seu checkout não são reenviadas (a plataforma já manda).
          </div>
          {canEdit && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Input label="Credencial de API da UTMify" type="password" value={token} onChange={(e) => setToken(e.target.value)} style={{ flex: 1, minWidth: 260 }} autoComplete="off" />
              <Button variant="primary" iconLeft="plug" disabled={busy || token.trim().length < 16} onClick={connect}>Conectar</Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function KoblyTracking() {
  const store = useKobly();
  const { orgId, picker, canEdit } = useTargetOrg();
  const [groupBy, setGroupBy] = useState('utm_source');
  const [dias, setDias] = useState('30');
  const [st, setSt] = useState({ loading: true, error: null, rows: [] });
  const load = useCallback(async () => {
    if (!orgId) { setSt({ loading: false, error: null, rows: [] }); return; }
    setSt((s) => ({ ...s, loading: true }));
    const r = await KoblyApi.tracking('report', { group_by: groupBy, days: Number(dias) }, orgId);
    setSt({ loading: false, error: r.error, rows: r.rows || [] });
  }, [orgId, groupBy, dias]);
  useEffect(() => { load(); }, [load]);

  const total = st.rows.reduce((a, r) => ({ leads: a.leads + r.leads, comUtm: a.comUtm + (r.origem === '(sem UTM)' ? 0 : r.leads) }), { leads: 0, comUtm: 0 });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader style={{ marginBottom: 0 }}>
        De onde vêm os leads e quanto cada origem gera. Os UTMs (utm_source, utm_campaign…, src, sck) chegam junto com o evento do checkout; o lead guarda o primeiro toque.
      </PageHeader>
      {picker}
      {!orgId ? <EmptyState icon="users" title="Selecione uma conta" message="Escolha a conta do cliente acima." /> : (<>
        <UtmifyCard orgId={orgId} canEdit={canEdit} notify={store.notify} />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Select label="Agrupar por" value={groupBy} onChange={(e) => setGroupBy(e.target.value)} options={GROUPS.map(([value, label]) => ({ value, label }))} style={{ width: 240 }} />
          <Select label="Período" value={dias} onChange={(e) => setDias(e.target.value)} options={[{ value: '7', label: 'Últimos 7 dias' }, { value: '30', label: 'Últimos 30 dias' }, { value: '90', label: 'Últimos 90 dias' }]} style={{ width: 180 }} />
          {total.leads > 0 && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', paddingBottom: 10 }}>{Math.round((total.comUtm / total.leads) * 100)}% dos leads com UTM</span>}
        </div>
        {st.error ? <ErrorState message={st.error} onRetry={load} /> : st.loading ? <SkeletonTable /> : (
          <Card pad={false}>
            <DataTable rowKey="origem" zebra rows={st.rows}
              empty={<EmptyState compact icon="chart-line" title="Sem leads no período" message="Quando o checkout mandar eventos com UTM, a origem aparece aqui." />}
              columns={[
                { key: 'origem', header: GROUPS.find(([v]) => v === groupBy)[1], render: (r) => <span style={{ fontWeight: 'var(--fw-semibold)', color: r.origem === '(sem UTM)' ? 'var(--text-muted)' : 'var(--text-strong)' }}>{r.origem}</span> },
                { key: 'leads', header: 'Leads', align: 'end', render: (r) => r.leads },
                { key: 'abandonos', header: 'Abandonos / Pix', align: 'end', render: (r) => r.abandonos },
                { key: 'aprovadas', header: 'Compras aprovadas', align: 'end', render: (r) => r.aprovadas },
                { key: 'conv', header: 'Conversão', align: 'end', render: (r) => (r.leads ? `${Math.round((r.aprovadas / r.leads) * 100)}%` : '—') },
                { key: 'rec', header: 'Recuperadas (fluxo)', align: 'end', render: (r) => <span style={{ color: r.recuperadas ? 'var(--status-success-fg)' : 'var(--text-muted)', fontWeight: 'var(--fw-semibold)' }}>{r.recuperadas} · {money(r.receita_recuperada)}</span> },
                { key: 'receita', header: 'Receita aprovada', align: 'end', render: (r) => money(r.receita_checkout) },
              ]} />
          </Card>
        )}
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Valores somados como vieram do checkout (sem conversão de moeda).</div>
      </>)}
    </div>
  );
}

export { KoblyTracking };
