import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Banner, Button, Icon, Input, Select } from '@/ds';
import { askConfirm } from '@/lib/confirm.jsx';
import { Modal } from '@/lib/ui.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Afiliados. Quem indica a Kobly pelo link ganha comissão recorrente sobre cada pagamento das contas
// indicadas. Afiliado: link, painel (saldo, cliques, cadastros, clientes, gráfico de 12 meses), indicações,
// comissões, saques por Pix e dados de pagamento. Administrador: visão geral, afiliados (comissão especial por
// pessoa), saques a pagar, comissões e regras do programa (comissão padrão, saque mínimo, carência e os
// fluxos de boas-vindas). KoblyAffiliates

const money = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const int = (n) => Number(n || 0).toLocaleString('pt-BR');
const dia = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '—');
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mesLabel = (ym) => { const [y, m] = String(ym).split('-'); return `${MES[Number(m) - 1]}/${y.slice(2)}`; };
const ST = {
  pendente: ['Pendente', '#fbbf24', 'clock'], disponivel: ['Disponível', '#34d399', 'circle-check'], paga: ['Paga', '#60a5fa', 'badge-check'], cancelada: ['Cancelada', '#fb7185', 'circle-x'],
  solicitado: ['Aguardando pagamento', '#fbbf24', 'hourglass'], pago: ['Pago', '#34d399', 'badge-check'], recusado: ['Recusado', '#fb7185', 'circle-x'],
  ativo: ['Ativo', '#34d399', 'circle-check'], pausado: ['Pausado', '#fbbf24', 'pause-circle'], bloqueado: ['Bloqueado', '#fb7185', 'ban'],
  cliente: ['Cliente pagante', '#34d399', 'badge-check'], teste: ['Criou a conta', '#60a5fa', 'building-2'], cadastrado: ['Só cadastrou', '#94a3b8', 'user'], cancelou: ['Parou de pagar', '#fb7185', 'circle-x'],
};
const PIX = [['cpf', 'CPF'], ['cnpj', 'CNPJ'], ['email', 'E-mail'], ['telefone', 'Telefone'], ['aleatoria', 'Chave aleatória']];

const CSS = `
.ka2 { display: flex; flex-direction: column; gap: 16px; }
.ka2-hero { position: relative; overflow: hidden; border-radius: 22px; padding: 22px; background: radial-gradient(circle at 0% 0%, rgba(255,98,1,.28), transparent 55%), radial-gradient(circle at 100% 100%, rgba(52,211,153,.16), transparent 50%), rgba(15,17,26,.96); border: 1px solid rgba(255,148,82,.25); }
.ka2-link { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 14px; border-radius: 14px; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.1); min-width: 0; }
.ka2-link code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ffd2b3; font-size: 14px; }
.ka2-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
.ka2-k { border-radius: 16px; padding: 14px 16px; display: flex; gap: 12px; align-items: center; position: relative; overflow: hidden; background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.012)), rgba(15,17,26,.95); border: 1px solid rgba(255,255,255,.08); }
.ka2-k::before { content: ''; position: absolute; left: 14px; right: 14px; top: -1px; height: 2px; background: linear-gradient(90deg, transparent, var(--c), transparent); }
.ka2-k .i { width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); flex: none; }
.ka2-k span { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .07em; } .ka2-k b { display: block; font-size: 22px; color: var(--text-strong); margin-top: 2px; }
.ka2-k small { display: block; font-size: 11.5px; color: var(--text-subtle); margin-top: 1px; }
.ka2-card { border-radius: 18px; padding: 18px; background: rgba(12,14,22,.92); border: 1px solid rgba(255,255,255,.07); }
.ka2-tabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
.ka2-tab { flex: none; display: inline-flex; align-items: center; gap: 7px; padding: 9px 14px; border-radius: 12px; cursor: pointer; font-family: var(--font-sans); font-size: 14px; font-weight: 600; color: var(--text-muted); background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); }
.ka2-tab.on { color: #fff; border-color: rgba(255,148,82,.6); background: rgba(255,98,1,.2); }
.ka2-tab .n { padding: 0 7px; border-radius: 999px; font-size: 11px; background: rgba(251,191,36,.25); color: #fde68a; }
.ka2-t { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.ka2-t th { text-align: left; font-size: 11px; color: var(--text-subtle); text-transform: uppercase; letter-spacing: .07em; font-weight: 600; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.07); white-space: nowrap; }
.ka2-t td { padding: 11px 12px; border-bottom: 1px solid rgba(255,255,255,.05); color: var(--text-body); vertical-align: middle; }
.ka2-t tr:hover td { background: rgba(255,255,255,.02); }
.ka2-t .r { text-align: right; }
.ka2-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
.ka2-empty { padding: 34px 10px; text-align: center; color: var(--text-muted); font-size: 14px; }
.ka2-steps { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.ka2-step { border-radius: 16px; padding: 16px; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); display: flex; flex-direction: column; gap: 8px; }
.ka2-step i { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; font-style: normal; font-weight: 800; color: #fff; background: linear-gradient(135deg, #ff9452, #ff6201); }
.ka2-chart { display: flex; align-items: flex-end; gap: 8px; height: 190px; padding-top: 18px; }
.ka2-bar { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; height: 100%; justify-content: flex-end; position: relative; }
.ka2-bar .b { width: 100%; max-width: 38px; border-radius: 8px 8px 3px 3px; background: linear-gradient(180deg, #ff9452, #ff6201); box-shadow: 0 0 14px rgba(255,98,1,.25); min-height: 3px; transition: height .5s; }
.ka2-bar .b.zero { background: rgba(255,255,255,.08); box-shadow: none; }
.ka2-bar .v { font-size: 10.5px; color: var(--text-muted); white-space: nowrap; }
.ka2-bar .m { font-size: 11px; color: var(--text-subtle); }
.ka2-bar:hover .tip { display: block; }
.ka2-bar .tip { display: none; position: absolute; bottom: calc(100% - 10px); z-index: 5; padding: 8px 10px; border-radius: 10px; background: #1b2030; border: 1px solid rgba(255,255,255,.12); font-size: 12px; color: var(--text-body); white-space: nowrap; box-shadow: 0 10px 24px rgba(0,0,0,.5); }
.ka2-x { overflow-x: auto; }
`;

