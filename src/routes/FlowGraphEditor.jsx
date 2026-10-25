import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, BaseEdge, ConnectionLineType, Controls, EdgeLabelRenderer, MiniMap, Handle, Position, addEdge, getBezierPath, useEdgesState, useNodesState, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Button, Icon, IconButton, Input, Select } from '@/ds';
import { BLOCKS, MEDIA, PALETTE_GROUPS, TONES, TIPOS_EVENTO, PAYMENT_METHODS, CURRENCY_LABEL, exitsOf, newRef, emptyGraph, toCanvas, fromCanvas, summaryOf, paletteItems, metaOf, edgeTone } from '@/lib/flowGraph.js';

// Kobly — Editor visual do fluxo em grafo (motor novo). Blocos ligados por saídas nomeadas:
// paleta → arrasta/clica para adicionar, liga uma saída a outro bloco, clica no bloco para editar (janela),
// valida no servidor e publica uma nova versão (dá para voltar a qualquer versão). KoblyFlowGraphEditor

const defaultApi = {
  flowGraph: (...a) => KoblyApi.flowGraph(...a),
  listTemplates: () => KoblyApi.listWhatsappTemplates(),
  getTags: () => KoblyApi.getTags(),
  listIntegrations: () => KoblyApi.paymentIntegrations('list').then((r) => r.integrations || []),
  listPixels: () => KoblyApi.pixelConfigs('list').then((r) => r.pixels || []),
  listChannels: () => KoblyApi.notifyChannels('list').then((r) => r.channels || []),
  listAgents: () => KoblyApi.workspaceSettings('get').then((r) => r.agents || []),
  uploadMedia: (file) => KoblyApi.uploadFlowMedia(file),
};

const LookupsCtx = React.createContext({ templates: [], tags: [], integrations: [], pixels: [], channels: [], agents: [], metrics: null, uploadMedia: null });
const VARS_HELP = '{{nome}} {{primeiro_nome}} {{produto}} {{valor}} {{cta_link}} {{resposta}} {{hora_atual}} {{dia_semana}} {{global.chave}} {{campo.chave}} · depois da Cobrança: {{pagamento_codigo}} {{pagamento_qr}} {{pagamento_link}} {{pagamento_valor}}';

// Linhas: gradiente ciano → violeta (caminho normal), âmbar (desvio) e rosa (falha), com um pulso correndo.
const EDGE = {
  ok: { from: '#22d3ee', to: '#a78bfa', glow: '#8b5cf6' },
  warn: { from: '#fbbf24', to: '#f59e0b', glow: '#f59e0b' },
  danger: { from: '#fb7185', to: '#f43f5e', glow: '#f43f5e' },
};

