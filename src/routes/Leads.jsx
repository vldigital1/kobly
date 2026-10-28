import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Icon } from '@/ds';
import { LeadAvatar, downloadText, useLeadAvatars } from '@/lib/leadAvatar.jsx';
import { LeadSheet, STAGES, fmtPhone, money, origemOf, stageOf } from '@/lib/leadSheet.jsx';
import { useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Leads. Todos os contatos da empresa (checkout, WhatsApp, disparos): números do topo, busca, filtros por
// etapa, origem, etiqueta e período, ordem, seleção para etiquetar em lote e planilha. Cada linha mostra a foto do
// WhatsApp, a etapa, a origem, as etiquetas e a última mensagem; clique para abrir a ficha completa. KoblyLeads

const PAGE = 25;
const ORDENS = [['recente', 'Atividade recente'], ['novos', 'Mais novos'], ['valor', 'Maior valor'], ['nome', 'Nome (A–Z)']];
const TIPO = { image: ['image', 'Foto'], audio: ['mic', 'Áudio'], video: ['video', 'Vídeo'], document: ['file-text', 'Arquivo'], sticker: ['smile', 'Figurinha'] };
const rel = (iso) => { if (!iso) return '—'; const s = (Date.now() - new Date(iso).getTime()) / 1000; if (s < 60) return 'agora'; if (s < 3600) return `há ${Math.round(s / 60)} min`; if (s < 86400) return `há ${Math.round(s / 3600)} h`; if (s < 86400 * 30) return `há ${Math.round(s / 86400)} d`; return new Date(iso).toLocaleDateString('pt-BR'); };

const KL_CSS = `
.kl-kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
.kl-k { border-radius: 16px; padding: 14px 16px; display: flex; gap: 12px; align-items: center; position: relative; overflow: hidden; background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.012)), rgba(15,17,26,.95); border: 1px solid rgba(255,255,255,.08); }
.kl-k::before { content: ''; position: absolute; left: 14px; right: 14px; top: -1px; height: 2px; background: linear-gradient(90deg, transparent, var(--c), transparent); }
.kl-k .i { width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); flex: none; }
.kl-k span { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .07em; } .kl-k b { display: block; font-size: 22px; color: var(--text-strong); margin-top: 2px; }
.kl-k small { display: block; font-size: 11.5px; color: var(--text-subtle); margin-top: 1px; }
.kl-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.kl-search { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 40px; border-radius: 12px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); flex: 1; min-width: 240px; }
.kl-search input { flex: 1; background: transparent; border: 0; outline: none; color: var(--text-strong); font: inherit; font-size: var(--text-sm); }
.kl-dd { position: relative; }
.kl-ddb { display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px; border-radius: 12px; cursor: pointer; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: 600; color: var(--text-strong); background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); white-space: nowrap; }
.kl-ddb:hover { background: rgba(255,255,255,.08); } .kl-ddb.act { border-color: rgba(255,148,82,.6); color: #ffb27d; }
.kl-menu { position: absolute; top: calc(100% + 6px); left: 0; z-index: 60; min-width: 230px; max-height: 340px; overflow-y: auto; padding: 6px; border-radius: 14px; background: #161a24; border: 1px solid rgba(255,255,255,.1); box-shadow: 0 16px 40px rgba(0,0,0,.55); }
.kl-menu.r { left: auto; right: 0; }
.kl-menu button { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 9px 10px; border-radius: 9px; background: none; border: 0; cursor: pointer; color: var(--text-body); font-family: var(--font-sans); font-size: 13.5px; }
.kl-menu button:hover { background: rgba(255,98,1,.14); }
.kl-menu .ck { width: 16px; display: grid; place-items: center; color: #ff9452; } .kl-menu .n { margin-left: auto; font-size: 11px; color: var(--text-subtle); }
.kl-stages { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
.kl-st { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 999px; cursor: pointer; font-family: var(--font-sans); font-size: 13px; font-weight: 600; color: var(--text-muted); background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); }
.kl-st:hover { color: var(--text-strong); }
.kl-st.on { color: #fff; border-color: var(--c); background: color-mix(in srgb, var(--c) 22%, transparent); }
.kl-st .n { padding: 0 7px; border-radius: 999px; font-size: 11px; background: rgba(255,255,255,.08); }
.kl-table { border-radius: 18px; overflow: hidden; background: rgba(12,14,22,.92); border: 1px solid rgba(255,255,255,.07); }
.kl-row { display: grid; grid-template-columns: 34px minmax(220px, 2.2fr) 140px minmax(140px, 1.6fr) minmax(130px, 1.2fr) 110px 100px 40px; gap: 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid rgba(255,255,255,.05); cursor: pointer; transition: background .12s; }
.kl-row:hover { background: rgba(255,255,255,.03); }
.kl-row.sel { background: rgba(255,98,1,.08); }
.kl-row.head { cursor: default; padding: 12px 16px; font-size: 11px; color: var(--text-subtle); text-transform: uppercase; letter-spacing: .07em; background: rgba(255,255,255,.02); }
.kl-row.head:hover { background: rgba(255,255,255,.02); }
.kl-cb { width: 18px; height: 18px; accent-color: #ff6201; cursor: pointer; }
.kl-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
.kl-msg { display: flex; align-items: center; gap: 5px; font-size: 12.5px; color: #8696a0; min-width: 0; }
.kl-msg span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kl-go { width: 32px; height: 32px; border-radius: 10px; border: 0; cursor: pointer; display: grid; place-items: center; color: var(--text-muted); background: transparent; }
.kl-go:hover { color: #04130b; background: #25d366; }
.kl-bulk { position: sticky; bottom: 14px; z-index: 30; align-self: center; display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 16px; background: #1b2030; border: 1px solid rgba(255,148,82,.4); box-shadow: 0 16px 40px rgba(0,0,0,.6); animation: kl-up .2s ease-out; }
.kl-bulk .kl-menu { top: auto; bottom: calc(100% + 8px); }
@keyframes kl-up { from { transform: translateY(12px); opacity: 0; } }
.kl-pg { display: flex; align-items: center; justify-content: flex-end; gap: 10px; font-size: 13px; color: var(--text-muted); }
.kl-pg button { width: 36px; height: 36px; border-radius: 10px; border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.04); color: var(--text-strong); cursor: pointer; display: grid; place-items: center; }
.kl-pg button:disabled { opacity: .35; cursor: not-allowed; }
.kl-empty { padding: 50px 20px; text-align: center; color: var(--text-muted); }
@media (max-width: 1100px) { .kl-row { grid-template-columns: 34px minmax(200px, 1fr) 130px 110px 40px; } .kl-row .hide-md { display: none; } }
`;

function Dropdown({ label, icon, active, right, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (!open) return undefined; const f = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener('mousedown', f); return () => document.removeEventListener('mousedown', f); }, [open]);
  return (
    <div className="kl-dd" ref={ref}>
      <button type="button" className={`kl-ddb${active ? ' act' : ''}`} onClick={() => setOpen((v) => !v)}><Icon name={icon} size={16} />{label}<Icon name="chevron-down" size={14} /></button>
      {open && <div className={`kl-menu${right ? ' r' : ''}`} onClick={(e) => { if (e.target.closest('[data-close]')) setOpen(false); }}>{children}</div>}
    </div>
  );
}
const Opt = ({ on, onClick, children, n }) => <button type="button" data-close onClick={onClick}><span className="ck">{on && <Icon name="check" size={14} />}</span>{children}{n != null && <span className="n">{n}</span>}</button>;

