import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Banner, Button, Icon, IconButton, Input } from '@/ds';
import { ChannelLogo } from '@/lib/brandLogos.jsx';
import { Drawer, Modal } from '@/lib/ui.jsx';
import { fmtDateTime } from '@/lib/workspace.jsx';
import { WhatsappMetaTab } from '@/routes/WhatsappMeta.jsx';
import { useKobly } from '@/store/store.jsx';
import { askConfirm } from '@/lib/confirm.jsx';

// Kobly — Integrações → Conexões. Todos os canais da conta num lugar: WhatsApp comum (QR Code, pela Uazapi),
// API oficial da Meta, Instagram Direct e Messenger (página do Facebook, login com um clique) e bots do Telegram (alertas da equipe).
// "Nova conexão" escolhe o tipo; o QR Code atualiza sozinho até o número conectar. KoblyConnections

const KINDS = [
  { id: 'qr', label: 'WhatsApp', color: '#25D366', desc: 'Conecte lendo um QR Code. Funciona com qualquer número, comum ou Business.' },
  { id: 'oficial', label: 'WhatsApp API Oficial', color: '#1D9BF0', desc: 'Número verificado pela Meta, modelos aprovados e sem risco de bloqueio.' },
  { id: 'telegram', label: 'Telegram', color: '#2AABEE', desc: 'Bot que avisa sua equipe: venda aprovada, erro de pagamento, lead pedindo humano.' },
  { id: 'instagram', label: 'Instagram', color: '#E1306C', desc: 'Direct do Instagram no Chat ao vivo, com fluxos e IA.' },
  { id: 'messenger', label: 'Messenger', color: '#A033FF', desc: 'Mensagens da página do Facebook no Chat ao vivo.' },
];
const FILTERS = [['todos', 'Todos os canais'], ['qr', 'WhatsApp'], ['oficial', 'WhatsApp Oficial'], ['instagram', 'Instagram'], ['messenger', 'Messenger'], ['telegram', 'Telegram']];
const STATUS = { connected: ['ok', 'Conectado'], connecting: ['wait', 'Aguardando QR Code'], disconnected: ['off', 'Desconectado'], hibernated: ['idle', 'Em espera'] };
const qrSrc = (q) => (!q ? null : /^data:image\//.test(q) ? q : /^https?:\/\//.test(q) ? q : `data:image/png;base64,${q}`);
// 5547997883654 → +55 (47) 99788-3654 · 554797886227 → +55 (47) 9788-6227
export function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) { const r = d.slice(4); return `+55 (${d.slice(2, 4)}) ${r.slice(0, r.length - 4)}-${r.slice(-4)}`; }
  return `+${d}`;
}
const ago = (iso) => {
  if (!iso) return null;
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'agora';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return fmtDateTime(iso);
};
// Foto do perfil: o WhatsApp pede JPEG 640×640 — recorta o centro e converte no navegador
function toJpeg640(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) { reject(new Error('Escolha uma imagem (JPG, PNG ou WEBP).')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const c = document.createElement('canvas'); c.width = 640; c.height = 640;
      c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 640, 640);
      URL.revokeObjectURL(url);
      let q = 0.9, out = c.toDataURL('image/jpeg', q);
      while (out.length > 1_400_000 && q > 0.4) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não deu para ler essa imagem.')); };
    img.src = url;
  });
}
const initials = (s) => String(s || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

const KC_CSS = `
.kc-hero { position: relative; overflow: hidden; border-radius: 20px; padding: 20px 22px; display: flex; gap: 18px; align-items: center; flex-wrap: wrap;
  background: radial-gradient(700px 260px at 0% 0%, rgba(37,211,102,.16), transparent 60%), radial-gradient(600px 260px at 100% 100%, rgba(255,98,1,.18), transparent 60%), rgba(14,16,24,.92);
  border: 1px solid rgba(255,255,255,.08); box-shadow: 0 18px 50px rgba(0,0,0,.45); }
.kc-hero::after { content: ''; position: absolute; left: -30%; top: 0; width: 30%; height: 100%; background: linear-gradient(90deg, transparent, rgba(255,255,255,.06), transparent); animation: kc-sweep 5s linear infinite; pointer-events: none; }
@keyframes kc-sweep { to { left: 130%; } }
.kc-stat { min-width: 110px; padding: 10px 14px; border-radius: 14px; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07); }
.kc-stat b { display: block; font-size: 22px; color: var(--text-strong); line-height: 1.1; }
.kc-stat span { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .08em; }
.kc-chip { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px 6px 7px; border-radius: 999px; cursor: pointer; font-size: var(--text-sm); font-family: var(--font-sans);
  color: var(--text-muted); background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); transition: all .15s; }
.kc-chip:hover { color: var(--text-strong); border-color: rgba(255,255,255,.18); }
.kc-chip.on { color: #fff; background: linear-gradient(135deg, rgba(37,211,102,.22), rgba(255,98,1,.3)); border-color: transparent; box-shadow: inset 0 0 0 1px rgba(255,148,82,.55), 0 0 18px rgba(255,98,1,.25); }
.kc-chip .all { width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center; background: linear-gradient(135deg, #f39200, #ff6201); color: #fff; }
.kc-card { position: relative; border-radius: 20px; padding: 18px; display: flex; flex-direction: column; gap: 14px; overflow: hidden;
  background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.012)), rgba(15,17,26,.94); border: 1px solid rgba(255,255,255,.08);
  box-shadow: 0 14px 40px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.05); transition: border-color .2s, box-shadow .2s, transform .2s; }
.kc-card::before { content: ''; position: absolute; left: 18px; right: 18px; top: -1px; height: 2px; border-radius: 2px; background: linear-gradient(90deg, transparent, var(--brand), transparent); }
.kc-card::after { content: ''; position: absolute; right: -60px; top: -60px; width: 180px; height: 180px; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--brand) 22%, transparent), transparent 70%); pointer-events: none; }
.kc-card:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--brand) 40%, rgba(255,255,255,.1)); box-shadow: 0 18px 46px rgba(0,0,0,.5), 0 0 30px color-mix(in srgb, var(--brand) 16%, transparent); }
.kc-avatar { position: relative; width: 58px; height: 58px; flex: none; }
.kc-avatar .pic { width: 58px; height: 58px; border-radius: 50%; object-fit: cover; display: grid; place-items: center; font-weight: 700; font-size: 18px; color: #fff;
  background: linear-gradient(135deg, color-mix(in srgb, var(--brand) 55%, #111), #1b1f2c); box-shadow: 0 0 0 2px #0d1018, 0 0 0 4px var(--ring), 0 0 22px color-mix(in srgb, var(--ring) 45%, transparent); }
.kc-avatar .badge { position: absolute; right: -5px; bottom: -4px; border-radius: 9px; box-shadow: 0 0 0 3px #0d1018; overflow: hidden; }
.kc-pill { display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid; }
.kc-pill .d { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.kc-pill.ok { color: #34d399; border-color: rgba(52,211,153,.35); background: rgba(52,211,153,.08); }
.kc-pill.ok .d { animation: kc-pulse 1.8s infinite; }
.kc-pill.wait { color: #fbbf24; border-color: rgba(251,191,36,.35); background: rgba(251,191,36,.08); }
.kc-pill.wait .d { animation: kc-blink 1s infinite; }
.kc-pill.off { color: #fb7185; border-color: rgba(251,113,133,.35); background: rgba(251,113,133,.08); }
.kc-pill.idle { color: #94a3b8; border-color: rgba(148,163,184,.3); background: rgba(148,163,184,.06); }
@keyframes kc-pulse { 0% { box-shadow: 0 0 0 0 rgba(52,211,153,.6); } 70% { box-shadow: 0 0 0 8px rgba(52,211,153,0); } 100% { box-shadow: 0 0 0 0 rgba(52,211,153,0); } }
@keyframes kc-blink { 50% { opacity: .3; } }
.kc-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.kc-meta div { padding: 9px 11px; border-radius: 12px; background: rgba(255,255,255,.025); border: 1px solid rgba(255,255,255,.06); }
.kc-meta span { display: block; font-size: 10.5px; color: var(--text-subtle); text-transform: uppercase; letter-spacing: .07em; }
.kc-meta b { display: block; font-size: 13px; color: var(--text-strong); margin-top: 2px; font-weight: 600; }
.kc-link { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; border-radius: 12px; cursor: pointer; font-family: var(--font-sans); font-size: var(--text-sm); color: var(--text-body); text-align: left;
  background: linear-gradient(135deg, rgba(243,146,0,.07), rgba(255,98,1,.09)); border: 1px solid rgba(255,148,82,.22); transition: border-color .15s, box-shadow .15s; }
.kc-link:hover { border-color: rgba(255,148,82,.55); box-shadow: 0 0 18px rgba(255,98,1,.2); }
.kc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 8px 12px; border-radius: 11px; cursor: pointer; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: 600;
  color: var(--text-strong); background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1); transition: all .15s; }
.kc-btn:hover { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.2); }
.kc-btn.primary { color: #fff; border-color: transparent; background: linear-gradient(135deg, #25D366, #128C7E); box-shadow: 0 0 18px rgba(37,211,102,.3); }
.kc-btn.danger { color: #fda4af; border-color: rgba(251,113,133,.3); background: rgba(251,113,133,.06); }
.kc-btn.danger:hover { background: rgba(251,113,133,.14); }
.kc-tile { position: relative; display: flex; flex-direction: column; gap: 12px; padding: 18px; border-radius: 18px; text-align: left; font-family: var(--font-sans); cursor: pointer; overflow: hidden;
  background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.012)), rgba(15,17,26,.96); border: 1px solid rgba(255,255,255,.08); transition: all .18s; }
.kc-tile:not(.soon):hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--brand) 55%, transparent); box-shadow: 0 0 28px color-mix(in srgb, var(--brand) 25%, transparent); }
.kc-tile.soon { cursor: default; opacity: .55; }
.kc-qr { position: relative; width: 272px; height: 272px; padding: 14px; border-radius: 22px; background: #fff; box-shadow: 0 0 0 1px rgba(37,211,102,.4), 0 0 40px rgba(37,211,102,.25); }
.kc-qr .corner { position: absolute; width: 34px; height: 34px; border: 3px solid #25D366; }
.kc-qr .scan { position: absolute; left: 14px; right: 14px; height: 2px; top: 14px; background: linear-gradient(90deg, transparent, #25D366, transparent); box-shadow: 0 0 12px #25D366; animation: kc-scan 2.4s ease-in-out infinite; }
@keyframes kc-scan { 50% { top: calc(100% - 16px); } }
.kc-step { display: flex; gap: 10px; align-items: flex-start; font-size: var(--text-sm); color: var(--text-body); }
.kc-step i { font-style: normal; flex: none; width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center; font-size: 12px; font-weight: 700; color: #fff; background: linear-gradient(135deg, #25D366, #128C7E); }
.kc-toggle { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; cursor: pointer; background: rgba(255,255,255,.025); border: 1px solid rgba(255,255,255,.06); font-size: var(--text-sm); color: var(--text-body); }
.kc-switch { position: relative; width: 40px; height: 22px; flex: none; border-radius: 999px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.08); cursor: pointer; padding: 0; transition: all .2s; }
.kc-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #cbd5e1; transition: all .2s cubic-bezier(.3,1.4,.5,1); }
.kc-switch.on { border-color: transparent; background: linear-gradient(135deg, #f39200, #ff6201); box-shadow: 0 0 14px rgba(255,98,1,.45); }
.kc-switch.on::after { left: 20px; background: #fff; }
.kc-tabs { display: flex; padding: 4px; gap: 4px; border-radius: 13px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); }
.kc-tabs button { flex: 1; border: 0; padding: 9px 12px; border-radius: 10px; background: transparent; color: var(--text-muted); cursor: pointer; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: 600; display: inline-flex; gap: 7px; align-items: center; justify-content: center; }
.kc-tabs button.on { color: #fff; background: linear-gradient(135deg, rgba(37,211,102,.28), rgba(255,98,1,.36)); box-shadow: inset 0 0 0 1px rgba(255,148,82,.5); }
.kc-photo { display: flex; align-items: center; gap: 16px; padding: 16px; border-radius: 16px; cursor: pointer; border: 1.5px dashed rgba(37,211,102,.4); background: radial-gradient(circle at 0% 50%, rgba(37,211,102,.1), transparent 60%), rgba(255,255,255,.02); transition: all .15s; }
.kc-photo:hover, .kc-photo.over { border-color: #25D366; box-shadow: 0 0 22px rgba(37,211,102,.22); }
.kc-photo img, .kc-photo .ph { width: 84px; height: 84px; border-radius: 50%; object-fit: cover; flex: none; display: grid; place-items: center; background: #1b1f2c; color: #fff; font-weight: 800; font-size: 24px; box-shadow: 0 0 0 3px #0d1018, 0 0 0 5px #25D366; }
.kc-done { position: relative; display: grid; place-items: center; width: 150px; height: 150px; margin: 6px auto 0; }
.kc-done .ring { position: absolute; inset: 0; border-radius: 50%; border: 2px solid rgba(37,211,102,.5); animation: kc-ring 2.2s ease-out infinite; }
.kc-done .ring:nth-child(2) { animation-delay: .7s; } .kc-done .ring:nth-child(3) { animation-delay: 1.4s; }
@keyframes kc-ring { from { transform: scale(.55); opacity: 1; } to { transform: scale(1.15); opacity: 0; } }
.kc-done .core { position: relative; width: 92px; height: 92px; border-radius: 50%; display: grid; place-items: center; overflow: hidden;
  background: linear-gradient(135deg, #25D366, #128C7E); box-shadow: 0 0 0 4px #0d1018, 0 0 0 6px #25D366, 0 0 40px rgba(37,211,102,.55); animation: kc-pop .5s cubic-bezier(.2,1.4,.4,1); }
.kc-done .tick { position: absolute; right: 22px; bottom: 22px; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; background: #34d399; color: #04130b; box-shadow: 0 0 0 3px #0d1018; animation: kc-pop .6s .25s both cubic-bezier(.2,1.4,.4,1); }
@keyframes kc-pop { from { transform: scale(.3); opacity: 0; } }
`;

// QR Code da Uazapi: consulta o status a cada 3 s (o QR muda sozinho) até conectar
function QrPanel({ id, empresaId, initialQr, onConnected, notify, flowsActive, onClose }) {
  const store = useKobly();
  const [st, setSt] = useState({ status: 'connecting', qrcode: initialQr || null });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let done = false;
    const tick = async () => {
      if (done) return;
      const r = await KoblyApi.uazapi('status', { id }, empresaId);
      if (!alive.current) return;
      if (r.error) { setSt((s) => ({ ...s, error: r.error })); return; }
      setSt({ status: r.status, qrcode: r.qrcode || null, phone: r.phone, name: r.profile_name, pic: r.profile_pic_url, business: r.is_business });
      if (r.status === 'connected') { done = true; notify('success', 'WhatsApp conectado.'); onConnected(); }
    };
    const t = setInterval(tick, 3000);
    tick();
    return () => { alive.current = false; clearInterval(t); };
  }, [id, empresaId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function novoQr() {
    const r = await KoblyApi.uazapi('qrcode', { id }, empresaId);
    if (r.error) notify('danger', r.error); else setSt((s) => ({ ...s, qrcode: r.qrcode || s.qrcode }));
  }
  const go = (route) => { onClose(); store.navigate(route); };
  if (st.status === 'connected') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center' }}>
        <div className="kc-done">
          <span className="ring" /><span className="ring" /><span className="ring" />
          <div className="core">{st.pic ? <img src={st.pic} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: '#fff', fontSize: 30, fontWeight: 800 }}>{initials(st.name)}</span>}</div>
          <span className="tick"><Icon name="check" size={17} /></span>
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-strong)' }}>Conectado!</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 4 }}>
            {st.name ? <><b style={{ color: 'var(--text-strong)' }}>{st.name}</b>{st.business ? ' · WhatsApp Business' : ''} · </> : null}{fmtPhone(st.phone)}
          </div>
        </div>
        <div style={{ width: '100%', padding: '12px 14px', borderRadius: 14, background: 'rgba(52,211,153,.07)', border: '1px solid rgba(52,211,153,.25)', color: 'var(--text-body)', fontSize: 'var(--text-sm)', textAlign: 'left' }}>
          Este número já está pronto para os <b>fluxos</b> e os <b>Chats ao vivo</b>.{flowsActive ? ` ${flowsActive} fluxo${flowsActive > 1 ? 's' : ''} rodando já ${flowsActive > 1 ? 'podem' : 'pode'} usar ele.` : ' Crie um fluxo para começar a recuperar vendas.'}
        </div>
        <div style={{ display: 'flex', gap: 8, width: '100%' }}>
          <button type="button" className="kc-btn" style={{ flex: 1 }} onClick={() => go('chats')}><Icon name="message-circle" size={15} />Abrir Chats ao vivo</button>
          <button type="button" className="kc-btn primary" style={{ flex: 1 }} onClick={() => go('fluxos')}><Icon name="git-branch" size={15} />{flowsActive ? 'Ver fluxos' : 'Criar fluxo'}</button>
        </div>
      </div>
    );
  }
  const src = qrSrc(st.qrcode);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      <div className="kc-qr">
        <span className="corner" style={{ left: -6, top: -6, borderRight: 0, borderBottom: 0, borderTopLeftRadius: 14 }} />
        <span className="corner" style={{ right: -6, top: -6, borderLeft: 0, borderBottom: 0, borderTopRightRadius: 14 }} />
        <span className="corner" style={{ left: -6, bottom: -6, borderRight: 0, borderTop: 0, borderBottomLeftRadius: 14 }} />
        <span className="corner" style={{ right: -6, bottom: -6, borderLeft: 0, borderTop: 0, borderBottomRightRadius: 14 }} />
        {src ? <img src={src} alt="QR Code para conectar o WhatsApp" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} /> : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#555', fontSize: 13 }}>Gerando QR Code…</div>}
        {src && <span className="scan" />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#fbbf24', fontSize: 'var(--text-xs)' }}><span className="kc-pill wait" style={{ padding: '2px 8px' }}><span className="d" />aguardando leitura</span> esta tela confirma sozinha</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, width: '100%' }}>
        <div className="kc-step"><i>1</i><span>No celular, abra o WhatsApp → <b>Configurações</b> (ou ⋮) → <b>Aparelhos conectados</b>.</span></div>
        <div className="kc-step"><i>2</i><span>Toque em <b>Conectar um aparelho</b>.</span></div>
        <div className="kc-step"><i>3</i><span>Aponte a câmera para este QR Code.</span></div>
      </div>
      <button type="button" className="kc-btn" onClick={novoQr}><Icon name="refresh-cw" size={14} />Gerar outro QR Code</button>
      {st.error && <Banner tone="danger">{st.error}</Banner>}
    </div>
  );
}

