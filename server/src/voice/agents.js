// Agentes de voz e ligações com voz (rota voice-agents).
// ElevenLabs (ligar para o lead): o número de ligação fica conectado na ElevenLabs (WhatsApp → Importar conta). A Kobly
//   cria/atualiza o agente na conta ElevenLabs do cliente (chave de Integrações → Voz) e liga com
//   POST /v1/convai/whatsapp/outbound-call. A Meta exige que o lead aceite ligações: a ElevenLabs manda o modelo de
//   pedido de permissão e liga quando ele aceita. O resultado vem de GET /v1/convai/conversations/{id} (a Kobly
//   consulta a cada 30 s): atendeu / não atendeu / recusou, a saída escolhida (data_collection "saida"), resumo e conversa.
// OpenAI (atender quem liga): a ligação chega na OpenAI por SIP; a OpenAI avisa a Kobly (webhook realtime.call.incoming,
//   assinado no padrão Standard Webhooks) e a Kobly aceita com as instruções e a voz do agente escolhido.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';

const UUID = /^[0-9a-f-]{36}$/i;
const KEY = /^[a-z0-9_]{1,20}$/; // igual às saídas dos blocos (graph.js)
export const OPENAI_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];
export const OPENAI_MODEL = 'gpt-realtime';
const LANGS = { pt: 'português do Brasil', es: 'espanhol', en: 'inglês' };
const POLL_SECS = 30, GIVE_UP_HOURS = 26;
const digits = (v) => String(v || '').replace(/\D/g, '');

// saídas do agente: [{ key, label, description }] (até 8, chaves únicas)
export function cleanOutcomes(list) {
  const out = [], seen = new Set();
  for (const o of Array.isArray(list) ? list : []) {
    const label = String((o && o.label) || '').trim().slice(0, 40);
    if (!label) continue;
    let key = String((o && o.key) || label).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || `saida_${out.length + 1}`;
    if (!KEY.test(key) || seen.has(key)) key = `saida_${out.length + 1}`;
    seen.add(key);
    out.push({ key, label, description: String((o && o.description) || '').trim().slice(0, 300) });
    if (out.length >= 8) break;
  }
  return out;
}

// instruções completas que vão para a IA (o que o cliente escreveu + idioma + como escolher a saída)
export function fullPrompt(a) {
  const parts = [String(a.instructions || '').trim() || 'Você é um atendente educado e direto.'];
  parts.push(`Fale sempre em ${LANGS[a.language] || LANGS.pt}. É uma ligação de voz pelo WhatsApp: frases curtas e naturais, uma pergunta por vez.`);
  if (a.outcomes && a.outcomes.length) parts.push(`Ao longo da conversa, descubra qual destes resultados aconteceu: ${a.outcomes.map((o) => `"${o.label}"${o.description ? ` (${o.description})` : ''}`).join('; ')}. Quando ficar claro, encerre com educação.`);
  return parts.join('\n\n');
}

// corpo do agente na ElevenLabs
export function elevenAgentBody(a) {
  const body = {
    name: `Kobly · ${a.name}`.slice(0, 100),
    conversation_config: {
      agent: { first_message: a.first_message || '', language: a.language || 'pt', prompt: { prompt: fullPrompt(a) } },
      ...(a.voice_id ? { tts: { voice_id: a.voice_id } } : {}),
      conversation: { max_duration_seconds: a.max_duration_s || 300 },
      turn: { silence_end_call_timeout: a.silence_timeout_s || 20 },
    },
    platform_settings: { data_collection: {} },
  };
  if (a.outcomes && a.outcomes.length) {
    body.platform_settings.data_collection.saida = {
      type: 'string',
      description: `Qual foi o resultado da ligação. Responda SOMENTE com uma destas chaves: ${a.outcomes.map((o) => `${o.key} (${o.label}${o.description ? `: ${o.description}` : ''})`).join('; ')}. Se nenhuma se aplica, responda: nenhuma.`,
    };
  }
  return body;
}

