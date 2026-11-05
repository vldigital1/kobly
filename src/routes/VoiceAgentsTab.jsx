import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Icon, Input, Select } from '@/ds';
import { EmptyState, Modal, SkeletonTable } from '@/lib/ui.jsx';
import { fmtDateTime } from '@/lib/workspace.jsx';
import { askConfirm } from '@/lib/confirm.jsx';

// Kobly — Integrações → Agentes de voz. Agentes que conversam por ligação no WhatsApp:
// ElevenLabs liga para o lead (bloco Ligação dos fluxos) e a OpenAI atende quem liga para a empresa.
// Aqui: criar/editar agentes, configurar o número de ligação (ElevenLabs) e o atendimento (OpenAI), e ver as ligações. KoblyVoiceAgentsTab

const CSS = `
.va-card { border-radius: 18px; padding: 18px; display: flex; flex-direction: column; gap: 12px; background: linear-gradient(180deg, rgba(var(--fg-rgb), .045), rgba(var(--fg-rgb), .012)), rgba(var(--panel-rgb), .95); border: 1px solid rgba(var(--fg-rgb), .08); }
.va-hero { position: relative; overflow: hidden; border-radius: 20px; padding: 20px 22px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
  background: radial-gradient(600px 240px at 0% 0%, rgba(129,140,248,.22), transparent 60%), radial-gradient(600px 240px at 100% 100%, rgba(255,98,1,.16), transparent 60%), rgba(var(--panel-rgb), .95); border: 1px solid rgba(var(--fg-rgb), .08); }
.va-wave { display: flex; gap: 3px; align-items: center; height: 40px; }
.va-wave i { width: 4px; border-radius: 3px; background: linear-gradient(180deg, #a5b4fc, #ff6201); animation: va-w 1.2s ease-in-out infinite; }
@keyframes va-w { 0%, 100% { height: 8px; } 50% { height: 36px; } }
.va-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 14px; }
.va-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; font-size: 12px; color: var(--text-muted); background: rgba(var(--fg-rgb), .05); border: 1px solid rgba(var(--fg-rgb), .08); }
.va-step { display: flex; gap: 10px; font-size: var(--text-sm); color: var(--text-body); line-height: 1.5; }
.va-step i { font-style: normal; flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; color: var(--on-tint); background: rgba(255,98,1,.25); }
.va-ta { width: 100%; box-sizing: border-box; border-radius: 12px; border: 1px solid rgba(var(--fg-rgb), .1); background: rgba(var(--well-rgb), calc(.25 * var(--well-k))); color: var(--text-strong); font: inherit; font-size: 14px; padding: 12px; resize: vertical; line-height: 1.5; }
.va-seg { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.va-seg button { text-align: left; padding: 12px; border-radius: 12px; cursor: pointer; font-family: var(--font-sans); background: var(--surface-sunken); border: 1px solid var(--border-subtle); color: var(--text-muted); }
.va-seg button.on { background: var(--accent-soft); border-color: var(--border-accent); color: var(--text-strong); }
.va-call { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; padding: 10px 6px; border-radius: 10px; cursor: pointer; }
.va-call:hover { background: rgba(var(--fg-rgb), .03); }
.va-code { font-family: var(--font-mono, monospace); font-size: 12px; padding: 8px 10px; border-radius: 10px; background: rgba(var(--fg-rgb), .05); border: 1px solid rgba(var(--fg-rgb), .08); color: var(--text-strong); word-break: break-all; }
`;

const RESULT = { answered: ['success', 'Atendeu'], no_answer: ['neutral', 'Não atendeu'], rejected: ['danger', 'Recusou'] };
const LANGS = [{ value: 'pt', label: 'Português' }, { value: 'es', label: 'Espanhol' }, { value: 'en', label: 'Inglês' }];
const blank = () => ({ name: '', provider: 'elevenlabs', language: 'pt', voice_id: '', voice_name: '', instructions: '', first_message: '', outcomes: [{ label: '', description: '' }], max_duration_s: 300, silence_timeout_s: 20 });

function copy(text, notify) {
  try { navigator.clipboard.writeText(text); notify('success', 'Copiado!'); } catch { notify('danger', 'Selecione e copie à mão.'); }
}

