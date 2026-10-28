import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Icon } from '@/ds';
import { LeadAvatar, downloadText, useLeadAvatars } from '@/lib/leadAvatar.jsx';
import { LeadSheet, STAGES, fmtPhone, origemOf } from '@/lib/leadSheet.jsx';
import { useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Pipeline de WhatsApp e vendas. Colunas pelo que aconteceu com o lead: Novo → Em contato (a Kobly mandou
// mensagem) → Respondeu → Cobrança → Comprou, e Perdido. Cartão com a foto do WhatsApp, a última mensagem, as
// etiquetas e a origem. Arraste para mudar a etapa; clique para abrir a ficha; "conversa" leva ao Chat ao vivo.
// Filtros por período, etiqueta e número de WhatsApp; esconder colunas; atualizar sozinho; baixar planilha. KoblyPipeline

const HINT = { novo: 'Chegou e ainda não recebeu mensagem', contato: 'A Kobly já mandou mensagem', respondeu: 'O lead respondeu no WhatsApp', cobranca: 'Pix, boleto ou cobrança do fluxo gerada', comprou: 'Compra aprovada', perdido: 'Pediu para sair, reembolso ou movido à mão' };
const HIDDEN_KEY = 'kobly:pipeline-hidden';
const POLL_MS = 30000;
const money = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const rel = (iso) => { if (!iso) return ''; const s = (Date.now() - new Date(iso).getTime()) / 1000; if (s < 60) return 'agora'; if (s < 3600) return `${Math.round(s / 60)} min`; if (s < 86400) return `${Math.round(s / 3600)} h`; return `${Math.round(s / 86400)} d`; };
const TIPO = { image: ['image', 'Foto'], audio: ['mic', 'Áudio'], video: ['video', 'Vídeo'], document: ['file-text', 'Arquivo'], sticker: ['smile', 'Figurinha'] };
const DE = { lead: null, fluxo: ['git-branch', '#ff9452'], agente: ['sparkles', '#f39200'], humano: ['check-check', '#53bdeb'], celular: ['check-check', '#53bdeb'] };

const KP_CSS = `
.kp-sum { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.kp-s { border-radius: 16px; padding: 14px 16px; background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.012)), rgba(15,17,26,.95); border: 1px solid rgba(255,255,255,.08); position: relative; overflow: hidden; display: flex; gap: 12px; align-items: center; }
.kp-s::before { content: ''; position: absolute; left: 14px; right: 14px; top: -1px; height: 2px; background: linear-gradient(90deg, transparent, var(--c), transparent); }
.kp-s .i { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); flex: none; }
.kp-s span { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .07em; } .kp-s b { display: block; font-size: 22px; color: var(--text-strong); margin-top: 2px; }
.kp-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.kp-search { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 40px; border-radius: 12px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); flex: 1; min-width: 220px; max-width: 360px; }
.kp-search input { flex: 1; background: transparent; border: 0; outline: none; color: var(--text-strong); font: inherit; font-size: var(--text-sm); }
.kp-seg { display: inline-flex; padding: 4px; gap: 4px; border-radius: 12px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); }
.kp-seg button { border: 0; padding: 6px 11px; border-radius: 9px; background: transparent; color: var(--text-muted); cursor: pointer; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: 600; }
.kp-seg button.on { color: #fff; background: linear-gradient(135deg, rgba(243,146,0,.3), rgba(255,98,1,.42)); box-shadow: inset 0 0 0 1px rgba(255,148,82,.55); }
.kp-dd { position: relative; }
.kp-ddb { display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px; border-radius: 12px; cursor: pointer; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: 600; color: var(--text-strong); background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); white-space: nowrap; }
.kp-ddb:hover { background: rgba(255,255,255,.08); }
.kp-ddb.act { border-color: rgba(255,148,82,.6); color: #ffb27d; }
.kp-ic { width: 40px; padding: 0; justify-content: center; }
.kp-menu { position: absolute; top: calc(100% + 6px); left: 0; z-index: 60; min-width: 240px; max-height: 340px; overflow-y: auto; padding: 6px; border-radius: 14px; background: #161a24; border: 1px solid rgba(255,255,255,.1); box-shadow: 0 16px 40px rgba(0,0,0,.55); }
.kp-menu.r { left: auto; right: 0; }
.kp-menu button { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 9px 10px; border-radius: 9px; background: none; border: 0; cursor: pointer; color: var(--text-body); font-family: var(--font-sans); font-size: 13.5px; }
.kp-menu button:hover { background: rgba(255,98,1,.14); }
.kp-menu .ck { width: 16px; display: grid; place-items: center; color: #ff9452; }
.kp-menu .n { margin-left: auto; font-size: 11px; color: var(--text-subtle); }
.kp-board { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(290px, 1fr); gap: 12px; overflow-x: auto; padding-bottom: 8px; }
.kp-col { display: flex; flex-direction: column; min-height: 0; border-radius: 18px; background: rgba(12,14,22,.9); border: 1px solid rgba(255,255,255,.07); border-top: 3px solid var(--c); transition: border-color .15s, box-shadow .15s; }
.kp-col.over { border-color: var(--c); box-shadow: 0 0 0 1px var(--c), 0 0 26px color-mix(in srgb, var(--c) 30%, transparent); }
.kp-head { padding: 12px 14px 10px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid rgba(255,255,255,.06); }
.kp-head .t { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--text-strong); }
.kp-head .ico { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; color: var(--c); background: color-mix(in srgb, var(--c) 15%, transparent); }
.kp-head .n { margin-left: auto; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 700; color: var(--c); background: color-mix(in srgb, var(--c) 12%, transparent); }
.kp-meter { height: 4px; border-radius: 999px; background: rgba(255,255,255,.06); overflow: hidden; }
.kp-meter span { display: block; height: 100%; background: var(--c); box-shadow: 0 0 8px var(--c); transition: width .6s; }
.kp-list { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; max-height: calc(100dvh - 360px); min-height: 200px; }
.kp-card { position: relative; border-radius: 14px; padding: 11px 12px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 8px; background: #141822; border: 1px solid rgba(255,255,255,.07); transition: transform .12s, border-color .15s, box-shadow .15s; animation: kp-in .3s both; }
.kp-card:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--c) 55%, transparent); box-shadow: 0 8px 22px rgba(0,0,0,.4); }
.kp-card.drag { opacity: .35; }
.kp-card .acts { position: absolute; top: 8px; right: 8px; display: none; gap: 4px; }
.kp-card:hover .acts { display: flex; }
.kp-card .acts button { width: 28px; height: 28px; border-radius: 8px; border: 0; cursor: pointer; display: grid; place-items: center; color: #e9edef; background: rgba(255,255,255,.08); }
.kp-card .acts button:hover { background: #25d366; color: #04130b; }
@keyframes kp-in { from { opacity: 0; transform: translateY(4px); } }
.kp-msg { display: flex; align-items: center; gap: 5px; font-size: 12.5px; color: #8696a0; padding: 6px 8px; border-radius: 8px; background: rgba(255,255,255,.03); overflow: hidden; }
.kp-msg span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kp-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.kp-more { margin: 2px 10px 10px; padding: 8px; border-radius: 10px; border: 1px dashed rgba(255,255,255,.12); background: transparent; color: var(--text-muted); cursor: pointer; font-family: var(--font-sans); font-size: 12px; }
.kp-more:hover { color: var(--text-strong); border-color: rgba(255,148,82,.5); }
.kp-empty { color: var(--text-subtle); font-size: 12.5px; padding: 26px 10px; text-align: center; border: 1px dashed rgba(255,255,255,.08); border-radius: 12px; }
`;

function Dropdown({ label, icon, active, right, children, iconOnly, title }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (!open) return undefined; const f = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener('mousedown', f); return () => document.removeEventListener('mousedown', f); }, [open]);
  return (
    <div className="kp-dd" ref={ref}>
      <button type="button" title={title} className={`kp-ddb${active ? ' act' : ''}${iconOnly ? ' kp-ic' : ''}`} onClick={() => setOpen((v) => !v)}><Icon name={icon} size={16} />{!iconOnly && label}{!iconOnly && <Icon name="chevron-down" size={14} />}</button>
      {open && <div className={`kp-menu${right ? ' r' : ''}`} onClick={(e) => { if (e.target.closest('[data-close]')) setOpen(false); }}>{children}</div>}
    </div>
  );
}

