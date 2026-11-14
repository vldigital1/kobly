import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Icon } from '@/ds';
import { ChannelLogo } from '@/lib/brandLogos.jsx';
import { askConfirm } from '@/lib/confirm.jsx';
import { useBreakpoint } from '@/lib/responsive.jsx';
import { useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Chats ao vivo, no jeito do WhatsApp. Conversas do WhatsApp (QR Code e API Oficial): o que o lead mandou +
// o que o fluxo, a IA, a equipe (pela Kobly) ou a empresa (pelo próprio celular) mandou. Áudio toca na hora, foto e
// vídeo abrem na conversa, foto de perfil do contato, emojis, menu + (arquivo, resposta rápida, disparar fluxo),
// ligação, etiquetas, notas, limpar e arquivar. "Assumir" pausa a automação do lead. KoblyChats

const POLL_MS = 5000;
const DE = {
  lead: { label: 'Lead', mine: false, icon: null },
  fluxo: { label: 'Fluxo', mine: true, icon: 'git-branch', color: '#ffb27d' },
  agente: { label: 'IA', mine: true, icon: 'sparkles', color: 'var(--pastel-amber)' },
  humano: { label: 'Equipe', mine: true, icon: 'user', color: 'var(--pastel-green)' },
  celular: { label: 'Celular', mine: true, icon: 'smartphone', color: 'var(--pastel-blue)' },
};
// redes do Chat ao vivo: todas juntas ou uma só; dentro de cada uma, dá para escolher a conexão (chip, número oficial, conta, Página)
const REDES = [['', 'Todas', null], ['whatsapp', 'WhatsApp', 'qr'], ['instagram', 'Instagram', 'instagram'], ['messenger', 'Messenger', 'messenger']];
const CONN_LOGO = { uazapi: 'qr', oficial: 'oficial', instagram: 'instagram', messenger: 'messenger' };
const FILTROS = [['todas', 'Todas'], ['aguardando', 'Não respondidas'], ['fluxo', 'Em fluxo'], ['humano', 'Com humano'], ['arquivadas', 'Arquivadas']];
const TIPO = { image: ['image', 'Foto'], audio: ['mic', 'Áudio'], video: ['video', 'Vídeo'], document: ['file-text', 'Arquivo'], sticker: ['smile', 'Figurinha'] };
const EMOJIS = {
  'Carinhas': '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🥵 🥶 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬',
  'Gestos': '👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 👏 🙌 👐 🤲 🤝 🙏 💪 ✍️ 💅 👀 🧠',
  'Corações': '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 ✨ ⭐ 🌟 🔥 💥 🎉 🎊 🎁 🏆 🥇',
  'Negócios': '✅ ☑️ ✔️ ❌ ⚠️ ❗ ❓ 📌 📍 📎 🔗 💰 💵 💳 🧾 🛒 📦 🚚 📈 📉 📊 📅 ⏰ ⏳ 📞 📱 💻 📧 📝 📚 🎯 🚀 💡 🔒 🔓 🏷️ 🎟️ 🪙',
  'Natureza': '☀️ 🌤️ 🌧️ ⛈️ 🌈 🌙 🌸 🌹 🌻 🌷 🍀 🌱 🌴 🐶 🐱 🐭 🐰 🦊 🐻 🐼 🐨 🦁 🐸 🐵 🐔 🐧 🦋 🐝',
  'Comida': '☕ 🍵 🥤 🍺 🍷 🍕 🍔 🍟 🌭 🥪 🌮 🍝 🍣 🍰 🎂 🍫 🍩 🍪 🍿 🍎 🍌 🍓 🍉 🍇 🥑',
};
const nomeOf = (c) => [c.nome, c.sobrenome].filter(Boolean).join(' ') || (c.telefone ? `+${c.telefone}` : 'Contato');
const ini = (s) => String(s || '?').replace(/^\+/, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const money = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dataHora = (iso) => (iso ? `${new Date(iso).toLocaleDateString('pt-BR')} às ${hora(iso)}` : '—');
const diaLabel = (iso) => { const d = new Date(iso), h = new Date(); const y = new Date(h); y.setDate(h.getDate() - 1); const same = (a, b) => a.toDateString() === b.toDateString(); return same(d, h) ? 'Hoje' : same(d, y) ? 'Ontem' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }); };
const rel = (iso) => { const d = new Date(iso), h = new Date(); if (d.toDateString() === h.toDateString()) return hora(iso); const y = new Date(h); y.setDate(h.getDate() - 1); if (d.toDateString() === y.toDateString()) return 'Ontem'; return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }); };
const fmtPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); if (d.length === 13 && d.startsWith('55')) return `+55 (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`; if (d.length === 12 && d.startsWith('55')) return `+55 (${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}`; return d ? `+${d}` : ''; };
const secs = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');

