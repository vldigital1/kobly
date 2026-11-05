// Importar fluxo por arquivo: Kobly (.json exportado aqui), ZapData (.json/.zip) e Leona (.json).
// Converte cada formato para o grafo da Kobly ({ version: 1, start, nodes: [{ ref, type, data, next, position }] }).
// O que não tem equivalente vira um bloco "Contador" com o aviso e entra na lista de pendências.
// Etiquetas chegam por NOME (tag_name / add_names); a tela troca pelo id da conta (criando se faltar) antes de salvar.
import JSZip from 'jszip';

const REF = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || `b_${Math.random().toString(36).slice(2, 8)}`;
const VAR = (s) => { let v = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_]/g, '_').replace(/^_+/, ''); if (!/^[a-z]/.test(v)) v = `v_${v}`; return v.slice(0, 40) || 'resposta'; };
const KEY = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'opcao';
const secs = (v, unit) => Math.round(Number(v || 0) * ({ minutes: 60, hours: 3600, days: 86400 }[unit] || 1));
const mins = (v, unit) => Math.max(1, Math.round(secs(v, unit || 'hours') / 60));
const https = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');

// variáveis com nome diferente na Kobly
const VAR_MAP = {
  pix_copia_cola: 'pagamento_codigo', spei_clabe: 'pagamento_codigo', oxxo_referencia: 'pagamento_codigo', codi_codigo: 'pagamento_codigo', cop_llave: 'pagamento_codigo', ars_cvu: 'pagamento_codigo',
  pix_valor: 'pagamento_valor', spei_valor: 'pagamento_valor', oxxo_valor: 'pagamento_valor', cop_valor: 'pagamento_valor', ars_valor: 'pagamento_valor', cop_link: 'pagamento_link',
  full_name: 'nome', name: 'nome', first_name: 'primeiro_nome', phone_number: 'telefone', phone: 'telefone', email: 'email',
  'gateway.payment_code': 'pagamento_codigo', 'gateway.value': 'pagamento_valor', 'gateway.payment_link': 'pagamento_link', 'ai.response': 'ai_response',
};
const mapVar = (n) => { const k = String(n).trim(); return VAR_MAP[k] || (/^[a-z][a-z0-9_]*$/.test(k) ? k : VAR(k)); };
// {{x}} (ZapData) e {x} (Leona) → {{x da Kobly}}
export function convertVars(text) {
  return String(text ?? '')
    .replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_, n) => `{{${mapVar(n)}}}`)
    .replace(/(^|[^{])\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}(?!\})/g, (_, p, n) => `${p}{{${mapVar(n)}}}`);
}

const COUNTRY_DDI = { BR: '55', MX: '52', CO: '57', AR: '54', CL: '56', PE: '51', EC: '593', BO: '591', PY: '595', UY: '598', VE: '58', GT: '502', SV: '503', HN: '504', NI: '505', CR: '506', PA: '507', DO: '1809', ES: '34', US: '1', PT: '351', IN: '91', PH: '63', GB: '44' };
const CURRENCY = { BR: 'BRL', MX: 'MXN', CO: 'COP', AR: 'ARS', CL: 'CLP' };
const METHOD = { pix: 'PIX', spei: 'SPEI', mx_oxxo: 'OXXO', cop_nequi: 'NEQUI', cop_breb: 'BREB', cop_breb_llave: 'BREB', ars_transfer: 'BANK_TRANSFER', cl_transfer: 'BANK_TRANSFER', PIX: 'PIX', SPEI: 'SPEI', OXXO: 'OXXO' };
const VAR_OP = { equals: 'eq', not_equals: 'neq', contains: 'contains', not_contains: 'not_contains', greater: 'gt', less: 'lt', exists: 'not_empty', not_exists: 'empty', startsWith: 'contains', endsWith: 'contains' };

// Construtor do grafo: blocos, ligações e pendências
function builder() {
  const nodes = [], todo = [], used = new Set();
  const uniq = (r) => { let x = REF(r), i = 2; while (used.has(x)) x = `${REF(r)}_${i++}`; used.add(x); return x; };
  const add = (ref, type, data, pos) => { const n = { ref: uniq(ref), type, data, next: {}, position: pos || { x: (nodes.length % 6) * 300, y: Math.floor(nodes.length / 6) * 220 } }; nodes.push(n); return n; };
  const warn = (ref, label, why, pos) => { todo.push(`${label}: ${why}`); return add(ref, 'checkpoint', { name: `⚠ ${label}`.slice(0, 60) }, pos); };
  return { nodes, todo, add, warn };
}

