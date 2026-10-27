import React, { useEffect, useMemo, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Icon } from '@/ds';
import { ChannelLogo } from '@/lib/brandLogos.jsx';
import { ErrorState } from '@/lib/ui.jsx';
import { fmtDateTime, useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Dashboard. Cliente: leads que chegaram, conversas no WhatsApp, fluxos rodando e vendas (do checkout e
// recuperadas pelos fluxos), com comparação ao período anterior, gráfico por dia e atividade ao vivo.
// Administrador: a plataforma inteira (empresas, números, servidores e quem mais usa). KoblyDashboard

const KD_CSS = `
.kd-hero { position: relative; overflow: hidden; border-radius: 22px; padding: 22px 24px; display: flex; gap: 18px; align-items: center; flex-wrap: wrap;
  background: radial-gradient(800px 300px at 0% 0%, rgba(255,98,1,.22), transparent 60%), radial-gradient(700px 300px at 100% 100%, rgba(243,146,0,.16), transparent 60%), rgba(12,14,22,.95);
  border: 1px solid rgba(255,255,255,.08); box-shadow: 0 20px 60px rgba(0,0,0,.5); }
.kd-hero::before { content: ''; position: absolute; inset: 0; background-image: radial-gradient(rgba(255,148,82,.18) 1px, transparent 1px); background-size: 22px 22px; mask-image: linear-gradient(90deg, transparent, #000 40%, transparent); opacity: .5; pointer-events: none; }
.kd-hero::after { content: ''; position: absolute; left: -30%; top: 0; width: 30%; height: 100%; background: linear-gradient(90deg, transparent, rgba(255,255,255,.07), transparent); animation: kd-sweep 6s linear infinite; pointer-events: none; }
@keyframes kd-sweep { to { left: 130%; } }
.kd-core { position: relative; width: 64px; height: 64px; flex: none; display: grid; place-items: center; }
.kd-core .ring { position: absolute; inset: 0; border-radius: 50%; border: 2px solid transparent; border-top-color: #f39200; border-right-color: #ff6201; animation: kd-spin 2.4s linear infinite; }
.kd-core .ring.r2 { inset: 8px; border-top-color: #ffd6bd; border-right-color: transparent; border-left-color: #ff9452; animation-duration: 3.6s; animation-direction: reverse; }
.kd-core .dot { width: 22px; height: 22px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #fff, #ff9452 45%, #b24500); box-shadow: 0 0 24px #ff6201, 0 0 48px rgba(243,146,0,.4); animation: kd-pulse 2s ease-in-out infinite; }
@keyframes kd-spin { to { transform: rotate(360deg); } }
@keyframes kd-pulse { 50% { transform: scale(.82); box-shadow: 0 0 14px #ff6201, 0 0 30px rgba(243,146,0,.3); } }
.kd-live { display: inline-flex; align-items: center; gap: 8px; font-size: var(--text-sm); color: #ffb485; }
.kd-live i { width: 8px; height: 8px; border-radius: 50%; background: #34d399; box-shadow: 0 0 0 0 rgba(52,211,153,.6); animation: kd-ping 1.8s infinite; }
@keyframes kd-ping { 0% { box-shadow: 0 0 0 0 rgba(52,211,153,.55); } 70% { box-shadow: 0 0 0 9px rgba(52,211,153,0); } 100% { box-shadow: 0 0 0 0 rgba(52,211,153,0); } }
.kd-seg { display: inline-flex; padding: 4px; gap: 4px; border-radius: 12px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); position: relative; z-index: 1; }
.kd-seg button { border: 0; padding: 7px 13px; border-radius: 9px; background: transparent; color: var(--text-muted); cursor: pointer; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: 600; }
.kd-seg button.on { color: #fff; background: linear-gradient(135deg, rgba(243,146,0,.3), rgba(255,98,1,.42)); box-shadow: inset 0 0 0 1px rgba(255,148,82,.55); }
.kd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
.kd-kpi { position: relative; overflow: hidden; border-radius: 18px; padding: 16px 16px 12px; display: flex; flex-direction: column; gap: 6px;
  background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.012)), rgba(15,17,26,.95); border: 1px solid rgba(255,255,255,.08); box-shadow: 0 12px 34px rgba(0,0,0,.4); animation: kd-in .5s both; }
.kd-kpi::before { content: ''; position: absolute; left: 16px; right: 16px; top: -1px; height: 2px; background: linear-gradient(90deg, transparent, var(--c), transparent); }
.kd-kpi::after { content: ''; position: absolute; right: -50px; top: -50px; width: 140px; height: 140px; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--c) 22%, transparent), transparent 70%); }
@keyframes kd-in { from { opacity: 0; transform: translateY(8px); } }
.kd-kpi .lbl { display: flex; align-items: center; gap: 8px; font-size: var(--text-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: .07em; position: relative; z-index: 1; }
.kd-kpi .ico { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; color: var(--c); background: color-mix(in srgb, var(--c) 15%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 32%, transparent); }
.kd-kpi .val { font-size: 30px; font-weight: 800; color: var(--text-strong); line-height: 1.1; position: relative; z-index: 1; font-variant-numeric: tabular-nums; }
.kd-kpi .sub { font-size: var(--text-xs); color: var(--text-subtle); position: relative; z-index: 1; display: flex; gap: 8px; align-items: center; }
.kd-delta { font-weight: 700; padding: 1px 7px; border-radius: 999px; }
.kd-delta.up { color: #34d399; background: rgba(52,211,153,.12); } .kd-delta.down { color: #fb7185; background: rgba(251,113,133,.12); } .kd-delta.eq { color: #94a3b8; background: rgba(148,163,184,.1); }
.kd-panel { border-radius: 20px; padding: 18px; display: flex; flex-direction: column; gap: 14px; background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.012)), rgba(15,17,26,.95); border: 1px solid rgba(255,255,255,.08); box-shadow: 0 14px 40px rgba(0,0,0,.4); min-width: 0; }
.kd-panel h3 { margin: 0; font-size: 15px; color: var(--text-strong); display: flex; align-items: center; gap: 8px; }
.kd-legend { display: flex; gap: 8px; flex-wrap: wrap; }
.kd-legend button { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; cursor: pointer; font-family: var(--font-sans); color: var(--text-muted); background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); }
.kd-legend button.on { color: var(--text-strong); border-color: color-mix(in srgb, var(--c) 55%, transparent); background: color-mix(in srgb, var(--c) 12%, transparent); }
.kd-legend i { width: 8px; height: 8px; border-radius: 50%; background: var(--c); box-shadow: 0 0 8px var(--c); }
.kd-bar { height: 9px; border-radius: 999px; background: rgba(255,255,255,.06); overflow: hidden; }
.kd-bar span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--c), color-mix(in srgb, var(--c) 50%, #fff)); box-shadow: 0 0 10px var(--c); transition: width .8s; }
.kd-feed { display: flex; flex-direction: column; gap: 2px; }
.kd-feed .it { display: flex; gap: 10px; align-items: center; padding: 9px 6px; border-radius: 10px; animation: kd-in .4s both; }
.kd-feed .it:hover { background: rgba(255,255,255,.03); }
.kd-feed .ic { width: 30px; height: 30px; border-radius: 10px; display: grid; place-items: center; flex: none; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); }
.kd-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 14px; align-items: center; padding: 10px 8px; border-radius: 10px; font-size: var(--text-sm); }
.kd-row:hover { background: rgba(255,255,255,.03); }
.kd-skel { border-radius: 18px; height: 118px; background: linear-gradient(90deg, rgba(255,255,255,.03), rgba(255,255,255,.07), rgba(255,255,255,.03)); background-size: 200% 100%; animation: kd-shimmer 1.4s linear infinite; }
@keyframes kd-shimmer { to { background-position: -200% 0; } }
`;

const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');
const money = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
function Delta({ cur, prev }) {
  if (!prev && !cur) return <span className="kd-delta eq">—</span>;
  if (!prev) return <span className="kd-delta up">novo</span>;
  const p = Math.round(((cur - prev) / prev) * 100);
  return <span className={`kd-delta ${p > 0 ? 'up' : p < 0 ? 'down' : 'eq'}`}>{p > 0 ? '▲' : p < 0 ? '▼' : ''} {Math.abs(p)}%</span>;
}
// número que sobe até o valor (sensação de "processando")
function Count({ value, format = fmt }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const to = Number(value || 0); let raf; const t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / 700); setV(to * (1 - Math.pow(1 - k, 3))); if (k < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(Math.round(v))}</>;
}
function Spark({ data, color }) {
  const max = Math.max(1, ...data);
  const pts = data.map((y, i) => `${(i / Math.max(1, data.length - 1)) * 100},${30 - (y / max) * 26}`).join(' ');
  const id = `sp${color.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" style={{ width: '100%', height: 34, position: 'relative', zIndex: 1 }} aria-hidden="true">
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".35" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <polygon points={`0,32 ${pts} 100,32`} fill={`url(#${id})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
    </svg>
  );
}
function Kpi({ label, icon, color, value, prev, format, sub, spark, delay = 0, logo }) {
  return (
    <div className="kd-kpi" style={{ '--c': color, animationDelay: `${delay}ms` }}>
      <div className="lbl">{logo ? <ChannelLogo kind={logo} size={28} /> : <span className="ico"><Icon name={icon} size={15} /></span>}{label}</div>
      <div className="val"><Count value={value} format={format} /></div>
      <div className="sub">{prev !== undefined && <Delta cur={value} prev={prev} />}<span>{sub}</span></div>
      {spark && <Spark data={spark} color={color} />}
    </div>
  );
}
// gráfico de área por dia com várias séries ligáveis
function AreaChart({ serie, lines }) {
  const [on, setOn] = useState(() => Object.fromEntries(lines.map((l) => [l.key, true])));
  const [hover, setHover] = useState(null);
  const W = 640, H = 220, P = 26;
  const vis = lines.filter((l) => on[l.key]);
  const max = Math.max(1, ...serie.flatMap((d) => vis.map((l) => d[l.key] || 0)));
  const x = (i) => P + (i / Math.max(1, serie.length - 1)) * (W - P * 2);
  const y = (v) => H - P - (v / max) * (H - P * 2);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="kd-legend">
        {lines.map((l) => <button key={l.key} type="button" className={on[l.key] ? 'on' : ''} style={{ '--c': l.color }} onClick={() => setOn({ ...on, [l.key]: !on[l.key] })}><i />{l.label}</button>)}
      </div>
      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 240, display: 'block' }} onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.round(((e.clientX - r.left) / r.width * W - P) / (W - P * 2) * (serie.length - 1)); setHover(Math.max(0, Math.min(serie.length - 1, i))); }}>
          <defs>{lines.map((l) => <linearGradient key={l.key} id={`ag-${l.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={l.color} stopOpacity=".28" /><stop offset="1" stopColor={l.color} stopOpacity="0" /></linearGradient>)}</defs>
          {[0, 0.25, 0.5, 0.75, 1].map((k) => <line key={k} x1={P} x2={W - P} y1={P + k * (H - P * 2)} y2={P + k * (H - P * 2)} stroke="rgba(255,255,255,.06)" strokeDasharray="3 5" />)}
          {vis.map((l) => {
            const pts = serie.map((d, i) => `${x(i)},${y(d[l.key] || 0)}`).join(' ');
            return (
              <g key={l.key}>
                <polygon points={`${x(0)},${H - P} ${pts} ${x(serie.length - 1)},${H - P}`} fill={`url(#ag-${l.key})`} />
                <polyline points={pts} fill="none" stroke={l.color} strokeWidth="2.2" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 4px ${l.color})` }} />
              </g>
            );
          })}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={P} y2={H - P} stroke="rgba(255,148,82,.5)" />}
          {hover !== null && vis.map((l) => <circle key={l.key} cx={x(hover)} cy={y(serie[hover][l.key] || 0)} r="4" fill={l.color} stroke="#0d1018" strokeWidth="2" />)}
        </svg>
        {hover !== null && serie[hover] && (
          <div style={{ position: 'absolute', top: 6, left: `${Math.min(70, Math.max(2, (hover / Math.max(1, serie.length - 1)) * 100 - 10))}%`, padding: '8px 10px', borderRadius: 10, background: 'rgba(12,14,22,.95)', border: '1px solid rgba(255,255,255,.12)', fontSize: 12, pointerEvents: 'none', boxShadow: '0 8px 24px rgba(0,0,0,.5)' }}>
            <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>{serie[hover].dia.split('-').reverse().join('/')}</div>
            {vis.map((l) => <div key={l.key} style={{ color: 'var(--text-strong)' }}><span style={{ color: l.color }}>●</span> {l.label}: <b>{fmt(serie[hover][l.key])}</b></div>)}
          </div>
        )}
      </div>
    </div>
  );
}

function Hero({ title, line, days, setDays, extra }) {
  return (
    <div className="kd-hero">
      <div className="kd-core"><span className="ring" /><span className="ring r2" /><span className="dot" /></div>
      <div style={{ flex: 1, minWidth: 240, position: 'relative', zIndex: 1 }}>
        <div style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: 22 }}>{title}</div>
        <div className="kd-live" style={{ marginTop: 4 }}><i />{line}</div>
      </div>
      {extra}
      <div className="kd-seg">{[7, 30, 90].map((d) => <button key={d} type="button" className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d} dias</button>)}</div>
    </div>
  );
}

function ClientDashboard() {
  const store = useKobly();
  const { orgId, picker } = useTargetOrg();
  const [days, setDays] = useState(30);
  const [st, setSt] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    if (!orgId) { setSt({ loading: false, data: null, error: null }); return undefined; }
    let alive = true;
    setSt((s) => ({ ...s, loading: true }));
    KoblyApi.dashboardOverview(days, orgId).then((r) => { if (alive) setSt({ loading: false, data: r && r.leads && r.serie ? r : null, error: (r && r.error) || null }); }).catch((e) => { if (alive) setSt({ loading: false, data: null, error: e.message }); });
    return () => { alive = false; };
  }, [orgId, days]);
  const d = st.data;
  const serie = (d && d.serie) || [];
  const col = (k) => serie.map((x) => x[k] || 0);
  const nome = String((store.session && (store.session.nome || store.session.name)) || '').split(' ')[0];
  const eventosMax = Math.max(1, ...((d && d.eventos) || []).map((e) => e.n));
  const EV_COLOR = { 'Compra Aprovada': '#34d399', 'Pix Gerado': '#f39200', 'Abandono de carrinho': '#f59e0b', 'Boleto Gerado': '#ff9452', 'Compra Recusada': '#fb7185' };
  const FEED = { evento: ['#f39200', 'shopping-cart'], resposta: ['#25D366', 'message-circle'], venda: ['#34d399', 'badge-dollar-sign'] };

  if (st.error && !st.data) return <ErrorState message={st.error} onRetry={() => setDays((x) => x)} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{KD_CSS}</style>
      <Hero title={`${nome ? `Olá, ${nome}` : 'Olá'} — sua operação ao vivo`} days={days} setDays={setDays}
        line={d ? (d.leads_em_fluxo ? `A Kobly está trabalhando: ${fmt(d.leads_em_fluxo)} lead(s) dentro dos seus fluxos agora` : d.fluxos_ativos ? `${d.fluxos_ativos} fluxo(s) no ar, esperando os próximos leads` : 'Publique um fluxo para a Kobly começar a trabalhar por você') : 'Carregando seus números…'} />
      {picker}
      {d && !d.conexoes && (
        <button type="button" className="kd-panel" style={{ flexDirection: 'row', alignItems: 'center', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans)', borderColor: 'rgba(37,211,102,.35)' }}
          onClick={() => { try { sessionStorage.setItem('kobly:int-section', 'conexoes'); } catch { /* ok */ } store.navigate('integracoes'); }}>
          <ChannelLogo kind="qr" size={40} />
          <div style={{ flex: 1 }}><b style={{ color: 'var(--text-strong)' }}>Conecte seu WhatsApp</b><div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Sem um número conectado os fluxos não enviam mensagens. Leva menos de um minuto.</div></div>
          <Icon name="arrow-right" size={18} style={{ color: '#25D366' }} />
        </button>
      )}
      <div className="kd-grid">
        {st.loading && !d ? Array.from({ length: 6 }, (_, i) => <div key={i} className="kd-skel" />) : d && (<>
          <Kpi label="Leads que chegaram" icon="user-plus" color="#f39200" value={d.leads.cur} prev={d.leads.prev} sub={`em ${days} dias`} spark={col('leads')} />
          <Kpi label="Mensagens enviadas" logo="qr" color="#25D366" value={d.enviadas.cur} prev={d.enviadas.prev} sub="no WhatsApp" spark={col('enviadas')} delay={60} />
          <Kpi label="Respostas recebidas" icon="message-circle-reply" color="#ff9452" value={d.recebidas.cur} prev={d.recebidas.prev} sub={d.enviadas.cur ? `${Math.round((d.recebidas.cur / Math.max(1, d.enviadas.cur)) * 100)}% de resposta` : 'dos leads'} spark={col('recebidas')} delay={120} />
          <Kpi label="Vendas aprovadas" icon="badge-dollar-sign" color="#34d399" value={d.vendas.valor} prev={d.vendas.valor_prev} format={money} sub={`${fmt(d.vendas.cur)} venda(s) no checkout`} spark={col('vendas')} delay={180} />
          <Kpi label="Recuperadas pelos fluxos" icon="sparkles" color="#f59e0b" value={d.recuperadas.valor} format={money} sub={`${fmt(d.recuperadas.n)} venda(s) vindas da Kobly`} delay={240} />
          <Kpi label="Fluxos no ar" icon="git-branch" color="#ffd6bd" value={d.fluxos_ativos} sub={`${fmt(d.leads_em_fluxo)} lead(s) neles agora · ${fmt(d.emails.cur)} e-mails enviados`} delay={300} />
        </>)}
      </div>
      {d && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
          <div className="kd-panel" style={{ gridColumn: 'span 2' }}>
            <h3><Icon name="activity" size={16} style={{ color: '#f39200' }} />Movimento por dia</h3>
            <AreaChart serie={serie} lines={[{ key: 'leads', label: 'Leads', color: '#f39200' }, { key: 'enviadas', label: 'Enviadas', color: '#25D366' }, { key: 'recebidas', label: 'Respostas', color: '#ff9452' }, { key: 'vendas', label: 'Vendas', color: '#34d399' }]} />
          </div>
          <div className="kd-panel">
            <h3><Icon name="radar" size={16} style={{ color: '#ff9452' }} />Atividade ao vivo</h3>
            <div className="kd-feed">
              {!d.atividade.length && <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Assim que chegar um evento do checkout ou uma resposta no WhatsApp, aparece aqui.</div>}
              {d.atividade.map((a, i) => {
                const [c, ic] = a.tipo === 'evento' ? [EV_COLOR[a.titulo] || '#f39200', a.titulo === 'Compra Aprovada' ? 'badge-check' : 'shopping-cart'] : FEED[a.tipo];
                return (
                  <div key={i} className="it" style={{ '--c': c, animationDelay: `${i * 40}ms` }}>
                    <span className="ic"><Icon name={ic} size={15} /></span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.titulo}{a.quem ? ` · ${a.quem}` : ''}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{fmtDateTime(a.em)}</div>
                    </div>
                    {a.valor != null && <b style={{ fontSize: 'var(--text-sm)', color: c }}>{money(a.valor)}</b>}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="kd-panel">
            <h3><Icon name="shopping-cart" size={16} style={{ color: '#f59e0b' }} />Eventos do checkout</h3>
            {!d.eventos.length && <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Nenhum evento no período. Conecte seu checkout em Integrações → Gateways de pagamento.</div>}
            {d.eventos.map((e) => (
              <div key={e.tipo} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)' }}><span style={{ color: 'var(--text-body)' }}>{e.tipo}</span><b style={{ color: 'var(--text-strong)' }}>{fmt(e.n)}</b></div>
                <div className="kd-bar" style={{ '--c': EV_COLOR[e.tipo] || '#64748b' }}><span style={{ width: `${(e.n / eventosMax) * 100}%` }} /></div>
              </div>
            ))}
            {d.oportunidades > 0 && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{fmt(d.oportunidades)} oportunidade(s) de recuperação no período (abandonos, Pix, boletos e recusas).</div>}
          </div>
          <div className="kd-panel" style={{ gridColumn: 'span 2' }}>
            <h3><Icon name="git-branch" size={16} style={{ color: '#ffd6bd' }} />Fluxos que mais trabalham</h3>
            {!d.top_fluxos.length && <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Nenhum fluxo publicado ainda. <button type="button" className="kd-seg" style={{ padding: '4px 10px', cursor: 'pointer', color: 'var(--text-strong)', fontFamily: 'var(--font-sans)' }} onClick={() => store.navigate('fluxos')}>Criar fluxo</button></div>}
            {d.top_fluxos.length > 0 && <div className="kd-row" style={{ color: 'var(--text-subtle)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.07em' }}><span>Fluxo</span><span>Leads</span><span>Agora</span><span>Vendas</span></div>}
            {d.top_fluxos.map((f) => (
              <div key={f.id} className="kd-row" style={{ cursor: 'pointer' }} onClick={() => store.navigate('fluxos')}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}><span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: f.status === 'Ativa' ? '#34d399' : '#64748b', boxShadow: f.status === 'Ativa' ? '0 0 8px #34d399' : 'none' }} /><b style={{ color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.nome}</b></span>
                <span>{fmt(f.leads)}</span><span style={{ color: '#ff9452' }}>{fmt(f.agora)}</span><span style={{ color: '#34d399' }}>{f.vendas ? `${fmt(f.vendas)} · ${money(f.valor)}` : '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AdminDashboard() {
  const store = useKobly();
  const [days, setDays] = useState(30);
  const [st, setSt] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setSt((s) => ({ ...s, loading: true }));
    KoblyApi.adminDashboard(days).then((r) => { if (alive) setSt({ loading: false, data: r && r.totais && r.serie ? r : null, error: (r && r.error) || null }); }).catch((e) => { if (alive) setSt({ loading: false, data: null, error: e.message }); });
    return () => { alive = false; };
  }, [days]);
  const d = st.data, t = (d && d.totais) || {};
  const serie = (d && d.serie) || [];
  const col = (k) => serie.map((x) => x[k] || 0);
  const cap = ((d && d.servidores) || []).reduce((a, s) => a + s.capacity, 0), used = ((d && d.servidores) || []).reduce((a, s) => a + s.usados, 0);
  const topMax = Math.max(1, ...((d && d.top) || []).map((o) => o.mensagens + o.leads));
  if (st.error && !st.data) return <ErrorState message={st.error} onRetry={() => setDays((x) => x)} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{KD_CSS}</style>
      <Hero title="Centro de comando da Kobly" days={days} setDays={setDays}
        line={d ? `${fmt(t.empresas_ativas)} empresa(s) ativas · ${fmt(t.em_fluxo)} lead(s) dentro de fluxos agora · ${fmt(t.numeros)} número(s) de WhatsApp conectados` : 'Lendo a plataforma…'} />
      <div className="kd-grid">
        {st.loading && !d ? Array.from({ length: 6 }, (_, i) => <div key={i} className="kd-skel" />) : d && (<>
          <Kpi label="Empresas" icon="building-2" color="#f39200" value={t.empresas} sub={`+${fmt(t.empresas_novas)} em ${days} dias`} spark={col('empresas')} />
          <Kpi label="Usuários" icon="users" color="#ff9452" value={t.usuarios} sub={`${fmt(t.empresas_ativas)} empresa(s) usando o WhatsApp`} delay={60} />
          <Kpi label="Números conectados" logo="qr" color="#25D366" value={t.numeros} sub={cap ? `${fmt(used)} de ${fmt(cap)} vagas nos servidores` : 'sem servidor Uazapi cadastrado'} delay={120} />
          <Kpi label="Mensagens enviadas" icon="send" color="#f39200" value={t.mensagens} sub={`${fmt(t.respostas)} respostas recebidas`} spark={col('mensagens')} delay={180} />
          <Kpi label="Leads na plataforma" icon="user-plus" color="#f59e0b" value={t.leads} sub={`em ${days} dias`} spark={col('leads')} delay={240} />
          <Kpi label="Vendas recuperadas" icon="badge-dollar-sign" color="#34d399" value={t.vendas_valor} format={money} sub={`${fmt(t.vendas)} venda(s) pelos fluxos`} delay={300} />
        </>)}
      </div>
      {d && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
          <div className="kd-panel" style={{ gridColumn: 'span 2' }}>
            <h3><Icon name="activity" size={16} style={{ color: '#f39200' }} />Crescimento por dia</h3>
            <AreaChart serie={serie} lines={[{ key: 'mensagens', label: 'Mensagens', color: '#25D366' }, { key: 'leads', label: 'Leads', color: '#f59e0b' }, { key: 'empresas', label: 'Novas empresas', color: '#f39200' }]} />
          </div>
          <div className="kd-panel">
            <h3><Icon name="server" size={16} style={{ color: '#25D366' }} />Servidores WhatsApp</h3>
            {!d.servidores.length && <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Nenhum servidor cadastrado. <button type="button" className="kd-seg" style={{ padding: '4px 10px', cursor: 'pointer', color: 'var(--text-strong)', fontFamily: 'var(--font-sans)' }} onClick={() => store.navigate('servidores')}>Cadastrar</button></div>}
            {d.servidores.map((s) => {
              const pct = Math.round((s.usados / Math.max(1, s.capacity)) * 100);
              return (
                <div key={s.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)' }}><span style={{ color: 'var(--text-strong)' }}>{s.label}{!s.active && <span style={{ color: '#94a3b8' }}> · pausado</span>}</span><span style={{ color: 'var(--text-muted)' }}>{s.conectados} on · {s.usados}/{s.capacity}</span></div>
                  <div className="kd-bar" style={{ '--c': pct > 85 ? '#fb7185' : pct > 65 ? '#f59e0b' : '#25D366' }}><span style={{ width: `${Math.min(100, pct)}%` }} /></div>
                </div>
              );
            })}
          </div>
          <div className="kd-panel" style={{ gridColumn: 'span 3' }}>
            <h3><Icon name="trophy" size={16} style={{ color: '#f59e0b' }} />Empresas que mais usam</h3>
            {d.top.map((o, i) => (
              <div key={o.id} style={{ display: 'grid', gridTemplateColumns: '28px 1fr 1fr auto', gap: 12, alignItems: 'center', fontSize: 'var(--text-sm)' }}>
                <span style={{ color: i < 3 ? '#f59e0b' : 'var(--text-subtle)', fontWeight: 800 }}>#{i + 1}</span>
                <b style={{ color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.nome}</b>
                <div className="kd-bar" style={{ '--c': '#ff6201' }}><span style={{ width: `${((o.mensagens + o.leads) / topMax) * 100}%` }} /></div>
                <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmt(o.mensagens)} msg · {fmt(o.leads)} leads{o.vendas ? ` · ${money(o.vendas)}` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function KoblyDashboard() {
  const store = useKobly();
  return store.role === 'Administrador' ? <AdminDashboard /> : <ClientDashboard />;
}

export { KoblyDashboard };
