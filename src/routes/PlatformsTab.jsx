import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Icon, IconButton, Input } from '@/ds';
import { Drawer } from '@/lib/ui.jsx';
import { GATEWAYS, SALES_PLATFORMS } from '@/lib/platforms.js';
import { fmtDateTime } from '@/lib/workspace.jsx';

// Kobly — Integrações → Plataformas. Um cartão (com a marca) por plataforma de venda e por gateway;
// cada um abre a página dele: o que a Kobly faz com ela, como conectar e as conexões ativas.
// Plataformas de venda: pela API (Kiwify, Cakto — a Kobly cria o webhook) ou pela URL (Hotmart, Kirvano,
// PerfectPay, Payt — com o passo a passo e a chave de validação). Gateways: conta usada no bloco Cobrança. KoblyPlatformsTab

export function PlatformLogo({ p, size = 40 }) {
  const [broken, setBroken] = useState(false);
  if (p.logo && !broken) return <img src={p.logo} alt="" width={size} height={size} onError={() => setBroken(true)} style={{ borderRadius: 10, objectFit: 'contain', background: '#fff', flex: 'none' }} />;
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: 10, background: p.color, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 'var(--fw-bold)', fontSize: size * (p.mono.length > 1 ? 0.34 : 0.45), letterSpacing: '-0.02em', flex: 'none' }}>{p.mono}</span>
  );
}

function Card({ p, count, onOpen }) {
  return (
    <button type="button" onClick={onOpen} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', textAlign: 'start', padding: 14, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
      background: 'var(--surface-card)', cursor: 'pointer', fontFamily: 'var(--font-sans)', minHeight: 92 }} className="kbly-lift">
      <PlatformLogo p={p} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{p.name}</span>
          {count > 0 && <Badge size="sm" tone="success" dot>{count > 1 ? `${count} conexões` : 'Conectado'}</Badge>}
        </span>
        <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>{p.desc}</span>
      </span>
      <Icon name="chevron-right" size={16} style={{ color: 'var(--text-subtle)', marginTop: 4 }} />
    </button>
  );
}

const copy = async (text, notify) => { try { await navigator.clipboard.writeText(text); notify('success', 'Copiado.'); } catch { notify('info', text); } };

function SalesPage({ p, conns, empresaId, notify, reload }) {
  const [form, setForm] = useState({});
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  async function run(action, extra, msg) {
    setBusy(true);
    const r = await KoblyApi.platforms(action, { platform: p.id, ...extra }, empresaId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return null; }
    if (msg) notify('success', msg);
    reload(); return r;
  }
  async function disconnect(c) {
    if (!confirm(`Desconectar esta ${p.name}? A URL deixa de aceitar avisos${c.via_api ? ' e a Kobly tenta remover o webhook da sua conta' : ''}.`)) return;
    const r = await run('disconnect', { id: c.id });
    if (r && r.remote_removed === false) notify('warning', `Desconectado na Kobly. Remova o webhook "Kobly" também no painel da ${p.name}.`);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>{p.desc}</div>
      {conns.map((c) => (
        <div key={c.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ color: 'var(--text-strong)' }}>{c.label}</strong>
            {c.via_api ? <Badge size="sm" tone="info">Conectada pela API</Badge> : c.tem_chave ? <Badge size="sm" tone="success">Chave conferida</Badge> : <Badge size="sm" tone="warning">Sem chave de validação</Badge>}
            <span style={{ flex: 1 }} />
            <IconButton icon="unplug" size="sm" aria-label="Desconectar" onClick={() => disconnect(c)} />
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <code style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>{c.url}</code>
            <Button size="sm" variant="secondary" iconLeft="copy" onClick={() => copy(c.url, notify)}>Copiar URL</Button>
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {c.last_event_at ? `Último aviso ${fmtDateTime(c.last_event_at)} · ${c.events_count} aviso(s)` : 'Ainda não chegou nenhum aviso. Envie um teste pelo painel da plataforma.'}
          </div>
          {!c.via_api && p.secretLabel && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <Input label={c.tem_chave ? `Trocar ${p.secretLabel}` : p.secretLabel} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} style={{ flex: 1 }} />
              <Button size="sm" variant="secondary" disabled={busy || !secret.trim()} onClick={async () => { if (await run('update_secret', { id: c.id, secret }, 'Chave salva.')) setSecret(''); }}>Salvar</Button>
            </div>
          )}
        </div>
      ))}

      <div>
        <div style={{ fontWeight: 600, color: 'var(--text-strong)', marginBottom: 8 }}>{conns.length ? 'Conectar outra conta' : 'Como conectar'}</div>
        <ol style={{ margin: 0, paddingInlineStart: 18, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>
          {p.steps.map((s) => <li key={s}>{s}</li>)}
        </ol>
      </div>

      {p.mode === 'api' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {p.fields.map(([k, label, secretField]) => (
            <Input key={k} label={label} type={secretField ? 'password' : 'text'} autoComplete="off" value={form[k] || ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          ))}
          <Button variant="primary" iconLeft="plug" disabled={busy || p.fields.some(([k]) => !(form[k] || '').trim())}
            onClick={async () => { if (await run('connect_api', form, `${p.name} conectada: webhook criado na sua conta.`)) setForm({}); }}>
            {busy ? 'Conectando…' : `Conectar ${p.name} e criar webhook`}
          </Button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {p.secretLabel && <Input label={`${p.secretLabel} (opcional, recomendado)`} type="password" autoComplete="off" value={form.secret || ''} onChange={(e) => setForm({ ...form, secret: e.target.value })} hint={p.secretHint} />}
          <Button variant="primary" iconLeft="link" disabled={busy} onClick={async () => { if (await run('connect_manual', { secret: form.secret }, 'URL gerada: copie e cole no painel da plataforma.')) setForm({}); }}>
            Gerar URL da {p.name}
          </Button>
        </div>
      )}
      <a href={p.docs} target="_blank" rel="noreferrer" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Documentação da {p.name} ↗</a>
    </div>
  );
}

