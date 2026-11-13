// Prévia das janelas de conexão SEM backend (só desenvolvimento: /connect-preview.html).
// "Conectar Instagram" e "Conectar WhatsApp com um clique". ?wa=1 abre a do WhatsApp.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/index.css';
import { KoblyApi } from '../api/mockApi.js';
import { MetaConnect, KC_CSS } from '../routes/Connections.jsx';
import { ConnectForm } from '../routes/WhatsappMeta.jsx';
import { Modal } from '../lib/ui.jsx';
import { initI18n } from '../lib/i18n.js';

// respostas falsas do servidor
KoblyApi.metaChannels = async (action) => {
  if (action === 'oauth_status') return { enabled: true, ig_enabled: true };
  if (action === 'ig_oauth_start') return { url: 'about:blank' };
  return { error: null };
};
KoblyApi.whatsappAccount = async (action) => {
  if (action === 'embedded_config') return { enabled: true, app_id: '1550449143065379', config_id: '123', graph_version: 'v21.0' };
  return { error: 'só prévia' };
};

function Preview() {
  const [log, setLog] = useState([]);
  const [want, setWant] = useState(() => (new URLSearchParams(location.search).get('wa') ? 'whatsapp' : 'instagram'));
  return (
    <div style={{ padding: 16, background: 'var(--surface-app)', minHeight: '100vh' }}>
      <style>{KC_CSS}</style>
      {want === 'whatsapp' ? <ConnectForm empresaId={null} onDone={() => setLog((l) => [...l, 'pronto'])} /> : (
        <Modal open onClose={() => {}} title={want === 'messenger' ? 'Conectar Messenger' : 'Conectar Instagram'} subtitle="Direct, comentários e stories na Kobly, com fluxos e IA." width={540}>
          <MetaConnect key={want} empresaId={null} want={want} notify={(t, m) => setLog((l) => [...l.slice(-3), `${t}: ${m}`])} onDone={() => setLog((l) => [...l, 'pronto'])} onClose={() => {}} />
        </Modal>
      )}
      <div id="preview-log" style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 12 }}>{log.join(' · ')}</div>
    </div>
  );
}
initI18n().finally(() => createRoot(document.getElementById('root')).render(<Preview />));