// ---- ZapData --------------------------------------------------------------------------
// Aceita o formato do MCP ({ fluxo: { trigger, blocks: [{ ref, type, data, next }] } }) e o do editor ({ nodes, edges }).
function zapdataBlocks(src) {
  const f = src.fluxo || src.flow || src;
  if (Array.isArray(f.blocks)) return { name: f.name, trigger: f.trigger || {}, blocks: f.blocks };
  const nodes = f.nodes || (f.flow_data && f.flow_data.nodes) || [];
  const edges = f.edges || (f.flow_data && f.flow_data.edges) || [];
  const start = nodes.find((n) => n.type === 'start') || {};
  const sd = start.data || {};
  const blocks = nodes.filter((n) => n.type !== 'start').map((n) => ({ ref: n.id, type: n.type, data: n.data || {}, position: n.position, next: {} }));
  const byId = new Map(blocks.map((b) => [b.ref, b]));
  let first = null;
  for (const e of edges) {
    const h = e.sourceHandle || e.handle || 'default';
    if (e.source === start.id) { first = e.target; continue; }
    const b = byId.get(e.source); if (b) b.next[h] = e.target;
  }
  if (first) { const i = blocks.findIndex((b) => b.ref === first); if (i > 0) blocks.unshift(blocks.splice(i, 1)[0]); }
  return { name: f.name || src.name, trigger: { type: sd.triggerType || f.trigger_type, keywords: sd.triggerKeywords || f.trigger_keywords || [], match: sd.keywordMatchType || f.keyword_match_type }, blocks };
}

