import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Icon } from '@/ds';
import { ChannelLogo } from '@/lib/brandLogos.jsx';
import { useBreakpoint } from '@/lib/responsive.jsx';
import { fmtDateTime, useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Chats ao vivo. Conversas do WhatsApp (QR Code e API Oficial): o que o lead mandou + o que o fluxo, a IA
// ou alguém da equipe respondeu. Filtros (aguardando resposta, com humano, em fluxo), envio de texto e arquivo,
// respostas rápidas com "/", etiquetas e ficha do lead ao lado. "Assumir" pausa a automação do lead. KoblyChats

const POLL_MS = 5000;
const DE = {
  lead: { label: 'Lead', mine: false, icon: null },
  fluxo: { label: 'Fluxo', mine: true, icon: 'git-branch', color: '#ff9452' },
  agente: { label: 'IA', mine: true, icon: 'sparkles', color: '#f39200' },
  humano: { label: 'Equipe', mine: true, icon: 'user', color: '#25D366' },
  celular: { label: 'Celular', mine: true, icon: 'smartphone', color: '#38bdf8' },
};
const FILTROS = [['todas', 'Todas', 'messages-square'], ['aguardando', 'Aguardando você', 'bell-ring'], ['fluxo', 'Em fluxo', 'git-branch'], ['humano', 'Com humano', 'hand']];
const nomeOf = (c) => [c.nome, c.sobrenome].filter(Boolean).join(' ') || c.telefone || 'Lead';
const ini = (s) => String(s || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const money = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const diaLabel = (iso) => { const d = new Date(iso), h = new Date(); const y = new Date(h); y.setDate(h.getDate() - 1); const same = (a, b) => a.toDateString() === b.toDateString(); return same(d, h) ? 'Hoje' : same(d, y) ? 'Ontem' : d.toLocaleDateString('pt-BR'); };
const rel = (iso) => { const s = (Date.now() - new Date(iso).getTime()) / 1000; if (s < 60) return 'agora'; if (s < 3600) return `${Math.round(s / 60)} min`; if (s < 86400) return hora(iso); return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }); };

