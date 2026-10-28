import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Icon } from '@/ds';
import { LeadAvatar } from '@/lib/leadAvatar.jsx';

// Ficha do lead (gaveta à direita), usada no Pipeline e em Leads: foto, contato, etapa, origem, etiquetas, notas,
// números da conversa e a linha do tempo (checkout, fluxos e mensagens). "Abrir conversa" leva ao Chat ao vivo.

export const STAGES = [
  { key: 'novo', label: 'Novo lead', icon: 'sparkles', c: '#f39200' },
  { key: 'contato', label: 'Em contato', icon: 'send', c: '#ff9452' },
  { key: 'respondeu', label: 'Respondeu', icon: 'message-circle-reply', c: '#25D366' },
  { key: 'cobranca', label: 'Cobrança enviada', icon: 'qr-code', c: '#f59e0b' },
  { key: 'comprou', label: 'Comprou', icon: 'badge-check', c: '#34d399' },
  { key: 'perdido', label: 'Perdido', icon: 'circle-x', c: '#fb7185' },
];
export const stageOf = (k) => STAGES.find((s) => s.key === k) || STAGES[0];
export const fmtPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); if (d.length === 13 && d.startsWith('55')) return `+55 (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`; if (d.length === 12 && d.startsWith('55')) return `+55 (${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}`; return d ? `+${d}` : ''; };
export const money = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
export const ORIGEM = { whatsapp: ['message-circle', '#25D366', 'WhatsApp'], facebook: ['facebook', '#1877f2', 'Facebook'], fb: ['facebook', '#1877f2', 'Facebook'], instagram: ['instagram', '#e1306c', 'Instagram'], ig: ['instagram', '#e1306c', 'Instagram'], google: ['search', '#4285f4', 'Google'], tiktok: ['music-2', '#ff0050', 'TikTok'], _sem: ['circle-dashed', '#94a3b8', 'Sem origem'] };
export const origemOf = (o) => ORIGEM[String(o || '_sem').toLowerCase()] || ['link', '#ff9452', o];
const TL = { evento: ['zap', '#f39200'], fluxo: ['git-branch', '#ff9452'], recebida: ['message-circle', '#25D366'], enviada: ['send', '#53bdeb'], criado: ['user-plus', '#a78bfa'] };
const when = (iso) => { const d = new Date(iso); return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`; };

const CSS = `
.ls-back { position: fixed; inset: 0; z-index: 800; background: rgba(0,0,0,.5); animation: ls-f .15s; }
.ls { position: fixed; top: 0; right: 0; bottom: 0; width: 460px; max-width: 100vw; z-index: 801; overflow-y: auto; background: #0f1219; border-left: 1px solid rgba(255,255,255,.08); box-shadow: -20px 0 60px rgba(0,0,0,.6); animation: ls-in .2s ease-out; }
@keyframes ls-in { from { transform: translateX(40px); opacity: 0; } } @keyframes ls-f { from { opacity: 0; } }
.ls-top { position: relative; padding: 26px 22px 20px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; background: radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--c) 28%, transparent), transparent 70%); border-bottom: 1px solid rgba(255,255,255,.06); }
.ls-x { position: absolute; top: 12px; right: 12px; width: 36px; height: 36px; border-radius: 50%; border: 0; cursor: pointer; display: grid; place-items: center; color: #aebac1; background: rgba(255,255,255,.05); }
.ls-x:hover { color: #fff; background: rgba(255,255,255,.1); }
.ls-sec { padding: 16px 22px; border-bottom: 1px solid rgba(255,255,255,.06); display: flex; flex-direction: column; gap: 10px; }
.ls-lb { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-subtle); display: flex; align-items: center; gap: 8px; }
.ls-kv { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
.ls-kv span { display: block; font-size: 11px; color: var(--text-subtle); } .ls-kv b { display: block; font-size: 14px; color: var(--text-strong); font-weight: 600; overflow-wrap: anywhere; }
.ls-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 10px 14px; border-radius: 12px; cursor: pointer; font-family: var(--font-sans); font-size: 14px; font-weight: 600; border: 1px solid rgba(255,255,255,.1); color: var(--text-strong); background: rgba(255,255,255,.05); }
.ls-btn:hover { background: rgba(255,255,255,.09); }
.ls-btn.go { border: 0; color: #04130b; background: #25d366; }
.ls-stages { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.ls-stages button { display: flex; align-items: center; gap: 6px; padding: 8px; border-radius: 10px; cursor: pointer; font-family: var(--font-sans); font-size: 12px; font-weight: 600; color: var(--text-muted); background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07); }
.ls-stages button.on { color: #fff; border-color: var(--c); background: color-mix(in srgb, var(--c) 20%, transparent); }
.ls-tag { display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px; border-radius: 999px; font-size: 12.5px; cursor: pointer; font-family: var(--font-sans); color: var(--text-muted); background: rgba(255,255,255,.03); border: 1px dashed rgba(255,255,255,.14); }
.ls-tag.on { color: #fff; border: 1px solid transparent; background: rgba(255,98,1,.3); }
.ls-notes { width: 100%; min-height: 80px; resize: vertical; border-radius: 10px; border: 1px solid rgba(255,255,255,.1); background: rgba(0,0,0,.25); color: var(--text-strong); font: inherit; font-size: 14px; padding: 10px; outline: none; box-sizing: border-box; }
.ls-notes:focus { border-color: #ff9452; }
.ls-cnt { display: grid; grid-template-columns: repeat(3, 1fr); border-radius: 14px; overflow: hidden; border: 1px solid rgba(255,255,255,.07); }
.ls-cnt div { padding: 12px 6px; text-align: center; background: rgba(255,255,255,.02); } .ls-cnt div + div { border-left: 1px solid rgba(255,255,255,.07); }
.ls-cnt b { display: block; font-size: 22px; color: var(--text-strong); } .ls-cnt span { font-size: 11px; color: var(--text-muted); }
.ls-tl { display: flex; flex-direction: column; }
.ls-tl .it { display: flex; gap: 12px; }
.ls-tl .rail { display: flex; flex-direction: column; align-items: center; width: 30px; flex: none; }
.ls-tl .dot { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; flex: none; }
.ls-tl .ln { flex: 1; width: 2px; min-height: 12px; background: rgba(255,255,255,.08); }
`;

export function LeadSheet({ orgId, leadId, avatar, canEdit = true, tags = [], notify = () => {}, onClose, onChanged, onOpenChat }) {
  const [st, setSt] = useState({ loading: true });
  const [notes, setNotes] = useState('');
  const [dirty, setDirty] = useState(false);
  const load = useCallback(async () => {
    const r = await KoblyApi.pipeline('detail', { lead_id: leadId }, orgId);
    if (r && r.lead) { setSt({ ...r, loading: false }); setNotes(r.lead.notas || ''); setDirty(false); } else setSt({ loading: false, error: (r && r.error) || 'Não deu para abrir o lead.' });
  }, [leadId, orgId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const f = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f); }, [onClose]);

  async function move(stage) {
    const r = await KoblyApi.pipeline('move', { lead_id: leadId, stage }, orgId);
    if (r && r.error) { notify('danger', r.error); return; }
    notify('success', stage === 'auto' ? 'Etapa volta a ser automática.' : `Movido para ${stageOf(stage).label}.`);
    load(); onChanged && onChanged();
  }
  async function toggleTag(t, on) {
    setSt((s) => ({ ...s, lead: { ...s.lead, tags: on ? [...s.lead.tags, t] : s.lead.tags.filter((x) => x.id !== t.id) } }));
    const r = await KoblyApi.inbox('tags', { lead_id: leadId, [on ? 'add' : 'remove']: [t.id] }, orgId);
    if (r && r.error) { notify('danger', r.error); load(); } else onChanged && onChanged();
  }
  async function saveNotes() {
    const r = await KoblyApi.inbox('notes', { lead_id: leadId, text: notes }, orgId);
    if (r && r.error) notify('danger', r.error); else { notify('success', 'Nota salva.'); setDirty(false); }
  }

  const l = st.lead;
  const sg = l ? stageOf(l.etapa) : STAGES[0];
  const has = new Set(((l && l.tags) || []).map((t) => t.id));
  const og = l ? origemOf(l.origem) : null;
  return (
    <>
      <style>{CSS}</style>
      <div className="ls-back" onClick={onClose} />
      <aside className="ls" role="dialog" aria-label="Ficha do lead" style={{ '--c': sg.c }}>
        {st.loading && <div style={{ padding: 40, color: 'var(--text-muted)' }}>Abrindo…</div>}
        {!st.loading && !l && <div style={{ padding: 40, color: '#fda4af' }}>{st.error}</div>}
        {l && <>
          <div className="ls-top">
            <button type="button" className="ls-x" onClick={onClose} aria-label="Fechar"><Icon name="x" size={18} /></button>
            <LeadAvatar name={l.nome} src={avatar || l.avatar_url} size={104} ring={sg.c} />
            <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-strong)', marginTop: 6 }}>{l.nome}</div>
            {l.telefone && <div style={{ fontSize: 14, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>{fmtPhone(l.telefone)}
              <button type="button" className="ls-x" style={{ position: 'static', width: 26, height: 26 }} title="Copiar número" onClick={() => { navigator.clipboard && navigator.clipboard.writeText(l.telefone); notify('success', 'Número copiado.'); }}><Icon name="copy" size={13} /></button></div>}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center', marginTop: 2 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: sg.c, background: `color-mix(in srgb, ${sg.c} 15%, transparent)` }}><Icon name={sg.icon} size={12} />{sg.label}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: og[1], background: `color-mix(in srgb, ${og[1]} 15%, transparent)` }}><Icon name={og[0]} size={12} />{og[2]}</span>
              {l.em_fluxo && !l.humano && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: '#ff9452', background: 'rgba(255,98,1,.14)' }}><Icon name="git-branch" size={12} />Em fluxo</span>}
              {l.humano && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: '#fbbf24', background: 'rgba(251,191,36,.14)' }}><Icon name="hand" size={12} />Com humano</span>}
              {l.opt_out && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: '#fb7185', background: 'rgba(251,113,133,.14)' }}><Icon name="ban" size={12} />Pediu para sair</span>}
            </div>
            {l.telefone && <div style={{ display: 'flex', gap: 8, marginTop: 10, width: '100%' }}>
              <button type="button" className="ls-btn go" style={{ flex: 1 }} onClick={() => onOpenChat(l)}><Icon name="message-circle" size={16} />Abrir conversa</button>
              <a className="ls-btn" href={`https://wa.me/${String(l.telefone).replace(/\D/g, '')}`} target="_blank" rel="noreferrer" title="Abrir no WhatsApp" style={{ textDecoration: 'none' }}><Icon name="external-link" size={16} /></a>
            </div>}
          </div>
          <div className="ls-sec">
            <div className="ls-cnt">
              <div><b>{st.counts.recebidas}</b><span>Mensagens dele</span></div>
              <div><b>{st.counts.enviadas}</b><span>Enviadas</span></div>
              <div><b>{st.counts.fluxos}</b><span>Fluxos</span></div>
            </div>
          </div>
          <div className="ls-sec">
            <div className="ls-lb"><Icon name="columns-3" size={13} />Etapa no pipeline{l.manual && canEdit && <button type="button" onClick={() => move('auto')} style={{ marginLeft: 'auto', background: 'none', border: 0, color: '#ff9452', cursor: 'pointer', fontSize: 12, fontFamily: 'var(--font-sans)' }}>Voltar para automática</button>}</div>
            <div className="ls-stages">{STAGES.map((s) => <button key={s.key} type="button" disabled={!canEdit} className={l.etapa === s.key ? 'on' : ''} style={{ '--c': s.c }} onClick={() => l.etapa !== s.key && move(s.key)}><Icon name={s.icon} size={13} style={{ color: s.c }} />{s.label}</button>)}</div>
          </div>
          <div className="ls-sec">
            <div className="ls-lb"><Icon name="user" size={13} />Dados</div>
            <div className="ls-kv">
              <div><span>E-mail</span><b>{l.email || '—'}</b></div>
              <div><span>Produto</span><b>{l.produto || '—'}</b></div>
              <div><span>Valor</span><b style={{ color: l.valor ? '#34d399' : undefined }}>{money(l.valor)}</b></div>
              <div><span>Pagamento</span><b>{l.metodo || '—'}</b></div>
              <div><span>Último evento</span><b>{l.ultimo_evento || '—'}</b></div>
              <div><span>Criado em</span><b>{l.criado ? new Date(l.criado).toLocaleDateString('pt-BR') : '—'}</b></div>
              {l.utm && l.utm.utm_campaign && <div style={{ gridColumn: '1 / -1' }}><span>Campanha</span><b>{l.utm.utm_campaign}{l.utm.utm_medium ? ` · ${l.utm.utm_medium}` : ''}</b></div>}
            </div>
            {l.link && <a href={l.link} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: '#ff9452' }}>Abrir link de pagamento ↗</a>}
          </div>
          <div className="ls-sec">
            <div className="ls-lb"><Icon name="tag" size={13} />Etiquetas</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {!tags.length && !(l.tags || []).length && <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Crie etiquetas em Integrações → Tags.</span>}
              {(tags.length ? tags : l.tags).map((t) => <button key={t.id} type="button" disabled={!canEdit} className={`ls-tag${has.has(t.id) ? ' on' : ''}`} onClick={() => toggleTag(t, !has.has(t.id))}><Icon name={has.has(t.id) ? 'check' : 'plus'} size={12} />{t.nome}</button>)}
            </div>
          </div>
          <div className="ls-sec">
            <div className="ls-lb"><Icon name="sticky-note" size={13} />Notas internas</div>
            <textarea className="ls-notes" value={notes} disabled={!canEdit} maxLength={4000} placeholder="Anote o que importa sobre este lead (só a equipe vê)" onChange={(e) => { setNotes(e.target.value); setDirty(true); }} />
            {dirty && <button type="button" className="ls-btn" style={{ alignSelf: 'flex-end', borderColor: 'rgba(255,148,82,.5)', color: '#ffb27d' }} onClick={saveNotes}><Icon name="check" size={15} />Salvar nota</button>}
          </div>
          <div className="ls-sec" style={{ borderBottom: 0 }}>
            <div className="ls-lb"><Icon name="history" size={13} />Linha do tempo</div>
            <div className="ls-tl">
              {st.timeline.map((it, i) => {
                const [ic, c] = TL[it.kind] || TL.evento;
                return (
                  <div key={i} className="it">
                    <div className="rail"><span className="dot" style={{ color: c, background: `color-mix(in srgb, ${c} 16%, transparent)` }}><Icon name={ic} size={14} /></span>{i < st.timeline.length - 1 && <span className="ln" />}</div>
                    <div style={{ flex: 1, minWidth: 0, paddingBottom: 14 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><b style={{ flex: 1, fontSize: 13.5, color: 'var(--text-strong)' }}>{it.titulo}</b><span style={{ fontSize: 11, color: 'var(--text-subtle)', flex: 'none' }}>{when(it.at)}</span></div>
                      {it.sub && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.sub}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>}
      </aside>
    </>
  );
}
