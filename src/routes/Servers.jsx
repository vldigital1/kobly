import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Card, IconButton, Input, MetricCard, PageHeader } from '@/ds';
import { ErrorState, Modal, SkeletonTable } from '@/lib/ui.jsx';
import { useKobly } from '@/store/store.jsx';
import { askConfirm, askPrompt } from '@/lib/confirm.jsx';

// Kobly — Servidores WhatsApp (só Administrador). Servidores Uazapi que seguram os números conectados por
// QR Code dos clientes. Cada número novo vai para o servidor ativo com mais folga; quando a ocupação total
// passa de 80%, a tela avisa para contratar mais um servidor. KoblyServers

const pct = (u, c) => (c ? Math.round((u / c) * 100) : 0);

function Bar({ used, capacity }) {
  const p = Math.min(100, pct(used, capacity));
  const color = p >= 90 ? 'var(--status-danger-fg)' : p >= 80 ? 'var(--status-warning-fg)' : 'var(--status-success-fg)';
  return (
    <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-sunken)', overflow: 'hidden' }} role="meter" aria-valuenow={used} aria-valuemax={capacity} aria-label="Ocupação">
      <div style={{ width: `${p}%`, height: '100%', background: color }} />
    </div>
  );
}

function KoblyServers() {
  const store = useKobly();
  const [st, setSt] = useState({ loading: true, error: null, servers: [], totals: { capacity: 0, used: 0 } });
  const [add, setAdd] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await KoblyApi.uazapiServers('list');
    setSt({ loading: false, error: r.error, servers: r.servers || [], totals: r.totals || { capacity: 0, used: 0 } });
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    setBusy(true);
    const r = await KoblyApi.uazapiServers('add', { ...add, capacity: Number(add.capacity) });
    setBusy(false);
    if (r.error) { store.notify('danger', r.error); return; }
    store.notify('success', 'Servidor adicionado: os próximos números já podem ir para ele.'); setAdd(null); load();
  }
  async function update(s, patch, msg) {
    const r = await KoblyApi.uazapiServers('update', { id: s.id, ...patch });
    if (r.error) store.notify('danger', r.error); else { store.notify('success', msg); load(); }
  }
  async function remove(s) {
    if (!(await askConfirm(`Remover "${s.label}" da Kobly?`))) return;
    const r = await KoblyApi.uazapiServers('remove', { id: s.id });
    if (r.error) store.notify('danger', r.error); else load();
  }

  if (st.loading) return <SkeletonTable rows={3} />;
  if (st.error) return <ErrorState message={st.error} onRetry={load} />;
  const ocup = pct(st.totals.used, st.totals.capacity);
  const livres = st.totals.capacity - st.totals.used;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader style={{ marginBottom: 0 }} action={<Button variant="primary" iconLeft="plus" onClick={() => setAdd({ label: '', base_url: '', admin_token: '', capacity: 300 })}>Adicionar servidor</Button>}>
        Servidores Uazapi que seguram os números de WhatsApp conectados por QR Code. Cada número novo vai para o servidor ativo com mais folga. Servidor PRO = 300 números.
      </PageHeader>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <MetricCard label="Números conectados por QR" value={`${st.totals.used}`} />
        <MetricCard label="Capacidade total" value={`${st.totals.capacity}`} />
        <MetricCard label="Vagas livres" value={`${Math.max(0, livres)}`} />
        <MetricCard label="Ocupação" value={`${ocup}%`} />
      </div>
      {st.servers.length === 0 && <Banner tone="warning" title="Nenhum servidor configurado.">O WhatsApp por QR Code fica desativado para os clientes até você adicionar um servidor Uazapi.</Banner>}
      {st.servers.length > 0 && ocup >= 80 && <Banner tone={ocup >= 90 ? 'danger' : 'warning'} title={`Ocupação em ${ocup}%.`}>Contrate mais um servidor e adicione aqui antes de lotar: com tudo cheio, clientes não conseguem conectar números novos.</Banner>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {st.servers.map((s) => (
          <Card key={s.id}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ color: 'var(--text-strong)' }}>{s.label}</strong>
                {s.fromEnv && <Badge size="sm" tone="info">Configurado no ambiente</Badge>}
                {s.active ? <Badge size="sm" tone="success" dot>Recebendo números</Badge> : <Badge size="sm" tone="neutral" dot>Pausado</Badge>}
                <span style={{ flex: 1 }} />
                {!s.fromEnv && <Button size="sm" variant="ghost" onClick={() => update(s, { active: !s.active }, s.active ? 'Servidor pausado: não recebe números novos.' : 'Servidor reativado.')}>{s.active ? 'Pausar' : 'Reativar'}</Button>}
                {!s.fromEnv && <IconButton icon="trash-2" size="sm" aria-label="Remover servidor" onClick={() => remove(s)} />}
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{s.base_url} · admintoken {s.token_hint}</div>
              <Bar used={s.used} capacity={s.capacity} />
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>
                <span><strong>{s.used}</strong> de {s.capacity} números ({pct(s.used, s.capacity)}%) · {s.connected} conectados agora</span>
                {!s.fromEnv && (
                  <Button size="sm" variant="secondary" onClick={async () => { const v = (await askPrompt('Novo limite de números deste servidor:', String(s.capacity))); if (v) update(s, { capacity: Number(v) }, 'Limite atualizado.'); }}>Mudar limite</Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
      <Modal open={!!add} onClose={() => setAdd(null)} title="Adicionar servidor Uazapi" subtitle="Use o endereço e o admintoken que a Uazapi entregou na contratação. O admintoken fica cifrado."
        footer={<><Button variant="ghost" onClick={() => setAdd(null)}>Cancelar</Button><Button variant="primary" disabled={busy || !add || !add.base_url || !add.admin_token} onClick={save}>Adicionar</Button></>}>
        {add && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Input label="Nome (opcional)" value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} placeholder="Ex.: PRO 2" />
            <Input label="Endereço do servidor" value={add.base_url} onChange={(e) => setAdd({ ...add, base_url: e.target.value })} placeholder="https://suaempresa.uazapi.com" />
            <Input label="Admintoken" type="password" autoComplete="off" value={add.admin_token} onChange={(e) => setAdd({ ...add, admin_token: e.target.value })} />
            <Input label="Limite de números" type="number" value={add.capacity} onChange={(e) => setAdd({ ...add, capacity: e.target.value })} hint="Servidor LITE = 100 · Servidor PRO = 300" />
          </div>
        )}
      </Modal>
    </div>
  );
}

export { KoblyServers };
