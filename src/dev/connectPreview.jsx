// Prévia da janela "Conectar Instagram" SEM backend (só desenvolvimento: /connect-preview.html).
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/index.css';
import { KoblyApi } from '../api/mockApi.js';
import { MetaConnect, KC_CSS } from '../routes/Connections.jsx';
import { Modal } from '../lib/ui.jsx';
import { initI18n } from '../lib/i18n.js';

// respostas falsas do servidor: login do Instagram ligado
KoblyApi.metaChannels = async (action) => {
  if (action === 'oauth_status') return { enabled: true, ig_enabled: true };
  if (action === 'ig_oauth_start') return { url: 'about:blank' };
  return { error: null };
};

function Preview() {
  const [log, setLog] = useState([]);
  const [want, setWant] = useState('instagram');
  return (
    <div style={{ padding: 16, background: 'var(--surface-app)', minHeight: '100vh' }}>
      <style>{KC_CSS}</style>
      <Modal open onClose={() => {}} title={want === 'messenger' ? 'Conectar Messenger' : 'Conectar Instagram'} subtitle="Conversas do Direct e da página do Facebook no Chat ao vivo." width={540}>
        <MetaConnect key={want} empresaId={null} want={want} notify={(t, m) => setLog((l) => [...l.slice(-3), `${t}: ${m}`])} onDone={() => setLog((l) => [...l, 'pronto'])} onClose={() => {}} />
      </Modal>
      <button type="button" onClick={() => setWant(want === 'instagram' ? 'messenger' : 'instagram')}>trocar</button>
      <div id="preview-log" style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 12 }}>{log.join(' · ')}</div>
    </div>
  );
}
initI18n().finally(() => createRoot(document.getElementById('root')).render(<Preview />));