function ConnCard({ c, flowsActive, onQr, onAct, onRename, onManage, onPause, navigate }) {
  const k = KINDS.find((x) => x.id === c.kind);
  const [tone, label] = STATUS[c.status] || STATUS.disconnected;
  const ring = { ok: '#34d399', wait: '#fbbf24', off: '#fb7185', idle: '#64748b' }[tone];
  return (
    <div className="kc-card" style={{ '--brand': k.color }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', position: 'relative', zIndex: 1 }}>
        <div className="kc-avatar" style={{ '--ring': ring }}>
          {c.pic ? <img className="pic" src={c.pic} alt="" /> : <div className="pic">{c.kind === 'telegram' ? <Icon name="bell" size={22} /> : initials(c.profile || c.name)}</div>}
          <span className="badge"><ChannelLogo kind={c.kind} size={24} /></span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 2 }}>
            <span>{c.profile || c.sub}</span>
            {c.business && <span style={{ padding: '0 6px', borderRadius: 6, background: 'rgba(37,211,102,.12)', color: '#4ade80', fontWeight: 600 }}>Business</span>}
          </div>
        </div>
        <span className={`kc-pill ${tone}`}><span className="d" />{label}</span>
      </div>

      {(c.phone || c.chat) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600, color: 'var(--text-strong)', position: 'relative', zIndex: 1 }}>
          <Icon name={c.chat ? 'hash' : 'phone'} size={15} style={{ color: k.color }} />{c.phone ? fmtPhone(c.phone) : `chat ${c.chat}`}
        </div>
      )}

      <div className="kc-meta" style={{ position: 'relative', zIndex: 1 }}>
        <div><span>{c.status === 'connected' ? 'Último sinal' : 'Situação'}</span><b>{c.status === 'connected' ? (ago(c.seen) || 'agora') : label}</b></div>
        <div><span>{c.kind === 'telegram' ? 'Criado' : 'Conectado desde'}</span><b>{c.when ? fmtDateTime(c.when) : '—'}</b></div>
      </div>
      {c.reason && c.status !== 'connected' && <div style={{ fontSize: 'var(--text-xs)', color: '#fda4af', position: 'relative', zIndex: 1 }}>Última desconexão: {c.reason}</div>}

      {['qr', 'oficial', 'instagram', 'messenger'].includes(c.kind) && (
        <button type="button" className="kc-link" style={{ position: 'relative', zIndex: 1 }} onClick={() => navigate('fluxos')}>
          <Icon name="zap" size={16} style={{ color: '#ff9452' }} />
          <span style={{ flex: 1 }}><b style={{ color: 'var(--text-strong)' }}>{flowsActive}</b> fluxo{flowsActive === 1 ? '' : 's'} rodando com {c.status === 'connected' ? 'este número' : 'os números conectados'}</span>
          <Icon name="chevron-right" size={16} style={{ color: 'var(--text-subtle)' }} />
        </button>
      )}

      {c.kind === 'qr' && c.status === 'connected' && c.history && (
        <div className="kc-toggle" style={{ position: 'relative', zIndex: 1, cursor: 'default' }}>
          <Icon name={c.history.status === 'running' ? 'loader' : c.history.status === 'error' ? 'alert-triangle' : 'messages-square'} size={16}
            style={{ color: c.history.status === 'error' ? '#fb7185' : c.history.status === 'done' ? '#34d399' : 'var(--text-subtle)' }} />
          <span style={{ flex: 1 }}>
            {c.history.status === 'running' ? `Importando conversas do WhatsApp… ${c.history.count || 0} mensagens`
              : c.history.status === 'done' ? `Conversas importadas: ${c.history.count || 0} mensagens`
                : c.history.status === 'error' ? 'Não deu para importar as conversas agora.'
                  : 'As conversas do WhatsApp vão aparecer em Conversas.'}
          </span>
          {c.history.status !== 'running' && <button type="button" className="kc-btn" onClick={() => onAct('uazapi', 'import_history', { id: c.key }, 'Importando as conversas recentes. Elas aparecem em Conversas em alguns minutos.')}><Icon name="refresh-cw" size={14} />{c.history.status ? 'Importar de novo' : 'Importar'}</button>}
        </div>
      )}

      {c.kind === 'qr' && (
        <div className="kc-toggle" style={{ position: 'relative', zIndex: 1 }} onClick={() => onPause(!c.pause)} title="Se este número cair e não houver outro WhatsApp conectado, os fluxos ativos pausam sozinhos; quando ele voltar, eles voltam a rodar.">
          <Icon name="pause-circle" size={16} style={{ color: c.pause ? '#34d399' : 'var(--text-subtle)' }} />
          <span style={{ flex: 1 }}>Pausar fluxos ao desconectar</span>
          <button type="button" role="switch" aria-checked={!!c.pause} aria-label="Pausar fluxos ao desconectar" className={`kc-switch${c.pause ? ' on' : ''}`} onClick={(e) => { e.stopPropagation(); onPause(!c.pause); }} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', position: 'relative', zIndex: 1 }}>
        {c.kind === 'qr' && c.status !== 'connected' && <button type="button" className="kc-btn primary" onClick={onQr}><Icon name="qr-code" size={15} />{c.status === 'connecting' ? 'Ler QR Code' : 'Reconectar'}</button>}
        {c.kind === 'qr' && c.status === 'connected' && <button type="button" className="kc-btn" onClick={() => onAct('uazapi', 'disconnect', { id: c.key }, 'Desconectado.', `Desconectar ${c.name}? Para voltar, será preciso ler o QR Code de novo.`)}><Icon name="unplug" size={15} />Desconectar</button>}
        {c.kind === 'qr' && <button type="button" className="kc-btn" onClick={onRename}><Icon name="pencil" size={15} />Editar</button>}
        {c.kind === 'qr' && <button type="button" className="kc-btn danger" onClick={() => onAct('uazapi', 'remove', { id: c.key }, 'Conexão excluída.', `Excluir ${c.name}? O número sai da Kobly.`)}><Icon name="trash-2" size={15} />Excluir</button>}
        {(c.kind === 'instagram' || c.kind === 'messenger') && <button type="button" className="kc-btn" onClick={() => navigate('chats')}><Icon name="message-circle" size={15} />Ver conversas</button>}
        {(c.kind === 'instagram' || c.kind === 'messenger') && <button type="button" className="kc-btn danger" onClick={() => onAct('metaChannels', 'remove', { id: c.key }, 'Canal desconectado.', `Desconectar ${c.name}? As conversas já recebidas continuam na Kobly.`)}><Icon name="unplug" size={15} />Desconectar</button>}
        {c.kind === 'oficial' && <button type="button" className="kc-btn" onClick={onManage}><Icon name="settings-2" size={15} />Gerenciar</button>}
        {c.kind === 'telegram' && <button type="button" className="kc-btn" onClick={() => onAct('notifyChannels', 'test', { id: c.key }, 'Mensagem de teste enviada no Telegram.')}><Icon name="send" size={15} />Testar</button>}
        {c.kind === 'telegram' && <button type="button" className="kc-btn danger" onClick={() => onAct('notifyChannels', 'delete', { id: c.key }, 'Bot removido.', `Remover o bot "${c.name}"?`)}><Icon name="trash-2" size={15} />Remover</button>}
      </div>
    </div>
  );
}