const KH_CSS = `
.kh-shell { display: grid; grid-template-columns: 340px 1fr 300px; height: calc(100dvh - 170px); min-height: 520px; border-radius: 20px; overflow: hidden;
  background: rgba(12,14,22,.96); border: 1px solid rgba(255,255,255,.08); box-shadow: 0 20px 60px rgba(0,0,0,.5); }
.kh-shell.two { grid-template-columns: 340px 1fr; } .kh-shell.one { grid-template-columns: 1fr; }
.kh-col { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.kh-col + .kh-col { border-left: 1px solid rgba(255,255,255,.07); }
.kh-top { padding: 14px; display: flex; flex-direction: column; gap: 10px; border-bottom: 1px solid rgba(255,255,255,.07); background: linear-gradient(180deg, rgba(255,98,1,.08), transparent); }
.kh-search { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 12px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); }
.kh-search input { flex: 1; background: transparent; border: 0; outline: none; color: var(--text-strong); font: inherit; font-size: var(--text-sm); }
.kh-filters { display: flex; gap: 6px; flex-wrap: wrap; }
.kh-f { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 999px; font-size: 12px; cursor: pointer; font-family: var(--font-sans); color: var(--text-muted); background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); }
.kh-f.on { color: #fff; border-color: transparent; background: linear-gradient(135deg, rgba(37,211,102,.3), rgba(255,98,1,.38)); box-shadow: inset 0 0 0 1px rgba(255,148,82,.55); }
.kh-list { flex: 1; min-height: 0; overflow-y: auto; }
.kh-item { display: flex; gap: 11px; width: 100%; text-align: left; padding: 12px 14px; border: 0; border-bottom: 1px solid rgba(255,255,255,.04); cursor: pointer; font-family: var(--font-sans); background: transparent; position: relative; transition: background .12s; }
.kh-item:hover { background: rgba(255,255,255,.03); }
.kh-item.on { background: linear-gradient(90deg, rgba(255,98,1,.16), rgba(255,98,1,.03)); }
.kh-item.on::before { content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 3px; background: linear-gradient(#f39200, #ff6201); }
.kh-av { width: 42px; height: 42px; border-radius: 50%; flex: none; display: grid; place-items: center; font-weight: 700; font-size: 14px; color: #fff; position: relative; }
.kh-av .st { position: absolute; right: -1px; bottom: -1px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #0c0e16; }
.kh-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600; }
.kh-unread { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; display: grid; place-items: center; font-size: 11px; font-weight: 800; color: #04130b; background: #25D366; box-shadow: 0 0 10px rgba(37,211,102,.6); }
.kh-head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,.07); background: rgba(255,255,255,.02); }
.kh-btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 10px; cursor: pointer; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: 600; color: var(--text-strong); background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1); }
.kh-btn:hover { background: rgba(255,255,255,.09); }
.kh-btn.hot { color: #fff; border-color: transparent; background: linear-gradient(135deg, #25D366, #128C7E); box-shadow: 0 0 16px rgba(37,211,102,.35); }
.kh-msgs { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 6%; display: flex; flex-direction: column; gap: 4px;
  background: radial-gradient(circle at 20% 10%, rgba(255,98,1,.06), transparent 40%), radial-gradient(circle at 80% 90%, rgba(37,211,102,.05), transparent 40%), #0b111a; }
.kh-day { align-self: center; margin: 10px 0 6px; padding: 4px 12px; border-radius: 999px; font-size: 11px; color: #cbd5e1; background: rgba(255,255,255,.06); }
.kh-b { max-width: min(72%, 520px); padding: 8px 11px 18px; border-radius: 12px; position: relative; font-size: 14px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; color: #e9edef; box-shadow: 0 2px 8px rgba(0,0,0,.25); animation: kh-in .2s both; }
@keyframes kh-in { from { opacity: 0; transform: translateY(4px); } }
.kh-b.lead { align-self: flex-start; background: #1f2c33; border-top-left-radius: 4px; }
.kh-b.mine { align-self: flex-end; background: #005c4b; border-top-right-radius: 4px; }
.kh-b.mine.ia { background: linear-gradient(135deg, #732500, #ad200e); }
.kh-b .meta { position: absolute; right: 9px; bottom: 3px; font-size: 10.5px; color: rgba(233,237,239,.6); display: flex; gap: 5px; align-items: center; }
.kh-b .who { display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 700; margin-bottom: 2px; }
.kh-compose { padding: 10px 14px 14px; border-top: 1px solid rgba(255,255,255,.07); position: relative; background: rgba(255,255,255,.02); }
.kh-box { display: flex; align-items: flex-end; gap: 8px; padding: 6px; border-radius: 16px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1); transition: border-color .15s, box-shadow .15s; }
.kh-box:focus-within { border-color: #ff9452; box-shadow: 0 0 0 3px rgba(255,98,1,.18); }
.kh-box textarea { flex: 1; background: transparent; border: 0; outline: none; resize: none; color: var(--text-strong); font: inherit; font-size: 14px; padding: 8px 6px; max-height: 140px; }
.kh-ic { width: 38px; height: 38px; border-radius: 12px; border: 0; cursor: pointer; display: grid; place-items: center; color: var(--text-muted); background: transparent; flex: none; }
.kh-ic:hover { color: var(--text-strong); background: rgba(255,255,255,.06); }
.kh-send { width: 42px; height: 42px; border-radius: 13px; border: 0; cursor: pointer; display: grid; place-items: center; color: #fff; background: linear-gradient(135deg, #25D366, #128C7E); box-shadow: 0 0 16px rgba(37,211,102,.4); flex: none; }
.kh-send:disabled { opacity: .4; cursor: not-allowed; box-shadow: none; }
.kh-pop { position: absolute; left: 14px; right: 14px; bottom: calc(100% - 4px); border-radius: 14px; overflow: hidden; background: rgba(15,17,26,.98); border: 1px solid rgba(255,255,255,.12); box-shadow: 0 -10px 30px rgba(0,0,0,.5); }
.kh-pop button { display: block; width: 100%; text-align: left; padding: 9px 12px; background: none; border: 0; cursor: pointer; color: var(--text-body); font-family: var(--font-sans); font-size: var(--text-sm); }
.kh-pop button:hover { background: rgba(255,98,1,.14); }
.kh-side { overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 16px; }
.kh-sec { display: flex; flex-direction: column; gap: 8px; }
.kh-sec > span { font-size: 10.5px; color: var(--text-subtle); text-transform: uppercase; letter-spacing: .08em; }
.kh-tag { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 999px; font-size: 12px; cursor: pointer; font-family: var(--font-sans); color: var(--text-muted); background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.09); }
.kh-tag.on { color: #fff; border-color: transparent; background: rgba(255,98,1,.3); box-shadow: inset 0 0 0 1px rgba(255,148,82,.6); }
.kh-empty { flex: 1; display: grid; place-items: center; text-align: center; padding: 30px; background: #0b111a; }
.kh-pulse { width: 80px; height: 80px; border-radius: 50%; margin: 0 auto 14px; display: grid; place-items: center; background: radial-gradient(circle, rgba(37,211,102,.25), transparent 70%); animation: kh-breathe 2.4s ease-in-out infinite; }
@keyframes kh-breathe { 50% { transform: scale(1.08); opacity: .8; } }
`;