const FLOW_CSS = `
.kf-canvas { position: relative; background:
  radial-gradient(900px 520px at 12% -8%, rgba(139,92,246,.16), transparent 62%),
  radial-gradient(800px 480px at 105% 108%, rgba(34,211,238,.12), transparent 60%),
  #090b11; }
.kf-canvas .react-flow { --xy-background-color: transparent; --xy-controls-button-background-color: rgba(20,23,33,.92); --xy-controls-button-border-color: rgba(255,255,255,.06); --xy-minimap-background-color: rgba(14,16,24,.92); }
.kf-canvas .react-flow__controls { border-radius: 12px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.08); }
.kf-canvas .react-flow__minimap { border-radius: 12px; overflow: hidden; border: 1px solid rgba(255,255,255,.08); }
.kf-node { width: 252px; position: relative; border-radius: 16px; font-size: 12px; color: var(--text-body);
  background: linear-gradient(180deg, rgba(255,255,255,.055), rgba(255,255,255,.015)), rgba(17,20,30,.94);
  border: 1px solid rgba(255,255,255,.09); box-shadow: 0 10px 30px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter: blur(8px); transition: border-color .15s, box-shadow .2s, transform .15s; cursor: pointer; }
.kf-node::before { content: ''; position: absolute; left: 14px; right: 14px; top: -1px; height: 2px; border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--tone), transparent); opacity: .9; }
.kf-node:hover { border-color: color-mix(in srgb, var(--tone) 45%, rgba(255,255,255,.12)); box-shadow: 0 14px 36px rgba(0,0,0,.5), 0 0 22px color-mix(in srgb, var(--tone) 18%, transparent); }
.kf-node.sel { border-color: color-mix(in srgb, var(--tone) 80%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--tone) 70%, transparent), 0 0 34px color-mix(in srgb, var(--tone) 34%, transparent), 0 14px 36px rgba(0,0,0,.5); }
.kf-ico { width: 30px; height: 30px; flex: none; border-radius: 10px; display: grid; place-items: center; color: var(--tone);
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--tone) 34%, transparent), color-mix(in srgb, var(--tone) 10%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 38%, transparent), 0 0 14px color-mix(in srgb, var(--tone) 22%, transparent); }
.kf-ref { font-family: var(--font-mono); font-size: 10px; color: var(--text-subtle); background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.06); border-radius: 6px; padding: 1px 6px; }
.kf-exit { position: relative; display: flex; align-items: center; justify-content: flex-end; gap: 6px; padding: 5px 20px 5px 12px; color: var(--text-muted); font-size: 11px; }
.kf-exit + .kf-exit { border-top: 1px dashed rgba(255,255,255,.05); }
.kf-exit .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ec); box-shadow: 0 0 8px var(--ec); }
.kf-canvas .react-flow__handle.kf-h { width: 13px; height: 13px; border: 2px solid #0d1018; background: var(--hc); box-shadow: 0 0 0 3px color-mix(in srgb, var(--hc) 22%, transparent), 0 0 12px var(--hc); transition: transform .12s; }
.kf-canvas .react-flow__handle.kf-h:hover { transform: translate(50%, -50%) scale(1.3); }
.kf-canvas .react-flow__handle-left.kf-h:hover { transform: translate(-50%, -50%) scale(1.3); }
.kf-live { width: 8px; height: 8px; border-radius: 50%; background: #34d399; box-shadow: 0 0 0 0 rgba(52,211,153,.6); animation: kf-pulse 1.8s infinite; }
@keyframes kf-pulse { 0% { box-shadow: 0 0 0 0 rgba(52,211,153,.55); } 70% { box-shadow: 0 0 0 9px rgba(52,211,153,0); } 100% { box-shadow: 0 0 0 0 rgba(52,211,153,0); } }
.kf-flow { animation: kf-dash 1.4s linear infinite; }
@keyframes kf-dash { to { stroke-dashoffset: -32; } }
.kf-edge-del { width: 22px; height: 22px; border-radius: 50%; border: 1px solid rgba(255,255,255,.18); background: rgba(15,17,26,.95); color: #fda4af; cursor: pointer; display: grid; place-items: center; box-shadow: 0 0 12px rgba(244,63,94,.45); }
.kf-pal { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 9px; border-radius: 11px; cursor: grab; text-align: left; font-size: var(--text-sm); color: var(--text-body);
  background: rgba(255,255,255,.025); border: 1px solid rgba(255,255,255,.06); transition: border-color .15s, background .15s, box-shadow .15s, transform .12s; }
.kf-pal:hover { background: rgba(255,255,255,.05); border-color: color-mix(in srgb, var(--tone) 50%, transparent); box-shadow: 0 0 16px color-mix(in srgb, var(--tone) 18%, transparent); transform: translateX(2px); }
.kf-pal .kf-ico { width: 26px; height: 26px; border-radius: 8px; }
.kf-glass { background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.015)), rgba(14,16,24,.92); border: 1px solid rgba(255,255,255,.08); box-shadow: 0 18px 50px rgba(0,0,0,.55); backdrop-filter: blur(14px); }
.kf-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 16px; background: rgba(4,6,12,.62); backdrop-filter: blur(6px); animation: kf-fade .15s ease-out; }
.kf-modal { width: min(600px, 100%); max-height: 88vh; display: flex; flex-direction: column; border-radius: 20px; overflow: hidden; animation: kf-pop .18s cubic-bezier(.2,.9,.3,1.2); position: relative; }
.kf-modal::before { content: ''; position: absolute; inset: 0 0 auto 0; height: 1px; background: linear-gradient(90deg, transparent, var(--tone), transparent); }
@keyframes kf-fade { from { opacity: 0; } }
@keyframes kf-pop { from { opacity: 0; transform: translateY(8px) scale(.97); } }
.kf-chip { display: inline-flex; align-items: center; gap: 6px; padding: 7px 13px; border-radius: 999px; font-size: var(--text-sm); cursor: pointer; user-select: none;
  color: var(--text-muted); background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.09); transition: all .15s; }
.kf-chip:hover { color: var(--text-strong); border-color: rgba(167,139,250,.5); }
.kf-chip.on { color: #fff; border-color: transparent; background: linear-gradient(135deg, rgba(34,211,238,.28), rgba(139,92,246,.38)); box-shadow: inset 0 0 0 1px rgba(167,139,250,.65), 0 0 18px rgba(139,92,246,.32); }
.kf-day { width: 46px; height: 46px; padding: 0; justify-content: center; border-radius: 14px; font-weight: 600; }
.kf-switch { position: relative; width: 42px; height: 24px; flex: none; border-radius: 999px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.08); cursor: pointer; transition: all .2s; padding: 0; }
.kf-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #cbd5e1; box-shadow: 0 2px 6px rgba(0,0,0,.4); transition: all .2s cubic-bezier(.3,1.4,.5,1); }
.kf-switch.on { border-color: transparent; background: linear-gradient(135deg, #22d3ee, #8b5cf6); box-shadow: 0 0 16px rgba(139,92,246,.5); }
.kf-switch.on::after { left: 20px; background: #fff; }
.kf-row { display: flex; align-items: center; gap: 12px; padding: 11px 13px; border-radius: 13px; background: rgba(255,255,255,.025); border: 1px solid rgba(255,255,255,.07); }
.kf-seg { display: inline-flex; padding: 3px; gap: 3px; border-radius: 12px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); }
.kf-seg button { display: inline-flex; align-items: center; gap: 6px; border: 0; padding: 7px 14px; border-radius: 9px; background: transparent; color: var(--text-muted); cursor: pointer; font-size: var(--text-sm); transition: all .15s; }
.kf-seg button.on { color: #fff; background: linear-gradient(135deg, rgba(34,211,238,.3), rgba(139,92,246,.42)); box-shadow: inset 0 0 0 1px rgba(167,139,250,.55); }
.kf-drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 26px 16px; border-radius: 16px; cursor: pointer; text-align: center;
  border: 1.5px dashed rgba(167,139,250,.38); background: radial-gradient(circle at 50% 0%, rgba(139,92,246,.10), transparent 70%), rgba(255,255,255,.02); transition: all .15s; }
.kf-drop:hover, .kf-drop.over { border-color: #a78bfa; background: radial-gradient(circle at 50% 0%, rgba(139,92,246,.2), transparent 70%), rgba(255,255,255,.03); box-shadow: 0 0 26px rgba(139,92,246,.22); }
.kf-ta { background: rgba(255,255,255,.03); color: var(--text-strong); border: 1px solid rgba(255,255,255,.1); border-radius: 12px; padding: 11px 12px; font: inherit; resize: vertical; outline: none; transition: border-color .15s, box-shadow .15s; }
.kf-ta:focus { border-color: #a78bfa; box-shadow: 0 0 0 3px rgba(139,92,246,.22); }
.kf-hint { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 5; pointer-events: none; padding: 7px 14px; border-radius: 999px; font-size: var(--text-xs); color: var(--text-muted); white-space: nowrap; }
`;