function Card({ l, s, drag, canEdit, avatar, onDrag, onDragEnd, onOpen, onChat, onAuto, delay }) {
  const t = l.ultima_msg && TIPO[l.ultima_msg.tipo];
  const de = l.ultima_msg && DE[l.ultima_msg.de];
  const og = l.origem ? origemOf(l.origem) : null;
  const msg = l.ultima_msg ? (t && (!l.ultima_msg.body || /^\[/.test(l.ultima_msg.body)) ? t[1] : l.ultima_msg.body) : null;
  return (
    <div className={`kp-card${drag ? ' drag' : ''}`} style={{ animationDelay: `${delay}ms` }} draggable={canEdit}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDrag(); }} onDragEnd={onDragEnd} onClick={onOpen}>
      <div className="acts">
        {(l.telefone || l.canal) && <button type="button" title="Abrir conversa" onClick={(e) => { e.stopPropagation(); onChat(); }}><Icon name="message-circle" size={14} /></button>}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <LeadAvatar name={l.nome} src={avatar} size={40} dot={l.humano ? '#fbbf24' : l.em_fluxo ? '#ff9452' : null} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 30 }}>{l.nome}</div>
          <div style={{ fontSize: 12, color: 'var(--text-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.produto || fmtPhone(l.telefone) || (l.ig_username ? `@${l.ig_username}` : l.canal === 'messenger' ? 'Messenger' : l.email)}</div>
        </div>
      </div>
      {msg && <div className="kp-msg">{de && <Icon name={de[0]} size={13} style={{ color: de[1], flex: 'none' }} />}{t && <Icon name={t[0]} size={13} style={{ flex: 'none' }} />}<span>{msg}</span></div>}
      {(l.tags || []).length > 0 && <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {l.tags.slice(0, 3).map((tg) => <span key={tg.id} className="kp-chip" style={{ color: '#bfdbfe', background: 'rgba(59,130,246,.18)' }}>{tg.nome}</span>)}
        {l.tags.length > 3 && <span className="kp-chip" style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,.06)' }}>+{l.tags.length - 3}</span>}
      </div>}
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
        {og && <span className="kp-chip" title={`Origem: ${og[2]}`} style={{ color: og[1], background: `color-mix(in srgb, ${og[1]} 14%, transparent)` }}><Icon name={og[0]} size={10} />{og[2]}</span>}
        {l.em_fluxo && !l.humano && <span className="kp-chip" style={{ color: '#ff9452', background: 'rgba(255,98,1,.14)' }}><Icon name="git-branch" size={10} />em fluxo</span>}
        {l.humano && <span className="kp-chip" style={{ color: '#fbbf24', background: 'rgba(251,191,36,.12)' }}><Icon name="hand" size={10} />humano</span>}
        {l.manual && canEdit && <button type="button" className="kp-chip" title="Voltar para a etapa automática" style={{ color: '#94a3b8', background: 'rgba(148,163,184,.1)', border: 0, cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); onAuto(); }}><Icon name="pin" size={10} />manual</button>}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {l.valor != null && Number(l.valor) > 0 && <b style={{ fontSize: 12.5, color: '#34d399' }}>{money(l.valor)}</b>}
          <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{rel(l.ultima || l.criado)}</span>
        </span>
      </div>
    </div>
  );
}