function GatewayPage({ g, accounts, empresaId, notify, reload }) {
  const [form, setForm] = useState({ label: '', client_id: '', client_secret: '', sandbox: false });
  const [busy, setBusy] = useState(false);
  async function connect() {
    setBusy(true);
    const r = await KoblyApi.paymentIntegrations('connect', { provider: g.id, ...form }, empresaId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', `${g.name} conectado. Já dá para usar no bloco Cobrança dos fluxos.`);
    setForm({ label: '', client_id: '', client_secret: '', sandbox: false }); reload();
  }
  async function remove(i) {
    if (!confirm(`Desconectar "${i.label}"? Fluxos que usam esta conta passam a sair por "erro" no bloco Cobrança.`)) return;
    const r = await KoblyApi.paymentIntegrations('disconnect', { id: i.id }, empresaId);
    if (r.error) notify('danger', r.error); else reload();
  }
  async function webhook(i) {
    const r = await KoblyApi.paymentIntegrations('webhook_url', { id: i.id }, empresaId);
    if (r.error) notify('danger', r.error); else copy(r.url, notify);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>Cobra dentro do WhatsApp pelo bloco Cobrança: {g.desc} O dinheiro cai direto na sua conta {g.name}.</div>
      {accounts.map((i) => (
        <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
          <div style={{ flex: 1, minWidth: 0, color: 'var(--text-strong)', fontWeight: 600 }}>{i.label}</div>
          {i.sandbox && <Badge size="sm" tone="warning">Sandbox</Badge>}
          <Badge size="sm" tone={i.status === 'connected' ? 'success' : 'danger'} dot>{i.status === 'connected' ? 'Conectada' : 'Erro'}</Badge>
          {g.id === 'woovi' && <Button size="sm" variant="secondary" iconLeft="copy" onClick={() => webhook(i)}>Webhook</Button>}
          <IconButton icon="trash-2" size="sm" aria-label="Desconectar" onClick={() => remove(i)} />
        </div>
      ))}
      <Input label="Nome (opcional)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Principal, México…" />
      {g.id_label && <Input label={g.id_label} value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} autoComplete="off" />}
      <Input label={g.secret} type="password" value={form.client_secret} onChange={(e) => setForm({ ...form, client_secret: e.target.value })} autoComplete="new-password" hint={`Onde pegar: ${g.where}`} />
      {g.sandbox && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>
          <input type="checkbox" checked={form.sandbox} onChange={(e) => setForm({ ...form, sandbox: e.target.checked })} /> Chaves de sandbox (teste)
        </label>
      )}
      <Button variant="primary" iconLeft="plug" disabled={busy || (g.id_label && !form.client_id.trim()) || !form.client_secret.trim()} onClick={connect}>{busy ? 'Conferindo…' : `Conectar ${g.name}`}</Button>
    </div>
  );
}

function KoblyPlatformsTab({ empresaId, notify = () => {} }) {
  const [st, setSt] = useState({ loading: true, conns: [], gws: [], error: null });
  const [open, setOpen] = useState(null); // { kind: 'sales'|'gateway', p }
  const load = useCallback(async () => {
    const [a, b] = await Promise.all([KoblyApi.platforms('list', {}, empresaId), KoblyApi.paymentIntegrations('list', {}, empresaId)]);
    setSt({ loading: false, conns: a.connections || [], gws: b.integrations || [], error: a.error || b.error });
  }, [empresaId]);
  useEffect(() => { load(); }, [load]);
  const connsOf = (id) => st.conns.filter((c) => c.platform === id);
  const gwsOf = (id) => st.gws.filter((g) => g.provider === id);
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {st.error && <Banner tone="danger">{st.error}</Banner>}
      <section>
        <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>Plataformas de venda</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '2px 0 10px' }}>De onde chegam Pix gerado, carrinho abandonado e vendas que disparam os fluxos.</div>
        <div style={grid}>{SALES_PLATFORMS.map((p) => <Card key={p.id} p={p} count={connsOf(p.id).length} onOpen={() => setOpen({ kind: 'sales', p })} />)}</div>
      </section>
      <section>
        <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>Gateways de pagamento</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '2px 0 10px' }}>Contas usadas pelo bloco Cobrança para gerar Pix, SPEI e outros métodos dentro da conversa.</div>
        <div style={grid}>{GATEWAYS.map((g) => <Card key={g.id} p={g} count={gwsOf(g.id).length} onOpen={() => setOpen({ kind: 'gateway', p: g })} />)}</div>
      </section>

      <Drawer open={!!open} onClose={() => setOpen(null)} width={520}
        title={open ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}><PlatformLogo p={open.p} size={30} />{open.p.name}</span> : ''}
        subtitle={open ? (open.kind === 'gateway' ? 'Gateway de pagamento' : open.p.mode === 'api' ? 'Plataforma de venda · conexão pela API' : 'Plataforma de venda · conexão pela URL') : ''}>
        {open && open.kind === 'sales' && <SalesPage p={open.p} conns={connsOf(open.p.id)} empresaId={empresaId} notify={notify} reload={load} />}
        {open && open.kind === 'gateway' && <GatewayPage g={open.p} accounts={gwsOf(open.p.id)} empresaId={empresaId} notify={notify} reload={load} />}
      </Drawer>
    </div>
  );
}

export { KoblyPlatformsTab };
