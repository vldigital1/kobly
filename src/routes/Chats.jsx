import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Avatar, Badge, Banner, Button, Card, Icon, Input } from '@/ds';
import { useBreakpoint } from '@/lib/responsive.jsx';
import { EmptyState, ErrorState, SkeletonTable } from '@/lib/ui.jsx';
import { fmtDateTime, useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Chats ao vivo. Conversas do WhatsApp oficial: o que o lead mandou + o que o fluxo,
// o agente de IA ou alguém da equipe respondeu. Responder em texto livre só com a janela de 24 h
// aberta; "Assumir conversa" pausa a automação do lead. Digite "/" para usar respostas rápidas. KoblyChats

const POLL_MS = 10_000;
const DE = {
  lead: { label: 'Lead', align: 'flex-start', bg: 'var(--surface-sunken)' },
  fluxo: { label: 'Fluxo', align: 'flex-end', bg: 'var(--status-info-bg)' },
  agente: { label: 'Agente de IA', align: 'flex-end', bg: 'var(--status-info-bg)' },
  humano: { label: 'Equipe', align: 'flex-end', bg: 'var(--accent-soft, var(--status-success-bg))' },
};
const nomeOf = (c) => [c.nome, c.sobrenome].filter(Boolean).join(' ') || c.telefone || 'Lead';

function Conversation({ orgId, leadId, quickReplies, canEdit, notify, onChanged, onBack }) {
  const [st, setSt] = useState({ loading: true, error: null, lead: null, messages: [], flows: [] });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setSt((s) => ({ ...s, loading: true }));
    const r = await KoblyApi.inbox('messages', { lead_id: leadId }, orgId);
    setSt(r.error ? { loading: false, error: r.error, lead: null, messages: [], flows: [] } : { loading: false, error: null, lead: r.lead, messages: r.messages || [], flows: r.flows || [] });
  }, [leadId, orgId]);
  useEffect(() => { load(); const t = setInterval(() => load(true), POLL_MS); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (endRef.current) endRef.current.scrollIntoView({ block: 'end' }); }, [st.messages.length]);

  async function send() {
    const msg = text.trim();
    if (!msg) return;
    setBusy(true);
    const r = await KoblyApi.inbox('send', { lead_id: leadId, text: msg }, orgId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    setText('');
    setSt((s) => ({ ...s, messages: [...s.messages, r.message] }));
    onChanged();
  }
  async function pause(paused) {
    if (paused && st.flows.length && !confirm(`Assumir a conversa encerra ${st.flows.length} fluxo(s) em andamento para este lead e impede novos. Continuar?`)) return;
    const r = await KoblyApi.inbox('pause', { lead_id: leadId, paused }, orgId);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', paused ? `Você assumiu a conversa${r.cancelled ? ` (${r.cancelled} fluxo(s) encerrado(s))` : ''}.` : 'Conversa devolvida para a automação.');
    load(true); onChanged();
  }

  if (st.loading && !st.lead) return <SkeletonTable rows={6} />;
  if (st.error) return <ErrorState compact message={st.error} onRetry={() => load()} />;
  const lead = st.lead;
  const slash = text.startsWith('/') ? text.slice(1).toLowerCase() : null;
  const sugest = slash !== null ? quickReplies.filter((q) => q.shortcut.startsWith(slash)).slice(0, 6) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
        {onBack && <Button size="sm" variant="ghost" iconLeft="arrow-left" onClick={onBack}>Voltar</Button>}
        <Avatar name={nomeOf(lead)} size="sm" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{nomeOf(lead)}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{lead.telefone || 'sem telefone'}{lead.produto ? ` · ${lead.produto}` : ''}</div>
        </div>
        {lead.janela_aberta ? <Badge tone="success" dot>Janela de 24 h aberta</Badge> : <Badge tone="warning" dot>Janela fechada</Badge>}
        {canEdit && (lead.automation_paused
          ? <Button size="sm" variant="secondary" iconLeft="play" onClick={() => pause(false)}>Devolver à automação</Button>
          : <Button size="sm" variant="secondary" iconLeft="hand" onClick={() => pause(true)}>Assumir conversa</Button>)}
      </header>
      {lead.automation_paused && <div style={{ padding: '8px 16px', fontSize: 'var(--text-xs)', color: 'var(--status-warning-fg)', background: 'var(--status-warning-bg)' }}>Automação pausada: nenhum fluxo inicia ou continua para este lead até você devolver.</div>}
      {!lead.automation_paused && st.flows.length > 0 && <div style={{ padding: '8px 16px', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', background: 'var(--surface-sunken)' }}>Em fluxo: {st.flows.map((f) => `${f.campanha} (${f.status === 'waiting' ? (f.wait_kind === 'reply' ? 'esperando resposta' : 'aguardando') : 'rodando'})`).join(' · ')}</div>}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {st.messages.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', textAlign: 'center', marginTop: 24 }}>Sem mensagens ainda.</div>}
        {st.messages.map((m) => {
          const de = DE[m.de] || DE.lead;
          return (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: de.align }}>
              <div style={{ maxWidth: '78%', background: de.bg, color: 'var(--text-strong)', padding: '8px 12px', borderRadius: 'var(--radius-md)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--text-sm)' }}>
                {m.body || <em style={{ color: 'var(--text-muted)' }}>[{m.tipo}]</em>}
              </div>
              <span style={{ fontSize: 'var(--text-2xs, 11px)', color: 'var(--text-subtle)', marginTop: 2 }}>{de.label} · {fmtDateTime(m.at)}</span>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {canEdit && (
        <footer style={{ borderTop: '1px solid var(--border-subtle)', padding: 12, position: 'relative' }}>
          {sugest.length > 0 && (
            <div style={{ position: 'absolute', bottom: '100%', left: 12, right: 12, background: 'var(--surface-overlay)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-pop)', overflow: 'hidden' }}>
              {sugest.map((q) => (
                <button key={q.id} type="button" onClick={() => setText(q.body)} style={{ display: 'block', width: '100%', textAlign: 'start', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-body)', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)' }}>
                  <strong>/{q.shortcut}</strong> <span style={{ color: 'var(--text-muted)' }}>{q.body.slice(0, 80)}</span>
                </button>
              ))}
            </div>
          )}
          {!lead.janela_aberta ? (
            <Banner tone="warning">A Meta só permite texto livre até 24 h depois da última mensagem do lead. Para reabrir a conversa, envie um modelo aprovado por um fluxo.</Banner>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <textarea value={text} rows={2} maxLength={4096} placeholder="Escreva uma resposta… (digite / para respostas rápidas)" onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (sugest.length && slash !== null) setText(sugest[0].body); else send(); } }}
                style={{ flex: 1, background: 'var(--surface-sunken)', color: 'var(--text-strong)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', padding: 10, font: 'inherit', resize: 'none' }} />
              <Button variant="primary" iconLeft="send" disabled={busy || !text.trim()} onClick={send}>Enviar</Button>
            </div>
          )}
        </footer>
      )}
    </div>
  );
}