// resultado de uma conversa da ElevenLabs → { done, result, outcome, duration, summary, transcript }
export function readConversation(conv, outcomes = []) {
  const st = conv && conv.status;
  if (!['done', 'failed'].includes(st)) return { done: false };
  const md = conv.metadata || {};
  const wa = md.whatsapp || md.phone_call || {};
  const perm = wa.call_permission_request && wa.call_permission_request.state;
  const cr = wa.call_result;
  const duration = Math.round(Number(md.call_duration_secs) || 0);
  const userSpoke = (conv.transcript || []).some((t) => t.role === 'user' && String(t.message || '').trim());
  let result;
  if (perm === 'declined' || cr === 'busy') result = 'rejected';
  else if (cr === 'answered' || (!cr && st === 'done' && (userSpoke || duration > 5))) result = 'answered';
  else result = 'no_answer';
  const an = conv.analysis || {};
  const dc = an.data_collection_results || {};
  const raw = dc.saida && dc.saida.value != null ? String(dc.saida.value).trim().toLowerCase() : '';
  const outcome = result === 'answered' && outcomes.some((o) => o.key === raw) ? raw : null;
  const transcript = (conv.transcript || []).filter((t) => String(t.message || '').trim())
    .map((t) => `${t.role === 'agent' ? 'Agente' : 'Lead'}: ${String(t.message).trim()}`).join('\n').slice(0, 20000);
  return { done: true, result, outcome, duration, summary: an.transcript_summary ? String(an.transcript_summary).slice(0, 2000) : null, transcript: transcript || null,
    error: st === 'failed' ? String((md.error && (md.error.reason || md.error.code)) || md.termination_reason || 'falhou').slice(0, 300) : null };
}