function Kpi({ c, icon, label, value, sub, action }) {
  return <div className="ka2-k" style={{ '--c': c }}><span className="i"><Icon name={icon} size={20} /></span><div style={{ flex: 1, minWidth: 0 }}><span>{label}</span><b>{value}</b>{sub && <small>{sub}</small>}{action && <div style={{ marginTop: 8 }}>{action}</div>}</div></div>;
}
function Chip({ s }) { const [l, c, i] = ST[s] || [s, '#94a3b8', 'circle']; return <span className="ka2-chip" style={{ color: c, background: `color-mix(in srgb, ${c} 15%, transparent)` }}><Icon name={i} size={11} />{l}</span>; }
function Bars({ data, field = 'comissao', extra }) {
  const max = Math.max(1, ...data.map((d) => d[field]));
  return (
    <div className="ka2-chart">
      {data.map((d) => (
        <div key={d.mes} className="ka2-bar">
          <span className="tip"><b>{mesLabel(d.mes)}</b><br />{money(d[field])}{extra ? extra(d) : null}</span>
          {d[field] > 0 && <span className="v">{money(d[field]).replace(/,\d\d$/, '')}</span>}
          <span className={`b${d[field] > 0 ? '' : ' zero'}`} style={{ height: `${Math.max(2, (d[field] / max) * 140)}px` }} />
          <span className="m">{mesLabel(d.mes)}</span>
        </div>
      ))}
    </div>
  );
}
function copy(text, notify, msg = 'Copiado!') { try { navigator.clipboard.writeText(text); notify('success', msg); } catch { notify('warning', 'Não deu para copiar. Selecione e copie à mão.'); } }