// ---- Cartão do bloco no canvas ------------------------------------------------
function BlockNode({ id, data, selected }) {
  const lookups = React.useContext(LookupsCtx);
  const b = metaOf(data.type, data.data || {});
  const color = TONES[b.tone] || TONES.neutral;
  const exits = exitsOf({ type: data.type, data: data.data });
  return (
    <div className={`kf-node${selected ? ' sel' : ''}`} style={{ '--tone': color }}>
      {!data.isStart && <Handle type="target" position={Position.Left} className="kf-h" style={{ '--hc': '#a78bfa' }} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 12px 6px' }}>
        <span className="kf-ico"><Icon name={b.icon} size={16} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: 'var(--text-strong)', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
            {b.label}{data.isStart && <span className="kf-live" title="Ponto de partida" />}
          </div>
        </div>
        <span className="kf-ref">{id}</span>
      </div>
      {lookups.metrics && (
        <div style={{ display: 'flex', gap: 6, padding: '0 12px 6px' }}>
          <span title="Leads que chegaram a este bloco" style={{ background: 'rgba(34,211,238,.12)', color: '#67e8f9', borderRadius: 'var(--radius-pill)', padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>
            {(lookups.metrics[id] && lookups.metrics[id].leads) || 0} leads
          </span>
          {lookups.metrics[id] && lookups.metrics[id].here > 0 && (
            <span title="Leads parados neste bloco agora" style={{ background: 'var(--amber-tint)', color: 'var(--amber-600)', borderRadius: 'var(--radius-pill)', padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>
              {lookups.metrics[id].here} aqui agora
            </span>
          )}
        </div>
      )}
      <div style={{ padding: '0 12px 10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', minHeight: 16, lineHeight: 1.45 }}>
        {summaryOf(data.type, data.data || {}, lookups)}
      </div>
      {data.type === 'send_media' && data.data && data.data.kind === 'image' && /^https?:\/\//.test(data.data.url || '') && (
        <div style={{ padding: '0 12px 10px' }}><img src={data.data.url} alt="" style={{ width: '100%', maxHeight: 110, objectFit: 'cover', borderRadius: 10, border: '1px solid rgba(255,255,255,.08)', display: 'block' }} /></div>
      )}
      {exits.length > 0 && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,.06)', padding: '2px 0' }}>
          {exits.map(([k, label]) => {
            const ec = EDGE[edgeTone(k)].from;
            return (
              <div key={k} className="kf-exit" style={{ '--ec': ec, color: edgeTone(k) === 'danger' ? '#fda4af' : undefined }}>
                {label}<span className="dot" />
                <Handle type="source" id={k} position={Position.Right} className="kf-h" style={{ '--hc': ec }} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
const nodeTypes = { kobly: BlockNode };

// ---- Linha entre blocos ------------------------------------------------------------
function GlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, sourceHandleId, selected }) {
  const rf = useReactFlow();
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: 0.32 });
  const c = EDGE[edgeTone(sourceHandleId)];
  const gid = `kg-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return (<>
    <defs>
      <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={targetX} y2={targetY}>
        <stop offset="0" stopColor={c.from} /><stop offset="1" stopColor={c.to} />
      </linearGradient>
    </defs>
    <path d={path} fill="none" stroke={c.glow} strokeOpacity={selected ? 0.4 : 0.22} strokeWidth={selected ? 12 : 8} style={{ filter: 'blur(4px)' }} />
    <BaseEdge id={id} path={path} style={{ stroke: `url(#${gid})`, strokeWidth: selected ? 3 : 2.2 }} />
    <path d={path} fill="none" stroke="#ffffff" strokeOpacity={0.85} strokeWidth={2} strokeLinecap="round" strokeDasharray="1 31" className="kf-flow" style={{ pointerEvents: 'none' }} />
    <circle cx={targetX} cy={targetY} r={3.5} fill={c.to} style={{ filter: `drop-shadow(0 0 4px ${c.to})` }} />
    {selected && (
      <EdgeLabelRenderer>
        <button type="button" className="kf-edge-del nodrag nopan" title="Remover ligação" aria-label="Remover ligação"
          style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, pointerEvents: 'all' }}
          onClick={() => rf.deleteElements({ edges: [{ id }] })}>
          <Icon name="x" size={12} />
        </button>
      </EdgeLabelRenderer>
    )}
  </>);
}
const edgeTypes = { kobly: GlowEdge };

// ---- Campos auxiliares --------------------------------------------------------
function TextArea({ label, value, onChange, rows = 4, hint, placeholder }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>
      {label}
      <textarea className="kf-ta" value={value ?? ''} rows={rows} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {hint && <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)', lineHeight: 1.5 }}>{hint}</span>}
    </label>
  );
}
// Chave liga/desliga com rótulo e explicação
function Toggle({ label, hint, checked, onChange }) {
  return (
    <div className="kf-row" onClick={() => onChange(!checked)} style={{ cursor: 'pointer' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-strong)' }}>{label}</div>
        {hint && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', marginTop: 2, lineHeight: 1.5 }}>{hint}</div>}
      </div>
      <button type="button" role="switch" aria-checked={!!checked} aria-label={label} className={`kf-switch${checked ? ' on' : ''}`} onClick={(e) => { e.stopPropagation(); onChange(!checked); }} />
    </div>
  );
}
// Seleção múltipla em pílulas
function Chips({ options, value = [], onChange, className = '' }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button key={o.value} type="button" aria-pressed={on} title={o.title} className={`kf-chip ${className}${on ? ' on' : ''}`}
            onClick={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])}>
            {on && className !== 'kf-day' && <Icon name="check" size={13} />}{o.label}
          </button>
        );
      })}
    </div>
  );
}
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
function DayPicker({ value = [], onChange }) {
  const set = (v) => onChange([...v].sort((a, b) => a - b));
  const same = (a) => a.length === value.length && a.every((x) => value.includes(x));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Chips className="kf-day" value={value} onChange={set} options={DIAS.map((d, i) => ({ value: i, label: d }))} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {[['Seg a Sex', [1, 2, 3, 4, 5]], ['Seg a Sáb', [1, 2, 3, 4, 5, 6]], ['Todos os dias', [0, 1, 2, 3, 4, 5, 6]], ['Fim de semana', [0, 6]]].map(([l, v]) => (
          <button key={l} type="button" className={`kf-chip${same(v) ? ' on' : ''}`} style={{ padding: '4px 10px', fontSize: 'var(--text-xs)' }} onClick={() => set(v)}>{l}</button>
        ))}
      </div>
    </div>
  );
}
function Segmented({ options, value, onChange }) {
  return (
    <div className="kf-seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={14} />}{o.label}
        </button>
      ))}
    </div>
  );
}
function Section({ title, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '.08em' }}>{title}</div>
      {children}
    </div>
  );
}
const num = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));
const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'opcao';

function ListEditor({ items, onChange, render, make, addLabel, max = 10 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((it, i) => (
        <div key={i} className="kf-row" style={{ alignItems: 'flex-start', gap: 6, padding: 10 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>{render(it, (patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))))}</div>
          <IconButton icon="trash-2" size="sm" aria-label="Remover" onClick={() => onChange(items.filter((_, j) => j !== i))} />
        </div>
      ))}
      {items.length < max && <Button size="sm" variant="secondary" iconLeft="plus" onClick={() => onChange([...items, make(items)])}>{addLabel}</Button>}
    </div>
  );
}

// "Apagar mensagem ao aplicar etiqueta" (texto e mídia)
function DeleteOnTag({ d, set, tags }) {
  const [open, setOpen] = useState(!!d.delete_on_tag);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Toggle label="Apagar mensagem ao aplicar etiqueta" checked={open}
        hint="Quando a etiqueta entrar no lead (pelo fluxo ou à mão), a mensagem some para todos no WhatsApp. Funciona no WhatsApp conectado por QR Code: a API oficial da Meta não permite apagar."
        onChange={(v) => { setOpen(v); if (!v) set({ delete_on_tag: undefined }); }} />
      {open && (<>
        <Select label="Etiqueta que dispara a exclusão" value={d.delete_on_tag || ''} onChange={(e) => set({ delete_on_tag: e.target.value || undefined })}
          options={[{ value: '', label: 'Selecionar…' }, ...tags.map((t) => ({ value: t.id, label: t.nome }))]} />
        {tags.length === 0 && <span style={{ color: 'var(--amber-600)', fontSize: 'var(--text-xs)' }}>Crie uma etiqueta em Leads → Etiquetas primeiro.</span>}
      </>)}
    </div>
  );
}