export function fromZapData(src) {
  const { name, trigger, blocks } = zapdataBlocks(src);
  const B = builder();
  const tt = trigger.type;
  const tdata = tt === 'keyword' ? { source: 'message', mode: 'keywords', keywords: (trigger.keywords || []).filter(Boolean), match: trigger.match === 'exact' ? 'equals' : 'contains' }
    : tt === 'all' ? { source: 'message', mode: 'any' } : { events: ['Pix Gerado'] };
  if (!['keyword', 'all'].includes(tt)) B.todo.push(`Gatilho: no ZapData era "${tt || 'manual'}". Escolha o gatilho na Kobly.`);
  if (trigger.match === 'not_contains') B.todo.push('Gatilho: "não contém" virou "contém". Confira as palavras.');
  const ini = B.add('ini', 'trigger', tdata, { x: -320, y: 0 });
  const map = new Map(); // ref do ZapData → { entry: ref Kobly, exits: { saídaZapData: [nóKobly, saídaKobly] } }
  for (const b of blocks) {
    const d = b.data || {}, pos = b.position;
    const one = (type, data, exitMap = { default: 'default' }) => { const n = B.add(b.ref, type, data, pos); map.set(b.ref, { entry: n.ref, exits: Object.fromEntries(Object.entries(exitMap).map(([z, k]) => [z, [n, k]])) }); return n; };
    const opts = { reply_last: !!d.replyToLastMessage || undefined, react_last: !!d.reactToLastMessage || undefined, react_emoji: d.reactToLastMessage ? (d.reactionEmoji || '👍') : undefined };
    switch (b.type) {
      case 'text': case 'aiText': one('send_text', { text: convertVars(d.message || ' '), link_preview: !!d.linkPreview, ...opts }, { default: 'sent' }); break;
      case 'delay': {
        const u = d.unit || 'seconds';
        const [a, c] = d.delayType === 'variable' ? [secs(d.minDelay ?? 5, u), secs(d.maxDelay ?? 15, u)] : [secs(d.delay ?? 5, u), secs(d.delay ?? 5, u)];
        one('delay', { min_seconds: a, max_seconds: Math.max(a, c), typing: !!d.presence && d.presence !== 'none' }); break;
      }
      case 'image': case 'video': case 'audio': case 'document': case 'sticker': {
        const kind = b.type === 'sticker' ? 'image' : b.type;
        const url = https(d.mediaUrl);
        if (!url) B.todo.push(`${b.type === 'audio' ? 'Áudio' : 'Mídia'} "${d.fileName || b.ref}": envie o arquivo de novo no editor.`);
        one('send_media', { kind, url: url || 'https://example.com/troque-este-arquivo', ...(d.caption && kind !== 'audio' ? { caption: convertVars(d.caption) } : {}), ...(kind === 'document' && d.fileName ? { filename: d.fileName } : {}),
          view_once: !!d.viewOnce || undefined, forwarded: !!d.sendAsForwarded || undefined, ...opts }, { default: 'sent' });
        break;
      }
      case 'waitInput': {
        if (d.captureImage) B.todo.push(`Aguardar resposta "${d.variableName || b.ref}": a Kobly guarda o texto, não a imagem do comprovante.`);
        one('wait_reply', { save_as: VAR(d.variableName || 'resposta'), ...(d.timeoutEnabled ? { timeout_minutes: mins(d.timeout ?? 24, d.timeoutUnit) } : {}) }, { default: 'reply', no_response: 'timeout', timeout: 'timeout' });
        break;
      }
      case 'waitInputAI': {
        const w = B.add(`${b.ref}_espera`, 'wait_reply', { save_as: 'resposta', ...(d.timeoutEnabled ? { timeout_minutes: mins(d.timeout ?? 24, d.timeoutUnit) } : {}) }, pos);
        const fields = (d.variablesToExtract || []).filter((v) => v && v.name).slice(0, 8).map((v) => ({ name: VAR(v.name), description: String(v.description || v.name).slice(0, 300), required: v.required !== false }));
        const x = B.add(b.ref, 'ai_extract', { input: '{{resposta}}', fields: fields.length ? fields : [{ name: VAR(d.variableName || 'dado'), description: String(d.extractionPrompt || 'dado do lead').slice(0, 300), required: true }] }, pos && { x: pos.x + 280, y: pos.y });
        w.next.reply = x.ref;
        map.set(b.ref, { entry: w.ref, exits: { default: [x, 'ok'], max_attempts: [x, 'missing'], error: [x, 'error'], no_response: [w, 'timeout'] } });
        break;
      }
      case 'condition': {
        const cs = d.conditions || [];
        const ia = cs.find((c) => c.type === 'ia');
        if (ia) {
          one('ai_classify', { input: '{{ultima_mensagem}}', outputs: [{ key: 'sim', description: String(ia.iaPromptYes || ia.iaPrompt || 'sim').slice(0, 500) }, { key: 'nao', description: String(ia.iaPromptNo || 'não').slice(0, 500) }] }, { yes: 'out_sim', no: 'out_nao', error: 'error' });
          if (cs.length > 1) B.todo.push(`Condição "${b.ref}": tinha IA e outras regras; ficou só a IA.`);
          break;
        }
        const rules = cs.map((c) => (c.type === 'tag' ? { kind: 'tag', op: c.tagCondition === 'not_has' ? 'not_has' : 'has', tag_name: c.tagName }
          : c.type === 'country' ? { kind: 'country', ddi: [COUNTRY_DDI[String(c.countryCode || '').toUpperCase()] || '55'] }
            : { kind: 'var', name: VAR(c.variable || 'resposta'), op: VAR_OP[c.operator] || 'eq', value: convertVars(c.value ?? '') })).filter(Boolean);
        if (cs.some((c) => c.type === 'country' && c.countryMatch === 'is_not')) B.todo.push(`Condição "${b.ref}": "país não é" virou "país é" — troque as saídas Sim/Não.`);
        one('condition', { match: d.logicOperator === 'or' ? 'any' : 'all', rules: rules.length ? rules : [{ kind: 'var', name: 'resposta', op: 'not_empty' }] }, { yes: 'yes', no: 'no', error: 'no' });
        break;
      }
      case 'interactiveBlock': {
        const ch = (d.choices || []).map((c, i) => ({ i, t: String(c).split('|')[0].trim(), url: /\|https?:/.test(String(c)) })).filter((c) => c.t && !c.t.startsWith('[') && !c.url).slice(0, 10);
        const options = []; const ids = new Set();
        for (const c of ch) { let id = KEY(c.t); while (ids.has(id)) id = `${id}_${c.i}`.slice(0, 20); ids.add(id); options.push({ id, title: c.t.slice(0, ch.length <= 3 ? 20 : 24), z: `choice-${c.i}` }); }
        const exits = { fallback: 'other', timeout: 'timeout', default: 'other' };
        for (const o of options) exits[o.z] = `opt_${o.id}`;
        one('send_buttons', { text: convertVars(d.text || 'Escolha uma opção'), options: options.map(({ id, title }) => ({ id, title })), timeout_minutes: mins(d.timeout ?? 6, d.timeoutUnit) }, exits);
        break;
      }
      case 'randomizer': {
        const sp = (d.splits || []).slice(0, 6);
        const variants = sp.map((s) => ({ id: KEY(s.id || s.name), weight: Math.max(1, Math.min(100, Math.round(Number(s.percentage) || 50))) }));
        one('split', { variants }, Object.fromEntries(sp.map((s, i) => [`split-${s.id}`, `var_${variants[i].id}`])));
        break;
      }
      case 'goToFlow': B.todo.push(`Conectar fluxo "${d.targetFlowName || b.ref}": escolha o fluxo de destino.`); one('goto_flow', { campaign_id: '' }, {}); break;
      case 'webhook': one('webhook', { url: d.url || 'https://', method: ['POST', 'GET', 'PUT', 'PATCH'].includes(d.method) ? d.method : 'POST', headers: (d.customHeaders || []).filter((h) => h && h.key).map((h) => ({ key: String(h.key).replace(/[^A-Za-z0-9-]/g, ''), value: convertVars(h.value) })),
        ...(d.payloadMode === 'raw_json' && d.rawBody ? { body: convertVars(d.rawBody) } : {}), save_as: 'webhook' }, { default: 'success' }); break;
      case 'tag': {
        const at = d.actionType || (d.action === 'remove' ? 'remove_tag' : 'add_tag');
        if (at === 'add_tag' || at === 'remove_tag') one('tag', { add: [], remove: [], [at === 'add_tag' ? 'add_names' : 'remove_names']: [d.tagName].filter(Boolean) });
        else if (at === 'set_field') one('set_var', { name: VAR(d.fieldName), op: 'set', value: convertVars(d.fieldValue ?? '') });
        else { const n = B.warn(b.ref, `Ação ${at}`, 'não existe na Kobly; o fluxo só passa por aqui.', pos); map.set(b.ref, { entry: n.ref, exits: { default: [n, 'default'] } }); }
        break;
      }
      case 'notifyAdmin': B.todo.push(`Notificar "${d.pushTitle || b.ref}": escolha o canal de alerta (Telegram).`); one('notify', { channel_id: '', text: convertVars([d.pushTitle, d.pushBody || d.message].filter(Boolean).join('\n') || 'Aviso do fluxo') }); break;
      case 'pixel': B.todo.push('Pixel: escolha o Pixel da conta.'); one('pixel', { pixel_config_id: '', event: ['Purchase', 'Lead', 'InitiateCheckout'].includes(d.eventType) ? d.eventType : 'Purchase' }); break;
      case 'pixApi': case 'speiApi': {
        const country = String(d.country || (b.type === 'speiApi' ? 'MX' : 'BR')).toUpperCase();
        const currency = CURRENCY[country];
        if (!currency) { const n = B.warn(b.ref, 'Cobrança', `país ${country} não é cobrado pela Kobly.`, pos); map.set(b.ref, { entry: n.ref, exits: { sucesso: [n, 'default'], erro: [n, 'default'] } }); break; }
        B.todo.push(`Cobrança "${b.ref}": escolha a conta do gateway (${d.provider || 'gateway'}).`);
        const pay = B.add(b.ref, 'payment', { integration_id: '', currency, method: METHOD[d.method] || (currency === 'BRL' ? 'PIX' : currency === 'MXN' ? 'SPEI' : 'BANK_TRANSFER'), amount: convertVars(d.amount || '{{valor}}'), ...(d.openValue ? { open_amount: true } : {}) }, pos);
        const msg = B.add(`${b.ref}_msg`, 'send_text', { text: convertVars(d.caption || 'Seu código de pagamento:\n{{pagamento_codigo}}') }, pos && { x: pos.x + 280, y: pos.y });
        pay.next.charge_created = msg.ref;
        map.set(b.ref, { entry: pay.ref, exits: { sucesso: [msg, 'sent'], erro: [pay, 'error'] } });
        break;
      }
      case 'saleApproved': one('record_sale', {}); break;
      case 'aiResponder': one('ai_agent', { objective: String(d.systemPrompt || 'Atender o lead').slice(0, 2000), ...(d.enableExpiration ? { timeout_minutes: Number(d.expirationMinutes) || 30 } : {}) }, { expiration: 'expiration', error: 'error' }); break;
      case 'calculator': one('set_var', { name: VAR(d.saveToVariable || 'resultado'), op: d.operation === 'add' ? 'add' : d.operation === 'subtract' ? 'subtract' : d.operation === 'divide' ? 'divide' : 'multiply', value: convertVars(d.operandB ?? '1') }); B.todo.push(`Calculadora "${b.ref}": confira a conta (a Kobly faz a operação sobre o valor atual da variável).`); break;
      case 'passageTracker': one('checkpoint', { name: String(d.trackerName || 'Passagem').slice(0, 60) }); break;
      case 'officialTemplate': B.todo.push(`Modelo oficial "${d.templateName || b.ref}": escolha o modelo aprovado.`); one('send_template', { template_id: '', vars: (d.templateParams || []).map(convertVars) }, { default: 'sent' }); break;
      default: { const n = B.warn(b.ref, ({ call: 'Ligação', carousel: 'Carrossel', contact: 'Contato', sendPixKey: 'Chave PIX', sendCharge: 'Cobrança nativa', iaGenerator: 'Gerador IA', audioAI: 'Áudio IA', catalogResolver: 'Catálogo', whatsappLabel: 'Etiqueta do WhatsApp' })[b.type] || b.type, 'ainda não existe na Kobly; refaça este passo.', pos); const ex = {}; for (const k of Object.keys(b.next || {})) ex[k] = [n, 'default']; map.set(b.ref, { entry: n.ref, exits: ex }); }
    }
  }
  // ligações
  for (const b of blocks) {
    const m = map.get(b.ref); if (!m) continue;
    for (const [z, target] of Object.entries(b.next || {})) {
      const t = map.get(target); const ex = m.exits[z] || m.exits.default;
      if (t && ex && !ex[0].next[ex[1]]) ex[0].next[ex[1]] = t.entry;
    }
  }
  if (blocks[0] && map.get(blocks[0].ref)) ini.next.default = map.get(blocks[0].ref).entry;
  const graph = { version: 1, start: ini.ref, nodes: B.nodes };
  if (!blocks.some((b) => b.position)) autoLayout(graph);
  return { nome: name || 'Fluxo importado do ZapData', graph, pendencias: [...new Set(B.todo)], origem: 'ZapData' };
}

