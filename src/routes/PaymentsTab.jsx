import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Card, Icon, IconButton, Input, Select } from '@/ds';

// Gateways: o que cada um cobra e onde pegar a credencial. Os de Pix (Mercado Pago, Woovi) só usam um token.
const GATEWAYS = {
  xpag: { label: 'XPag', desc: 'Pix (BRL), SPEI e OXXO (MXN), Nequi e Bre-B (COP), transferência (ARS) e Chile (CLP).', id: 'Client ID', secret: 'Client Secret', where: 'Painel da XPag → Integrações → API.' },
  mercadopago: { label: 'Mercado Pago', desc: 'Pix (BRL).', secret: 'Access Token', where: 'Mercado Pago Developers → Suas integrações → Credenciais de produção (Access Token). Credencial de teste começa com TEST-.' },
  pushinpay: { label: 'PushinPay', desc: 'Pix (BRL), a partir de R$ 0,50.', secret: 'Token da API', where: 'Painel da PushinPay → Configurações → API: gere o token (a liberação da API pode precisar de pedido ao suporte).' },
  syncpay: { label: 'SyncPay', desc: 'Pix (BRL), a partir de R$ 1,00.', id: 'Client ID', secret: 'Client Secret', where: 'Painel da SyncPay → Credenciais de API: o Client Secret aparece uma vez só, na criação.' },
  zenith: { label: 'Zenith', desc: 'SPEI (MXN) e outros métodos locais.', id: 'Chave pública (X-API-Key)', secret: 'Chave secreta (X-API-Secret)', where: 'Painel da Zenith → Integrações (para testar, conecte pela aba Plataformas marcando sandbox).' },
  woovi: { label: 'Woovi (OpenPix)', desc: 'Pix (BRL).', secret: 'AppID', where: 'Painel da Woovi → API/Plugins → Nova API: copie o AppID. Depois cadastre o webhook (Cobrança paga) com o endereço que aparece aqui.' },
};

