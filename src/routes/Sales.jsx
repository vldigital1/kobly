import React, { useEffect, useMemo, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Button, Icon } from '@/ds';
import { ChannelLogo } from '@/lib/brandLogos.jsx';
import { ErrorState } from '@/lib/ui.jsx';
import { useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';
import { KD_CSS, Kpi, AreaChart } from '@/routes/Dashboard.jsx';
import { SettingsModal } from '@/routes/MetaAds.jsx';

// Kobly — Vendas. Faturamento, vendas, ticket médio, lucro, ROAS, gasto em anúncios, taxas, conversão e
// reembolsos do período; gráfico por dia, mapa de horários, estados/países, números de WhatsApp, produtos,
// origem e forma de pagamento. Vendas = checkout aprovado + vendas dos fluxos. Gasto = Facebook + Google Ads. KoblySales

const PERIODS = [['today', 'Hoje'], ['yesterday', 'Ontem'], ['last_7d', '7 dias'], ['last_30d', '30 dias'], ['this_month', 'Este mês'], ['last_month', 'Mês passado'], ['maximum', 'Tudo']];
const PKEY = 'kobly:sales-period';
const DOW = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

const money = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const money2 = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const int = (n) => Number(n || 0).toLocaleString('pt-BR');

const KS_CSS = `
.ks-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 16px; }
.ks-list { display: flex; flex-direction: column; gap: 4px; }
.ks-li { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; padding: 8px 6px; border-radius: 10px; animation: kd-in .4s both; }
.ks-li:hover { background: rgba(var(--fg-rgb), .03); }
.ks-li .nm { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.ks-li .nm b { font-size: var(--text-sm); color: var(--text-strong); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ks-li .vv { text-align: right; font-size: var(--text-sm); color: var(--text-strong); font-weight: 700; font-variant-numeric: tabular-nums; }
.ks-li .vv small { display: block; font-weight: 500; color: var(--text-subtle); font-size: 11px; }
.ks-badge { min-width: 34px; height: 30px; padding: 0 6px; border-radius: 9px; display: grid; place-items: center; font-size: 11px; font-weight: 800; letter-spacing: .04em;
  color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 30%, transparent); }
.ks-heat { display: grid; grid-template-columns: 34px repeat(24, minmax(0, 1fr)); gap: 3px; font-size: 10px; color: var(--text-subtle); }
.ks-heat .c { aspect-ratio: 1; border-radius: 4px; background: rgba(var(--fg-rgb), .045); position: relative; }
.ks-heat .c[data-v]:hover::after { content: attr(data-v); position: absolute; bottom: 120%; left: 50%; transform: translateX(-50%); white-space: nowrap; padding: 4px 7px; border-radius: 7px;
  background: rgba(var(--panel-rgb), .97); border: 1px solid rgba(var(--fg-rgb), .14); color: var(--text-strong); font-size: 11px; z-index: 3; pointer-events: none; }
.ks-heat .h { text-align: center; }
.ks-heat .d { display: flex; align-items: center; }
.ks-hours { display: flex; align-items: flex-end; gap: 3px; height: 86px; }
.ks-hours span { flex: 1; border-radius: 4px 4px 1px 1px; background: linear-gradient(180deg, #ff9452, rgba(255,98,1,.35)); min-height: 2px; transition: height .8s; }
.ks-hours span.top { background: linear-gradient(180deg, #ffd6bd, #ff6201); box-shadow: 0 0 12px rgba(255,98,1,.6); }
.ks-tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.ks-tbl th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-subtle); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid rgba(var(--fg-rgb), .08); }
.ks-tbl td { padding: 10px 8px; border-bottom: 1px solid rgba(var(--fg-rgb), .05); color: var(--text-body); font-variant-numeric: tabular-nums; }
.ks-tbl td.n, .ks-tbl th.n { text-align: right; }
.ks-tbl tr:hover td { background: rgba(var(--fg-rgb), .025); }
.ks-note { font-size: var(--text-xs); color: var(--text-subtle); line-height: 1.5; }
.ks-empty { padding: 28px 12px; text-align: center; color: var(--text-muted); font-size: var(--text-sm); }
.ks-tabs { display: inline-flex; gap: 4px; padding: 3px; border-radius: 10px; background: rgba(var(--fg-rgb), .04); border: 1px solid rgba(var(--fg-rgb), .08); }
.ks-tabs button { border: 0; padding: 5px 11px; border-radius: 8px; background: transparent; color: var(--text-muted); cursor: pointer; font-family: var(--font-sans); font-size: 12px; font-weight: 600; }
.ks-tabs button.on { color: var(--on-tint); background: linear-gradient(135deg, rgba(243,146,0,.3), rgba(255,98,1,.42)); }
@media (max-width: 640px) { .ks-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; } .ks-kpis .kd-kpi { padding: 12px 12px 10px; } .ks-kpis .val { font-size: 20px; } .ks-kpis .lbl { font-size: 10px; letter-spacing: .04em; } .ks-kpis .lbl .ico { width: 22px; height: 22px; } .ks-kpis .sub { font-size: 10px; } .kd-hero .kd-seg { width: 100%; } .ks-heat { grid-template-columns: 26px repeat(24, minmax(0, 1fr)); gap: 2px; } .ks-heat .h:nth-child(odd) { visibility: hidden; } }
`;

// barra com nome, valor e % do total
function BarList({ items, total, color = '#ff6201', badge, empty = 'Sem vendas no período.' }) {
  if (!items || !items.length) return <div className="ks-empty">{empty}</div>;
  const max = Math.max(1, ...items.map((x) => x.valor));
  return (
    <div className="ks-list">
      {items.map((x, i) => (
        <div key={x.nome} className="ks-li" style={{ '--c': color, animationDelay: `${i * 35}ms` }}>
          {badge ? badge(x) : <span className="ks-badge">{i + 1}</span>}
          <div className="nm">
            <b title={x.nome}>{x.nome}</b>
            <div className="kd-bar" style={{ '--c': color }}><span style={{ width: `${Math.max(2, (x.valor / max) * 100)}%` }} /></div>
          </div>
          <div className="vv">{money(x.valor)}<small>{int(x.vendas)} {x.vendas === 1 ? 'venda' : 'vendas'}{total ? ` · ${Math.round((x.valor / total) * 100)}%` : ''}</small></div>
        </div>
      ))}
    </div>
  );
}

function Panel({ title, icon, color = '#ff6201', action, children, note }) {
  return (
    <div className="kd-panel">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h3><span style={{ color }}><Icon name={icon} size={16} /></span>{title}</h3>
        {action}
      </div>
      {children}
      {note && <div className="ks-note">{note}</div>}
    </div>
  );
}

function Heatmap({ heat, porHora }) {
  const max = Math.max(1, ...heat.flat());
  const maxH = Math.max(1, ...porHora.map((h) => h.vendas));
  const best = porHora.reduce((b, h, i) => (h.vendas > porHora[b].vendas ? i : b), 0);
  const bestDay = heat.map((r) => r.reduce((a, b) => a + b, 0)).reduce((b, v, i, arr) => (v > arr[b] ? i : b), 0);
  const any = porHora.some((h) => h.vendas);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {any && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span className="kd-live" style={{ fontSize: 13 }}><i />Pico às {best}h · {int(porHora[best].vendas)} {porHora[best].vendas === 1 ? 'venda' : 'vendas'}</span>
          <span className="ks-note" style={{ alignSelf: 'center' }}>Dia mais forte: <b style={{ color: 'var(--text-strong)' }}>{DOW[bestDay]}</b></span>
        </div>
      )}
      <div className="ks-hours" aria-hidden="true">
        {porHora.map((h, i) => <span key={i} className={any && i === best ? 'top' : ''} style={{ height: `${(h.vendas / maxH) * 100}%` }} title={`${i}h · ${h.vendas}`} />)}
      </div>
      <div className="ks-heat">
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="h">{h % 3 === 0 ? h : ''}</span>)}
        {heat.map((row, d) => (
          <React.Fragment key={d}>
            <span className="d">{DOW[d]}</span>
            {row.map((v, h) => (
              <span key={h} className="c" data-v={v ? `${DOW[d]} ${h}h · ${v}` : undefined}
                style={v ? { background: `rgba(255, ${Math.round(150 - (v / max) * 52)}, ${Math.round(82 - (v / max) * 81)}, ${0.18 + (v / max) * 0.82})`, boxShadow: v === max ? '0 0 10px rgba(255,98,1,.7)' : 'none' } : undefined} />
            ))}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// gasto e série diária do Facebook e do Google (se conectados); falha = sem gasto
async function adsSpend(preset, orgId) {
  const out = { gasto: 0, porDia: new Map(), fontes: [] };
  const calls = [['Facebook', KoblyApi.metaAds('dashboard', { id: 'all', date_preset: preset }, orgId)], ['Google', KoblyApi.googleAds('dashboard', { id: 'all', date_preset: preset }, orgId)]];
  for (const [nome, p] of calls) {
    try {
      const r = await p;
      if (!r || r.error || !r.meta) continue;
      out.gasto += Number(r.meta.spend) || 0;
      if (r.contas) out.fontes.push(nome);
      for (const d of r.serie || []) out.porDia.set(d.dia, (out.porDia.get(d.dia) || 0) + (Number(d.gasto) || 0));
    } catch { /* não conectado */ }
  }
  return out;
}

function KoblySales() {
  const store = useKobly();
  const { orgId, picker, isGestor } = useTargetOrg();
  const [preset, setPreset] = useState(() => { try { return localStorage.getItem(PKEY) || 'last_30d'; } catch { return 'last_30d'; } });
  const [st, setSt] = useState({ loading: true });
  const [ads, setAds] = useState(null);
  const [tick, setTick] = useState(0);
  const [taxas, setTaxas] = useState(false);
  const [geo, setGeo] = useState('estados');

  const pick = (p) => { setPreset(p); try { localStorage.setItem(PKEY, p); } catch { /* ok */ } };

  useEffect(() => {
    if (isGestor && !orgId) return undefined;
    let on = true;
    setSt((s) => ({ ...s, loading: true }));
    KoblyApi.serviceCall('dashboard', 'sales', { date_preset: preset }, orgId).then((r) => { if (on) setSt(r && !r.error && r.totais ? { d: r } : { error: (r && r.error) || 'Não foi possível carregar.' }); });
    setAds(null);
    adsSpend(preset, orgId).then((a) => { if (on) setAds(a); });
    const t = setInterval(() => setTick((x) => x + 1), 120000);
    return () => { on = false; clearInterval(t); };
  }, [preset, orgId, isGestor, tick]);

  const d = st.d;
  const serie = useMemo(() => (d ? d.serie.map((x) => ({ ...x, faturamento: Math.round(x.faturamento), gasto: Math.round(ads ? ads.porDia.get(x.dia) || 0 : 0) })) : []), [d, ads]);

  if (isGestor && !orgId) return <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>{picker}<div className="ks-empty">Selecione uma conta de cliente para ver as vendas.</div></div>;
  if (st.error && !d) return <ErrorState message={st.error} onRetry={() => setTick((x) => x + 1)} />;

  const t = d ? d.totais : null;
  const gasto = ads ? ads.gasto : 0;
  const lucro = t ? t.faturamento - t.despesas - gasto : 0;
  const roas = gasto > 0 && t ? t.faturamento / gasto : null;
  const prev = d && d.anterior;
  const periodo = (PERIODS.find((p) => p[0] === preset) || PERIODS[3])[1];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <style>{KD_CSS + KS_CSS}</style>
      {picker}
      <div className="kd-hero">
        <div className="kd-core"><span className="ring" /><span className="ring r2" /><span className="dot" /></div>
        <div style={{ flex: 1, minWidth: 240, position: 'relative', zIndex: 1 }}>
          <div style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: 22 }}>Suas vendas</div>
          <div className="kd-live" style={{ marginTop: 4 }}><i />{t ? `${money(t.faturamento)} em ${int(t.vendas)} venda(s)` : 'Carregando…'}</div>
        </div>
        <Button size="sm" variant="ghost" iconLeft="calculator" onClick={() => setTaxas(true)} style={{ position: 'relative', zIndex: 1 }}>Taxas e despesas</Button>
        <div className="kd-seg" style={{ flexWrap: 'wrap' }}>{PERIODS.map(([id, label]) => <button key={id} type="button" className={preset === id ? 'on' : ''} onClick={() => pick(id)}>{label}</button>)}</div>
      </div>

      {!d ? (
        <div className="kd-grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="kd-skel" />)}</div>
      ) : (
        <>
          <div className="kd-grid ks-kpis" style={{ opacity: st.loading ? 0.6 : 1, transition: 'opacity .2s' }}>
            <Kpi label="Faturamento" icon="badge-dollar-sign" color="#ff6201" value={t.faturamento} prev={prev ? prev.faturamento : undefined} format={money} sub={prev ? 'vs. período anterior' : periodo} spark={serie.map((x) => x.faturamento)} />
            <Kpi label="Vendas" icon="shopping-bag" color="#f39200" value={t.vendas} prev={prev ? prev.vendas : undefined} sub={`${int(t.recuperadas)} pelos fluxos`} spark={serie.map((x) => x.vendas)} delay={40} />
            <Kpi label="Ticket médio" icon="receipt" color="#fbbf24" value={t.ticket_medio} format={money} sub={`${int(t.compradores)} comprador(es)`} delay={80} />
            <Kpi label="Lucro" icon="wallet" color={lucro < 0 ? '#fb7185' : '#34d399'} value={lucro} format={money} sub={t.faturamento ? `margem ${Math.round((lucro / t.faturamento) * 100)}%` : 'faturamento − gasto − taxas'} delay={120} />
            <Kpi label="ROAS" icon="trending-up" color="#22d3ee" value={roas == null ? 0 : Math.round(roas * 100)} format={(v) => (roas == null ? '—' : `${(v / 100).toFixed(2)}x`)} sub={roas == null ? 'conecte Facebook ou Google Ads' : 'faturamento ÷ gasto'} delay={160} />
            <Kpi label="Gasto em anúncios" icon="megaphone" color="#818cf8" value={gasto} format={money} sub={ads ? (ads.fontes.length ? ads.fontes.join(' + ') : 'nenhuma conta de anúncio') : 'consultando…'} delay={200} />
            <Kpi label="Taxas e despesas" icon="calculator" color="#a78bfa" value={t.despesas} format={money} sub="imposto, gateway e custos" delay={240} />
            <Kpi label="Taxa de conversão" icon="percent" color="#2dd4bf" value={t.taxa_conversao == null ? 0 : Math.round(t.taxa_conversao * 10)} format={(v) => (t.taxa_conversao == null ? '—' : `${(v / 10).toLocaleString('pt-BR')}%`)} sub={`${int(t.leads)} lead(s) novos`} delay={280} />
            <Kpi label="Reembolsos" icon="undo-2" color="#fb7185" value={t.reembolsos.valor} format={money} sub={`${int(t.reembolsos.n)} reembolso(s) e chargeback(s)`} delay={320} />
            <Kpi label="Aguardando pagamento" icon="hourglass" color="#fcd34d" value={t.pendentes.valor} format={money} sub={`${int(t.pendentes.n)} Pix/boleto gerado(s)`} delay={360} />
          </div>

          <Panel title="Faturamento por dia" icon="chart-line"
            note={ads && !ads.fontes.length ? 'Conecte o Facebook ou o Google Ads em Anúncios para ver o gasto e o lucro de verdade.' : `Dias no fuso da empresa (${d.timezone}). Vendas = checkout aprovado + vendas feitas pelos fluxos.`}>
            {serie.length > 1
              ? <AreaChart key={preset} serie={serie} lines={[{ key: 'faturamento', label: 'Faturamento (R$)', color: '#ff6201' }, { key: 'gasto', label: 'Gasto em anúncios (R$)', color: '#818cf8' }, { key: 'vendas', label: 'Vendas', color: '#34d399' }]} />
              : <div className="ks-empty">{t.vendas ? `${money(t.faturamento)} em ${int(t.vendas)} venda(s) neste dia.` : 'Sem vendas neste dia.'} Escolha um período maior para ver o gráfico.</div>}
          </Panel>

          <div className="ks-grid2">
            <Panel title="Horários que mais vendem" icon="clock" color="#f39200" note="Cada quadradinho é um dia da semana × hora. Mais forte = mais vendas.">
              <Heatmap heat={d.heatmap} porHora={d.por_hora} />
            </Panel>
            <Panel title="De onde são os compradores" icon="map-pin" color="#22d3ee"
              action={<div className="ks-tabs">{[['estados', 'Estados'], ['paises', 'Países']].map(([id, l]) => <button key={id} type="button" className={geo === id ? 'on' : ''} onClick={() => setGeo(id)}>{l}</button>)}</div>}
              note="Pelo DDD/DDI do telefone do comprador.">
              {geo === 'estados'
                ? <BarList items={d.estados.slice(0, 10)} total={t.faturamento} color="#22d3ee" badge={(x) => <span className="ks-badge">{x.uf}</span>} empty="Nenhuma venda com telefone do Brasil no período." />
                : <BarList items={d.paises} total={t.faturamento} color="#22d3ee" empty="Nenhuma venda com telefone no período." />}
            </Panel>
          </div>

          <div className="ks-grid2">
            <Panel title="Vendas por número de WhatsApp" icon="smartphone" color="#25d366" note="O número em que o comprador conversou por último antes da compra.">
              <BarList items={d.instancias} total={t.faturamento} color="#25d366"
                badge={(x) => (x.nome === 'Sem conversa no WhatsApp' ? <span className="ks-badge" style={{ '--c': '#94a3b8' }}><Icon name="minus" size={14} /></span> : <ChannelLogo kind="qr" size={30} />)} />
            </Panel>
            <Panel title="Origem das vendas" icon="target" color="#818cf8" note="Pela UTM do link do anúncio (utm_source) ou pelo anúncio Click-to-WhatsApp.">
              <BarList items={d.origens} total={t.faturamento} color="#818cf8" />
            </Panel>
          </div>

          <div className="ks-grid2">
            <Panel title="Produtos mais vendidos" icon="package" color="#ff6201">
              {d.produtos.length ? (
                <div style={{ overflowX: 'auto' }}>
                  <table className="ks-tbl">
                    <thead><tr><th>Produto</th><th className="n">Vendas</th><th className="n">Faturamento</th><th className="n">Ticket médio</th></tr></thead>
                    <tbody>{d.produtos.map((p) => (
                      <tr key={p.nome}><td style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{p.nome}</td><td className="n">{int(p.vendas)}</td><td className="n">{money2(p.valor)}</td><td className="n">{money2(p.valor / p.vendas)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              ) : <div className="ks-empty">Sem vendas no período.</div>}
            </Panel>
            <Panel title="Forma de pagamento" icon="credit-card" color="#fbbf24">
              <BarList items={d.metodos} total={t.faturamento} color="#fbbf24" />
            </Panel>
          </div>
        </>
      )}
      <SettingsModal open={taxas} orgId={orgId} notify={store.notify} onClose={(saved) => { setTaxas(false); if (saved) setTick((x) => x + 1); }} />
    </div>
  );
}

export { KoblySales };