function KoblyChats() {
  const store = useKobly();
  const { isMobile } = useBreakpoint();
  const { orgId, picker, canEdit } = useTargetOrg();
  const [q, setQ] = useState('');
  const [list, setList] = useState({ loading: true, error: null, items: [] });
  const [sel, setSel] = useState(null);
  const [quick, setQuick] = useState([]);

  const load = useCallback(async (quiet = false) => {
    if (!orgId) { setList({ loading: false, error: null, items: [] }); return; }
    if (!quiet) setList((s) => ({ ...s, loading: true }));
    const r = await KoblyApi.inbox('list', { q }, orgId);
    setList({ loading: false, error: r.error, items: r.conversations || [] });
  }, [orgId, q]);
  useEffect(() => { const t = setTimeout(() => load(), q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { const t = setInterval(() => load(true), POLL_MS); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (orgId) KoblyApi.workspaceSettings('get', {}, orgId).then((r) => setQuick(r.quick_replies || [])); }, [orgId]);

  const listPane = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ padding: 12, borderBottom: '1px solid var(--border-subtle)' }}>
        <Input icon="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome, telefone ou e-mail" />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {list.loading ? <div style={{ padding: 12 }}><SkeletonTable rows={5} /></div>
          : list.error ? <ErrorState compact message={list.error} onRetry={() => load()} />
          : list.items.length === 0 ? <EmptyState compact icon="message-circle" title={orgId ? 'Nenhuma conversa ainda' : 'Selecione uma conta'} message={orgId ? 'Quando um lead responder no WhatsApp oficial, a conversa aparece aqui.' : 'Escolha a conta do cliente acima.'} />
          : list.items.map((c) => (
            <button key={c.lead_id} type="button" onClick={() => setSel(c.lead_id)} style={{
              display: 'flex', gap: 10, width: '100%', textAlign: 'start', padding: '12px 14px', border: 'none', borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer', fontFamily: 'var(--font-sans)',
              background: sel === c.lead_id ? 'var(--surface-sunken)' : 'transparent' }}>
              <Avatar name={nomeOf(c)} size="sm" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nomeOf(c)}</span>
                  <span style={{ fontSize: 'var(--text-2xs, 11px)', color: 'var(--text-subtle)', flex: 'none' }}>{fmtDateTime(c.ultima_em)}</span>
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.ultima_de !== 'lead' && <Icon name="corner-down-right" size={11} />} {c.ultima || '[mídia]'}
                </div>
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  {c.janela_aberta && <Badge size="sm" tone="success">24 h</Badge>}
                  {c.automation_paused && <Badge size="sm" tone="warning">Humano</Badge>}
                  {c.ultima_de === 'lead' && <Badge size="sm" tone="info">Aguardando resposta</Badge>}
                </div>
              </div>
            </button>
          ))}
      </div>
    </div>
  );
  const convPane = sel
    ? <Conversation key={sel} orgId={orgId} leadId={sel} quickReplies={quick} canEdit={canEdit} notify={store.notify} onChanged={() => load(true)} onBack={isMobile ? () => setSel(null) : null} />
    : <EmptyState icon="messages-square" title="Escolha uma conversa" message="Veja o histórico com o fluxo e o agente de IA, responda dentro da janela de 24 h ou assuma o atendimento." />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {picker}
      <Card pad={false} style={{ height: 'calc(100dvh - 190px)', minHeight: 480 }} bodyStyle={{ display: 'flex', height: '100%' }}>
        {isMobile ? (sel ? <div style={{ flex: 1, minWidth: 0 }}>{convPane}</div> : <div style={{ flex: 1 }}>{listPane}</div>) : (<>
          <div style={{ width: 340, flex: 'none', borderInlineEnd: '1px solid var(--border-subtle)' }}>{listPane}</div>
          <div style={{ flex: 1, minWidth: 0 }}>{convPane}</div>
        </>)}
      </Card>
    </div>
  );
}

export { KoblyChats };