function Avatar({ name, size = 42, online }) {
  const h = hue(name);
  return (
    <div className="kh-av" style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${h} 65% 45%), hsl(${(h + 50) % 360} 70% 35%))` }}>
      {ini(name)}{online !== undefined && <span className="st" style={{ background: online ? '#25D366' : '#64748b' }} />}
    </div>
  );
}

function LeadSide({ lead, flows, tags, canEdit, onToggleTag }) {
  const has = new Set((lead.tags || []).map((t) => t.id));
  return (
    <div className="kh-side">
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <Avatar name={nomeOf(lead)} size={72} />
        <div style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: 16 }}>{nomeOf(lead)}</div>
        {lead.valor_compra != null && <div style={{ color: '#34d399', fontWeight: 700 }}>{money(lead.valor_compra)}</div>}
      </div>
      <div className="kh-sec"><span>Contato</span>
        {lead.telefone && <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-strong)' }}><ChannelLogo kind="qr" size={18} />+{lead.telefone}
          <button type="button" className="kh-ic" style={{ width: 26, height: 26 }} title="Copiar" onClick={() => navigator.clipboard && navigator.clipboard.writeText(lead.telefone)}><Icon name="copy" size={13} /></button></div>}
        {lead.email && <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-body)', wordBreak: 'break-all' }}><Icon name="mail" size={15} style={{ color: '#ffb485' }} />{lead.email}</div>}
        {lead.produto && <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}><Icon name="package" size={15} style={{ color: '#f59e0b' }} />{lead.produto}</div>}
        {lead.utm && lead.utm.utm_source && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Veio de: {lead.utm.utm_source}{lead.utm.utm_campaign ? ` · ${lead.utm.utm_campaign}` : ''}</div>}
        {lead.link_recuperacao && <a href={lead.link_recuperacao} target="_blank" rel="noreferrer" style={{ fontSize: 'var(--text-xs)', color: '#ff9452' }}>Abrir link de pagamento ↗</a>}
      </div>
      <div className="kh-sec"><span>Etiquetas</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {tags.length === 0 && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Crie etiquetas em Integrações → Tags.</span>}
          {tags.map((t) => <button key={t.id} type="button" disabled={!canEdit} className={`kh-tag${has.has(t.id) ? ' on' : ''}`} onClick={() => onToggleTag(t, !has.has(t.id))}>{has.has(t.id) && <Icon name="check" size={11} />}{t.nome}</button>)}
        </div>
      </div>
      <div className="kh-sec"><span>Automação</span>
        {lead.automation_paused ? <div style={{ fontSize: 'var(--text-sm)', color: '#fbbf24' }}>Pausada: você está atendendo.</div>
          : flows.length ? flows.map((f) => <div key={f.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}><Icon name="git-branch" size={14} style={{ color: '#ff9452' }} />{f.campanha}<span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{f.status === 'waiting' ? (f.wait_kind === 'reply' ? 'esperando resposta' : 'aguardando') : 'rodando'}</span></div>)
          : <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Nenhum fluxo rodando agora.</div>}
      </div>
      <div className="kh-sec"><span>Histórico de compra</span>
        {!(lead.eventos || []).length && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Nenhum evento do checkout.</div>}
        {(lead.eventos || []).map((e, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--text-xs)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: e.tipo === 'Compra Aprovada' ? '#34d399' : e.tipo === 'Compra Recusada' ? '#fb7185' : '#f39200' }} />
            <span style={{ flex: 1, color: 'var(--text-body)' }}>{e.tipo}{e.produto ? ` · ${e.produto}` : ''}</span>
            <span style={{ color: 'var(--text-subtle)' }}>{e.valor != null ? money(e.valor) : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Conversation({ orgId, leadId, quickReplies, tags, canEdit, notify, onChanged, onBack, showSide }) {
  const [st, setSt] = useState({ loading: true, error: null, lead: null, messages: [], flows: [] });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  const fileRef = useRef(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setSt((s) => ({ ...s, loading: true }));
    const r = await KoblyApi.inbox('messages', { lead_id: leadId }, orgId);
    if (r && r.lead) setSt({ loading: false, error: null, lead: r.lead, messages: r.messages || [], flows: r.flows || [] });
    else setSt((s) => ({ ...s, loading: false, error: (r && r.error) || 'Não deu para abrir a conversa.' }));
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
  async function sendFile(file) {
    if (!file) return;
    const kind = /^image\//.test(file.type) ? 'image' : /^video\//.test(file.type) ? 'video' : /^audio\//.test(file.type) ? 'audio' : 'document';
    setBusy(true);
    const up = await KoblyApi.uploadFlowMedia(file, orgId).catch((e) => ({ error: e.message }));
    if (!up || up.error) { setBusy(false); notify('danger', (up && up.error) || 'Não deu para enviar o arquivo.'); return; }
    const r = await KoblyApi.inbox('send_media', { lead_id: leadId, kind, url: up.url, caption: text.trim() || undefined, filename: file.name }, orgId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    setText('');
    setSt((s) => ({ ...s, messages: [...s.messages, r.message] }));
    onChanged();
  }
  async function pause(paused) {
    const r = await KoblyApi.inbox('pause', { lead_id: leadId, paused }, orgId);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', paused ? `Você assumiu a conversa${r.cancelled ? ` (${r.cancelled} fluxo(s) parado(s))` : ''}.` : 'Conversa devolvida para a automação.');
    load(true); onChanged();
  }
  async function toggleTag(t, on) {
    setSt((s) => ({ ...s, lead: { ...s.lead, tags: on ? [...(s.lead.tags || []), t] : (s.lead.tags || []).filter((x) => x.id !== t.id) } }));
    const r = await KoblyApi.inbox('tags', { lead_id: leadId, [on ? 'add' : 'remove']: [t.id] }, orgId);
    if (r.error) { notify('danger', r.error); load(true); }
  }

  if (st.loading && !st.lead) return <div className="kh-empty"><div><div className="kh-pulse"><ChannelLogo kind="qr" size={36} /></div><div style={{ color: 'var(--text-muted)' }}>Abrindo conversa…</div></div></div>;
  if (!st.lead) return <div className="kh-empty"><div style={{ color: '#fda4af' }}>{st.error}</div></div>;
  const lead = st.lead;
  const slash = text.startsWith('/') ? text.slice(1).toLowerCase() : null;
  const sugest = slash !== null ? quickReplies.filter((q) => q.shortcut.toLowerCase().startsWith(slash)).slice(0, 6) : [];
  let lastDay = '';

  return (
    <>
      <div className="kh-col">
        <div className="kh-head">
          {onBack && <button type="button" className="kh-ic" onClick={onBack} aria-label="Voltar"><Icon name="arrow-left" size={18} /></button>}
          <Avatar name={nomeOf(lead)} size={40} online={lead.janela_aberta} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{nomeOf(lead)}</div>
            <div style={{ fontSize: 'var(--text-xs)', color: lead.automation_paused ? '#fbbf24' : st.flows.length ? '#ff9452' : 'var(--text-muted)' }}>
              {lead.automation_paused ? 'Você está atendendo' : st.flows.length ? `Kobly atendendo pelo fluxo ${st.flows[0].campanha}` : (lead.telefone ? `+${lead.telefone}` : 'sem telefone')}
            </div>
          </div>
          {canEdit && (lead.automation_paused
            ? <button type="button" className="kh-btn" onClick={() => pause(false)}><Icon name="bot" size={15} />Devolver para a Kobly</button>
            : <button type="button" className="kh-btn hot" onClick={() => pause(true)}><Icon name="hand" size={15} />Assumir conversa</button>)}
        </div>
        <div className="kh-msgs">
          {st.messages.length === 0 && <div className="kh-day">Sem mensagens ainda</div>}
          {st.messages.map((m) => {
            const de = DE[m.de] || DE.lead;
            const dl = diaLabel(m.at); const sep = dl !== lastDay; lastDay = dl;
            return (
              <React.Fragment key={m.id}>
                {sep && <div className="kh-day">{dl}</div>}
                <div className={`kh-b ${de.mine ? 'mine' : 'lead'}${m.de === 'agente' ? ' ia' : ''}`}>
                  {de.mine && <div className="who" style={{ color: de.color }}><Icon name={de.icon} size={11} />{de.label}</div>}
                  {m.body || <em style={{ opacity: .7 }}>[{m.tipo}]</em>}
                  <span className="meta">{hora(m.at)}{de.mine && <Icon name="check-check" size={13} style={{ color: '#53bdeb' }} />}</span>
                </div>
              </React.Fragment>
            );
          })}
          <div ref={endRef} />
        </div>
        {canEdit && (
          <div className="kh-compose">
            {sugest.length > 0 && (
              <div className="kh-pop">
                {sugest.map((q) => <button key={q.id} type="button" onClick={() => setText(q.body)}><b style={{ color: '#ff9452' }}>/{q.shortcut}</b> <span style={{ color: 'var(--text-muted)' }}>{q.body.slice(0, 90)}</span></button>)}
              </div>
            )}
            {!lead.janela_aberta ? (
              <div style={{ fontSize: 'var(--text-sm)', color: '#fbbf24', padding: '6px 4px' }}>A API Oficial da Meta só deixa responder em até 24 h depois da última mensagem do lead. Envie um modelo aprovado por um fluxo para reabrir a conversa.</div>
            ) : (
              <div className="kh-box">
                <input ref={fileRef} type="file" hidden accept="image/*,video/mp4,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" onChange={(e) => { sendFile(e.target.files && e.target.files[0]); e.target.value = ''; }} />
                <button type="button" className="kh-ic" title="Enviar arquivo" disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}><Icon name="paperclip" size={18} /></button>
                <button type="button" className="kh-ic" title="Respostas rápidas" onClick={() => setText('/')}><Icon name="zap" size={18} /></button>
                <textarea value={text} rows={1} maxLength={4096} placeholder="Mensagem  ·  digite / para respostas rápidas" onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (sugest.length && slash !== null) setText(sugest[0].body); else send(); } }} />
                <button type="button" className="kh-send" disabled={busy || !text.trim()} onClick={send} aria-label="Enviar"><Icon name={busy ? 'loader-circle' : 'send'} size={18} /></button>
              </div>
            )}
          </div>
        )}
      </div>
      {showSide && <div className="kh-col"><LeadSide lead={lead} flows={st.flows} tags={tags} canEdit={canEdit} onToggleTag={toggleTag} /></div>}
    </>
  );
}

function KoblyChats() {
  const store = useKobly();
  const { isMobile } = useBreakpoint();
  const { orgId, picker, canEdit } = useTargetOrg();
  const [q, setQ] = useState('');
  const [filtro, setFiltro] = useState('todas');
  const [list, setList] = useState({ loading: true, error: null, items: [] });
  const [sel, setSel] = useState(null);
  // vindo do Pipeline: abre a conversa daquele lead (lido uma vez, num efeito)
  useEffect(() => { try { const s = sessionStorage.getItem('kobly:chat-lead'); if (s) { sessionStorage.removeItem('kobly:chat-lead'); setSel(s); } } catch { /* ok */ } }, []);
  const [quick, setQuick] = useState([]);
  const [tags, setTags] = useState([]);
  const [wide, setWide] = useState(() => typeof window === 'undefined' || window.innerWidth > 1280);
  useEffect(() => { const f = () => setWide(window.innerWidth > 1280); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);

  const load = useCallback(async (quiet = false) => {
    if (!orgId) { setList({ loading: false, error: null, items: [] }); return; }
    if (!quiet) setList((s) => ({ ...s, loading: true }));
    const r = await KoblyApi.inbox('list', { q, filtro }, orgId);
    setList({ loading: false, error: r && r.error, items: (r && r.conversations) || [] });
  }, [orgId, q, filtro]);
  useEffect(() => { const t = setTimeout(() => load(), q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { const t = setInterval(() => load(true), POLL_MS); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    if (!orgId) return;
    KoblyApi.workspaceSettings('get', {}, orgId).then((r) => setQuick((r && r.quick_replies) || [])).catch(() => {});
    KoblyApi.getTags().then((t) => setTags(t || [])).catch(() => {});
  }, [orgId]);
  const aguardando = useMemo(() => list.items.filter((c) => c.ultima_de === 'lead').length, [list.items]);

  const listPane = (
    <div className="kh-col">
      <div className="kh-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ChannelLogo kind="qr" size={30} />
          <div style={{ flex: 1 }}><div style={{ fontWeight: 800, color: 'var(--text-strong)' }}>Conversas</div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{aguardando ? `${aguardando} esperando resposta` : 'Tudo respondido'}</div></div>
        </div>
        <div className="kh-search"><Icon name="search" size={15} style={{ color: 'var(--text-subtle)' }} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nome, telefone ou e-mail" /></div>
        <div className="kh-filters">{FILTROS.map(([id, label, ic]) => <button key={id} type="button" className={`kh-f${filtro === id ? ' on' : ''}`} onClick={() => setFiltro(id)}><Icon name={ic} size={12} />{label}</button>)}</div>
      </div>
      <div className="kh-list">
        {list.loading && !list.items.length ? <div style={{ padding: 20, color: 'var(--text-muted)' }}>Carregando…</div>
          : list.items.length === 0 ? <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{orgId ? (filtro === 'todas' ? 'Quando um lead mandar mensagem ou um fluxo enviar, a conversa aparece aqui.' : 'Nenhuma conversa neste filtro.') : 'Escolha a conta do cliente acima.'}</div>
          : list.items.map((c) => (
            <button key={c.lead_id} type="button" className={`kh-item${sel === c.lead_id ? ' on' : ''}`} onClick={() => setSel(c.lead_id)}>
              <Avatar name={nomeOf(c)} online={c.janela_aberta} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontWeight: 700, color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nomeOf(c)}</span>
                  <span style={{ fontSize: 11, color: c.ultima_de === 'lead' ? '#25D366' : 'var(--text-subtle)', flex: 'none' }}>{rel(c.ultima_em)}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <div style={{ flex: 1, fontSize: 'var(--text-xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.ultima_de !== 'lead' && <Icon name={(DE[c.ultima_de] || DE.humano).icon || 'check-check'} size={11} style={{ color: (DE[c.ultima_de] || {}).color, marginRight: 3 }} />}{c.ultima || '[mídia]'}
                  </div>
                  {c.ultima_de === 'lead' && <span className="kh-unread">1</span>}
                </div>
                <div style={{ display: 'flex', gap: 4, marginTop: 5, flexWrap: 'wrap' }}>
                  {c.automation_paused && <span className="kh-badge" style={{ color: '#fbbf24', background: 'rgba(251,191,36,.12)' }}><Icon name="hand" size={10} />Humano</span>}
                  {c.em_fluxo && !c.automation_paused && <span className="kh-badge" style={{ color: '#ff9452', background: 'rgba(255,98,1,.14)' }}><Icon name="git-branch" size={10} />Em fluxo</span>}
                  {c.valor_compra != null && <span className="kh-badge" style={{ color: '#34d399', background: 'rgba(52,211,153,.1)' }}>{money(c.valor_compra)}</span>}
                </div>
              </div>
            </button>
          ))}
      </div>
    </div>
  );
  const conv = sel
    ? <Conversation key={sel} orgId={orgId} leadId={sel} quickReplies={quick} tags={tags} canEdit={canEdit} notify={store.notify} onChanged={() => load(true)} onBack={isMobile ? () => setSel(null) : null} showSide={wide && !isMobile} />
    : <div className="kh-empty"><div><div className="kh-pulse"><ChannelLogo kind="qr" size={40} /></div><div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>Escolha uma conversa</div><div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 6, maxWidth: 360 }}>Veja o que o fluxo e a IA conversaram, responda, mande arquivos ou assuma o atendimento.</div></div></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <style>{KH_CSS}</style>
      {picker}
      <div className={`kh-shell${isMobile ? ' one' : !(sel && wide) ? ' two' : ''}`}>
        {isMobile ? (sel ? conv : listPane) : (<>{listPane}{conv}</>)}
      </div>
    </div>
  );
}

export { KoblyChats };