// Kobly — Integrações → Pagamentos e Pixel. Conta do gateway (XPag, Mercado Pago, Woovi) usada pelo bloco "Cobrança" dos
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
  const [tg, setTg] = useState({ loading: true, list: [], error: null });
  const [tgForm, setTgForm] = useState({ label: '', bot_token: '', chat_id: '' });
  const [gwForm, setGwForm] = useState({ provider: 'xpag', label: '', client_id: '', client_secret: '' });
  const gwInfo = GATEWAYS[gwForm.provider];
  const [pxForm, setPxForm] = useState({ label: '', pixel_id: '', access_token: '', test_event_code: '' });
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const [g, p, t] = await Promise.all([KoblyApi.paymentIntegrations('list', {}, empresaId), KoblyApi.pixelConfigs('list', {}, empresaId), KoblyApi.notifyChannels('list', {}, empresaId)]);
    setGw({ loading: false, list: g.integrations || [], error: g.error });
    setPx({ loading: false, list: p.pixels || [], error: p.error });
    setTg({ loading: false, list: t.channels || [], error: t.error });
  }, [empresaId]);
  useEffect(() => { load(); }, [load]);

  async function connectGw() {
    setBusy('gw');
    const r = await KoblyApi.paymentIntegrations('connect', gwForm, empresaId);
    setBusy('');
    if (r.error) { notify('danger', r.error); return; }
    notify('success', `Conta ${gwInfo.label} conectada. Já dá para usar no bloco "Cobrança" dos fluxos.`);
    setGwForm({ provider: gwForm.provider, label: '', client_id: '', client_secret: '' }); load();
  }
  async function copyWebhook(i) {
    const r = await KoblyApi.paymentIntegrations('webhook_url', { id: i.id }, empresaId);
    if (r.error) { notify('danger', r.error); return; }
    try { await navigator.clipboard.writeText(r.url); notify('success', 'Endereço do webhook copiado.'); } catch { notify('info', r.url); }
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
  async function saveTg() {
    setBusy('tg');
    const r = await KoblyApi.notifyChannels('save', tgForm, empresaId);
    setBusy('');
    if (r.error) { notify('danger', r.error); return; }
    notify('success', 'Bot conectado. Use "Testar" para receber uma mensagem.');
    setTgForm({ label: '', bot_token: '', chat_id: '' }); load();
  }
  async function testTg(c) {
    setBusy(c.id);
    const r = await KoblyApi.notifyChannels('test', { id: c.id }, empresaId);
    setBusy('');
    if (r.error) notify('danger', `Telegram: ${r.error}`); else notify('success', 'Mensagem de teste enviada no Telegram.');
  }
  async function removeTg(c) {
    if (!confirm(`Remover o canal "${c.label}"? Blocos de alerta que usam este canal deixam de avisar.`)) return;
    const r = await KoblyApi.notifyChannels('delete', { id: c.id }, empresaId);
    if (r.error) notify('danger', r.error); else load();
  }
  async function removePx(p) {
    if (!confirm(`Remover o Pixel "${p.label}"?`)) return;
    const r = await KoblyApi.pixelConfigs('delete', { id: p.id }, empresaId);
    if (r.error) notify('danger', r.error); else load();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Section icon="credit-card" title="Gateway de pagamento" desc="Cobre dentro do WhatsApp pelo bloco Cobrança. O dinheiro cai direto na SUA conta do gateway.">
        {gw.error && <Banner tone="danger">{gw.error}</Banner>}
        {gw.list.map((i) => (
          <Row key={i.id}>
            <Icon name="credit-card" size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{(GATEWAYS[i.provider] || {}).label || i.provider} · {i.label}</div>
              {i.provider === 'xpag' && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Client ID {i.client_id}</div>}
            </div>
            {i.sandbox && <Badge tone="warning">Sandbox</Badge>}
            {i.provider === 'woovi' && <Button size="sm" variant="secondary" iconLeft="copy" onClick={() => copyWebhook(i)}>Copiar webhook</Button>}
            <Badge tone={i.status === 'connected' ? 'success' : 'danger'} dot>{i.status === 'connected' ? 'Conectada' : 'Erro'}</Badge>
            <IconButton icon="trash-2" size="sm" aria-label="Desconectar" onClick={() => removeGw(i)} />
          </Row>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <Select label="Gateway" value={gwForm.provider} onChange={(e) => setGwForm({ ...gwForm, provider: e.target.value })} options={Object.entries(GATEWAYS).map(([value, g]) => ({ value, label: g.label }))} />
          <Input label="Nome (opcional)" value={gwForm.label} onChange={(e) => setGwForm({ ...gwForm, label: e.target.value })} placeholder="Principal, México..." />
          {gwInfo.id && <Input label={gwInfo.id} value={gwForm.client_id} onChange={(e) => setGwForm({ ...gwForm, client_id: e.target.value })} />}
          <Input label={gwInfo.secret} type="password" value={gwForm.client_secret} onChange={(e) => setGwForm({ ...gwForm, client_secret: e.target.value })} autoComplete="new-password" />
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{gwInfo.label} cobra: {gwInfo.desc}</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button onClick={connectGw} loading={busy === 'gw'} disabled={(gwInfo.id && !gwForm.client_id) || !gwForm.client_secret} iconLeft="plug">Conectar {gwInfo.label}</Button>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>{gwInfo.where} A Kobly confere a credencial antes de salvar.</span>
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

      <Section icon="bell" title="Alertas no Telegram" desc="O bloco Alerta dos fluxos avisa sua equipe: venda aprovada, erro de pagamento, lead pedindo atendimento humano.">
        {tg.error && <Banner tone="danger">{tg.error}</Banner>}
        {tg.list.map((c) => (
          <Row key={c.id}>
            <Icon name="bell" size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{c.label}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>chat {c.default_chat_id}</div>
            </div>
            <Button size="sm" variant="secondary" loading={busy === c.id} onClick={() => testTg(c)}>Testar</Button>
            <IconButton icon="trash-2" size="sm" aria-label="Remover" onClick={() => removeTg(c)} />
          </Row>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <Input label="Nome (opcional)" value={tgForm.label} onChange={(e) => setTgForm({ ...tgForm, label: e.target.value })} placeholder="Equipe de vendas" />
          <Input label="Token do bot" type="password" value={tgForm.bot_token} onChange={(e) => setTgForm({ ...tgForm, bot_token: e.target.value })} autoComplete="new-password" />
          <Input label="ID do chat ou grupo" value={tgForm.chat_id} onChange={(e) => setTgForm({ ...tgForm, chat_id: e.target.value })} placeholder="-1001234567890" />
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button onClick={saveTg} loading={busy === 'tg'} disabled={!tgForm.bot_token || !tgForm.chat_id} iconLeft="plus">Conectar bot</Button>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Crie o bot com o @BotFather, adicione-o ao grupo e use o ID do grupo (começa com -100).</span>
        </div>
      </Section>
    </div>
  );
}
export { KoblyPaymentsTab };
