import React, { useEffect, useRef, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';

// Foto do contato no WhatsApp (ou as iniciais coloridas quando não há foto), usada no Pipeline, em Leads e no Chat.
// useLeadAvatars busca no servidor, em lotes, as fotos que ainda faltam — uma vez por contato.

const ini = (s) => String(s || '?').replace(/^\+/, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
export const hueOf = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };

export function LeadAvatar({ name, src, size = 40, ring = null, dot = null }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [src]);
  const h = hueOf(name);
  const img = src && !bad;
  return (
    <span style={{ position: 'relative', width: size, height: size, flex: 'none', display: 'inline-grid' }}>
      <span style={{ width: size, height: size, borderRadius: '50%', display: 'grid', placeItems: 'center', overflow: 'hidden', fontWeight: 700, fontSize: Math.round(size * 0.36), color: '#fff',
        background: img ? '#2a3942' : `linear-gradient(135deg, hsl(${h} 55% 45%), hsl(${(h + 40) % 360} 60% 32%))`, boxShadow: ring ? `0 0 0 2px #0c0e16, 0 0 0 4px ${ring}` : 'none' }}>
        {img ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBad(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : ini(name)}
      </span>
      {dot && <span style={{ position: 'absolute', right: -1, bottom: -1, width: Math.max(10, size * 0.28), height: Math.max(10, size * 0.28), borderRadius: '50%', background: dot, border: '2px solid #0c0e16' }} />}
    </span>
  );
}

export function useLeadAvatars(orgId, leads) {
  const [map, setMap] = useState({});
  const asked = useRef(new Set());
  useEffect(() => { asked.current = new Set(); setMap({}); }, [orgId]);
  useEffect(() => {
    if (!orgId || !leads || !leads.length) return;
    const miss = leads.filter((l) => l && l.id && !l.avatar_url && l.telefone && !asked.current.has(l.id)).slice(0, 25).map((l) => l.id);
    if (!miss.length) return;
    miss.forEach((id) => asked.current.add(id));
    KoblyApi.inbox('avatars', { lead_ids: miss }, orgId).then((r) => { if (r && r.avatars) setMap((m) => ({ ...m, ...r.avatars })); }).catch(() => {});
  }, [orgId, leads]);
  return (l) => (l && (l.avatar_url || map[l.id])) || null;
}

// baixa um texto como arquivo (planilha CSV)
export function downloadText(name, text, type = 'text/csv;charset=utf-8') {
  const blob = new Blob(['﻿', text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