// ---------------------------------------------------------------- afiliado
function Join({ me, notify, onDone }) {
  const [code, setCode] = useState(me.sugestao || '');
  const [whatsapp, setWhatsapp] = useState('');
  const [busy, setBusy] = useState(false);
  const r = me.regras;
  async function join() {
    setBusy(true);
    const x = await KoblyApi.affiliates('join', { code, whatsapp });
    setBusy(false);
    if (x.error) { notify('danger', x.error); return; }
    notify('success', 'Pronto! Você já é afiliado da Kobly. Copie seu link e comece a indicar.');
    onDone();
  }
  return (
    <div className="ka2">
      <div className="ka2-hero">
        <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ width: 64, height: 64, borderRadius: 18, display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg, #ff9452, #ff6201)', boxShadow: '0 0 30px rgba(255,98,1,.45)', flex: 'none' }}><Icon name="handshake" size={32} style={{ color: '#fff' }} /></div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-strong)' }}>Ganhe {r.default_pct}% todo mês indicando a Kobly</div>
            <div style={{ fontSize: 15, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>Cada empresa que entrar pelo seu link vira comissão <b style={{ color: '#ffd2b3' }}>recorrente</b>: você recebe {r.default_pct}% de todo pagamento de plano dela, enquanto ela for cliente.</div>
          </div>
        </div>
      </div>
      <div className="ka2-steps">
        <div className="ka2-step"><i>1</i><b style={{ color: 'var(--text-strong)' }}>Pegue seu link</b><span style={{ color: 'var(--text-muted)', fontSize: 14 }}>Escolha um código fácil (ex.: seu nome). Ele vira app.koblay.io/?ref=seu-codigo.</span></div>
        <div className="ka2-step"><i>2</i><b style={{ color: 'var(--text-strong)' }}>Divulgue</b><span style={{ color: 'var(--text-muted)', fontSize: 14 }}>Quem clicar e criar conta em até {r.cookie_days} dias fica ligado a você.</span></div>
        <div className="ka2-step"><i>3</i><b style={{ color: 'var(--text-strong)' }}>Receba por Pix</b><span style={{ color: 'var(--text-muted)', fontSize: 14 }}>A comissão libera {r.hold_days} dias depois do pagamento. Saque a partir de {money(r.min_payout)}.</span></div>
      </div>
      <div className="ka2-card" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
        <Input label="Seu código" value={code} onChange={(e) => setCode(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30))} placeholder="maria-silva" hint={`Seu link: app.koblay.io/?ref=${code || 'seu-codigo'}`} />
        <Input label="WhatsApp (para avisos do programa)" type="tel" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="(11) 99999-9999" />
        {r.terms && <details style={{ fontSize: 13, color: 'var(--text-muted)' }}><summary style={{ cursor: 'pointer', color: 'var(--text-body)' }}>Regras do programa</summary><div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{r.terms}</div></details>}
        <Button variant="primary" iconLeft="handshake" disabled={busy || code.length < 3} onClick={join}>{busy ? 'Criando…' : 'Quero ser afiliado'}</Button>
      </div>
    </div>
  );
}

function AffiliatePanel({ notify }) {
  const [me, setMe] = useState(null);
  const [d, setD] = useState(null);
  const [tab, setTab] = useState('painel');
  const [list, setList] = useState({});
  const [pix, setPix] = useState(null);
  const [busy, setBusy] = useState(false);
  const loadMe = useCallback(async () => {
    const r = await KoblyApi.affiliates('me').catch((e) => ({ error: e.message }));
    if (!r || r.error || !r.regras) { setMe({ error: (r && r.error) || 'Não deu para abrir os afiliados agora.' }); return; }
    setMe(r);
    if (r.affiliate) { const x = await KoblyApi.affiliates('dashboard').catch(() => null); if (x && !x.error && x.saldo) setD(x); setPix({ tipo: r.affiliate.pix_tipo || 'cpf', chave: r.affiliate.pix_chave || '', whatsapp: r.affiliate.whatsapp || '' }); }
  }, []);
  useEffect(() => { loadMe(); }, [loadMe]);
  useEffect(() => {
    if (!me || !me.affiliate || tab === 'painel' || tab === 'dados') return;
    const action = { indicacoes: 'referrals', comissoes: 'commissions', saques: 'payouts' }[tab];
    KoblyApi.affiliates(action).then((r) => setList((l) => ({ ...l, [tab]: { referrals: [], commissions: [], payouts: [], ...(r || {}) } }))).catch(() => {});
  }, [tab, me]);

  if (!me) return <div className="ka2-card" style={{ color: 'var(--text-muted)' }}>Carregando…</div>;
  if (me.error) return <Banner tone="danger">{me.error}</Banner>;
  if (!me.affiliate) return <Join me={me} notify={notify} onDone={loadMe} />;
  const a = me.affiliate, r = me.regras;
  const s = d && d.saldo, st = d && d.stats;
  const share = `Conheci a Kobly, que recupera vendas no automático pelo WhatsApp e e-mail. Cria sua conta por aqui: ${a.link}`;

  async function sacar() {
    if (!a.pix_chave) { notify('warning', 'Cadastre sua chave Pix em "Dados de pagamento" primeiro.'); setTab('dados'); return; }
    if (!(await askConfirm(`Pedir o saque de ${money(s.disponivel)} para a chave Pix ${a.pix_chave}?`, { title: 'Pedir saque', confirmLabel: 'Pedir saque', danger: false }))) return;
    setBusy(true);
    const x = await KoblyApi.affiliates('request_payout');
    setBusy(false);
    if (x.error) { notify('danger', x.error); return; }
    notify('success', 'Saque pedido! Você recebe o Pix assim que a Kobly aprovar.');
    loadMe(); setList({});
  }
  async function salvarPix() {
    setBusy(true);
    const x = await KoblyApi.affiliates('update', { pix_tipo: pix.tipo, pix_chave: pix.chave, whatsapp: pix.whatsapp });
    setBusy(false);
    if (x.error) { notify('danger', x.error); return; }
    notify('success', 'Dados de pagamento salvos.'); loadMe();
  }
  const conv = st && st.cliques ? Math.round((st.cadastros / st.cliques) * 100) : 0;
  const TABS = [['painel', 'Painel', 'layout-dashboard'], ['indicacoes', 'Indicações', 'users'], ['comissoes', 'Comissões', 'coins'], ['saques', 'Saques', 'wallet'], ['dados', 'Dados de pagamento', 'landmark']];

  return (
    <div className="ka2">
      <div className="ka2-hero">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 300px', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-strong)' }}>Seu link de afiliado</span>
              <span className="ka2-chip" style={{ color: '#ffd2b3', background: 'rgba(255,98,1,.25)' }}><Icon name="percent" size={11} />{a.pct}% recorrente</span>
              {a.status !== 'ativo' && <Chip s={a.status} />}
            </div>
            <div className="ka2-link" style={{ marginTop: 10 }}>
              <Icon name="link" size={16} style={{ color: '#ff9452', flex: 'none' }} /><code>{a.link}</code>
              <Button size="sm" variant="primary" iconLeft="copy" onClick={() => copy(a.link, notify, 'Link copiado!')}>Copiar</Button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <a href={`https://wa.me/?text=${encodeURIComponent(share)}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><Button variant="secondary" iconLeft="message-circle">Mandar no WhatsApp</Button></a>
            <Button variant="secondary" iconLeft="copy" onClick={() => copy(share, notify, 'Mensagem copiada!')}>Copiar mensagem</Button>
          </div>
        </div>
      </div>

      <div className="ka2-kpis">
        <Kpi c="#34d399" icon="wallet" label="Disponível para saque" value={s ? money(s.disponivel) : '—'} sub={s && s.em_saque ? `${money(s.em_saque)} em saque` : `mínimo ${money(r.min_payout)}`}
          action={s && s.disponivel >= r.min_payout && a.status === 'ativo' ? <Button size="sm" variant="primary" disabled={busy} onClick={sacar}>Sacar</Button> : null} />
        <Kpi c="#fbbf24" icon="clock" label="A liberar" value={s ? money(s.pendente) : '—'} sub={`libera ${r.hold_days} dias após o pagamento`} />
        <Kpi c="#60a5fa" icon="badge-check" label="Já recebido" value={s ? money(s.paga) : '—'} sub={s ? `${money(s.total)} gerado no total` : ''} />
        <Kpi c="#ff9452" icon="trending-up" label="Últimos 30 dias" value={st ? money(st.ultimos_30) : '—'} sub="em comissões" />
      </div>
      <div className="ka2-kpis">
        <Kpi c="#a78bfa" icon="mouse-pointer-click" label="Cliques no link" value={st ? int(st.cliques) : '—'} sub={st ? `${int(st.cliques_30)} nos últimos 30 dias` : ''} />
        <Kpi c="#f39200" icon="user-plus" label="Cadastros" value={st ? int(st.cadastros) : '—'} sub={st ? `${conv}% dos cliques` : ''} />
        <Kpi c="#25D366" icon="building-2" label="Clientes pagantes" value={st ? int(st.ativos) : '—'} sub={st ? `${int(st.pagantes)} já pagaram alguma vez` : ''} />
      </div>

      <div className="ka2-tabs">{TABS.map(([id, l, ic]) => <button key={id} type="button" className={`ka2-tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}><Icon name={ic} size={15} />{l}</button>)}</div>

      {tab === 'painel' && d && (<>
        <div className="ka2-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="chart-column" size={16} style={{ color: '#ff9452' }} /><b style={{ color: 'var(--text-strong)' }}>Comissões por mês</b><span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-subtle)' }}>últimos 12 meses</span></div>
          <Bars data={d.serie} extra={(x) => <><br />{x.cadastros} cadastro(s) · {x.cliques} clique(s)</>} />
        </div>
        <div className="ka2-card">
          <b style={{ color: 'var(--text-strong)' }}>Últimas comissões</b>
          {!d.recentes.length ? <div className="ka2-empty">Assim que uma empresa indicada pagar o plano, a comissão aparece aqui.</div> : (
            <div className="ka2-x"><table className="ka2-t"><thead><tr><th>Data</th><th>Conta</th><th className="r">Pagamento</th><th className="r">Comissão</th><th>Situação</th></tr></thead>
              <tbody>{d.recentes.map((c) => <tr key={c.id}><td>{dia(c.created_at)}</td><td>{c.conta || '—'}{c.plano ? <span style={{ color: 'var(--text-subtle)' }}> · {c.plano}</span> : null}</td><td className="r">{money(c.base_value)}</td><td className="r"><b style={{ color: '#34d399' }}>{money(c.amount)}</b> <span style={{ color: 'var(--text-subtle)', fontSize: 11 }}>{c.pct}%</span></td><td><Chip s={c.payout_id && c.status === 'disponivel' ? 'solicitado' : c.status} /></td></tr>)}</tbody></table></div>
          )}
        </div>
      </>)}
      {tab === 'indicacoes' && <div className="ka2-card">{!list.indicacoes ? 'Carregando…' : !list.indicacoes.referrals.length ? <div className="ka2-empty">Ninguém se cadastrou pelo seu link ainda. Copie o link lá em cima e mande para quem vende pela internet.</div> : (
        <div className="ka2-x"><table className="ka2-t"><thead><tr><th>Quem</th><th>Conta</th><th>Plano</th><th>Situação</th><th>Desde</th><th className="r">Te rendeu</th></tr></thead>
          <tbody>{list.indicacoes.referrals.map((x) => <tr key={x.id}><td><b style={{ color: 'var(--text-strong)' }}>{x.nome || '—'}</b><div style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{x.email}</div></td><td>{x.conta || '—'}</td><td>{x.plano || '—'}</td><td><Chip s={x.situacao} /></td><td>{dia(x.created_at)}</td><td className="r"><b style={{ color: x.comissao ? '#34d399' : undefined }}>{money(x.comissao)}</b></td></tr>)}</tbody></table></div>)}</div>}
      {tab === 'comissoes' && <div className="ka2-card">{!list.comissoes ? 'Carregando…' : !list.comissoes.commissions.length ? <div className="ka2-empty">Nenhuma comissão ainda.</div> : (
        <div className="ka2-x"><table className="ka2-t"><thead><tr><th>Data</th><th>Conta</th><th className="r">Pagamento</th><th className="r">%</th><th className="r">Comissão</th><th>Libera em</th><th>Situação</th></tr></thead>
          <tbody>{list.comissoes.commissions.map((c) => <tr key={c.id}><td>{dia(c.created_at)}</td><td>{c.conta || '—'}{c.plano ? <span style={{ color: 'var(--text-subtle)' }}> · {c.plano}</span> : null}</td><td className="r">{money(c.base_value)}</td><td className="r">{c.pct}%</td><td className="r"><b style={{ color: '#34d399' }}>{money(c.amount)}</b></td><td>{c.status === 'pendente' ? dia(c.available_at) : '—'}</td><td><Chip s={c.payout_id && c.status === 'disponivel' ? 'solicitado' : c.status} /></td></tr>)}</tbody></table></div>)}</div>}
      {tab === 'saques' && <div className="ka2-card">{!list.saques ? 'Carregando…' : !list.saques.payouts.length ? <div className="ka2-empty">Você ainda não pediu saque. Quando tiver {money(r.min_payout)} disponível, o botão "Sacar" aparece no painel.</div> : (
        <div className="ka2-x"><table className="ka2-t"><thead><tr><th>Pedido em</th><th className="r">Valor</th><th>Pix</th><th>Situação</th><th>Pago em</th><th>Observação</th></tr></thead>
          <tbody>{list.saques.payouts.map((p) => <tr key={p.id}><td>{dia(p.requested_at)}</td><td className="r"><b style={{ color: 'var(--text-strong)' }}>{money(p.amount)}</b></td><td>{p.pix_chave}</td><td><Chip s={p.status} /></td><td>{dia(p.paid_at)}</td><td style={{ color: 'var(--text-muted)' }}>{p.note || '—'}</td></tr>)}</tbody></table></div>)}</div>}
      {tab === 'dados' && pix && <div className="ka2-card" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
        <Select label="Tipo da chave Pix" value={pix.tipo} onChange={(e) => setPix({ ...pix, tipo: e.target.value })} options={PIX.map(([v, l]) => ({ value: v, label: l }))} />
        <Input label="Chave Pix" value={pix.chave} onChange={(e) => setPix({ ...pix, chave: e.target.value })} placeholder="Para onde a Kobly manda suas comissões" />
        <Input label="WhatsApp" type="tel" value={pix.whatsapp} onChange={(e) => setPix({ ...pix, whatsapp: e.target.value })} />
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Seu código: <b style={{ color: 'var(--text-strong)' }}>{a.code}</b> (não muda depois do primeiro cadastro, para os links já divulgados continuarem valendo).</div>
        <Button variant="primary" iconLeft="check" disabled={busy || pix.chave.trim().length < 5} onClick={salvarPix}>Salvar</Button>
        {r.terms && <details style={{ fontSize: 13, color: 'var(--text-muted)' }}><summary style={{ cursor: 'pointer', color: 'var(--text-body)' }}>Regras do programa</summary><div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{r.terms}</div></details>}
      </div>}
    </div>
  );
}