// Mídia: enviar do computador (fica hospedado na Kobly) ou colar um link
const isOwnUpload = (u) => /\/storage\/v1\/object\/public\/flow-media\//.test(String(u || ''));
function MediaFields({ d, set, upload }) {
  const m = MEDIA[d.kind] || MEDIA.document;
  const [mode, setMode] = useState(d.url && !isOwnUpload(d.url) ? 'url' : 'file');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [over, setOver] = useState(false);
  const input = useRef(null);
  async function pick(file) {
    if (!file) return;
    if (file.size > m.maxMb * 1024 * 1024) { setErr(`O arquivo passa de ${m.maxMb} MB (limite do WhatsApp para ${m.label.toLowerCase()}).`); return; }
    if (!upload) { setErr('Envio de arquivo indisponível aqui. Use um link.'); return; }
    setBusy(true); setErr(null);
    let r;
    try { r = await upload(file); } catch (e) { r = { error: (e && e.message) || 'Falha no envio.' }; }
    setBusy(false);
    if (!r || r.error) { setErr(typeof r?.error === 'string' ? r.error : (r?.error && r.error.message) || 'Falha no envio.'); return; }
    set({ url: r.url, ...(d.kind === 'document' ? { filename: d.filename || file.name } : {}) });
  }
  const name = d.filename || decodeURIComponent(String(d.url || '').split('/').pop() || '');
  const hasFile = mode === 'file' && d.url;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Segmented value={mode} onChange={setMode} options={[{ value: 'file', label: 'Arquivo', icon: 'upload' }, { value: 'url', label: 'URL', icon: 'link' }]} />
      {mode === 'file' ? (<>
        <input ref={input} type="file" accept={m.accept} hidden onChange={(e) => { pick(e.target.files && e.target.files[0]); e.target.value = ''; }} />
        {hasFile ? (
          <div className="kf-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
            {d.kind === 'image' && <img src={d.url} alt="" style={{ width: '100%', maxHeight: 240, objectFit: 'contain', borderRadius: 10, background: 'rgba(0,0,0,.3)' }} />}
            {d.kind === 'video' && <video src={d.url} controls style={{ width: '100%', maxHeight: 240, borderRadius: 10, background: '#000' }} />}
            {d.kind === 'audio' && <audio src={d.url} controls style={{ width: '100%' }} />}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="kf-ico" style={{ '--tone': TONES.green }}><Icon name={m.icon} size={15} /></span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-strong)', fontSize: 'var(--text-sm)' }}>{name}</span>
              <Button size="sm" variant="secondary" iconLeft="refresh-cw" loading={busy} onClick={() => input.current && input.current.click()}>Trocar</Button>
              <IconButton icon="trash-2" size="sm" aria-label="Remover arquivo" onClick={() => set({ url: '', filename: undefined })} />
            </div>
          </div>
        ) : (
          <div className={`kf-drop${over ? ' over' : ''}`} role="button" tabIndex={0}
            onClick={() => !busy && input.current && input.current.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current && input.current.click(); } }}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files && e.dataTransfer.files[0]); }}>
            <span className="kf-ico" style={{ '--tone': '#a78bfa', width: 44, height: 44, borderRadius: 14 }}><Icon name={busy ? 'loader-circle' : 'upload'} size={20} /></span>
            <div style={{ color: 'var(--text-strong)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>{busy ? 'Enviando…' : 'Arraste o arquivo aqui ou clique para escolher'}</div>
            <div style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>{m.formats}</div>
          </div>
        )}
      </>) : (
        <Input label="Link público (https)" value={d.url || ''} onChange={(e) => set({ url: e.target.value.trim() })} placeholder="https://..." hint="O WhatsApp baixa o arquivo deste link. Também aceita uma variável, como {{pagamento_qr}}." />
      )}
      {err && <div style={{ color: '#fda4af', fontSize: 'var(--text-xs)' }}>{err}</div>}
      {d.kind !== 'audio' && <TextArea label="Legenda (opcional)" value={d.caption} onChange={(v) => set({ caption: v })} rows={3} placeholder="Texto que vai junto com o arquivo" hint="Aceita {{variáveis}}." />}
      {d.kind === 'document' && <Input label="Nome do arquivo para o lead" value={d.filename || ''} onChange={(e) => set({ filename: e.target.value || undefined })} placeholder="material.pdf" />}
    </div>
  );
}

// ---- Campos de cada bloco ---------------------------------------------------------
const RULE_KINDS = [
  { value: 'var', label: 'Variável' }, { value: 'tag', label: 'Etiqueta' }, { value: 'purchased', label: 'Comprou' },
  { value: 'window_open', label: 'Janela de 24 h aberta' }, { value: 'weekday', label: 'Dia da semana' }, { value: 'time_between', label: 'Horário' }, { value: 'country', label: 'País (DDI)' },
];
const VAR_OPS = [['eq', 'é igual a'], ['neq', 'é diferente de'], ['contains', 'contém'], ['not_contains', 'não contém'], ['gt', 'maior que'], ['gte', 'maior ou igual'], ['lt', 'menor que'], ['lte', 'menor ou igual'], ['empty', 'está vazia'], ['not_empty', 'não está vazia']].map(([value, label]) => ({ value, label }));

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
    case 'weekday': return <DayPicker value={r.days || []} onChange={(days) => set({ days })} />;
    case 'time_between': return (<div style={{ display: 'flex', gap: 8 }}>
      <Input label="De" type="time" value={r.from || '09:00'} onChange={(e) => set({ from: e.target.value })} />
      <Input label="Até" type="time" value={r.to || '18:00'} onChange={(e) => set({ to: e.target.value })} />
    </div>);
    case 'country': return <Input label="DDIs (separados por vírgula)" value={(r.ddi || []).join(', ')} onChange={(e) => set({ ddi: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} hint="Ex.: 52 (México), 57 (Colômbia), 91 (Índia)" />;
    default: return null;
  }
}

