// Peças comuns das telas de operação (Fluxos, Chats ao vivo, Agentes, Configurações):
// conta-alvo (Gestor escolhe a conta do cliente) e campo de texto longo no padrão do DS.
import React from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Select } from '@/ds';
import { useAsync } from '@/lib/hooks.jsx';
import { useKobly } from '@/store/store.jsx';

// Cliente: a própria empresa. Gestor: a conta escolhida no seletor (guardada na sessão do navegador).
export function useTargetOrg() {
  const store = useKobly();
  const isGestor = store.role === 'Gestor';
  const clients = useAsync(() => (isGestor ? KoblyApi.listClients() : Promise.resolve([])), [store.role]);
  const [contaId, setContaId] = React.useState(() => { try { return sessionStorage.getItem('kobly:conta') || null; } catch { return null; } });
  const pick = (id) => { setContaId(id); try { id ? sessionStorage.setItem('kobly:conta', id) : sessionStorage.removeItem('kobly:conta'); } catch { /* ok */ } };
  const orgId = isGestor ? contaId : store.session.empresaId;
  const picker = isGestor ? (
    <Select label="Conta" value={contaId || ''} onChange={(e) => pick(e.target.value || null)} style={{ maxWidth: 320 }}
      options={[{ value: '', label: 'Selecione uma conta de cliente' }, ...((clients.data || []).map((c) => ({ value: c.id, label: c.nome })))]} />
  ) : null;
  return { orgId, picker, isGestor, canEdit: store.role !== 'Suporte' };
}

export function TextArea({ label, value, onChange, rows = 4, hint, placeholder, maxLength }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>
      {label}
      <textarea value={value ?? ''} rows={rows} placeholder={placeholder} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} style={{
        background: 'var(--surface-sunken)', color: 'var(--text-strong)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)',
        padding: 10, font: 'inherit', resize: 'vertical' }} />
      {hint && <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>{hint}</span>}
    </label>
  );
}

export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
