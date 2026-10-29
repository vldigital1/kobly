import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Banner, Button, Icon, Input, Select } from '@/ds';
import { askConfirm } from '@/lib/confirm.jsx';
import { isDocumentoBr } from '@/lib/documento.js';
import { Modal, DocumentoField } from '@/lib/ui.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Planos & cobrança. Cliente: meu plano (conexões em uso, renovação, forma de pagamento), escolher plano
// (Essencial, PRO, Scale e Agência; mensal, trimestral ou anual), pagar por Pix (QR Code que confirma sozinho) ou
// cartão (cobrança automática todo ciclo), upgrade pagando só a diferença dos dias que faltam, reduzir plano na
// próxima renovação e o histórico de faturas. Administrador: assinaturas, receita por mês (MRR) e cortesias.
// Os preços e as regras vêm do servidor (billing/pricing.js). KoblyPlans

const money = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dia = (iso) => (iso ? new Date(String(iso).length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('pt-BR') : '—');
const onlyDigits = (v) => String(v || '').replace(/\D/g, '');
const fmtCard = (v) => onlyDigits(v).slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ');
const fmtExp = (v) => { const d = onlyDigits(v).slice(0, 4); return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; };
const fmtCep = (v) => { const d = onlyDigits(v).slice(0, 8); return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d; };
const fmtTel = (v) => { const d = onlyDigits(v).slice(0, 11); if (d.length <= 2) return d; if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`; return `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}`; };
const brandOf = (n) => { const d = onlyDigits(n); if (/^4/.test(d)) return 'Visa'; if (/^(5[1-5]|2[2-7])/.test(d)) return 'Mastercard'; if (/^3[47]/.test(d)) return 'Amex'; if (/^(636368|438935|504175|451416|636297|5067|4576|4011|506699)/.test(d)) return 'Elo'; if (/^(606282|3841)/.test(d)) return 'Hipercard'; return d.length >= 4 ? 'Cartão' : ''; };

// mesma conta do servidor (pricing.js) só para mostrar o preço enquanto escolhe; quem cobra é o servidor
function monthlyOf(code, n) {
  if (code === 'essencial') return 57 + 27 * (n - 1);
  if (code === 'pro') return 87 + 37 * (n - 1);
  if (code === 'scale') return 420 + 27 * (Math.min(n, 50) - 10) + 20 * Math.max(0, n - 50);
  return { agencia5: 397, agencia10: 697, agencia20: 1197 }[code] || 0;
}
const CICLOS = { mensal: { nome: 'Mensal', fator: 1, sufixo: '/mês', meses: 1 }, trimestral: { nome: 'Trimestral', fator: 2.85, sufixo: '/trimestre', meses: 3 }, anual: { nome: 'Anual', fator: 10, sufixo: '/ano', meses: 12 } };
// empresa aberta no seletor (a cobrança é da conta, não da pessoa)
let ORG = null;
const billingOrg = () => ORG;
const priceOf = (code, n, cycle) => Math.round(monthlyOf(code, n) * CICLOS[cycle].fator * 100) / 100;
const PLAN_ICON = { essencial: ['zap', '#60a5fa'], pro: ['rocket', '#ff7a1a'], scale: ['trending-up', '#a78bfa'], agencia5: ['building-2', '#34d399'], agencia10: ['building-2', '#34d399'], agencia20: ['building-2', '#34d399'] };
const SUB_ST = { ativa: ['Ativo', '#34d399', 'circle-check'], pendente: ['Aguardando pagamento', '#fbbf24', 'hourglass'], inadimplente: ['Pagamento atrasado', '#fb7185', 'circle-x'], cancelada: ['Cancelado', '#94a3b8', 'ban'], cortesia: ['Cortesia', '#a78bfa', 'gift'] };
const INV_ST = { pendente: ['Aguardando', '#fbbf24', 'hourglass'], paga: ['Paga', '#34d399', 'circle-check'], vencida: ['Vencida', '#fb7185', 'clock'], estornada: ['Estornada', '#94a3b8', 'refresh-cw'], cancelada: ['Cancelada', '#94a3b8', 'ban'], falhou: ['Recusada', '#fb7185', 'circle-x'] };

const CSS = `
.kp { display: flex; flex-direction: column; gap: 18px; }
.kp-card { border-radius: 20px; padding: 20px; background: rgba(12,14,22,.92); border: 1px solid rgba(255,255,255,.07); }
.kp-h { font-size: 17px; font-weight: 800; color: var(--text-strong); margin: 0; display: flex; align-items: center; gap: 8px; }
.kp-sub { font-size: 13.5px; color: var(--text-muted); margin-top: 3px; }
.kp-me { position: relative; overflow: hidden; border-radius: 22px; padding: 22px; background: radial-gradient(circle at 0% 0%, rgba(255,98,1,.26), transparent 55%), radial-gradient(circle at 100% 100%, rgba(167,139,250,.14), transparent 50%), rgba(15,17,26,.96); border: 1px solid rgba(255,148,82,.25); display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 22px; }
.kp-me .ic { width: 52px; height: 52px; border-radius: 16px; display: grid; place-items: center; color: #fff; flex: none; }
.kp-me .nm { font-size: 24px; font-weight: 900; color: var(--text-strong); letter-spacing: -.01em; }
.kp-me .pr { font-size: 15px; color: var(--text-body); margin-top: 2px; } .kp-me .pr b { font-size: 20px; color: var(--text-strong); }
.kp-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.kp-fact { padding: 12px 14px; border-radius: 14px; background: rgba(0,0,0,.28); border: 1px solid rgba(255,255,255,.07); min-width: 0; }
.kp-fact span { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--text-subtle); }
.kp-fact b { display: block; font-size: 15px; color: var(--text-strong); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kp-bar { height: 8px; border-radius: 99px; background: rgba(255,255,255,.08); overflow: hidden; margin-top: 8px; }
.kp-bar i { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, #ff9452, #ff6201); transition: width .4s; }
.kp-chip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; white-space: nowrap; }
.kp-cycle { display: inline-flex; padding: 4px; gap: 4px; border-radius: 14px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); flex-wrap: wrap; }
.kp-cycle button { border: 0; cursor: pointer; padding: 9px 16px; border-radius: 10px; font-family: var(--font-sans); font-size: 14px; font-weight: 700; color: var(--text-muted); background: transparent; display: inline-flex; align-items: center; gap: 7px; }
.kp-cycle button.on { color: #fff; background: linear-gradient(135deg, #ff9452, #ff6201); box-shadow: 0 0 18px rgba(255,98,1,.35); }
.kp-cycle small { font-size: 11px; padding: 1px 7px; border-radius: 99px; background: rgba(52,211,153,.18); color: #6ee7b7; font-weight: 800; }
.kp-cycle button.on small { background: rgba(255,255,255,.22); color: #fff; }
.kp-plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
.kp-plan { position: relative; border-radius: 20px; padding: 20px; display: flex; flex-direction: column; gap: 14px; background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.01)), rgba(13,15,23,.96); border: 1px solid rgba(255,255,255,.09); transition: transform .15s, border-color .15s; }
.kp-plan:hover { transform: translateY(-2px); border-color: rgba(255,148,82,.35); }
.kp-plan.hot { border-color: rgba(255,122,26,.7); box-shadow: 0 0 0 1px rgba(255,122,26,.35), 0 18px 50px rgba(255,98,1,.16); }
.kp-plan.cur { border-color: rgba(52,211,153,.6); }
.kp-plan .tag { position: absolute; top: -11px; left: 50%; transform: translateX(-50%); padding: 4px 12px; border-radius: 99px; font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: #fff; background: linear-gradient(135deg, #ff9452, #ff6201); white-space: nowrap; }
.kp-plan .tag.g { background: linear-gradient(135deg, #34d399, #059669); }
.kp-plan .top { display: flex; align-items: center; gap: 10px; }
.kp-plan .top i { width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center; font-style: normal; }
.kp-plan .top b { font-size: 19px; color: var(--text-strong); }
.kp-price { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.kp-price b { font-size: 32px; font-weight: 900; color: var(--text-strong); letter-spacing: -.02em; }
.kp-price span { font-size: 14px; color: var(--text-muted); }
.kp-price s { font-size: 13px; color: var(--text-subtle); width: 100%; }
.kp-conn { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border-radius: 14px; background: rgba(0,0,0,.28); border: 1px solid rgba(255,255,255,.07); }
.kp-conn > span { font-size: 13px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.kp-step { display: inline-flex; align-items: center; border-radius: 11px; border: 1px solid rgba(255,255,255,.12); overflow: hidden; }
.kp-step button { width: 34px; height: 34px; border: 0; cursor: pointer; background: rgba(255,255,255,.05); color: var(--text-strong); font-size: 18px; font-weight: 700; }
.kp-step button:disabled { opacity: .35; cursor: default; }
.kp-step input { width: 52px; height: 34px; border: 0; text-align: center; background: transparent; color: var(--text-strong); font-family: var(--font-sans); font-size: 15px; font-weight: 800; outline: none; }
.kp-feat { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; font-size: 13.5px; color: var(--text-body); flex: 1; }
.kp-feat li { display: flex; gap: 8px; align-items: flex-start; line-height: 1.4; }
.kp-feat li svg { flex: none; margin-top: 2px; color: #34d399; }
.kp-ag { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.kp-agc { border-radius: 16px; padding: 16px; background: rgba(52,211,153,.05); border: 1px solid rgba(52,211,153,.22); display: flex; flex-direction: column; gap: 8px; }
.kp-agc b { font-size: 16px; color: var(--text-strong); } .kp-agc .v { font-size: 24px; font-weight: 900; color: var(--text-strong); }
.kp-t { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.kp-t th { text-align: left; font-size: 11px; color: var(--text-subtle); text-transform: uppercase; letter-spacing: .07em; font-weight: 600; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.07); white-space: nowrap; }
.kp-t td { padding: 12px; border-bottom: 1px solid rgba(255,255,255,.05); color: var(--text-body); vertical-align: middle; }
.kp-t tr:hover td { background: rgba(255,255,255,.02); }
.kp-t .r { text-align: right; }
.kp-x { overflow-x: auto; }
.kp-empty { padding: 30px 10px; text-align: center; color: var(--text-muted); font-size: 14px; }
.kp-link { background: none; border: 0; padding: 0; cursor: pointer; color: #ff9452; font-family: var(--font-sans); font-size: 13px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px; }
.kp-ck { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr); gap: 18px; }
.kp-sum { border-radius: 16px; padding: 16px; background: rgba(255,98,1,.07); border: 1px solid rgba(255,148,82,.25); display: flex; flex-direction: column; gap: 10px; align-self: start; }
.kp-sum .ln { display: flex; justify-content: space-between; gap: 10px; font-size: 13.5px; color: var(--text-muted); }
.kp-sum .ln b { color: var(--text-strong); font-weight: 700; text-align: right; }
.kp-sum .tot { border-top: 1px dashed rgba(255,255,255,.15); padding-top: 10px; display: flex; justify-content: space-between; align-items: baseline; }
.kp-sum .tot b { font-size: 24px; font-weight: 900; color: var(--text-strong); }
.kp-pay { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.kp-pay button { cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; border-radius: 13px; font-family: var(--font-sans); font-size: 14px; font-weight: 700; color: var(--text-muted); background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.1); }
.kp-pay button.on { color: #fff; border-color: rgba(255,148,82,.7); background: rgba(255,98,1,.16); }
.kp-g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.kp-cc { position: relative; height: 150px; border-radius: 18px; padding: 18px; color: #fff; background: linear-gradient(135deg, #2a2f45, #141824 60%), #141824; border: 1px solid rgba(255,255,255,.12); display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; }
.kp-cc::after { content: ''; position: absolute; right: -40px; top: -40px; width: 160px; height: 160px; border-radius: 50%; background: radial-gradient(circle, rgba(255,98,1,.45), transparent 70%); }
.kp-cc .n { font-family: var(--font-mono); font-size: 18px; letter-spacing: .08em; }
.kp-cc .row { display: flex; justify-content: space-between; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; opacity: .85; gap: 10px; }
.kp-qr { display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; }
.kp-qr img { width: 230px; height: 230px; border-radius: 16px; background: #fff; padding: 10px; }
.kp-wait { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 99px; background: rgba(251,191,36,.12); color: #fde68a; font-size: 13.5px; font-weight: 700; }
.kp-wait i { width: 8px; height: 8px; border-radius: 50%; background: #fbbf24; animation: kpPulse 1.2s infinite; }
@keyframes kpPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.7); } }
.kp-copy { display: flex; gap: 8px; width: 100%; }
.kp-copy code { flex: 1; min-width: 0; padding: 10px 12px; border-radius: 12px; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.1); font-size: 12px; color: var(--text-body); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.kp-ok { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; padding: 10px 0; }
.kp-ok i { width: 70px; height: 70px; border-radius: 50%; display: grid; place-items: center; color: #fff; background: linear-gradient(135deg, #34d399, #059669); box-shadow: 0 0 30px rgba(52,211,153,.4); }
.kp-diff { display: flex; flex-direction: column; gap: 10px; padding: 16px; border-radius: 16px; background: rgba(0,0,0,.28); border: 1px solid rgba(255,255,255,.08); }
.kp-diff .ln { display: flex; justify-content: space-between; gap: 10px; font-size: 14px; color: var(--text-muted); }
.kp-diff .ln b { color: var(--text-strong); }
.kp-diff .ln.cr b { color: #34d399; }
.kp-diff .tot { display: flex; justify-content: space-between; align-items: baseline; border-top: 1px dashed rgba(255,255,255,.15); padding-top: 10px; }
.kp-diff .tot b { font-size: 26px; font-weight: 900; color: var(--text-strong); }
.kp-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.kp-k { border-radius: 16px; padding: 14px 16px; display: flex; gap: 12px; align-items: center; background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.012)), rgba(15,17,26,.95); border: 1px solid rgba(255,255,255,.08); }
.kp-k .i { width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); flex: none; }
.kp-k span { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .07em; } .kp-k b { display: block; font-size: 21px; color: var(--text-strong); margin-top: 2px; }
@media (max-width: 860px) { .kp-me, .kp-ck { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .kp-g2, .kp-facts { grid-template-columns: 1fr; } .kp-price b { font-size: 28px; } }
`;

function Chip({ map, s }) { const [l, c, i] = map[s] || [s, '#94a3b8', 'circle']; return <span className="kp-chip" style={{ color: c, background: `color-mix(in srgb, ${c} 15%, transparent)` }}><Icon name={i} size={12} />{l}</span>; }
function Stepper({ value, min, max, onChange }) {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => setTxt(String(value)), [value]);
  const commit = (v) => { const n = Math.max(min, Math.min(max, Math.round(Number(v) || min))); onChange(n); setTxt(String(n)); };
  return (
    <span className="kp-step">
      <button type="button" aria-label="Menos" disabled={value <= min} onClick={() => commit(value - 1)}>−</button>
      <input inputMode="numeric" aria-label="Conexões" value={txt} onChange={(e) => setTxt(onlyDigits(e.target.value).slice(0, 4))} onBlur={() => commit(txt)} onKeyDown={(e) => e.key === 'Enter' && commit(txt)} />
      <button type="button" aria-label="Mais" disabled={value >= max} onClick={() => commit(value + 1)}>+</button>
    </span>
  );
}

// ---- escolher plano ------------------------------------------------------------------------------
function PlanPicker({ cat, cycle, setCycle, current, onPick, enabled }) {
  const [conn, setConn] = useState({ essencial: 1, pro: 1, scale: 11 });
  useEffect(() => { if (current && conn[current.plan] !== undefined) setConn((c) => ({ ...c, [current.plan]: current.connections })); }, [current && current.plan, current && current.connections]); // eslint-disable-line react-hooks/exhaustive-deps
  const cy = CICLOS[cycle];
  const label = (p, n) => {
    if (!current) return 'Assinar';
    if (current.plan === p && current.connections === n && current.cycle === cycle) return 'Seu plano atual';
    return priceOf(p, n, current.cycle) > current.price ? 'Fazer upgrade' : 'Mudar para este';
  };
  return (
    <div className="kp-card" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
        <div><h2 className="kp-h"><Icon name="sparkles" size={18} style={{ color: '#ff9452' }} />{current ? 'Mudar de plano' : 'Escolha seu plano'}</h2>
          <div className="kp-sub">Você paga por conexão (cada número de WhatsApp, Instagram ou Messenger conectado). Sem fidelidade.</div></div>
        <div className="kp-cycle" role="tablist" aria-label="Ciclo de cobrança">
          {Object.entries(CICLOS).map(([k, c]) => (
            <button key={k} type="button" role="tab" aria-selected={cycle === k} className={cycle === k ? 'on' : ''} onClick={() => setCycle(k)}>
              {c.nome}{k === 'trimestral' && <small>-5%</small>}{k === 'anual' && <small>2 meses grátis</small>}
            </button>
          ))}
        </div>
      </div>
      <div className="kp-plans" style={{ paddingTop: 8 }}>
        {(cat.planos || []).map((p) => {
          const n = conn[p.code];
          const total = priceOf(p.code, n, cycle);
          const mes = monthlyOf(p.code, n);
          const [icon, color] = PLAN_ICON[p.code];
          const isCur = current && current.plan === p.code;
          const lb = label(p.code, n);
          return (
            <div key={p.code} className={`kp-plan${p.destaque ? ' hot' : ''}${isCur ? ' cur' : ''}`}>
              {isCur ? <span className="tag g">Seu plano</span> : p.destaque ? <span className="tag">Mais escolhido</span> : null}
              <div className="top"><i style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}><Icon name={icon} size={20} /></i><b>{p.nome}</b></div>
              <div className="kp-price">
                <b>{money(total)}</b><span>{cy.sufixo}</span>
                {cycle !== 'mensal' && <s>equivale a {money(total / cy.meses)}/mês · sem desconto seria {money(mes * cy.meses)}</s>}
              </div>
              <div className="kp-conn">
                <span><Icon name="plug" size={14} />Conexões</span>
                <Stepper value={n} min={p.min} max={p.max} onChange={(v) => setConn((c) => ({ ...c, [p.code]: v }))} />
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-subtle)', marginTop: -6 }}>
                {p.code === 'scale' ? `${money(p.base)} com 10 conexões + ${money(27)} cada até 50 e ${money(20)} acima de 50` : `${money(p.base)} com 1 conexão + ${money(p.extra)} por conexão a mais (até ${p.max})`}
              </div>
              <ul className="kp-feat">{p.recursos.map((r) => <li key={r}><Icon name="circle-check" size={15} />{r}</li>)}</ul>
              <Button variant={p.destaque ? 'primary' : 'secondary'} fullWidth disabled={!enabled || lb === 'Seu plano atual'} onClick={() => onPick({ plan: p.code, nome: p.nome, connections: n, cycle })}>{lb}</Button>
            </div>
          );
        })}
      </div>
      <div>
        <h3 className="kp-h" style={{ fontSize: 15 }}><Icon name="building-2" size={16} style={{ color: '#34d399' }} />Planos para agências</h3>
        <div className="kp-sub" style={{ marginBottom: 12 }}>Para quem gerencia clientes: cada conta de cliente ganha o PRO com 1 conexão. Você entra nas contas pelo seletor de empresas.</div>
        <div className="kp-ag">
          {(cat.agencias || []).map((a) => {
            const total = priceOf(a.code, 1, cycle);
            const isCur = current && current.plan === a.code;
            const lb = label(a.code, 1);
            return (
              <div key={a.code} className="kp-agc" style={isCur ? { borderColor: 'rgba(52,211,153,.7)' } : undefined}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><b>{a.nome}</b>{isCur && <Chip map={SUB_ST} s="ativa" />}</div>
                <div><span className="v">{money(total)}</span> <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{cy.sufixo}</span></div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Até {a.contas} contas de clientes · {money(monthlyOf(a.code, 1) / a.contas)} por conta/mês</div>
                <Button variant="secondary" size="sm" disabled={!enabled || lb === 'Seu plano atual'} onClick={() => onPick({ plan: a.code, nome: a.nome, connections: 1, cycle })}>{lb}</Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---- formulário do cartão --------------------------------------------------------------------------
const CARD0 = { number: '', holder: '', expiry: '', ccv: '', cpfCnpj: '', postalCode: '', addressNumber: '', phone: '' };
function cardOk(c) { return onlyDigits(c.number).length >= 13 && c.holder.trim().length > 2 && /^\d{2}\/\d{2}$/.test(c.expiry) && onlyDigits(c.ccv).length >= 3 && isDocumentoBr(c.cpfCnpj) && onlyDigits(c.postalCode).length === 8 && c.addressNumber.trim() && onlyDigits(c.phone).length >= 10; }
const cardBody = (c) => ({ card: { number: c.number, holder: c.holder, expiry: c.expiry, ccv: c.ccv }, holder: { cpfCnpj: c.cpfCnpj, postalCode: c.postalCode, addressNumber: c.addressNumber, phone: c.phone } });
function CardForm({ c, set }) {
  const f = (k, fmt) => (e) => set({ ...c, [k]: fmt ? fmt(e.target.value) : e.target.value });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="kp-cc" aria-hidden="true">
        <div className="row"><span>{brandOf(c.number) || 'Cartão de crédito'}</span><Icon name="credit-card" size={20} /></div>
        <div className="n">{fmtCard(c.number) || '•••• •••• •••• ••••'}</div>
        <div className="row"><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.holder || 'Nome no cartão'}</span><span>{c.expiry || 'MM/AA'}</span></div>
      </div>
      <Input label="Número do cartão" inputMode="numeric" autoComplete="cc-number" placeholder="0000 0000 0000 0000" value={fmtCard(c.number)} onChange={f('number', (v) => onlyDigits(v).slice(0, 19))} />
      <Input label="Nome impresso no cartão" autoComplete="cc-name" value={c.holder} onChange={f('holder', (v) => v.toUpperCase())} />
      <div className="kp-g2">
        <Input label="Validade" inputMode="numeric" autoComplete="cc-exp" placeholder="MM/AA" value={c.expiry} onChange={f('expiry', fmtExp)} />
        <Input label="CVV" inputMode="numeric" autoComplete="cc-csc" placeholder="123" value={c.ccv} onChange={f('ccv', (v) => onlyDigits(v).slice(0, 4))} />
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-muted)', marginTop: 4 }}>Dados do titular do cartão</div>
      <DocumentoField label="CPF ou CNPJ do titular" value={c.cpfCnpj} onChange={(v) => set({ ...c, cpfCnpj: v })} />
      <div className="kp-g2">
        <Input label="CEP" inputMode="numeric" autoComplete="postal-code" placeholder="00000-000" value={fmtCep(c.postalCode)} onChange={f('postalCode', (v) => onlyDigits(v).slice(0, 8))} />
        <Input label="Número do endereço" value={c.addressNumber} onChange={f('addressNumber')} />
      </div>
      <Input label="Celular" inputMode="tel" autoComplete="tel" placeholder="(11) 99999-9999" value={fmtTel(c.phone)} onChange={f('phone', (v) => onlyDigits(v).slice(0, 11))} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--text-subtle)' }}><Icon name="lock" size={13} />Os dados do cartão vão direto para o Asaas (banco de pagamentos). A Kobly não guarda o número.</div>
    </div>
  );
}

// ---- Pix: QR Code esperando o pagamento -----------------------------------------------------------
function PixBox({ inv }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { try { navigator.clipboard.writeText(inv.pix_payload); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* ok */ } };
  return (
    <div className="kp-qr">
      <span className="kp-wait"><i />Aguardando pagamento</span>
      {inv.pix_image ? <img src={`data:image/png;base64,${inv.pix_image}`} alt="QR Code do Pix" /> : <div className="kp-empty">QR Code indisponível. Use o código copia e cola.</div>}
      <div style={{ fontSize: 26, fontWeight: 900, color: 'var(--text-strong)' }}>{money(inv.value)}</div>
      <div style={{ fontSize: 13.5, color: 'var(--text-muted)', maxWidth: 360 }}>Abra o app do seu banco, escolha <b>Pix → Ler QR Code</b> ou cole o código abaixo. Esta tela atualiza sozinha quando o pagamento cair.</div>
      {inv.pix_payload && <div className="kp-copy"><code>{inv.pix_payload}</code><Button variant="secondary" size="sm" iconLeft={copied ? 'check' : 'copy'} onClick={copy}>{copied ? 'Copiado' : 'Copiar'}</Button></div>}
      {inv.invoice_url && <a className="kp-link" href={inv.invoice_url} target="_blank" rel="noreferrer"><Icon name="external-link" size={13} />Abrir a fatura no Asaas</a>}
    </div>
  );
}
function usePolling(inv, onPaid) {
  const ref = useRef(onPaid); ref.current = onPaid;
  useEffect(() => {
    if (!inv || inv.status !== 'pendente') return undefined;
    let alive = true;
    const t = setInterval(async () => {
      const r = await KoblyApi.billing('invoice', { id: inv.id }, billingOrg()).catch(() => null);
      if (alive && r && r.invoice && r.invoice.status !== 'pendente') ref.current(r);
    }, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [inv && inv.id, inv && inv.status]); // eslint-disable-line react-hooks/exhaustive-deps
}
function PaidBox({ title, text }) {
  return <div className="kp-ok"><i><Icon name="check" size={34} /></i><div style={{ fontSize: 20, fontWeight: 900, color: 'var(--text-strong)' }}>{title}</div><div style={{ color: 'var(--text-muted)', fontSize: 14, maxWidth: 380 }}>{text}</div></div>;
}

// ---- assinar --------------------------------------------------------------------------------------
function Checkout({ pick, status, onClose, onDone }) {
  const store = useKobly();
  const [method, setMethod] = useState('PIX');
  const [doc, setDoc] = useState('');
  const [card, setCard] = useState(CARD0);
  const [busy, setBusy] = useState(false);
  const [inv, setInv] = useState(null);
  const [paid, setPaid] = useState(false);
  usePolling(inv, (r) => { setInv(r.invoice); if (r.invoice.status === 'paga') { setPaid(true); onDone(); } });
  const needDoc = !status.documento;
  const total = priceOf(pick.plan, pick.connections, pick.cycle);
  const can = (!needDoc || isDocumentoBr(doc)) && (method === 'PIX' || cardOk(card));
  async function pay() {
    setBusy(true);
    const r = await KoblyApi.billing('subscribe', { plan: pick.plan, connections: pick.connections, cycle: pick.cycle, method, documento: needDoc ? doc : undefined, ...(method === 'CREDIT_CARD' ? cardBody(card) : {}) }, billingOrg());
    setBusy(false);
    if (r.error) { store.notify('danger', r.error); return; }
    onDone();
    if (r.invoice && r.invoice.status === 'paga') { setPaid(true); return; }
    if (r.invoice && r.invoice.status === 'falhou') { store.notify('danger', 'O cartão foi recusado. Confira os dados ou use outro cartão.'); return; }
    setInv(r.invoice);
  }
  const done = paid || (inv && inv.status === 'paga');
  return (
    <Modal open onClose={onClose} title={done ? 'Pagamento confirmado' : inv ? 'Pague com Pix' : `Assinar ${pick.nome}`} width={inv || done ? 480 : 820}
      footer={done ? <Button variant="primary" onClick={onClose}>Começar a usar</Button>
        : inv ? <Button variant="ghost" onClick={onClose}>Pagar depois</Button>
          : <><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" iconLeft={method === 'PIX' ? 'qr-code' : 'lock'} loading={busy} disabled={!can || busy} onClick={pay}>{method === 'PIX' ? 'Gerar Pix' : `Pagar ${money(total)}`}</Button></>}>
      {done ? <PaidBox title={`Plano ${pick.nome} ativo!`} text={method === 'CREDIT_CARD' ? 'As próximas cobranças entram sozinhas no seu cartão. Você recebe o recibo por e-mail.' : 'Pronto! Antes de cada renovação você recebe um novo Pix por e-mail e aqui no painel.'} />
        : inv ? (inv.status === 'pendente' ? <PixBox inv={inv} /> : <Banner tone="warning">Essa cobrança está {INV_ST[inv.status] ? INV_ST[inv.status][0].toLowerCase() : inv.status}. Feche e tente de novo.</Banner>)
          : (
            <div className="kp-ck">
              <div className="kp-sum">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 38, height: 38, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg, #ff9452, #ff6201)', color: '#fff' }}><Icon name={PLAN_ICON[pick.plan][0]} size={19} /></span><b style={{ fontSize: 18, color: 'var(--text-strong)' }}>{pick.nome}</b></div>
                {!/^agencia/.test(pick.plan) && <div className="ln"><span>Conexões</span><b>{pick.connections}</b></div>}
                <div className="ln"><span>Ciclo</span><b>{CICLOS[pick.cycle].nome}</b></div>
                {pick.cycle !== 'mensal' && <div className="ln"><span>Desconto</span><b style={{ color: '#34d399' }}>− {money(monthlyOf(pick.plan, pick.connections) * CICLOS[pick.cycle].meses - total)}</b></div>}
                <div className="tot"><span style={{ color: 'var(--text-muted)' }}>Total hoje</span><b>{money(total)}</b></div>
                <div style={{ fontSize: 12.5, color: 'var(--text-subtle)', lineHeight: 1.5 }}>Renova sozinho a cada {CICLOS[pick.cycle].meses === 1 ? 'mês' : `${CICLOS[pick.cycle].meses} meses`}. Você pode mudar de plano ou cancelar quando quiser.</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="kp-pay">
                  <button type="button" className={method === 'PIX' ? 'on' : ''} onClick={() => setMethod('PIX')}><Icon name="qr-code" size={17} />Pix</button>
                  <button type="button" className={method === 'CREDIT_CARD' ? 'on' : ''} onClick={() => setMethod('CREDIT_CARD')}><Icon name="credit-card" size={17} />Cartão de crédito</button>
                </div>
                {needDoc && <DocumentoField label="CPF ou CNPJ da sua empresa (para a nota)" value={doc} onChange={setDoc} />}
                {method === 'PIX'
                  ? <div style={{ display: 'flex', gap: 10, padding: 14, borderRadius: 14, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)', fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.5 }}><Icon name="zap" size={18} style={{ color: '#ff9452', flex: 'none', marginTop: 2 }} /><span>Geramos o QR Code na hora. O plano libera assim que o Pix cair (normalmente em segundos). A cada renovação chega um Pix novo.</span></div>
                  : <CardForm c={card} set={setCard} />}
              </div>
            </div>
          )}
    </Modal>
  );
}

// ---- upgrade / reduzir ----------------------------------------------------------------------------
function Change({ pick, sub, onClose, onDone }) {
  const store = useKobly();
  const [q, setQ] = useState(null);
  const [method, setMethod] = useState(sub.card ? 'CARD_SAVED' : 'PIX');
  const [card, setCard] = useState(CARD0);
  const [busy, setBusy] = useState(false);
  const [inv, setInv] = useState(null);
  const [done, setDone] = useState(false);
  useEffect(() => { KoblyApi.billing('quote', { plan: pick.plan, connections: pick.connections, cycle: pick.cycle }, billingOrg()).then((r) => (r && !r.error ? setQ(r) : (store.notify('danger', (r && r.error) || 'Não deu para calcular.'), onClose()))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  usePolling(inv, (r) => { setInv(r.invoice); if (r.invoice.status === 'paga') { setDone(true); onDone(); } });
  const up = q && q.upgrade && q.upgrade.direcao === 'upgrade' && pick.cycle === sub.cycle;
  async function go() {
    setBusy(true);
    let r;
    if (up) r = await KoblyApi.billing('upgrade', { plan: pick.plan, connections: pick.connections, method: method === 'PIX' ? 'PIX' : 'CREDIT_CARD', ...(method === 'CARD_NEW' ? cardBody(card) : {}) }, billingOrg());
    else r = await KoblyApi.billing('downgrade', { plan: pick.plan, connections: pick.connections, cycle: pick.cycle }, billingOrg());
    setBusy(false);
    if (r.error) { store.notify('danger', r.error); return; }
    onDone();
    if (!up) { store.notify('success', `Pronto. A partir de ${dia(sub.renova_em)} você fica no ${pick.nome}.`); onClose(); return; }
    if (r.invoice.status === 'paga') { setDone(true); return; }
    if (r.invoice.status === 'falhou') { store.notify('danger', 'O cartão foi recusado. Tente outro cartão ou Pix.'); return; }
    setInv(r.invoice);
  }
  const pagar = q && q.upgrade ? q.upgrade.pagar : 0;
  return (
    <Modal open onClose={onClose} title={done ? 'Upgrade feito!' : inv ? 'Pague a diferença com Pix' : up ? `Fazer upgrade para ${pick.nome}` : pick.cycle !== sub.cycle ? `Mudar para o ${CICLOS[pick.cycle].nome}` : `Reduzir para ${pick.nome}`} width={540}
      footer={done ? <Button variant="primary" onClick={onClose}>Fechar</Button>
        : inv ? <Button variant="ghost" onClick={onClose}>Pagar depois</Button>
          : <><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" iconLeft={up ? 'arrow-up-circle' : 'calendar'} loading={busy} disabled={!q || busy || (up && method === 'CARD_NEW' && !cardOk(card))} onClick={go}>{!up ? 'Confirmar' : pagar < 5 ? 'Mudar agora' : method === 'PIX' ? 'Gerar Pix' : `Pagar ${money(pagar)}`}</Button></>}>
      {done ? <PaidBox title={`Agora você está no ${pick.nome}`} text="As novas conexões e recursos já estão liberados. A data de renovação continua a mesma." />
        : inv ? <PixBox inv={inv} />
          : !q ? <div className="kp-empty">Calculando…</div>
            : up ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ fontSize: 14.5, color: 'var(--text-body)' }}><b style={{ color: 'var(--text-strong)' }}>Você paga só a diferença.</b> O que já pagou do plano atual vira crédito pelos {q.upgrade.dias_restantes} dias que faltam.</div>
                <div className="kp-diff">
                  <div className="ln"><span>{pick.nome}{/^agencia/.test(pick.plan) ? '' : ` · ${pick.connections} conexão(ões)`} ({q.upgrade.dias_restantes} dias)</span><b>{money(q.upgrade.novo)}</b></div>
                  <div className="ln cr"><span>Crédito do plano atual</span><b>− {money(q.upgrade.credito)}</b></div>
                  <div className="tot"><span style={{ color: 'var(--text-muted)' }}>Total hoje</span><b>{money(pagar)}</b></div>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="calendar" size={14} />Renovação continua em {dia(sub.renova_em)}, já no valor novo de {money(q.upgrade.price)}{CICLOS[sub.cycle].sufixo}.</div>
                {pagar >= 5 && (<>
                  <div className="kp-pay" style={{ gridTemplateColumns: sub.card ? '1fr 1fr 1fr' : '1fr 1fr' }}>
                    {sub.card && <button type="button" className={method === 'CARD_SAVED' ? 'on' : ''} onClick={() => setMethod('CARD_SAVED')}><Icon name="credit-card" size={16} />•••• {sub.card.last4}</button>}
                    <button type="button" className={method === 'CARD_NEW' ? 'on' : ''} onClick={() => setMethod('CARD_NEW')}><Icon name="plus" size={16} />{sub.card ? 'Outro cartão' : 'Cartão'}</button>
                    <button type="button" className={method === 'PIX' ? 'on' : ''} onClick={() => setMethod('PIX')}><Icon name="qr-code" size={16} />Pix</button>
                  </div>
                  {method === 'CARD_NEW' && <CardForm c={card} set={setCard} />}
                </>)}
                {pagar < 5 && <Banner tone="success">A diferença é pequena ({money(pagar)}): fazemos a troca agora sem cobrar.</Banner>}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="kp-diff">
                  <div className="ln"><span>Até {dia(sub.renova_em)}</span><b>{sub.nome} (como está hoje)</b></div>
                  <div className="ln"><span>A partir de {dia(sub.renova_em)}</span><b>{pick.nome}{/^agencia/.test(pick.plan) ? '' : ` · ${pick.connections} conexão(ões)`}</b></div>
                  <div className="tot"><span style={{ color: 'var(--text-muted)' }}>Próxima cobrança</span><b>{money(q.price)}</b></div>
                </div>
                <div style={{ fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>Você continua com tudo do plano atual até o fim do período já pago. Se mudar de ideia, dá para desfazer antes da renovação.</div>
              </div>
            )}
    </Modal>
  );
}

function ChangeCard({ onClose, onDone }) {
  const store = useKobly();
  const [card, setCard] = useState(CARD0);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const r = await KoblyApi.billing('change_card', cardBody(card), billingOrg());
    setBusy(false);
    if (r.error) { store.notify('danger', r.error); return; }
    store.notify('success', 'Cartão atualizado. As próximas cobranças vão nele.'); onDone(); onClose();
  }
  return (
    <Modal open onClose={onClose} title="Cartão para as próximas cobranças" width={480}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" iconLeft="lock" loading={busy} disabled={busy || !cardOk(card)} onClick={save}>Salvar cartão</Button></>}>
      <CardForm c={card} set={setCard} />
    </Modal>
  );
}

// ---- tela do cliente ----------------------------------------------------------------------------
function ClientBilling() {
  const store = useKobly();
  const [st, setSt] = useState(null);
  const [cat, setCat] = useState(null);
  const [err, setErr] = useState(null);
  const [cycle, setCycle] = useState('mensal');
  const [pick, setPick] = useState(null);
  const [payInv, setPayInv] = useState(null);
  const [cardModal, setCardModal] = useState(false);
  const pickerRef = useRef(null);
  const load = useCallback(async () => {
    const [s, c] = await Promise.all([KoblyApi.billing('status', {}, billingOrg()).catch((e) => ({ error: e.message })), KoblyApi.billing('catalog', {}, billingOrg()).catch(() => null)]);
    if (!s || s.error || !c || c.error || !Array.isArray(c.planos)) { setErr((s && s.error) || (c && c.error) || 'Não deu para carregar seus planos.'); return; }
    setErr(null); setSt(s); setCat(c);
    if (s.subscription && s.subscription.cycle) setCycle((x) => (x === 'mensal' ? s.subscription.cycle : x));
  }, []);
  useEffect(() => { load(); }, [load, store.session.empresaId]);
  usePolling(payInv, (r) => { setPayInv(r.invoice); load(); });
  if (err) return <div className="kp-card"><Banner tone="danger" title="Não deu para abrir">{err}</Banner><div style={{ marginTop: 12 }}><Button variant="secondary" iconLeft="refresh-cw" onClick={load}>Tentar de novo</Button></div></div>;
  if (!st) return <div className="kp-card kp-empty">Carregando seu plano…</div>;
  const sub = st.subscription && st.subscription.status !== 'cancelada' ? st.subscription : null;
  const ent = st.entitlement || {};
  const usage = st.usage || { total: 0 };
  const paying = sub && ['ativa', 'inadimplente'].includes(sub.status);
  const current = paying ? sub : null;
  const pend = st.pending;
  function choose(p) {
    if (current) { setPick({ ...p, change: true }); return; }
    setPick(p);
  }
  async function cancelDown() {
    if (!(await askConfirm('Você continua no plano atual depois da renovação.', { title: 'Desfazer a redução?', confirmLabel: 'Desfazer', danger: false }))) return;
    const r = await KoblyApi.billing('cancel_downgrade', {}, billingOrg());
    if (r.error) store.notify('danger', r.error); else { store.notify('success', 'Redução desfeita.'); load(); }
  }
  async function usePix() {
    if (!(await askConfirm('As próximas cobranças chegam como Pix (por e-mail e aqui no painel). O cartão salvo deixa de ser usado.', { title: 'Pagar as próximas com Pix?', confirmLabel: 'Usar Pix', danger: false }))) return;
    const r = await KoblyApi.billing('use_pix', {}, billingOrg());
    if (r.error) store.notify('danger', r.error); else { store.notify('success', 'Próximas cobranças por Pix.'); load(); }
  }
  const viaAgency = ent.source === 'agencia';
  const limit = ent.connections || 0;
  const [icon, color] = PLAN_ICON[(sub && sub.plan) || ent.plan || 'pro'] || PLAN_ICON.pro;
  return (
    <>
      {!st.enabled && <Banner tone="warning" title="Pagamento online ainda não ativado">A Kobly está terminando de ligar o pagamento automático. Enquanto isso, fale com o suporte para assinar.</Banner>}
      {sub && sub.status === 'inadimplente' && pend && <Banner tone="danger" title="Pagamento atrasado">Sua fatura de {money(pend.value)} venceu em {dia(pend.due_date)}. Pague para não perder o acesso. <button type="button" className="kp-link" onClick={() => setPayInv(pend)}>Pagar agora</button></Banner>}
      {sub && sub.status === 'pendente' && pend && pend.pix_payload && <Banner tone="warning" title="Falta pagar para liberar seu plano">O Pix de {money(pend.value)} do {sub.nome} está esperando. <button type="button" className="kp-link" onClick={() => setPayInv(pend)}>Ver QR Code</button></Banner>}

      {(current || ent.plan) ? (
        <div className="kp-me">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <span className="ic" style={{ background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 55%, #000))` }}><Icon name={icon} size={24} /></span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text-muted)', fontWeight: 700 }}>Meu plano</div>
                <div className="nm">{viaAgency ? ent.nome : sub ? sub.nome : ent.nome}</div>
              </div>
              <div style={{ marginLeft: 'auto' }}>{sub ? <Chip map={SUB_ST} s={sub.status} /> : <Chip map={SUB_ST} s="ativa" />}</div>
            </div>
            {sub && !viaAgency && <div className="pr"><b>{sub.price ? money(sub.price) : 'Grátis'}</b> {sub.price ? CICLOS[sub.cycle].sufixo : ''}{sub.status === 'cortesia' ? ' · liberado pela Kobly' : ''}</div>}
            {viaAgency && <div className="pr">Liberado pela sua agência. Fale com ela para mudar o plano.</div>}
            {sub && sub.pending_change && <Banner tone="info" title={`Redução marcada para ${dia(sub.renova_em)}`}>Depois dessa data você fica no {(cat.planos.find((p) => p.code === sub.pending_change.plan) || cat.agencias.find((a) => a.code === sub.pending_change.plan) || {}).nome} · {money(sub.pending_change.price)}. <button type="button" className="kp-link" onClick={cancelDown}>Desfazer</button></Banner>}
            {current && !viaAgency && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Button variant="primary" iconLeft="arrow-up-circle" onClick={() => pickerRef.current && pickerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Fazer upgrade</Button>
                <Button variant="secondary" iconLeft="arrow-down-circle" onClick={() => pickerRef.current && pickerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Reduzir plano</Button>
              </div>
            )}
          </div>
          <div className="kp-facts">
            {!/^agencia/.test(ent.plan || '') ? (
              <div className="kp-fact" style={{ gridColumn: '1 / -1' }}>
                <span>Conexões em uso</span>
                <b>{usage.total} de {limit}</b>
                <div className="kp-bar"><i style={{ width: `${limit ? Math.min(100, (usage.total / limit) * 100) : 0}%` }} /></div>
              </div>
            ) : (
              <div className="kp-fact" style={{ gridColumn: '1 / -1' }}><span>Contas de clientes</span><b>Até {ent.accounts}</b></div>
            )}
            <div className="kp-fact"><span>{sub && sub.status === 'cortesia' ? 'Válido até' : 'Renova em'}</span><b>{sub ? (sub.renova_em ? dia(sub.renova_em) : 'Sem prazo') : '—'}</b></div>
            <div className="kp-fact"><span>Pagamento</span><b>{sub && sub.status !== 'cortesia' ? (sub.billing_type === 'CREDIT_CARD' ? (sub.card ? `${sub.card.brand || 'Cartão'} •••• ${sub.card.last4}` : 'Cartão') : 'Pix') : '—'}</b>
              {current && <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap' }}><button type="button" className="kp-link" onClick={() => setCardModal(true)}>{sub.billing_type === 'CREDIT_CARD' ? 'Trocar cartão' : 'Usar cartão'}</button>{sub.billing_type === 'CREDIT_CARD' && <button type="button" className="kp-link" onClick={usePix}>Usar Pix</button>}</div>}
            </div>
          </div>
        </div>
      ) : (
        <div className="kp-me" style={{ gridTemplateColumns: '1fr' }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="ic" style={{ background: 'linear-gradient(135deg, #ff9452, #ff6201)' }}><Icon name="rocket" size={24} /></span>
            <div style={{ flex: 1, minWidth: 220 }}><div className="nm">Escolha um plano para começar</div><div className="kp-sub">Pague com Pix ou cartão e libere na hora. Troque de plano quando quiser, pagando só a diferença.</div></div>
          </div>
        </div>
      )}

      {!viaAgency && <div ref={pickerRef}><PlanPicker cat={cat} cycle={cycle} setCycle={setCycle} current={current} onPick={choose} enabled={st.enabled} /></div>}

      <div className="kp-card">
        <h2 className="kp-h"><Icon name="receipt" size={18} style={{ color: '#ff9452' }} />Faturas</h2>
        <div className="kp-sub" style={{ marginBottom: 10 }}>Tudo o que foi cobrado da sua conta.</div>
        {(st.invoices || []).length === 0 ? <div className="kp-empty">Nenhuma fatura ainda.</div> : (
          <div className="kp-x"><table className="kp-t">
            <thead><tr><th>Data</th><th>Descrição</th><th>Forma</th><th className="r">Valor</th><th>Status</th><th /></tr></thead>
            <tbody>{st.invoices.map((i) => (
              <tr key={i.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{dia(i.paid_at || i.due_date || i.created_at)}</td>
                <td>{i.description || (i.kind === 'upgrade' ? 'Upgrade' : 'Assinatura')}</td>
                <td>{i.billing_type === 'CREDIT_CARD' ? 'Cartão' : i.billing_type === 'PIX' ? 'Pix' : '—'}</td>
                <td className="r" style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{money(i.value)}</td>
                <td><Chip map={INV_ST} s={i.status} /></td>
                <td className="r" style={{ whiteSpace: 'nowrap' }}>
                  {(i.status === 'pendente' || i.status === 'vencida') && i.pix_payload ? <button type="button" className="kp-link" onClick={() => setPayInv(i)}><Icon name="qr-code" size={13} />Pagar</button>
                    : i.invoice_url ? <a className="kp-link" href={i.invoice_url} target="_blank" rel="noreferrer"><Icon name="external-link" size={13} />{i.status === 'paga' ? 'Recibo' : 'Abrir'}</a> : null}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {pick && !pick.change && <Checkout pick={pick} status={st} onClose={() => setPick(null)} onDone={load} />}
      {pick && pick.change && <Change pick={pick} sub={sub} onClose={() => setPick(null)} onDone={load} />}
      {cardModal && <ChangeCard onClose={() => setCardModal(false)} onDone={load} />}
      {payInv && (
        <Modal open onClose={() => setPayInv(null)} title={payInv.status === 'paga' ? 'Pagamento confirmado' : 'Pague com Pix'} width={480} footer={<Button variant="ghost" onClick={() => setPayInv(null)}>Fechar</Button>}>
          {payInv.status === 'paga' ? <PaidBox title="Recebemos seu pagamento" text="Tudo certo com o seu plano." /> : <PixBox inv={payInv} />}
        </Modal>
      )}
    </>
  );
}

// ---- tela do Administrador ------------------------------------------------------------------------
function AdminBilling() {
  const store = useKobly();
  const [ov, setOv] = useState(null);
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [gift, setGift] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const load = useCallback(() => {
    KoblyApi.billingAdmin('overview').then((r) => setOv(r && !r.error && typeof r.mrr === 'number' ? r : null)).catch(() => setOv(null));
    KoblyApi.billingAdmin('list', { q }).then((r) => setRows((r && r.subscriptions) || [])).catch(() => setRows([]));
  }, [q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { if (gift) KoblyApi.billingAdmin('orgs', { q: gift.q || '' }).then((r) => setOrgs((r && r.orgs) || [])).catch(() => setOrgs([])); }, [gift && gift.q]); // eslint-disable-line react-hooks/exhaustive-deps
  async function saveGift() {
    const r = await KoblyApi.billingAdmin('set_cortesia', { org_id: gift.org_id, plan: gift.plan, connections: Number(gift.connections) || 1, until: gift.until || null, note: gift.note });
    if (r.error) { store.notify('danger', r.error); return; }
    store.notify('success', 'Cortesia liberada.'); setGift(null); load();
  }
  async function cancel(s) {
    if (!(await askConfirm(`A assinatura de "${s.conta}" para de cobrar e o acesso é cortado.`, { title: 'Cancelar assinatura?', confirmLabel: 'Cancelar assinatura' }))) return;
    const r = await KoblyApi.billingAdmin('cancel', { org_id: s.organization_id });
    if (r.error) store.notify('danger', r.error); else { store.notify('success', 'Assinatura cancelada.'); load(); }
  }
  const PLANOS = [['essencial', 'Essencial'], ['pro', 'PRO'], ['scale', 'Scale'], ['agencia5', 'Agência 5'], ['agencia10', 'Agência 10'], ['agencia20', 'Agência 20']];
  const k = (c, icon, label, value) => <div className="kp-k" style={{ '--c': c }}><span className="i"><Icon name={icon} size={20} /></span><div><span>{label}</span><b>{value}</b></div></div>;
  return (
    <>
      {ov && !ov.enabled && <Banner tone="warning" title="Asaas ainda não ligado">Coloque ASAAS_API_KEY, ASAAS_ENV e ASAAS_WEBHOOK_TOKEN no Railway para os clientes pagarem sozinhos.</Banner>}
      <div className="kp-kpis">
        {k('#ff7a1a', 'trending-up', 'Receita por mês (MRR)', ov ? money(ov.mrr) : '—')}
        {k('#34d399', 'wallet', 'Recebido este mês', ov ? money(ov.recebido_mes) : '—')}
        {k('#60a5fa', 'circle-check', 'Assinaturas ativas', ov ? ov.ativas : '—')}
        {k('#fb7185', 'clock', 'Atrasadas', ov ? ov.inadimplentes : '—')}
        {k('#a78bfa', 'gift', 'Cortesias', ov ? ov.cortesias : '—')}
      </div>
      <div className="kp-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ flex: 1, minWidth: 200 }}><h2 className="kp-h"><Icon name="users" size={18} style={{ color: '#ff9452' }} />Assinaturas</h2><div className="kp-sub">Planos das contas, status do pagamento e conexões em uso.</div></div>
          <div style={{ width: 240, maxWidth: '100%' }}><Input placeholder="Buscar conta…" icon="search" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Button variant="primary" iconLeft="gift" onClick={() => setGift({ q: '', org_id: '', plan: 'pro', connections: 1, until: '', note: '' })}>Dar cortesia</Button>
        </div>
        {!rows ? <div className="kp-empty">Carregando…</div> : rows.length === 0 ? <div className="kp-empty">Nenhuma assinatura ainda.</div> : (
          <div className="kp-x"><table className="kp-t">
            <thead><tr><th>Conta</th><th>Plano</th><th>Conexões</th><th className="r">Valor</th><th>Pagamento</th><th>Status</th><th>Renova</th><th /></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id}>
                <td style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{s.conta}{s.note && <div style={{ fontSize: 12, color: 'var(--text-subtle)', fontWeight: 400 }}>{s.note}</div>}</td>
                <td>{s.nome}<div style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{s.ciclo}</div></td>
                <td>{/^agencia/.test(s.plan) ? '—' : `${s.em_uso} / ${s.connections}`}</td>
                <td className="r" style={{ fontWeight: 700 }}>{s.price ? money(s.price) : 'Grátis'}</td>
                <td>{s.status === 'cortesia' ? '—' : s.billing_type === 'CREDIT_CARD' ? `Cartão${s.card ? ` •••• ${s.card.last4}` : ''}` : 'Pix'}</td>
                <td><Chip map={SUB_ST} s={s.status} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>{s.renova_em ? dia(s.renova_em) : '—'}</td>
                <td className="r">{s.status !== 'cancelada' && <button type="button" className="kp-link" style={{ color: '#fb7185' }} onClick={() => cancel(s)}>Cancelar</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {gift && (
        <Modal open onClose={() => setGift(null)} title="Dar cortesia" subtitle="Libera um plano sem cobrar (parceiros, amigos, a sua própria conta). Se a conta pagava, a cobrança automática para." width={520}
          footer={<><Button variant="ghost" onClick={() => setGift(null)}>Cancelar</Button><Button variant="primary" iconLeft="gift" disabled={!gift.org_id} onClick={saveGift}>Liberar</Button></>}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Input label="Buscar a conta" icon="search" value={gift.q} onChange={(e) => setGift({ ...gift, q: e.target.value })} />
            <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {orgs.map((o) => (
                <button key={o.id} type="button" onClick={() => setGift({ ...gift, org_id: o.id })} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '9px 12px', borderRadius: 11, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 14, textAlign: 'left', color: 'var(--text-body)', background: gift.org_id === o.id ? 'rgba(255,98,1,.16)' : 'rgba(255,255,255,.03)', border: `1px solid ${gift.org_id === o.id ? 'rgba(255,148,82,.7)' : 'rgba(255,255,255,.08)'}` }}>
                  <span>{o.nome}</span>{o.plan_code && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{o.plan_code} · {o.status}</span>}
                </button>
              ))}
              {orgs.length === 0 && <div className="kp-empty" style={{ padding: 12 }}>Nenhuma conta encontrada.</div>}
            </div>
            <div className="kp-g2">
              <Select label="Plano" value={gift.plan} onChange={(e) => setGift({ ...gift, plan: e.target.value })} options={PLANOS.map(([value, label]) => ({ value, label }))} />
              {!/^agencia/.test(gift.plan) && <Input label="Conexões" type="number" value={gift.connections} onChange={(e) => setGift({ ...gift, connections: e.target.value })} />}
            </div>
            <Input label="Válido até (vazio = sem prazo)" type="date" value={gift.until} onChange={(e) => setGift({ ...gift, until: e.target.value })} />
            <Input label="Observação" placeholder="ex.: parceiro, conta da Kobly" value={gift.note} onChange={(e) => setGift({ ...gift, note: e.target.value })} />
          </div>
        </Modal>
      )}
    </>
  );
}

function KoblyPlans() {
  const store = useKobly();
  const admin = store.role === 'Administrador';
  ORG = store.session.empresaId || null;
  return (
    <div className="kp">
      <style>{CSS}</style>
      <div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 900, color: 'var(--text-strong)' }}>{admin ? 'Planos & cobrança' : 'Meu plano'}</h1>
        <div className="kp-sub">{admin ? 'Assinaturas de todas as contas, receita e cortesias.' : 'Seu plano, forma de pagamento e faturas. Pagamento automático por Pix ou cartão.'}</div>
      </div>
      {admin ? <AdminBilling /> : <ClientBilling />}
    </div>
  );
}
export { KoblyPlans };
