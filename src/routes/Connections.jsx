import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Icon, IconButton, Input } from '@/ds';
import { Drawer, Modal } from '@/lib/ui.jsx';
import { fmtDateTime } from '@/lib/workspace.jsx';
import { WhatsappMetaTab } from '@/routes/WhatsappMeta.jsx';

// Kobly — Integrações → Conexões. Todos os canais da conta num lugar: WhatsApp comum (QR Code, pela Uazapi),
// API oficial da Meta e bots do Telegram (alertas da equipe). "Nova conexão" escolhe o tipo; o QR Code
// atualiza sozinho até o número conectar. KoblyConnections

const KINDS = [
  { id: 'qr', label: 'WhatsApp comum', icon: 'qr-code', color: '#25D366', desc: 'Conecte lendo um QR Code. Funciona com qualquer número.' },
  { id: 'oficial', label: 'API Oficial da Meta', icon: 'badge-check', color: '#128C7E', desc: 'Número verificado, modelos aprovados e sem risco de bloqueio. Alguns recursos dependem da janela de 24 h.' },
  { id: 'telegram', label: 'Telegram', icon: 'send', color: '#229ED9', desc: 'Bot que avisa sua equipe: venda aprovada, erro de pagamento, lead pedindo humano.' },
  { id: 'instagram', label: 'Instagram', icon: 'instagram', color: '#E1306C', desc: 'Atendimento pelo Direct.', soon: true },
  { id: 'messenger', label: 'Messenger', icon: 'message-circle', color: '#0084FF', desc: 'Atendimento nas páginas do Facebook.', soon: true },
];
const FILTERS = [['todos', 'Todos os canais'], ['qr', 'WhatsApp'], ['oficial', 'WhatsApp Oficial'], ['telegram', 'Telegram']];
const STATUS = { connected: ['success', 'Conectado'], connecting: ['warning', 'Aguardando QR Code'], disconnected: ['danger', 'Desconectado'], hibernated: ['neutral', 'Em espera'] };
const qrSrc = (q) => (!q ? null : /^data:image\//.test(q) ? q : /^https?:\/\//.test(q) ? q : `data:image/png;base64,${q}`);
const fmtPhone = (p) => (p ? `+${p}` : '');

function KindIcon({ k, size = 36 }) {
  return <span style={{ width: size, height: size, borderRadius: 10, background: k.color, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><Icon name={k.icon} size={size * 0.5} /></span>;
}

// QR Code da Uazapi: consulta o status a cada 3 s (o QR muda sozinho) até conectar
function QrPanel({ id, empresaId, initialQr, onConnected, notify }) {
  const [st, setSt] = useState({ status: 'connecting', qrcode: initialQr || null });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const tick = async () => {
      const r = await KoblyApi.uazapi('status', { id }, empresaId);
      if (!alive.current) return;
      if (r.error) { setSt((s) => ({ ...s, error: r.error })); return; }
      setSt({ status: r.status, qrcode: r.qrcode || null, phone: r.phone });
      if (r.status === 'connected') { notify('success', 'WhatsApp conectado.'); onConnected(); }
    };
    const t = setInterval(tick, 3000);
    tick();
    return () => { alive.current = false; clearInterval(t); };
  }, [id, empresaId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function novoQr() {
    const r = await KoblyApi.uazapi('qrcode', { id }, empresaId);
    if (r.error) notify('danger', r.error); else setSt((s) => ({ ...s, qrcode: r.qrcode || s.qrcode }));
  }
  const src = qrSrc(st.qrcode);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      {st.status === 'connected' ? <Banner tone="success" title="Conectado!">Número {fmtPhone(st.phone)} pronto para os fluxos e os Chats ao vivo.</Banner> : (<>
        <div style={{ width: 264, height: 264, background: '#fff', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
          {src ? <img src={src} alt="QR Code para conectar o WhatsApp" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span style={{ color: '#555', fontSize: 13 }}>Gerando QR Code…</span>}
        </div>
        <ol style={{ margin: 0, paddingInlineStart: 18, fontSize: 'var(--text-sm)', color: 'var(--text-body)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <li>No celular, abra o WhatsApp → Mais opções (⋮) ou Configurações → <strong>Aparelhos conectados</strong>.</li>
          <li>Toque em <strong>Conectar um aparelho</strong> e aponte para este QR Code.</li>
          <li>Esta tela confirma sozinha quando conectar.</li>
        </ol>
        <Button size="sm" variant="ghost" iconLeft="refresh-cw" onClick={novoQr}>Gerar outro QR Code</Button>
      </>)}
      {st.error && <Banner tone="danger">{st.error}</Banner>}
    </div>
  );
}

function KoblyConnections({ empresaId, notify = () => {} }) {
  const [st, setSt] = useState({ loading: true, uaz: [], uazOn: false, oficial: null, tg: [], error: null });
  const [filter, setFilter] = useState('todos');
  const [q, setQ] = useState('');
  const [picker, setPicker] = useState(false);
  const [flow, setFlow] = useState(null); // { kind, step, id, qrcode }
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [u, o, t] = await Promise.all([KoblyApi.uazapi('list', {}, empresaId), KoblyApi.whatsappAccount('status', {}, empresaId), KoblyApi.notifyChannels('list', {}, empresaId)]);
    setSt({ loading: false, uaz: u.instances || [], uazOn: !!u.configured, oficial: (o && o.account) || null, tg: t.channels || [], error: u.error || t.error || null });
  }, [empresaId]);
  useEffect(() => { load(); }, [load]);

  function start(kind) {
    setPicker(false);
    if (kind.soon) { notify('info', `${kind.label} chega em breve.`); return; }
    setForm({}); setFlow({ kind: kind.id, step: 'form' });
  }
  async function createQr() {
    setBusy(true);
    const r = await KoblyApi.uazapi('create', { label: form.label }, empresaId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    setFlow({ kind: 'qr', step: 'qr', id: r.instance.id, qrcode: r.qrcode }); load();
  }
  async function saveTg() {
    setBusy(true);
    const r = await KoblyApi.notifyChannels('save', { label: form.label, bot_token: form.bot_token, chat_id: form.chat_id }, empresaId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', 'Bot conectado. Use "Testar" para receber uma mensagem.'); setFlow(null); load();
  }
  async function act(fn, action, extra, msg, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    const r = await KoblyApi[fn](action, extra, empresaId);
    if (r.error) notify('danger', r.error); else { if (msg) notify('success', msg); load(); }
  }

  // todas as conexões no mesmo formato de cartão
  const cards = [
    ...st.uaz.map((i) => ({ key: i.id, kind: 'qr', name: i.label, sub: i.profile_name || 'WhatsApp comum', phone: i.phone, status: i.status, when: i.connected_at, raw: i })),
    ...(st.oficial ? [{ key: 'oficial', kind: 'oficial', name: st.oficial.verified_name || 'WhatsApp Oficial', sub: 'API Oficial da Meta', phone: String(st.oficial.display_phone || '').replace(/\D/g, ''), status: st.oficial.status === 'connected' ? 'connected' : 'disconnected', when: st.oficial.connected_at, raw: st.oficial }] : []),
    ...st.tg.map((c) => ({ key: c.id, kind: 'telegram', name: c.label, sub: 'Bot de alertas', phone: null, chat: c.default_chat_id, status: 'connected', when: c.created_at, raw: c })),
  ].filter((c) => (filter === 'todos' || c.kind === filter) && (!q || `${c.name} ${c.phone || ''}`.toLowerCase().includes(q.toLowerCase())));
  const kindOf = (id) => KINDS.find((k) => k.id === id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 600, color: 'var(--text-strong)', fontSize: 'var(--text-lg)' }}>Suas conexões</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>WhatsApp, API Oficial e Telegram. Os fluxos e os Chats ao vivo usam estes canais.</div>
        </div>
        <IconButton icon="refresh-cw" aria-label="Atualizar" onClick={load} />
        <Button variant="primary" iconLeft="plus" onClick={() => setPicker(true)}>Nova conexão</Button>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Input icon="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome ou número…" style={{ flex: 1, minWidth: 220, maxWidth: 360 }} />
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setFilter(id)} style={{ padding: '7px 12px', borderRadius: 'var(--radius-pill)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)',
            border: `1px solid ${filter === id ? 'var(--accent)' : 'var(--border-subtle)'}`, background: filter === id ? 'var(--accent-soft)' : 'transparent', color: filter === id ? 'var(--accent)' : 'var(--text-body)' }}>{label}</button>
        ))}
      </div>
      {st.error && <Banner tone="danger">{st.error}</Banner>}
      {!st.loading && cards.length === 0 && (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', border: '1px dashed var(--border-default)', borderRadius: 'var(--radius-md)' }}>
          Nenhuma conexão{filter !== 'todos' ? ' deste canal' : ''} ainda. Clique em <strong>Nova conexão</strong> para começar pelo WhatsApp.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {cards.map((c) => {
          const k = kindOf(c.kind); const [tone, label] = STATUS[c.status] || STATUS.disconnected;
          return (
            <div key={c.key} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--surface-card)', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <KindIcon k={k} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{c.sub}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Badge size="sm" tone={tone} dot>{label}</Badge>
                {c.phone && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-strong)' }}>{fmtPhone(c.phone)}</span>}
                {c.chat && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>chat {c.chat}</span>}
              </div>
              {c.when && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>{c.kind === 'telegram' ? 'Criado' : 'Conectado'} em {fmtDateTime(c.when)}</div>}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {c.kind === 'qr' && c.status !== 'connected' && <Button size="sm" variant="primary" iconLeft="qr-code" onClick={() => setFlow({ kind: 'qr', step: 'qr', id: c.key })}>Ler QR Code</Button>}
                {c.kind === 'qr' && c.status === 'connected' && <Button size="sm" variant="secondary" iconLeft="unplug" onClick={() => act('uazapi', 'disconnect', { id: c.key }, 'Desconectado.', `Desconectar ${c.name}? Para voltar, será preciso ler o QR Code de novo.`)}>Desconectar</Button>}
                {c.kind === 'qr' && <Button size="sm" variant="ghost" iconLeft="trash-2" onClick={() => act('uazapi', 'remove', { id: c.key }, 'Conexão excluída.', `Excluir ${c.name}? O número sai da Kobly.`)}>Excluir</Button>}
                {c.kind === 'oficial' && <Button size="sm" variant="secondary" iconLeft="settings-2" onClick={() => setFlow({ kind: 'oficial', step: 'manage' })}>Gerenciar</Button>}
                {c.kind === 'telegram' && <Button size="sm" variant="secondary" onClick={() => act('notifyChannels', 'test', { id: c.key }, 'Mensagem de teste enviada no Telegram.')}>Testar</Button>}
                {c.kind === 'telegram' && <Button size="sm" variant="ghost" iconLeft="trash-2" onClick={() => act('notifyChannels', 'delete', { id: c.key }, 'Bot removido.', `Remover o bot "${c.name}"?`)}>Remover</Button>}
              </div>
            </div>
          );
        })}
      </div>

      <Modal open={picker} onClose={() => setPicker(false)} title="Nova conexão" subtitle="Escolha o tipo de conexão." width={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {KINDS.map((k) => (
            <button key={k.id} type="button" onClick={() => start(k)} style={{ display: 'flex', gap: 12, alignItems: 'center', textAlign: 'start', padding: 14, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
              background: 'var(--surface-card)', cursor: k.soon ? 'default' : 'pointer', opacity: k.soon ? 0.6 : 1, fontFamily: 'var(--font-sans)' }}>
              <KindIcon k={k} />
              <span style={{ flex: 1 }}>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><strong style={{ color: 'var(--text-strong)' }}>{k.label}</strong>{k.soon && <Badge size="sm" tone="neutral">Em breve</Badge>}</span>
                <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{k.desc}</span>
              </span>
              <Icon name="chevron-right" size={16} style={{ color: 'var(--text-subtle)' }} />
            </button>
          ))}
        </div>
      </Modal>

      <Modal open={!!flow && flow.kind === 'qr'} onClose={() => setFlow(null)} title="WhatsApp comum (QR Code)" width={480}
        footer={flow && flow.step === 'form' ? <><Button variant="ghost" onClick={() => setFlow(null)}>Cancelar</Button><Button variant="primary" iconLeft="qr-code" disabled={busy || !st.uazOn} onClick={createQr}>{busy ? 'Criando…' : 'Gerar QR Code'}</Button></> : null}>
        {flow && flow.kind === 'qr' && flow.step === 'form' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {!st.uazOn && <Banner tone="warning" title="Ainda não ativo neste servidor.">O administrador da Kobly precisa configurar a Uazapi (UAZAPI_BASE_URL e UAZAPI_ADMIN_TOKEN).</Banner>}
            <Input label="Nome da conexão" value={form.label || ''} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Ex.: Vendas, Suporte, Número da Ana" />
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Funciona com qualquer número de WhatsApp ou WhatsApp Business. Não é a API oficial: siga as boas práticas de envio para evitar bloqueio.</div>
          </div>
        )}
        {flow && flow.kind === 'qr' && flow.step === 'qr' && <QrPanel id={flow.id} empresaId={empresaId} initialQr={flow.qrcode} notify={notify} onConnected={load} />}
      </Modal>

      <Modal open={!!flow && flow.kind === 'telegram'} onClose={() => setFlow(null)} title="Telegram (bot de alertas)" width={480}
        footer={<><Button variant="ghost" onClick={() => setFlow(null)}>Cancelar</Button><Button variant="primary" disabled={busy || !form.bot_token || !form.chat_id} onClick={saveTg}>Conectar bot</Button></>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input label="Nome (opcional)" value={form.label || ''} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Equipe de vendas" />
          <Input label="Token do bot" type="password" autoComplete="new-password" value={form.bot_token || ''} onChange={(e) => setForm({ ...form, bot_token: e.target.value })} />
          <Input label="ID do chat ou grupo" value={form.chat_id || ''} onChange={(e) => setForm({ ...form, chat_id: e.target.value })} placeholder="-1001234567890" hint="Crie o bot com o @BotFather, adicione-o ao grupo e use o ID do grupo (começa com -100)." />
        </div>
      </Modal>

      <Drawer open={!!flow && flow.kind === 'oficial'} onClose={() => { setFlow(null); load(); }} width={720} title="API Oficial da Meta" subtitle="WhatsApp Cloud API: número verificado e modelos aprovados.">
        {flow && flow.kind === 'oficial' && <WhatsappMetaTab empresaId={empresaId} />}
      </Drawer>
    </div>
  );
}

export { KoblyConnections };
