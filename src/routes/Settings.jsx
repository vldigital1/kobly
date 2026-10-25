import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Card, Icon, IconButton, Input, PageHeader, Select } from '@/ds';
import { EmptyState, ErrorState, Modal, SkeletonForm } from '@/lib/ui.jsx';
import { TextArea, useTargetOrg } from '@/lib/workspace.jsx';
import { KoblyTeamCard } from '@/routes/TeamCard.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Configurações da automação: Empresa (nome e fuso, usado por horário comercial e
// condições de hora), Respostas rápidas (/atalho no chat ao vivo), Campos personalizados
// ({{campo.chave}}) e Variáveis globais ({{global.chave}}); atalhos para o resto. KoblySettings

const FUSOS = [
  ['America/Sao_Paulo', 'Brasil — Brasília (UTC−3)'], ['America/Manaus', 'Brasil — Manaus (UTC−4)'], ['America/Mexico_City', 'México — Cidade do México (UTC−6)'],
  ['America/Bogota', 'Colômbia — Bogotá (UTC−5)'], ['America/Lima', 'Peru — Lima (UTC−5)'], ['America/Santiago', 'Chile — Santiago'], ['America/Argentina/Buenos_Aires', 'Argentina — Buenos Aires (UTC−3)'],
  ['America/New_York', 'EUA — Nova York'], ['America/Los_Angeles', 'EUA — Los Angeles'], ['Europe/Lisbon', 'Portugal — Lisboa'], ['Europe/Madrid', 'Espanha — Madri'], ['Africa/Luanda', 'Angola — Luanda (UTC+1)'],
];

// Lista genérica com criar/editar/excluir pela rota workspace-settings (upsert/delete por `kind`).
export function SettingsList({ orgId, kind, items, onSaved, canEdit, notify, title, help, empty, fields, blank, row }) {
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const r = await KoblyApi.workspaceSettings('upsert', { kind, item: edit }, orgId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', 'Salvo.'); setEdit(null); onSaved();
  }
  async function remove(it) {
    if (!confirm('Excluir este item? Fluxos que usam ele passam a receber vazio.')) return;
    const r = await KoblyApi.workspaceSettings('delete', { kind, id: it.id }, orgId);
    if (r.error) notify('danger', r.error); else onSaved();
  }
  return (
    <Card bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{title}</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 2 }}>{help}</div>
        </div>
        {canEdit && <Button size="sm" variant="secondary" iconLeft="plus" onClick={() => setEdit(blank())}>Adicionar</Button>}
      </div>
      {items.length === 0 ? <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-subtle)', padding: '6px 0' }}>{empty}.</div> : items.map((it) => (
        <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>{row(it)}</div>
          {canEdit && <IconButton icon="pencil" size="sm" aria-label="Editar" onClick={() => setEdit({ ...it })} />}
          {canEdit && <IconButton icon="trash-2" size="sm" aria-label="Excluir" onClick={() => remove(it)} />}
        </div>
      ))}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit && edit.id ? 'Editar' : 'Adicionar'} width={540}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancelar</Button><Button variant="primary" disabled={busy} onClick={save}>Salvar</Button></>}>
        {edit && <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{fields(edit, (patch) => setEdit((e) => ({ ...e, ...patch })))}</div>}
      </Modal>
    </Card>
  );
}

