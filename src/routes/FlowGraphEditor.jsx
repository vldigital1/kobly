import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, addEdge, useEdgesState, useNodesState, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Button, Icon, IconButton, Input, Select } from '@/ds';
import { BLOCKS, PALETTE_GROUPS, TONES, TIPOS_EVENTO, PAYMENT_METHODS, CURRENCY_LABEL, exitsOf, newRef, emptyGraph, toCanvas, fromCanvas, summaryOf } from '@/lib/flowGraph.js';

// Kobly — Editor visual do fluxo em grafo (motor novo). Blocos ligados por saídas nomeadas:
// paleta → arrasta/clica para adicionar, liga uma saída a outro bloco, edita no painel da direita,
// valida no servidor e publica uma nova versão (dá para voltar a qualquer versão). KoblyFlowGraphEditor

const defaultApi = {
  flowGraph: (...a) => KoblyApi.flowGraph(...a),
  listTemplates: () => KoblyApi.listWhatsappTemplates(),
  getTags: () => KoblyApi.getTags(),
  listIntegrations: () => KoblyApi.paymentIntegrations('list').then((r) => r.integrations || []),
  listPixels: () => KoblyApi.pixelConfigs('list').then((r) => r.pixels || []),
  listChannels: () => KoblyApi.notifyChannels('list').then((r) => r.channels || []),
};

const LookupsCtx = React.createContext({ templates: [], tags: [], integrations: [], pixels: [], channels: [], metrics: null });
const VARS_HELP = '{{nome}} {{primeiro_nome}} {{produto}} {{valor}} {{cta_link}} {{resposta}} {{hora_atual}} {{dia_semana}} · depois da Cobrança: {{pagamento_codigo}} {{pagamento_qr}} {{pagamento_link}} {{pagamento_valor}}';