// Instagram Direct e Messenger: login com Facebook numa janelinha, escolha das páginas e do que conectar.
function MetaConnect({ empresaId, want, notify, onDone, onClose }) {
  const [st, setSt] = useState({ step: 'start', enabled: null, pages: [], user: null });
  const [pick, setPick] = useState([]);
  const [kinds, setKinds] = useState(() => new Set(['instagram', 'messenger']));
  const [busy, setBusy] = useState(false);
  const popup = useRef(null);
  useEffect(() => { KoblyApi.metaChannels('oauth_status', {}, empresaId).then((r) => setSt((s) => ({ ...s, enabled: !!(r && r.enabled) }))); }, [empresaId]);
  const loadPages = useCallback(async () => {
    const r = await KoblyApi.metaChannels('oauth_pages', {}, empresaId);
    if (r.error) { notify('danger', r.error); return; }
    setSt((s) => ({ ...s, step: 'pages', pages: r.pages || [], user: r.user_name }));
    setPick((r.pages || []).filter((p) => want !== 'instagram' || p.instagram).map((p) => p.id));
  }, [empresaId, notify, want]);
  useEffect(() => {
    function onMsg(e) {
      if (!e.data || e.data.kobly !== 'meta-msg' || e.source !== popup.current) return;
      setBusy(false); popup.current = null;
      if (e.data.ok) loadPages(); else notify('warning', e.data.message);
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [loadPages, notify]);
  async function login() {
    const w = window.open('', 'kobly-facebook-msg', 'width=600,height=720');
    if (!w) { notify('warning', 'O navegador bloqueou a janelinha. Libere pop-ups para a Kobly e tente de novo.'); return; }
    w.document.title = 'Conectando ao Facebook…';
    popup.current = w; setBusy(true);
    const r = await KoblyApi.metaChannels('oauth_start', {}, empresaId);
    if (r.error) { w.close(); popup.current = null; setBusy(false); notify('danger', r.error); return; }
    w.location.href = r.url;
    const t = setInterval(() => { if (w.closed) { clearInterval(t); if (popup.current === w) { popup.current = null; setBusy(false); } } }, 700);
  }
  async function connect() {
    setBusy(true);
    const r = await KoblyApi.metaChannels('connect', { page_ids: pick, kinds: [...kinds] }, empresaId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    const n = (r.channels || []).length;
    notify('success', n ? `${n} canal${n > 1 ? 'is' : ''} conectado${n > 1 ? 's' : ''}. As mensagens novas já chegam no Chat ao vivo.` : 'Nada novo para conectar.');
    onDone();
  }
  const toggle = (id) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleKind = (k) => setKinds((s) => { const n = new Set(s); if (n.has(k)) { if (n.size > 1) n.delete(k); } else n.add(k); return n; });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {st.step === 'start' && (<>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ display: 'flex' }}><ChannelLogo kind="instagram" size={46} /><span style={{ marginLeft: -10 }}><ChannelLogo kind="messenger" size={46} /></span></div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.5 }}>Entre com o Facebook que administra a página da empresa. O Instagram precisa ser <b style={{ color: 'var(--text-strong)' }}>profissional</b> e estar ligado a essa página.</div>
        </div>
        <div className="kc-step"><i>1</i><span>Clique em <b>Conectar com Facebook</b> e entre com a sua conta.</span></div>
        <div className="kc-step"><i>2</i><span>Marque a <b>página</b> e o <b>Instagram</b> da empresa e permita o acesso às mensagens.</span></div>
        <div className="kc-step"><i>3</i><span>De volta aqui, escolha o que conectar. Pronto: as conversas chegam no Chat ao vivo.</span></div>
        {st.enabled === false && <Banner tone="warning" title="Ainda não ativo neste servidor.">O administrador da Kobly precisa colocar as chaves do app do Facebook no servidor.</Banner>}
        <Button variant="primary" iconLeft={busy ? 'loader-circle' : 'facebook'} disabled={busy || st.enabled === false} onClick={login}>{busy ? 'Esperando o Facebook…' : 'Conectar com Facebook'}</Button>
      </>)}
      {st.step === 'pages' && (<>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Entrou como <b style={{ color: 'var(--text-strong)' }}>{st.user || 'você'}</b>. Escolha as páginas:</div>
        {!st.pages.length && <Banner tone="warning" title="Nenhuma página encontrada">Este Facebook não administra nenhuma página, ou você não marcou a página no login. Clique em Conectar de novo e marque a página da empresa.</Banner>}
        {st.pages.map((p) => (
          <label key={p.id} className="kc-toggle" style={{ cursor: 'pointer', alignItems: 'flex-start', border: pick.includes(p.id) ? '1px solid rgba(255,148,82,.6)' : undefined }}>
            <input type="checkbox" checked={pick.includes(p.id)} onChange={() => toggle(p.id)} style={{ accentColor: '#ff6201', width: 18, height: 18, marginTop: 4 }} />
            {p.picture ? <img src={p.picture} alt="" style={{ width: 40, height: 40, borderRadius: 10, objectFit: 'cover' }} /> : <ChannelLogo kind="messenger" size={40} />}
            <span style={{ flex: 1, minWidth: 0 }}>
              <b style={{ display: 'block', color: 'var(--text-strong)' }}>{p.name}</b>
              <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 'var(--text-xs)', marginTop: 3 }}>
                <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', color: 'var(--text-muted)' }}><ChannelLogo kind="messenger" size={16} />Messenger</span>
                {p.instagram ? <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', color: 'var(--text-muted)' }}><ChannelLogo kind="instagram" size={16} />@{p.instagram.username}</span>
                  : <span style={{ color: '#fbbf24' }}>Sem Instagram profissional ligado</span>}
              </span>
            </span>
          </label>
        ))}
        {st.pages.length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[['instagram', 'Instagram Direct'], ['messenger', 'Messenger']].map(([k, l]) => (
            <button key={k} type="button" className={`kc-chip${kinds.has(k) ? ' on' : ''}`} onClick={() => toggleKind(k)}><ChannelLogo kind={k} size={20} />{l}{kinds.has(k) && <Icon name="check" size={13} />}</button>
          ))}
        </div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={login}>Entrar com outra conta</Button>
          <Button variant="primary" iconLeft="plug" disabled={busy || !pick.length} onClick={connect}>{busy ? 'Conectando…' : 'Conectar'}</Button>
        </div>
      </>)}
    </div>
  );
}