function AgentEditor({ open, agent, data, empresaId, notify, onClose }) {
  const [f, setF] = useState(blank());
  const [voices, setVoices] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setF(agent ? { ...blank(), ...agent, outcomes: agent.outcomes && agent.outcomes.length ? agent.outcomes : [{ label: '', description: '' }] } : blank());
  }, [open, agent]);
  useEffect(() => {
    if (!open || f.provider !== 'elevenlabs' || voices || !data.elevenlabs_connected) return;
    KoblyApi.voice('voices', {}, empresaId).then((r) => setVoices(r.error ? [] : r.voices || []));
  }, [open, f.provider, voices, data.elevenlabs_connected, empresaId]);
  if (!open) return null;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setOut = (i, k, v) => setF((x) => ({ ...x, outcomes: x.outcomes.map((o, j) => (j === i ? { ...o, [k]: v } : o)) }));
  const providerOk = f.provider === 'elevenlabs' ? data.elevenlabs_connected : data.openai_connected;
  async function save() {
    setSaving(true);
    const r = await KoblyApi.voiceAgents('save', { ...f, id: agent ? agent.id : undefined, outcomes: f.outcomes.filter((o) => o.label.trim()) }, empresaId);
    setSaving(false);
    if (r.error) { notify('danger', r.error); return; }
    if (r.sync_error) notify('warning', `Agente salvo na Kobly, mas a ElevenLabs recusou: ${r.sync_error}`);
    else notify('success', agent ? 'Agente atualizado.' : 'Agente criado.');
    onClose(true);
  }
  const voiceOpts = f.provider === 'openai'
    ? data.openai_voices.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))
    : [{ value: '', label: !data.elevenlabs_connected ? 'Conecte a ElevenLabs para escolher' : voices ? 'Voz padrão da conta' : 'Carregando vozes…' }, ...(voices || []).map((v) => ({ value: v.voice_id, label: `${v.name}${v.descricao ? ` · ${v.descricao}` : ''}` }))];
  return (
    <Modal open onClose={() => onClose(false)} title={agent ? 'Editar agente de voz' : 'Novo agente de voz'} subtitle="Quem fala na ligação, o que ele quer conseguir e como termina." width={640}
      footer={<><Button variant="ghost" onClick={() => onClose(false)}>Cancelar</Button><Button variant="primary" loading={saving} disabled={!f.name.trim() || f.instructions.trim().length < 10} onClick={save}>Salvar agente</Button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label="Nome do agente" value={f.name} maxLength={60} placeholder="Ex.: Recuperação de Pix" onChange={(e) => set('name', e.target.value)} />
        <div>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-body)', marginBottom: 6 }}>Provedor da voz</div>
          <div className="va-seg">
            {[['elevenlabs', 'ElevenLabs', 'Liga para o lead pelo bloco Ligação dos fluxos. Voz mais natural.'], ['openai', 'OpenAI', 'Atende quem liga para a empresa (ligação recebida).']].map(([id, t, d]) => (
              <button key={id} type="button" className={f.provider === id ? 'on' : ''} onClick={() => setF((x) => ({ ...x, provider: id, voice_id: id === 'openai' ? 'marin' : '', voice_name: '' }))}>
                <b style={{ display: 'block', color: 'var(--text-strong)', marginBottom: 3 }}>{t}</b><span style={{ fontSize: 12, lineHeight: 1.45 }}>{d}</span>
              </button>
            ))}
          </div>
          {!providerOk && <Banner tone="warning" style={{ marginTop: 8 }}>{f.provider === 'elevenlabs' ? 'Conecte sua chave em Integrações → Voz (ElevenLabs) antes de usar este agente.' : 'Cadastre uma chave da OpenAI em Integrações → IA (sua chave).'}</Banner>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <Select label="Voz" value={f.voice_id || ''} options={voiceOpts}
            onChange={(e) => { const v = (voices || []).find((x) => x.voice_id === e.target.value); setF((x) => ({ ...x, voice_id: e.target.value, voice_name: v ? v.name : e.target.value })); }} />
          <Select label="Idioma da conversa" value={f.language} options={LANGS} onChange={(e) => set('language', e.target.value)} />
        </div>
        <div>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-body)', marginBottom: 6 }}>Instruções (quem ele é, objetivo, jeito de falar, o que não pode fazer)</div>
          <textarea className="va-ta" rows={7} maxLength={8000} value={f.instructions} onChange={(e) => set('instructions', e.target.value)}
            placeholder="Ex.: Você é a Ana, da Loja X. Liga para quem gerou um Pix e não pagou. Pergunte se teve algum problema, tire dúvidas sobre o produto e ofereça reenviar o código Pix. Seja simpática e breve. Nunca prometa desconto." />
        </div>
        <Input label="Primeira frase (o que ele diz quando atendem)" value={f.first_message} maxLength={500} placeholder="Ex.: Oi {{nome}}, aqui é a Ana da Loja X. Tudo bem?" onChange={(e) => set('first_message', e.target.value)}
          hint="Use {{nome}} para falar o nome do lead. Vazio = o agente espera a pessoa falar primeiro." />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-body)' }}>Saídas (o agente escolhe uma no fim da ligação)</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.5 }}>Cada saída vira uma ligação no bloco Ligação do fluxo. Ex.: "Vai pagar", "Sem interesse", "Pediu para ligar depois".</div>
          {f.outcomes.map((o, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr) auto', gap: 8, alignItems: 'center' }}>
              <input className="kbly-input" value={o.label} maxLength={40} placeholder={`Saída ${i + 1}`} onChange={(e) => setOut(i, 'label', e.target.value)} />
              <input className="kbly-input" value={o.description || ''} maxLength={300} placeholder="Quando escolher (opcional)" onChange={(e) => setOut(i, 'description', e.target.value)} />
              <button type="button" aria-label="Remover saída" onClick={() => setF((x) => ({ ...x, outcomes: x.outcomes.filter((_, j) => j !== i) }))}
                style={{ border: 0, background: 'transparent', color: 'var(--text-subtle)', cursor: 'pointer', padding: 6 }}><Icon name="x" size={16} /></button>
            </div>
          ))}
          {f.outcomes.length < 8 && <div><Button size="sm" variant="ghost" iconLeft="plus" onClick={() => setF((x) => ({ ...x, outcomes: [...x.outcomes, { label: '', description: '' }] }))}>Adicionar saída</Button></div>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <Input label="Duração máxima (segundos)" type="number" min={30} max={3600} value={f.max_duration_s} onChange={(e) => set('max_duration_s', Number(e.target.value))} />
          <Input label="Desligar após silêncio (segundos)" type="number" min={5} max={120} value={f.silence_timeout_s} onChange={(e) => set('silence_timeout_s', Number(e.target.value))} />
        </div>
      </div>
    </Modal>
  );
}

