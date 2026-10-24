// Prévia do editor de fluxo em grafo SEM backend (só desenvolvimento: /flow-preview.html).
// Usa o validador REAL do servidor e guarda as versões em memória.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/index.css';
import { KoblyFlowGraphEditor } from '../routes/FlowGraphEditor.jsx';
import { validateGraph } from '../../server/src/flows/graph.js';

const exemplo = {
  version: 1, start: 'ini', nodes: [
    { ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado', 'Compra Recusada'] }, next: { default: 'tpl' }, position: { x: 0, y: 120 } },
    { ref: 'tpl', type: 'send_template', data: { template_id: 't1', vars: ['primeiro_nome', 'produto'] }, next: { sent: 'esp' }, position: { x: 300, y: 80 } },
    { ref: 'esp', type: 'wait_reply', data: { save_as: 'resposta', timeout_minutes: 1380 }, next: { reply: 'ia', timeout: 'fim' }, position: { x: 600, y: 80 } },
    { ref: 'ia', type: 'ai_classify', data: { input: '{{resposta}}', outputs: [{ key: 'sim', description: 'aceitou' }, { key: 'oxxo', description: 'quer pagar no OXXO' }, { key: 'nao', description: 'recusou' }] }, next: { out_sim: 'pdf', out_nao: 'fim' }, position: { x: 900, y: 40 } },
    { ref: 'pdf', type: 'send_media', data: { kind: 'document', url: 'https://cdn.exemplo.test/guia.pdf', caption: 'Seu guia' }, next: { sent: 'fim' }, position: { x: 1200, y: 0 } },
    { ref: 'fim', type: 'end', data: {}, next: {}, position: { x: 1500, y: 120 } },
  ],
};
const versions = [{ version: 1, graph: exemplo, is_active: true, created_at: new Date().toISOString() }];
const fakeApi = {
  async flowGraph(action, x) {
    await new Promise((r) => setTimeout(r, 150));
    const active = versions.find((v) => v.is_active);
    if (action === 'get') return { error: null, active: active ? { version: active.version, graph: active.graph } : null, versions: versions.map(({ graph, ...v }) => v).reverse() };
    if (action === 'validate') return { error: null, ...validateGraph(x.graph) };
    if (action === 'save') {
      const v = validateGraph(x.graph);
      if (!v.ok) return { error: v.errors[0], details: v };
      versions.forEach((y) => { y.is_active = false; });
      versions.push({ version: versions.length + 1, graph: JSON.parse(JSON.stringify(x.graph)), is_active: true, created_at: new Date().toISOString() });
      return { error: null, ok: true, version: versions.length, warnings: v.warnings };
    }
    if (action === 'activate') { versions.forEach((y) => { y.is_active = y.version === x.version; }); return { error: null, ok: true }; }
    if (action === 'deactivate') { versions.forEach((y) => { y.is_active = false; }); return { error: null, ok: true }; }
    return { error: 'ação desconhecida' };
  },
  listTemplates: async () => [
    { id: 't1', name: 'recuperacao_pix', language: 'pt_BR', status: 'APPROVED', variable_count: 2 },
    { id: 't2', name: 'lembrete_oxxo', language: 'es_MX', status: 'APPROVED', variable_count: 1 },
  ],
  getTags: async () => [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nome: 'Lead quente' }, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', nome: 'PARTE 1' }],
};

function Preview() {
  const [log, setLog] = useState([]);
  return (
    <div style={{ padding: 16, background: 'var(--surface-app)', minHeight: '100vh' }}>
      <KoblyFlowGraphEditor campaign={{ id: 'c1', nome: 'Recuperação Pix — México' }} api={fakeApi} onBack={() => setLog((l) => [...l, 'voltar'])}
        notify={(tone, msg) => setLog((l) => [...l.slice(-3), `${tone}: ${msg}`])} />
      <div id="preview-log" style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 12 }}>{log.join(' · ')}</div>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Preview />);
