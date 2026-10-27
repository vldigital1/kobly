import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Card, Icon, Input } from '@/ds';
import { SkeletonTable } from '@/lib/ui.jsx';

// Kobly — Integrações → Voz (ElevenLabs). Cada cliente conecta a PRÓPRIA chave da ElevenLabs: os blocos de
// áudio geram a fala a partir de um texto e a tradução de fluxo regrava os áudios no novo idioma.
// Os créditos de voz ficam na conta do cliente. KoblyVoiceTab

const STEPS = [
  ['Crie a sua conta na ElevenLabs', 'Entre em elevenlabs.io e crie uma conta (o plano gratuito serve para testar; para usar nos fluxos, um plano pago dá mais minutos).'],
  ['Abra as chaves de API', 'No canto de baixo à esquerda, clique no seu nome → API Keys (ou Developers → API Keys).'],
  ['Crie a chave', 'Clique em Create API Key, dê o nome Kobly e deixe ligados Text to Speech, Speech to Text e Voices. Copie a chave (começa com sk_).'],
  ['Cole aqui e escolha a voz', 'Cole a chave no campo abaixo e clique em Conectar. Depois escolha a voz que vai falar nos seus áudios.'],
];

function ElevenLogo({ size = 44 }) {
  return (
    <span aria-label="ElevenLabs" style={{ width: size, height: size, borderRadius: 12, background: '#000', border: '1px solid rgba(255,255,255,.15)', display: 'grid', placeItems: 'center', flex: 'none' }}>
      <svg width={size * 0.42} height={size * 0.42} viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="2" width="3.2" height="16" rx="1" fill="#fff" /><rect x="11.8" y="2" width="3.2" height="16" rx="1" fill="#fff" /></svg>
    </span>
  );
}

function KoblyVoiceTab({ empresaId, notify = () => {} }) {
  const [st, setSt] = useState({ loading: true });
  const [key, setKey] = useState('');
  const [voices, setVoices] = useState(null);
  const [busy, setBusy] = useState(false);
  const audio = useRef(null);
  const [playing, setPlaying] = useState(null);

  const load = useCallback(async () => {
    const r = await KoblyApi.voice('status', {}, empresaId);
    setSt({ loading: false, ...r });
    if (r.connected) { const v = await KoblyApi.voice('voices', {}, empresaId); if (!v.error) setVoices(v.voices); }
  }, [empresaId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { if (audio.current) audio.current.pause(); }, []);

  async function connect() {
    setBusy(true);
    const r = await KoblyApi.voice('connect', { api_key: key }, empresaId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    setKey(''); notify('success', 'ElevenLabs conectada! Agora escolha a voz.'); load();
  }
  async function remove() {
    setBusy(true);
    const r = await KoblyApi.voice('remove', {}, empresaId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    setVoices(null); load();
  }
  async function pick(v) {
    const r = await KoblyApi.voice('set_voice', { voice_id: v.voice_id, voice_name: v.name }, empresaId);
    if (r.error) { notify('danger', r.error); return; }
    setSt((s) => ({ ...s, voice_id: v.voice_id, voice_name: v.name }));
  }
  function preview(v) {
    if (audio.current) audio.current.pause();
    if (playing === v.voice_id || !v.preview_url) { setPlaying(null); return; }
    audio.current = new Audio(v.preview_url);
    audio.current.onended = () => setPlaying(null);
    audio.current.play().catch(() => setPlaying(null));
    setPlaying(v.voice_id);
  }

  if (st.loading) return <SkeletonTable rows={3} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <ElevenLogo />
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>Voz com ElevenLabs</div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Transforme texto em áudio com voz natural nos seus fluxos e traduza um fluxo inteiro (textos e áudios) para outro idioma com um clique.</div>
            </div>
            {st.connected && <Badge tone={st.status === 'error' ? 'danger' : 'success'}>{st.status === 'error' ? 'Chave com problema' : `Conectada · ${st.key_hint}`}</Badge>}
          </div>
          {st.connected && st.status === 'error' && <Banner tone="danger">{st.last_error}</Banner>}

          {!st.connected && (<>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              {STEPS.map(([t, d], i) => (
                <div key={t} style={{ display: 'flex', gap: 10, padding: 12, borderRadius: 12, border: '1px solid var(--border-subtle)' }}>
                  <span style={{ flex: 'none', width: 26, height: 26, borderRadius: 8, display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 13, color: '#1b0d02', background: 'linear-gradient(135deg, #f39200, #ff6201)' }}>{i + 1}</span>
                  <div><div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', fontSize: 'var(--text-sm)' }}>{t}</div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.5 }}>{d}</div></div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Input label="Chave da ElevenLabs" type="password" autoComplete="off" placeholder="sk_..." value={key} onChange={(e) => setKey(e.target.value)} style={{ flex: 1, minWidth: 260 }} />
              <Button variant="primary" iconLeft="plug" disabled={busy || key.trim().length < 20} onClick={connect}>{busy ? 'Conferindo…' : 'Conectar'}</Button>
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>A chave fica guardada cifrada. Os minutos de voz são cobrados na sua conta da ElevenLabs, não na Kobly.</div>
          </>)}

          {st.connected && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="ghost" iconLeft="unplug" disabled={busy} onClick={remove}>Desconectar</Button>
            </div>
          )}
        </div>
      </Card>

      {st.connected && (
        <Card title="Voz dos seus áudios" subtitle={st.voice_name ? `Escolhida: ${st.voice_name}. Clique no play para ouvir e em Usar para trocar.` : 'Escolha a voz que vai falar nos áudios dos fluxos.'}>
          {!voices ? <SkeletonTable rows={3} /> : (
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
              {voices.map((v) => {
                const on = v.voice_id === st.voice_id;
                return (
                  <div key={v.voice_id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 12,
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'}`, background: on ? 'var(--accent-soft)' : 'transparent' }}>
                    <button type="button" aria-label={`Ouvir ${v.name}`} onClick={() => preview(v)} disabled={!v.preview_url}
                      style={{ width: 34, height: 34, borderRadius: 10, border: 0, cursor: 'pointer', display: 'grid', placeItems: 'center', background: 'var(--accent)', color: '#1b0d02', flex: 'none', opacity: v.preview_url ? 1 : 0.4 }}>
                      <Icon name={playing === v.voice_id ? 'pause' : 'play'} size={15} />
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.name}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>{v.descricao || v.category || ' '}</div>
                    </div>
                    {on ? <Badge tone="success">Em uso</Badge> : <Button size="sm" variant="secondary" onClick={() => pick(v)}>Usar</Button>}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {st.connected && (
        <Card title="Como usar nos fluxos">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-body)', lineHeight: 1.6 }}>
            <div><b>Áudio com voz:</b> no editor de fluxo, adicione o bloco Enviar mídia, escolha Áudio e clique em "Gerar com voz". Escreva o texto e a Kobly cria o áudio.</div>
            <div><b>Traduzir um fluxo:</b> na lista de Fluxos, clique em "Traduzir" no fluxo, escolha o idioma e pronto. A Kobly cria uma cópia com os textos traduzidos (pela sua chave de IA) e os áudios regravados nesta voz. O fluxo original não muda.</div>
          </div>
        </Card>
      )}
    </div>
  );
}

export { KoblyVoiceTab };