function CallSettings({ data, empresaId, notify, onSaved }) {
  const s = data.settings || {};
  const [open, setOpen] = useState(!s.el_phone_number_id);
  const [accs, setAccs] = useState(null);
  const [f, setF] = useState({ el_phone_number_id: s.el_phone_number_id || '', el_phone_label: s.el_phone_label || '', permission_template: s.permission_template || '', permission_language: s.permission_language || 'pt_BR',
    openai_project_id: s.openai_project_id || '', openai_webhook_secret: '', openai_agent_id: s.openai_agent_id || '' });
  const [busy, setBusy] = useState(false);
  async function loadAccs() {
    setAccs('load');
    const r = await KoblyApi.voiceAgents('el_accounts', {}, empresaId);
    if (r.error) { notify('danger', r.error); setAccs(null); return; }
    setAccs(r.accounts || []);
  }
  async function save() {
    setBusy(true);
    const body = { ...f }; if (!body.openai_webhook_secret) delete body.openai_webhook_secret;
    const r = await KoblyApi.voiceAgents('save_settings', body, empresaId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', 'Configuração de ligações salva.'); setF((x) => ({ ...x, openai_webhook_secret: '' })); onSaved();
  }
  const oaAgents = (data.agents || []).filter((a) => a.provider === 'openai');
  const elOk = !!(s.el_phone_number_id && s.permission_template);
  return (
    <div className="va-card">
      <button type="button" onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'transparent', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans)' }}>
        <Icon name="settings-2" size={18} style={{ color: 'var(--accent)' }} />
        <b style={{ flex: 1, color: 'var(--text-strong)', fontSize: 15 }}>Configurar ligações</b>
        <Badge tone={elOk ? 'success' : 'warning'} dot>{elOk ? `Ligando por ${s.el_phone_label || 'ElevenLabs'}` : 'Falta configurar'}</Badge>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} style={{ color: 'var(--text-subtle)' }} />
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <b style={{ color: 'var(--text-strong)' }}>1. Número que liga (ElevenLabs)</b>
            <div className="va-step"><i>a</i><span>Use um número do WhatsApp Oficial <b>só para ligações</b> (não pode ser o número que a Kobly já usa para mensagens).</span></div>
            <div className="va-step"><i>b</i><span>Na ElevenLabs, abra <b>Agents → WhatsApp → Import account</b> e conecte esse número pela Meta.</span></div>
            <div className="va-step"><i>c</i><span>No Gerenciador do WhatsApp desse número, crie um modelo com o botão <b>"Pedir permissão para ligar"</b> e espere a aprovação. A Meta só deixa ligar para quem aceitar.</span></div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                {Array.isArray(accs) ? (
                  <Select label="Número de ligação" value={f.el_phone_number_id}
                    options={[{ value: '', label: accs.length ? 'Escolha o número' : 'Nenhum número conectado na ElevenLabs' }, ...accs.map((a) => ({ value: a.phone_number_id, label: `${a.phone_number}${a.name ? ` · ${a.name}` : ''}${a.token_expired ? ' (reconectar)' : ''}` }))]}
                    onChange={(e) => { const a = accs.find((x) => x.phone_number_id === e.target.value); setF((x) => ({ ...x, el_phone_number_id: e.target.value, el_phone_label: a ? a.phone_number : '' })); }} />
                ) : (
                  <Input label="Número de ligação" value={f.el_phone_label || (f.el_phone_number_id ? `ID ${f.el_phone_number_id}` : '')} readOnly placeholder="Busque os números da sua ElevenLabs" />
                )}
              </div>
              <Button variant="secondary" iconLeft={accs === 'load' ? 'loader' : 'refresh-cw'} disabled={!data.elevenlabs_connected || accs === 'load'} onClick={loadAccs}>Buscar números</Button>
            </div>
            {!data.elevenlabs_connected && <Banner tone="warning">Conecte sua chave da ElevenLabs em Integrações → Voz (ElevenLabs) primeiro.</Banner>}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 10 }}>
              <Input label="Nome do modelo de permissão" value={f.permission_template} placeholder="ex.: pedido_ligacao" onChange={(e) => setF((x) => ({ ...x, permission_template: e.target.value.trim() }))} hint="Igual aparece no Gerenciador do WhatsApp." />
              <Input label="Idioma do modelo" value={f.permission_language} placeholder="pt_BR" onChange={(e) => setF((x) => ({ ...x, permission_language: e.target.value.trim() }))} />
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <b style={{ color: 'var(--text-strong)' }}>2. Atender quem liga com a OpenAI <span className="va-chip" style={{ marginLeft: 6 }}>experimental</span></b>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Na OpenAI (platform.openai.com → Settings → Webhooks), crie um webhook com o evento <b>realtime.call.incoming</b> apontando para o endereço abaixo e cole aqui o segredo (whsec_…).
              As ligações precisam chegar na OpenAI por SIP: a Meta encaminha as ligações do seu número oficial para o endereço SIP do projeto. Teste com uma ligação real antes de divulgar.
            </div>
            {s.openai_webhook_url && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><div className="va-code" data-no-i18n style={{ flex: 1 }}>{s.openai_webhook_url}</div><Button size="sm" variant="ghost" iconLeft="copy" onClick={() => copy(s.openai_webhook_url, notify)}>Copiar</Button></div>}
            {s.openai_sip_uri && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><div className="va-code" data-no-i18n style={{ flex: 1 }}>{s.openai_sip_uri}</div><Button size="sm" variant="ghost" iconLeft="copy" onClick={() => copy(s.openai_sip_uri, notify)}>Copiar</Button></div>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              <Input label="ID do projeto OpenAI" value={f.openai_project_id} placeholder="proj_…" onChange={(e) => setF((x) => ({ ...x, openai_project_id: e.target.value.trim() }))} />
              <Input label="Segredo do webhook" type="password" value={f.openai_webhook_secret} placeholder={s.openai_secret_set ? '•••••• (guardado)' : 'whsec_…'} autoComplete="off" onChange={(e) => setF((x) => ({ ...x, openai_webhook_secret: e.target.value.trim() }))} />
              <Select label="Agente que atende" value={f.openai_agent_id || ''} options={[{ value: '', label: oaAgents.length ? 'Ninguém (recusa a ligação)' : 'Crie um agente da OpenAI' }, ...oaAgents.map((a) => ({ value: a.id, label: a.name }))]}
                onChange={(e) => setF((x) => ({ ...x, openai_agent_id: e.target.value }))} />
            </div>
            {!data.openai_connected && <Banner tone="info">A OpenAI usa a sua chave cadastrada em Integrações → IA (sua chave).</Banner>}
          </div>
          <div><Button variant="primary" iconLeft="check" loading={busy} onClick={save}>Salvar configuração</Button></div>
        </div>
      )}
    </div>
  );
}