function BlockFields({ node, onChange }) {
  const lookups = React.useContext(LookupsCtx);
  const { templates, tags, integrations = [], pixels = [], channels = [] } = lookups;
  const d = node.data.data || {};
  const set = (patch) => onChange({ ...d, ...patch });
  const tplOptions = [{ value: '', label: 'Selecionar…' }, ...templates.map((t) => ({ value: t.id, label: `${t.name} (${t.language})${t.status === 'APPROVED' ? '' : ' — ' + t.status}` }))];
  const varsFor = (tid, list, key) => {
    const t = templates.find((x) => x.id === tid);
    const n = (t && t.variable_count) || 0;
    if (!n) return null;
    const cur = Array.from({ length: n }, (_, i) => (list || [])[i] ?? '');
    return cur.map((v, i) => <Input key={i} label={`Variável {{${i + 1}}}`} value={v} placeholder="ex.: primeiro_nome ou {{produto}}" onChange={(e) => set({ [key]: cur.map((x, j) => (j === i ? e.target.value : x)) })} />);
  };
  switch (node.data.type) {
    case 'trigger': return (<>
      <Section title="Inicia quando chegar um destes eventos do checkout">
        <Chips value={d.events || []} onChange={(events) => set({ events })} options={TIPOS_EVENTO.map((ev) => ({ value: ev, label: ev }))} />
      </Section>
      <Toggle label="Encerrar este fluxo se o lead comprar" hint="Para quem pagou não receber mais mensagens de recuperação." checked={d.stop_on_purchase ?? !(d.events || []).includes('Compra Aprovada')} onChange={(v) => set({ stop_on_purchase: v })} />
    </>);
    case 'send_template': return (<>
      <Select label="Modelo aprovado" value={d.template_id || ''} onChange={(e) => set({ template_id: e.target.value, vars: [] })} options={tplOptions} />
      {varsFor(d.template_id, d.vars, 'vars')}
    </>);
    case 'send_text': return (<>
      <TextArea label="Mensagem" value={d.text} onChange={(v) => set({ text: v })} rows={6} hint={VARS_HELP} />
      <Select label="Modelo reserva (só API Oficial)" value={d.fallback_template_id || ''} onChange={(e) => set({ fallback_template_id: e.target.value || undefined, fallback_vars: [] })} options={[{ value: '', label: 'Nenhum' }, ...tplOptions.slice(1)]} />
      <div style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)', marginTop: -6, lineHeight: 1.5 }}>A Meta só aceita texto livre até 24 h depois da última mensagem do lead. Passou disso, a Kobly manda este modelo no lugar. No WhatsApp por QR Code não há esse limite.</div>
      {varsFor(d.fallback_template_id, d.fallback_vars, 'fallback_vars')}
      <DeleteOnTag d={d} set={set} tags={tags} />
    </>);
    case 'send_media': return (<>
      <MediaFields d={d} set={set} upload={lookups.uploadMedia} />
      <DeleteOnTag d={d} set={set} tags={tags} />
    </>);
    case 'send_buttons': return (<>
      <TextArea label="Pergunta" value={d.text} onChange={(v) => set({ text: v })} hint="Até 3 opções aparecem como botões; de 4 a 10, como lista." />
      <ListEditor items={d.options || []} max={10} addLabel="Adicionar opção" onChange={(options) => set({ options })}
        make={(items) => ({ id: `opcao_${items.length + 1}`, title: `Opção ${items.length + 1}` })}
        render={(o, up) => <Input value={o.title} onChange={(e) => up({ title: e.target.value, id: slug(e.target.value) })} placeholder="Texto da opção" hint={`saída: opt_${o.id}`} />} />
      {(d.options || []).length > 3 && <Input label="Texto do botão da lista" value={d.list_button || ''} onChange={(e) => set({ list_button: e.target.value })} placeholder="Ver opções" />}
      <Input label="Salvar resposta em" value={d.save_as || 'resposta'} onChange={(e) => set({ save_as: e.target.value.trim() })} />
      <Input label="Prazo para responder (minutos)" type="number" value={d.timeout_minutes ?? ''} onChange={(e) => set({ timeout_minutes: num(e.target.value) })} hint="Vazio = até 30 dias" />
    </>);
    case 'delay': return (<>
      <div style={{ display: 'flex', gap: 8 }}>
        <Input label="Mínimo (segundos)" type="number" value={d.min_seconds ?? d.seconds ?? ''} onChange={(e) => set({ min_seconds: num(e.target.value), seconds: undefined })} />
        <Input label="Máximo (segundos)" type="number" value={d.max_seconds ?? d.seconds ?? ''} onChange={(e) => set({ max_seconds: num(e.target.value), seconds: undefined })} />
      </div>
      <div style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>Tempo sorteado entre o mínimo e o máximo. 3600 = 1 hora · 86400 = 1 dia.</div>
      <Toggle label='Mostrar "digitando..."' hint="Com a conversa aberta, o lead vê que você está digitando durante a espera." checked={d.typing} onChange={(v) => set({ typing: v })} />
    </>);
    case 'wait_reply': return (<>
      <Input label="Salvar resposta em" value={d.save_as || 'resposta'} onChange={(e) => set({ save_as: e.target.value.trim() })} hint="Use depois como {{resposta}}" />
      <Input label="Prazo (minutos)" type="number" value={d.timeout_minutes ?? ''} onChange={(e) => set({ timeout_minutes: num(e.target.value) })} hint="Vazio = até 30 dias. Dica: até 1380 (23 h) mantém a janela de 24 h aberta." />
    </>);
    case 'condition': return (<>
      <Segmented value={d.match || 'all'} onChange={(match) => set({ match })} options={[{ value: 'all', label: 'Todas as regras (E)' }, { value: 'any', label: 'Qualquer uma (OU)' }]} />
      <ListEditor items={d.rules || []} max={10} addLabel="Adicionar regra" onChange={(rules) => set({ rules })}
        make={() => ({ kind: 'var', name: 'resposta', op: 'contains', value: '' })}
        render={(r, up) => (<>
          <Select value={r.kind} onChange={(e) => up({ kind: e.target.value, op: e.target.value === 'tag' ? 'has' : e.target.value === 'var' ? 'eq' : undefined })} options={RULE_KINDS} />
          <RuleFields r={r} set={up} tags={tags} />
        </>)} />
    </>);
    case 'ai_classify': return (<>
      <Input label="Texto analisado" value={d.input || '{{resposta}}'} onChange={(e) => set({ input: e.target.value })} />
      <TextArea label="Contexto para a IA (opcional)" value={d.instructions} onChange={(v) => set({ instructions: v })} rows={3} hint="Ex.: estamos oferecendo o guia por $45 MXN." />
      <ListEditor items={d.outputs || []} max={8} addLabel="Adicionar saída" onChange={(outputs) => set({ outputs })}
        make={(items) => ({ key: `saida_${items.length + 1}`, description: '' })}
        render={(o, up) => (<>
          <Input value={o.key} onChange={(e) => up({ key: slug(e.target.value) })} placeholder="chave (ex.: sim)" />
          <Input value={o.description} onChange={(e) => up({ description: e.target.value })} placeholder="quando usar (ex.: aceitou a oferta)" />
        </>)} />
      <Input label="Salvar a escolha em" value={d.save_as || 'classificacao'} onChange={(e) => set({ save_as: e.target.value.trim() })} />
    </>);
    case 'ai_extract': return (<>
      <Input label="Texto analisado" value={d.input || '{{resposta}}'} onChange={(e) => set({ input: e.target.value })} />
      <TextArea label="Contexto para a IA (opcional)" value={d.instructions} onChange={(v) => set({ instructions: v })} rows={3} />
      <ListEditor items={d.fields || []} max={8} addLabel="Adicionar campo" onChange={(fields) => set({ fields })}
        make={(items) => ({ name: `campo_${items.length + 1}`, description: '', required: true })}
        render={(f, up) => (<>
          <Input value={f.name} onChange={(e) => up({ name: slug(e.target.value) })} placeholder="nome da variável" />
          <Input value={f.description} onChange={(e) => up({ description: e.target.value })} placeholder="o que extrair" />
          <Toggle label="Obrigatório" checked={f.required !== false} onChange={(v) => up({ required: v })} />
        </>)} />
    </>);
    case 'payment': {
      const metodos = PAYMENT_METHODS[d.currency] || [];
      const abertoOk = d.currency === 'BRL' || (d.currency === 'MXN' && d.method === 'SPEI');
      const pref = d.save_as || 'pagamento';
      return (<>
        {integrations.length === 0 && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--amber-600)' }}>Nenhuma conta de gateway conectada. Conecte em Integrações → Gateways de pagamento.</div>}
        <Select label="Conta do gateway" value={d.integration_id || ''} onChange={(e) => set({ integration_id: e.target.value })}
          options={[{ value: '', label: 'Selecionar…' }, ...integrations.map((i) => ({ value: i.id, label: `${({ xpag: 'XPag', mercadopago: 'Mercado Pago', woovi: 'Woovi', pushinpay: 'PushinPay', syncpay: 'SyncPay', zenith: 'Zenith' })[i.provider] || i.provider} · ${i.label}${i.sandbox ? ' (sandbox)' : ''}` }))]} />
        <Select label="País e moeda" value={d.currency || 'BRL'} onChange={(e) => { const c = e.target.value; set({ currency: c, method: (PAYMENT_METHODS[c] || [[]])[0][0], open_amount: false }); }}
          options={Object.keys(PAYMENT_METHODS).map((c) => ({ value: c, label: CURRENCY_LABEL[c] || c }))} />
        <Select label="Método" value={d.method || ''} onChange={(e) => set({ method: e.target.value, ...(e.target.value === 'OXXO' ? { open_amount: false } : {}) })} options={metodos.map(([value, label]) => ({ value, label }))} />
        {abertoOk && <Toggle label="Valor livre" hint="O lead paga o quanto quiser." checked={d.open_amount} onChange={(v) => set({ open_amount: v })} />}
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
    }
    case 'ai_agent': return (<>
      <Select label="Agente salvo" value={d.agent_id || ''} onChange={(e) => set(e.target.value ? { agent_id: e.target.value, objective: '', knowledge: '', max_turns: undefined, timeout_minutes: undefined } : { agent_id: undefined })}
        options={[{ value: '', label: 'Configurar só neste bloco' }, ...((lookups.agents || []).map((a) => ({ value: a.id, label: a.name })))]}
      />
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', marginTop: -6 }}>{d.agent_id ? 'Usa o agente salvo em Agentes de IA. O que você preencher abaixo vale só neste bloco.' : 'Crie agentes reaproveitáveis no menu Agentes de IA.'}</div>
      <TextArea label="Objetivo do agente" value={d.objective} onChange={(v) => set({ objective: v })} rows={3} hint="O que conta como sucesso. Ex.: tirar dúvidas e levar o lead a pagar o guia de $45 MXN." />
      <TextArea label="Base de conhecimento" value={d.knowledge} onChange={(v) => set({ knowledge: v })} rows={6} hint="Preço, entrega, garantia, perguntas frequentes. O agente não promete nada fora daqui." />
      <Input label="Tom de voz" value={d.tone || ''} onChange={(e) => set({ tone: e.target.value || undefined })} placeholder="amigável e direto" />
      <TextArea label="Mensagem de abertura (opcional)" value={d.opening} onChange={(v) => set({ opening: v || undefined })} rows={2} hint="Vazio: o agente responde a última mensagem do lead (ou espera ele escrever)." />
      <div style={{ display: 'flex', gap: 8 }}>
        <Input label="Máx. de respostas" type="number" value={d.max_turns ?? 10} onChange={(e) => set({ max_turns: num(e.target.value) })} />
        <Input label="Prazo sem resposta (min)" type="number" value={d.timeout_minutes ?? 60} onChange={(e) => set({ timeout_minutes: num(e.target.value) })} />
      </div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Saídas: Concluiu, Pediu humano (ligue num Alerta), Sem resposta e Erro. A última resposta fica em {'{{agente_resposta}}'}.</div>
    </>);
    case 'split': return (<>
      <ListEditor items={d.variants || []} max={6} addLabel="Adicionar caminho" onChange={(variants) => set({ variants })}
        make={(items) => ({ id: String.fromCharCode(97 + items.length), weight: 50 })}
        render={(v, up) => (<div style={{ display: 'flex', gap: 6 }}>
          <Input value={v.id} onChange={(e) => up({ id: slug(e.target.value).slice(0, 10) })} placeholder="a" style={{ width: 70 }} />
          <Input type="number" value={v.weight} onChange={(e) => up({ weight: num(e.target.value) })} hint="peso %" />
        </div>)} />
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Use "Métricas" para comparar quantos leads de cada caminho chegam à venda.</div>
    </>);
    case 'checkpoint': return <Input label="Nome do ponto" value={d.name || ''} onChange={(e) => set({ name: e.target.value })} placeholder="viu a oferta" />;
    case 'wait_until': return (<>
      <Segmented value={d.mode || 'business_hours'} onChange={(mode) => set({ mode })} options={[{ value: 'business_hours', label: 'Horário de atendimento', icon: 'clock' }, { value: 'datetime', label: 'Data e hora', icon: 'calendar-clock' }]} />
      {d.mode === 'datetime' ? (
        <Input label="Data e hora" value={d.at || ''} onChange={(e) => set({ at: e.target.value })} placeholder="2026-11-01 09:00 ou {{data_live}}" hint="No fuso da empresa (Configurações)." />
      ) : (<>
        <Section title="Dias de atendimento"><DayPicker value={d.days || []} onChange={(days) => set({ days })} /></Section>
        <div style={{ display: 'flex', gap: 8 }}>
          <Input label="Abre" type="time" value={d.from || '09:00'} onChange={(e) => set({ from: e.target.value })} />
          <Input label="Fecha" type="time" value={d.to || '18:00'} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Dentro do horário, segue na hora. Fora, espera a próxima abertura (no fuso da empresa).</div>
      </>)}
    </>);
    case 'notify': return (<>
      {channels.length === 0 && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--amber-600)' }}>Nenhum canal de alerta. Conecte um bot do Telegram em Integrações.</div>}
      <Select label="Canal" value={d.channel_id || ''} onChange={(e) => set({ channel_id: e.target.value })} options={[{ value: '', label: 'Selecionar…' }, ...channels.map((c) => ({ value: c.id, label: `Telegram · ${c.label}` }))]} />
      <TextArea label="Texto do alerta" value={d.text} onChange={(v) => set({ text: v })} rows={4} hint={VARS_HELP} />
      <Input label="Outro chat (opcional)" value={d.chat_id || ''} onChange={(e) => set({ chat_id: e.target.value || undefined })} placeholder="vazio = chat padrão do canal" />
    </>);
    case 'record_sale': return (<>
      <Input label="Valor (opcional)" value={d.amount ?? ''} onChange={(e) => set({ amount: e.target.value || undefined })} placeholder="vazio = valor pago na cobrança" />
      <Input label="Moeda (opcional)" value={d.currency ?? ''} onChange={(e) => set({ currency: e.target.value.toUpperCase() || undefined })} placeholder="vazio = moeda da cobrança" />
      <Input label="Produto (opcional)" value={d.product ?? ''} onChange={(e) => set({ product: e.target.value || undefined })} placeholder="{{produto}}" />
    </>);
    case 'pixel': return (<>
      {pixels.length === 0 && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--amber-600)' }}>Nenhum Pixel cadastrado. Cadastre em Integrações → Trackeamento.</div>}
      <Select label="Pixel" value={d.pixel_config_id || ''} onChange={(e) => set({ pixel_config_id: e.target.value })} options={[{ value: '', label: 'Selecionar…' }, ...pixels.map((p) => ({ value: p.id, label: `${p.label} (${p.pixel_id})` }))]} />
      <Select label="Evento" value={d.event || 'Purchase'} onChange={(e) => set({ event: e.target.value })}
        options={[{ value: 'Purchase', label: 'Compra (Purchase)' }, { value: 'Lead', label: 'Lead' }, { value: 'InitiateCheckout', label: 'Iniciou checkout' }, { value: 'AddPaymentInfo', label: 'Gerou pagamento' }]} />
      <Input label="Valor (opcional)" value={d.value ?? ''} onChange={(e) => set({ value: e.target.value || undefined })} placeholder={d.event === 'Purchase' ? 'vazio = valor pago na cobrança' : ''} />
    </>);
    case 'tag': return (<>
      {tags.length === 0 && <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>Nenhuma etiqueta criada ainda.</span>}
      {['add', 'remove'].map((k) => (
        <Section key={k} title={k === 'add' ? 'Adicionar ao lead' : 'Remover do lead'}>
          <Chips value={d[k] || []} onChange={(v) => set({ [k]: v })} options={tags.map((t) => ({ value: t.id, label: t.nome }))} />
        </Section>))}
    </>);
    case 'set_var': return (<>
      <Input label="Variável" value={d.name || ''} onChange={(e) => set({ name: e.target.value.trim() })} />
      <Select label="Operação" value={d.op || 'set'} onChange={(e) => set({ op: e.target.value })} options={[{ value: 'set', label: 'Definir' }, { value: 'add', label: 'Somar' }, { value: 'subtract', label: 'Subtrair' }, { value: 'multiply', label: 'Multiplicar' }, { value: 'divide', label: 'Dividir' }]} />
      <Input label="Valor" value={d.value ?? ''} onChange={(e) => set({ value: e.target.value })} hint="Aceita {{variáveis}}" />
    </>);
    case 'end': return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Este bloco encerra o fluxo para o lead. Não há nada para configurar.</div>;
    default: return null;
  }
}

