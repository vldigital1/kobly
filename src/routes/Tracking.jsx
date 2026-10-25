import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Card, DataTable, Icon, IconButton, Input, Select } from '@/ds';
import { EmptyState, ErrorState, SkeletonTable } from '@/lib/ui.jsx';
import { fmtDateTime } from '@/lib/workspace.jsx';

// Kobly — Integrações → Trackeamento. De onde vêm os leads (UTM do 1º toque, capturado do postback do checkout)
// e quanto cada origem gera: abandonos, compras aprovadas e vendas recuperadas pelos fluxos.
// UTMify: as vendas que o fluxo gera (cobrança XPag) vão para a UTMify com os UTMs do lead. TrackingPanel

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

// Pixels pelo servidor: o bloco Pixel dos fluxos manda Lead e Compra para Meta, TikTok e Google.
const PIXELS = [
  { id: 'meta', name: 'Pixel da Meta', mono: 'M', color: '#0866FF', idLabel: 'ID do Pixel', idHint: 'Só números (Gerenciador de Eventos → Fontes de dados).', tokenLabel: 'Token da API de Conversões', test: 'Código de teste (opcional)',
    desc: 'API de Conversões: Lead e Purchase direto do servidor, com e-mail e telefone em hash. Melhora a otimização no Facebook e Instagram.' },
  { id: 'tiktok', name: 'Pixel do TikTok', mono: 'T', color: '#111111', idLabel: 'Código do Pixel', idHint: 'Ex.: C4ABCDEF12345678 (Gerenciador de Eventos do TikTok).', tokenLabel: 'Access Token da Events API', test: 'Código de teste (opcional)',
    desc: 'Events API: SubmitForm e CompletePayment pelo servidor, com e-mail e telefone em hash.' },
  { id: 'google', name: 'Google (GA4)', mono: 'G', color: '#EA4335', idLabel: 'ID de métricas', idHint: 'Começa com G- (Administrador → Fluxos de dados).', tokenLabel: 'API secret do Measurement Protocol', test: null,
    desc: 'GA4 Measurement Protocol: generate_lead e purchase com o ID da transação. Importe as conversões no Google Ads pelo GA4.' },
];

function PixelsCard({ orgId, canEdit, notify }) {
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => { const r = await KoblyApi.pixelConfigs('list', {}, orgId); setList(r.pixels || []); }, [orgId]);
  useEffect(() => { load(); }, [load]);
  async function save(p) {
    setBusy('save');
    const r = await KoblyApi.pixelConfigs('save', { provider: p.id, ...form }, orgId);
    setBusy('');
    if (r.error) { notify('danger', r.error); return; }
    notify('success', 'Pixel salvo. Use "Testar" para conferir.'); setForm({}); setOpen(null); load();
  }
  async function test(x) {
    setBusy(x.id);
    const r = await KoblyApi.pixelConfigs('test', { id: x.id }, orgId);
    setBusy('');
    if (r.error) notify('danger', r.error); else notify('success', `Pixel respondeu: ${r.detail}.`);
  }
  async function remove(x) {
    if (!confirm(`Remover "${x.label}"? Blocos Pixel que usam ele param de enviar.`)) return;
    const r = await KoblyApi.pixelConfigs('delete', { id: x.id }, orgId);
    if (r.error) notify('danger', r.error); else load();
  }
  return (
    <Card title="Pixels" subtitle="Usados pelo bloco Pixel dos fluxos: cada lead e cada venda recuperada viram conversão nas plataformas de anúncio.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {PIXELS.map((p) => {
          const mine = list.filter((x) => (x.provider || 'meta') === p.id);
          return (
            <div key={p.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span aria-hidden="true" style={{ width: 34, height: 34, borderRadius: 9, background: p.color, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flex: 'none' }}>{p.mono}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{p.name} {mine.length > 0 && <Badge size="sm" tone="success" dot>{mine.length > 1 ? `${mine.length} pixels` : 'Conectado'}</Badge>}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{p.desc}</div>
                </div>
                {canEdit && <Button size="sm" variant="secondary" iconLeft={open === p.id ? 'x' : 'plus'} onClick={() => { setForm({}); setOpen(open === p.id ? null : p.id); }}>{open === p.id ? 'Fechar' : 'Adicionar'}</Button>}
              </div>
              {mine.map((x) => (
                <div key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingInlineStart: 44 }}>
                  <Icon name="target" size={14} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-sm)', color: 'var(--text-strong)' }}>{x.label} <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{x.pixel_id}{x.test_event_code ? ` · teste ${x.test_event_code}` : ''}</span></span>
                  <Button size="sm" variant="ghost" disabled={busy === x.id} onClick={() => test(x)}>Testar</Button>
                  {canEdit && <IconButton icon="trash-2" size="sm" aria-label="Remover pixel" onClick={() => remove(x)} />}
                </div>
              ))}
              {open === p.id && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, paddingInlineStart: 44 }}>
                  <Input label="Nome (opcional)" value={form.label || ''} onChange={(e) => setForm({ ...form, label: e.target.value })} />
                  <Input label={p.idLabel} value={form.pixel_id || ''} onChange={(e) => setForm({ ...form, pixel_id: e.target.value })} hint={p.idHint} />
                  <Input label={p.tokenLabel} type="password" autoComplete="new-password" value={form.access_token || ''} onChange={(e) => setForm({ ...form, access_token: e.target.value })} />
                  {p.test && <Input label={p.test} value={form.test_event_code || ''} onChange={(e) => setForm({ ...form, test_event_code: e.target.value })} />}
                  <div style={{ display: 'flex', alignItems: 'flex-end' }}><Button variant="primary" disabled={busy === 'save' || !form.pixel_id || !form.access_token} onClick={() => save(p)}>Salvar pixel</Button></div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function TrackingPanel({ orgId, canEdit = true, notify = () => {} }) {
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
      {!orgId ? <EmptyState icon="users" title="Selecione uma conta" message="Escolha a conta do cliente acima." /> : (<>
        <PixelsCard orgId={orgId} canEdit={canEdit} notify={notify} />
        <UtmifyCard orgId={orgId} canEdit={canEdit} notify={notify} />
        <div style={{ fontWeight: 600, color: 'var(--text-strong)', marginTop: 4 }}>De onde vêm os leads</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: -10 }}>Os UTMs (utm_source, utm_campaign…, src, sck) chegam junto com o evento do checkout; o lead guarda o primeiro toque.</div>
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

export { TrackingPanel };
