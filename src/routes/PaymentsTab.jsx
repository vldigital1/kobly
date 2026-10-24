import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Card, Icon, IconButton, Input } from '@/ds';

// Kobly — Integrações → Pagamentos e Pixel. Conta do gateway (XPag) usada pelo bloco "Cobrança" dos
// fluxos e Pixel da Meta (API de Conversões). Segredos só vão para o servidor (cifrados); nunca voltam
// para a tela. KoblyPaymentsTab

function Section({ icon, title, children, desc }) {
  return (
    <Card style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span style={{ color: 'var(--accent)', display: 'flex', marginTop: 2 }}><Icon name={icon} size={18} /></span>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{title}</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 2 }}>{desc}</div>
        </div>
      </div>
      {children}
    </Card>
  );
}
const Row = ({ children }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{children}</div>
);

function KoblyPaymentsTab({ empresaId, notify = () => {} }) {
  const [gw, setGw] = useState({ loading: true, list: [], error: null });
  const [px, setPx] = useState({ loading: true, list: [], error: null });
  const [gwForm, setGwForm] = useState({ label: '', client_id: '', client_secret: '' });
  const [pxForm, setPxForm] = useState({ label: '', pixel_id: '', access_token: '', test_event_code: '' });
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const [g, p] = await Promise.all([KoblyApi.paymentIntegrations('list', {}, empresaId), KoblyApi.pixelConfigs('list', {}, empresaId)]);
    setGw({ loading: false, list: g.integrations || [], error: g.error });
    setPx({ loading: false, list: p.pixels || [], error: p.error });
  }, [empresaId]);
  useEffect(() => { load(); }, [load]);

  async function connectGw() {
    setBusy('gw');
    const r = await KoblyApi.paymentIntegrations('connect', { provider: 'xpag', ...gwForm }, empresaId);
    setBusy('');
    if (r.error) { notify('danger', r.error); return; }
    notify('success', 'Conta XPag conectada. Já dá para usar no bloco "Cobrança" dos fluxos.');
    setGwForm({ label: '', client_id: '', client_secret: '' }); load();
  }
  async function removeGw(i) {
    if (!confirm(`Desconectar "${i.label}"? Fluxos que usam esta conta passam a sair por "erro" no bloco de cobrança.`)) return;
    const r = await KoblyApi.paymentIntegrations('disconnect', { id: i.id }, empresaId);
    if (r.error) notify('danger', r.error); else load();
  }
  async function savePx() {
    setBusy('px');
    const r = await KoblyApi.pixelConfigs('save', pxForm, empresaId);
    setBusy('');
    if (r.error) { notify('danger', r.error); return; }
    notify('success', 'Pixel salvo. Use "Testar" para conferir o token.');
    setPxForm({ label: '', pixel_id: '', access_token: '', test_event_code: '' }); load();
  }
  async function testPx(p) {
    setBusy(p.id);
    const r = await KoblyApi.pixelConfigs('test', { id: p.id }, empresaId);
    setBusy('');
    if (r.error) notify('danger', `Pixel: ${r.error}`); else notify('success', `Pixel respondeu (${r.detail}). Veja em Gerenciador de Eventos → Testar eventos.`);
  }
  async function removePx(p) {
    if (!confirm(`Remover o Pixel "${p.label}"?`)) return;
    const r = await KoblyApi.pixelConfigs('delete', { id: p.id }, empresaId);
    if (r.error) notify('danger', r.error); else load();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Section icon="credit-card" title="Gateway de pagamento (XPag)" desc="Cobre dentro do WhatsApp com o método local de cada país: Pix (BRL), SPEI e OXXO (MXN), Nequi e Bre-B (COP), transferência (ARS) e Chile (CLP). O dinheiro cai na SUA conta XPag.">
        {gw.error && <Banner tone="danger">{gw.error}</Banner>}
        {gw.list.map((i) => (
          <Row key={i.id}>
            <Icon name="credit-card" size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{i.label}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Client ID {i.client_id}</div>
            </div>
            {i.sandbox && <Badge tone="warning">Sandbox</Badge>}
            <Badge tone={i.status === 'connected' ? 'success' : 'danger'} dot>{i.status === 'connected' ? 'Conectada' : 'Erro'}</Badge>
            <IconButton icon="trash-2" size="sm" aria-label="Desconectar" onClick={() => removeGw(i)} />
          </Row>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <Input label="Nome (opcional)" value={gwForm.label} onChange={(e) => setGwForm({ ...gwForm, label: e.target.value })} placeholder="Principal, México..." />
          <Input label="Client ID" value={gwForm.client_id} onChange={(e) => setGwForm({ ...gwForm, client_id: e.target.value })} />
          <Input label="Client Secret" type="password" value={gwForm.client_secret} onChange={(e) => setGwForm({ ...gwForm, client_secret: e.target.value })} autoComplete="new-password" />
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button onClick={connectGw} loading={busy === 'gw'} disabled={!gwForm.client_id || !gwForm.client_secret} iconLeft="plug">Conectar XPag</Button>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Gere as chaves no painel da XPag em Integrações → API. A Kobly confere a chave antes de salvar.</span>
        </div>
      </Section>

      <Section icon="target" title="Pixel da Meta (API de Conversões)" desc="O bloco Pixel dos fluxos envia Lead e Purchase direto do servidor para a Meta, com e-mail e telefone em hash. Melhora o ROAS e a otimização dos anúncios.">
        {px.error && <Banner tone="danger">{px.error}</Banner>}
        {px.list.map((p) => (
          <Row key={p.id}>
            <Icon name="target" size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{p.label}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Pixel {p.pixel_id}{p.test_event_code ? ` · teste ${p.test_event_code}` : ''}</div>
            </div>
            <Button size="sm" variant="secondary" loading={busy === p.id} onClick={() => testPx(p)}>Testar</Button>
            <IconButton icon="trash-2" size="sm" aria-label="Remover" onClick={() => removePx(p)} />
          </Row>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <Input label="Nome (opcional)" value={pxForm.label} onChange={(e) => setPxForm({ ...pxForm, label: e.target.value })} />
          <Input label="ID do Pixel" value={pxForm.pixel_id} onChange={(e) => setPxForm({ ...pxForm, pixel_id: e.target.value.replace(/\D/g, '') })} />
          <Input label="Token da API de Conversões" type="password" value={pxForm.access_token} onChange={(e) => setPxForm({ ...pxForm, access_token: e.target.value })} autoComplete="new-password" />
          <Input label="Código de teste (opcional)" value={pxForm.test_event_code} onChange={(e) => setPxForm({ ...pxForm, test_event_code: e.target.value })} placeholder="TEST12345" />
        </div>
        <div><Button onClick={savePx} loading={busy === 'px'} disabled={!pxForm.pixel_id || !pxForm.access_token} iconLeft="plus">Salvar Pixel</Button></div>
      </Section>
    </div>
  );
}
export { KoblyPaymentsTab };