// ---- Janela de edição do bloco -------------------------------------------------------
function BlockModal({ node, onChange, onDelete, onClose }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const b = metaOf(node.data.type, node.data.data || {});
  const tone = TONES[b.tone] || TONES.neutral;
  return (
    <div className="kf-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="kf-modal kf-glass" role="dialog" aria-modal="true" aria-label={`Editar ${b.label}`} style={{ '--tone': tone }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px 14px', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
          <span className="kf-ico" style={{ width: 40, height: 40, borderRadius: 13 }}><Icon name={b.icon} size={19} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong style={{ color: 'var(--text-strong)', fontSize: 16 }}>Editar {b.label}</strong>
              <span className="kf-ref">{node.id}</span>
            </div>
            <div style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)', marginTop: 2 }}>{b.hint}</div>
          </div>
          <IconButton icon="x" aria-label="Fechar" onClick={onClose} />
        </div>
        <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <BlockFields node={node} onChange={onChange} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderTop: '1px solid rgba(255,255,255,.06)' }}>
          {!node.data.isStart && <Button variant="ghost" iconLeft="trash-2" onClick={onDelete} style={{ color: '#fda4af' }}>Excluir bloco</Button>}
          <span style={{ flex: 1 }} />
          <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>As mudanças entram no canvas na hora</span>
          <Button iconLeft="check" onClick={onClose}>Concluir</Button>
        </div>
      </div>
    </div>
  );
}

