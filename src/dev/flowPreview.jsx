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
    { ref: 'ia', type: 'ai_classify', data: { input: '{{resposta}}', outputs: [{ key: 'sim', description: 'aceitou' }, { key: 'oxxo', description: 'quer pagar no OXXO' }, { key: 'nao', description: 'recusou' }] }, next: { out_sim: 'pg', out_oxxo: 'pg', out_nao: 'ag' }, position: { x: 900, y: 40 } },
    { ref: 'ag', type: 'ai_agent', data: { objective: 'Entender a objeção e oferecer o OXXO.', knowledge: 'Guia de 50 receitas, PDF na hora, $120 MXN.', max_turns: 6, timeout_minutes: 60 }, next: { done: 'pg', handoff: 'al', expiration: 'hc' }, position: { x: 1200, y: 320 } },
    { ref: 'al', type: 'notify', data: { channel_id: 'tg-1', text: '🙋 {{nome}} pediu atendimento humano' }, next: { default: 'fim' }, position: { x: 1500, y: 420 } },
    { ref: 'hc', type: 'wait_until', data: { mode: 'business_hours', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }, next: { default: 'tpl' }, position: { x: 1500, y: 260 } },
    { ref: 'pg', type: 'payment', data: { integration_id: 'int-1', currency: 'MXN', method: 'OXXO', amount: '120', listen_hours: 48 }, next: { charge_created: 'cod', payment_approved: 'venda', error: 'fim' }, position: { x: 1200, y: 0 } },
    { ref: 'cod', type: 'send_text', data: { text: 'Aquí tienes tu referencia OXXO: {{pagamento_codigo}}' }, next: { sent: 'fim' }, position: { x: 1500, y: -80 } },
    { ref: 'venda', type: 'record_sale', data: {}, next: { default: 'px' }, position: { x: 1500, y: 80 } },
    { ref: 'px', type: 'pixel', data: { pixel_config_id: 'px-1', event: 'Purchase' }, next: { default: 'pdf' }, position: { x: 1800, y: 80 } },
    { ref: 'pdf', type: 'send_media', data: { kind: 'document', url: 'https://cdn.exemplo.test/guia.pdf', caption: 'Seu guia' }, next: { sent: 'fim' }, position: { x: 2100, y: 80 } },
    { ref: 'fim', type: 'end', data: {}, next: {}, position: { x: 2400, y: 120 } },
  ],
};
const rascunhoIA = JSON.parse(JSON.stringify(exemplo));
rascunhoIA.nodes.find((n) => n.ref === 'esp').data.timeout_minutes = 360; // a IA sugeriu esperar 6 h
const versions = [
  { version: 1, graph: exemplo, is_active: true, is_draft: false, source: 'editor', created_at: new Date().toISOString() },
  { version: 2, graph: rascunhoIA, is_active: false, is_draft: true, source: 'mcp', note: 'lembrete em 6 h para quem não respondeu', created_at: new Date().toISOString() },
];
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
    if (action === 'activate') {
      const v = versions.find((y) => y.version === x.version); const chk = validateGraph(v.graph);
      if (!chk.ok) return { error: chk.errors[0], details: chk };
      versions.forEach((y) => { y.is_active = y.version === x.version; if (y.is_active) y.is_draft = false; }); return { error: null, ok: true };
    }
    if (action === 'get_version') { const v = versions.find((y) => y.version === x.version); return v ? { error: null, ...v } : { error: 'Versão não encontrada.' }; }
    if (action === 'save_draft') {
      const chk = validateGraph(x.graph); if (!chk.ok) return { error: chk.errors[0], details: chk };
      versions.push({ version: versions.length + 1, graph: JSON.parse(JSON.stringify(x.graph)), is_active: false, is_draft: true, source: 'editor', note: x.note, created_at: new Date().toISOString() });
      return { error: null, ok: true, version: versions.length, draft: true, warnings: chk.warnings };
    }
    if (action === 'copilot') {
      const { analyzeFlow } = await import('../../server/src/flows/copilot.js');
      const byNode = [['tpl', 'sent', 212], ['esp', 'reply', 74], ['esp', 'timeout', 131], ['ia', 'out_sim', 60], ['ia', 'out_oxxo', 36], ['ia', 'out_nao', 31], ['ia', 'other', 14],
        ['pg', 'charge_created', 90], ['pg', 'error', 6], ['pg', 'payment_approved', 41], ['ag', 'done', 12], ['ag', 'handoff', 4], ['ag', 'expiration', 22]].map(([ref, outcome, leads]) => ({ ref, outcome, leads }));
      return { error: null, leads: 212, suggestions: analyzeFlow(active.graph, byNode), summary: 'Prioridade: 64% não respondem ao primeiro modelo — ligue "Sem resposta" a um lembrete. Depois, só 46% das cobranças OXXO são pagas: lembre em algumas horas e ofereça SPEI.' };
    }
    if (action === 'deactivate') { versions.forEach((y) => { y.is_active = false; }); return { error: null, ok: true }; }
    if (action === 'stats') return { error: null, by_status: [{ status: 'completed', n: 180 }, { status: 'waiting', n: 32 }],
      by_ref: [['ini', 212], ['tpl', 212], ['esp', 205], ['ia', 141], ['pg', 96], ['cod', 94], ['venda', 41], ['px', 41], ['ag', 38], ['al', 4]].map(([ref, leads]) => ({ ref, leads })),
      waiting_at: [{ ref: 'esp', leads: 21 }, { ref: 'ag', leads: 11 }] };
    return { error: 'ação desconhecida' };
  },
  listTemplates: async () => [
    { id: 't1', name: 'recuperacao_pix', language: 'pt_BR', status: 'APPROVED', variable_count: 2 },
    { id: 't2', name: 'lembrete_oxxo', language: 'es_MX', status: 'APPROVED', variable_count: 1 },
  ],
  getTags: async () => [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nome: 'Lead quente' }, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', nome: 'PARTE 1' }],
  listIntegrations: async () => [{ id: 'int-1', provider: 'xpag', label: 'México', sandbox: true, status: 'connected' }],
  listPixels: async () => [{ id: 'px-1', label: 'Pixel principal', pixel_id: '1234567890' }],
  listChannels: async () => [{ id: 'tg-1', label: '@vendas_bot', default_chat_id: '-1001234567890' }],
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