function KoblyLeads() {
  const store = useKobly();
  const { orgId, picker, canEdit } = useTargetOrg();
  const [q, setQ] = useState('');
  const [qDeb, setQDeb] = useState('');
  const [stage, setStage] = useState('');
  const [origem, setOrigem] = useState('');
  const [tagId, setTagId] = useState('');
  const [days, setDays] = useState(0);
  const [order, setOrder] = useState('recente');
  const [page, setPage] = useState(1);
  const [list, setList] = useState({ loading: true, leads: [], total: 0 });
  const [stats, setStats] = useState(null);
  const [board, setBoard] = useState(null);
  const [tags, setTags] = useState([]);
  const [sel, setSel] = useState(() => new Set());
  const [sheet, setSheet] = useState(null);

  useEffect(() => { const t = setTimeout(() => setQDeb(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setPage(1); setSel(new Set()); }, [qDeb, stage, origem, tagId, days, order, orgId]);
  const filters = useMemo(() => ({ q: qDeb || undefined, stage: stage || undefined, origem: origem || undefined, tag_id: tagId || undefined, days: days || undefined }), [qDeb, stage, origem, tagId, days]);

  const load = useCallback(async () => {
    if (!orgId) { setList({ loading: false, leads: [], total: 0 }); return; }
    setList((s) => ({ ...s, loading: true }));
    const r = await KoblyApi.pipeline('leads', { ...filters, order, limit: PAGE, offset: (page - 1) * PAGE }, orgId).catch((e) => ({ error: e.message }));
    setList({ loading: false, leads: (r && Array.isArray(r.leads) && r.leads) || [], total: (r && Number(r.total)) || 0, error: r && r.error });
  }, [orgId, filters, order, page]);
  const loadStats = useCallback(async () => {
    if (!orgId) return;
    const [s, b] = await Promise.all([KoblyApi.pipeline('stats', { days: days || undefined }, orgId).catch(() => null), KoblyApi.pipeline('board', { ...filters, stage: undefined, limit: 5 }, orgId).catch(() => null)]);
    setStats(s && !s.error && typeof s.total === 'number' ? s : null); setBoard(b && b.columns && STAGES.every((x) => b.columns[x.key]) ? b.columns : null);
  }, [orgId, days, filters]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { KoblyApi.getTags().then((t) => setTags(t || [])).catch(() => {}); }, [orgId]);
  const photo = useLeadAvatars(orgId, list.leads);

  const pages = Math.max(1, Math.ceil(list.total / PAGE));
  const allOn = list.leads.length > 0 && list.leads.every((l) => sel.has(l.id));
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const openChat = (lead) => { try { sessionStorage.setItem('kobly:chat-lead', lead.id); } catch { /* ok */ } store.navigate('chats'); };
  const hasFilters = !!(q || stage || origem || tagId || days);
  const tagName = tagId && (tags.find((t) => t.id === tagId) || {}).nome;

  async function bulkTag(t, remove = false) {
    const r = await KoblyApi.pipeline('tag_bulk', { lead_ids: [...sel], tag_id: t.id, remove }, orgId);
    if (!r || r.error) { store.notify('danger', (r && r.error) || 'Não deu para etiquetar.'); return; }
    store.notify('success', remove ? `Etiqueta "${t.nome}" tirada de ${sel.size} lead(s).` : `Etiqueta "${t.nome}" colocada em ${sel.size} lead(s).`);
    setSel(new Set()); load();
  }
  async function exportCsv(onlySel) {
    const r = await KoblyApi.pipeline('export', onlySel ? { lead_ids: [...sel] } : filters, orgId);
    if (!r || r.error) { store.notify('danger', (r && r.error) || 'Não deu para gerar a planilha.'); return; }
    const text = r.csv;
    downloadText(`leads-kobly-${new Date().toISOString().slice(0, 10)}.csv`, text);
    store.notify('success', `Planilha com ${r.count} leads baixada.`);
  }

  const counts = board ? Object.fromEntries(STAGES.map((s) => [s.key, board[s.key].total])) : {};
  const totalBoard = board ? STAGES.reduce((a, s) => a + board[s.key].total, 0) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{KL_CSS}</style>
      {picker}
      <div className="kl-kpis">
        <div className="kl-k" style={{ '--c': '#f39200' }}><span className="i"><Icon name="users" size={20} /></span><div><span>Leads</span><b>{stats ? stats.total.toLocaleString('pt-BR') : '—'}</b><small>{stats ? `+${stats.novos7} nos últimos 7 dias` : ''}</small></div></div>
        <div className="kl-k" style={{ '--c': '#25D366' }}><span className="i"><Icon name="message-circle-reply" size={20} /></span><div><span>Responderam</span><b>{stats ? stats.responderam.toLocaleString('pt-BR') : '—'}</b><small>{stats && stats.total ? `${Math.round((stats.responderam / stats.total) * 100)}% responderam ou além` : ''}</small></div></div>
        <div className="kl-k" style={{ '--c': '#ff9452' }}><span className="i"><Icon name="git-branch" size={20} /></span><div><span>Em fluxo agora</span><b>{stats ? stats.em_fluxo.toLocaleString('pt-BR') : '—'}</b><small>sendo atendidos pela Kobly</small></div></div>
        <div className="kl-k" style={{ '--c': '#34d399' }}><span className="i"><Icon name="badge-check" size={20} /></span><div><span>Compraram</span><b>{stats ? stats.compraram.toLocaleString('pt-BR') : '—'}</b><small>{stats ? `${money(stats.vendido)} vendidos` : ''}</small></div></div>
      </div>

      <div className="kl-stages">
        <button type="button" className={`kl-st${!stage ? ' on' : ''}`} style={{ '--c': '#ff9452' }} onClick={() => setStage('')}>Todos{totalBoard != null && <span className="n">{totalBoard}</span>}</button>
        {STAGES.map((s) => <button key={s.key} type="button" className={`kl-st${stage === s.key ? ' on' : ''}`} style={{ '--c': s.c }} onClick={() => setStage(stage === s.key ? '' : s.key)}><Icon name={s.icon} size={14} style={{ color: s.c }} />{s.label}{counts[s.key] != null && <span className="n">{counts[s.key]}</span>}</button>)}
      </div>

      <div className="kl-bar">
        <div className="kl-search"><Icon name="search" size={15} style={{ color: 'var(--text-subtle)' }} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nome, telefone, e-mail ou produto" />{q && <button type="button" onClick={() => setQ('')} style={{ background: 'none', border: 0, color: 'var(--text-subtle)', cursor: 'pointer', display: 'grid' }} aria-label="Limpar"><Icon name="x" size={14} /></button>}</div>
        <Dropdown icon="radio-tower" label={origem ? origemOf(origem)[2] : 'Origem'} active={!!origem}>
          <Opt on={!origem} onClick={() => setOrigem('')}>Todas as origens</Opt>
          {((stats && stats.origens) || []).map((o) => { const og = origemOf(o.origem); return <Opt key={o.origem} on={origem === o.origem} onClick={() => setOrigem(o.origem)} n={o.n}><Icon name={og[0]} size={14} style={{ color: og[1] }} />{og[2]}</Opt>; })}
        </Dropdown>
        <Dropdown icon="tag" label={tagName || 'Etiqueta'} active={!!tagId}>
          <Opt on={!tagId} onClick={() => setTagId('')}>Todas as etiquetas</Opt>
          {tags.map((t) => <Opt key={t.id} on={tagId === t.id} onClick={() => setTagId(t.id)}>{t.nome}</Opt>)}
        </Dropdown>
        <Dropdown icon="calendar" label={days ? `Últimos ${days} dias` : 'Qualquer data'} active={!!days}>
          {[[0, 'Qualquer data'], [7, 'Últimos 7 dias'], [30, 'Últimos 30 dias'], [90, 'Últimos 90 dias']].map(([v, l]) => <Opt key={v} on={days === v} onClick={() => setDays(v)}>{l}</Opt>)}
        </Dropdown>
        <Dropdown icon="arrow-up-down" label={ORDENS.find((o) => o[0] === order)[1]} right>
          {ORDENS.map(([v, l]) => <Opt key={v} on={order === v} onClick={() => setOrder(v)}>{l}</Opt>)}
        </Dropdown>
        {hasFilters && <button type="button" className="kl-ddb" style={{ color: '#ffb27d' }} onClick={() => { setQ(''); setStage(''); setOrigem(''); setTagId(''); setDays(0); }}><Icon name="x" size={15} />Limpar</button>}
        <button type="button" className="kl-ddb" title="Baixar planilha (CSV) com os filtros" onClick={() => exportCsv(false)}><Icon name="download" size={16} />Planilha</button>
      </div>

      <div className="kl-table">
        <div className="kl-row head">
          <input type="checkbox" className="kl-cb" checked={allOn} disabled={!canEdit || !list.leads.length} aria-label="Selecionar todos da página" onChange={() => setSel(allOn ? new Set() : new Set(list.leads.map((l) => l.id)))} />
          <span>Lead</span><span>Etapa</span><span className="hide-md">Última mensagem</span><span className="hide-md">Etiquetas</span><span>Origem</span><span className="hide-md">Atividade</span><span />
        </div>
        {list.loading && !list.leads.length && Array.from({ length: 6 }).map((_, i) => <div key={i} className="kl-row" style={{ cursor: 'default' }}><span /><div style={{ height: 36, borderRadius: 10, background: 'rgba(255,255,255,.04)' }} /><span /><span /><span /><span /><span /><span /></div>)}
        {!list.loading && !list.leads.length && <div className="kl-empty"><Icon name="users" size={34} style={{ opacity: .5 }} /><div style={{ marginTop: 10 }}>{list.error || (!orgId ? 'Escolha a conta do cliente acima.' : hasFilters ? 'Nenhum lead com esses filtros.' : 'Nenhum lead ainda. Eles chegam pelo checkout, pelo WhatsApp e pelos disparos.')}</div></div>}
        {list.leads.map((l) => {
          const sg = stageOf(l.etapa);
          const og = origemOf(l.origem);
          const t = l.ultima_msg && TIPO[l.ultima_msg.tipo];
          const msg = l.ultima_msg ? (t && (!l.ultima_msg.body || /^\[/.test(l.ultima_msg.body)) ? t[1] : l.ultima_msg.body) : null;
          return (
            <div key={l.id} className={`kl-row${sel.has(l.id) ? ' sel' : ''}`} onClick={() => setSheet(l)}>
              <input type="checkbox" className="kl-cb" checked={sel.has(l.id)} disabled={!canEdit} aria-label={`Selecionar ${l.nome}`} onClick={(e) => e.stopPropagation()} onChange={() => toggle(l.id)} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <LeadAvatar name={l.nome} src={photo(l)} size={42} dot={l.humano ? '#fbbf24' : l.em_fluxo ? '#ff9452' : null} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.nome}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[fmtPhone(l.telefone), l.produto, l.valor != null && Number(l.valor) > 0 ? money(l.valor) : null].filter(Boolean).join(' · ') || l.email || '—'}</div>
                </div>
              </div>
              <span><span className="kl-chip" style={{ color: sg.c, background: `color-mix(in srgb, ${sg.c} 15%, transparent)` }}><Icon name={sg.icon} size={11} />{sg.label}</span></span>
              <div className="kl-msg hide-md">{msg ? <>{l.ultima_msg.de !== 'lead' && <Icon name="check-check" size={13} style={{ color: '#53bdeb', flex: 'none' }} />}{t && <Icon name={t[0]} size={13} style={{ flex: 'none' }} />}<span>{msg}</span></> : <span style={{ opacity: .6 }}>Sem conversa</span>}</div>
              <div className="hide-md" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', minWidth: 0 }}>
                {(l.tags || []).slice(0, 2).map((tg) => <span key={tg.id} className="kl-chip" style={{ color: '#bfdbfe', background: 'rgba(59,130,246,.18)' }}>{tg.nome}</span>)}
                {(l.tags || []).length > 2 && <span className="kl-chip" style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,.06)' }}>+{l.tags.length - 2}</span>}
                {!(l.tags || []).length && <span style={{ fontSize: 12, color: 'var(--text-subtle)' }}>—</span>}
              </div>
              <span><span className="kl-chip" style={{ color: og[1], background: `color-mix(in srgb, ${og[1]} 14%, transparent)` }}><Icon name={og[0]} size={11} />{og[2]}</span></span>
              <span className="hide-md" style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{rel(l.ultima || l.criado)}</span>
              <span>{l.telefone && <button type="button" className="kl-go" title="Abrir conversa" onClick={(e) => { e.stopPropagation(); openChat(l); }}><Icon name="message-circle" size={16} /></button>}</span>
            </div>
          );
        })}
      </div>

      {list.total > PAGE && (
        <div className="kl-pg">
          <span>Página {page} de {pages} · {list.total.toLocaleString('pt-BR')} leads</span>
          <button type="button" aria-label="Página anterior" disabled={page <= 1} onClick={() => setPage(page - 1)}><Icon name="chevron-left" size={16} /></button>
          <button type="button" aria-label="Próxima página" disabled={page >= pages} onClick={() => setPage(page + 1)}><Icon name="chevron-right" size={16} /></button>
        </div>
      )}

      {sel.size > 0 && (
        <div className="kl-bulk">
          <b style={{ color: 'var(--text-strong)', fontSize: 14 }}>{sel.size} selecionado{sel.size > 1 ? 's' : ''}</b>
          <Dropdown icon="tag" label="Colocar etiqueta" right>
            {tags.map((t) => <Opt key={t.id} onClick={() => bulkTag(t)}>{t.nome}</Opt>)}
            {!tags.length && <div style={{ padding: 10, fontSize: 13, color: 'var(--text-muted)' }}>Crie etiquetas em Integrações → Tags.</div>}
          </Dropdown>
          <Dropdown icon="tag" label="Tirar etiqueta" right>
            {tags.map((t) => <Opt key={t.id} onClick={() => bulkTag(t, true)}>{t.nome}</Opt>)}
          </Dropdown>
          <button type="button" className="kl-ddb" onClick={() => exportCsv(true)}><Icon name="download" size={16} />Planilha</button>
          <button type="button" className="kl-ddb" onClick={() => setSel(new Set())}><Icon name="x" size={16} /></button>
        </div>
      )}

      {sheet && <LeadSheet orgId={orgId} leadId={sheet.id} avatar={photo(sheet)} canEdit={canEdit} tags={tags} notify={store.notify}
        onClose={() => setSheet(null)} onChanged={() => { load(); loadStats(); }} onOpenChat={openChat} />}
    </div>
  );
}

export { KoblyLeads };