const mono = { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--accent)' };
const sub = { fontSize: 'var(--text-xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

function KoblySettings() {
  const store = useKobly();
  const { orgId, picker, canEdit } = useTargetOrg();
  const [st, setSt] = useState({ loading: true, error: null, data: null });
  const [org, setOrg] = useState({ nome: '', timezone: 'America/Sao_Paulo' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!orgId) { setSt({ loading: false, error: null, data: null }); return; }
    if (!quiet) setSt((s) => ({ ...s, loading: true }));
    const r = await KoblyApi.workspaceSettings('get', {}, orgId);
    if (r.error) { setSt({ loading: false, error: r.error, data: null }); return; }
    setSt({ loading: false, error: null, data: r });
    if (!quiet && r.org) setOrg({ nome: r.org.nome || '', timezone: r.org.timezone || 'America/Sao_Paulo' });
  }, [orgId]);
  useEffect(() => { load(); }, [load]);

  async function saveOrg() {
    setBusy(true);
    const r = await KoblyApi.workspaceSettings('update_org', org, orgId);
    setBusy(false);
    if (r.error) store.notify('danger', r.error); else store.notify('success', 'Empresa atualizada.');
  }

  const d = st.data;
  const fusos = FUSOS.some(([v]) => v === org.timezone) ? FUSOS : [[org.timezone, org.timezone], ...FUSOS];
  const common = { orgId, canEdit, notify: store.notify, onSaved: () => load(true) };
  const atalhos = [
    ['agentes', 'bot', 'Agentes de IA', 'Atendentes de IA reaproveitáveis nos fluxos'],
    ['integracoes', 'plug', 'Integrações', 'Conexões, gateways de pagamento, pixels e IA'],
    ['leads', 'tag', 'Etiquetas e leads', 'Contatos, etiquetas e histórico'],
    ['produtos', 'package', 'Produtos', 'Catálogo e vendas por produto'],
    ['integracoes', 'chart-line', 'Trackeamento', 'Pixels, UTMify e UTMs por origem', 'trackeamento'],
    ['fluxos', 'git-branch', 'Fluxos', 'Fluxos de conversa em grafo'],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader style={{ marginBottom: 0 }}>Configurações da conta e da automação usadas por todos os fluxos.</PageHeader>
      {picker}
      {!orgId ? <EmptyState icon="users" title="Selecione uma conta" message="Escolha a conta do cliente acima." />
        : st.loading ? <SkeletonForm fields={6} />
        : st.error ? <ErrorState message={st.error} onRetry={() => load()} />
        : (<>
          <Card bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>Empresa</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Input label="Nome da empresa" value={org.nome} onChange={(e) => setOrg((o) => ({ ...o, nome: e.target.value }))} style={{ flex: 1, minWidth: 220 }} disabled={!canEdit} />
              <Select label="Fuso horário" value={org.timezone} onChange={(e) => setOrg((o) => ({ ...o, timezone: e.target.value }))} options={fusos.map(([value, label]) => ({ value, label }))} style={{ flex: 1, minWidth: 220 }} disabled={!canEdit} />
              {canEdit && <Button variant="primary" disabled={busy} onClick={saveOrg}>Salvar</Button>}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>O fuso vale para o bloco Horário comercial, condições de hora/dia e {'{{hora_atual}}'} nas mensagens.</div>
          </Card>

          <KoblyTeamCard orgId={orgId} notify={store.notify} />

          <SettingsList {...common} kind="quick_reply" items={d.quick_replies || []} title="Respostas rápidas" empty="Nenhuma resposta rápida"
            help="No chat ao vivo, digite / e o atalho para inserir a mensagem."
            blank={() => ({ shortcut: '', body: '' })}
            row={(it) => (<><span style={mono}>/{it.shortcut}</span><div style={sub}>{it.body}</div></>)}
            fields={(e, set) => (<>
              <Input label="Atalho" value={e.shortcut} onChange={(ev) => set({ shortcut: ev.target.value.toLowerCase() })} placeholder="pix" hint="minúsculas, números, - e _" />
              <TextArea label="Mensagem" value={e.body} onChange={(v) => set({ body: v })} rows={5} maxLength={4096} />
            </>)} />

          <SettingsList {...common} kind="custom_field" items={d.custom_fields || []} title="Campos personalizados" empty="Nenhum campo personalizado"
            help="Dados extras do lead (cidade, plano…). Use {{campo.chave}} nas mensagens; o bloco Variável e a IA de extração podem preencher."
            blank={() => ({ key: '', label: '', field_type: 'texto', options: [] })}
            row={(it) => (<><span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{it.label}</span> <span style={mono}>{`{{campo.${it.key}}}`}</span> <Badge size="sm" tone="neutral">{it.field_type}</Badge></>)}
            fields={(e, set) => (<>
              <Input label="Nome" value={e.label} onChange={(ev) => set({ label: ev.target.value })} placeholder="Cidade" />
              <Input label="Chave" value={e.key} onChange={(ev) => set({ key: ev.target.value.toLowerCase() })} placeholder="cidade" hint="começa com letra; a-z, 0-9 e _" />
              <Select label="Tipo" value={e.field_type} onChange={(ev) => set({ field_type: ev.target.value })} options={[{ value: 'texto', label: 'Texto' }, { value: 'numero', label: 'Número' }, { value: 'data', label: 'Data' }, { value: 'opcoes', label: 'Lista de opções' }]} />
              {e.field_type === 'opcoes' && <Input label="Opções (separe por vírgula)" value={(e.options || []).join(', ')} onChange={(ev) => set({ options: ev.target.value.split(',').map((x) => x.trim()) })} />}
            </>)} />

          <SettingsList {...common} kind="global_var" items={d.global_vars || []} title="Variáveis globais" empty="Nenhuma variável global"
            help="Valores da conta usados em qualquer fluxo: link do suporte, cupom do mês, horário de atendimento. Use {{global.chave}}."
            blank={() => ({ key: '', value: '' })}
            row={(it) => (<><span style={mono}>{`{{global.${it.key}}}`}</span><div style={sub}>{it.value || '(vazio)'}</div></>)}
            fields={(e, set) => (<>
              <Input label="Chave" value={e.key} onChange={(ev) => set({ key: ev.target.value.toLowerCase() })} placeholder="cupom" />
              <TextArea label="Valor" value={e.value} onChange={(v) => set({ value: v })} rows={3} maxLength={2000} />
            </>)} />

          <Card>
            <div style={{ fontWeight: 600, color: 'var(--text-strong)', marginBottom: 10 }}>Mais configurações</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
              {atalhos.map(([id, icon, label, desc, sec]) => (
                <button key={label} type="button" onClick={() => { if (sec) { try { sessionStorage.setItem('kobly:int-section', sec); } catch { /* ok */ } } store.navigate(id); }} style={{ display: 'flex', gap: 10, textAlign: 'start', padding: 12, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
                  <span style={{ color: 'var(--accent)' }}><Icon name={icon} size={18} /></span>
                  <span><span style={{ display: 'block', color: 'var(--text-strong)', fontWeight: 600 }}>{label}</span><span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{desc}</span></span>
                </button>
              ))}
            </div>
          </Card>
          {!canEdit && <Banner tone="info">Seu perfil só visualiza as configurações.</Banner>}
        </>)}
    </div>
  );
}

export { KoblySettings };