// ---------------------------------------------------------------- administrador
function AdminPanel({ notify }) {
  const [tab, setTab] = useState('geral');
  const [ov, setOv] = useState(null);
  const [affs, setAffs] = useState(null);
  const [q, setQ] = useState('');
  const [pays, setPays] = useState(null);
  const [payFilter, setPayFilter] = useState('solicitado');
  const [coms, setComs] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [orgQ, setOrgQ] = useState('');
  const [orgs, setOrgs] = useState([]);
  const [camps, setCamps] = useState([]);
  const [edit, setEdit] = useState(null);
  const [add, setAdd] = useState(null);
  const [busy, setBusy] = useState(false);
  const loadOv = useCallback(() => KoblyApi.affiliatesAdmin('overview').then((r) => setOv(r && !r.error && Array.isArray(r.serie) ? r : null)).catch(() => setOv(null)), []);
  const loadAffs = useCallback(() => KoblyApi.affiliatesAdmin('list', { q }).then((r) => setAffs((r && r.affiliates) || [])).catch(() => setAffs([])), [q]);
  const loadPays = useCallback(() => KoblyApi.affiliatesAdmin('payouts', { status: payFilter || undefined }).then((r) => setPays((r && r.payouts) || [])).catch(() => setPays([])), [payFilter]);
  useEffect(() => { loadOv(); }, [loadOv]);
  useEffect(() => { if (tab === 'afiliados') { const t = setTimeout(loadAffs, q ? 300 : 0); return () => clearTimeout(t); } return undefined; }, [tab, loadAffs, q]);
  useEffect(() => { if (tab === 'saques') loadPays(); }, [tab, loadPays]);
  useEffect(() => { if (tab === 'comissoes') KoblyApi.affiliatesAdmin('commissions').then((r) => setComs((r && r.commissions) || [])).catch(() => setComs([])); }, [tab]);
  useEffect(() => { if (tab === 'regras') KoblyApi.affiliatesAdmin('settings').then((r) => { if (r && !r.error && r.settings) setCfg({ ...r.settings, platform_org: r.platform_org }); }).catch(() => {}); }, [tab]);
  useEffect(() => { if (tab === 'regras') KoblyApi.affiliatesAdmin('orgs', { q: orgQ }).then((r) => setOrgs((r && r.orgs) || [])).catch(() => {}); }, [tab, orgQ]);
  useEffect(() => { if (cfg && cfg.platform_org_id) KoblyApi.affiliatesAdmin('campaigns', { org_id: cfg.platform_org_id }).then((r) => setCamps((r && r.campaigns) || [])).catch(() => {}); else setCamps([]); }, [cfg && cfg.platform_org_id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveEdit() {
    setBusy(true);
    const r = await KoblyApi.affiliatesAdmin('update', { id: edit.id, commission_pct: edit.pctTxt === '' ? null : Number(String(edit.pctTxt).replace(',', '.')), status: edit.status, note: edit.note });
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', 'Afiliado atualizado. A nova comissão vale para os próximos pagamentos.'); setEdit(null); loadAffs();
  }
  async function create() {
    setBusy(true);
    const r = await KoblyApi.affiliatesAdmin('create', { email: add.email, code: add.code, commission_pct: add.pct === '' ? null : Number(String(add.pct).replace(',', '.')) });
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', 'Afiliado cadastrado.'); setAdd(null); loadAffs(); loadOv();
  }
  async function resolve(p, action) {
    const ok = await askConfirm(action === 'mark_paid' ? `Confirma que você já mandou ${money(p.amount)} por Pix para ${p.pix_chave} (${p.nome})?` : `Recusar o saque de ${money(p.amount)} de ${p.nome}? O valor volta para o saldo dele.`,
      { title: action === 'mark_paid' ? 'Marcar como pago' : 'Recusar saque', confirmLabel: action === 'mark_paid' ? 'Já paguei' : 'Recusar', danger: action !== 'mark_paid' });
    if (!ok) return;
    const r = await KoblyApi.affiliatesAdmin(action, { id: p.id });
    if (r.error) { notify('danger', r.error); return; }
    notify('success', action === 'mark_paid' ? 'Saque marcado como pago.' : 'Saque recusado.'); loadPays(); loadOv();
  }
  async function saveCfg() {
    setBusy(true);
    const r = await KoblyApi.affiliatesAdmin('save_settings', { default_pct: Number(String(cfg.default_pct).replace(',', '.')), min_payout: Number(String(cfg.min_payout).replace(',', '.')), hold_days: Number(cfg.hold_days), cookie_days: Number(cfg.cookie_days),
      terms: cfg.terms || '', platform_org_id: cfg.platform_org_id || null, referral_campaign_id: cfg.referral_campaign_id || null, affiliate_campaign_id: cfg.affiliate_campaign_id || null });
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', 'Regras salvas.'); loadOv();
  }
  const TABS = [['geral', 'Visão geral', 'layout-dashboard'], ['afiliados', 'Afiliados', 'users'], ['saques', 'Saques', 'wallet', ov && ov.saques_pendentes_n], ['comissoes', 'Comissões', 'coins'], ['regras', 'Regras e fluxos', 'settings']];
  const orgOptions = useMemo(() => {
    const list = [...orgs];
    if (cfg && cfg.platform_org && !list.some((o) => o.id === cfg.platform_org.id)) list.unshift(cfg.platform_org);
    return list;
  }, [orgs, cfg]);

  return (
    <div className="ka2">
      <div className="ka2-tabs">{TABS.map(([id, l, ic, n]) => <button key={id} type="button" className={`ka2-tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}><Icon name={ic} size={15} />{l}{n ? <span className="n">{n}</span> : null}</button>)}</div>
      {tab === 'geral' && (<>
        <div className="ka2-kpis">
          <Kpi c="#ff9452" icon="handshake" label="Afiliados ativos" value={ov ? int(ov.afiliados) : '—'} sub={ov ? `${int(ov.cadastros)} cadastros pelos links` : ''} />
          <Kpi c="#25D366" icon="building-2" label="Clientes indicados ativos" value={ov ? int(ov.clientes_ativos) : '—'} />
          <Kpi c="#34d399" icon="trending-up" label="Receita indicada" value={ov ? money(ov.receita_indicada) : '—'} sub="pagamentos de contas indicadas" />
          <Kpi c="#60a5fa" icon="coins" label="Comissões geradas" value={ov ? money(ov.comissao_total) : '—'} sub={ov ? `${money(ov.comissao_paga)} já pagas` : ''} />
          <Kpi c="#fbbf24" icon="wallet" label="Saques a pagar" value={ov ? money(ov.saques_pendentes) : '—'} sub={ov ? `${ov.saques_pendentes_n} pedido(s)` : ''} action={ov && ov.saques_pendentes_n ? <Button size="sm" variant="primary" onClick={() => setTab('saques')}>Ver</Button> : null} />
        </div>
        {ov && <div className="ka2-card"><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="chart-column" size={16} style={{ color: '#ff9452' }} /><b style={{ color: 'var(--text-strong)' }}>Receita das contas indicadas</b><span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-subtle)' }}>últimos 12 meses</span></div>
          <Bars data={ov.serie} field="receita" extra={(x) => <><br />comissões: {money(x.comissao)}</>} /></div>}
      </>)}
      {tab === 'afiliados' && <div className="ka2-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Input icon="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nome, e-mail ou código" style={{ flex: 1, minWidth: 220 }} />
          <Button variant="primary" iconLeft="user-plus" onClick={() => setAdd({ email: '', code: '', pct: '' })}>Adicionar afiliado</Button>
        </div>
        {!affs ? 'Carregando…' : !affs.length ? <div className="ka2-empty">Nenhum afiliado ainda. Quando alguém entrar em Afiliados e criar o link, aparece aqui.</div> : (
          <div className="ka2-x"><table className="ka2-t"><thead><tr><th>Afiliado</th><th>Código</th><th className="r">Comissão</th><th className="r">Cliques</th><th className="r">Cadastros</th><th className="r">Clientes ativos</th><th className="r">Gerado</th><th className="r">A sacar</th><th>Situação</th><th /></tr></thead>
            <tbody>{affs.map((x) => <tr key={x.id}>
              <td><b style={{ color: 'var(--text-strong)' }}>{x.nome || '—'}</b><div style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{x.email}</div></td>
              <td><button type="button" onClick={() => copy(x.link, notify, 'Link copiado!')} style={{ background: 'none', border: 0, color: '#ffd2b3', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 13 }} title="Copiar link">{x.code}</button></td>
              <td className="r"><b style={{ color: x.commission_pct != null ? '#ff9452' : 'var(--text-strong)' }}>{x.pct}%</b>{x.commission_pct != null && <div style={{ fontSize: 10.5, color: '#ff9452' }}>especial</div>}</td>
              <td className="r">{int(x.cliques)}</td><td className="r">{int(x.cadastros)}</td><td className="r">{int(x.clientes_ativos)}</td>
              <td className="r">{money(x.comissao_total)}</td><td className="r"><b style={{ color: x.disponivel ? '#34d399' : undefined }}>{money(x.disponivel)}</b></td>
              <td><Chip s={x.status} /></td>
              <td><Button size="sm" variant="secondary" iconLeft="pencil" onClick={() => setEdit({ ...x, pctTxt: x.commission_pct == null ? '' : String(x.commission_pct) })}>Editar</Button></td>
            </tr>)}</tbody></table></div>)}
      </div>}
      {tab === 'saques' && <div className="ka2-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 6 }}>{[['solicitado', 'A pagar'], ['pago', 'Pagos'], ['recusado', 'Recusados'], ['', 'Todos']].map(([v, l]) => <button key={v} type="button" className={`ka2-tab${payFilter === v ? ' on' : ''}`} onClick={() => setPayFilter(v)}>{l}</button>)}</div>
        {!pays ? 'Carregando…' : !pays.length ? <div className="ka2-empty">Nenhum saque aqui.</div> : (
          <div className="ka2-x"><table className="ka2-t"><thead><tr><th>Pedido em</th><th>Afiliado</th><th className="r">Valor</th><th>Chave Pix</th><th>Situação</th><th /></tr></thead>
            <tbody>{pays.map((p) => <tr key={p.id}>
              <td>{dia(p.requested_at)}</td><td><b style={{ color: 'var(--text-strong)' }}>{p.nome}</b><div style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{p.email}</div></td>
              <td className="r"><b style={{ color: 'var(--text-strong)', fontSize: 15 }}>{money(p.amount)}</b></td>
              <td><button type="button" onClick={() => copy(p.pix_chave, notify, 'Chave Pix copiada!')} style={{ background: 'none', border: 0, color: 'var(--text-body)', cursor: 'pointer', display: 'inline-flex', gap: 6, alignItems: 'center', fontFamily: 'var(--font-sans)' }}><Icon name="copy" size={13} />{p.pix_chave}</button><div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{(PIX.find((x) => x[0] === p.pix_tipo) || [])[1] || p.pix_tipo}</div></td>
              <td><Chip s={p.status} />{p.paid_at && <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{dia(p.paid_at)}</div>}</td>
              <td>{p.status === 'solicitado' && <div style={{ display: 'flex', gap: 6 }}><Button size="sm" variant="primary" iconLeft="check" onClick={() => resolve(p, 'mark_paid')}>Já paguei</Button><Button size="sm" variant="ghost" onClick={() => resolve(p, 'refuse')}>Recusar</Button></div>}</td>
            </tr>)}</tbody></table></div>)}
      </div>}
      {tab === 'comissoes' && <div className="ka2-card">{!coms ? 'Carregando…' : !coms.length ? <div className="ka2-empty">Nenhuma comissão ainda.</div> : (
        <div className="ka2-x"><table className="ka2-t"><thead><tr><th>Data</th><th>Afiliado</th><th>Conta indicada</th><th className="r">Pagamento</th><th className="r">%</th><th className="r">Comissão</th><th>Situação</th></tr></thead>
          <tbody>{coms.map((c) => <tr key={c.id}><td>{dia(c.created_at)}</td><td>{c.afiliado} <span style={{ color: 'var(--text-subtle)' }}>· {c.code}</span></td><td>{c.conta || '—'}</td><td className="r">{money(c.base_value)}</td><td className="r">{c.pct}%</td><td className="r"><b style={{ color: '#34d399' }}>{money(c.amount)}</b></td><td><Chip s={c.status} /></td></tr>)}</tbody></table></div>)}</div>}
      {tab === 'regras' && cfg && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <div className="ka2-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <b style={{ color: 'var(--text-strong)' }}>Comissão e saque</b>
          <Input label="Comissão padrão (%)" value={cfg.default_pct} onChange={(e) => setCfg({ ...cfg, default_pct: e.target.value })} hint="Vale para todos, menos quem tem comissão especial (Afiliados → Editar)." />
          <Input label="Saque mínimo (R$)" value={cfg.min_payout} onChange={(e) => setCfg({ ...cfg, min_payout: e.target.value })} />
          <Input label="Dias até liberar a comissão" value={cfg.hold_days} onChange={(e) => setCfg({ ...cfg, hold_days: e.target.value })} hint="Tempo para reembolsos e estornos antes do afiliado poder sacar." />
          <Input label="Validade do link (dias)" value={cfg.cookie_days} onChange={(e) => setCfg({ ...cfg, cookie_days: e.target.value })} hint="Quem clicou e criar a conta dentro desse prazo fica ligado ao afiliado." />
        </div>
        <div className="ka2-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <b style={{ color: 'var(--text-strong)' }}>Fluxos automáticos</b>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>A Kobly coloca a pessoa num fluxo da <b>sua conta</b> (WhatsApp/e-mail). Publique os fluxos nessa conta antes de escolher aqui.</div>
          <Input icon="search" label="Buscar a conta da Kobly" value={orgQ} onChange={(e) => setOrgQ(e.target.value)} placeholder="Nome da conta" />
          <Select label="Conta que envia os fluxos" value={cfg.platform_org_id || ''} onChange={(e) => setCfg({ ...cfg, platform_org_id: e.target.value || null, referral_campaign_id: null, affiliate_campaign_id: null })}
            options={[{ value: '', label: 'Nenhuma (não enviar fluxos)' }, ...orgOptions.map((o) => ({ value: o.id, label: o.nome }))]} />
          <Select label="Fluxo para quem se cadastra pelo link" value={cfg.referral_campaign_id || ''} disabled={!cfg.platform_org_id} onChange={(e) => setCfg({ ...cfg, referral_campaign_id: e.target.value || null })}
            options={[{ value: '', label: 'Nenhum' }, ...camps.map((c) => ({ value: c.id, label: c.nome }))]} />
          <Select label="Fluxo para quem vira afiliado" value={cfg.affiliate_campaign_id || ''} disabled={!cfg.platform_org_id} onChange={(e) => setCfg({ ...cfg, affiliate_campaign_id: e.target.value || null })}
            options={[{ value: '', label: 'Nenhum' }, ...camps.map((c) => ({ value: c.id, label: c.nome }))]} />
          {cfg.platform_org_id && !camps.length && <Banner tone="warning">Essa conta ainda não tem fluxo publicado.</Banner>}
        </div>
        <div className="ka2-card" style={{ display: 'flex', flexDirection: 'column', gap: 12, gridColumn: '1 / -1' }}>
          <b style={{ color: 'var(--text-strong)' }}>Regras do programa (os afiliados veem)</b>
          <textarea value={cfg.terms || ''} onChange={(e) => setCfg({ ...cfg, terms: e.target.value })} rows={6} maxLength={8000} placeholder="Ex.: Não vale indicar a si mesmo. Proibido anunciar com a marca Kobly no Google…"
            style={{ width: '100%', boxSizing: 'border-box', borderRadius: 12, border: '1px solid rgba(255,255,255,.1)', background: 'rgba(0,0,0,.25)', color: 'var(--text-strong)', font: 'inherit', fontSize: 14, padding: 12, resize: 'vertical' }} />
          <div><Button variant="primary" iconLeft="check" disabled={busy} onClick={saveCfg}>{busy ? 'Salvando…' : 'Salvar regras'}</Button></div>
        </div>
      </div>}

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit ? `Editar ${edit.nome || edit.code}` : ''} width={480}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancelar</Button><Button variant="primary" iconLeft="check" disabled={busy} onClick={saveEdit}>Salvar</Button></>}>
        {edit && <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input label="Comissão deste afiliado (%)" value={edit.pctTxt} onChange={(e) => setEdit({ ...edit, pctTxt: e.target.value })} placeholder="vazio = comissão padrão" hint="Deixe vazio para usar a comissão padrão. Vale para os próximos pagamentos." />
          <Select label="Situação" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })} options={[{ value: 'ativo', label: 'Ativo' }, { value: 'pausado', label: 'Pausado (não gera comissão nova)' }, { value: 'bloqueado', label: 'Bloqueado' }]} />
          <Input label="Anotação (só você vê)" value={edit.note || ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Link: <b style={{ color: '#ffd2b3' }}>{edit.link}</b> · Pix: {edit.pix_chave || 'não cadastrado'}</div>
        </div>}
      </Modal>
      <Modal open={!!add} onClose={() => setAdd(null)} title="Adicionar afiliado" subtitle="A pessoa precisa ter conta na Kobly." width={480}
        footer={<><Button variant="ghost" onClick={() => setAdd(null)}>Cancelar</Button><Button variant="primary" iconLeft="user-plus" disabled={busy || !(add && add.email.includes('@'))} onClick={create}>Adicionar</Button></>}>
        {add && <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input label="E-mail da conta da pessoa" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} />
          <Input label="Código do link (opcional)" value={add.code} onChange={(e) => setAdd({ ...add, code: e.target.value.toLowerCase() })} placeholder="ex.: joao" />
          <Input label="Comissão especial (%)" value={add.pct} onChange={(e) => setAdd({ ...add, pct: e.target.value })} placeholder="vazio = padrão" />
        </div>}
      </Modal>
    </div>
  );
}

function KoblyAffiliates() {
  const store = useKobly();
  const isAdmin = store.role === 'Administrador';
  const [view, setView] = useState(isAdmin ? 'admin' : 'me');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{CSS}</style>
      {isAdmin && <div className="ka2-tabs">
        <button type="button" className={`ka2-tab${view === 'admin' ? ' on' : ''}`} onClick={() => setView('admin')}><Icon name="shield" size={15} />Gerenciar programa</button>
        <button type="button" className={`ka2-tab${view === 'me' ? ' on' : ''}`} onClick={() => setView('me')}><Icon name="link" size={15} />Meu link</button>
      </div>}
      {view === 'admin' && isAdmin ? <AdminPanel notify={store.notify} /> : <AffiliatePanel notify={store.notify} />}
    </div>
  );
}

export { KoblyAffiliates };