// ---- Leona ----------------------------------------------------------------------------
export function fromLeona(src) {
  const nodes = src.nodes || (src.flow && src.flow.nodes) || [];
  const conns = src.connections || nodes.flatMap((n) => (n.connections || []).map((c) => ({ ...c, from_node_id: n.id })));
  const B = builder();
  const name = (src.flow && src.flow.name) || src.name;
  const ini = B.add('ini', 'trigger', { source: 'message', mode: 'any' }, { x: -320, y: 0 });
  B.todo.push('Gatilho: confira como o fluxo começa (mensagem, palavra-chave ou evento do checkout).');
  const map = new Map(); // id Leona → { entry, exits: { chave: [nó, saída] } }
  for (const n of nodes) {
    const pos = n.position ? { x: Math.round(n.position.x), y: Math.round(n.position.y) } : undefined;
    const acts = [...(n.actions || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    const chain = []; // nós Kobly em sequência deste bloco
    const push = (type, data, exitKey) => { const k = B.add(`l${n.id}_${chain.length}`, type, data, pos && { x: pos.x + chain.length * 40, y: pos.y + chain.length * 60 }); chain.push([k, exitKey]); return k; };
    const conf = (t) => (acts.find((a) => a.action_type === t) || {}).config || {};
    switch (n.node_type) {
      case 'start': map.set(n.id, { start: true }); continue;
      case 'message': case 'template': case 'notification': case 'tags': case 'manipulator': case 'smart_interval': case 'approved_sale': case 'pixel':
        for (const a of acts) {
          const c = a.config || {};
          switch (a.action_type) {
            case 'send_message': if (c.typing_delay_seconds) push('delay', { min_seconds: Number(c.typing_delay_seconds), max_seconds: Number(c.typing_delay_seconds), typing: true }, 'default'); push('send_text', { text: convertVars(c.message_text || c.message || ' ') }, 'sent'); break;
            case 'send_multi_media': case 'send_file': {
              const kind = a.action_type === 'send_file' ? 'document' : ['image', 'video', 'audio'].includes(c.media_type) ? c.media_type : 'document';
              const url = https(c.media_url || c.file_url || (c.media_file_info && c.media_file_info.url));
              if (c.typing_delay_seconds) push('delay', { min_seconds: Number(c.typing_delay_seconds), max_seconds: Number(c.typing_delay_seconds), typing: true }, 'default');
              if (!url) B.todo.push(`Mídia em "${n.name}": envie o arquivo de novo no editor.`);
              push('send_media', { kind, url: url || 'https://example.com/troque-este-arquivo', ...(c.caption && kind !== 'audio' ? { caption: convertVars(c.caption) } : {}), ...(kind === 'document' ? { filename: c.file_name || (c.media_file_info && c.media_file_info.filename) } : {}), ...(c.audio_forward ? { forwarded: true } : {}) }, 'sent');
              break;
            }
            case 'delay_between_messages': push('delay', { min_seconds: Number(c.delay_min_seconds ?? c.delay_seconds ?? 3), max_seconds: Number(c.delay_max_seconds ?? c.delay_seconds ?? 3), typing: true }, 'default'); break;
            case 'add_tags': push('tag', { add: [], remove: [], [c.action === 'remove' ? 'remove_names' : 'add_names']: (c.tags || []).map(String) }, 'default'); break;
            case 'send_notification': B.todo.push(`Notificação "${c.name || n.name}": escolha o canal de alerta (Telegram).`); push('notify', { channel_id: '', text: convertVars(c.message || 'Aviso do fluxo') }, 'default'); break;
            case 'set_contact_custom_field': push('set_var', { name: VAR(c.field_name), op: 'set', value: convertVars(c.value ?? '') }, 'default'); break;
            case 'smart_interval': push(c.schedule_type === 'date' && c.scheduled_date ? 'wait_until' : 'delay', c.schedule_type === 'date' && c.scheduled_date ? { mode: 'datetime', at: String(c.scheduled_date).slice(0, 16).replace('T', ' ') } : { min_seconds: secs(c.interval_value, c.interval_unit), max_seconds: secs(c.interval_value, c.interval_unit) }, 'default'); break;
            case 'register_approved_sale': push('record_sale', {}, 'default'); break;
            case 'send_template': B.todo.push(`Modelo do WhatsApp em "${n.name}": escolha o modelo aprovado.`); push('send_template', { template_id: '', vars: [] }, 'sent'); break;
            default: if (n.node_type === 'pixel') { B.todo.push('Pixel: escolha o Pixel da conta.'); push('pixel', { pixel_config_id: '', event: 'Purchase' }, 'default'); } break;
          }
        }
        if (n.node_type === 'pixel' && !chain.length) { B.todo.push('Pixel: escolha o Pixel da conta.'); push('pixel', { pixel_config_id: '', event: 'Purchase' }, 'default'); }
        break;
      case 'wait_response': {
        const save = conf('save_user_data').field_name;
        const w = conf('wait_for_response');
        const k = push('wait_reply', { save_as: VAR(save || 'resposta'), ...(!w.wait_indefinitely && w.timeout_value ? { timeout_minutes: mins(w.timeout_value, w.timeout_unit) } : {}) }, 'reply');
        map.set(n.id, { entry: chain[0][0].ref, exits: { 'client-response': [k, 'reply'], timeout: [k, 'timeout'], default: [k, 'reply'] } });
        continue;
      }
      case 'condition': {
        const c = conf('evaluate_condition');
        const rules = (c.conditions || []).map((r) => (r.systemSubtype === 'tag' || r.tagName ? { kind: 'tag', op: /not|diff/.test(r.systemOperator || '') ? 'not_has' : 'has', tag_name: r.tagName }
          : { kind: 'var', name: VAR(r.field || r.variable || 'resposta'), op: VAR_OP[r.operator] || 'eq', value: convertVars(r.value ?? '') }));
        const k = push('condition', { match: c.ruleType === 'any' ? 'any' : 'all', rules: rules.length ? rules : [{ kind: 'var', name: 'resposta', op: 'not_empty' }] }, 'yes');
        map.set(n.id, { entry: k.ref, exits: { success: [k, 'yes'], failure: [k, 'no'], default: [k, 'yes'] } });
        continue;
      }
      case 'ai': {
        const c = conf('ai_call');
        const outs = (c.output_conditions || []).slice(0, 8);
        if (outs.length >= 2) {
          const keys = new Set();
          const outputs = outs.map((o) => { let k = KEY(o.output_key); while (keys.has(k)) k = `${k}_2`.slice(0, 20); keys.add(k); return { key: k, description: String(o.prompt || o.output_key).slice(0, 500), z: o.output_key }; });
          const k = push('ai_classify', { input: convertVars(c.user_message || '{{resposta}}'), ...(c.system_prompt ? { instructions: String(c.system_prompt).slice(0, 2000) } : {}), outputs: outputs.map(({ key, description }) => ({ key, description })) }, 'other');
          const exits = { failure: [k, 'error'], success: [k, 'other'], default: [k, 'other'] };
          for (const o of outputs) exits[`out:${o.z}`] = [k, `out_${o.key}`];
          map.set(n.id, { entry: k.ref, exits });
        } else {
          const k = push('ai_agent', { objective: String(c.system_prompt || 'Atender o lead').slice(0, 2000) }, 'done');
          map.set(n.id, { entry: k.ref, exits: { failure: [k, 'error'], success: [k, 'done'], default: [k, 'done'] } });
        }
        continue;
      }
      case 'payment': {
        const c = conf('create_payment_charge');
        const cur = String(c.currency || 'BRL').toUpperCase();
        B.todo.push(`Cobrança em "${n.name}": escolha a conta do gateway (${c.gateway || 'gateway'}).`);
        const k = push('payment', { integration_id: '', currency: ['BRL', 'MXN', 'COP', 'ARS', 'CLP'].includes(cur) ? cur : 'BRL', method: METHOD[c.method] || String(c.method || 'PIX').toUpperCase(), amount: convertVars(c.amount || '{{valor}}'), ...(c.open_amount ? { open_amount: true } : {}), ...(c.listener_ttl_value ? { listen_hours: Math.min(168, Math.max(1, Math.round(secs(c.listener_ttl_value, c.listener_ttl_unit) / 3600))) } : {}) }, 'charge_created');
        map.set(n.id, { entry: k.ref, exits: { charge_created: [k, 'charge_created'], payment_approved: [k, 'payment_approved'], error: [k, 'error'], default: [k, 'charge_created'] } });
        continue;
      }
      default: {
        const label = ({ make_call: 'Ligação', carousel: 'Carrossel', pix: 'Pix', integration: 'Integração', kanban: 'Kanban', leonapay: 'LeonaPay', kieai_integration: 'Gerador IA', chat_controller: 'Controle do chat' })[n.node_type] || n.node_type;
        const k = B.warn(`l${n.id}`, label, 'ainda não existe na Kobly; refaça este passo.', pos);
        chain.push([k, 'default']);
      }
    }
    if (!chain.length) { const k = B.add(`l${n.id}`, 'checkpoint', { name: String(n.name || 'Bloco').slice(0, 60) }, pos); chain.push([k, 'default']); }
    for (let i = 0; i < chain.length - 1; i++) chain[i][0].next[chain[i][1]] = chain[i + 1][0].ref;
    const last = chain[chain.length - 1];
    map.set(n.id, { entry: chain[0][0].ref, exits: { default: last } });
  }
  for (const c of conns) {
    const from = map.get(c.from_node_id), to = map.get(c.to_node_id);
    if (!from || !to || to.start) continue;
    if (from.start) { ini.next.default = to.entry; continue; }
    const cc = c.condition_config || {};
    const key = cc.output_key ? `out:${cc.output_key}` : cc.condition_result || cc.source_handle || (c.condition_type === 'timeout_or_unknown' ? 'timeout' : 'default');
    const ex = from.exits[key] || from.exits.default;
    if (ex && !ex[0].next[ex[1]]) ex[0].next[ex[1]] = to.entry;
  }
  return { nome: name || 'Fluxo importado da Leona', graph: { version: 1, start: ini.ref, nodes: B.nodes }, pendencias: [...new Set(B.todo)], origem: 'Leona' };
}

// Sem posições no arquivo: organiza em colunas pela distância até o gatilho
export function autoLayout(graph) {
  const by = new Map(graph.nodes.map((n) => [n.ref, n]));
  const depth = new Map([[graph.start, 0]]); const q = [graph.start];
  while (q.length) { const r = q.shift(); for (const t of Object.values((by.get(r) || {}).next || {})) if (t && by.has(t) && !depth.has(t)) { depth.set(t, depth.get(r) + 1); q.push(t); } }
  const rows = new Map();
  for (const n of graph.nodes) { const d = depth.has(n.ref) ? depth.get(n.ref) : (Math.max(0, ...depth.values()) + 1); const i = rows.get(d) || 0; rows.set(d, i + 1); n.position = { x: d * 310, y: i * 190 }; }
  return graph;
}

// ---- detectar o formato --------------------------------------------------------------
export function convertFlowJson(json) {
  if (json && json.kobly && json.graph) return { nome: json.nome || 'Fluxo importado', graph: json.graph, pendencias: [], origem: 'Kobly' };
  if (json && json.version === 1 && Array.isArray(json.nodes) && json.start) return { nome: json.nome || 'Fluxo importado', graph: json, pendencias: [], origem: 'Kobly' };
  const leonaNodes = json && (json.nodes || (json.flow && json.flow.nodes));
  if (Array.isArray(leonaNodes) && leonaNodes.some((n) => n && n.node_type)) return fromLeona(json);
  if (json && (json.fluxo || Array.isArray(json.blocks) || Array.isArray(json.nodes) || (json.flow && (json.flow.nodes || json.flow.blocks)) || json.flow_data)) return fromZapData(json.flow && !json.flow.node_type ? { ...json.flow, name: json.flow.name || json.name } : json);
  throw new Error('Não reconheci este arquivo. Use um fluxo exportado da Kobly, do ZapData ou da Leona.');
}
// arquivo .json (um ou vários fluxos) ou .zip (vários .json)
export async function readFlowFile(file) {
  const out = [];
  const push = (json, fname) => {
    const list = Array.isArray(json) ? json : Array.isArray(json && json.flows) && !json.nodes ? json.flows : [json];
    for (const j of list) { try { out.push({ arquivo: fname, ...convertFlowJson(j) }); } catch (e) { out.push({ arquivo: fname, erro: e.message }); } }
  };
  if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
    const zip = await JSZip.loadAsync(file);
    for (const f of Object.values(zip.files)) {
      if (f.dir || !/\.json$/i.test(f.name)) continue;
      try { push(JSON.parse(await f.async('string')), f.name); } catch { out.push({ arquivo: f.name, erro: 'arquivo .json inválido' }); }
    }
    if (!out.length) throw new Error('O .zip não tem nenhum fluxo (.json).');
    return out;
  }
  let json; try { json = JSON.parse(await file.text()); } catch { throw new Error('O arquivo não é um .json válido.'); }
  push(json, file.name);
  return out;
}

// Etiquetas por nome → ids da conta (cria as que faltam)
export async function resolveTagNames(graph, tags, createTag) {
  const byName = new Map(tags.map((t) => [String(t.nome).trim().toLowerCase(), t.id]));
  const idOf = async (nome) => {
    const k = String(nome || '').trim().toLowerCase(); if (!k) return null;
    if (!byName.has(k)) { const t = await createTag(String(nome).trim().slice(0, 60)); if (t && t.id) byName.set(k, t.id); }
    return byName.get(k) || null;
  };
  for (const n of graph.nodes) {
    const d = n.data || {};
    if (n.type === 'tag') {
      for (const [names, ids] of [['add_names', 'add'], ['remove_names', 'remove']]) {
        if (!d[names]) continue;
        for (const nm of d[names]) { const id = await idOf(nm); if (id && !d[ids].includes(id)) d[ids].push(id); }
        delete d[names];
      }
    }
    if (n.type === 'condition') for (const r of d.rules || []) if (r.kind === 'tag' && r.tag_name) { r.tag_id = (await idOf(r.tag_name)) || ''; delete r.tag_name; }
  }
  return graph;
}

// Baixar fluxo da Kobly (um .json ou vários num .zip)
export async function exportFlowsFile(list) {
  if (list.length === 1) return new Blob([JSON.stringify({ kobly: 1, nome: list[0].nome, graph: list[0].graph }, null, 2)], { type: 'application/json' });
  const zip = new JSZip();
  list.forEach((f, i) => zip.file(`${String(i + 1).padStart(2, '0')}-${String(f.nome).replace(/[^\w\- ]+/g, '').slice(0, 50) || 'fluxo'}.json`, JSON.stringify({ kobly: 1, nome: f.nome, graph: f.graph }, null, 2)));
  return zip.generateAsync({ type: 'blob' });
}