function KoblyConnections({ empresaId, notify = () => {} }) {
  const store = useKobly();
  const [st, setSt] = useState({ loading: true, uaz: [], uazOn: false, flows: 0, oficial: null, tg: [], meta: [], error: null });
  const [filter, setFilter] = useState('todos');
  const [q, setQ] = useState('');
  const [picker, setPicker] = useState(false);
  const [flow, setFlow] = useState(null); // { kind, step, id, qrcode }
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null); // { id, tab, label, origLabel, connected, name, origName, pic, image, removeImage }
  const [over, setOver] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    const [u, o, t, m] = await Promise.all([KoblyApi.uazapi('list', {}, empresaId), KoblyApi.whatsappAccount('status', {}, empresaId), KoblyApi.notifyChannels('list', {}, empresaId),
      KoblyApi.metaChannels('list', {}, empresaId).catch(() => ({}))]);
    setSt({ loading: false, uaz: u.instances || [], uazOn: !!u.configured, flows: u.flows_active || 0, oficial: (o && o.account) || null, tg: t.channels || [], meta: (m && m.channels) || [], error: u.error || t.error || null });
  }, [empresaId]);
  useEffect(() => { load(); }, [load]);
  // enquanto puxa o histórico do WhatsApp, atualiza o andamento
  const importing = st.uaz.some((i) => i.history_status === 'running');
  useEffect(() => {
    if (!importing) return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [importing, load]);

  function start(kind) {
    if (kind.soon) { notify('info', `${kind.label} chega em breve.`); return; }
    setPicker(false);
    if (kind.id === 'instagram' || kind.id === 'messenger') { setFlow({ kind: 'meta', want: kind.id }); return; }
    setForm({}); setFlow({ kind: kind.id, step: 'form' });
  }
  async function createQr() {
    setBusy(true);
    const r = await KoblyApi.uazapi('create', { label: form.label }, empresaId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    setFlow({ kind: 'qr', step: 'qr', id: r.instance.id, qrcode: r.qrcode }); load();
  }
  async function saveTg() {
    setBusy(true);
    const r = await KoblyApi.notifyChannels('save', { label: form.label, bot_token: form.bot_token, chat_id: form.chat_id }, empresaId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    notify('success', 'Bot conectado. Use "Testar" para receber uma mensagem.'); setFlow(null); load();
  }
  async function pickPhoto(file) {
    try { const image = await toJpeg640(file); setEdit((e) => ({ ...e, image, removeImage: false })); }
    catch (err) { notify('danger', err.message); }
  }
  async function saveEdit() {
    setBusy(true);
    try {
      if (edit.label.trim() && edit.label.trim() !== edit.origLabel) {
        const r = await KoblyApi.uazapi('rename', { id: edit.id, label: edit.label }, empresaId);
        if (r.error) { notify('danger', r.error); return; }
      }
      const prof = {};
      if (edit.name.trim() && edit.name.trim() !== (edit.origName || '')) prof.name = edit.name.trim();
      if (edit.image) prof.image = edit.image;
      if (edit.removeImage) prof.remove_image = true;
      if (Object.keys(prof).length) {
        const r = await KoblyApi.uazapi('profile', { id: edit.id, ...prof }, empresaId);
        if (r.error) { notify('danger', r.error); return; }
        notify('success', 'Perfil do WhatsApp atualizado. Pode levar alguns segundos para aparecer para os contatos.');
      }
      setEdit(null); load();
    } finally { setBusy(false); }
  }
  async function setPause(c, on) {
    setSt((s) => ({ ...s, uaz: s.uaz.map((i) => (i.id === c.key ? { ...i, pause_flows_on_disconnect: on } : i)) }));
    const r = await KoblyApi.uazapi('settings', { id: c.key, pause_flows_on_disconnect: on }, empresaId);
    if (r.error) { notify('danger', r.error); load(); return; }
    notify('success', on ? 'Os fluxos pausam sozinhos se este número desconectar.' : 'Os fluxos seguem ativos mesmo se este número desconectar.');
  }
  async function act(fn, action, extra, msg, confirmText) {
    if (confirmText && !(await askConfirm(confirmText))) return;
    const r = await KoblyApi[fn](action, extra, empresaId);
    if (r.error) notify('danger', r.error); else { if (msg) notify('success', msg); load(); }
  }

  // todas as conexões no mesmo formato de cartão
  const all = [
    ...st.uaz.map((i) => ({ key: i.id, kind: 'qr', name: i.label, profile: i.profile_name, sub: 'WhatsApp comum', pic: i.profile_pic_url, business: i.is_business, pause: i.pause_flows_on_disconnect, history: { status: i.history_status, count: i.history_count, at: i.history_at, error: i.history_error }, phone: i.phone, status: i.status, when: i.connected_at, seen: i.last_seen_at, reason: i.disconnect_reason })),
    ...(st.oficial ? [{ key: 'oficial', kind: 'oficial', name: st.oficial.verified_name || 'WhatsApp Oficial', sub: 'API Oficial da Meta', phone: String(st.oficial.display_phone || '').replace(/\D/g, ''), status: st.oficial.status === 'connected' ? 'connected' : 'disconnected', when: st.oficial.connected_at }] : []),
    ...st.meta.map((c) => ({ key: c.id, kind: c.kind, name: c.kind === 'instagram' ? (c.username ? `@${c.username}` : c.name) : c.name, profile: c.kind === 'instagram' ? c.name : null,
      sub: c.kind === 'instagram' ? 'Instagram Direct' : 'Messenger da página', pic: c.picture_url, status: c.status === 'connected' ? 'connected' : 'disconnected', when: c.created_at, reason: c.last_error })),
    ...st.tg.map((c) => ({ key: c.id, kind: 'telegram', name: c.label, sub: 'Bot de alertas da equipe', chat: c.default_chat_id, status: 'connected', when: c.created_at })),
  ];
  const cards = all.filter((c) => (filter === 'todos' || c.kind === filter) && (!q || `${c.name} ${c.profile || ''} ${c.phone || ''}`.toLowerCase().includes(q.toLowerCase())));
  const on = all.filter((c) => c.status === 'connected' && c.kind !== 'telegram').length;
  const waiting = all.filter((c) => c.status === 'connecting').length;
  const soonFilter = KINDS.find((k) => k.id === filter && k.soon);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{KC_CSS}</style>
      <div className="kc-hero">
        <div style={{ display: 'flex', marginRight: 4 }}>
          {['qr', 'instagram', 'messenger', 'telegram'].map((k, i) => <span key={k} style={{ marginLeft: i ? -10 : 0, borderRadius: 12, boxShadow: '0 0 0 3px #0e1018', zIndex: 4 - i }}><ChannelLogo kind={k} size={40} /></span>)}
        </div>
        <div style={{ flex: 1, minWidth: 220, position: 'relative', zIndex: 1 }}>
          <div style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: 20 }}>Central de conexões</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 2 }}>Todos os seus canais num lugar. Os fluxos e os Chats ao vivo usam os números conectados aqui.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, position: 'relative', zIndex: 1 }}>
          <div className="kc-stat"><b style={{ color: '#34d399' }}>{on}</b><span>conectados</span></div>
          <div className="kc-stat"><b style={{ color: waiting ? '#fbbf24' : undefined }}>{waiting}</b><span>aguardando</span></div>
          <div className="kc-stat"><b style={{ color: '#ff9452' }}>{st.flows}</b><span>fluxos rodando</span></div>
        </div>
        <div style={{ display: 'flex', gap: 8, position: 'relative', zIndex: 1 }}>
          <IconButton icon="refresh-cw" aria-label="Atualizar" onClick={load} />
          <Button variant="primary" iconLeft="plus" onClick={() => setPicker(true)}>Nova conexão</Button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {FILTERS.map(([id, lbl]) => (
          <button key={id} type="button" className={`kc-chip${filter === id ? ' on' : ''}`} onClick={() => setFilter(id)}>
            {id === 'todos' ? <span className="all"><Icon name="layers" size={13} /></span> : <ChannelLogo kind={id} size={22} />}{lbl}
          </button>
        ))}
        <Input icon="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome ou número…" style={{ flex: 1, minWidth: 200, maxWidth: 320, marginLeft: 'auto' }} />
      </div>
      {st.error && <Banner tone="danger">{st.error}</Banner>}
      {!st.loading && cards.length === 0 && (
        <div className="kc-card" style={{ '--brand': '#ff6201', alignItems: 'center', textAlign: 'center', padding: 34 }}>
          {soonFilter ? <ChannelLogo kind={soonFilter.id} size={52} /> : <div style={{ display: 'flex', gap: 6 }}><ChannelLogo kind="qr" size={44} /><ChannelLogo kind="telegram" size={44} /></div>}
          <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: 16 }}>{soonFilter ? `${soonFilter.label} chega em breve` : `Nenhuma conexão${filter !== 'todos' ? ' deste canal' : ''} ainda`}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', maxWidth: 420 }}>{soonFilter ? soonFilter.desc : 'Comece conectando seu WhatsApp: leva menos de um minuto, é só ler o QR Code.'}</div>
          {!soonFilter && <button type="button" className="kc-btn primary" onClick={() => setPicker(true)}><Icon name="plus" size={15} />Nova conexão</button>}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
        {cards.map((c) => (
          <ConnCard key={c.key} c={c} flowsActive={st.flows} navigate={store.navigate} onAct={act}
            onQr={() => setFlow({ kind: 'qr', step: 'qr', id: c.key })} onRename={() => setEdit({ id: c.key, tab: 'conexao', label: c.name, origLabel: c.name, connected: c.status === 'connected', name: c.profile || '', origName: c.profile || '', pic: c.pic, image: null, removeImage: false })} onPause={(on) => setPause(c, on)} onManage={() => setFlow({ kind: 'oficial', step: 'manage' })} />
        ))}
      </div>

      <Modal open={picker} onClose={() => setPicker(false)} title="Nova conexão" subtitle="Escolha o canal que você quer conectar." width={640}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
          {KINDS.map((k) => (
            <button key={k.id} type="button" className={`kc-tile${k.soon ? ' soon' : ''}`} style={{ '--brand': k.color }} onClick={() => start(k)}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <ChannelLogo kind={k.id} size={46} />
                {k.soon ? <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(255,255,255,.08)', color: 'var(--text-muted)' }}>Em breve</span> : <Icon name="arrow-up-right" size={16} style={{ color: 'var(--text-subtle)' }} />}
              </div>
              <div>
                <div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{k.label}</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>{k.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </Modal>

      <Modal open={!!flow && flow.kind === 'qr'} onClose={() => setFlow(null)} title={flow && flow.step === 'form' ? 'Conectar WhatsApp' : 'Leia o QR Code'} width={500}
        footer={flow && flow.step === 'form' ? <><Button variant="ghost" onClick={() => setFlow(null)}>Cancelar</Button><Button variant="primary" iconLeft="qr-code" disabled={busy || !st.uazOn} onClick={createQr}>{busy ? 'Criando…' : 'Gerar QR Code'}</Button></> : null}>
        {flow && flow.kind === 'qr' && flow.step === 'form' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <ChannelLogo kind="qr" size={48} />
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.5 }}>Funciona com qualquer número de WhatsApp ou WhatsApp Business. Não é a API oficial: siga as boas práticas de envio para evitar bloqueio.</div>
            </div>
            {!st.uazOn && <Banner tone="warning" title="Ainda não ativo neste servidor.">O administrador da Kobly precisa cadastrar um servidor em Servidores WhatsApp.</Banner>}
            <Input label="Nome da conexão" value={form.label || ''} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Ex.: Vendas, Suporte, Número da Ana" autoFocus />
          </div>
        )}
        {flow && flow.kind === 'qr' && flow.step === 'qr' && <QrPanel id={flow.id} empresaId={empresaId} initialQr={flow.qrcode} notify={notify} onConnected={load} flowsActive={st.flows} onClose={() => setFlow(null)} />}
      </Modal>

      <Modal open={!!edit} onClose={() => setEdit(null)} title="Editar conexão" subtitle="Nome na Kobly e perfil que seus contatos veem no WhatsApp." width={500}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancelar</Button><Button variant="primary" iconLeft="check" disabled={busy || !(edit && edit.label.trim())} onClick={saveEdit}>{busy ? 'Salvando…' : 'Salvar'}</Button></>}>
        {edit && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
            onPaste={(e) => { const f = [...(e.clipboardData && e.clipboardData.files ? e.clipboardData.files : [])][0]; if (f && edit.tab === 'perfil' && edit.connected) { e.preventDefault(); pickPhoto(f); } }}>
            <div className="kc-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={edit.tab === 'conexao'} className={edit.tab === 'conexao' ? 'on' : ''} onClick={() => setEdit({ ...edit, tab: 'conexao' })}><Icon name="plug" size={14} />Conexão</button>
              <button type="button" role="tab" aria-selected={edit.tab === 'perfil'} className={edit.tab === 'perfil' ? 'on' : ''} onClick={() => setEdit({ ...edit, tab: 'perfil' })}><ChannelLogo kind="qr" size={16} />Perfil do WhatsApp</button>
            </div>
            {edit.tab === 'conexao' ? (
              <Input label="Nome da conexão" value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} hint="Só na Kobly, para você identificar o número. Ex.: Vendas, Suporte, Número da Ana." autoFocus />
            ) : !edit.connected ? (
              <Banner tone="warning" title="Número desconectado">Conecte o número (leia o QR Code) para mudar o nome e a foto do perfil.</Banner>
            ) : (<>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { pickPhoto(e.target.files && e.target.files[0]); e.target.value = ''; }} />
              <div className={`kc-photo${over ? ' over' : ''}`} role="button" tabIndex={0} onClick={() => fileRef.current && fileRef.current.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current && fileRef.current.click(); } }}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); pickPhoto(e.dataTransfer.files && e.dataTransfer.files[0]); }}>
                {edit.image ? <img src={edit.image} alt="" /> : edit.pic && !edit.removeImage ? <img src={edit.pic} alt="" /> : <div className="ph">{initials(edit.name || edit.label)}</div>}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{edit.image ? 'Nova foto pronta' : 'Trocar foto do perfil'}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.5 }}>Arraste, cole (Ctrl+V) ou clique. A Kobly recorta em 640×640, como o WhatsApp pede.</div>
                </div>
                <Icon name="upload" size={18} style={{ color: '#25D366' }} />
              </div>
              {(edit.pic || edit.image) && (
                <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-body)', cursor: 'pointer' }}>
                  <button type="button" role="switch" aria-checked={edit.removeImage} className={`kc-switch${edit.removeImage ? ' on' : ''}`} onClick={() => setEdit({ ...edit, removeImage: !edit.removeImage, image: null })} />
                  Remover a foto atual
                </label>
              )}
              <div>
                <Input label="Nome do perfil" value={edit.name} maxLength={25} onChange={(e) => setEdit({ ...edit, name: e.target.value.slice(0, 25) })} placeholder={edit.origName || 'Nome que aparece no WhatsApp'} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', marginTop: 6 }}>
                  <span>Todos os seus contatos veem. O WhatsApp limita quantas vezes dá para trocar.</span><span>{edit.name.length}/25</span>
                </div>
              </div>
            </>)}
          </div>
        )}
      </Modal>

      <Modal open={!!flow && flow.kind === 'meta'} onClose={() => setFlow(null)} title={flow && flow.want === 'messenger' ? 'Conectar Messenger' : 'Conectar Instagram'} subtitle="Conversas do Direct e da página do Facebook no Chat ao vivo." width={540}>
        {flow && flow.kind === 'meta' && <MetaConnect empresaId={empresaId} want={flow.want} notify={notify} onClose={() => setFlow(null)} onDone={() => { setFlow(null); load(); }} />}
      </Modal>

      <Modal open={!!flow && flow.kind === 'telegram'} onClose={() => setFlow(null)} title="Telegram (bot de alertas)" width={480}
        footer={<><Button variant="ghost" onClick={() => setFlow(null)}>Cancelar</Button><Button variant="primary" disabled={busy || !form.bot_token || !form.chat_id} onClick={saveTg}>Conectar bot</Button></>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}><ChannelLogo kind="telegram" size={44} /><span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Crie o bot com o @BotFather, adicione-o ao grupo da equipe e cole os dados aqui.</span></div>
          <Input label="Nome (opcional)" value={form.label || ''} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Equipe de vendas" />
          <Input label="Token do bot" type="password" autoComplete="new-password" value={form.bot_token || ''} onChange={(e) => setForm({ ...form, bot_token: e.target.value })} />
          <Input label="ID do chat ou grupo" value={form.chat_id || ''} onChange={(e) => setForm({ ...form, chat_id: e.target.value })} placeholder="-1001234567890" hint="O ID do grupo começa com -100." />
        </div>
      </Modal>

      <Drawer open={!!flow && flow.kind === 'oficial'} onClose={() => { setFlow(null); load(); }} width={720} title="WhatsApp API Oficial" subtitle="WhatsApp Cloud API: número verificado e modelos aprovados.">
        {flow && flow.kind === 'oficial' && <WhatsappMetaTab empresaId={empresaId} />}
      </Drawer>
    </div>
  );
}

export { KoblyConnections };
