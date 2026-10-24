import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Input, PageHeader } from '@/ds';
import { EmptyState, ErrorState, SkeletonForm } from '@/lib/ui.jsx';
import { TextArea, useTargetOrg } from '@/lib/workspace.jsx';
import { SettingsList } from '@/routes/Settings.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Agentes de IA reaproveitáveis. Cada agente tem objetivo, base de conhecimento e tom;
// no editor de fluxo, o bloco "Agente de IA" escolhe um agente salvo (mudar aqui vale para todos
// os fluxos que usam ele). O texto do lead é tratado como dado, nunca como instrução. KoblyAgents

function KoblyAgents() {
  const store = useKobly();
  const { orgId, picker, canEdit } = useTargetOrg();
  const [st, setSt] = useState({ loading: true, error: null, agents: [] });
  const load = useCallback(async (quiet = false) => {
    if (!orgId) { setSt({ loading: false, error: null, agents: [] }); return; }
    if (!quiet) setSt((s) => ({ ...s, loading: true }));
    const r = await KoblyApi.workspaceSettings('get', {}, orgId);
    setSt({ loading: false, error: r.error, agents: r.agents || [] });
  }, [orgId]);
  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader style={{ marginBottom: 0 }}>
        Atendentes de IA que conversam com o lead no WhatsApp até concluir o objetivo, pedir um humano ou o lead sumir. Crie aqui e escolha no bloco Agente de IA de qualquer fluxo.
      </PageHeader>
      {picker}
      {!orgId ? <EmptyState icon="users" title="Selecione uma conta" message="Escolha a conta do cliente acima." />
        : st.loading ? <SkeletonForm fields={4} />
        : st.error ? <ErrorState message={st.error} onRetry={() => load()} />
        : (
          <SettingsList orgId={orgId} canEdit={canEdit} notify={store.notify} onSaved={() => load(true)} kind="agent" items={st.agents}
            title="Agentes" empty="Nenhum agente ainda"
            help="Dica: coloque preço, entrega, garantia e dúvidas frequentes na base de conhecimento. O agente não promete nada fora dela."
            blank={() => ({ name: '', objective: '', knowledge: '', tone: '', opening: '', max_turns: 10, timeout_minutes: 60 })}
            row={(a) => (<>
              <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{a.name}</span>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.objective}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>até {a.max_turns} respostas · espera {a.timeout_minutes} min{a.tone ? ` · tom: ${a.tone}` : ''}</div>
            </>)}
            fields={(e, set) => (<>
              <Input label="Nome" value={e.name} onChange={(ev) => set({ name: ev.target.value })} placeholder="Vendedora do guia (México)" />
              <TextArea label="Objetivo" value={e.objective} onChange={(v) => set({ objective: v })} rows={3} hint="O que conta como sucesso. Ex.: tirar dúvidas e levar o lead a pagar o Pix." />
              <TextArea label="Base de conhecimento" value={e.knowledge} onChange={(v) => set({ knowledge: v })} rows={7} maxLength={8000} />
              <Input label="Tom de voz" value={e.tone || ''} onChange={(ev) => set({ tone: ev.target.value })} placeholder="amigável e direto, em espanhol" />
              <TextArea label="Mensagem de abertura (opcional)" value={e.opening || ''} onChange={(v) => set({ opening: v })} rows={2} hint="Vazio: o agente responde a última mensagem do lead." />
              <div style={{ display: 'flex', gap: 8 }}>
                <Input label="Máx. de respostas" type="number" value={e.max_turns ?? 10} onChange={(ev) => set({ max_turns: Number(ev.target.value) })} />
                <Input label="Espera sem resposta (min)" type="number" value={e.timeout_minutes ?? 60} onChange={(ev) => set({ timeout_minutes: Number(ev.target.value) })} />
              </div>
            </>)} />
        )}
    </div>
  );
}

export { KoblyAgents };