// ---- Cartão do bloco no canvas ------------------------------------------------
function BlockNode({ id, data, selected }) {
  const lookups = React.useContext(LookupsCtx);
  const b = BLOCKS[data.type] || { label: data.type, icon: 'circle', tone: 'neutral' };
  const color = TONES[b.tone] || TONES.neutral;
  const exits = exitsOf({ type: data.type, data: data.data });
  return (
    <div style={{
      width: 240, background: 'var(--surface-card)', borderStyle: 'solid', borderWidth: '3px 1px 1px 1px',
      borderColor: `${color} ${selected ? 'var(--accent)' : 'var(--border-default)'} ${selected ? 'var(--accent)' : 'var(--border-default)'}`, borderRadius: 'var(--radius-md)', boxShadow: selected ? 'var(--shadow-focus)' : 'var(--shadow-sm)', fontSize: 12, color: 'var(--text-body)',
    }}>
      {!data.isStart && <Handle type="target" position={Position.Left} style={{ width: 10, height: 10, background: 'var(--ink-300)' }} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px 4px' }}>
        <span style={{ color, display: 'flex' }}><Icon name={b.icon} size={15} /></span>
        <strong style={{ color: 'var(--text-strong)', fontSize: 13, flex: 1 }}>{b.label}</strong>
        <span style={{ color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{id}</span>
      </div>
      {lookups.metrics && (
        <div style={{ display: 'flex', gap: 6, padding: '0 10px 6px' }}>
          <span title="Leads que chegaram a este bloco" style={{ background: 'var(--surface-sunken)', color: 'var(--text-strong)', borderRadius: 'var(--radius-pill)', padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>
            {(lookups.metrics[id] && lookups.metrics[id].leads) || 0} leads
          </span>
          {lookups.metrics[id] && lookups.metrics[id].here > 0 && (
            <span title="Leads parados neste bloco agora" style={{ background: 'var(--amber-tint)', color: 'var(--amber-600)', borderRadius: 'var(--radius-pill)', padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>
              {lookups.metrics[id].here} aqui agora
            </span>
          )}
        </div>
      )}
      <div style={{ padding: '0 10px 8px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', minHeight: 16 }}>
        {summaryOf(data.type, data.data || {}, lookups)}
      </div>
      {exits.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {exits.map(([k, label]) => (
            <div key={k} style={{ position: 'relative', padding: '4px 18px 4px 10px', textAlign: 'right', color: k === 'failed' || k === 'error' ? 'var(--red-500)' : 'var(--text-muted)' }}>
              {label}
              <Handle type="source" id={k} position={Position.Right} style={{ width: 10, height: 10, background: color }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
const nodeTypes = { kobly: BlockNode };

// ---- Campos auxiliares --------------------------------------------------------
function TextArea({ label, value, onChange, rows = 4, hint }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>
      {label}
      <textarea value={value ?? ''} rows={rows} onChange={(e) => onChange(e.target.value)} style={{
        background: 'var(--surface-sunken)', color: 'var(--text-strong)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)',
        padding: 10, font: 'inherit', resize: 'vertical' }} />
      {hint && <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>{hint}</span>}
    </label>
  );
}
function Check({ label, checked, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-body)', cursor: 'pointer' }}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}
const num = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));
const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'opcao';

function ListEditor({ items, onChange, render, make, addLabel, max = 10 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: 8, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>{render(it, (patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))))}</div>
          <IconButton icon="trash-2" size="sm" aria-label="Remover" onClick={() => onChange(items.filter((_, j) => j !== i))} />
        </div>
      ))}
      {items.length < max && <Button size="sm" variant="secondary" iconLeft="plus" onClick={() => onChange([...items, make(items)])}>{addLabel}</Button>}
    </div>
  );
}

// ---- Painel de propriedades -----------------------------------------------------
const RULE_KINDS = [
  { value: 'var', label: 'Variável' }, { value: 'tag', label: 'Etiqueta' }, { value: 'purchased', label: 'Comprou' },
  { value: 'window_open', label: 'Janela de 24 h aberta' }, { value: 'weekday', label: 'Dia da semana' }, { value: 'time_between', label: 'Horário' }, { value: 'country', label: 'País (DDI)' },
];
const VAR_OPS = [['eq', 'é igual a'], ['neq', 'é diferente de'], ['contains', 'contém'], ['not_contains', 'não contém'], ['gt', 'maior que'], ['gte', 'maior ou igual'], ['lt', 'menor que'], ['lte', 'menor ou igual'], ['empty', 'está vazia'], ['not_empty', 'não está vazia']].map(([value, label]) => ({ value, label }));
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function RuleFields({ r, set, tags }) {
  switch (r.kind) {
    case 'var': return (<>
      <Input label="Variável" value={r.name || ''} onChange={(e) => set({ name: e.target.value.trim() })} placeholder="resposta" />
      <Select label="Operador" value={r.op || 'eq'} onChange={(e) => set({ op: e.target.value })} options={VAR_OPS} />
      {!['empty', 'not_empty'].includes(r.op) && <Input label="Valor" value={r.value ?? ''} onChange={(e) => set({ value: e.target.value })} />}
    </>);
    case 'tag': return (<>
      <Select label="Etiqueta" value={r.tag_id || ''} onChange={(e) => set({ tag_id: e.target.value })} options={[{ value: '', label: 'Selecionar…' }, ...tags.map((t) => ({ value: t.id, label: t.nome }))]} />
      <Select label="Lead" value={r.op || 'has'} onChange={(e) => set({ op: e.target.value })} options={[{ value: 'has', label: 'tem a etiqueta' }, { value: 'not_has', label: 'não tem a etiqueta' }]} />
    </>);
    case 'weekday': return (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{DIAS.map((dName, i) => (
        <Check key={i} label={dName} checked={(r.days || []).includes(i)} onChange={(on) => set({ days: on ? [...(r.days || []), i].sort() : (r.days || []).filter((x) => x !== i) })} />))}</div>);
    case 'time_between': return (<div style={{ display: 'flex', gap: 8 }}>
      <Input label="De" type="time" value={r.from || '09:00'} onChange={(e) => set({ from: e.target.value })} />
      <Input label="Até" type="time" value={r.to || '18:00'} onChange={(e) => set({ to: e.target.value })} />
    </div>);
    case 'country': return <Input label="DDIs (separados por vírgula)" value={(r.ddi || []).join(', ')} onChange={(e) => set({ ddi: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} hint="Ex.: 52 (México), 57 (Colômbia), 91 (Índia)" />;
    default: return null;
  }
}

function Inspector({ node, onChange, onDelete, isStart }) {
  const { templates, tags, integrations = [], pixels = [], channels = [] } = React.useContext(LookupsCtx);
  if (!node) return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Selecione um bloco para editar. Para ligar, arraste da bolinha de uma saída até outro bloco.</div>;
  const d = node.data.data || {};
  const set = (patch) => onChange({ ...d, ...patch });
  const b = BLOCKS[node.data.type];
  const tplOptions = [{ value: '', label: 'Selecionar…' }, ...templates.map((t) => ({ value: t.id, label: `${t.name} (${t.language})${t.status === 'APPROVED' ? '' : ' — ' + t.status}` }))];
  const varsFor = (tid, list, key) => {
    const t = templates.find((x) => x.id === tid);
    const n = (t && t.variable_count) || 0;
    if (!n) return null;
    const cur = Array.from({ length: n }, (_, i) => (list || [])[i] ?? '');
    return cur.map((v, i) => <Input key={i} label={`Variável {{${i + 1}}}`} value={v} placeholder="ex.: primeiro_nome ou {{produto}}" onChange={(e) => set({ [key]: cur.map((x, j) => (j === i ? e.target.value : x)) })} />);
  };
  let body = null;
  switch (node.data.type) {
    case 'trigger': body = (<>
      <div style={{ fontSize: 'var(--text-sm)' }}>Inicia quando chegar um destes eventos do checkout:</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>{TIPOS_EVENTO.map((ev) => (
        <Check key={ev} label={ev} checked={(d.events || []).includes(ev)} onChange={(on) => set({ events: on ? [...(d.events || []), ev] : (d.events || []).filter((x) => x !== ev) })} />))}</div>
      <Check label="Encerrar este fluxo se o lead comprar" checked={d.stop_on_purchase ?? !(d.events || []).includes('Compra Aprovada')} onChange={(v) => set({ stop_on_purchase: v })} />
    </>); break;
    case 'send_template': body = (<>
      <Select label="Modelo aprovado" value={d.template_id || ''} onChange={(e) => set({ template_id: e.target.value, vars: [] })} options={tplOptions} />
      {varsFor(d.template_id, d.vars, 'vars')}
    </>); break;
    case 'send_text': body = (<>
      <TextArea label="Mensagem" value={d.text} onChange={(v) => set({ text: v })} rows={6} hint={VARS_HELP} />
      <Select label="Modelo reserva (janela fechada)" value={d.fallback_template_id || ''} onChange={(e) => set({ fallback_template_id: e.target.value || undefined, fallback_vars: [] })} options={[{ value: '', label: 'Nenhum — sair por "Janela fechada"' }, ...tplOptions.slice(1)]} />
      {varsFor(d.fallback_template_id, d.fallback_vars, 'fallback_vars')}
    </>); break;
    case 'send_media': body = (<>
      <Select label="Tipo" value={d.kind || 'document'} onChange={(e) => set({ kind: e.target.value })} options={[{ value: 'image', label: 'Imagem' }, { value: 'audio', label: 'Áudio' }, { value: 'video', label: 'Vídeo (MP4)' }, { value: 'document', label: 'Documento (PDF)' }]} />
      <Input label="Link público (https)" value={d.url || ''} onChange={(e) => set({ url: e.target.value.trim() })} placeholder="https://..." />
      {d.kind !== 'audio' && <Input label="Legenda" value={d.caption || ''} onChange={(e) => set({ caption: e.target.value })} />}
      {d.kind === 'document' && <Input label="Nome do arquivo" value={d.filename || ''} onChange={(e) => set({ filename: e.target.value })} placeholder="material.pdf" />}
    </>); break;
    case 'send_buttons': body = (<>
      <TextArea label="Pergunta" value={d.text} onChange={(v) => set({ text: v })} hint="Até 3 opções aparecem como botões; de 4 a 10, como lista." />
      <ListEditor items={d.options || []} max={10} addLabel="Adicionar opção" onChange={(options) => set({ options })}
        make={(items) => ({ id: `opcao_${items.length + 1}`, title: `Opção ${items.length + 1}` })}
        render={(o, up) => <Input value={o.title} onChange={(e) => up({ title: e.target.value, id: slug(e.target.value) })} placeholder="Texto da opção" hint={`saída: opt_${o.id}`} />} />
      {(d.options || []).length > 3 && <Input label="Texto do botão da lista" value={d.list_button || ''} onChange={(e) => set({ list_button: e.target.value })} placeholder="Ver opções" />}
      <Input label="Salvar resposta em" value={d.save_as || 'resposta'} onChange={(e) => set({ save_as: e.target.value.trim() })} />
      <Input label="Prazo para responder (minutos)" type="number" value={d.timeout_minutes ?? ''} onChange={(e) => set({ timeout_minutes: num(e.target.value) })} hint="Vazio = até 30 dias" />
    </>); break;
    case 'delay': body = (<>
      <div style={{ display: 'flex', gap: 8 }}>
        <Input label="Mínimo (segundos)" type="number" value={d.min_seconds ?? d.seconds ?? ''} onChange={(e) => set({ min_seconds: num(e.target.value), seconds: undefined })} />
        <Input label="Máximo (segundos)" type="number" value={d.max_seconds ?? d.seconds ?? ''} onChange={(e) => set({ max_seconds: num(e.target.value), seconds: undefined })} />
      </div>
      <div style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>Tempo sorteado entre o mínimo e o máximo. 3600 = 1 hora · 86400 = 1 dia.</div>
      <Check label='Mostrar "digitando..." (com a conversa aberta)' checked={d.typing} onChange={(v) => set({ typing: v })} />
    </>); break;
    case 'wait_reply': body = (<>
      <Input label="Salvar resposta em" value={d.save_as || 'resposta'} onChange={(e) => set({ save_as: e.target.value.trim() })} hint="Use depois como {{resposta}}" />
      <Input label="Prazo (minutos)" type="number" value={d.timeout_minutes ?? ''} onChange={(e) => set({ timeout_minutes: num(e.target.value) })} hint="Vazio = até 30 dias. Dica: até 1380 (23 h) mantém a janela de 24 h aberta." />
    </>); break;
    case 'condition': body = (<>
      <Select label="Combinar regras" value={d.match || 'all'} onChange={(e) => set({ match: e.target.value })} options={[{ value: 'all', label: 'Todas (E)' }, { value: 'any', label: 'Qualquer uma (OU)' }]} />
      <ListEditor items={d.rules || []} max={10} addLabel="Adicionar regra" onChange={(rules) => set({ rules })}
        make={() => ({ kind: 'var', name: 'resposta', op: 'contains', value: '' })}
        render={(r, up) => (<>
          <Select value={r.kind} onChange={(e) => up({ kind: e.target.value, op: e.target.value === 'tag' ? 'has' : e.target.value === 'var' ? 'eq' : undefined })} options={RULE_KINDS} />
          <RuleFields r={r} set={up} tags={tags} />
        </>)} />
    </>); break;
    case 'ai_classify': body = (<>
      <Input label="Texto analisado" value={d.input || '{{resposta}}'} onChange={(e) => set({ input: e.target.value })} />
      <TextArea label="Contexto para a IA (opcional)" value={d.instructions} onChange={(v) => set({ instructions: v })} rows={3} hint="Ex.: estamos oferecendo o guia por $45 MXN." />
      <ListEditor items={d.outputs || []} max={8} addLabel="Adicionar saída" onChange={(outputs) => set({ outputs })}
        make={(items) => ({ key: `saida_${items.length + 1}`, description: '' })}
        render={(o, up) => (<>
          <Input value={o.key} onChange={(e) => up({ key: slug(e.target.value) })} placeholder="chave (ex.: sim)" />
          <Input value={o.description} onChange={(e) => up({ description: e.target.value })} placeholder="quando usar (ex.: aceitou a oferta)" />
        </>)} />
      <Input label="Salvar a escolha em" value={d.save_as || 'classificacao'} onChange={(e) => set({ save_as: e.target.value.trim() })} />
    </>); break;
    case 'ai_extract': body = (<>
      <Input label="Texto analisado" value={d.input || '{{resposta}}'} onChange={(e) => set({ input: e.target.value })} />
      <TextArea label="Contexto para a IA (opcional)" value={d.instructions} onChange={(v) => set({ instructions: v })} rows={3} />
      <ListEditor items={d.fields || []} max={8} addLabel="Adicionar campo" onChange={(fields) => set({ fields })}
        make={(items) => ({ name: `campo_${items.length + 1}`, description: '', required: true })}
        render={(f, up) => (<>
          <Input value={f.name} onChange={(e) => up({ name: slug(e.target.value) })} placeholder="nome da variável" />
          <Input value={f.description} onChange={(e) => up({ description: e.target.value })} placeholder="o que extrair" />
          <Check label="Obrigatório" checked={f.required !== false} onChange={(v) => up({ required: v })} />
        </>)} />
    </>); break;
    case 'payment': {
      const metodos = PAYMENT_METHODS[d.currency] || [];
      const abertoOk = d.currency === 'BRL' || (d.currency === 'MXN' && d.method === 'SPEI');
      const pref = d.save_as || 'pagamento';
      body = (<>
        {integrations.length === 0 && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--amber-600)' }}>Nenhuma conta de gateway conectada. Conecte em Integrações → Pagamentos e Pixel.</div>}
        <Select label="Conta do gateway" value={d.integration_id || ''} onChange={(e) => set({ integration_id: e.target.value })}
          options={[{ value: '', label: 'Selecionar…' }, ...integrations.map((i) => ({ value: i.id, label: `XPag · ${i.label}${i.sandbox ? ' (sandbox)' : ''}` }))]} />
        <Select label="País e moeda" value={d.currency || 'BRL'} onChange={(e) => { const c = e.target.value; set({ currency: c, method: (PAYMENT_METHODS[c] || [[]])[0][0], open_amount: false }); }}
          options={Object.keys(PAYMENT_METHODS).map((c) => ({ value: c, label: CURRENCY_LABEL[c] || c }))} />
        <Select label="Método" value={d.method || ''} onChange={(e) => set({ method: e.target.value, ...(e.target.value === 'OXXO' ? { open_amount: false } : {}) })} options={metodos.map(([value, label]) => ({ value, label }))} />
        {abertoOk && <Check label="Valor livre (o lead paga o quanto quiser)" checked={d.open_amount} onChange={(v) => set({ open_amount: v })} />}
        {!d.open_amount && <Input label="Valor" value={d.amount ?? ''} onChange={(e) => set({ amount: e.target.value })} placeholder="45 ou {{valor}}" hint={d.method === 'OXXO' ? 'OXXO aceita de 10 a 10.000 MXN.' : 'Número ou variável.'} />}
        <Input label="Nome do pagador" value={d.payer_name || ''} onChange={(e) => set({ payer_name: e.target.value })} placeholder="{{nome}}" />
        {(d.currency === 'ARS' || d.currency === 'CLP') && <Input label={d.currency === 'ARS' ? 'CUIT (opcional)' : 'RUT'} value={d.document || ''} onChange={(e) => set({ document: e.target.value })} />}
        <Input label="Descrição (aparece para o pagador)" value={d.description || ''} onChange={(e) => set({ description: e.target.value })} placeholder="{{produto}}" />
        <Input label="Escutar o pagamento por (horas)" type="number" value={d.listen_hours ?? 48} onChange={(e) => set({ listen_hours: num(e.target.value) })} hint="Se o lead pagar dentro desse prazo, o fluxo pula para a saída Pago, esteja onde estiver." />
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', lineHeight: 1.6 }}>
          Variáveis para a mensagem seguinte: {`{{${pref}_codigo}}`} (Pix copia-e-cola, CLABE, referência OXXO), {`{{${pref}_qr}}`} (link da imagem do QR), {`{{${pref}_link}}`}, {`{{${pref}_valor}}`}
          {d.method === 'SPEI' ? `, {{${pref}_banco}}, {{${pref}_beneficiario}}` : ''}.
        </div>
      </>);
      break;
    }
    case 'ai_agent': body = (<>
      <TextArea label="Objetivo do agente" value={d.objective} onChange={(v) => set({ objective: v })} rows={3} hint="O que conta como sucesso. Ex.: tirar dúvidas e levar o lead a pagar o guia de $45 MXN." />
      <TextArea label="Base de conhecimento" value={d.knowledge} onChange={(v) => set({ knowledge: v })} rows={6} hint="Preço, entrega, garantia, perguntas frequentes. O agente não promete nada fora daqui." />
      <Input label="Tom de voz" value={d.tone || ''} onChange={(e) => set({ tone: e.target.value || undefined })} placeholder="amigável e direto" />
      <TextArea label="Mensagem de abertura (opcional)" value={d.opening} onChange={(v) => set({ opening: v || undefined })} rows={2} hint="Vazio: o agente responde a última mensagem do lead (ou espera ele escrever)." />
      <div style={{ display: 'flex', gap: 8 }}>
        <Input label="Máx. de respostas" type="number" value={d.max_turns ?? 10} onChange={(e) => set({ max_turns: num(e.target.value) })} />
        <Input label="Prazo sem resposta (min)" type="number" value={d.timeout_minutes ?? 60} onChange={(e) => set({ timeout_minutes: num(e.target.value) })} />
      </div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Saídas: Concluiu, Pediu humano (ligue num Alerta), Sem resposta e Erro. A última resposta fica em {'{{agente_resposta}}'}.</div>
    </>); break;
    case 'split': body = (<>
      <ListEditor items={d.variants || []} max={6} addLabel="Adicionar caminho" onChange={(variants) => set({ variants })}
        make={(items) => ({ id: String.fromCharCode(97 + items.length), weight: 50 })}
        render={(v, up) => (<div style={{ display: 'flex', gap: 6 }}>
          <Input value={v.id} onChange={(e) => up({ id: slug(e.target.value).slice(0, 10) })} placeholder="a" style={{ width: 70 }} />
          <Input type="number" value={v.weight} onChange={(e) => up({ weight: num(e.target.value) })} hint="peso %" />
        </div>)} />
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Use "Métricas" para comparar quantos leads de cada caminho chegam à venda.</div>
    </>); break;
    case 'checkpoint': body = <Input label="Nome do ponto" value={d.name || ''} onChange={(e) => set({ name: e.target.value })} placeholder="viu a oferta" />; break;
    case 'wait_until': body = (<>
      <Select label="Esperar até" value={d.mode || 'business_hours'} onChange={(e) => set({ mode: e.target.value })} options={[{ value: 'business_hours', label: 'Próximo horário de atendimento' }, { value: 'datetime', label: 'Data e hora' }]} />
      {d.mode === 'datetime' ? (
        <Input label="Data e hora" value={d.at || ''} onChange={(e) => set({ at: e.target.value })} placeholder="2026-11-01 09:00 ou {{data_live}}" hint="No fuso da empresa (Configurações)." />
      ) : (<>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{DIAS.map((dn, i) => (
          <Check key={i} label={dn} checked={(d.days || []).includes(i)} onChange={(on) => set({ days: on ? [...(d.days || []), i].sort() : (d.days || []).filter((x) => x !== i) })} />))}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Input label="Abre" type="time" value={d.from || '09:00'} onChange={(e) => set({ from: e.target.value })} />
          <Input label="Fecha" type="time" value={d.to || '18:00'} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Dentro do horário, segue na hora. Fora, espera a próxima abertura (no fuso da empresa).</div>
      </>)}
    </>); break;
    case 'notify': body = (<>
      {channels.length === 0 && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--amber-600)' }}>Nenhum canal de alerta. Conecte um bot do Telegram em Integrações → Pagamentos, Pixel e alertas.</div>}
      <Select label="Canal" value={d.channel_id || ''} onChange={(e) => set({ channel_id: e.target.value })} options={[{ value: '', label: 'Selecionar…' }, ...channels.map((c) => ({ value: c.id, label: `Telegram · ${c.label}` }))]} />
      <TextArea label="Texto do alerta" value={d.text} onChange={(v) => set({ text: v })} rows={4} hint={VARS_HELP} />
      <Input label="Outro chat (opcional)" value={d.chat_id || ''} onChange={(e) => set({ chat_id: e.target.value || undefined })} placeholder="vazio = chat padrão do canal" />
    </>); break;
    case 'record_sale': body = (<>
      <Input label="Valor (opcional)" value={d.amount ?? ''} onChange={(e) => set({ amount: e.target.value || undefined })} placeholder="vazio = valor pago na cobrança" />
      <Input label="Moeda (opcional)" value={d.currency ?? ''} onChange={(e) => set({ currency: e.target.value.toUpperCase() || undefined })} placeholder="vazio = moeda da cobrança" />
      <Input label="Produto (opcional)" value={d.product ?? ''} onChange={(e) => set({ product: e.target.value || undefined })} placeholder="{{produto}}" />
    </>); break;
    case 'pixel': body = (<>
      {pixels.length === 0 && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--amber-600)' }}>Nenhum Pixel cadastrado. Cadastre em Integrações → Pagamentos e Pixel.</div>}
      <Select label="Pixel" value={d.pixel_config_id || ''} onChange={(e) => set({ pixel_config_id: e.target.value })} options={[{ value: '', label: 'Selecionar…' }, ...pixels.map((p) => ({ value: p.id, label: `${p.label} (${p.pixel_id})` }))]} />
      <Select label="Evento" value={d.event || 'Purchase'} onChange={(e) => set({ event: e.target.value })}
        options={[{ value: 'Purchase', label: 'Compra (Purchase)' }, { value: 'Lead', label: 'Lead' }, { value: 'InitiateCheckout', label: 'Iniciou checkout' }, { value: 'AddPaymentInfo', label: 'Gerou pagamento' }]} />
      <Input label="Valor (opcional)" value={d.value ?? ''} onChange={(e) => set({ value: e.target.value || undefined })} placeholder={d.event === 'Purchase' ? 'vazio = valor pago na cobrança' : ''} />
    </>); break;
    case 'tag': body = (<>
      {['add', 'remove'].map((k) => (
        <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <strong style={{ fontSize: 'var(--text-sm)' }}>{k === 'add' ? 'Adicionar' : 'Remover'}</strong>
          {tags.length === 0 && <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>Nenhuma etiqueta criada ainda.</span>}
          {tags.map((t) => <Check key={t.id} label={t.nome} checked={(d[k] || []).includes(t.id)} onChange={(on) => set({ [k]: on ? [...(d[k] || []), t.id] : (d[k] || []).filter((x) => x !== t.id) })} />)}
        </div>))}
    </>); break;
    case 'set_var': body = (<>
      <Input label="Variável" value={d.name || ''} onChange={(e) => set({ name: e.target.value.trim() })} />
      <Select label="Operação" value={d.op || 'set'} onChange={(e) => set({ op: e.target.value })} options={[{ value: 'set', label: 'Definir' }, { value: 'add', label: 'Somar' }, { value: 'subtract', label: 'Subtrair' }, { value: 'multiply', label: 'Multiplicar' }, { value: 'divide', label: 'Dividir' }]} />
      <Input label="Valor" value={d.value ?? ''} onChange={(e) => set({ value: e.target.value })} hint="Aceita {{variáveis}}" />
    </>); break;
    default: body = null;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: TONES[b.tone] }}><Icon name={b.icon} size={18} /></span>
        <strong style={{ flex: 1, color: 'var(--text-strong)' }}>{b.label}</strong>
        {!isStart && <IconButton icon="trash-2" size="sm" aria-label="Excluir bloco" onClick={onDelete} />}
      </div>
      <div style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>{b.hint}</div>
      {body}
    </div>
  );
}

// ---- Editor -----------------------------------------------------------------------
function Editor({ campaign, onBack, api, notify }) {
  const rf = useReactFlow();
  const wrap = useRef(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selId, setSelId] = useState(null);
  const [lookups, setLookups] = useState({ templates: [], tags: [] });
  const [state, setState] = useState({ loading: true, error: null, version: null, versions: [] });
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [metrics, setMetrics] = useState(null); // ref → { leads, here } (contador por bloco)
  const [copilot, setCopilot] = useState(null); // { leads, suggestions, summary }
  async function runCopilot() {
    if (copilot) { setCopilot(null); return; }
    const r = await call('copilot', { campaign_id: campaign.id });
    if (r.error) { notify('danger', r.error); return; }
    setCopilot(r);
    if (!r.suggestions.length) notify('info', r.leads ? 'O copiloto não encontrou problemas com os dados atuais.' : 'Ainda não há leads suficientes neste fluxo para analisar.');
  }
  async function toggleMetrics() {
    if (metrics) { setMetrics(null); return; }
    const r = await call('stats', { campaign_id: campaign.id });
    if (r.error) { notify('danger', r.error); return; }
    const m = {};
    for (const x of r.by_ref || []) m[x.ref] = { leads: x.leads, here: 0 };
    for (const x of r.waiting_at || []) m[x.ref] = { ...(m[x.ref] || { leads: 0 }), here: x.leads };
    setMetrics(m);
    const total = (r.by_status || []).reduce((s, x) => s + x.n, 0);
    notify('info', `${total} lead(s) já passaram por este fluxo.`);
  }

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    const opt = (fn) => (fn ? fn() : Promise.resolve([])).catch(() => []);
    const [g, templates, tags, integrations, pixels, channels] = await Promise.all([
      api.flowGraph('get', { campaign_id: campaign.id }),
      opt(api.listTemplates), opt(api.getTags), opt(api.listIntegrations), opt(api.listPixels), opt(api.listChannels),
    ]);
    if (g.error) { setState((s) => ({ ...s, loading: false, error: g.error })); return; }
    const c = toCanvas(g.active ? g.active.graph : emptyGraph());
    setNodes(c.nodes); setEdges(c.edges); setDirty(false); setReport(null); setMetrics(null);
    setLookups({ templates: templates || [], tags: tags || [], integrations: integrations || [], pixels: pixels || [], channels: channels || [] });
    setState({ loading: false, error: null, version: g.active ? g.active.version : null, versions: g.versions || [], viewing: null });
    setCopilot(null);
    setCanvasKey((k) => k + 1); // remonta o canvas: o fitView nativo enquadra depois de medir os blocos
  }, [api, campaign.id, setEdges, setNodes]);
  const [canvasKey, setCanvasKey] = useState(0);
  useEffect(() => { load(); }, [load]);

  const graph = useCallback(() => fromCanvas(rf.getNodes(), rf.getEdges(), 'ini'), [rf]);
  const touch = () => { setDirty(true); setReport(null); };

  // uma saída liga a UM bloco: religar substitui a ligação anterior
  const onConnect = useCallback((c) => {
    if (c.source === c.target) return;
    setEdges((eds) => addEdge({ ...c, id: `${c.source}:${c.sourceHandle}`, type: 'smoothstep' }, eds.filter((e) => !(e.source === c.source && e.sourceHandle === c.sourceHandle))));
    touch();
  }, [setEdges]);

  const addBlock = useCallback((type, position) => {
    const taken = new Set(rf.getNodes().map((n) => n.id));
    const ref = newRef(type, taken);
    const pos = position || (() => {
      const box = wrap.current ? wrap.current.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
      return rf.screenToFlowPosition({ x: box.left + box.width / 2 - 120 + (taken.size % 5) * 16, y: box.top + box.height / 2 - 60 + (taken.size % 5) * 16 });
    })();
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id: ref, type: 'kobly', position: pos, selected: true, data: { type, data: BLOCKS[type].make(), isStart: false } }]);
    setSelId(ref); touch();
  }, [rf, setNodes]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/kobly-block');
    if (!BLOCKS[type]) return;
    addBlock(type, rf.screenToFlowPosition({ x: e.clientX - 120, y: e.clientY - 20 }));
  }, [addBlock, rf]);

  const selected = nodes.find((n) => n.id === selId) || null;
  const updateSelected = (data) => {
    setNodes((ns) => ns.map((n) => (n.id === selId ? { ...n, data: { ...n.data, data } } : n)));
    // saídas que deixaram de existir (opção/saída removida) perdem a ligação
    const valid = new Set(exitsOf({ type: selected.data.type, data }).map(([k]) => k));
    setEdges((eds) => eds.filter((e) => e.source !== selId || valid.has(e.sourceHandle)));
    touch();
  };
  const deleteSelected = () => {
    if (!selected || selected.data.isStart) return;
    setNodes((ns) => ns.filter((n) => n.id !== selId));
    setEdges((eds) => eds.filter((e) => e.source !== selId && e.target !== selId));
    setSelId(null); touch();
  };

  // chamada ao servidor que SEMPRE destrava os botões, mesmo se a rede/servidor falhar
  const call = async (action, extra) => {
    setBusy(true);
    try { return await api.flowGraph(action, extra); }
    catch (e) { return { error: (e && e.message) || 'Falha ao falar com o servidor.' }; }
    finally { setBusy(false); }
  };
  async function validate() {
    const r = await call('validate', { graph: graph() });
    if (r.error) { notify('danger', r.error); return; }
    setReport({ ok: r.ok, errors: r.errors || [], warnings: r.warnings || [] });
    if (r.ok) notify('success', r.warnings && r.warnings.length ? 'Fluxo válido, com avisos.' : 'Fluxo válido.');
  }
  async function save() {
    const r = await call('save', { campaign_id: campaign.id, graph: graph() });
    if (r.error) { setReport(r.details ? { ok: false, errors: r.details.errors || [r.error], warnings: r.details.warnings || [] } : { ok: false, errors: [r.error], warnings: [] }); notify('danger', 'Corrija os erros antes de publicar.'); return; }
    setReport({ ok: true, errors: [], warnings: r.warnings || [] });
    setDirty(false);
    notify('success', `Versão ${r.version} publicada. Os próximos leads já usam este fluxo.`);
    const g = await api.flowGraph('get', { campaign_id: campaign.id });
    if (!g.error) setState((s) => ({ ...s, version: g.active ? g.active.version : null, versions: g.versions || [], viewing: null }));
  }
  // Publicar uma versão existente (rascunho da IA ou versão antiga). O servidor revalida antes.
  async function activate(version) {
    if (dirty && !confirm('Há alterações não salvas no canvas. Publicar a versão escolhida descarta essas alterações. Continuar?')) return;
    const r = await call('activate', { campaign_id: campaign.id, version: Number(version) });
    if (r.error) { if (r.details) setReport({ ok: false, errors: r.details.errors || [r.error], warnings: r.details.warnings || [] }); notify('danger', r.error); return; }
    notify('success', `Versão ${version} publicada. Os próximos leads já usam este fluxo.`);
    load();
  }
  // Abrir uma versão no canvas para revisar (não publica nada).
  async function openVersion(version) {
    if (dirty && !confirm('Há alterações não salvas no canvas. Abrir outra versão descarta essas alterações. Continuar?')) return;
    if (Number(version) === state.version && !state.viewing) return;
    if (Number(version) === state.version) { load(); return; }
    const r = await call('get_version', { campaign_id: campaign.id, version: Number(version) });
    if (r.error) { notify('danger', r.error); return; }
    const c = toCanvas(r.graph);
    setNodes(c.nodes); setEdges(c.edges); setDirty(false); setReport(null); setMetrics(null); setCopilot(null);
    setState((s) => ({ ...s, viewing: { version: r.version, is_draft: r.is_draft, source: r.source, note: r.note } }));
    setCanvasKey((k) => k + 1);
  }
  async function saveDraft() {
    const note = prompt('Nota do rascunho (opcional): o que mudou?') ?? null;
    if (note === null) return;
    const r = await call('save_draft', { campaign_id: campaign.id, graph: graph(), note: note || undefined });
    if (r.error) { setReport(r.details ? { ok: false, errors: r.details.errors || [r.error], warnings: r.details.warnings || [] } : { ok: false, errors: [r.error], warnings: [] }); notify('danger', 'Corrija os erros antes de salvar.'); return; }
    setDirty(false);
    notify('success', `Rascunho salvo como versão ${r.version}. Nada mudou para os leads até publicar.`);
    const g = await api.flowGraph('get', { campaign_id: campaign.id });
    if (!g.error) setState((s) => ({ ...s, versions: g.versions || [], viewing: { version: r.version, is_draft: true, source: 'editor', note } }));
  }
  const versionLabel = (v) => `Versão ${v.version}${v.is_active ? ' (publicada)' : v.is_draft ? (v.source === 'mcp' ? ' (rascunho da IA)' : ' (rascunho)') : ''}`;
  async function deactivate() {
    if (!confirm('Desligar o fluxo em grafo? A campanha volta a usar a lista de etapas antiga. As versões ficam guardadas.')) return;
    const r = await api.flowGraph('deactivate', { campaign_id: campaign.id });
    if (r.error) { notify('danger', r.error); return; }
    notify('info', 'Fluxo em grafo desligado para esta campanha.');
    load();
  }
  const back = () => { if (!dirty || confirm('Sair sem publicar as alterações?')) onBack(); };
  const focusRef = (msg) => {
    const m = /bloco "([^"]+)"|"([^"]+)" não é alcançado/.exec(msg);
    const ref = m && (m[1] || m[2]);
    const n = ref && rf.getNode(ref);
    if (n) { setSelId(ref); setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === ref }))); rf.setCenter(n.position.x + 120, n.position.y + 60, { zoom: 1.1, duration: 300 }); }
  };

  if (state.error) return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ color: 'var(--red-500)' }}>{state.error}</div>
      <div style={{ display: 'flex', gap: 8 }}><Button variant="secondary" onClick={onBack} iconLeft="arrow-left">Voltar</Button><Button onClick={load} iconLeft="refresh-cw">Tentar de novo</Button></div>
    </div>
  );

  return (
    <LookupsCtx.Provider value={{ ...lookups, metrics }}>
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)', minHeight: 520, gap: 10 }}>
        {/* barra superior */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <IconButton icon="arrow-left" aria-label="Voltar" onClick={back} />
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{campaign.nome || 'Campanha'}</div>
            <div style={{ fontSize: 'var(--text-xs)', color: state.viewing ? 'var(--amber-600)' : 'var(--text-muted)' }}>
              {state.viewing
                ? `Revisando versão ${state.viewing.version}${state.viewing.is_draft ? (state.viewing.source === 'mcp' ? ' · rascunho criado pela IA' : ' · rascunho') : ' · versão antiga'}${state.viewing.note ? ` · "${state.viewing.note}"` : ''} — os leads seguem na versão ${state.version || 'publicada'}`
                : `Fluxo em grafo · ${state.version ? `versão ${state.version} publicada` : 'ainda não publicado'}`}
              {dirty ? ' · alterações não salvas' : ''}
            </div>
          </div>
          {state.versions.length > 0 && (
            <Select value={String((state.viewing && state.viewing.version) || state.version || '')} onChange={(e) => e.target.value && openVersion(e.target.value)} style={{ minWidth: 190 }}
              options={[...(state.version || state.viewing ? [] : [{ value: '', label: 'Versões…' }]), ...state.versions.map((v) => ({ value: String(v.version), label: versionLabel(v) }))]} />
          )}
          {state.viewing ? (<>
            <Button variant="ghost" size="sm" onClick={() => openVersion(state.version || state.viewing.version)} disabled={!state.version}>Voltar à publicada</Button>
            <Button onClick={() => activate(state.viewing.version)} loading={busy} iconLeft="send" disabled={dirty}>Publicar esta versão</Button>
          </>) : (<>
            {state.version && <Button variant={copilot ? 'primary' : 'secondary'} size="sm" iconLeft="sparkles" onClick={runCopilot}>Copiloto</Button>}
            {state.version && <Button variant={metrics ? 'primary' : 'secondary'} size="sm" iconLeft="chart-column" onClick={toggleMetrics}>Métricas</Button>}
            {state.version && <Button variant="ghost" size="sm" onClick={deactivate}>Desligar</Button>}
          </>)}
          <Button variant="secondary" onClick={validate} loading={busy} iconLeft="check">Validar</Button>
          <Button variant="secondary" onClick={saveDraft} loading={busy} iconLeft="file-text" disabled={state.loading}>Salvar rascunho</Button>
          {!state.viewing && <Button onClick={save} loading={busy} iconLeft="send" disabled={state.loading}>Publicar</Button>}
          {state.viewing && dirty && <Button onClick={save} loading={busy} iconLeft="send">Publicar alterações</Button>}
        </div>

        <div style={{ display: 'flex', gap: 10, flex: 1, minHeight: 0 }}>
          {/* paleta */}
          <div style={{ width: 190, flex: 'none', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: 10, background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
            {PALETTE_GROUPS.map((grp) => (
              <div key={grp} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{grp}</div>
                {Object.entries(BLOCKS).filter(([, b]) => b.group === grp).map(([type, b]) => (
                  <button key={type} type="button" draggable title={b.hint}
                    onDragStart={(e) => { e.dataTransfer.setData('application/kobly-block', type); e.dataTransfer.effectAllowed = 'move'; }}
                    onClick={() => addBlock(type)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-body)', cursor: 'grab', textAlign: 'left', fontSize: 'var(--text-sm)' }}>
                    <span style={{ color: TONES[b.tone], display: 'flex' }}><Icon name={b.icon} size={15} /></span>{b.label}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* canvas */}
          <div ref={wrap} style={{ flex: 1, minWidth: 0, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--surface-sunken)' }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }} onDrop={onDrop}>
            <ReactFlow key={canvasKey} nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode="dark" fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
              onNodesChange={(ch) => { onNodesChange(ch); if (ch.some((c) => c.type === 'position' || c.type === 'remove')) touch(); }}
              onEdgesChange={(ch) => { onEdgesChange(ch); if (ch.some((c) => c.type === 'remove')) touch(); }}
              onConnect={onConnect} onSelectionChange={({ nodes: sel }) => setSelId(sel.length === 1 ? sel[0].id : null)}
              defaultEdgeOptions={{ type: 'smoothstep' }} deleteKeyCode={['Delete', 'Backspace']} minZoom={0.2} maxZoom={1.75} proOptions={{ hideAttribution: true }}>
              <Background gap={20} size={1} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable style={{ background: 'var(--surface-card)', width: 150, height: 100 }} />
            </ReactFlow>
          </div>

          {/* propriedades + validação */}
          <div style={{ width: 320, flex: 'none', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: 12, background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
            {report && (report.errors.length > 0 || report.warnings.length > 0) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {report.errors.map((m, i) => <button key={'e' + i} type="button" onClick={() => focusRef(m)} style={{ textAlign: 'left', background: 'var(--red-tint)', color: 'var(--red-500)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontSize: 'var(--text-xs)', cursor: 'pointer' }}>{m}</button>)}
                {report.warnings.map((m, i) => <button key={'w' + i} type="button" onClick={() => focusRef(m)} style={{ textAlign: 'left', background: 'var(--amber-tint)', color: 'var(--amber-600)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontSize: 'var(--text-xs)', cursor: 'pointer' }}>{m}</button>)}
              </div>
            )}
            {report && report.ok && report.errors.length === 0 && report.warnings.length === 0 && <Badge tone="success">Fluxo válido</Badge>}
            {copilot && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 12, borderBottom: '1px solid var(--border-subtle)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: TONES.purple, display: 'flex' }}><Icon name="sparkles" size={16} /></span>
                  <strong style={{ flex: 1, color: 'var(--text-strong)' }}>Copiloto</strong>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{copilot.leads} leads analisados</span>
                </div>
                {copilot.summary && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)', lineHeight: 1.5 }}>{copilot.summary}</div>}
                {copilot.suggestions.map((s, i) => {
                  const c = s.severity === 'alta' ? 'var(--red-500)' : s.severity === 'media' ? 'var(--amber-600)' : TONES.blue;
                  return (
                    <button key={i} type="button" onClick={() => s.ref && focusRef(`bloco "${s.ref}"`)} style={{ textAlign: 'left', background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', borderLeft: `3px solid ${c}`, borderRadius: 'var(--radius-sm)', padding: '8px 10px', cursor: s.ref ? 'pointer' : 'default', display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-strong)', fontSize: 'var(--text-sm)' }}>{s.title}{s.ref ? <span style={{ color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)', fontWeight: 400, fontSize: 10 }}> · {s.ref}</span> : null}</span>
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{s.detail}</span>
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-body)' }}>→ {s.action}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <Inspector node={selected} isStart={!!(selected && selected.data.isStart)} onChange={updateSelected} onDelete={deleteSelected} />
          </div>
        </div>
      </div>
    </LookupsCtx.Provider>
  );
}

function KoblyFlowGraphEditor({ campaign, onBack, api = defaultApi, notify = (tone, msg) => console.log(`[${tone}] ${msg}`) }) {
  return <ReactFlowProvider><Editor campaign={campaign} onBack={onBack} api={api} notify={notify} /></ReactFlowProvider>;
}
export { KoblyFlowGraphEditor };