// *negrito* _itálico_ ~riscado~ e links, como no WhatsApp (sem HTML cru)
function Rich({ text }) {
  const parts = String(text || '').split(/(https?:\/\/\S+|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g);
  return parts.map((p, i) => {
    if (/^https?:\/\//.test(p)) return <a key={i} href={p} target="_blank" rel="noreferrer" style={{ color: '#53bdeb', wordBreak: 'break-all' }}>{p}</a>;
    if (/^\*[^*]+\*$/.test(p)) return <b key={i}>{p.slice(1, -1)}</b>;
    if (/^_[^_]+_$/.test(p)) return <i key={i}>{p.slice(1, -1)}</i>;
    if (/^~[^~]+~$/.test(p)) return <s key={i}>{p.slice(1, -1)}</s>;
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}

const KH_CSS = `
.kh-shell { position: relative; display: grid; grid-template-columns: 360px 1fr 340px; height: calc(100dvh - 150px); min-height: 560px; border-radius: 18px; overflow: hidden;
  background: var(--wa-bg); border: 1px solid rgba(var(--fg-rgb), .07); box-shadow: 0 20px 60px rgba(0,0,0,.45); }
.kh-shell.two { grid-template-columns: 360px 1fr; } .kh-shell.one { grid-template-columns: 1fr; }
.kh-col { display: flex; flex-direction: column; min-height: 0; min-width: 0; position: relative; }
.kh-col.l { background: var(--wa-panel); border-right: 1px solid var(--wa-line); }
.kh-col.r { background: var(--wa-panel); border-left: 1px solid var(--wa-line); }
.kh-col.r.drawer { position: absolute; top: 0; right: 0; bottom: 0; width: 360px; max-width: 100%; z-index: 40; box-shadow: -12px 0 40px rgba(0,0,0,.55); animation: kh-slide .18s ease-out; }
@keyframes kh-slide { from { transform: translateX(30px); opacity: 0; } }
.kh-top { padding: 14px 14px 10px; display: flex; flex-direction: column; gap: 10px; background: var(--wa-panel); }
.kh-title { display: flex; align-items: center; gap: 10px; }
.kh-search { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-radius: 10px; background: var(--wa-in); }
.kh-search input { flex: 1; background: transparent; border: 0; outline: none; color: var(--wa-text); font: inherit; font-size: 14px; }
.kh-filters { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding-bottom: 2px; }
.kh-f { flex: none; padding: 6px 12px; border-radius: 999px; font-size: 13px; cursor: pointer; font-family: var(--font-sans); color: var(--wa-icon); background: var(--wa-in); border: 0; }
.kh-f:hover { background: var(--wa-btn); }
.kh-f.on { color: var(--pastel-orange); background: rgba(255,98,1,.28); }
.kh-f .n { margin-left: 5px; opacity: .75; }
.kh-redes { display: flex; gap: 4px; padding: 3px; border-radius: 12px; background: var(--wa-in); }
.kh-rede { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 6px; border-radius: 9px; border: 0; cursor: pointer; background: transparent; color: var(--wa-icon); font: 500 13px var(--font-sans); white-space: nowrap; transition: background .15s, color .15s; }
.kh-rede:hover { color: var(--wa-text); }
.kh-rede.on { background: var(--wa-panel); color: var(--wa-text); box-shadow: 0 1px 3px rgba(0,0,0,.18); }
.kh-rede .n { font-size: 11px; padding: 0 6px; border-radius: 999px; background: #25d366; color: #0b141a; font-weight: 700; }
.kh-top { container-type: inline-size; }
.kh-rede .t { overflow: hidden; text-overflow: ellipsis; }
@container (max-width: 380px) { .kh-rede:not(.on) .t { display: none; } .kh-rede:not(.on) { flex: 0 0 38px; } }
.kh-connsel { position: relative; display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 10px; background: var(--wa-in); color: var(--wa-text); font-size: 13px; }
.kh-connsel select { flex: 1; min-width: 0; appearance: none; -webkit-appearance: none; background: transparent; border: 0; outline: none; color: inherit; font: inherit; cursor: pointer; padding-right: 18px; }
.kh-connsel select option { background: var(--wa-panel); color: var(--wa-text); }
.kh-connsel .chev { position: absolute; right: 10px; pointer-events: none; color: var(--wa-muted); }
.kh-conn { display: inline-flex; align-items: center; gap: 4px; max-width: 140px; font-size: 11px; color: var(--wa-muted); background: var(--wa-in); border-radius: 6px; padding: 1px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none; }
.kh-list { flex: 1; min-height: 0; overflow-y: auto; }
.kh-item { display: flex; gap: 12px; width: 100%; text-align: left; padding: 0 14px; border: 0; cursor: pointer; font-family: var(--font-sans); background: transparent; align-items: center; }
.kh-item:hover { background: var(--wa-in); }
.kh-item.on { background: var(--wa-btn); }
.kh-item .bd { flex: 1; min-width: 0; padding: 12px 0; border-bottom: 1px solid var(--wa-line); }
.kh-name { font-size: 16px; color: var(--wa-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kh-prev { font-size: 13.5px; color: var(--wa-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 4px; }
.kh-av { border-radius: 50%; flex: none; display: grid; place-items: center; font-weight: 700; color: #fff; position: relative; overflow: visible; }
.kh-av img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }
.kh-av .st { position: absolute; right: 0; bottom: 0; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--wa-panel); }
.kh-unread { min-width: 21px; height: 21px; padding: 0 6px; border-radius: 999px; display: grid; place-items: center; font-size: 12px; font-weight: 700; color: var(--wa-panel); background: #25d366; flex: none; }
.kh-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.kh-head { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--wa-in); min-height: 62px; }
.kh-acts { display: flex; align-items: center; gap: 0; margin-left: auto; flex: none; }
.kh-ic { width: 38px; height: 38px; border-radius: 50%; border: 0; cursor: pointer; display: grid; place-items: center; color: var(--wa-icon); background: transparent; flex: none; position: relative; }
.kh-ic:hover { background: rgba(var(--fg-rgb), .08); color: var(--wa-text); }
.kh-ic.on { color: #ff9452; }
.kh-ic.danger:hover { color: #f87171; }
.kh-ic:disabled { opacity: .4; cursor: not-allowed; }
.kh-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 999px; cursor: pointer; font-family: var(--font-sans); font-size: 13px; font-weight: 600; color: var(--wa-text); background: var(--wa-btn); border: 0; }
.kh-btn:hover { filter: brightness(1.15); }
.kh-btn.hot { color: var(--wa-panel); background: #25d366; }
.kh-btn.orange { color: #fff; background: linear-gradient(135deg, #ff9452, #ff6201); }
.kh-msgs { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 7% 10px; display: flex; flex-direction: column; gap: 2px; background-color: var(--wa-bg);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Cg fill='none' stroke='%23ffffff' stroke-opacity='.035' stroke-width='1.5'%3E%3Ccircle cx='18' cy='20' r='7'/%3E%3Cpath d='M70 14l8 8-8 8-8-8z'/%3E%3Crect x='96' y='40' width='14' height='10' rx='2'/%3E%3Cpath d='M20 70c6-8 14-8 20 0'/%3E%3Ccircle cx='80' cy='82' r='4'/%3E%3Cpath d='M48 100l6 10 6-10z'/%3E%3Cpath d='M100 100c0-5 8-5 8 0s-8 9-8 9-8-4-8-9 8-5 8 0'/%3E%3Cpath d='M40 40h10v10'/%3E%3C/g%3E%3C/svg%3E"); }
.kh-day { align-self: center; margin: 10px 0 8px; padding: 5px 12px; border-radius: 8px; font-size: 12.5px; color: var(--wa-muted); background: var(--wa-chip); box-shadow: 0 1px 1px rgba(0,0,0,.2); position: sticky; top: 0; z-index: 2; }
.kh-row { display: flex; flex-direction: column; }
.kh-row.mine { align-items: flex-end; } .kh-row.lead { align-items: flex-start; }
.kh-row.first { margin-top: 8px; }
.kh-b { max-width: min(68%, 560px); padding: 6px 8px 8px 9px; border-radius: 8px; position: relative; font-size: 14.2px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; color: var(--wa-text); box-shadow: 0 1px .5px rgba(var(--panel-rgb), .13); }
.kh-row.lead .kh-b { background: var(--wa-in); }
.kh-row.mine .kh-b { background: var(--wa-out); }
.kh-row.mine .kh-b.ia { background: #6b2a06; }
.kh-row.first.lead .kh-b { border-top-left-radius: 0; }
.kh-row.first.mine .kh-b { border-top-right-radius: 0; }
.kh-row.first.lead .kh-b::before { content: ''; position: absolute; left: -8px; top: 0; border: 8px solid transparent; border-top-color: var(--wa-in); border-right-color: var(--wa-in); border-width: 0 8px 10px 0; }
.kh-row.first.mine .kh-b::before { content: ''; position: absolute; right: -8px; top: 0; border-style: solid; border-color: var(--wa-out) transparent transparent var(--wa-out); border-width: 0 0 10px 8px; }
.kh-row.first.mine .kh-b.ia::before { border-color: #6b2a06 transparent transparent #6b2a06; }
.kh-b .meta { float: right; margin: 8px 0 -4px 10px; font-size: 11px; color: rgba(233,237,239,.6); display: inline-flex; gap: 3px; align-items: center; white-space: nowrap; }
.kh-b .who { display: flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; margin-bottom: 2px; }
.kh-b.media { padding: 4px 4px 6px; }
.kh-b.media .cap { padding: 4px 5px 0; }
.kh-b.sticker { background: transparent !important; box-shadow: none; padding: 0; }
.kh-b.sticker::before { display: none; }
.kh-img { display: block; width: 300px; max-width: 100%; min-height: 160px; max-height: 360px; object-fit: cover; border-radius: 6px; cursor: zoom-in; background: rgba(var(--well-rgb), calc(.25 * var(--well-k))); }
.kh-ph { width: 300px; max-width: 100%; height: 190px; border-radius: 6px; display: grid; place-items: center; background: rgba(var(--well-rgb), calc(.25 * var(--well-k))); color: var(--wa-muted); }
.kh-audio { display: flex; align-items: center; gap: 10px; width: 290px; max-width: 100%; padding: 4px 2px 0; }
.kh-audio .pp { width: 40px; height: 40px; border-radius: 50%; border: 0; cursor: pointer; display: grid; place-items: center; color: var(--wa-text); background: transparent; flex: none; }
.kh-audio .wave { flex: 1; display: flex; align-items: center; gap: 2px; height: 30px; cursor: pointer; }
.kh-audio .wave i { flex: 1; border-radius: 2px; background: rgba(233,237,239,.35); }
.kh-audio .wave i.p { background: #53bdeb; }
.kh-audio .sp { font-size: 11px; font-weight: 700; padding: 3px 7px; border-radius: 999px; border: 0; cursor: pointer; color: var(--wa-panel); background: rgba(233,237,239,.75); }
.kh-audio .t { font-size: 11px; color: rgba(233,237,239,.6); margin-top: 2px; }
.kh-doc { display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 6px; background: rgba(var(--well-rgb), calc(.18 * var(--well-k))); width: 280px; max-width: 100%; }
.kh-compose { display: flex; align-items: flex-end; gap: 6px; padding: 8px 12px; background: var(--wa-in); position: relative; }
.kh-box { flex: 1; display: flex; align-items: flex-end; border-radius: 10px; background: var(--wa-btn); padding: 2px 6px; }
.kh-box textarea { flex: 1; min-width: 0; white-space: pre-wrap; overflow-y: auto; background: transparent; border: 0; outline: none; resize: none; color: var(--wa-text); font: inherit; font-size: 15px; padding: 9px 6px; max-height: 140px; line-height: 1.35; }
.kh-send { width: 44px; height: 44px; border-radius: 50%; border: 0; cursor: pointer; display: grid; place-items: center; color: var(--wa-panel); background: #25d366; flex: none; }
.kh-send:disabled { opacity: .45; cursor: not-allowed; }
.kh-pop { position: absolute; left: 12px; bottom: calc(100% + 6px); z-index: 20; border-radius: 12px; overflow: hidden; background: var(--wa-pop); box-shadow: 0 10px 30px rgba(0,0,0,.5); }
.kh-menu { min-width: 230px; padding: 6px 0; }
.kh-menu button { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; padding: 10px 18px; background: none; border: 0; cursor: pointer; color: var(--wa-text2); font-family: var(--font-sans); font-size: 14.5px; }
.kh-menu button:hover { background: var(--wa-chip); }
.kh-menu .ico { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; color: #fff; flex: none; }
.kh-emoji { width: 360px; max-width: calc(100vw - 40px); }
.kh-emoji .tabs { display: flex; gap: 2px; padding: 8px 8px 0; border-bottom: 1px solid var(--wa-btn); overflow-x: auto; }
.kh-emoji .tabs button { padding: 7px 10px; background: none; border: 0; border-bottom: 2px solid transparent; cursor: pointer; color: var(--wa-muted); font-size: 12.5px; font-family: var(--font-sans); white-space: nowrap; }
.kh-emoji .tabs button.on { color: var(--wa-text); border-bottom-color: #ff9452; }
.kh-emoji .grid { display: grid; grid-template-columns: repeat(9, 1fr); gap: 2px; padding: 8px; height: 230px; overflow-y: auto; align-content: start; }
.kh-emoji .grid button { font-size: 23px; line-height: 1; padding: 5px 0; background: none; border: 0; cursor: pointer; border-radius: 8px; }
.kh-emoji .grid button:hover { background: var(--wa-btn); }
.kh-quick { left: 12px; right: 12px; max-height: 260px; overflow-y: auto; }
.kh-quick button { display: block; width: 100%; text-align: left; padding: 10px 16px; background: none; border: 0; cursor: pointer; color: var(--wa-text2); font-family: var(--font-sans); font-size: 14px; }
.kh-quick button:hover { background: var(--wa-chip); }
.kh-drop { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; min-width: 240px; padding: 8px 0; border-radius: 12px; background: var(--wa-pop); box-shadow: 0 10px 30px rgba(0,0,0,.5); }
.kh-drop h4 { margin: 4px 16px 8px; font-size: 13px; color: var(--wa-text); }
.kh-drop label { display: flex; align-items: center; gap: 10px; padding: 8px 16px; cursor: pointer; color: var(--wa-text2); font-size: 14px; }
.kh-drop label:hover { background: var(--wa-chip); }
.kh-side { overflow-y: auto; display: flex; flex-direction: column; }
.kh-side .hd { display: flex; align-items: center; gap: 12px; padding: 0 16px; min-height: 62px; background: var(--wa-in); color: var(--wa-text); font-weight: 600; }
.kh-card { padding: 16px 20px; background: var(--wa-panel); border-bottom: 8px solid var(--wa-bg); display: flex; flex-direction: column; gap: 10px; }
.kh-card > .lb { font-size: 13px; color: var(--wa-muted); display: flex; align-items: center; gap: 8px; }
.kh-kv { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--wa-text2); }
.kh-kv svg { color: var(--wa-muted); flex: none; }
.kh-tag { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12.5px; color: var(--wa-text); background: var(--wa-btn); }
.kh-tag button { background: none; border: 0; cursor: pointer; color: var(--wa-muted); padding: 0; display: grid; }
.kh-notes { width: 100%; min-height: 90px; resize: vertical; border-radius: 8px; border: 1px solid var(--wa-btn); background: var(--wa-bg); color: var(--wa-text); font: inherit; font-size: 14px; padding: 10px; outline: none; }
.kh-notes:focus { border-color: #ff9452; }
.kh-arch { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 12px; border-radius: 10px; cursor: pointer; font-family: var(--font-sans); font-size: 14px; font-weight: 600; border: 1px solid rgba(248,113,113,.4); color: #f87171; background: rgba(248,113,113,.08); }
.kh-empty { flex: 1; display: grid; place-items: center; text-align: center; padding: 30px; background: var(--wa-empty); border-bottom: 6px solid #25d366; }
.kh-light { position: fixed; inset: 0; z-index: 1000; background: rgba(var(--panel-rgb), .94); display: grid; place-items: center; padding: 40px; }
.kh-light img, .kh-light video { max-width: 92vw; max-height: 86vh; border-radius: 6px; }
.kh-modal { position: fixed; inset: 0; z-index: 900; background: rgba(0,0,0,.6); display: grid; place-items: center; padding: 20px; }
.kh-modal > div { width: 420px; max-width: 100%; max-height: 80vh; overflow-y: auto; border-radius: 14px; background: var(--wa-pop); box-shadow: 0 20px 60px rgba(0,0,0,.6); }
.kh-modal .opt { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 18px; background: none; border: 0; border-top: 1px solid var(--wa-btn); cursor: pointer; color: var(--wa-text); font-family: var(--font-sans); font-size: 14.5px; text-align: left; }
.kh-modal .opt:hover { background: var(--wa-chip); }
@keyframes spin { to { transform: rotate(360deg); } }
.kh-scroll-btn { position: absolute; right: 22px; bottom: 80px; width: 42px; height: 42px; border-radius: 50%; border: 0; cursor: pointer; display: grid; place-items: center; background: var(--wa-in); color: var(--wa-icon); box-shadow: 0 2px 8px rgba(0,0,0,.4); z-index: 5; }
`;

function Avatar({ name, src, size = 49, online, channel }) {
  const [bad, setBad] = useState(false);
  const h = hue(name);
  const img = src && !bad;
  return (
    <div className="kh-av" style={{ width: size, height: size, fontSize: Math.round(size * 0.36), background: img ? 'var(--wa-btn)' : `linear-gradient(135deg, hsl(${h} 55% 45%), hsl(${(h + 40) % 360} 60% 32%))` }}>
      {img ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBad(true)} /> : ini(name)}
      {channel && channel !== 'whatsapp' ? <span style={{ position: 'absolute', right: -3, bottom: -3, borderRadius: 7, boxShadow: '0 0 0 2px var(--wa-panel)', display: 'grid' }}><ChannelLogo kind={channel} size={Math.max(16, Math.round(size * 0.38))} /></span>
        : online !== undefined && <span className="st" style={{ background: online ? '#25d366' : '#64748b' }} />}
    </div>
  );
}

// ---- mídia: o link é pedido ao servidor só quando a mensagem aparece (e fica guardado nesta página) ----------
const mediaCache = new Map();
function useMediaUrl(m, fetcher, eager) {
  const [url, setUrl] = useState(() => m.media_url || mediaCache.get(m.id) || null);
  const [err, setErr] = useState(null);
  const get = useCallback(async () => {
    if (url) return url;
    if (mediaCache.has(m.id)) { const u = mediaCache.get(m.id); setUrl(u); return u; }
    const r = await fetcher(m);
    if (!r || r.error || !r.url) { setErr((r && r.error) || 'Mídia indisponível.'); return null; }
    mediaCache.set(m.id, r.url); setUrl(r.url); return r.url;
  }, [url, m, fetcher]);
  const ref = useRef(null);
  useEffect(() => {
    if (!eager || url || err || !ref.current) return undefined;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); get(); } }, { rootMargin: '300px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [eager, url, err, get]);
  return { url, err, get, ref };
}

function AudioMsg({ m, fetcher, mine, avatar }) {
  const { url, err, get } = useMediaUrl(m, fetcher, false);
  const a = useRef(null);
  const [st, setSt] = useState({ playing: false, t: 0, d: 0, loading: false });
  const [rate, setRate] = useState(1);
  const bars = useMemo(() => { let s = hue(m.id); return Array.from({ length: 34 }, () => { s = (s * 9301 + 49297) % 233280; return 25 + (s / 233280) * 75; }); }, [m.id]);
  async function toggle() {
    if (!url) { setSt((x) => ({ ...x, loading: true })); const u = await get(); setSt((x) => ({ ...x, loading: false })); if (u) setTimeout(() => a.current && a.current.play().catch(() => {}), 50); return; }
    if (a.current.paused) a.current.play().catch(() => {}); else a.current.pause();
  }
  function seek(e) {
    if (!a.current || !st.d) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.current.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * st.d;
  }
  function speed() { const n = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1; setRate(n); if (a.current) a.current.playbackRate = n; }
  const pct = st.d ? st.t / st.d : 0;
  return (
    <div className="kh-audio">
      {!mine && avatar}
      <button type="button" className="pp" onClick={toggle} aria-label={st.playing ? 'Pausar áudio' : 'Ouvir áudio'}>
        <Icon name={st.loading ? 'loader-circle' : st.playing ? 'pause' : 'play'} size={26} style={st.loading ? { animation: 'spin 1s linear infinite' } : undefined} />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="wave" onClick={seek}>{bars.map((h, i) => <i key={i} className={i / bars.length < pct ? 'p' : ''} style={{ height: `${h}%` }} />)}</div>
        <div className="t">{err ? <span style={{ color: 'var(--pastel-pink)' }}>{err}</span> : secs(st.playing || st.t ? st.t : st.d)}</div>
      </div>
      {url ? <button type="button" className="sp" onClick={speed}>{rate}×</button> : mine && avatar}
      {url && <audio ref={a} src={url} preload="metadata" onLoadedMetadata={(e) => { const d = e.currentTarget.duration; setSt((x) => ({ ...x, d })); }} onTimeUpdate={(e) => { const t = e.currentTarget.currentTime; setSt((x) => ({ ...x, t })); }}
        onPlay={() => setSt((x) => ({ ...x, playing: true }))} onPause={() => setSt((x) => ({ ...x, playing: false }))} onEnded={() => setSt((x) => ({ ...x, playing: false, t: 0 }))} />}
    </div>
  );
}

function ImageMsg({ m, fetcher, onOpen, sticker }) {
  const { url, err, ref } = useMediaUrl(m, fetcher, true);
  if (url) return <img className="kh-img" src={url} alt="" style={sticker ? { width: 150, minHeight: 0, background: 'none', cursor: 'default' } : undefined} onClick={sticker ? undefined : () => onOpen({ kind: 'image', url })} />;
  return <div ref={ref} className="kh-ph" style={sticker ? { width: 150, height: 150 } : undefined}>{err ? <span style={{ fontSize: 12, padding: 10 }}>{err}</span> : <Icon name="image" size={34} />}</div>;
}

function VideoMsg({ m, fetcher }) {
  const { url, err, ref } = useMediaUrl(m, fetcher, true);
  if (url) return <video src={url} controls preload="metadata" style={{ display: 'block', width: 300, maxWidth: '100%', maxHeight: 360, borderRadius: 6, background: '#000' }} />;
  return <div ref={ref} className="kh-ph">{err ? <span style={{ fontSize: 12, padding: 10 }}>{err}</span> : <Icon name="video" size={34} />}</div>;
}

function DocMsg({ m, fetcher }) {
  const { url, err, get } = useMediaUrl(m, fetcher, false);
  async function open() { const u = url || await get(); if (u) window.open(u, '_blank', 'noopener'); }
  return (
    <div className="kh-doc">
      <Icon name="file-text" size={30} style={{ color: '#ff9452', flex: 'none' }} />
      <div style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.body && !/^\[/.test(m.body) ? m.body : 'Arquivo'}</div>
      <button type="button" className="kh-ic" onClick={open} aria-label="Baixar arquivo" style={{ width: 34, height: 34 }}><Icon name="download" size={18} /></button>
      {err && <span style={{ fontSize: 11, color: 'var(--pastel-pink)' }}>{err}</span>}
    </div>
  );
}

function Bubble({ m, first, fetcher, onOpen, lead }) {
  const de = DE[m.de] || DE.lead;
  const tipo = m.tipo && m.tipo !== 'text' ? m.tipo : null;
  const caption = m.body && !/^\[(imagem|áudio|vídeo|arquivo|figurinha|mensagem|foto|localização|contato)\]$/i.test(m.body.trim()) ? m.body : '';
  const meta = <span className="meta">{hora(m.at)}{de.mine && <Icon name="check-check" size={15} style={{ color: '#53bdeb' }} />}</span>;
  const who = de.mine && <div className="who" style={{ color: de.color }}><Icon name={de.icon} size={11} />{de.label}</div>;
  const av = <Avatar name={nomeOf(lead)} src={lead.avatar_url} size={40} />;
  let body;
  if (tipo === 'audio') body = <>{who}<AudioMsg m={m} fetcher={fetcher} mine={de.mine} avatar={av} />{meta}</>;
  else if (tipo === 'image' || tipo === 'sticker') body = <>{who}<ImageMsg m={m} fetcher={fetcher} onOpen={onOpen} sticker={tipo === 'sticker'} />{caption && tipo === 'image' ? <div className="cap"><Rich text={caption} />{meta}</div> : <div className="cap">{meta}</div>}</>;
  else if (tipo === 'video') body = <>{who}<VideoMsg m={m} fetcher={fetcher} />{caption ? <div className="cap"><Rich text={caption} />{meta}</div> : <div className="cap">{meta}</div>}</>;
  else if (tipo === 'document') body = <>{who}<DocMsg m={m} fetcher={fetcher} />{meta}</>;
  else body = <>{who}<Rich text={m.body || ''} />{meta}</>;
  return (
    <div className={`kh-row ${de.mine ? 'mine' : 'lead'}${first ? ' first' : ''}`}>
      <div data-no-i18n className={`kh-b${m.de === 'agente' ? ' ia' : ''}${tipo && tipo !== 'audio' ? ' media' : ''}${tipo === 'sticker' ? ' sticker' : ''}`}>{body}</div>
    </div>
  );
}

function EmojiPicker({ onPick }) {
  const cats = Object.keys(EMOJIS);
  const [cat, setCat] = useState(cats[0]);
  return (
    <div className="kh-pop kh-emoji" onMouseDown={(e) => e.preventDefault()}>
      <div className="tabs">{cats.map((c) => <button key={c} type="button" className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}</div>
      <div className="grid">{EMOJIS[cat].split(' ').map((e, i) => <button key={i} type="button" onClick={() => onPick(e)}>{e}</button>)}</div>
    </div>
  );
}

function LeadSide({ lead, flows, tags, canEdit, onToggleTag, onClose, onNotes, onArchive, msgs }) {
  const has = new Set((lead.tags || []).map((t) => t.id));
  const [adding, setAdding] = useState(false);
  const [notes, setNotes] = useState(lead.chat_notes || '');
  const [editing, setEditing] = useState(false);
  const last = msgs.length ? msgs[msgs.length - 1].at : null;
  const naoLidas = (() => { let n = 0; for (let i = msgs.length - 1; i >= 0 && msgs[i].de === 'lead'; i--) n++; return n; })();
  return (
    <div className="kh-side">
      <div className="hd"><button type="button" className="kh-ic" onClick={onClose} aria-label="Fechar detalhes"><Icon name="x" size={20} /></button>Detalhes do contato</div>
      <div className="kh-card" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 26 }}>
        <Avatar name={nomeOf(lead)} src={lead.avatar_url} size={160} channel={lead.chat_channel} />
        <div style={{ fontSize: 22, color: 'var(--wa-text)', marginTop: 6 }}>{nomeOf(lead)}</div>
        {lead.ig_username && <div style={{ fontSize: 15, color: 'var(--wa-muted)' }}>@{lead.ig_username}</div>}
        {lead.telefone && <div style={{ fontSize: 15, color: 'var(--wa-muted)' }}>{fmtPhone(lead.telefone)}
          <button type="button" className="kh-ic" style={{ width: 28, height: 28, display: 'inline-grid', verticalAlign: 'middle' }} title="Copiar número" onClick={() => navigator.clipboard && navigator.clipboard.writeText(lead.telefone)}><Icon name="copy" size={14} /></button></div>}
        {lead.valor_compra != null && <div style={{ color: '#34d399', fontWeight: 700 }}>{money(lead.valor_compra)}</div>}
      </div>
      <div className="kh-card">
        <div className="kh-kv"><Icon name="message-circle" size={17} />Mensagens não respondidas: <b style={{ color: 'var(--wa-text)' }}>{naoLidas}</b></div>
        <div className="kh-kv"><Icon name="calendar" size={17} />Última mensagem: <b style={{ color: 'var(--wa-text)' }}>{dataHora(last)}</b></div>
        <div className="kh-kv"><Icon name="calendar-plus" size={17} />Criado em: <b style={{ color: 'var(--wa-text)' }}>{lead.created_at ? new Date(lead.created_at).toLocaleDateString('pt-BR') : '—'}</b></div>
        {lead.email && <div className="kh-kv"><Icon name="mail" size={17} /><span style={{ wordBreak: 'break-all' }}>{lead.email}</span></div>}
        {lead.produto && <div className="kh-kv"><Icon name="package" size={17} />{lead.produto}</div>}
        {lead.utm && lead.utm.utm_source && <div className="kh-kv"><Icon name="megaphone" size={17} />Veio de: {lead.utm.utm_source}{lead.utm.utm_campaign ? ` · ${lead.utm.utm_campaign}` : ''}</div>}
        {lead.link_recuperacao && <a href={lead.link_recuperacao} target="_blank" rel="noreferrer" style={{ fontSize: 13.5, color: '#ff9452' }}>Abrir link de pagamento ↗</a>}
      </div>
      <div className="kh-card">
        <div className="lb"><Icon name="tag" size={16} /><span style={{ flex: 1 }}>Etiquetas</span>
          {canEdit && tags.length > 0 && <button type="button" className="kh-btn" style={{ padding: '4px 12px' }} onClick={() => setAdding((v) => !v)}>{adding ? 'Pronto' : 'Adicionar'}</button>}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(lead.tags || []).map((t) => <span key={t.id} className="kh-tag">{t.nome}{canEdit && <button type="button" onClick={() => onToggleTag(t, false)} aria-label={`Tirar ${t.nome}`}><Icon name="x" size={12} /></button>}</span>)}
          {!(lead.tags || []).length && !adding && <span style={{ fontSize: 13, color: 'var(--wa-muted)' }}>{tags.length ? 'Sem etiquetas.' : 'Crie etiquetas em Integrações → Tags.'}</span>}
        </div>
        {adding && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{tags.filter((t) => !has.has(t.id)).map((t) => <button key={t.id} type="button" className="kh-tag" style={{ border: '1px dashed var(--wa-line)', cursor: 'pointer' }} onClick={() => onToggleTag(t, true)}><Icon name="plus" size={12} />{t.nome}</button>)}</div>}
      </div>
      <div className="kh-card">
        <div className="lb"><Icon name="git-branch" size={16} />Automação</div>
        {lead.automation_paused ? <div style={{ fontSize: 14, color: '#fbbf24' }}>Pausada: você está atendendo.</div>
          : flows.length ? flows.map((f) => <div key={f.id} className="kh-kv"><Icon name="zap" size={15} style={{ color: '#ff9452' }} />{f.campanha}<span style={{ fontSize: 12, color: 'var(--wa-muted)' }}>{f.status === 'waiting' ? (f.wait_kind === 'reply' ? 'esperando resposta' : 'aguardando') : 'rodando'}</span></div>)
          : <div style={{ fontSize: 14, color: 'var(--wa-muted)' }}>Nenhum fluxo rodando agora.</div>}
      </div>
      <div className="kh-card">
        <div className="lb"><Icon name="shopping-cart" size={16} />Histórico de compra</div>
        {!(lead.eventos || []).length && <div style={{ fontSize: 14, color: 'var(--wa-muted)' }}>Nenhum evento do checkout.</div>}
        {(lead.eventos || []).map((e, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: e.tipo === 'Compra Aprovada' ? '#34d399' : e.tipo === 'Compra Recusada' ? '#fb7185' : '#f39200' }} />
            <span style={{ flex: 1, color: 'var(--wa-text2)' }}>{e.tipo}{e.produto ? ` · ${e.produto}` : ''}</span>
            <span style={{ color: 'var(--wa-muted)' }}>{e.valor != null ? money(e.valor) : ''}</span>
          </div>
        ))}
      </div>
      <div className="kh-card">
        <div className="lb"><Icon name="sticky-note" size={16} /><span style={{ flex: 1 }}>Notas</span>
          {canEdit && !editing && <button type="button" className="kh-ic" style={{ width: 30, height: 30 }} onClick={() => setEditing(true)} aria-label="Editar notas"><Icon name="pencil" size={15} /></button>}</div>
        {editing ? (<>
          <textarea className="kh-notes" value={notes} autoFocus maxLength={4000} placeholder="Anotações internas (o contato não vê)" onChange={(e) => setNotes(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="kh-btn" onClick={() => { setNotes(lead.chat_notes || ''); setEditing(false); }}>Cancelar</button>
            <button type="button" className="kh-btn orange" onClick={async () => { await onNotes(notes); setEditing(false); }}>Salvar</button>
          </div>
        </>) : <div style={{ fontSize: 14, color: notes ? 'var(--wa-text2)' : 'var(--wa-muted)', whiteSpace: 'pre-wrap' }}>{notes || 'Nenhuma nota adicionada.'}</div>}
      </div>
      {canEdit && <div className="kh-card" style={{ borderBottom: 0 }}>
        <button type="button" className="kh-arch" onClick={onArchive}><Icon name={lead.chat_archived_at ? 'archive-restore' : 'archive'} size={17} />{lead.chat_archived_at ? 'Desarquivar conversa' : 'Arquivar conversa'}</button>
      </div>}
    </div>
  );
}

function Conversation({ orgId, leadId, quickReplies, tags, canEdit, notify, onChanged, onBack, wide, roomy, sideOpen, setSideOpen }) {
  const [st, setSt] = useState({ loading: true, error: null, lead: null, messages: [], flows: [] });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pop, setPop] = useState(null); // 'emoji' | 'menu' | 'tags'
  const [light, setLight] = useState(null);
  const [flowPick, setFlowPick] = useState(null);
  const [atBottom, setAtBottom] = useState(true);
  const boxRef = useRef(null);
  const endRef = useRef(null);
  const fileRef = useRef(null);
  const taRef = useRef(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setSt((s) => ({ ...s, loading: true }));
    const r = await KoblyApi.inbox('messages', { lead_id: leadId }, orgId);
    if (r && r.lead) setSt({ loading: false, error: null, lead: r.lead, messages: r.messages || [], flows: r.flows || [] });
    else setSt((s) => ({ ...s, loading: false, error: (r && r.error) || 'Não deu para abrir a conversa.' }));
  }, [leadId, orgId]);
  useEffect(() => { load(); const t = setInterval(() => load(true), POLL_MS); return () => clearInterval(t); }, [load]);
  const count = st.messages.length;
  useEffect(() => { if (atBottom && endRef.current) endRef.current.scrollIntoView({ block: 'end' }); }, [count]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!pop) return undefined; const f = (e) => { if (!e.target.closest('.kh-pop,.kh-drop,[data-pop]')) setPop(null); }; document.addEventListener('mousedown', f); return () => document.removeEventListener('mousedown', f); }, [pop]);
  useEffect(() => { const ta = taRef.current; if (ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`; } }, [text]);

  const fetchMedia = useCallback((m) => KoblyApi.inbox('media', { lead_id: leadId, id: m.id, de: m.de === 'lead' ? 'lead' : 'out' }, orgId), [leadId, orgId]);

  async function send() {
    const msg = text.trim();
    if (!msg) return;
    setBusy(true);
    const r = await KoblyApi.inbox('send', { lead_id: leadId, text: msg }, orgId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    setText(''); setAtBottom(true);
    setSt((s) => ({ ...s, messages: [...s.messages, r.message] }));
    onChanged();
  }
  async function sendFile(file) {
    if (!file) return;
    const kind = /^image\//.test(file.type) ? 'image' : /^video\//.test(file.type) ? 'video' : /^audio\//.test(file.type) ? 'audio' : 'document';
    setBusy(true);
    const up = await KoblyApi.uploadFlowMedia(file, orgId).catch((e) => ({ error: e.message }));
    if (!up || up.error) { setBusy(false); notify('danger', (up && up.error) || 'Não deu para enviar o arquivo.'); return; }
    const r = await KoblyApi.inbox('send_media', { lead_id: leadId, kind, url: up.url, caption: text.trim() || undefined, filename: file.name }, orgId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    setText(''); setAtBottom(true);
    setSt((s) => ({ ...s, messages: [...s.messages, r.message] }));
    onChanged();
  }
  async function act(action, extra, okMsg, reload = true) {
    const r = await KoblyApi.inbox(action, { lead_id: leadId, ...extra }, orgId);
    if (r.error) { notify('danger', r.error); return null; }
    if (okMsg) notify('success', okMsg);
    if (reload) { load(true); onChanged(); }
    return r;
  }
  async function pause(paused) {
    const r = await act('pause', { paused });
    if (r) notify('success', paused ? `Você assumiu a conversa${r.cancelled ? ` (${r.cancelled} fluxo(s) parado(s))` : ''}.` : 'Conversa devolvida para a automação.');
  }
  async function toggleTag(t, on) {
    setSt((s) => ({ ...s, lead: { ...s.lead, tags: on ? [...(s.lead.tags || []), t] : (s.lead.tags || []).filter((x) => x.id !== t.id) } }));
    const r = await KoblyApi.inbox('tags', { lead_id: leadId, [on ? 'add' : 'remove']: [t.id] }, orgId);
    if (r.error) { notify('danger', r.error); load(true); }
  }
  async function ring() {
    if (!(await askConfirm(`Vai tocar uma ligação no WhatsApp de ${nomeOf(st.lead)}. A chamada é muda: serve só para chamar a atenção. Use com moderação para evitar bloqueios.`, { title: 'Ligar pelo WhatsApp', confirmLabel: 'Ligar agora', danger: false }))) return;
    act('call', {}, 'Ligação enviada.', false);
  }
  async function clear() {
    if (!(await askConfirm('A conversa fica vazia aqui na Kobly, mas continua na sua lista e no WhatsApp. Mensagens novas aparecem normalmente.', { title: 'Limpar esta conversa?', confirmLabel: 'Limpar conversa', danger: true }))) return;
    act('clear', {}, 'Conversa limpa.');
  }
  async function archive() {
    const on = !st.lead.chat_archived_at;
    act('archive', { archived: on }, on ? 'Conversa arquivada. Ela volta sozinha se o contato mandar mensagem.' : 'Conversa desarquivada.');
  }
  async function openFlows() {
    setPop(null);
    setFlowPick({ loading: true, flows: [] });
    const r = await KoblyApi.inbox('flows', {}, orgId);
    setFlowPick({ loading: false, flows: (r && r.flows) || [], error: r && r.error });
  }
  async function startFlow(f) {
    setFlowPick(null);
    act('start_flow', { campaign_id: f.id }, `Fluxo "${f.nome}" disparado.`);
  }
  function insert(s) {
    const ta = taRef.current;
    if (!ta) { setText((t) => t + s); return; }
    const a = ta.selectionStart ?? text.length, b = ta.selectionEnd ?? text.length;
    const next = text.slice(0, a) + s + text.slice(b);
    setText(next);
    requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = a + s.length; });
  }

  if (st.loading && !st.lead) return <div className="kh-col" style={{ background: 'var(--wa-bg)', display: 'grid', placeItems: 'center', color: 'var(--wa-muted)' }}>Abrindo conversa…</div>;
  if (!st.lead) return <div className="kh-col" style={{ background: 'var(--wa-bg)', display: 'grid', placeItems: 'center', color: 'var(--pastel-pink)' }}>{st.error}</div>;
  const lead = st.lead;
  const slash = text.startsWith('/') ? text.slice(1).toLowerCase() : null;
  const sugest = slash !== null ? quickReplies.filter((q) => q.shortcut.toLowerCase().startsWith(slash)).slice(0, 8) : [];
  const has = new Set((lead.tags || []).map((t) => t.id));
  let lastDay = '', lastSide = '';

  return (
    <>
      <div className="kh-col" style={{ background: 'var(--wa-bg)' }}>
        <div className="kh-head">
          {onBack && <button type="button" className="kh-ic" onClick={onBack} aria-label="Voltar"><Icon name="arrow-left" size={20} /></button>}
          <button type="button" onClick={() => setSideOpen(!sideOpen)} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'none', border: 0, cursor: 'pointer', padding: 0, minWidth: 0, flex: 1, textAlign: 'left' }}>
            <Avatar name={nomeOf(lead)} src={lead.avatar_url} size={42} channel={lead.chat_channel} />
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 16, color: 'var(--wa-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{nomeOf(lead)}</span>
                {lead.automation_paused && <span className="kh-chip" style={{ color: '#fbbf24', background: 'rgba(251,191,36,.15)' }}><Icon name="hand" size={11} />Com humano</span>}
                {!lead.automation_paused && st.flows[0] && <span className="kh-chip" style={{ color: '#ffb27d', background: 'rgba(255,98,1,.18)' }}><Icon name="git-branch" size={11} />{st.flows[0].campanha}</span>}
                {(lead.tags || []).slice(0, 3).map((t) => <span key={t.id} className="kh-chip" style={{ color: 'var(--pastel-blue)', background: 'rgba(59,130,246,.2)' }}>{t.nome}</span>)}
              </div>
              <div style={{ fontSize: 13, color: 'var(--wa-muted)' }}>{lead.chat_channel === 'instagram' ? `Instagram${lead.ig_username ? ` · @${lead.ig_username}` : ''}` : lead.chat_channel === 'messenger' ? 'Messenger' : fmtPhone(lead.telefone)}</div>
            </div>
          </button>
          <div className="kh-acts">
            {canEdit && lead.telefone && <button type="button" className="kh-ic" title="Ligar (chamada muda)" onClick={ring}><Icon name="phone-call" size={19} /></button>}
            {canEdit && <button type="button" className="kh-ic" title="Disparar fluxo" onClick={openFlows}><Icon name="play" size={19} /></button>}
            {canEdit && (lead.automation_paused
              ? <button type="button" className="kh-ic on" title="Devolver para a automação" onClick={() => pause(false)}><Icon name="bot" size={19} /></button>
              : <button type="button" className="kh-ic" title="Assumir conversa (pausa os fluxos deste contato)" onClick={() => pause(true)}><Icon name="hand" size={19} /></button>)}
            {canEdit && <div style={{ position: 'relative' }} data-pop>
              <button type="button" className={`kh-ic${pop === 'tags' ? ' on' : ''}`} title="Etiquetas" onClick={() => setPop(pop === 'tags' ? null : 'tags')}><Icon name="tag" size={19} /></button>
              {pop === 'tags' && <div className="kh-drop">
                <h4>Etiquetas</h4>
                {!tags.length && <div style={{ padding: '4px 16px 8px', fontSize: 13, color: 'var(--wa-muted)' }}>Crie etiquetas em Integrações → Tags.</div>}
                {tags.map((t) => <label key={t.id}><input type="checkbox" checked={has.has(t.id)} onChange={() => toggleTag(t, !has.has(t.id))} style={{ accentColor: '#ff9452', width: 16, height: 16 }} />{t.nome}</label>)}
              </div>}
            </div>}
            {canEdit && <button type="button" className="kh-ic" title="Limpar conversa" onClick={clear}><Icon name="eraser" size={19} /></button>}
            {canEdit && <button type="button" className="kh-ic" title={lead.chat_archived_at ? 'Desarquivar' : 'Arquivar'} onClick={archive}><Icon name={lead.chat_archived_at ? 'archive-restore' : 'archive'} size={19} /></button>}
            {wide && <button type="button" className={`kh-ic${sideOpen ? ' on' : ''}`} title="Detalhes do contato" onClick={() => setSideOpen(!sideOpen)}><Icon name="user" size={19} /></button>}
          </div>
        </div>
        <div className="kh-msgs" ref={boxRef} onScroll={(e) => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120); }}>
          {count === 0 && <div className="kh-day">Sem mensagens ainda</div>}
          {st.messages.map((m) => {
            const dl = diaLabel(m.at); const sep = dl !== lastDay; lastDay = dl;
            const side = (DE[m.de] || DE.lead).mine ? 'mine' : 'lead';
            const first = sep || side !== lastSide; lastSide = side;
            return (
              <React.Fragment key={m.id}>
                {sep && <div className="kh-day">{dl}</div>}
                <Bubble m={m} first={first} fetcher={fetchMedia} onOpen={setLight} lead={lead} />
              </React.Fragment>
            );
          })}
          <div ref={endRef} />
        </div>
        {!atBottom && <button type="button" className="kh-scroll-btn" aria-label="Ir para o fim" onClick={() => { endRef.current && endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' }); setAtBottom(true); }}><Icon name="chevron-down" size={22} /></button>}
        {canEdit && (!lead.janela_aberta ? (
          <div style={{ padding: '14px 18px', background: 'var(--wa-in)', fontSize: 14, color: '#fbbf24' }}>{lead.chat_channel === 'instagram' || lead.chat_channel === 'messenger' ? `O ${lead.chat_channel === 'instagram' ? 'Instagram' : 'Messenger'} só deixa responder em até 24 h depois da última mensagem do contato. Quando ele escrever de novo, a conversa reabre.` : 'A API Oficial da Meta só deixa responder em até 24 h depois da última mensagem do contato. Dispare um fluxo com modelo aprovado para reabrir a conversa.'}</div>
        ) : (
          <div className="kh-compose">
            {sugest.length > 0 && <div className="kh-pop kh-quick">{sugest.map((q) => <button key={q.id} type="button" onClick={() => setText(q.body)}><b style={{ color: '#ff9452' }}>/{q.shortcut}</b> <span style={{ color: 'var(--wa-muted)' }}>{q.body.slice(0, 100)}</span></button>)}</div>}
            {pop === 'emoji' && <EmojiPicker onPick={insert} />}
            {pop === 'menu' && <div className="kh-pop kh-menu">
              <button type="button" onClick={() => { setPop(null); fileRef.current && (fileRef.current.accept = 'image/*,video/mp4'); fileRef.current && fileRef.current.click(); }}><span className="ico" style={{ background: '#007bfc' }}><Icon name="image" size={17} /></span>Fotos e vídeos</button>
              <button type="button" onClick={() => { setPop(null); fileRef.current && (fileRef.current.accept = '.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip,audio/*'); fileRef.current && fileRef.current.click(); }}><span className="ico" style={{ background: '#7f66ff' }}><Icon name="file-text" size={17} /></span>Documento ou áudio</button>
              <button type="button" onClick={() => { setPop(null); setText('/'); taRef.current && taRef.current.focus(); }}><span className="ico" style={{ background: '#ff6201' }}><Icon name="zap" size={17} /></span>Respostas rápidas</button>
              <button type="button" onClick={openFlows}><span className="ico" style={{ background: '#02a698' }}><Icon name="git-branch" size={17} /></span>Disparar fluxo</button>
            </div>}
            <input ref={fileRef} type="file" hidden onChange={(e) => { sendFile(e.target.files && e.target.files[0]); e.target.value = ''; }} />
            <button type="button" data-pop className={`kh-ic${pop === 'emoji' ? ' on' : ''}`} title="Emojis" onClick={() => setPop(pop === 'emoji' ? null : 'emoji')}><Icon name="smile" size={24} /></button>
            <button type="button" data-pop className={`kh-ic${pop === 'menu' ? ' on' : ''}`} title="Anexar e mais" disabled={busy} onClick={() => setPop(pop === 'menu' ? null : 'menu')}><Icon name="plus" size={24} style={{ transform: pop === 'menu' ? 'rotate(45deg)' : 'none', transition: 'transform .15s' }} /></button>
            <div className="kh-box">
              <textarea ref={taRef} value={text} rows={1} maxLength={4096} placeholder="Digite uma mensagem  ·  / respostas rápidas" onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (sugest.length && slash !== null) setText(sugest[0].body); else send(); } }} />
            </div>
            <button type="button" className="kh-send" disabled={busy || !text.trim()} onClick={send} aria-label="Enviar"><Icon name={busy ? 'loader-circle' : 'send-horizontal'} size={22} /></button>
          </div>
        ))}
      </div>
      {wide && sideOpen && <div className={`kh-col r${roomy ? '' : ' drawer'}`}><LeadSide key={lead.id} lead={lead} flows={st.flows} tags={tags} canEdit={canEdit} msgs={st.messages} onToggleTag={toggleTag} onClose={() => setSideOpen(false)}
        onNotes={(t) => act('notes', { text: t }, 'Nota salva.')} onArchive={archive} /></div>}
      {light && <div className="kh-light" onClick={() => setLight(null)}>
        <button type="button" className="kh-ic" style={{ position: 'absolute', top: 18, right: 18 }} aria-label="Fechar"><Icon name="x" size={24} /></button>
        <a href={light.url} target="_blank" rel="noreferrer" className="kh-ic" style={{ position: 'absolute', top: 18, right: 66 }} onClick={(e) => e.stopPropagation()} aria-label="Baixar"><Icon name="download" size={22} /></a>
        <img src={light.url} alt="" onClick={(e) => e.stopPropagation()} />
      </div>}
      {flowPick && <div className="kh-modal" onClick={() => setFlowPick(null)}><div onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '16px 18px' }}><b style={{ flex: 1, color: 'var(--wa-text)', fontSize: 16 }}>Disparar fluxo para {nomeOf(lead)}</b><button type="button" className="kh-ic" onClick={() => setFlowPick(null)} aria-label="Fechar"><Icon name="x" size={18} /></button></div>
        {flowPick.loading && <div style={{ padding: '6px 18px 18px', color: 'var(--wa-muted)' }}>Carregando fluxos…</div>}
        {!flowPick.loading && !flowPick.flows.length && <div style={{ padding: '6px 18px 18px', color: 'var(--wa-muted)', fontSize: 14 }}>{flowPick.error || 'Nenhum fluxo publicado ainda. Publique um fluxo no editor primeiro.'}</div>}
        {flowPick.flows.map((f) => <button key={f.id} type="button" className="opt" onClick={() => startFlow(f)}><Icon name="git-branch" size={17} style={{ color: '#ff9452' }} /><span style={{ flex: 1 }}>{f.nome}</span>{f.status !== 'Ativa' && <span style={{ fontSize: 12, color: 'var(--wa-muted)' }}>{f.status}</span>}</button>)}
      </div></div>}
    </>
  );
}

function KoblyChats() {
  const store = useKobly();
  const { isMobile } = useBreakpoint();
  const { orgId, picker, canEdit } = useTargetOrg();
  const [q, setQ] = useState('');
  const [filtro, setFiltro] = useState('todas');
  const [rede, setRede] = useState('');
  const [conexao, setConexao] = useState('');
  const [list, setList] = useState({ loading: true, error: null, items: [], arquivadas: 0, conexoes: [] });
  const [sel, setSel] = useState(null);
  const [avatars, setAvatars] = useState({});
  const asked = useRef(new Set());
  // vindo do Pipeline: abre a conversa daquele lead (lido uma vez, num efeito)
  useEffect(() => { try { const s = sessionStorage.getItem('kobly:chat-lead'); if (s) { sessionStorage.removeItem('kobly:chat-lead'); setSel(s); } } catch { /* ok */ } }, []);
  const [quick, setQuick] = useState([]);
  const [tags, setTags] = useState([]);
  const [wide, setWide] = useState(() => typeof window === 'undefined' || window.innerWidth > 900);
  // tela larga: detalhes ficam ao lado; tela média: abrem por cima da conversa (botão do contato)
  const [roomy, setRoomy] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1600);
  const [sideOpen, setSideOpen] = useState(roomy);
  useEffect(() => { const f = () => { setWide(window.innerWidth > 900); setRoomy(window.innerWidth >= 1600); }; f(); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);

  const load = useCallback(async (quiet = false) => {
    if (!orgId) { setList({ loading: false, error: null, items: [], arquivadas: 0, conexoes: [] }); return; }
    if (!quiet) setList((s) => ({ ...s, loading: true }));
    const r = await KoblyApi.inbox('list', { q, filtro, rede, conexao }, orgId);
    setList((s) => ({ loading: false, error: r && r.error, items: (r && r.conversations) || [], arquivadas: (r && r.arquivadas) || 0, conexoes: (r && r.conexoes) || s.conexoes || [] }));
  }, [orgId, q, filtro, rede, conexao]);
  useEffect(() => { const t = setTimeout(() => load(), q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { const t = setInterval(() => load(true), POLL_MS); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    if (!orgId) return;
    KoblyApi.workspaceSettings('get', {}, orgId).then((r) => setQuick((r && r.quick_replies) || [])).catch(() => {});
    KoblyApi.getTags().then((t) => setTags(t || [])).catch(() => {});
  }, [orgId]);
  // fotos do WhatsApp: pede as que faltam, em lotes, uma vez por contato
  useEffect(() => {
    if (!orgId) return;
    const miss = list.items.filter((c) => !c.avatar_url && !asked.current.has(c.lead_id)).slice(0, 25).map((c) => c.lead_id);
    if (!miss.length) return;
    miss.forEach((id) => asked.current.add(id));
    KoblyApi.inbox('avatars', { lead_ids: miss }, orgId).then((r) => { if (r && r.avatars) setAvatars((a) => ({ ...a, ...r.avatars })); }).catch(() => {});
  }, [list.items, orgId]);
  const naoResp = useMemo(() => list.items.filter((c) => c.ultima_de === 'lead').length, [list.items]);
  // nome de cada conexão para a etiqueta da conversa; só aparece quando a empresa tem mais de uma
  const connByKey = useMemo(() => Object.fromEntries((list.conexoes || []).map((c) => [c.key, c])), [list.conexoes]);
  const connsDaRede = useMemo(() => (list.conexoes || []).filter((c) => !rede || c.rede === rede), [list.conexoes, rede]);
  const muitas = (list.conexoes || []).length > 1;
  function escolherRede(id) { setRede(id); setConexao((k) => (k && connByKey[k] && id && connByKey[k].rede !== id ? '' : k)); }

  const listPane = (
    <div className="kh-col l">
      <div className="kh-top">
        <div className="kh-title">
          <ChannelLogo kind="qr" size={30} />
          <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 19, color: 'var(--wa-text)' }}>Conversas</div><div style={{ fontSize: 12, color: 'var(--wa-muted)' }}>{naoResp ? `${naoResp} esperando resposta` : 'Tudo respondido'}</div></div>
        </div>
        <div className="kh-search"><Icon name="search" size={16} style={{ color: 'var(--wa-muted)' }} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pesquisar nome, telefone ou e-mail" />{q && <button type="button" className="kh-ic" style={{ width: 24, height: 24 }} onClick={() => setQ('')} aria-label="Limpar busca"><Icon name="x" size={14} /></button>}</div>
        <div className="kh-redes" role="tablist" aria-label="Rede">
          {REDES.map(([id, label, logo]) => (
            <button key={id || 'todas'} type="button" role="tab" aria-selected={rede === id} title={label} className={`kh-rede${rede === id ? ' on' : ''}`} onClick={() => escolherRede(id)}>
              {logo ? <ChannelLogo kind={logo} size={16} /> : <Icon name="layers" size={15} />}<span className="t">{label}</span>
            </button>
          ))}
        </div>
        {connsDaRede.length > 1 && (
          <label className="kh-connsel">
            {conexao && connByKey[conexao] ? <ChannelLogo kind={CONN_LOGO[connByKey[conexao].kind]} size={16} /> : <Icon name="plug" size={15} style={{ color: 'var(--wa-muted)' }} />}
            <select value={conexao} onChange={(e) => setConexao(e.target.value)} aria-label="Conexão">
              <option value="">{rede ? `Todas as conexões de ${REDES.find((r) => r[0] === rede)[1]}` : 'Todas as conexões'} ({connsDaRede.length})</option>
              {connsDaRede.map((c) => <option key={c.key} value={c.key}>{c.nome} · {c.detalhe}{c.conectado ? '' : ' (desconectado)'}</option>)}
            </select>
            <Icon name="chevron-down" size={15} className="chev" />
          </label>
        )}
        <div className="kh-filters">{FILTROS.map(([id, label]) => <button key={id} type="button" className={`kh-f${filtro === id ? ' on' : ''}`} onClick={() => setFiltro(id)}>{label}{id === 'arquivadas' && list.arquivadas > 0 && <span className="n">{list.arquivadas}</span>}</button>)}</div>
      </div>
      <div className="kh-list">
        {list.loading && !list.items.length ? <div style={{ padding: 20, color: 'var(--wa-muted)' }}>Carregando…</div>
          : list.items.length === 0 ? <div style={{ padding: 28, textAlign: 'center', color: 'var(--wa-muted)', fontSize: 14 }}>{orgId ? (filtro === 'todas' && !rede && !conexao ? 'Quando alguém mandar mensagem para o seu WhatsApp, Instagram ou Messenger, a conversa aparece aqui.' : 'Nenhuma conversa neste filtro.') : 'Escolha a conta do cliente acima.'}</div>
          : list.items.map((c) => {
            const t = TIPO[c.ultima_tipo];
            const de = DE[c.ultima_de];
            const cx = muitas && c.conn_kind && connByKey[`${c.conn_kind}:${c.conn_id}`];
            return (
              <button key={c.lead_id} type="button" className={`kh-item${sel === c.lead_id ? ' on' : ''}`} onClick={() => setSel(c.lead_id)}>
                <Avatar name={nomeOf(c)} src={c.avatar_url || avatars[c.lead_id]} channel={c.chat_channel} />
                <div className="bd">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                    <span className="kh-name">{nomeOf(c)}</span>
                    <span style={{ fontSize: 12, color: c.nao_lidas ? '#25d366' : 'var(--wa-muted)', flex: 'none' }}>{rel(c.ultima_em)}</span>
                  </div>
                  {cx && <div style={{ marginTop: 2 }}><span className="kh-conn" title={`Conexão: ${cx.nome} · ${cx.detalhe}`}><ChannelLogo kind={CONN_LOGO[cx.kind]} size={11} />{cx.nome}</span></div>}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
                    <div className="kh-prev" style={{ flex: 1 }}>
                      {de && de.mine && <Icon name="check-check" size={15} style={{ color: '#53bdeb', flex: 'none' }} />}
                      {t && <Icon name={t[0]} size={14} style={{ flex: 'none' }} />}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t && (!c.ultima || /^\[/.test(c.ultima)) ? t[1] : (c.ultima || '')}</span>
                    </div>
                    {c.automation_paused && <Icon name="hand" size={14} style={{ color: '#fbbf24', flex: 'none' }} />}
                    {c.em_fluxo && !c.automation_paused && <Icon name="git-branch" size={14} style={{ color: '#ff9452', flex: 'none' }} />}
                    {c.nao_lidas > 0 && <span className="kh-unread">{c.nao_lidas > 99 ? '99+' : c.nao_lidas}</span>}
                  </div>
                </div>
              </button>
            );
          })}
      </div>
    </div>
  );
  const conv = sel
    ? <Conversation key={sel} orgId={orgId} leadId={sel} quickReplies={quick} tags={tags} canEdit={canEdit} notify={store.notify} onChanged={() => load(true)}
      onBack={isMobile ? () => setSel(null) : null} wide={wide && !isMobile} roomy={roomy} sideOpen={sideOpen} setSideOpen={setSideOpen} />
    : <div className="kh-empty"><div><ChannelLogo kind="qr" size={64} /><div style={{ fontSize: 28, fontWeight: 300, color: 'var(--wa-text)', marginTop: 18 }}>Kobly Conversas</div><div style={{ color: 'var(--wa-muted)', fontSize: 14, marginTop: 10, maxWidth: 420, lineHeight: 1.5 }}>Escolha uma conversa para ver o que o contato mandou, ouvir os áudios, responder ou disparar um fluxo.</div></div></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <style>{KH_CSS}</style>
      {picker}
      <div className={`kh-shell${isMobile ? ' one' : !(sel && wide && sideOpen && roomy) ? ' two' : ''}`}>
        {isMobile ? (sel ? conv : listPane) : (<>{listPane}{conv}</>)}
      </div>
    </div>
  );
}

export { KoblyChats };
