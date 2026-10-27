import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Card, Icon, IconButton, Input, Select } from '@/ds';
import { Modal } from '@/lib/ui.jsx';
import { fmtDateTime } from '@/lib/workspace.jsx';
import { askConfirm } from '@/lib/confirm.jsx';

// Kobly — Integrações → IA. Cada empresa usa a PRÓPRIA chave de IA (OpenAI, Claude, Gemini, DeepSeek ou
// OpenRouter) nos blocos de IA, no agente e no copiloto: o custo da IA fica na conta do cliente.
// Pode cadastrar várias chaves (inclusive do mesmo provedor); só uma fica ativa. KoblyAiKeysTab

const PROVIDERS = [
  { id: 'gemini', label: 'Google Gemini', where: 'aistudio.google.com → Get API key' },
  { id: 'openai', label: 'OpenAI (GPT)', where: 'platform.openai.com → API keys' },
  { id: 'anthropic', label: 'Anthropic (Claude)', where: 'console.anthropic.com → API Keys' },
  { id: 'deepseek', label: 'DeepSeek', where: 'platform.deepseek.com → API keys' },
  { id: 'openrouter', label: 'OpenRouter', where: 'openrouter.ai → Keys' },
];
const nameOf = (id) => (PROVIDERS.find((p) => p.id === id) || {}).label || id;

function ModelPicker({ label = 'Modelo', value, onChange, models }) {
  const id = React.useId();
  return (
    <>
      <Input label={label} value={value} onChange={(e) => onChange(e.target.value)} list={id} placeholder={models.length ? 'Escolha ou digite o modelo' : 'Ex.: claude-opus-5-5, deepseek-chat'} />
      <datalist id={id}>{models.slice(0, 400).map((m) => <option key={m} value={m} />)}</datalist>
    </>
  );
}

function KoblyAiKeysTab({ empresaId, notify = () => {} }) {
  const [st, setSt] = useState({ loading: true, keys: [], platform: false, error: null });
  const [add, setAdd] = useState(null);
  const [edit, setEdit] = useState(null); // { id, model, models }
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await KoblyApi.aiKeys('list', {}, empresaId);
    setSt({ loading: false, keys: r.keys || [], platform: !!r.platform_fallback, error: r.error });
  }, [empresaId]);
  useEffect(() => { load(); }, [load]);

  async function connect() {
    setBusy(true);
    const r = await KoblyApi.aiKeys('connect', add, empresaId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', `Chave conferida: ${r.models.length} modelo(s) disponíveis.`);
    setAdd(null); load();
    if (!add.model) setEdit({ id: r.key.id, model: r.key.model, models: r.models });
  }
  async function openModels(k) {
    setEdit({ id: k.id, model: k.model, models: [] });
    const r = await KoblyApi.aiKeys('models', { id: k.id }, empresaId);
    if (r.error) notify('warning', r.error); else setEdit((e) => (e && e.id === k.id ? { ...e, models: r.models } : e));
  }
  async function saveModel() {
    const r = await KoblyApi.aiKeys('set_model', { id: edit.id, model: edit.model }, empresaId);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', 'Modelo salvo.'); setEdit(null); load();
  }
  async function act(action, k, msg) {
    if (action === 'remove' && !(await askConfirm(`Remover a chave ${nameOf(k.provider)} ${k.key_hint}?${k.is_active ? ' Os blocos de IA param até você ativar outra.' : ''}`))) return;
    const r = await KoblyApi.aiKeys(action, { id: k.id }, empresaId);
    if (r.error) notify('danger', r.error); else { notify('success', msg); load(); }
  }
  const prov = add && PROVIDERS.find((p) => p.id === add.provider);
  const ativa = st.keys.find((k) => k.is_active);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card icon="sparkles" title="IA da sua conta" subtitle="Os blocos de IA, o Agente de IA e o copiloto usam a SUA chave de API. O custo da IA fica na sua conta do provedor."
        action={<Button size="sm" variant="primary" iconLeft="plus" onClick={() => setAdd({ provider: 'gemini', api_key: '', model: '', label: '' })}>Adicionar chave</Button>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {st.error && <Banner tone="danger">{st.error}</Banner>}
          {!st.loading && !ativa && (
            <Banner tone="warning" title="Nenhuma chave de IA ativa.">
              {st.platform ? 'Enquanto isso, os blocos de IA usam a IA da plataforma.' : 'Os blocos de IA (entender resposta, extrair dados, agente) saem por "Erro" até você cadastrar uma chave.'}
            </Banner>
          )}
          {st.keys.map((k) => (
            <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: `1px solid ${k.is_active ? 'var(--accent)' : 'var(--border-subtle)'}`, borderRadius: 'var(--radius-sm)', flexWrap: 'wrap' }}>
              <Icon name="key-round" size={16} />
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{k.label || nameOf(k.provider)} <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{k.key_hint}</span></div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{nameOf(k.provider)} · modelo <strong>{k.model}</strong> · último uso {fmtDateTime(k.last_used_at)}</div>
                {k.status === 'error' && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--status-danger-fg)' }}>{k.last_error}</div>}
              </div>
              {k.is_active ? <Badge tone="success" dot>Ativa</Badge> : <Button size="sm" variant="secondary" onClick={() => act('activate', k, 'Chave ativada.')}>Usar esta</Button>}
              <IconButton icon="settings-2" size="sm" aria-label="Trocar modelo" onClick={() => openModels(k)} />
              <IconButton icon="trash-2" size="sm" aria-label="Remover chave" onClick={() => act('remove', k, 'Chave removida.')} />
            </div>
          ))}
        </div>
      </Card>

      <Modal open={!!add} onClose={() => setAdd(null)} title="Adicionar chave de IA" subtitle="A Kobly confere a chave no provedor antes de salvar. Ela fica cifrada; ninguém vê a chave inteira depois."
        footer={<><Button variant="ghost" onClick={() => setAdd(null)}>Cancelar</Button><Button variant="primary" disabled={busy || !add || add.api_key.trim().length < 12} onClick={connect}>{busy ? 'Conferindo…' : 'Conferir e salvar'}</Button></>}>
        {add && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Select label="Provedor" value={add.provider} onChange={(e) => setAdd({ ...add, provider: e.target.value })} options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))} />
            <Input label="Chave da API" type="password" autoComplete="off" value={add.api_key} onChange={(e) => setAdd({ ...add, api_key: e.target.value })} hint={prov ? `Onde pegar: ${prov.where}` : null} />
            <Input label="Nome (opcional)" value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} placeholder="Ex.: Gemini da loja" />
            <ModelPicker label="Modelo (opcional — dá para escolher depois)" value={add.model} onChange={(model) => setAdd({ ...add, model })} models={[]} />
          </div>
        )}
      </Modal>

      <Modal open={!!edit} onClose={() => setEdit(null)} title="Modelo da IA" subtitle={edit && !edit.models.length ? 'Carregando os modelos disponíveis para esta chave…' : 'Modelos disponíveis para esta chave.'}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancelar</Button><Button variant="primary" disabled={!edit || !edit.model.trim()} onClick={saveModel}>Salvar</Button></>}>
        {edit && <ModelPicker value={edit.model} onChange={(model) => setEdit({ ...edit, model })} models={edit.models} />}
      </Modal>
    </div>
  );
}

export { KoblyAiKeysTab };