function TestCall({ agent, empresaId, notify, onClose }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  if (!agent) return null;
  async function go() {
    setBusy(true);
    const r = await KoblyApi.voiceAgents('test_call', { id: agent.id, phone }, empresaId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', 'Ligação pedida! Se o número ainda não deu permissão, chega primeiro uma mensagem pedindo para aceitar ligações.');
    onClose(true);
  }
  return (
    <Modal open onClose={() => onClose(false)} title="Testar ligação" subtitle={agent.name} width={440}
      footer={<><Button variant="ghost" onClick={() => onClose(false)}>Cancelar</Button><Button variant="primary" iconLeft="phone-call" loading={busy} disabled={phone.replace(/\D/g, '').length < 10} onClick={go}>Ligar agora</Button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Input label="Seu WhatsApp (com DDI e DDD)" value={phone} placeholder="5511999999999" inputMode="tel" onChange={(e) => setPhone(e.target.value)} />
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.5 }}>A ligação sai do número de ligação da ElevenLabs. O resultado aparece em "Últimas ligações" em até 1 minuto depois que terminar.</div>
      </div>
    </Modal>
  );
}

function KoblyVoiceAgentsTab({ empresaId, notify = () => {} }) {
  const [data, setData] = useState(null);
  const [calls, setCalls] = useState([]);
  const [edit, setEdit] = useState(null); // { agent | null }
  const [test, setTest] = useState(null);
  const [openCall, setOpenCall] = useState(null);
  const load = useCallback(async () => {
    const [r, c] = await Promise.all([KoblyApi.voiceAgents('list', {}, empresaId), KoblyApi.voiceAgents('calls', {}, empresaId)]);
    if (r.error) { notify('danger', r.error); setData({ agents: [], settings: {}, openai_voices: [] }); return; }
    setData(r); setCalls(c.calls || []);
  }, [empresaId, notify]);
  useEffect(() => { load(); }, [load]);
  // ligações em andamento: atualiza sozinho
  useEffect(() => {
    if (!calls.some((c) => c.status === 'pending')) return undefined;
    const t = setInterval(load, 20000); return () => clearInterval(t);
  }, [calls, load]);

  if (!data) return <SkeletonTable rows={3} />;
  async function remove(a) {
    if (!(await askConfirm(`Excluir o agente "${a.name}"? Blocos Ligação que usam ele passam a sair por "Não atendeu".`))) return;
    const r = await KoblyApi.voiceAgents('remove', { id: a.id }, empresaId);
    if (r.error) notify('danger', r.error); else { notify('success', 'Agente excluído.'); load(); }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{CSS}</style>
      <div className="va-hero">
        <div className="va-wave" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((i) => <i key={i} style={{ animationDelay: `${i * 0.13}s` }} />)}</div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: 19 }}>Agentes de voz</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>Uma IA que liga para o lead no WhatsApp, conversa com voz natural e escolhe a saída do fluxo. Use no bloco <b>Ligação</b> dos fluxos.</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            <span className="va-chip"><Icon name={data.elevenlabs_connected ? 'circle-check' : 'circle-alert'} size={13} style={{ color: data.elevenlabs_connected ? '#34d399' : '#fbbf24' }} />ElevenLabs</span>
            <span className="va-chip"><Icon name={data.openai_connected ? 'circle-check' : 'circle-alert'} size={13} style={{ color: data.openai_connected ? '#34d399' : '#fbbf24' }} />OpenAI</span>
          </div>
        </div>
        <Button variant="primary" iconLeft="plus" onClick={() => setEdit({ agent: null })}>Novo agente</Button>
      </div>

      <CallSettings key={JSON.stringify(data.settings)} data={data} empresaId={empresaId} notify={notify} onSaved={load} />

      {!data.agents.length ? (
        <EmptyState icon="audio-lines" title="Nenhum agente de voz ainda" message="Crie o primeiro: diga quem ele é, o objetivo da ligação e as saídas (ex.: vai pagar, sem interesse)."
          action={<Button variant="primary" iconLeft="plus" onClick={() => setEdit({ agent: null })}>Criar agente</Button>} />
      ) : (
        <div className="va-grid">
          {data.agents.map((a) => (
            <div key={a.id} className="va-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 38, height: 38, borderRadius: 12, display: 'grid', placeItems: 'center', background: a.provider === 'openai' ? 'rgba(16,163,127,.16)' : 'rgba(129,140,248,.16)', color: a.provider === 'openai' ? '#10a37f' : '#a5b4fc' }}><Icon name={a.provider === 'openai' ? 'phone-incoming' : 'phone-outgoing'} size={18} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{a.provider === 'openai' ? 'OpenAI · atende quem liga' : 'ElevenLabs · liga para o lead'}{a.voice_name || a.voice_id ? ` · voz ${a.voice_name || a.voice_id}` : ''}</div>
                </div>
              </div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.instructions}</div>
              {a.outcomes && a.outcomes.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{a.outcomes.map((o) => <span key={o.key} className="va-chip"><Icon name="git-branch" size={12} />{o.label}</span>)}</div>}
              {a.provider === 'elevenlabs' && a.sync_error && <Banner tone="danger">ElevenLabs: {a.sync_error}</Banner>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>
                {a.provider === 'elevenlabs' && <Button size="sm" variant="secondary" iconLeft="phone-call" onClick={() => setTest(a)}>Testar ligação</Button>}
                <Button size="sm" variant="ghost" iconLeft="pencil" onClick={() => setEdit({ agent: a })}>Editar</Button>
                <Button size="sm" variant="ghost" iconLeft="trash-2" onClick={() => remove(a)}>Excluir</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="va-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="phone" size={17} style={{ color: 'var(--accent)' }} />
          <b style={{ flex: 1, color: 'var(--text-strong)' }}>Últimas ligações</b>
          <Button size="sm" variant="ghost" iconLeft="refresh-cw" onClick={load}>Atualizar</Button>
        </div>
        {!calls.length ? <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', padding: '8px 2px' }}>Nenhuma ligação ainda. Use "Testar ligação" ou o bloco Ligação num fluxo.</div> : calls.map((c) => {
          const [tone, label] = c.status === 'pending' ? ['warning', 'Chamando…'] : (RESULT[c.result] || RESULT.no_answer);
          return (
            <div key={c.id}>
              <div className="va-call" onClick={() => setOpenCall(openCall === c.id ? null : c.id)}>
                <Icon name={c.direction === 'inbound' ? 'phone-incoming' : 'phone-outgoing'} size={16} style={{ color: 'var(--text-subtle)' }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-strong)', fontWeight: 600 }}><span data-no-i18n>{c.lead_nome || c.phone || '—'}</span> · {c.agent_name || 'agente removido'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{fmtDateTime(c.created_at)}{c.duration_s ? ` · ${Math.floor(c.duration_s / 60)}:${String(c.duration_s % 60).padStart(2, '0')}` : ''}{c.outcome ? ` · saída: ${c.outcome}` : ''}</div>
                </div>
                <Badge tone={tone} dot>{label}</Badge>
              </div>
              {openCall === c.id && (c.summary || c.transcript || c.error) && (
                <div style={{ margin: '0 6px 10px 34px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {c.error && <Banner tone="danger">{c.error}</Banner>}
                  {c.summary && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)' }} data-no-i18n><b>Resumo:</b> {c.summary}</div>}
                  {c.transcript && <pre data-no-i18n style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: 'var(--text-muted)', maxHeight: 260, overflow: 'auto', padding: 10, borderRadius: 10, background: 'rgba(var(--fg-rgb), .04)' }}>{c.transcript}</pre>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <AgentEditor open={!!edit} agent={edit && edit.agent} data={data} empresaId={empresaId} notify={notify} onClose={(saved) => { setEdit(null); if (saved) load(); }} />
      <TestCall agent={test} empresaId={empresaId} notify={notify} onClose={(done) => { setTest(null); if (done) load(); }} />
    </div>
  );
}

export { KoblyVoiceAgentsTab };
