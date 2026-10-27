// Voz ElevenLabs com a chave do cliente: conectar, gerar áudio e traduzir um fluxo (textos + áudios).
// Só a rede (ElevenLabs e provedor de IA) é simulada.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/voice.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { textsOf } from '../src/voice/elevenlabs.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const stamp = Date.now();
const XI = 'sk_eleven_valida_1234567890';
let pool, server, base;
const A = {}, B = {};
const net = [];

async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  const h = init.headers || {};
  net.push({ host: u.hostname, path: u.pathname, body: init.body });
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
  if (u.hostname === 'api.openai.com') {
    if (u.pathname === '/v1/models') return ok({ data: [{ id: 'gpt-x' }] });
    if (u.pathname === '/v1/chat/completions') {
      const itens = JSON.parse(JSON.parse(init.body).messages[1].content).itens;
      return ok({ choices: [{ message: { content: JSON.stringify({ itens: itens.map((i) => ({ id: i.id, texto: `EN: ${i.texto}` })) }) } }] });
    }
  }
  if (u.hostname === 'api.elevenlabs.io') {
    if (h['xi-api-key'] !== XI) return { ok: false, status: 401, json: async () => ({ detail: { message: 'invalid_api_key' } }) };
    if (u.pathname === '/v1/voices') return ok({ voices: [{ voice_id: 'VozAna1234567', name: 'Ana', labels: { gender: 'female' } }, { voice_id: 'VozBeto123456', name: 'Beto' }] });
    if (u.pathname.startsWith('/v1/text-to-speech/')) {
      const audio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 1)]);
      return { ok: true, status: 200, arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.length) };
    }
    if (u.pathname === '/v1/speech-to-text') return ok({ text: 'Oi, tudo bem? Aproveite o desconto.' });
  }
  throw new Error('rede não esperada: ' + url);
}
const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const fn = async (name, body, token) => { const r = await post(`/functions/v1/${name}`, body, token); const j = await r.json(); return { status: r.status, ...j }; };
async function asUser(userId, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query('set local role kobly_authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'kobly_authenticated' })]);
    const r = await c.query(sql, params); await c.query('commit'); return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  const config = { jwtSecret: 'segredo-jwt-voz', requireConfirm: false, allowedOrigins: [], loginPerMin: 1000, signupPerMin: 1000, secretKey: KEY.toString('base64'),
    publicBaseUrl: 'https://api.kobly.test', storageDir: mkdtempSync(join(tmpdir(), 'kobly-voz-')) };
  ({ server } = createApp({ pool, config, fetchImpl: fakeFetch }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [who, nome] of [[A, 'Empresa Voz A'], [B, 'Empresa Voz B']]) {
    const s = await (await post('/auth/signup', { email: `${nome.toLowerCase().replace(/\W/g, '')}${stamp}@kobly.test`, password: 'senha-forte-123', nome })).json();
    who.token = s.session.access_token; who.userId = s.session.user.id;
    who.orgId = (await asUser(who.userId, `select (public.create_own_org($1)).id as id`, [nome])).rows[0].id;
  }
});
after(async () => { if (skip) return; await new Promise((r) => server.close(r)); await pool.end(); });

test('campos de texto que entram na tradução', () => {
  assert.deepEqual(textsOf({ type: 'send_buttons', data: { text: 'Quer?', options: [{ title: 'Sim' }, { title: 'Não', description: '' }] } }).map((t) => t.path.join('.')), ['text', 'options.0.title', 'options.1.title']);
  assert.deepEqual(textsOf({ type: 'send_media', data: { kind: 'image', caption: 'Foto', tts_text: 'x' } }).map((t) => t.path.join('.')), ['caption']);
});

test('ElevenLabs: chave conferida e cifrada, vozes, áudio gerado e salvo', { skip }, async () => {
  assert.equal((await fn('voice', { action: 'tts', text: 'oi' }, A.token)).status, 409, 'sem chave ainda');
  assert.equal((await fn('voice', { action: 'connect', api_key: 'sk_errada_000000000000000' }, A.token)).status, 400);
  const c = await fn('voice', { action: 'connect', api_key: XI }, A.token);
  assert.equal(c.status, 200, JSON.stringify(c)); assert.equal(c.voices.length, 2);
  const st = await fn('voice', { action: 'status' }, A.token);
  assert.deepEqual([st.connected, st.key_hint, st.voice_id], [true, '…7890', 'VozAna1234567'], 'a 1ª voz já fica escolhida');
  await assert.rejects(asUser(A.userId, `select key_enc from public.voice_credentials`), /permission denied/);
  assert.equal((await fn('voice', { action: 'status' }, B.token)).connected, false, 'outra empresa não vê');
  const t = await fn('voice', { action: 'tts', text: 'Olá {{primeiro_nome}}, seu desconto acaba hoje!' }, A.token);
  assert.equal(t.status, 200, JSON.stringify(t));
  assert.match(t.url, new RegExp(`^https://api\\.kobly\\.test/storage/v1/object/public/flow-media/${A.orgId}/voz-.+\\.mp3$`));
  const path = new URL(t.url).pathname;
  const audio = await fetch(base + path);
  assert.equal(audio.status, 200); assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await fn('voice', { action: 'set_voice', voice_id: 'VozBeto123456', voice_name: 'Beto' }, A.token)).status, 200);
  assert.equal((await fn('voice', { action: 'status' }, A.token)).voice_name, 'Beto');
});

