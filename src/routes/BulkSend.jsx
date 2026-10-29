import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Banner, Button, Icon, IconButton, Input, Select } from '@/ds';
import { ChannelLogo } from '@/lib/brandLogos.jsx';
import { TIPOS_EVENTO } from '@/lib/flowGraph.js';
import { fmtDateTime, useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Disparo em massa. Três passos: o que enviar (um FLUXO publicado, uma MENSAGEM de WhatsApp ou um
// E-MAIL), para quem (filtro por etiqueta/evento ou lista colada à mão) e quando (agora, uma vez num dia e hora,
// ou todo dia num período — cada dia só para os leads novos). O servidor envia um contato por vez no ritmo
// escolhido; o progresso aparece ao vivo. Abas: novo disparo, calendário do mês e a lista de disparos (pausar,
// retomar, editar e cancelar os agendados). KoblyBulkSend

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
const STATUS = { enviando: ['run', 'Enviando'], concluido: ['ok', 'Concluído'], cancelado: ['off', 'Cancelado'], falhou: ['err', 'Falhou'], enfileirando: ['run', 'Preparando'], agendado: ['sch', 'Agendado'], pausado: ['pau', 'Pausado'] };
const AGENDAS = [
  { id: 'agora', label: 'Agora', icon: 'zap' },
  { id: 'uma_vez', label: 'Uma vez', icon: 'calendar' },
  { id: 'diario', label: 'Todo dia', icon: 'repeat' },
];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return ymd(d); };
const brDay = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : '');
const brWhen = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} às ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000) + 1;
function agendaText(s) {
  if (s.agenda === 'uma_vez') return s.status === 'agendado' || s.status === 'pausado' ? `Sai em ${brWhen(s.start_at)}` : `Agendado para ${brWhen(s.start_at)}`;
  if (s.agenda === 'diario') {
    const n = daysBetween(s.start_date, s.end_date);
    return `Todo dia às ${s.send_time} · ${brDay(s.start_date)} a ${brDay(s.end_date)} · ${s.runs} de ${n} dia(s)${s.next_run_at && s.status !== 'concluido' ? ` · próximo: ${brWhen(s.next_run_at)}` : ''}`;
  }
  return null;
}
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
.kb-pill.sch { color: #60a5fa; border-color: rgba(96,165,250,.4); background: rgba(96,165,250,.1); }
.kb-pill.pau { color: #fbbf24; border-color: rgba(251,191,36,.4); background: rgba(251,191,36,.08); }
.kb-when { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.kb-in { width: 100%; box-sizing: border-box; background: rgba(255,255,255,.03); color: var(--text-strong); border: 1px solid rgba(255,255,255,.12); border-radius: 12px; padding: 10px 12px; font: inherit; font-size: 15px; outline: none; color-scheme: dark; }
.kb-in:focus { border-color: #ff9452; box-shadow: 0 0 0 3px rgba(255,98,1,.2); }
.kb-lbl { display: flex; flex-direction: column; gap: 6px; font-size: var(--text-xs); color: var(--text-muted); font-weight: 600; }
.kb-tip { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 14px; background: rgba(96,165,250,.07); border: 1px solid rgba(96,165,250,.25); font-size: var(--text-sm); color: var(--text-body); line-height: 1.5; }
.kb-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.kb-tabs button { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 12px; cursor: pointer; font-family: var(--font-sans); font-size: 14px; font-weight: 700; color: var(--text-muted); background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); }
.kb-tabs button.on { color: #fff; border-color: rgba(255,148,82,.6); background: rgba(255,98,1,.2); }
.kb-tabs .n { padding: 0 7px; border-radius: 99px; font-size: 11px; background: rgba(96,165,250,.25); color: #bfdbfe; }
.kb-cal { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; }
.kb-cal .h { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-subtle); text-align: center; padding: 4px 0; }
.kb-day { min-height: 96px; border-radius: 12px; padding: 6px; background: rgba(255,255,255,.025); border: 1px solid rgba(255,255,255,.06); display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.kb-day.out { opacity: .35; } .kb-day.today { border-color: rgba(255,148,82,.7); box-shadow: inset 0 0 0 1px rgba(255,148,82,.4); }
.kb-day .dn { font-size: 12px; font-weight: 700; color: var(--text-muted); }
.kb-day.today .dn { color: #ff9452; }
.kb-ev { display: flex; align-items: center; gap: 4px; width: 100%; border: 0; cursor: pointer; text-align: left; padding: 3px 6px; border-radius: 7px; font-family: var(--font-sans); font-size: 11px; font-weight: 600; color: #fff; background: color-mix(in srgb, var(--c) 30%, transparent); border-left: 3px solid var(--c); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kb-ev.past { opacity: .55; }
.kb-ev span { overflow: hidden; text-overflow: ellipsis; }
.kb-more { font-size: 11px; color: var(--text-subtle); padding-left: 4px; }
@media (max-width: 720px) { .kb-day { min-height: 64px; padding: 4px; } .kb-ev span { display: none; } .kb-ev { justify-content: center; padding: 3px; } }
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
  const amanha = addDays(ymd(new Date()), 1);
  const [agenda, setAgenda] = useState('agora');
  const [startAt, setStartAt] = useState(`${amanha}T09:00`);
  const [startDate, setStartDate] = useState(amanha);
  const [endDate, setEndDate] = useState(addDays(amanha, 6));
  const [sendTime, setSendTime] = useState('09:00');
  const [editId, setEditId] = useState(null);
  const [tab, setTab] = useState('novo');
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [detail, setDetail] = useState(null);

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
  const scheduled = data.sends.filter((s) => s.status === 'agendado' || s.status === 'pausado');
  useEffect(() => {
    if (!running.length && !scheduled.length) return undefined;
    const t = setInterval(async () => { const r = await KoblyApi.bulk('list', {}, orgId).catch(() => null); if (r && r.sends) setData((d) => ({ ...d, sends: r.sends })); }, running.length ? 3000 : 30000);
    return () => clearInterval(t);
  }, [running.length, scheduled.length, orgId]);

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
  const whenOk = agenda === 'agora' ? true : agenda === 'uma_vez' ? new Date(startAt) > new Date() : (startDate && endDate && endDate >= startDate && /^\d\d:\d\d$/.test(sendTime) && new Date(`${endDate}T${sendTime}`) > new Date());
  // agendado por filtro pode começar sem ninguém (os leads chegam até lá)
  const ready = canEdit && contentOk && whenOk && ((est.total || 0) > 0 || (agenda !== 'agora' && origem === 'filtro'));
  const nDias = agenda === 'diario' && startDate && endDate && endDate >= startDate ? daysBetween(startDate, endDate) : 0;
  const quandoTxt = agenda === 'uma_vez' ? `em ${brWhen(startAt)}` : agenda === 'diario' ? `todo dia às ${sendTime}, de ${brDay(startDate)} a ${brDay(endDate)} (${nDias} dia${nDias === 1 ? '' : 's'})` : 'agora';
  const fluxo = data.flows.find((f) => f.campaign_id === campaignId);
  const email = data.emails.find((e) => e.id === emailId);
  const preview = texto.replace(/\{\{\s*primeiro_nome\s*\}\}/g, 'Ana').replace(/\{\{\s*nome\s*\}\}/g, 'Ana Souza').replace(/\{\{\s*produto\s*\}\}/g, 'Curso X').replace(/\{\{\s*valor\s*\}\}/g, 'R$ 97,00');

  const whenBody = () => (agenda === 'uma_vez' ? { agenda, start_at: startAt } : agenda === 'diario' ? { agenda, start_date: startDate, end_date: endDate, send_time: sendTime } : { agenda });
  function resetForm() { setLista(''); setNome(''); setEditId(null); setAgenda('agora'); }
  async function dispatch() {
    setBusy(true);
    const payload = { modo, campaign_id: campaignId, email_id: emailId, texto, origem, filtro, lista, rate_por_min: rate, nome: nome || undefined, ...whenBody() };
    const r = editId ? await KoblyApi.bulk('update', { id: editId, ...payload }, orgId) : await KoblyApi.bulk('create', payload, orgId);
    setBusy(false); setConfirmOpen(false);
    if (r.error) { store.notify('danger', r.error); return; }
    if (editId) store.notify('success', 'Disparo agendado atualizado.');
    else if (agenda === 'agora') store.notify('success', `Disparo iniciado para ${r.total} contato(s).`);
    else store.notify('success', `Disparo agendado: ${quandoTxt}.`);
    const toAgenda = agenda !== 'agora';
    resetForm(); load();
    if (toAgenda) setTab('agenda');
  }
  async function act(s, action, msg) {
    const r = await KoblyApi.bulk(action, { id: s.id }, orgId);
    if (r.error) store.notify('danger', r.error); else { store.notify('info', msg); setDetail(null); load(); }
  }
  const cancel = (s) => act(s, 'cancel', s.status === 'agendado' || s.status === 'pausado' ? 'Agendamento cancelado.' : 'Disparo cancelado. Quem ainda não recebeu fica de fora.');
  function edit(s) {
    setEditId(s.id); setModo(s.modo); setNome(s.nome || ''); setRate(s.rate_por_min || 15);
    if (s.modo === 'fluxo') setCampaignId(s.campaign_id || ''); if (s.modo === 'email') setEmailId(s.email_id || ''); if (s.modo === 'whatsapp') setTexto(s.texto || '');
    setOrigem(s.origem); setTagIds((s.filtro && s.filtro.tag_ids) || []); setEvento((s.filtro && s.filtro.evento) || '');
    setAgenda(s.agenda);
    if (s.agenda === 'uma_vez') setStartAt(s.start_local);
    if (s.agenda === 'diario') { setStartDate(s.start_date); setEndDate(s.end_date); setSendTime(s.send_time); }
    setDetail(null); setTab('novo'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function Actions({ s }) {
    if (!canEdit) return null;
    return (
      <div style={{ display: 'flex', gap: 4 }}>
        {(s.status === 'agendado' || s.status === 'enviando') && <IconButton icon="pause" size="sm" aria-label="Pausar" title="Pausar" onClick={() => act(s, 'pause', 'Disparo pausado.')} />}
        {s.status === 'pausado' && <IconButton icon="play" size="sm" aria-label="Retomar" title="Retomar" onClick={() => act(s, 'resume', 'Disparo retomado.')} />}
        {(s.status === 'agendado' || s.status === 'pausado') && s.agenda !== 'agora' && <IconButton icon="pencil" size="sm" aria-label="Editar" title="Editar" onClick={() => edit(s)} />}
        {['enviando', 'enfileirando', 'agendado', 'pausado'].includes(s.status) && <IconButton icon="x" size="sm" aria-label="Cancelar disparo" title="Cancelar" onClick={() => cancel(s)} />}
      </div>
    );
  }

  // calendário: cada disparo vira um ou vários eventos (um por dia no diário)
  const events = useMemo(() => {
    const out = {};
    const add = (day, ev) => { (out[day] = out[day] || []).push(ev); };
    const hoje = ymd(new Date());
    for (const s of data.sends) {
      if (s.status === 'cancelado') continue;
      const mm = MODOS.find((x) => x.id === s.modo) || MODOS[1];
      if (s.agenda === 'diario' && s.start_date && s.end_date) {
        const n = Math.min(400, daysBetween(s.start_date, s.end_date));
        for (let i = 0; i < n; i++) { const d = addDays(s.start_date, i); add(d, { s, hora: s.send_time, color: mm.color, past: d < hoje || i < s.runs }); }
      } else if (s.agenda === 'uma_vez' && s.start_at) {
        const d = new Date(s.start_at); add(ymd(d), { s, hora: `${pad(d.getHours())}:${pad(d.getMinutes())}`, color: mm.color, past: !['agendado', 'pausado'].includes(s.status) });
      } else if (s.created_at) {
        const d = new Date(s.created_at); add(ymd(d), { s, hora: `${pad(d.getHours())}:${pad(d.getMinutes())}`, color: mm.color, past: true });
      }
    }
    for (const k of Object.keys(out)) out[k].sort((a, b) => a.hora.localeCompare(b.hora));
    return out;
  }, [data.sends]);
  const calDays = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }, [month]);

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
        <div className="kb-stat"><b style={{ color: '#60a5fa' }}>{scheduled.length}</b><span>agendados</span></div>
        <div className="kb-stat"><b style={{ color: '#34d399' }}>{totEnviados.toLocaleString('pt-BR')}</b><span>já enviados</span></div>
        <div className="kb-stat"><b>{data.sends.length}</b><span>disparos</span></div>
      </div>
      {picker}
      {data.error && <Banner tone="danger">{data.error}</Banner>}
      <div className="kb-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'novo'} className={tab === 'novo' ? 'on' : ''} onClick={() => setTab('novo')}><Icon name={editId ? 'pencil' : 'plus'} size={16} />{editId ? 'Editando disparo' : 'Novo disparo'}</button>
        <button type="button" role="tab" aria-selected={tab === 'agenda'} className={tab === 'agenda' ? 'on' : ''} onClick={() => setTab('agenda')}><Icon name="calendar" size={16} />Calendário{scheduled.length > 0 && <span className="n">{scheduled.length}</span>}</button>
        <button type="button" role="tab" aria-selected={tab === 'lista'} className={tab === 'lista' ? 'on' : ''} onClick={() => setTab('lista')}><Icon name="history" size={16} />Disparos</button>
      </div>

      {tab === 'novo' && editId && <Banner tone="info" title="Você está editando um disparo agendado">Mude o que precisar e clique em <b>Salvar alterações</b>. <button type="button" onClick={resetForm} style={{ background: 'none', border: 0, color: '#ff9452', cursor: 'pointer', fontWeight: 700, padding: 0, fontFamily: 'inherit' }}>Desistir da edição</button></Banner>}

      {tab === 'novo' && <>
      {/* 1. o que enviar */}
      <div className="kb-card">
        <div className="kb-step"><i>1</i><b>O que você quer enviar?</b></div>
        <div className="kb-tiles">
          {MODOS.map((x) => (
            <button key={x.id} type="button" className={`kb-tile${modo === x.id ? ' on' : ''}`} style={{ '--c': x.color }} disabled={!!editId && modo !== x.id} onClick={() => setModo(x.id)}>
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
        {!editId && <div className="kb-seg">
          <button type="button" className={origem === 'filtro' ? 'on' : ''} onClick={() => setOrigem('filtro')}><Icon name="users" size={14} />Meus leads</button>
          <button type="button" className={origem === 'manual' ? 'on' : ''} onClick={() => { setOrigem('manual'); if (agenda === 'diario') setAgenda('uma_vez'); }}><Icon name="clipboard-list" size={14} />Colar uma lista</button>
        </div>}
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
        ) : editId ? (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Lista colada: os contatos continuam os mesmos.</div>
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
              {agenda !== 'agora' && origem === 'filtro' ? ' · esse é o número de hoje: quem entrar no público até o horário também recebe' : ''}
            </div>
          </div>
        </div>
      </div>

      {/* 3. quando */}
      <div className="kb-card">
        <div className="kb-step"><i>3</i><b>Quando?</b></div>
        <div className="kb-seg">
          {AGENDAS.filter((a) => !editId || a.id !== 'agora').map((a) => (
            <button key={a.id} type="button" className={agenda === a.id ? 'on' : ''} disabled={a.id === 'diario' && origem === 'manual'} title={a.id === 'diario' && origem === 'manual' ? 'Todo dia funciona com “Meus leads”' : undefined} onClick={() => setAgenda(a.id)}><Icon name={a.icon} size={14} />{a.label}</button>
          ))}
        </div>
        {agenda === 'uma_vez' && (
          <div className="kb-when">
            <label className="kb-lbl">Dia e hora<input type="datetime-local" className="kb-in" value={startAt} min={`${ymd(new Date())}T00:00`} onChange={(e) => setStartAt(e.target.value)} /></label>
          </div>
        )}
        {agenda === 'diario' && (
          <div className="kb-when">
            <label className="kb-lbl">Primeiro dia<input type="date" className="kb-in" value={startDate} min={ymd(new Date())} onChange={(e) => { setStartDate(e.target.value); if (endDate < e.target.value) setEndDate(e.target.value); }} /></label>
            <label className="kb-lbl">Último dia<input type="date" className="kb-in" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} /></label>
            <label className="kb-lbl">Horário<input type="time" className="kb-in" value={sendTime} onChange={(e) => setSendTime(e.target.value)} /></label>
          </div>
        )}
        {agenda === 'diario' && <div className="kb-tip"><Icon name="repeat" size={18} style={{ color: '#60a5fa', flex: 'none', marginTop: 2 }} /><span>Vai sair <b>todo dia às {sendTime}</b>, de <b>{brDay(startDate)}</b> a <b>{brDay(endDate)}</b> ({nDias} dia{nDias === 1 ? '' : 's'}). No primeiro dia vai para todo o público; nos outros, <b>só para os leads novos</b> que entraram desde o último envio. Ninguém recebe duas vezes.</span></div>}
        {agenda === 'uma_vez' && <div className="kb-tip"><Icon name="calendar" size={18} style={{ color: '#60a5fa', flex: 'none', marginTop: 2 }} /><span>Vai sair sozinho <b>{quandoTxt}</b> (horário de Brasília).{origem === 'filtro' ? ' O público é montado na hora: quem entrar até lá também recebe.' : ''} Dá para pausar, editar ou cancelar até lá.</span></div>}
        {agenda !== 'agora' && !whenOk && <div style={{ fontSize: 'var(--text-xs)', color: '#fb7185' }}>Escolha um horário no futuro.</div>}
      </div>

      {/* 4. ritmo e disparo */}
      <div className="kb-card">
        <div className="kb-step"><i>4</i><b>Ritmo e disparo</b></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {RITMOS.map((r) => <button key={r.v} type="button" title={r.hint} className={`kb-chip${rate === r.v ? ' on' : ''}`} onClick={() => setRate(r.v)}>{r.label} · {r.v}/min</button>)}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>ou
            <input type="number" min={1} max={600} value={rate} onChange={(e) => setRate(Math.max(1, Math.min(600, Number(e.target.value) || 1)))} className="kb-ta" style={{ width: 90, padding: '7px 10px' }} /> por minuto</label>
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>{RITMOS.find((r) => r.v === rate)?.hint || 'Ritmo personalizado'}{est.total ? ` · vai levar uns ${dur(est.total, rate)}` : ''}</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Input label="Nome do disparo (opcional)" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Black Friday — clientes VIP" style={{ flex: 1, minWidth: 240 }} />
          <button type="button" className="kb-go" disabled={!ready || busy} onClick={() => setConfirmOpen(true)}><Icon name={editId ? 'check' : agenda === 'agora' ? 'rocket' : 'calendar'} size={18} />{editId ? 'Salvar alterações' : agenda === 'agora' ? 'Disparar' : 'Agendar'}</button>
        </div>
        {!canEdit && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Seu perfil só acompanha os disparos.</div>}
      </div>
      </>}

      {/* calendário */}
      {tab === 'agenda' && (
        <div className="kb-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div className="kb-step" style={{ flex: 1, minWidth: 200 }}><i style={{ background: 'linear-gradient(135deg, #60a5fa, #2563eb)' }}><Icon name="calendar" size={15} /></i><b>{MESES[month.getMonth()][0].toUpperCase() + MESES[month.getMonth()].slice(1)} de {month.getFullYear()}</b></div>
            <IconButton icon="chevron-left" size="sm" aria-label="Mês anterior" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} />
            <Button size="sm" variant="ghost" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Hoje</Button>
            <IconButton icon="chevron-right" size="sm" aria-label="Próximo mês" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} />
            {canEdit && <Button size="sm" variant="primary" iconLeft="plus" onClick={() => { resetForm(); setAgenda('uma_vez'); setTab('novo'); }}>Agendar disparo</Button>}
          </div>
          <div className="kb-cal">
            {SEMANA.map((d) => <div key={d} className="h">{d}</div>)}
            {calDays.map((d) => {
              const k = ymd(d); const evs = events[k] || [];
              return (
                <div key={k} className={`kb-day${d.getMonth() !== month.getMonth() ? ' out' : ''}${k === ymd(new Date()) ? ' today' : ''}`}>
                  <span className="dn">{d.getDate()}</span>
                  {evs.slice(0, 3).map((ev, i) => (
                    <button key={i} type="button" className={`kb-ev${ev.past ? ' past' : ''}`} style={{ '--c': ev.color }} title={`${ev.hora} · ${ev.s.nome || 'Disparo'}`} onClick={() => setDetail(ev.s)}>
                      <b>{ev.hora}</b><span>{ev.s.nome || 'Disparo'}</span>
                    </button>
                  ))}
                  {evs.length > 3 && <span className="kb-more">+{evs.length - 3}</span>}
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {MODOS.map((x) => <span key={x.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: x.color }} />{x.label}</span>)}
            <span>Mais apagado = já saiu</span>
          </div>
        </div>
      )}

      {/* lista de disparos */}
      {(tab === 'lista' || tab === 'agenda') && (
      <div className="kb-card">
        <div className="kb-step"><i style={{ background: 'rgba(255,255,255,.08)', boxShadow: 'none' }}><Icon name={tab === 'agenda' ? 'calendar-clock' : 'history'} size={15} /></i><b>{tab === 'agenda' ? 'Próximos disparos' : 'Disparos'}</b></div>
        {!(tab === 'agenda' ? scheduled : data.sends).length && <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{data.loading ? 'Carregando…' : tab === 'agenda' ? 'Nada agendado. Crie um disparo e escolha "Uma vez" ou "Todo dia".' : 'Nenhum disparo ainda.'}</div>}
        {(tab === 'agenda' ? scheduled : data.sends).map((s) => {
          const [tone, label] = STATUS[s.status] || ['off', s.status];
          const pct = (n) => `${s.total ? (n / s.total) * 100 : 0}%`;
          const mm = MODOS.find((x) => x.id === s.modo) || MODOS[1];
          return (
            <div key={s.id} className="kb-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {mm.logo ? <ChannelLogo kind={mm.logo} size={30} /> : <span className="kb-ico" style={{ '--c': mm.color, width: 30, height: 30, borderRadius: 9 }}><Icon name={mm.icon} size={15} /></span>}
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{s.nome || 'Disparo'}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{mm.label}{s.fluxo_nome ? ` · ${s.fluxo_nome}` : s.email_titulo ? ` · ${s.email_titulo}` : ''} · {s.origem === 'manual' ? 'lista colada' : 'meus leads'} · {s.agenda && s.agenda !== 'agora' ? `criado em ${fmtDateTime(s.created_at)}` : fmtDateTime(s.created_at)}</div>
                  {agendaText(s) && <div style={{ fontSize: 'var(--text-xs)', color: '#93c5fd', marginTop: 3, display: 'flex', alignItems: 'center', gap: 5 }}><Icon name={s.agenda === 'diario' ? 'repeat' : 'calendar'} size={12} />{agendaText(s)}</div>}
                </div>
                <span className={`kb-pill ${tone}`}><span className="d" />{label}</span>
                <Actions s={s} />
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
      )}

      {detail && (
        <div className="kb-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) setDetail(null); }}>
          <div className="kb-card" style={{ width: 'min(460px, 100%)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="kb-step" style={{ flex: 1 }}><i><Icon name={detail.agenda === 'diario' ? 'repeat' : 'send'} size={15} /></i><b>{detail.nome || 'Disparo'}</b></div>
              <IconButton icon="x" size="sm" aria-label="Fechar" onClick={() => setDetail(null)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-body)', lineHeight: 1.5 }}>
              <div><span className={`kb-pill ${(STATUS[detail.status] || ['off'])[0]}`}><span className="d" />{(STATUS[detail.status] || [0, detail.status])[1]}</span></div>
              <div><b>{(MODOS.find((x) => x.id === detail.modo) || MODOS[1]).label}</b>{detail.fluxo_nome ? `: ${detail.fluxo_nome}` : detail.email_titulo ? `: ${detail.email_titulo}` : ''}</div>
              {detail.modo === 'whatsapp' && detail.texto && <div className="kb-bubble">{detail.texto}<small>prévia</small></div>}
              {agendaText(detail) && <div style={{ color: '#93c5fd' }}>{agendaText(detail)}</div>}
              <div style={{ color: 'var(--text-muted)' }}>{detail.enviados} enviados de {detail.total} · {detail.rate_por_min}/min · {detail.origem === 'manual' ? 'lista colada' : 'meus leads'}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              {canEdit && (detail.status === 'agendado' || detail.status === 'enviando') && <Button variant="secondary" iconLeft="pause" onClick={() => act(detail, 'pause', 'Disparo pausado.')}>Pausar</Button>}
              {canEdit && detail.status === 'pausado' && <Button variant="secondary" iconLeft="play" onClick={() => act(detail, 'resume', 'Disparo retomado.')}>Retomar</Button>}
              {canEdit && ['agendado', 'pausado'].includes(detail.status) && detail.agenda !== 'agora' && <Button variant="secondary" iconLeft="pencil" onClick={() => edit(detail)}>Editar</Button>}
              {canEdit && ['enviando', 'agendado', 'pausado'].includes(detail.status) && <Button variant="danger" iconLeft="x" onClick={() => cancel(detail)}>Cancelar</Button>}
            </div>
          </div>
        </div>
      )}

      {confirmOpen && (
        <div className="kb-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmOpen(false); }}>
          <div className="kb-card" style={{ width: 'min(460px, 100%)' }}>
            <div className="kb-step"><i><Icon name={agenda === 'agora' ? 'rocket' : 'calendar'} size={15} /></i><b>{editId ? 'Salvar alterações' : agenda === 'agora' ? 'Confirmar disparo' : 'Confirmar agendamento'}</b></div>
            <div style={{ color: 'var(--text-body)', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
              <b>{m.label}</b>{modo === 'fluxo' && fluxo ? `: ${fluxo.nome}` : modo === 'email' && email ? `: ${email.titulo || email.assunto}` : ''}<br />
              {agenda === 'agora'
                ? <>Para <b>{(est.total || 0).toLocaleString('pt-BR')}</b> contato(s), {rate} por minuto (uns {dur(est.total || 0, rate)}).<br /></>
                : <>Sai <b>{quandoTxt}</b>, {rate} por minuto.{origem === 'filtro' ? <> Hoje o público tem <b>{(est.total || 0).toLocaleString('pt-BR')}</b> contato(s).</> : <> Para <b>{(est.total || 0).toLocaleString('pt-BR')}</b> contato(s).</>}<br /></>}
              Você pode pausar ou cancelar a qualquer momento em Disparos.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>Voltar</Button>
              <button type="button" className="kb-go" disabled={busy} onClick={dispatch}><Icon name={agenda === 'agora' ? 'rocket' : 'calendar'} size={17} />{busy ? 'Salvando…' : editId ? 'Salvar' : agenda === 'agora' ? 'Disparar agora' : 'Agendar'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { KoblyBulkSend };