function KoblyPipeline() {
  const store = useKobly();
  const { orgId, picker, canEdit } = useTargetOrg();
  const [days, setDays] = useState(30);
  const [q, setQ] = useState('');
  const [tagId, setTagId] = useState('');
  const [inst, setInst] = useState('');
  const [tags, setTags] = useState([]);
  const [conns, setConns] = useState([]);
  const [cols, setCols] = useState(null);
  const [drag, setDrag] = useState(null); // { id, from }
  const [over, setOver] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [spin, setSpin] = useState(false);
  const [hidden, setHidden] = useState(() => { try { return JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]'); } catch { return []; } });
  useEffect(() => { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden)); } catch { /* ok */ } }, [hidden]);

  const filters = { days: days || undefined, q, tag_id: tagId || undefined, instance_id: inst || undefined };
  const load = useCallback(async () => {
    if (!orgId) { setCols(null); return; }
    const r = await KoblyApi.pipeline('board', { days: days || undefined, q, tag_id: tagId || undefined, instance_id: inst || undefined }, orgId).catch(() => null);
    setCols(r && r.columns ? r.columns : Object.fromEntries(STAGES.map((s) => [s.key, { total: 0, valor: 0, leads: [] }])));
  }, [orgId, days, q, tagId, inst]);
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { const t = setInterval(() => { if (document.visibilityState === 'visible' && !drag) load(); }, POLL_MS); return () => clearInterval(t); }, [load, drag]);
  useEffect(() => {
    KoblyApi.getTags().then((t) => setTags(t || [])).catch(() => {});
    if (orgId) KoblyApi.uazapi('list', {}, orgId).then((r) => setConns((r && r.instances) || [])).catch(() => {});
  }, [orgId]);
  const allLeads = useMemo(() => (cols ? STAGES.flatMap((s) => cols[s.key].leads) : []), [cols]);
  const photo = useLeadAvatars(orgId, allLeads);

  async function refresh() { setSpin(true); await load(); setTimeout(() => setSpin(false), 400); }
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
  async function exportCsv() {
    const r = await KoblyApi.pipeline('export', filters, orgId);
    if (!r || r.error) { store.notify('danger', (r && r.error) || 'Não deu para gerar a planilha.'); return; }
    downloadText(`pipeline-kobly-${new Date().toISOString().slice(0, 10)}.csv`, r.csv);
    store.notify('success', `Planilha com ${r.count} leads baixada.`);
  }
  const openChat = (lead) => { try { sessionStorage.setItem('kobly:chat-lead', lead.id); } catch { /* ok */ } store.navigate('chats'); };

  const total = cols ? STAGES.reduce((a, s) => a + cols[s.key].total, 0) : 0;
  const aberto = cols ? ['novo', 'contato', 'respondeu', 'cobranca'].reduce((a, k) => a + cols[k].valor, 0) : 0;
  const ganho = cols ? cols.comprou.valor : 0;
  const conv = total && cols ? Math.round((cols.comprou.total / total) * 100) : 0;
  const visible = STAGES.filter((s) => !hidden.includes(s.key));
  const tagName = tagId && (tags.find((t) => t.id === tagId) || {}).nome;
  const connName = inst && ((conns.find((c) => c.id === inst) || {}).label || 'WhatsApp');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{KP_CSS}</style>
      {picker}
      <div className="kp-sum">
        <div className="kp-s" style={{ '--c': '#f39200' }}><span className="i"><Icon name="users" size={19} /></span><div><span>Leads no pipeline</span><b>{total.toLocaleString('pt-BR')}</b></div></div>
        <div className="kp-s" style={{ '--c': '#f59e0b' }}><span className="i"><Icon name="hourglass" size={19} /></span><div><span>Em negociação</span><b>{money(aberto)}</b></div></div>
        <div className="kp-s" style={{ '--c': '#34d399' }}><span className="i"><Icon name="badge-check" size={19} /></span><div><span>Vendido</span><b>{money(ganho)}</b></div></div>
        <div className="kp-s" style={{ '--c': '#ff9452' }}><span className="i"><Icon name="trending-up" size={19} /></span><div><span>Conversão</span><b>{conv}%</b></div></div>
      </div>
      <div className="kp-bar">
        <div className="kp-search"><Icon name="search" size={15} style={{ color: 'var(--text-subtle)' }} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nome, telefone, e-mail ou produto" />{q && <button type="button" onClick={() => setQ('')} style={{ background: 'none', border: 0, color: 'var(--text-subtle)', cursor: 'pointer', display: 'grid' }} aria-label="Limpar"><Icon name="x" size={14} /></button>}</div>
        <div className="kp-seg">{[[7, '7 dias'], [30, '30 dias'], [90, '90 dias'], [0, 'Tudo']].map(([v, l]) => <button key={v} type="button" className={days === v ? 'on' : ''} onClick={() => setDays(v)}>{l}</button>)}</div>
        <Dropdown icon="tag" label={tagName || 'Etiquetas'} active={!!tagId}>
          <button type="button" data-close onClick={() => setTagId('')}><span className="ck">{!tagId && <Icon name="check" size={14} />}</span>Todas as etiquetas</button>
          {tags.map((t) => <button key={t.id} type="button" data-close onClick={() => setTagId(t.id)}><span className="ck">{tagId === t.id && <Icon name="check" size={14} />}</span>{t.nome}</button>)}
          {!tags.length && <div style={{ padding: 10, fontSize: 13, color: 'var(--text-muted)' }}>Crie etiquetas em Integrações → Tags.</div>}
        </Dropdown>
        <Dropdown icon="smartphone" label={connName || 'Todas as conexões'} active={!!inst}>
          <button type="button" data-close onClick={() => setInst('')}><span className="ck">{!inst && <Icon name="check" size={14} />}</span>Todas as conexões</button>
          {conns.map((c) => <button key={c.id} type="button" data-close onClick={() => setInst(c.id)}><span className="ck">{inst === c.id && <Icon name="check" size={14} />}</span>{c.label}<span className="n">{fmtPhone(c.phone)}</span></button>)}
        </Dropdown>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Dropdown icon="columns-3" iconOnly right title="Mostrar ou esconder colunas" active={hidden.length > 0}>
            <div style={{ padding: '6px 10px 8px', fontSize: 11, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '.07em' }}>Colunas visíveis</div>
            {STAGES.map((s) => <button key={s.key} type="button" onClick={() => setHidden((h) => (h.includes(s.key) ? h.filter((x) => x !== s.key) : h.length >= STAGES.length - 1 ? h : [...h, s.key]))}>
              <span className="ck">{!hidden.includes(s.key) && <Icon name="check" size={14} />}</span><Icon name={s.icon} size={14} style={{ color: s.c }} />{s.label}<span className="n">{cols ? cols[s.key].total : ''}</span></button>)}
          </Dropdown>
          <button type="button" className="kp-ddb kp-ic" title="Atualizar" onClick={refresh}><Icon name="refresh-cw" size={16} style={spin ? { animation: 'spin .8s linear infinite' } : undefined} /></button>
          <button type="button" className="kp-ddb kp-ic" title="Baixar planilha (CSV)" onClick={exportCsv}><Icon name="download" size={16} /></button>
        </div>
      </div>
      <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
      <div className="kp-board">
        {visible.map((s) => {
          const c = cols ? cols[s.key] : { total: 0, valor: 0, leads: [] };
          return (
            <div key={s.key} className={`kp-col${over === s.key ? ' over' : ''}`} style={{ '--c': s.c }}
              onDragOver={(e) => { if (drag && canEdit) { e.preventDefault(); setOver(s.key); } }} onDragLeave={() => setOver(null)} onDrop={(e) => { e.preventDefault(); drop(s.key); }}>
              <div className="kp-head" title={HINT[s.key]}>
                <div className="t"><span className="ico"><Icon name={s.icon} size={15} /></span>{s.label}<span className="n">{c.total}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted)' }}><span>{c.valor ? money(c.valor) : 'R$ 0'}</span><span>{total ? Math.round((c.total / total) * 100) : 0}%</span></div>
                <div className="kp-meter"><span style={{ width: `${total ? (c.total / total) * 100 : 0}%` }} /></div>
              </div>
              <div className="kp-list">
                {!cols && <div style={{ color: 'var(--text-subtle)', fontSize: 12, padding: 6 }}>Carregando…</div>}
                {cols && !c.leads.length && <div className="kp-empty">{canEdit ? 'Arraste um lead para cá' : 'Vazio'}</div>}
                {c.leads.map((l, i) => (
                  <Card key={l.id} l={l} s={s} drag={drag && drag.id === l.id} canEdit={canEdit} avatar={photo(l)} delay={Math.min(i, 10) * 25}
                    onDrag={() => setDrag({ id: l.id, from: s.key })} onDragEnd={() => { setDrag(null); setOver(null); }}
                    onOpen={() => setSheet(l)} onChat={() => openChat(l)} onAuto={() => auto(l)} />
                ))}
              </div>
              {cols && c.leads.length < c.total && <button type="button" className="kp-more" onClick={() => more(s.key)}>Ver mais ({c.total - c.leads.length})</button>}
            </div>
          );
        })}
      </div>
      {sheet && <LeadSheet orgId={orgId} leadId={sheet.id} avatar={photo(sheet)} canEdit={canEdit} tags={tags} notify={store.notify}
        onClose={() => setSheet(null)} onChanged={load} onOpenChat={openChat} />}
    </div>
  );
}

export { KoblyPipeline };