test('Traduzir fluxo: textos pela IA do cliente, áudio gerado refeito e áudio enviado transcrito', { skip }, async () => {
  const tts = (await fn('voice', { action: 'tts', text: 'Seu Pix está pronto' }, A.token)).url;
  // áudio "enviado" (sem texto guardado): arquivo da própria Kobly
  const up = await fetch(`${base}/storage/v1/object/flow-media/${A.orgId}/meu-audio.mp3`, { method: 'POST', headers: { authorization: `Bearer ${A.token}` }, body: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100, 2)]) });
  const enviado = `https://api.kobly.test/storage/v1/object/public/flow-media/${(await up.json()).path}`;
  const camp = (await pool.query(`insert into public.campaigns (organization_id, nome) values ($1,'Recuperação Pix') returning id`, [A.orgId])).rows[0].id;
  const f = (await pool.query(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [camp, A.orgId])).rows[0].id;
  const graph = { version: 1, start: 'ini', nodes: [
    { ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'm1' } },
    { ref: 'm1', type: 'send_text', data: { text: 'Oi {{primeiro_nome}}!' }, next: { default: 'a1' } },
    { ref: 'a1', type: 'send_media', data: { kind: 'audio', url: tts, tts_text: 'Seu Pix está pronto' }, next: { default: 'a2' } },
    { ref: 'a2', type: 'send_media', data: { kind: 'audio', url: enviado }, next: { default: 'b1' } },
    { ref: 'b1', type: 'send_buttons', data: { text: 'Posso ajudar?', options: [{ id: 's', title: 'Sim' }] }, next: {} },
  ] };
  await pool.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active) values ($1,$2,1,$3::jsonb,true)`, [A.orgId, f, JSON.stringify(graph)]);

  const vazio = (await pool.query(`insert into public.campaigns (organization_id, nome) values ($1,'Só gatilho') returning id`, [A.orgId])).rows[0].id;
  const fv = (await pool.query(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [vazio, A.orgId])).rows[0].id;
  await pool.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active) values ($1,$2,1,$3::jsonb,true)`, [A.orgId, fv, JSON.stringify({ version: 1, start: 'ini', nodes: [graph.nodes[0]] })]);
  assert.match((await fn('voice', { action: 'translate_flow', campaign_id: vazio, language: 'en' }, A.token)).message, /não tem textos nem áudios/);
  const semIa = await fn('voice', { action: 'translate_flow', campaign_id: camp, language: 'en' }, A.token);
  assert.equal(semIa.status, 409); assert.match(semIa.message, /chave de IA/);
  assert.equal((await fn('ai-keys', { action: 'connect', provider: 'openai', api_key: 'sk-openai-voz-123', model: 'gpt-x' }, A.token)).status, 200);
  assert.equal((await fn('voice', { action: 'translate_flow', campaign_id: camp, language: 'en' }, B.token)).status, 404, 'outra empresa não traduz');

  const r = await fn('voice', { action: 'translate_flow', campaign_id: camp, language: 'en' }, A.token);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.nome, 'Recuperação Pix (Inglês)'); assert.equal(r.audios, 2);
  const novo = (await pool.query(`select c.status_campanha, v.graph from public.campaigns c join public.campaign_flows f on f.campaign_id = c.id join public.flow_graph_versions v on v.flow_id = f.id where c.id = $1`, [r.campaign_id])).rows[0];
  assert.equal(novo.status_campanha, 'Rascunho', 'o novo fluxo não entra no ar sozinho');
  const by = Object.fromEntries(novo.graph.nodes.map((n) => [n.ref, n.data]));
  assert.equal(by.m1.text, 'EN: Oi {{primeiro_nome}}!');
  assert.equal(by.b1.options[0].title, 'EN: Sim');
  assert.equal(by.a1.tts_text, 'EN: Seu Pix está pronto'); assert.notEqual(by.a1.url, tts, 'áudio regravado');
  assert.equal(by.a2.tts_text, 'EN: Oi, tudo bem? Aproveite o desconto.', 'áudio enviado foi transcrito e traduzido');
  assert.match(by.a2.url, /\/voz-.+\.mp3$/);
  const stt = net.filter((x) => x.path === '/v1/speech-to-text').at(-1);
  assert.ok(stt.body.get('file'), 'o arquivo da própria Kobly vai direto, sem baixar link');
  const voz = net.filter((x) => x.path.startsWith('/v1/text-to-speech/')).at(-1);
  assert.equal(voz.path, '/v1/text-to-speech/VozBeto123456', 'usa a voz escolhida da conta');
  const orig = (await pool.query(`select graph from public.flow_graph_versions where flow_id = $1`, [f])).rows[0].graph;
  assert.equal(orig.nodes[1].data.text, 'Oi {{primeiro_nome}}!', 'o fluxo original não muda');
});