// Standard Webhooks (OpenAI): v1,<base64 HMAC-SHA256("id.timestamp.corpo")>, segredo "whsec_<base64>"
export function verifyStandardWebhook(secret, headers, raw, nowSecs = Math.floor(Date.now() / 1000)) {
  const id = headers['webhook-id'], ts = headers['webhook-timestamp'], sig = headers['webhook-signature'];
  if (!secret || !id || !ts || !sig) return false;
  if (Math.abs(nowSecs - Number(ts)) > 300) return false;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const want = createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest();
  return String(sig).split(' ').some((p) => {
    const [ver, val] = p.split(',');
    if (ver !== 'v1' || !val) return false;
    const got = Buffer.from(val, 'base64');
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

export function createVoiceAgents({ pool, secretKey, fetchImpl = globalThis.fetch, elevenBase = 'https://api.elevenlabs.io', openaiBase = 'https://api.openai.com', publicBaseUrl = '', now = () => new Date() }) {
  const fail = (m) => { throw new AuthError(422, 'validation_failed', m); };
  let onCallDone = null; // o runtime dos fluxos retoma a execução que esperava a ligação
  const setCallDoneHandler = (fn) => { onCallDone = fn; };

  async function elevenKey(orgId) {
    if (!secretKey) throw new AuthError(503, 'voice_unconfigured', 'Indisponível neste ambiente (chave de segurança ausente).');
    const r = (await pool.query(`select key_enc from public.voice_credentials where organization_id = $1`, [orgId])).rows[0];
    if (!r) throw new AuthError(409, 'voice_missing', 'Conecte a sua chave da ElevenLabs em Integrações → Voz (ElevenLabs).');
    return decrypt(r.key_enc, secretKey);
  }
  async function eleven(key, path, { method = 'GET', body } = {}) {
    let res;
    try { res = await fetchImpl(elevenBase + path, { method, headers: { 'xi-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); }
    catch { throw new AuthError(502, 'voice_unreachable', 'A ElevenLabs não respondeu agora. Tente de novo.'); }
    const j = await res.json().catch(() => null);
    if (res.status === 401) throw new AuthError(400, 'voice_bad_key', 'A ElevenLabs recusou a chave. Confira em Integrações → Voz.');
    if (!res.ok) {
      const det = j && j.detail;
      const msg = (Array.isArray(det) ? det.map((d) => d.msg).join('; ') : (det && (det.message || (typeof det === 'string' ? det : '')))) || `HTTP ${res.status}`;
      if (res.status === 403) throw new AuthError(400, 'voice_permission', `A chave da ElevenLabs não tem permissão para agentes: ${msg}. Crie a chave com acesso a "ElevenAgents".`);
      throw new AuthError(502, 'voice_error', `ElevenLabs: ${msg}`);
    }
    return j || {};
  }
  async function openaiKey(orgId) {
    if (!secretKey) throw new AuthError(503, 'ai_keys_unconfigured', 'Indisponível neste ambiente.');
    const r = (await pool.query(`select key_enc from public.ai_credentials where organization_id = $1 and provider = 'openai' order by is_active desc, created_at desc limit 1`, [orgId])).rows[0];
    if (!r) throw new AuthError(409, 'openai_missing', 'Cadastre uma chave da OpenAI em Integrações → IA (sua chave).');
    return decrypt(r.key_enc, secretKey);
  }
  async function openai(key, path, body) {
    let res;
    try { res = await fetchImpl(openaiBase + path, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('a OpenAI não respondeu'); }
    if (!res.ok) { const j = await res.json().catch(() => null); throw new Error(`OpenAI: ${(j && j.error && j.error.message) || `HTTP ${res.status}`}`); }
    return res.json().catch(() => ({}));
  }

  const agentOf = async (orgId, id) => {
    if (!UUID.test(String(id || ''))) fail('Agente inválido.');
    const r = (await pool.query(`select * from public.voice_agents where id = $1 and organization_id = $2`, [id, orgId])).rows[0];
    if (!r) throw new AuthError(404, 'not_found', 'Agente de voz não encontrado.');
    return r;
  };
  const settingsOf = async (orgId) => (await pool.query(`select * from public.voice_call_settings where organization_id = $1`, [orgId])).rows[0] || null;
  const viewSettings = (s) => ({
    el_phone_number_id: s ? s.el_phone_number_id : null, el_phone_label: s ? s.el_phone_label : null,
    permission_template: s ? s.permission_template : null, permission_language: s ? s.permission_language : 'pt_BR',
    openai_project_id: s ? s.openai_project_id : null, openai_secret_set: !!(s && s.openai_webhook_secret_enc), openai_agent_id: s ? s.openai_agent_id : null,
    openai_webhook_url: s ? `${String(publicBaseUrl).replace(/\/$/, '')}/webhooks/openai-calls/${s.openai_webhook_id}` : null,
    openai_sip_uri: s && s.openai_project_id ? `sip:${s.openai_project_id}@sip.api.openai.com;transport=tls` : null,
  });

  // cria ou atualiza o agente na ElevenLabs (erro fica guardado para a tela mostrar)
  async function syncEleven(orgId, a) {
    try {
      const key = await elevenKey(orgId);
      if (a.elevenlabs_agent_id) await eleven(key, `/v1/convai/agents/${encodeURIComponent(a.elevenlabs_agent_id)}`, { method: 'PATCH', body: elevenAgentBody(a) });
      else {
        const r = await eleven(key, '/v1/convai/agents/create', { method: 'POST', body: elevenAgentBody(a) });
        a.elevenlabs_agent_id = r.agent_id || null;
      }
      await pool.query(`update public.voice_agents set elevenlabs_agent_id = $2, sync_error = null, synced_at = now() where id = $1`, [a.id, a.elevenlabs_agent_id]);
      return null;
    } catch (e) {
      await pool.query(`update public.voice_agents set sync_error = $2 where id = $1`, [a.id, String(e.message).slice(0, 300)]);
      return e.message;
    }
  }

  function readAgent(b) {
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) fail('Dê um nome para o agente.');
    const provider = b.provider === 'openai' ? 'openai' : 'elevenlabs';
    const language = ['pt', 'es', 'en'].includes(b.language) ? b.language : 'pt';
    let voice = String(b.voice_id || '').trim().slice(0, 80) || null;
    if (provider === 'openai' && voice && !OPENAI_VOICES.includes(voice)) fail('Voz da OpenAI inválida.');
    if (provider === 'openai' && !voice) voice = 'marin';
    const instructions = String(b.instructions || '').trim().slice(0, 8000);
    if (instructions.length < 10) fail('Escreva as instruções do agente (quem ele é, o objetivo e o jeito de falar).');
    const max = Math.round(Number(b.max_duration_s) || 300), sil = Math.round(Number(b.silence_timeout_s) || 20);
    return {
      name, provider, language, voice_id: voice, voice_name: String(b.voice_name || '').trim().slice(0, 80) || null, instructions,
      first_message: String(b.first_message || '').trim().slice(0, 500), outcomes: cleanOutcomes(b.outcomes),
      max_duration_s: Math.min(3600, Math.max(30, max)), silence_timeout_s: Math.min(120, Math.max(5, sil)),
    };
  }

  // ---- ligar (bloco Ligação, modo agente; ou "Testar ligação") ----
  async function startCall({ orgId, agentId, phone, leadId = null, executionId = null, variables = {} }) {
    const a = await agentOf(orgId, agentId);
    if (a.provider !== 'elevenlabs') throw new AuthError(422, 'validation_failed', 'Agentes da OpenAI só atendem quem liga. Para ligar para o lead, use um agente da ElevenLabs.');
    const s = await settingsOf(orgId);
    if (!s || !s.el_phone_number_id) throw new AuthError(409, 'voice_no_number', 'Escolha o número de ligação da ElevenLabs em Agentes de voz → Configurar ligações.');
    if (!s.permission_template) throw new AuthError(409, 'voice_no_template', 'Informe o modelo de pedido de permissão de ligação em Agentes de voz → Configurar ligações.');
    const to = digits(phone);
    if (to.length < 10) throw new AuthError(422, 'validation_failed', 'O lead não tem telefone válido para ligar.');
    const key = await elevenKey(orgId);
    if (!a.elevenlabs_agent_id || a.sync_error) { const err = await syncEleven(orgId, a); if (err) throw new AuthError(502, 'voice_error', err); }
    const dyn = Object.fromEntries(Object.entries(variables || {}).filter(([k, v]) => /^[a-z0-9_]{1,40}$/i.test(k) && ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 30).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 300) : v]));
    const r = await eleven(key, '/v1/convai/whatsapp/outbound-call', { method: 'POST', body: {
      whatsapp_phone_number_id: s.el_phone_number_id, whatsapp_user_id: to,
      whatsapp_call_permission_request_template_name: s.permission_template, whatsapp_call_permission_request_template_language_code: s.permission_language || 'pt_BR',
      agent_id: a.elevenlabs_agent_id, ...(Object.keys(dyn).length ? { conversation_initiation_client_data: { dynamic_variables: dyn } } : {}),
    } });
    if (r.success === false || !r.conversation_id) throw new AuthError(502, 'voice_error', `ElevenLabs não iniciou a ligação${r.message ? `: ${r.message}` : '.'}`);
    const row = (await pool.query(`insert into public.voice_calls (organization_id, execution_id, lead_id, voice_agent_id, provider, external_id, phone, check_after)
      values ($1,$2,$3,$4,'elevenlabs',$5,$6, now() + interval '${POLL_SECS} seconds') returning id`, [orgId, executionId, leadId, a.id, r.conversation_id, to])).rows[0];
    return { id: row.id, conversation_id: r.conversation_id };
  }

  async function finish(call, info) {
    const up = await pool.query(`update public.voice_calls set status = 'done', result = $2, outcome = $3, duration_s = $4, summary = $5, transcript = $6, error = $7, finished_at = now()
      where id = $1 and status = 'pending' returning *`, [call.id, info.result, info.outcome || null, info.duration ?? null, info.summary || null, info.transcript || null, info.error || null]);
    if (up.rowCount && onCallDone) await onCallDone(up.rows[0]).catch((e) => console.error('[voz] retomar fluxo', e.message));
  }

  // consulta as ligações em andamento na ElevenLabs
  async function poll() {
    const due = (await pool.query(`select c.*, a.outcomes from public.voice_calls c left join public.voice_agents a on a.id = c.voice_agent_id
      where c.status = 'pending' and c.provider = 'elevenlabs' and c.check_after <= now() order by c.check_after limit 20`)).rows;
    let done = 0;
    for (const c of due) {
      try {
        if (now() - new Date(c.created_at) > GIVE_UP_HOURS * 3600e3) { await finish(c, { result: 'no_answer', error: 'sem resposta da ElevenLabs' }); done++; continue; }
        const key = await elevenKey(c.organization_id);
        const conv = await eleven(key, `/v1/convai/conversations/${encodeURIComponent(c.external_id)}`);
        const info = readConversation(conv, c.outcomes || []);
        if (info.done) { await finish(c, info); done++; }
        else await pool.query(`update public.voice_calls set check_after = now() + interval '${POLL_SECS} seconds' where id = $1`, [c.id]);
      } catch (e) {
        await pool.query(`update public.voice_calls set check_after = now() + interval '2 minutes', error = $2 where id = $1`, [c.id, String(e.message).slice(0, 300)]).catch(() => {});
      }
    }
    return { checked: due.length, done };
  }

  // ---- OpenAI: ligação recebida ----
  async function receiveOpenAiWebhook(webhookId, headers, raw) {
    if (!UUID.test(String(webhookId || ''))) return { status: 404 };
    const s = (await pool.query(`select * from public.voice_call_settings where openai_webhook_id = $1`, [webhookId])).rows[0];
    if (!s || !s.openai_webhook_secret_enc || !secretKey) return { status: 404 };
    if (!verifyStandardWebhook(decrypt(s.openai_webhook_secret_enc, secretKey), headers, raw, Math.floor(now().getTime() / 1000))) return { status: 401 };
    let ev; try { ev = JSON.parse(raw); } catch { return { status: 400 }; }
    if (ev.type !== 'realtime.call.incoming') return { status: 200 };
    const callId = ev.data && ev.data.call_id;
    if (!callId) return { status: 400 };
    const hdr = (n) => ((ev.data.sip_headers || []).find((h) => String(h.name).toLowerCase() === n) || {}).value || '';
    const from = digits((/sip:\+?(\d+)/.exec(hdr('from')) || [])[1]);
    const orgId = s.organization_id;
    const a = s.openai_agent_id ? (await pool.query(`select * from public.voice_agents where id = $1`, [s.openai_agent_id])).rows[0] : null;
    const lead = from ? (await pool.query(`select id from public.leads where organization_id = $1 and regexp_replace(coalesce(telefone,''), '\\D', '', 'g') in ($2, $3) limit 1`, [orgId, from, from.replace(/^55/, '')])).rows[0] : null;
    try {
      const key = await openaiKey(orgId);
      if (!a) { await openai(key, `/v1/realtime/calls/${encodeURIComponent(callId)}/reject`, { status_code: 486 }); return { status: 200 }; }
      const first = a.first_message ? `\n\nQuando a pessoa atender ou disser alô, comece dizendo exatamente: "${a.first_message}"` : '';
      await openai(key, `/v1/realtime/calls/${encodeURIComponent(callId)}/accept`, { type: 'realtime', model: OPENAI_MODEL, instructions: fullPrompt(a) + first, audio: { output: { voice: a.voice_id || 'marin' } } });
      await pool.query(`insert into public.voice_calls (organization_id, lead_id, voice_agent_id, provider, direction, external_id, phone, status, result, finished_at)
        values ($1,$2,$3,'openai','inbound',$4,$5,'done','answered',now())`, [orgId, lead ? lead.id : null, a.id, callId, from || null]);
    } catch (e) {
      await pool.query(`insert into public.voice_calls (organization_id, lead_id, voice_agent_id, provider, direction, external_id, phone, status, result, error, finished_at)
        values ($1,$2,$3,'openai','inbound',$4,$5,'done','no_answer',$6,now())`, [orgId, lead ? lead.id : null, a ? a.id : null, callId, from || null, String(e.message).slice(0, 300)]).catch(() => {});
    }
    return { status: 200 };
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar os agentes de voz.'); };
    switch (body.action) {
      case 'list': {
        const agents = (await pool.query(`select id, name, provider, voice_id, voice_name, language, instructions, first_message, outcomes, max_duration_s, silence_timeout_s,
          elevenlabs_agent_id is not null as synced, sync_error, created_at from public.voice_agents where organization_id = $1 order by created_at`, [orgId])).rows;
        const eleven = !!(await pool.query(`select 1 from public.voice_credentials where organization_id = $1`, [orgId])).rowCount;
        const openaiKeyOn = !!(await pool.query(`select 1 from public.ai_credentials where organization_id = $1 and provider = 'openai'`, [orgId])).rowCount;
        return { agents, settings: viewSettings(await settingsOf(orgId)), elevenlabs_connected: eleven, openai_connected: openaiKeyOn, openai_voices: OPENAI_VOICES };
      }
      case 'save': {
        editor();
        const v = readAgent(body);
        let row;
        if (body.id) {
          const cur = await agentOf(orgId, body.id);
          row = (await pool.query(`update public.voice_agents set name=$3, provider=$4, language=$5, voice_id=$6, voice_name=$7, instructions=$8, first_message=$9, outcomes=$10::jsonb,
            max_duration_s=$11, silence_timeout_s=$12, elevenlabs_agent_id = case when $4 = 'elevenlabs' then elevenlabs_agent_id else null end, updated_at = now()
            where id = $1 and organization_id = $2 returning *`, [cur.id, orgId, v.name, v.provider, v.language, v.voice_id, v.voice_name, v.instructions, v.first_message, JSON.stringify(v.outcomes), v.max_duration_s, v.silence_timeout_s])).rows[0];
        } else {
          const n = (await pool.query(`select count(*)::int as n from public.voice_agents where organization_id = $1`, [orgId])).rows[0].n;
          if (n >= 30) fail('Limite de 30 agentes de voz por conta.');
          row = (await pool.query(`insert into public.voice_agents (organization_id, name, provider, language, voice_id, voice_name, instructions, first_message, outcomes, max_duration_s, silence_timeout_s)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) returning *`, [orgId, v.name, v.provider, v.language, v.voice_id, v.voice_name, v.instructions, v.first_message, JSON.stringify(v.outcomes), v.max_duration_s, v.silence_timeout_s])).rows[0];
        }
        const syncError = row.provider === 'elevenlabs' ? await syncEleven(orgId, row) : null;
        return { ok: true, id: row.id, outcomes: v.outcomes, sync_error: syncError };
      }
      case 'remove': {
        editor();
        const a = await agentOf(orgId, body.id);
        if (a.elevenlabs_agent_id) { try { await eleven(await elevenKey(orgId), `/v1/convai/agents/${encodeURIComponent(a.elevenlabs_agent_id)}`, { method: 'DELETE' }); } catch { /* some só na Kobly */ } }
        await pool.query(`delete from public.voice_agents where id = $1`, [a.id]);
        return { ok: true };
      }
      case 'el_accounts': { // números de WhatsApp conectados na ElevenLabs
        const r = await eleven(await elevenKey(orgId), '/v1/convai/whatsapp-accounts');
        return { accounts: (r.items || []).map((x) => ({ phone_number_id: x.phone_number_id, phone_number: x.phone_number, name: x.phone_number_name || x.business_account_name || '', token_expired: !!x.is_token_expired })) };
      }
      case 'save_settings': {
        editor();
        const cur = await settingsOf(orgId);
        const tpl = body.permission_template != null ? String(body.permission_template).trim().slice(0, 120) : (cur && cur.permission_template);
        if (tpl && !/^[a-z0-9_]+$/.test(tpl)) fail('O nome do modelo usa só letras minúsculas, números e _ (igual aparece no Gerenciador do WhatsApp).');
        const lang = body.permission_language != null ? String(body.permission_language).trim() : (cur ? cur.permission_language : 'pt_BR');
        if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(lang)) fail('Idioma do modelo inválido (ex.: pt_BR).');
        const pid = body.el_phone_number_id !== undefined ? (String(body.el_phone_number_id || '').trim().slice(0, 40) || null) : (cur && cur.el_phone_number_id);
        if (pid && !/^\d{5,30}$/.test(pid)) fail('Número da ElevenLabs inválido.');
        const proj = body.openai_project_id !== undefined ? (String(body.openai_project_id || '').trim() || null) : (cur && cur.openai_project_id);
        if (proj && !/^proj_[A-Za-z0-9]{8,60}$/.test(proj)) fail('O ID do projeto da OpenAI começa com proj_.');
        let secretEnc = cur ? cur.openai_webhook_secret_enc : null;
        if (body.openai_webhook_secret) {
          const sec = String(body.openai_webhook_secret).trim();
          if (!/^whsec_[A-Za-z0-9+/=]{20,}$/.test(sec)) fail('O segredo do webhook da OpenAI começa com whsec_.');
          secretEnc = encrypt(sec, secretKey);
        }
        let oaAgent = body.openai_agent_id !== undefined ? (body.openai_agent_id || null) : (cur && cur.openai_agent_id);
        if (oaAgent) { const a = await agentOf(orgId, oaAgent); if (a.provider !== 'openai') fail('Para atender pela OpenAI, escolha um agente da OpenAI.'); oaAgent = a.id; }
        const label = body.el_phone_label !== undefined ? String(body.el_phone_label || '').slice(0, 80) || null : (cur && cur.el_phone_label);
        const r = (await pool.query(`insert into public.voice_call_settings (organization_id, el_phone_number_id, el_phone_label, permission_template, permission_language, openai_project_id, openai_webhook_secret_enc, openai_agent_id, updated_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,now()) on conflict (organization_id) do update set el_phone_number_id = excluded.el_phone_number_id, el_phone_label = excluded.el_phone_label,
            permission_template = excluded.permission_template, permission_language = excluded.permission_language, openai_project_id = excluded.openai_project_id,
            openai_webhook_secret_enc = excluded.openai_webhook_secret_enc, openai_agent_id = excluded.openai_agent_id, updated_at = now() returning *`,
          [orgId, pid, label, tpl || null, lang, proj, secretEnc, oaAgent])).rows[0];
        return { ok: true, settings: viewSettings(r) };
      }
      case 'calls': {
        const calls = (await pool.query(`select c.id, c.provider, c.direction, c.phone, c.status, c.result, c.outcome, c.duration_s, c.summary, c.transcript, c.error, c.created_at, c.finished_at,
            a.name as agent_name, l.nome as lead_nome from public.voice_calls c left join public.voice_agents a on a.id = c.voice_agent_id left join public.leads l on l.id = c.lead_id
          where c.organization_id = $1 order by c.created_at desc limit 50`, [orgId])).rows;
        return { calls };
      }
      case 'test_call': { // liga agora para um número (sem fluxo)
        editor();
        const phone = digits(body.phone);
        if (phone.length < 10) fail('Informe o número com DDI e DDD (ex.: 5511999999999).');
        const r = await startCall({ orgId, agentId: body.id, phone });
        return { ok: true, call_id: r.id };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }

  return { handle, startCall, poll, receiveOpenAiWebhook, setCallDoneHandler };
}
