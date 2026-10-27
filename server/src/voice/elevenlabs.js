// Voz com a chave ElevenLabs do próprio cliente (rota POST /functions/v1/voice).
//   status | connect | remove | voices | set_voice | tts | translate_flow
// tts: texto → áudio MP3 salvo em flow-media (vai no bloco de mídia como áudio do WhatsApp).
// translate_flow: copia um fluxo para outro idioma. Os textos são traduzidos pela IA da empresa; os áudios
// gerados aqui são refeitos a partir do texto guardado (tts_text) e os enviados como arquivo são
// transcritos pela ElevenLabs, traduzidos e regravados na voz escolhida. O original não muda.
// A chave fica cifrada e vai só no cabeçalho xi-api-key.
import { randomBytes } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';

export const LANGUAGES = { en: 'inglês', es: 'espanhol', pt: 'português do Brasil', fr: 'francês', it: 'italiano', de: 'alemão' };
const LANG_LABEL = { en: 'Inglês', es: 'Espanhol', pt: 'Português', fr: 'Francês', it: 'Italiano', de: 'Alemão' };
const TTS_MODEL = 'eleven_multilingual_v2';
const STT_MODEL = 'scribe_v1';
const MAX_TTS_CHARS = 2500;
const MAX_AUDIOS = 20;
const VOICE_ID = /^[A-Za-z0-9]{10,40}$/;

// campos de texto de cada bloco que vão para a tradução
export function textsOf(node) {
  const d = node.data || {}, out = [];
  const add = (path, v) => { if (typeof v === 'string' && v.trim()) out.push({ path, text: v }); };
  if (['send_text', 'send_buttons'].includes(node.type)) add(['text'], d.text);
  if (node.type === 'send_buttons') {
    add(['list_button'], d.list_button);
    (d.options || []).forEach((o, i) => { add(['options', i, 'title'], o && o.title); add(['options', i, 'description'], o && o.description); });
  }
  if (node.type === 'send_media') { add(['caption'], d.caption); if (d.kind === 'audio') add(['tts_text'], d.tts_text); }
  if (node.type === 'ai_agent') { add(['opening'], d.opening); }
  return out;
}
const setIn = (obj, path, v) => { let o = obj; for (let i = 0; i < path.length - 1; i++) o = o[path[i]]; o[path[path.length - 1]] = v; };

