import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Avatar, Badge, Banner, Button, Card, IconButton, Input, Select } from '@/ds';
import { Modal } from '@/lib/ui.jsx';
import { fmtDateTime } from '@/lib/workspace.jsx';
import { askConfirm } from '@/lib/confirm.jsx';

// Configurações → Equipe. Convida pessoas por e-mail como Administrador (configura tudo) ou Atendente
// (só Chats ao vivo, Leads e Pipeline). O dono da conta é sempre administrador. Sem provedor de
// e-mail configurado, o link de acesso aparece aqui para repassar. KoblyTeamCard

const PAPEL = { admin: 'Administrador', atendente: 'Atendente' };

function KoblyTeamCard({ orgId, notify }) {
  const [st, setSt] = useState({ loading: true, error: null, members: [], me: null, can: false });
  const [conv, setConv] = useState(null);
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await KoblyApi.team('list', {}, orgId);
    setSt({ loading: false, error: r.error, members: r.members || [], me: r.me, can: !!r.can_manage });
  }, [orgId]);
  useEffect(() => { load(); }, [load]);

  const done = (r, msg) => {
    if (r.error) { notify('danger', r.error); return false; }
    if (r.access_link) setLink(r.access_link); else if (msg) notify('success', msg);
    load(); return true;
  };
  async function invite() {
    setBusy(true);
    const r = await KoblyApi.team('invite', conv, orgId);
    setBusy(false);
    if (done(r, `Convite enviado para ${conv.email}.`)) setConv(null);
  }
  const resend = async (m) => done(await KoblyApi.team('resend', { profile_id: m.id }, orgId), 'Convite reenviado.');
  const setRole = async (m, team_role) => done(await KoblyApi.team('set_role', { profile_id: m.id, team_role }, orgId), `${m.nome} agora é ${PAPEL[team_role]}.`);
  async function remove(m) {
    if (!(await askConfirm(`Remover ${m.nome} da equipe? O acesso termina na hora.`))) return;
    done(await KoblyApi.team('remove', { profile_id: m.id }, orgId), `${m.nome} saiu da equipe.`);
  }
  const copy = async () => { try { await navigator.clipboard.writeText(link); notify('success', 'Link copiado'); } catch { notify('warning', 'Selecione e copie o link manualmente.'); } };

  return (
    <Card title="Equipe" subtitle="Quem acessa esta conta. Atendentes só veem os Chats ao vivo, Leads e Pipeline."
      action={st.can ? <Button size="sm" variant="secondary" iconLeft="user-plus" onClick={() => setConv({ email: '', nome: '', team_role: 'atendente' })}>Convidar</Button> : null}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {st.error && <Banner tone="danger">{st.error}</Banner>}
        {link && (
          <Banner tone="warning" title="E-mail não configurado neste ambiente: repasse o link de acesso.">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
              <code style={{ wordBreak: 'break-all', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{link}</code>
              <div style={{ display: 'flex', gap: 8 }}><Button size="sm" iconLeft="copy" onClick={copy}>Copiar link</Button><Button size="sm" variant="ghost" onClick={() => setLink(null)}>Fechar</Button></div>
            </div>
          </Banner>
        )}
        {st.members.map((m) => (
          <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', flexWrap: 'wrap' }}>
            <Avatar name={m.nome} size="sm" />
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{m.nome}{m.id === st.me ? ' (você)' : ''}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{m.email} · {m.convite_pendente ? 'convite pendente' : `último acesso ${fmtDateTime(m.ultimo_login)}`}</div>
            </div>
            {m.dono ? <Badge tone="info">Dono</Badge> : m.convite_pendente ? <Badge tone="warning">Convidado</Badge> : null}
            {st.can && !m.dono && m.id !== st.me ? (
              <Select value={m.team_role} onChange={(e) => setRole(m, e.target.value)} options={Object.entries(PAPEL).map(([value, label]) => ({ value, label }))} style={{ width: 170 }} aria-label={`Papel de ${m.nome}`} />
            ) : <Badge tone="neutral">{PAPEL[m.team_role] || m.team_role}</Badge>}
            {st.can && m.convite_pendente && <IconButton icon="send" size="sm" aria-label="Reenviar convite" onClick={() => resend(m)} />}
            {st.can && !m.dono && m.id !== st.me && <IconButton icon="user-minus" size="sm" aria-label="Remover da equipe" onClick={() => remove(m)} />}
          </div>
        ))}
      </div>
      <Modal open={!!conv} onClose={() => setConv(null)} title="Convidar para a equipe" subtitle="A pessoa recebe um link para criar a senha (vale 7 dias)."
        footer={<><Button variant="ghost" onClick={() => setConv(null)}>Cancelar</Button><Button variant="primary" iconLeft="send" disabled={busy || !conv || !conv.email.includes('@')} onClick={invite}>Enviar convite</Button></>}>
        {conv && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Input label="Nome" value={conv.nome} onChange={(e) => setConv({ ...conv, nome: e.target.value })} />
            <Input label="E-mail" type="email" value={conv.email} onChange={(e) => setConv({ ...conv, email: e.target.value })} />
            <Select label="Papel" value={conv.team_role} onChange={(e) => setConv({ ...conv, team_role: e.target.value })}
              options={[{ value: 'atendente', label: 'Atendente — Chats ao vivo, Leads e Pipeline' }, { value: 'admin', label: 'Administrador — configura tudo' }]} />
          </div>
        )}
      </Modal>
    </Card>
  );
}

export { KoblyTeamCard };