// ---- Editor -----------------------------------------------------------------------
function Editor({ campaign, onBack, api, notify }) {
  const rf = useReactFlow();
  const wrap = useRef(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [editId, setEditId] = useState(null);
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
    const [g, templates, tags, integrations, pixels, channels, agents] = await Promise.all([
      api.flowGraph('get', { campaign_id: campaign.id }),
      opt(api.listTemplates), opt(api.getTags), opt(api.listIntegrations), opt(api.listPixels), opt(api.listChannels), opt(api.listAgents),
    ]);
    if (g.error) { setState((s) => ({ ...s, loading: false, error: g.error })); return; }
    // sem versão publicada: abre o rascunho mais recente (ex.: fluxo criado pela tela Fluxos)
    let base = g.active ? g.active.graph : null;
    if (!base && (g.versions || [])[0]) { const v = await api.flowGraph('get_version', { campaign_id: campaign.id, version: g.versions[0].version }); if (!v.error && v.graph) base = v.graph; }
    const c = toCanvas(base || emptyGraph());
    setNodes(c.nodes); setEdges(c.edges); setDirty(false); setReport(null); setMetrics(null); setEditId(null);
    setLookups({ templates: templates || [], tags: tags || [], integrations: integrations || [], pixels: pixels || [], channels: channels || [], agents: agents || [] });
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
    setEdges((eds) => addEdge({ ...c, id: `${c.source}:${c.sourceHandle}`, type: 'kobly' }, eds.filter((e) => !(e.source === c.source && e.sourceHandle === c.sourceHandle))));
    touch();
  }, [setEdges]);

  // item da paleta → bloco novo (mídia já nasce com o tipo escolhido) e abre a janela de edição
  const addBlock = useCallback((item, position) => {
    const taken = new Set(rf.getNodes().map((n) => n.id));
    const ref = newRef(item.type, taken);
    const pos = position || (() => {
      const box = wrap.current ? wrap.current.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
      return rf.screenToFlowPosition({ x: box.left + box.width / 2 - 126 + (taken.size % 5) * 16, y: box.top + box.height / 2 - 60 + (taken.size % 5) * 16 });
    })();
    const data = item.type === 'send_media' ? BLOCKS.send_media.make(item.kind) : BLOCKS[item.type].make();
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id: ref, type: 'kobly', position: pos, selected: true, data: { type: item.type, data, isStart: false } }]);
    setEditId(ref); touch();
  }, [rf, setNodes]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    const [type, kind] = String(e.dataTransfer.getData('application/kobly-block') || '').split(':');
    if (!BLOCKS[type]) return;
    addBlock({ type, kind }, rf.screenToFlowPosition({ x: e.clientX - 126, y: e.clientY - 20 }));
  }, [addBlock, rf]);

  const editing = nodes.find((n) => n.id === editId) || null;
  const updateNode = (id, data) => {
    const n = rf.getNode(id);
    if (!n) return;
    setNodes((ns) => ns.map((x) => (x.id === id ? { ...x, data: { ...x.data, data } } : x)));
    // saídas que deixaram de existir (opção/saída removida) perdem a ligação
    const valid = new Set(exitsOf({ type: n.data.type, data }).map(([k]) => k));
    setEdges((eds) => eds.filter((e) => e.source !== id || valid.has(e.sourceHandle)));
    touch();
  };
  const deleteNode = (id) => {
    const n = rf.getNode(id);
    if (!n || n.data.isStart) return;
    setNodes((ns) => ns.filter((x) => x.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    setEditId(null); touch();
  };
  const closeModal = useCallback(() => setEditId(null), []);

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
    setNodes(c.nodes); setEdges(c.edges); setDirty(false); setReport(null); setMetrics(null); setCopilot(null); setEditId(null);
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
  const focusRef = (msg, open = true) => {
    const m = /bloco "([^"]+)"|"([^"]+)" não é alcançado|^([a-z0-9-]+):/.exec(msg);
    const ref = m && (m[1] || m[2] || m[3]);
    const n = ref && rf.getNode(ref);
    if (n) {
      setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === ref })));
      rf.setCenter(n.position.x + 126, n.position.y + 60, { zoom: 1.1, duration: 300 });
      if (open) setEditId(ref);
    }
  };
  const palette = useMemo(() => PALETTE_GROUPS.map((g) => [g, paletteItems(g)]), []);
  const showPanel = (report && (report.errors.length > 0 || report.warnings.length > 0 || report.ok)) || copilot;

  if (state.error) return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ color: 'var(--red-500)' }}>{state.error}</div>
      <div style={{ display: 'flex', gap: 8 }}><Button variant="secondary" onClick={onBack} iconLeft="arrow-left">Voltar</Button><Button onClick={load} iconLeft="refresh-cw">Tentar de novo</Button></div>
    </div>
  );

  return (
    <LookupsCtx.Provider value={{ ...lookups, metrics, uploadMedia: api.uploadMedia }}>
      <style>{FLOW_CSS}</style>
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)', minHeight: 520, gap: 10 }}>
        {/* barra superior */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <IconButton icon="arrow-left" aria-label="Voltar" onClick={back} />
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-strong)', display: 'flex', alignItems: 'center', gap: 8 }}>
              {campaign.nome || 'Campanha'}{state.version && !state.viewing && <span className="kf-live" title="Fluxo publicado e rodando" />}
            </div>
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
          <div className="kf-glass" style={{ width: 200, flex: 'none', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, padding: 12, borderRadius: 16 }}>
            {palette.map(([grp, items]) => (
              <div key={grp} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ fontSize: 10, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '.1em', padding: '0 2px 2px' }}>{grp}</div>
                {items.map((it) => (
                  <button key={it.key} type="button" draggable title={it.hint} className="kf-pal" style={{ '--tone': TONES[it.tone] }}
                    onDragStart={(e) => { e.dataTransfer.setData('application/kobly-block', it.kind ? `${it.type}:${it.kind}` : it.type); e.dataTransfer.effectAllowed = 'move'; }}
                    onClick={() => addBlock(it)}>
                    <span className="kf-ico"><Icon name={it.icon} size={14} /></span>{it.label}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* canvas */}
          <div ref={wrap} className="kf-canvas" style={{ flex: 1, minWidth: 0, border: '1px solid rgba(255,255,255,.07)', borderRadius: 16, overflow: 'hidden' }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }} onDrop={onDrop}>
            <ReactFlow key={canvasKey} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} colorMode="dark" fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
              onNodesChange={(ch) => { onNodesChange(ch); if (ch.some((c) => c.type === 'position' || c.type === 'remove')) touch(); }}
              onEdgesChange={(ch) => { onEdgesChange(ch); if (ch.some((c) => c.type === 'remove')) touch(); }}
              onConnect={onConnect} onNodeClick={(_, n) => setEditId(n.id)}
              defaultEdgeOptions={{ type: 'kobly' }} connectionLineType={ConnectionLineType.Bezier} connectionLineStyle={{ stroke: '#a78bfa', strokeWidth: 2.4, strokeDasharray: '6 6' }}
              deleteKeyCode={editId ? null : ['Delete', 'Backspace']} minZoom={0.2} maxZoom={1.75} proOptions={{ hideAttribution: true }}>
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="rgba(167,139,250,.22)" />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeColor={(n) => TONES[metaOf(n.data.type, n.data.data).tone] || '#64748b'} nodeBorderRadius={6} maskColor="rgba(5,7,12,.65)" style={{ width: 150, height: 100 }} />
            </ReactFlow>

            {/* validação e copiloto flutuando sobre o canvas */}
            {showPanel && (
              <div className="kf-glass" style={{ position: 'absolute', top: 12, right: 12, zIndex: 6, width: 340, maxHeight: 'calc(100% - 24px)', overflowY: 'auto', borderRadius: 16, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="kf-ico" style={{ '--tone': copilot ? TONES.purple : report && report.errors.length ? '#f43f5e' : '#34d399', width: 26, height: 26, borderRadius: 8 }}><Icon name={copilot ? 'sparkles' : report && report.errors.length ? 'circle-alert' : 'circle-check'} size={14} /></span>
                  <strong style={{ flex: 1, color: 'var(--text-strong)', fontSize: 'var(--text-sm)' }}>{copilot ? 'Copiloto' : report && report.errors.length ? `${report.errors.length} ajuste(s) antes de publicar` : 'Fluxo válido'}</strong>
                  <IconButton icon="x" size="sm" aria-label="Fechar painel" onClick={() => { setReport(null); setCopilot(null); }} />
                </div>
                {report && report.errors.map((m, i) => <button key={'e' + i} type="button" onClick={() => focusRef(m)} style={{ textAlign: 'left', background: 'rgba(244,63,94,.1)', color: '#fda4af', border: '1px solid rgba(244,63,94,.25)', borderRadius: 10, padding: '7px 9px', fontSize: 'var(--text-xs)', cursor: 'pointer' }}>{m}</button>)}
                {report && report.warnings.map((m, i) => <button key={'w' + i} type="button" onClick={() => focusRef(m)} style={{ textAlign: 'left', background: 'rgba(245,158,11,.1)', color: '#fcd34d', border: '1px solid rgba(245,158,11,.25)', borderRadius: 10, padding: '7px 9px', fontSize: 'var(--text-xs)', cursor: 'pointer' }}>{m}</button>)}
                {report && report.ok && !report.errors.length && !report.warnings.length && !copilot && <Badge tone="success">Pronto para publicar</Badge>}
                {copilot && (<>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{copilot.leads} leads analisados</span>
                  {copilot.summary && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)', lineHeight: 1.5 }}>{copilot.summary}</div>}
                  {copilot.suggestions.map((s, i) => {
                    const c = s.severity === 'alta' ? '#f43f5e' : s.severity === 'media' ? '#f59e0b' : '#22d3ee';
                    return (
                      <button key={i} type="button" onClick={() => s.ref && focusRef(`bloco "${s.ref}"`, false)} style={{ textAlign: 'left', background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.07)', borderLeft: `3px solid ${c}`, borderRadius: 10, padding: '8px 10px', cursor: s.ref ? 'pointer' : 'default', display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-strong)', fontSize: 'var(--text-sm)' }}>{s.title}{s.ref ? <span style={{ color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)', fontWeight: 400, fontSize: 10 }}> · {s.ref}</span> : null}</span>
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{s.detail}</span>
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-body)' }}>→ {s.action}</span>
                      </button>
                    );
                  })}
                </>)}
              </div>
            )}
            {!state.loading && nodes.length > 0 && <div className="kf-hint kf-glass">Clique num bloco para editar · arraste da bolinha de uma saída até outro bloco para ligar</div>}
          </div>
        </div>
      </div>
      {editing && <BlockModal node={editing} onChange={(data) => updateNode(editing.id, data)} onDelete={() => deleteNode(editing.id)} onClose={closeModal} />}
    </LookupsCtx.Provider>
  );
}

function KoblyFlowGraphEditor({ campaign, onBack, api = defaultApi, notify = (tone, msg) => console.log(`[${tone}] ${msg}`) }) {
  return <ReactFlowProvider><Editor campaign={campaign} onBack={onBack} api={api} notify={notify} /></ReactFlowProvider>;
}
export { KoblyFlowGraphEditor };
