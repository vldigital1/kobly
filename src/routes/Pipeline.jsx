import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Icon, Select } from '@/ds';
import { useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Pipeline de WhatsApp e vendas. Colunas pelo que aconteceu com o lead: Novo → Em contato (a Kobly mandou
// mensagem) → Respondeu → Cobrança → Comprou, e Perdido. Arraste o cartão para mudar a etapa à mão; clique para
// abrir a conversa no Chat ao vivo. KoblyPipeline

const STAGES = [
  { key: 'novo', label: 'Novo lead', icon: 'sparkles', c: '#22d3ee', hint: 'Chegou e ainda não recebeu mensagem' },
  { key: 'contato', label: 'Em contato', icon: 'send', c: '#a78bfa', hint: 'A Kobly já mandou mensagem' },
  { key: 'respondeu', label: 'Respondeu', icon: 'message-circle-reply', c: '#25D366', hint: 'O lead respondeu no WhatsApp' },
  { key: 'cobranca', label: 'Cobrança enviada', icon: 'qr-code', c: '#f59e0b', hint: 'Pix, boleto ou cobrança do fluxo gerada' },
  { key: 'comprou', label: 'Comprou', icon: 'badge-check', c: '#34d399', hint: 'Compra aprovada' },
  { key: 'perdido', label: 'Perdido', icon: 'circle-x', c: '#fb7185', hint: 'Pediu para sair, reembolso ou movido à mão' },
];
const money = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const ini = (s) => String(s || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const rel = (iso) => { if (!iso) return ''; const s = (Date.now() - new Date(iso).getTime()) / 1000; if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`; if (s < 86400) return `${Math.round(s / 3600)} h`; return `${Math.round(s / 86400)} d`; };

const KP_CSS = `
.kp-sum { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.kp-s { border-radius: 16px; padding: 14px 16px; background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.012)), rgba(15,17,26,.95); border: 1px solid rgba(255,255,255,.08); position: relative; overflow: hidden; }
.kp-s::before { content: ''; position: absolute; left: 14px; right: 14px; top: -1px; height: 2px; background: linear-gradient(90deg, transparent, var(--c), transparent); }
.kp-s span { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .07em; } .kp-s b { display: block; font-size: 24px; color: var(--text-strong); margin-top: 4px; }
.kp-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.kp-search { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 12px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); flex: 1; min-width: 220px; max-width: 380px; }
.kp-search input { flex: 1; background: transparent; border: 0; outline: none; color: var(--text-strong); font: inherit; font-size: var(--text-sm); }
.kp-seg { display: inline-flex; padding: 4px; gap: 4px; border-radius: 12px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); }
.kp-seg button { border: 0; padding: 7px 12px; border-radius: 9px; background: transparent; color: var(--text-muted); cursor: pointer; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: 600; }
.kp-seg button.on { color: #fff; background: linear-gradient(135deg, rgba(34,211,238,.3), rgba(139,92,246,.42)); box-shadow: inset 0 0 0 1px rgba(167,139,250,.55); }
.kp-board { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(270px, 1fr); gap: 12px; overflow-x: auto; padding-bottom: 8px; min-height: 520px; }
.kp-col { display: flex; flex-direction: column; min-height: 0; border-radius: 18px; background: rgba(12,14,22,.9); border: 1px solid rgba(255,255,255,.07); transition: border-color .15s, box-shadow .15s; }
.kp-col.over { border-color: var(--c); box-shadow: 0 0 0 1px var(--c), 0 0 26px color-mix(in srgb, var(--c) 30%, transparent); }
.kp-head { padding: 14px 14px 10px; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid rgba(255,255,255,.06); }
.kp-head .t { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--text-strong); }
.kp-head .ico { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; color: var(--c); background: color-mix(in srgb, var(--c) 15%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 35%, transparent); }
.kp-head .n { margin-left: auto; padding: 1px 9px; border-radius: 999px; font-size: 12px; color: var(--c); background: color-mix(in srgb, var(--c) 12%, transparent); }
.kp-meter { height: 4px; border-radius: 999px; background: rgba(255,255,255,.06); overflow: hidden; }
.kp-meter span { display: block; height: 100%; background: var(--c); box-shadow: 0 0 8px var(--c); transition: width .6s; }
.kp-list { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; max-height: calc(100dvh - 380px); }
.kp-card { position: relative; border-radius: 14px; padding: 11px 12px; cursor: grab; display: flex; flex-direction: column; gap: 7px; background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.015)); border: 1px solid rgba(255,255,255,.08); transition: transform .12s, border-color .15s, box-shadow .15s; animation: kp-in .3s both; }
.kp-card:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--c) 50%, transparent); box-shadow: 0 8px 22px rgba(0,0,0,.4), 0 0 16px color-mix(in srgb, var(--c) 16%, transparent); }
.kp-card.drag { opacity: .4; }
@keyframes kp-in { from { opacity: 0; transform: translateY(4px); } }
.kp-av { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; color: #fff; flex: none; }
.kp-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600; }
.kp-more { margin: 2px 10px 10px; padding: 8px; border-radius: 10px; border: 1px dashed rgba(255,255,255,.12); background: transparent; color: var(--text-muted); cursor: pointer; font-family: var(--font-sans); font-size: 12px; }
.kp-more:hover { color: var(--text-strong); border-color: rgba(167,139,250,.5); }
`;

function KoblyPipeline() {
  const store = useKobly();
  const { orgId, picker, canEdit } = useTargetOrg();
  const [days, setDays] = useState(30);
  const [q, setQ] = useState('');
  const [tagId, setTagId] = useState('');
  const [tags, setTags] = useState([]);
  const [cols, setCols] = useState(null);
  const [drag, setDrag] = useState(null); // { id, from }
  const [over, setOver] = useState(null);

  const filters = { days: days || undefined, q, tag_id: tagId || undefined };
  const load = useCallback(async () => {
    if (!orgId) { setCols(null); return; }
    const r = await KoblyApi.pipeline('board', { days: days || undefined, q, tag_id: tagId || undefined }, orgId).catch(() => null);
    setCols(r && r.columns ? r.columns : Object.fromEntries(STAGES.map((s) => [s.key, { total: 0, valor: 0, leads: [] }])));
  }, [orgId, days, q, tagId]);
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { KoblyApi.getTags().then((t) => setTags(t || [])).catch(() => {}); }, [orgId]);

  async function more(stage) {
    const r = await KoblyApi.pipeline('more', { ...filters, stage, offset: cols[stage].leads.length }, orgId);
    if (r && r.leads) setCols((c) => ({ ...c, [stage]: { ...c[stage], leads: [...c[stage].leads, ...r.leads] } }));
  }
  async function drop(stage) {
    setOver(null);
    if (!drag || drag.from === stage) return;
    const lead = cols[drag.from].leads.find((l) => l.id === drag.id);
    setCols((c) => ({ ...c, [drag.from]: { ...c[drag.from], total: c[drag.from].total - 1, valor: c[drag.from].valor - Number(lead.valor || 0), leads: c[drag.from].leads.filter((l) => l.id !== drag.id) },
      [stage]: { ...c[stage], total: c[stage].total + 1, valor: c[stage].valor + Number(lead.valor || 0), leads: [{ ...lead, etapa: stage, manual: true }, ...c[stage].leads] } }));
    const r = await KoblyApi.pipeline('move', { lead_id: drag.id, stage }, orgId);
    setDrag(null);
    if (r && r.error) { store.notify('danger', r.error); load(); } else store.notify('success', `${lead.nome} → ${STAGES.find((s) => s.key === stage).label}`);
  }
  async function auto(lead) {
    const r = await KoblyApi.pipeline('move', { lead_id: lead.id, stage: 'auto' }, orgId);
    if (r && r.error) store.notify('danger', r.error); else { store.notify('info', 'O lead volta para a etapa automática.'); load(); }
  }
  const openChat = (lead) => { try { sessionStorage.setItem('kobly:chat-lead', lead.id); } catch { /* ok */ } store.navigate('chats'); };

  const total = cols ? STAGES.reduce((a, s) => a + cols[s.key].total, 0) : 0;
  const aberto = cols ? ['novo', 'contato', 'respondeu', 'cobranca'].reduce((a, k) => a + cols[k].valor, 0) : 0;
  const ganho = cols ? cols.comprou.valor : 0;
  const conv = total && cols ? Math.round((cols.comprou.total / total) * 100) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{KP_CSS}</style>
      {picker}
      <div className="kp-sum">
        <div className="kp-s" style={{ '--c': '#22d3ee' }}><span>Leads no pipeline</span><b>{total.toLocaleString('pt-BR')}</b></div>
        <div className="kp-s" style={{ '--c': '#f59e0b' }}><span>Em negociação</span><b>{money(aberto)}</b></div>
        <div className="kp-s" style={{ '--c': '#34d399' }}><span>Vendido</span><b>{money(ganho)}</b></div>
        <div className="kp-s" style={{ '--c': '#a78bfa' }}><span>Conversão</span><b>{conv}%</b></div>
      </div>
      <div className="kp-bar">
        <div className="kp-search"><Icon name="search" size={15} style={{ color: 'var(--text-subtle)' }} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nome, telefone, e-mail ou produto" /></div>
        <div className="kp-seg">{[[7, '7 dias'], [30, '30 dias'], [90, '90 dias'], [0, 'Tudo']].map(([v, l]) => <button key={v} type="button" className={days === v ? 'on' : ''} onClick={() => setDays(v)}>{l}</button>)}</div>
        <Select value={tagId} onChange={(e) => setTagId(e.target.value)} style={{ minWidth: 180 }} options={[{ value: '', label: 'Todas as etiquetas' }, ...tags.map((t) => ({ value: t.id, label: t.nome }))]} />
      </div>
      <div className="kp-board">
        {STAGES.map((s) => {
          const c = cols ? cols[s.key] : { total: 0, valor: 0, leads: [] };
          return (
            <div key={s.key} className={`kp-col${over === s.key ? ' over' : ''}`} style={{ '--c': s.c }}
              onDragOver={(e) => { if (drag && canEdit) { e.preventDefault(); setOver(s.key); } }} onDragLeave={() => setOver(null)} onDrop={(e) => { e.preventDefault(); drop(s.key); }}>
              <div className="kp-head" title={s.hint}>
                <div className="t"><span className="ico"><Icon name={s.icon} size={15} /></span>{s.label}<span className="n">{c.total}</span></div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.valor ? money(c.valor) : '—'}</div>
                <div className="kp-meter"><span style={{ width: `${total ? (c.total / total) * 100 : 0}%` }} /></div>
              </div>
              <div className="kp-list">
                {!cols && <div style={{ color: 'var(--text-subtle)', fontSize: 12, padding: 6 }}>Carregando…</div>}
                {cols && !c.leads.length && <div style={{ color: 'var(--text-subtle)', fontSize: 12, padding: 6, textAlign: 'center' }}>{canEdit ? 'Arraste um lead para cá' : 'Vazio'}</div>}
                {c.leads.map((l, i) => {
                  const h = hue(l.nome);
                  return (
                    <div key={l.id} className={`kp-card${drag && drag.id === l.id ? ' drag' : ''}`} style={{ animationDelay: `${Math.min(i, 10) * 25}ms` }} draggable={canEdit}
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDrag({ id: l.id, from: s.key }); }} onDragEnd={() => { setDrag(null); setOver(null); }} onClick={() => openChat(l)} title="Abrir conversa">
                      <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
                        <span className="kp-av" style={{ background: `linear-gradient(135deg, hsl(${h} 65% 45%), hsl(${(h + 50) % 360} 70% 35%))` }}>{ini(l.nome)}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.nome}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.produto || (l.telefone ? `+${l.telefone}` : l.email)}</div>
                        </div>
                        {l.valor != null && <b style={{ fontSize: 13, color: '#34d399' }}>{money(l.valor)}</b>}
                      </div>
                      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                        {l.em_fluxo && !l.humano && <span className="kp-chip" style={{ color: '#a78bfa', background: 'rgba(139,92,246,.14)' }}><Icon name="git-branch" size={10} />em fluxo</span>}
                        {l.humano && <span className="kp-chip" style={{ color: '#fbbf24', background: 'rgba(251,191,36,.12)' }}><Icon name="hand" size={10} />humano</span>}
                        {l.manual && <button type="button" className="kp-chip" title="Voltar para a etapa automática" style={{ color: '#94a3b8', background: 'rgba(148,163,184,.1)', border: 0, cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); auto(l); }}><Icon name="pin" size={10} />manual</button>}
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-subtle)' }}>{rel(l.ultima || l.criado)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {cols && c.leads.length < c.total && <button type="button" className="kp-more" onClick={() => more(s.key)}>Ver mais ({c.total - c.leads.length})</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { KoblyPipeline };