export function createVoice({ pool, secretKey, aiKeys, storage, publicBaseUrl = '', fetchImpl = globalThis.fetch, base = 'https://api.elevenlabs.io' }) {
  const needKey = () => { if (!secretKey) throw new AuthError(503, 'voice_unconfigured', 'Indisponível neste ambiente (chave de segurança ausente).'); };
  const fail = (msg) => { throw new AuthError(422, 'validation_failed', msg); };

  async function eleven(key, path, init = {}) {
    let res;
    try { res = await fetchImpl(base + path, { ...init, headers: { 'xi-api-key': key, ...(init.headers || {}) }, signal: AbortSignal.timeout(init.timeout || 60000) }); }
    catch { throw new AuthError(502, 'voice_unreachable', 'A ElevenLabs não respondeu agora. Tente de novo.'); }
    if (res.status === 401) throw new AuthError(400, 'voice_bad_key', 'A ElevenLabs recusou a chave. Confira se copiou a chave inteira.');
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      const det = j && j.detail, msg = (det && (det.message || (typeof det === 'string' ? det : ''))) || `HTTP ${res.status}`;
      if (res.status === 429 || /quota|credits/i.test(msg)) throw new AuthError(402, 'voice_quota', 'Os créditos da sua conta ElevenLabs acabaram (ou o limite foi atingido). Recarregue no site da ElevenLabs.');
      if (res.status === 403 && /permission/i.test(msg)) throw new AuthError(400, 'voice_permission', `A chave da ElevenLabs não tem permissão para isso: ${msg}. Crie a chave com acesso a Text to Speech, Speech to Text e Voices.`);
      throw new AuthError(502, 'voice_error', `ElevenLabs: ${msg}`);
    }
    return res;
  }
  const row = async (orgId) => (await pool.query(`select * from public.voice_credentials where organization_id = $1`, [orgId])).rows[0] || null;
  async function keyOf(orgId) {
    needKey();
    const r = await row(orgId);
    if (!r) throw new AuthError(409, 'voice_missing', 'Conecte a sua chave da ElevenLabs em Integrações → Voz (ElevenLabs).');
    return { key: decrypt(r.key_enc, secretKey), voice: r.voice_id };
  }
  const markErr = (orgId, e) => { if (e && (e.code === 'voice_bad_key' || e.code === 'voice_permission')) pool.query(`update public.voice_credentials set status = 'error', last_error = $2 where organization_id = $1`, [orgId, e.message]).catch(() => {}); };
  const used = (orgId) => pool.query(`update public.voice_credentials set status = 'ok', last_error = null, last_used_at = now() where organization_id = $1`, [orgId]).catch(() => {});

  async function listVoices(key) {
    const j = await (await eleven(key, '/v1/voices')).json();
    return (j.voices || []).map((v) => ({ voice_id: v.voice_id, name: v.name, category: v.category || null, preview_url: v.preview_url || null,
      descricao: [v.labels && v.labels.gender, v.labels && v.labels.accent, v.labels && v.labels.age].filter(Boolean).join(' · ') }));
  }

  // texto → MP3 salvo em flow-media; devolve o link público
  async function speak(orgId, user, key, voiceId, text) {
    const t = String(text || '').trim();
    if (!t) fail('Escreva o texto do áudio.');
    if (t.length > MAX_TTS_CHARS) fail(`O texto do áudio passa de ${MAX_TTS_CHARS} letras. Divida em dois áudios.`);
    if (!VOICE_ID.test(String(voiceId || ''))) fail('Escolha uma voz.');
    const res = await eleven(key, `/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: t, model_id: TTS_MODEL }), timeout: 120000,
    });
    const audio = Buffer.from(await res.arrayBuffer());
    const name = `voz-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.mp3`;
    const up = await storage.upload(user, 'flow-media', orgId, name, audio);
    return `${publicBaseUrl}/storage/v1/object/public/flow-media/${up.path}`;
  }
  // áudio enviado como arquivo → texto (para poder traduzir)
  // (arquivo da própria Kobly é lido do disco; link de fora a ElevenLabs baixa — o servidor não busca URL do cliente)
  async function transcribe(orgId, key, url) {
    const form = new FormData();
    form.append('model_id', STT_MODEL);
    const own = new RegExp(`^${publicBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/storage/v1/object/public/flow-media/([0-9a-f-]{36})/([^/?#]+)$`).exec(url);
    if (own && publicBaseUrl) {
      if (own[1] !== orgId) fail('Um dos áudios do fluxo é de outra conta.');
      const f = await storage.read('flow-media', own[1], decodeURIComponent(own[2]));
      if (!f) fail('Um dos áudios do fluxo não existe mais. Envie de novo e tente traduzir.');
      form.append('file', new Blob([f.body]), own[2]);
    } else if (/^https:\/\/\S+$/i.test(url)) form.append('cloud_storage_url', url);
    else fail('Um dos áudios do fluxo não tem um link válido.');
    const j = await (await eleven(key, '/v1/speech-to-text', { method: 'POST', body: form, timeout: 180000 })).json();
    return String(j.text || '').trim();
  }

  async function activeGraph(orgId, campaignId) {
    const r = (await pool.query(`select c.nome, f.id as flow_id, v.graph from public.campaigns c join public.campaign_flows f on f.campaign_id = c.id
        join public.flow_graph_versions v on v.flow_id = f.id
       where c.id::text = $1 and c.organization_id = $2 order by v.is_active desc, v.version desc limit 1`, [String(campaignId || ''), orgId])).rows[0];
    if (!r) throw new AuthError(404, 'not_found', 'Fluxo não encontrado.');
    return r;
  }

  async function translateFlow(ctx, user, body) {
    const orgId = ctx.orgId;
    const lang = String(body.language || '');
    if (!LANGUAGES[lang]) fail('Escolha o idioma.');
    const src = await activeGraph(orgId, body.campaign_id);
    const graph = JSON.parse(JSON.stringify(src.graph));
    const nodes = graph.nodes || [];
    const audios = nodes.filter((n) => n.type === 'send_media' && n.data && n.data.kind === 'audio' && n.data.url);
    if (!audios.length && !nodes.some((n) => textsOf(n).length)) fail('Este fluxo não tem textos nem áudios para traduzir.');
    if (audios.length > MAX_AUDIOS) fail(`O fluxo tem ${audios.length} áudios; a tradução faz até ${MAX_AUDIOS} de cada vez.`);
    let voice = null, voiceId = null;
    if (audios.length) {
      voice = await keyOf(orgId);
      voiceId = VOICE_ID.test(String(body.voice_id || '')) ? body.voice_id : voice.voice;
      if (!voiceId) fail('Escolha a voz dos áudios traduzidos.');
    }
    const llm = await aiKeys.forOrg(orgId);
    try {
      // áudios sem texto guardado: transcreve antes, para traduzir junto com o resto
      for (const n of audios) if (!(n.data.tts_text || '').trim()) n.data.tts_text = await transcribe(orgId, voice.key, n.data.url);
      const items = [];
      nodes.forEach((n, i) => textsOf(n).forEach((t, k) => items.push({ id: `${i}.${k}`, text: t.text, node: n, path: t.path })));
      for (let i = 0; i < items.length; i += 15) {
        const part = items.slice(i, i + 15);
        const got = await llm.translate({ items: part.map(({ id, text }) => ({ id, text })), language: LANGUAGES[lang] });
        for (const it of part) setIn(it.node.data, it.path, got[it.id] != null ? got[it.id] : it.text);
      }
      for (const n of nodes) if (n.type === 'ai_agent') n.data.language = LANGUAGES[lang];
      for (const n of audios) n.data.url = await speak(orgId, user, voice.key, voiceId, n.data.tts_text);
    } catch (e) { markErr(orgId, e); if (e && e.code === 'ai_unconfigured') throw new AuthError(409, 'ai_missing', 'Para traduzir os textos, conecte a sua chave de IA em Integrações → IA.'); throw e; }
    if (audios.length) used(orgId);
    const templates = nodes.filter((n) => n.type === 'send_template').length;
    const nome = `${src.nome} (${LANG_LABEL[lang]})`.slice(0, 120);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const camp = (await client.query(`insert into public.campaigns (organization_id, nome, status_campanha, criador_id)
          values ($1,$2,'Rascunho',(select id from public.profiles where auth_id = $3)) returning id`, [orgId, nome, (user && user.id) || null])).rows[0];
      const f = (await client.query(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [camp.id, orgId])).rows[0];
      await client.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active, is_draft, source, note, created_by) values ($1,$2,1,$3::jsonb,true,false,'editor',$4,$5)`,
        [orgId, f.id, JSON.stringify(graph), `Tradução para ${LANG_LABEL[lang]} de "${src.nome}"`.slice(0, 500), (user && user.id) || null]);
      await client.query('commit');
      return { campaign_id: camp.id, nome, textos: nodes.reduce((s, n) => s + textsOf(n).length, 0), audios: audios.length,
        aviso: templates ? `${templates} modelo(s) aprovado(s) da Meta não foram traduzidos: escolha no novo fluxo um modelo aprovado no idioma certo.` : null };
    } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar a voz da conta.'); };
    switch (body.action) {
      case 'status': {
        const r = await row(orgId);
        return { connected: !!r, key_hint: r ? r.key_hint : null, voice_id: r ? r.voice_id : null, voice_name: r ? r.voice_name : null, status: r ? r.status : null, last_error: r ? r.last_error : null,
          languages: Object.entries(LANG_LABEL).map(([id, label]) => ({ id, label })) };
      }
      case 'connect': {
        editor(); needKey();
        const key = String(body.api_key || '').trim();
        if (key.length < 20 || /\s/.test(key)) fail('Cole a chave da ElevenLabs (começa com sk_).');
        const voices = await listVoices(key);
        const first = voices[0] || null;
        await pool.query(`insert into public.voice_credentials (organization_id, key_enc, key_hint, voice_id, voice_name, status, last_error) values ($1,$2,$3,$4,$5,'ok',null)
          on conflict (organization_id) do update set key_enc = excluded.key_enc, key_hint = excluded.key_hint, status = 'ok', last_error = null,
            voice_id = coalesce(public.voice_credentials.voice_id, excluded.voice_id), voice_name = coalesce(public.voice_credentials.voice_name, excluded.voice_name)`,
          [orgId, encrypt(key, secretKey), `…${key.slice(-4)}`, first && first.voice_id, first && first.name]);
        return { ok: true, voices };
      }
      case 'remove': { editor(); await pool.query(`delete from public.voice_credentials where organization_id = $1`, [orgId]); return { ok: true }; }
      case 'voices': {
        const v = await keyOf(orgId);
        try { return { voices: await listVoices(v.key), voice_id: v.voice }; } catch (e) { markErr(orgId, e); throw e; }
      }
      case 'set_voice': {
        editor();
        if (!VOICE_ID.test(String(body.voice_id || ''))) fail('Voz inválida.');
        await pool.query(`update public.voice_credentials set voice_id = $2, voice_name = $3 where organization_id = $1`, [orgId, body.voice_id, String(body.voice_name || '').slice(0, 80) || null]);
        return { ok: true };
      }
      case 'tts': {
        editor();
        const v = await keyOf(orgId);
        try { const url = await speak(orgId, user, v.key, body.voice_id || v.voice, body.text); used(orgId); return { url, text: String(body.text).trim() }; }
        catch (e) { markErr(orgId, e); throw e; }
      }
      case 'translate_flow': { editor(); return translateFlow(ctx, user, body); }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { handle };
}
