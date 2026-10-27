import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Banner, Button, Icon, IconButton, Input, Select } from '@/ds';
import { ChannelLogo } from '@/lib/brandLogos.jsx';
import { TIPOS_EVENTO } from '@/lib/flowGraph.js';
import { fmtDateTime, useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Disparo em massa. Três passos: o que enviar (um FLUXO publicado, uma MENSAGEM de WhatsApp ou um
// E-MAIL), para quem (filtro por etiqueta/evento ou lista colada à mão) e em que ritmo. O servidor envia um
// contato por vez no ritmo escolhido; o progresso aparece ao vivo. KoblyBulkSend

const MODOS = [
  { id: 'fluxo', label: 'Fluxo', icon: 'git-branch', color: '#ff9452', desc: 'Coloca cada contato no início de um fluxo publicado: textos, mídias, IA, cobrança, tudo que o fluxo fizer.' },
  { id: 'whatsapp', label: 'Mensagem de WhatsApp', logo: 'qr', color: '#25D366', desc: 'Uma mensagem de texto direto no WhatsApp de cada contato.' },
  { id: 'email', label: 'E-mail', icon: 'mail', color: '#ffb485', desc: 'Um e-mail com a sua marca, escolhido entre os que você já criou.' },
];
const RITMOS = [
  { v: 15, label: 'Seguro', hint: 'Melhor para WhatsApp por QR Code: menos risco de bloqueio' },
  { v: 40, label: 'Normal', hint: 'Bom equilíbrio' },
  { v: 120, label: 'Rápido', hint: 'Para e-mail ou API Oficial' },
];
const STATUS = { enviando: ['run', 'Enviando'], concluido: ['ok', 'Concluído'], cancelado: ['off', 'Cancelado'], falhou: ['err', 'Falhou'], enfileirando: ['run', 'Preparando'] };
const VARS = ['{{primeiro_nome}}', '{{nome}}', '{{produto}}', '{{valor}}'];
const dur = (n, rate) => { const m = Math.ceil(n / Math.max(1, rate)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

const KB_CSS = `
.kb-hero { position: relative; overflow: hidden; border-radius: 20px; padding: 20px 22px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
  background: radial-gradient(700px 260px at 0% 0%, rgba(255,98,1,.2), transparent 60%), radial-gradient(600px 260px at 100% 100%, rgba(243,146,0,.14), transparent 60%), rgba(14,16,24,.92);
  border: 1px solid rgba(255,255,255,.08); box-shadow: 0 18px 50px rgba(0,0,0,.45); }
.kb-hero::after { content: ''; position: absolute; left: -30%; top: 0; width: 30%; height: 100%; background: linear-gradient(90deg, transparent, rgba(255,255,255,.06), transparent); animation: kb-sweep 5s linear infinite; pointer-events: none; }
@keyframes kb-sweep { to { left: 130%; } }
.kb-orb { width: 54px; height: 54px; border-radius: 16px; display: grid; place-items: center; color: #fff; background: conic-gradient(from 180deg, #f39200, #ff6201, #ffd6bd, #f39200); box-shadow: 0 0 30px rgba(255,98,1,.45); animation: kb-spin 8s linear infinite; }
.kb-orb > * { animation: kb-spin 8s linear infinite reverse; }
@keyframes kb-spin { to { transform: rotate(360deg); } }
.kb-stat { min-width: 108px; padding: 10px 14px; border-radius: 14px; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07); position: relative; z-index: 1; }
.kb-stat b { display: block; font-size: 22px; color: var(--text-strong); line-height: 1.1; }
.kb-stat span { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .08em; }
.kb-card { border-radius: 20px; padding: 20px; display: flex; flex-direction: column; gap: 16px; background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.012)), rgba(15,17,26,.94); border: 1px solid rgba(255,255,255,.08); box-shadow: 0 14px 40px rgba(0,0,0,.4); }
.kb-step { display: flex; align-items: center; gap: 12px; }
.kb-step i { font-style: normal; width: 30px; height: 30px; border-radius: 10px; display: grid; place-items: center; font-weight: 800; color: #fff; background: linear-gradient(135deg, #f39200, #ff6201); box-shadow: 0 0 16px rgba(255,98,1,.4); flex: none; }
.kb-step b { color: var(--text-strong); font-size: 16px; }
.kb-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.kb-tile { text-align: left; display: flex; flex-direction: column; gap: 10px; padding: 16px; border-radius: 16px; cursor: pointer; font-family: var(--font-sans); background: rgba(255,255,255,.025); border: 1px solid rgba(255,255,255,.08); transition: all .18s; }
.kb-tile:hover { border-color: color-mix(in srgb, var(--c) 55%, transparent); transform: translateY(-2px); }
.kb-tile.on { border-color: transparent; background: radial-gradient(circle at 0% 0%, color-mix(in srgb, var(--c) 22%, transparent), transparent 70%), rgba(255,255,255,.04); box-shadow: inset 0 0 0 1.5px var(--c), 0 0 26px color-mix(in srgb, var(--c) 28%, transparent); }
.kb-ico { width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; color: var(--c); background: color-mix(in srgb, var(--c) 16%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 35%, transparent); }
.kb-seg { display: inline-flex; padding: 4px; gap: 4px; border-radius: 13px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); }
.kb-seg button { border: 0; padding: 8px 16px; border-radius: 10px; background: transparent; color: var(--text-muted); cursor: pointer; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: 600; display: inline-flex; gap: 7px; align-items: center; }
.kb-seg button.on { color: #fff; background: linear-gradient(135deg, rgba(243,146,0,.3), rgba(255,98,1,.42)); box-shadow: inset 0 0 0 1px rgba(255,148,82,.55); }
.kb-chip { display: inline-flex; align-items: center; gap: 6px; padding: 7px 13px; border-radius: 999px; font-size: var(--text-sm); cursor: pointer; font-family: var(--font-sans); color: var(--text-muted); background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.09); transition: all .15s; }
.kb-chip:hover { color: var(--text-strong); border-color: rgba(255,148,82,.5); }
.kb-chip.on { color: #fff; border-color: transparent; background: linear-gradient(135deg, rgba(243,146,0,.28), rgba(255,98,1,.38)); box-shadow: inset 0 0 0 1px rgba(255,148,82,.65); }
.kb-ta { width: 100%; box-sizing: border-box; background: rgba(255,255,255,.03); color: var(--text-strong); border: 1px solid rgba(255,255,255,.1); border-radius: 14px; padding: 12px 14px; font: inherit; resize: vertical; outline: none; }
.kb-ta:focus { border-color: #ff9452; box-shadow: 0 0 0 3px rgba(255,98,1,.2); }
.kb-bubble { align-self: flex-start; max-width: 360px; padding: 10px 12px 18px; border-radius: 4px 14px 14px 14px; background: #1f2c33; color: #e9edef; font-size: 14px; line-height: 1.45; white-space: pre-wrap; position: relative; box-shadow: 0 6px 18px rgba(0,0,0,.35); }
.kb-bubble small { position: absolute; right: 10px; bottom: 4px; font-size: 10px; color: #8696a0; }
.kb-reach { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-radius: 16px; background: linear-gradient(135deg, rgba(243,146,0,.08), rgba(255,98,1,.12)); border: 1px solid rgba(255,148,82,.25); }
.kb-reach b { font-size: 28px; color: var(--text-strong); }
.kb-go { display: inline-flex; align-items: center; gap: 9px; padding: 13px 22px; border-radius: 14px; border: 0; cursor: pointer; font-family: var(--font-sans); font-weight: 700; font-size: 15px; color: #fff; background: linear-gradient(135deg, #f39200, #ff6201 55%, #ffd6bd); box-shadow: 0 0 28px rgba(255,98,1,.45); transition: transform .15s, box-shadow .15s; }
.kb-go:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 0 38px rgba(255,98,1,.6); }
.kb-go:disabled { opacity: .45; cursor: not-allowed; }
.kb-bar { height: 8px; border-radius: 999px; background: rgba(255,255,255,.07); overflow: hidden; display: flex; }
.kb-bar span { height: 100%; transition: width .5s; }
.kb-bar .ok { background: linear-gradient(90deg, #f39200, #34d399); box-shadow: 0 0 10px #34d399; }
.kb-bar .sk { background: #64748b; } .kb-bar .er { background: #fb7185; }
.kb-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid; }
.kb-pill .d { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.kb-pill.run { color: #ff9452; border-color: rgba(255,148,82,.4); background: rgba(255,98,1,.1); } .kb-pill.run .d { animation: kb-blink 1s infinite; }
.kb-pill.ok { color: #34d399; border-color: rgba(52,211,153,.35); background: rgba(52,211,153,.08); }
.kb-pill.off { color: #94a3b8; border-color: rgba(148,163,184,.3); } .kb-pill.err { color: #fb7185; border-color: rgba(251,113,133,.35); }
@keyframes kb-blink { 50% { opacity: .3; } }
.kb-row { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border-radius: 16px; background: rgba(255,255,255,.025); border: 1px solid rgba(255,255,255,.07); }
.kb-modal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 16px; background: rgba(4,6,12,.62); backdrop-filter: blur(6px); }
`;

function KoblyBulkSend() {
  const store = useKobly();
  const { orgId, picker, canEdit } = useTargetOrg();
  const [data, setData] = useState({ flows: [], emails: [], tags: [], sends: [], loading: true });
  const [modo, setModo] = useState('fluxo');
  const [campaignId, setCampaignId] = useState('');
  const [emailId, setEmailId] = useState('');
  const [texto, setTexto] = useState('Oi {{primeiro_nome}}! ');
  const [origem, setOrigem] = useState('filtro');
  const [tagIds, setTagIds] = useState([]);
  const [evento, setEvento] = useState('');
  const [lista, setLista] = useState('');
  const [rate, setRate] = useState(15);
  const [nome, setNome] = useState('');
  const [est, setEst] = useState({ total: null, lidos: null, loading: false });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    const [fl, opts, tags, sends] = await Promise.all([
      KoblyApi.flowGraph('list', {}, orgId).catch(() => ({ flows: [] })),
      KoblyApi.getFlowOptions().catch(() => ({ emails: [] })),
      KoblyApi.getTags().catch(() => []),
      KoblyApi.bulk('list', {}, orgId).catch(() => ({ sends: [] })),
    ]);
    setData({ flows: (fl.flows || []).filter((f) => f.active_version), emails: opts.emails || [], tags: tags || [], sends: sends.sends || [], loading: false, error: sends.error || null });
  }, [orgId]);
  useEffect(() => { load(); }, [load]);

  // progresso ao vivo dos disparos em andamento
  const running = data.sends.filter((s) => s.status === 'enviando' || s.status === 'enfileirando');
  useEffect(() => {
    if (!running.length) return undefined;
    const t = setInterval(async () => { const r = await KoblyApi.bulk('list', {}, orgId).catch(() => null); if (r && r.sends) setData((d) => ({ ...d, sends: r.sends })); }, 3000);
    return () => clearInterval(t);
  }, [running.length, orgId]);

  // quantos vão receber (recalcula ao mudar o público)
  const filtro = useMemo(() => ({ ...(tagIds.length ? { tag_ids: tagIds } : {}), ...(evento ? { evento } : {}) }), [tagIds, evento]);
  useEffect(() => {
    if (!orgId) return undefined;
    setEst((e) => ({ ...e, loading: true }));
    const t = setTimeout(async () => {
      const r = await KoblyApi.bulk('estimate', { modo, origem, filtro, lista }, orgId).catch(() => ({}));
      setEst({ total: r.total ?? null, lidos: r.lidos ?? null, loading: false });
    }, 350);
    return () => clearTimeout(t);
  }, [orgId, modo, origem, filtro, lista]);

  const contentOk = modo === 'fluxo' ? !!campaignId : modo === 'email' ? !!emailId : texto.trim().length > 0;
  const ready = canEdit && contentOk && (est.total || 0) > 0;
  const fluxo = data.flows.find((f) => f.campaign_id === campaignId);
  const email = data.emails.find((e) => e.id === emailId);
  const preview = texto.replace(/\{\{\s*primeiro_nome\s*\}\}/g, 'Ana').replace(/\{\{\s*nome\s*\}\}/g, 'Ana Souza').replace(/\{\{\s*produto\s*\}\}/g, 'Curso X').replace(/\{\{\s*valor\s*\}\}/g, 'R$ 97,00');

  async function dispatch() {
    setBusy(true);
    const r = await KoblyApi.bulk('create', { modo, campaign_id: campaignId, email_id: emailId, texto, origem, filtro, lista, rate_por_min: rate, nome: nome || undefined }, orgId);
    setBusy(false); setConfirmOpen(false);
    if (r.error) { store.notify('danger', r.error); return; }
    store.notify('success', `Disparo iniciado para ${r.total} contato(s).`);
    setLista(''); setNome(''); load();
  }
  async function cancel(s) {
    const r = await KoblyApi.bulk('cancel', { id: s.id }, orgId);
    if (r.error) store.notify('danger', r.error); else { store.notify('info', 'Disparo cancelado. Quem ainda não recebeu fica de fora.'); load(); }
  }

  const totEnviados = data.sends.reduce((a, s) => a + (s.enviados || 0), 0);
  const m = MODOS.find((x) => x.id === modo);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{KB_CSS}</style>
      <div className="kb-hero">
        <div className="kb-orb"><Icon name="send" size={22} /></div>
        <div style={{ flex: 1, minWidth: 240, position: 'relative', zIndex: 1 }}>
          <div style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: 20 }}>Disparo em massa</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 2 }}>Envie um fluxo, uma mensagem ou um e-mail para muitos contatos de uma vez, no ritmo certo para não ser bloqueado.</div>
        </div>
        <div className="kb-stat"><b style={{ color: '#ff9452' }}>{running.length}</b><span>enviando agora</span></div>
        <div className="kb-stat"><b style={{ color: '#34d399' }}>{totEnviados.toLocaleString('pt-BR')}</b><span>já enviados</span></div>
        <div className="kb-stat"><b>{data.sends.length}</b><span>disparos</span></div>
      </div>
      {picker}
      {data.error && <Banner tone="danger">{data.error}</Banner>}

      {/* 1. o que enviar */}
      <div className="kb-card">
        <div className="kb-step"><i>1</i><b>O que você quer enviar?</b></div>
        <div className="kb-tiles">
          {MODOS.map((x) => (
            <button key={x.id} type="button" className={`kb-tile${modo === x.id ? ' on' : ''}`} style={{ '--c': x.color }} onClick={() => setModo(x.id)}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                {x.logo ? <ChannelLogo kind={x.logo} size={42} /> : <span className="kb-ico"><Icon name={x.icon} size={20} /></span>}
                {modo === x.id && <Icon name="circle-check" size={18} style={{ color: x.color }} />}
              </div>
              <div><div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{x.label}</div><div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>{x.desc}</div></div>
            </button>
          ))}
        </div>

        {modo === 'fluxo' && (data.flows.length ? (
          <Select label="Fluxo que vai ser disparado" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}
            options={[{ value: '', label: 'Escolha um fluxo publicado…' }, ...data.flows.map((f) => ({ value: f.campaign_id, label: f.nome }))]} />
        ) : (
          <Banner tone="info" title="Nenhum fluxo publicado ainda">Monte e publique um fluxo em <b>Fluxos</b>. Ele aparece aqui para disparar.
            <div style={{ marginTop: 8 }}><Button size="sm" variant="secondary" iconLeft="git-branch" onClick={() => store.navigate('fluxos')}>Ir para Fluxos</Button></div></Banner>
        ))}
        {modo === 'fluxo' && fluxo && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Cada contato entra no começo de <b>{fluxo.nome}</b> como se o gatilho tivesse disparado. Quem já está nesse fluxo não entra de novo.</div>}

        {modo === 'whatsapp' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <textarea className="kb-ta" rows={6} value={texto} maxLength={4096} onChange={(e) => setTexto(e.target.value)} placeholder="Escreva a mensagem…" />
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Inserir:</span>
                {VARS.map((v) => <button key={v} type="button" className="kb-chip" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setTexto((t) => `${t}${v}`)}>{v}</button>)}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 14, borderRadius: 16, background: '#0b141a', border: '1px solid rgba(255,255,255,.06)' }}>
              <span style={{ fontSize: 11, color: '#8696a0', textTransform: 'uppercase', letterSpacing: '.08em' }}>Prévia no WhatsApp</span>
              <div className="kb-bubble">{preview || ' '}<small>agora</small></div>
            </div>
          </div>
        )}

        {modo === 'email' && (data.emails.length ? (
          <>
            <Select label="E-mail que vai ser enviado" value={emailId} onChange={(e) => setEmailId(e.target.value)}
              options={[{ value: '', label: 'Escolha um e-mail…' }, ...data.emails.map((e) => ({ value: e.id, label: e.titulo || e.assunto || 'E-mail' }))]} />
            {email && <div className="kb-row" style={{ flexDirection: 'row', alignItems: 'center' }}><Icon name="mail" size={16} style={{ color: '#ffb485' }} /><span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-strong)' }}>Assunto: {email.assunto || '(sem assunto)'}</span></div>}
          </>
        ) : (
          <Banner tone="info" title="Nenhum e-mail criado ainda">Crie um e-mail no bloco <b>E-mail</b> de um fluxo ou em <b>Integrações → Modelos</b>.</Banner>
        ))}
      </div>

      {/* 2. para quem */}
      <div className="kb-card">
        <div className="kb-step"><i>2</i><b>Para quem?</b></div>
        <div className="kb-seg">
          <button type="button" className={origem === 'filtro' ? 'on' : ''} onClick={() => setOrigem('filtro')}><Icon name="users" size={14} />Meus leads</button>
          <button type="button" className={origem === 'manual' ? 'on' : ''} onClick={() => setOrigem('manual')}><Icon name="clipboard-list" size={14} />Colar uma lista</button>
        </div>
        {origem === 'filtro' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', marginBottom: 8 }}>Etiquetas (vazio = todos os leads)</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className={`kb-chip${!tagIds.length ? ' on' : ''}`} onClick={() => setTagIds([])}>Todos os leads</button>
                {data.tags.map((t) => { const on = tagIds.includes(t.id); return <button key={t.id} type="button" className={`kb-chip${on ? ' on' : ''}`} onClick={() => setTagIds(on ? tagIds.filter((x) => x !== t.id) : [...tagIds, t.id])}>{on && <Icon name="check" size={13} />}{t.nome}</button>; })}
              </div>
            </div>
            <Select label="Que tiveram este evento no checkout (opcional)" value={evento} onChange={(e) => setEvento(e.target.value)} style={{ maxWidth: 360 }}
              options={[{ value: '', label: 'Qualquer um' }, ...TIPOS_EVENTO.map((ev) => ({ value: ev, label: ev }))]} />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea className="kb-ta" rows={7} value={lista} onChange={(e) => setLista(e.target.value)}
              placeholder={'Uma pessoa por linha: nome, telefone e/ou e-mail\nAna Souza, (11) 98888-7777, ana@email.com\nCarlos, 21977776666\nbia@email.com'} />
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Pode colar do Excel ou do Google Planilhas. Quem ainda não é lead é cadastrado automaticamente. Até 5.000 linhas.</div>
          </div>
        )}
        <div className="kb-reach">
          <span className="kb-ico" style={{ '--c': '#ff9452' }}><Icon name="radar" size={20} /></span>
          <div style={{ flex: 1 }}>
            <b>{est.loading ? '…' : (est.total ?? 0).toLocaleString('pt-BR')}</b>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              contato(s) vão receber {modo === 'email' ? '(com e-mail)' : '(com telefone)'}
              {origem === 'manual' && est.lidos != null && est.lidos !== est.total ? ` · ${est.lidos - (est.total || 0)} da lista sem ${modo === 'email' ? 'e-mail' : 'telefone'}` : ''}
              {modo !== 'email' && origem === 'filtro' ? ' · quem pediu para sair do WhatsApp fica de fora' : ''}
            </div>
          </div>
        </div>
      </div>

      {/* 3. ritmo e disparo */}
      <div className="kb-card">
        <div className="kb-step"><i>3</i><b>Ritmo e disparo</b></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {RITMOS.map((r) => <button key={r.v} type="button" title={r.hint} className={`kb-chip${rate === r.v ? ' on' : ''}`} onClick={() => setRate(r.v)}>{r.label} · {r.v}/min</button>)}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>ou
            <input type="number" min={1} max={600} value={rate} onChange={(e) => setRate(Math.max(1, Math.min(600, Number(e.target.value) || 1)))} className="kb-ta" style={{ width: 90, padding: '7px 10px' }} /> por minuto</label>
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>{RITMOS.find((r) => r.v === rate)?.hint || 'Ritmo personalizado'}{est.total ? ` · vai levar uns ${dur(est.total, rate)}` : ''}</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Input label="Nome do disparo (opcional)" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Black Friday — clientes VIP" style={{ flex: 1, minWidth: 240 }} />
          <button type="button" className="kb-go" disabled={!ready || busy} onClick={() => setConfirmOpen(true)}><Icon name="rocket" size={18} />Disparar</button>
        </div>
        {!canEdit && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Seu perfil só acompanha os disparos.</div>}
      </div>

      {/* histórico */}
      <div className="kb-card">
        <div className="kb-step"><i style={{ background: 'rgba(255,255,255,.08)', boxShadow: 'none' }}><Icon name="history" size={15} /></i><b>Disparos</b></div>
        {!data.sends.length && <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{data.loading ? 'Carregando…' : 'Nenhum disparo ainda.'}</div>}
        {data.sends.map((s) => {
          const [tone, label] = STATUS[s.status] || ['off', s.status];
          const pct = (n) => `${s.total ? (n / s.total) * 100 : 0}%`;
          const mm = MODOS.find((x) => x.id === s.modo) || MODOS[1];
          return (
            <div key={s.id} className="kb-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {mm.logo ? <ChannelLogo kind={mm.logo} size={30} /> : <span className="kb-ico" style={{ '--c': mm.color, width: 30, height: 30, borderRadius: 9 }}><Icon name={mm.icon} size={15} /></span>}
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{s.nome || 'Disparo'}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{mm.label}{s.fluxo_nome ? ` · ${s.fluxo_nome}` : s.email_titulo ? ` · ${s.email_titulo}` : ''} · {s.origem === 'manual' ? 'lista colada' : 'meus leads'} · {fmtDateTime(s.created_at)}</div>
                </div>
                <span className={`kb-pill ${tone}`}><span className="d" />{label}</span>
                {(s.status === 'enviando' || s.status === 'enfileirando') && canEdit && <IconButton icon="square" size="sm" aria-label="Parar disparo" title="Parar" onClick={() => cancel(s)} />}
              </div>
              <div className="kb-bar"><span className="ok" style={{ width: pct(s.enviados) }} /><span className="sk" style={{ width: pct(s.pulados) }} /><span className="er" style={{ width: pct(s.falhados) }} /></div>
              <div style={{ display: 'flex', gap: 16, fontSize: 'var(--text-xs)', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                <span><b style={{ color: '#34d399' }}>{s.enviados}</b> enviados</span><span><b style={{ color: 'var(--text-strong)' }}>{s.total - s.enviados - s.pulados - s.falhados}</b> na fila</span>
                <span><b>{s.pulados}</b> pulados</span><span><b style={{ color: '#fb7185' }}>{s.falhados}</b> com erro</span><span>de {s.total} · {s.rate_por_min}/min</span>
              </div>
            </div>
          );
        })}
      </div>

      {confirmOpen && (
        <div className="kb-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmOpen(false); }}>
          <div className="kb-card" style={{ width: 'min(460px, 100%)' }}>
            <div className="kb-step"><i><Icon name="rocket" size={15} /></i><b>Confirmar disparo</b></div>
            <div style={{ color: 'var(--text-body)', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
              <b>{m.label}</b>{modo === 'fluxo' && fluxo ? `: ${fluxo.nome}` : modo === 'email' && email ? `: ${email.titulo || email.assunto}` : ''}<br />
              Para <b>{(est.total || 0).toLocaleString('pt-BR')}</b> contato(s), {rate} por minuto (uns {dur(est.total || 0, rate)}).<br />
              Você pode parar a qualquer momento no histórico.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>Voltar</Button>
              <button type="button" className="kb-go" disabled={busy} onClick={dispatch}><Icon name="rocket" size={17} />{busy ? 'Iniciando…' : 'Disparar agora'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { KoblyBulkSend };
