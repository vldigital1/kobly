// Vários servidores Uazapi: distribuição dos números, limite, pausa e acesso só do Administrador.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/uazapi_servers.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { pickServer } from '../src/whatsapp/uazapi.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const stamp = Date.now();
let pool, server, base;
const ADM = {}, A = {};
const net = [];

async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  net.push({ host: u.hostname, path: u.pathname, headers: init.headers || {} });
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  if (u.hostname.endsWith('.uazapi.test')) {
    const srv = u.hostname.split('.')[0]; // s1 ou s2
    if (u.pathname === '/instance/create') return init.headers.admintoken === `adm-${srv}-0000` ? ok({ token: `tok-${srv}-${net.length}` }) : { ok: false, status: 401, json: async () => ({}) };
    if (!String(init.headers.token || '').startsWith(`tok-${srv}-`)) return { ok: false, status: 401, json: async () => ({}) }; // token de um servidor não vale no outro
    if (u.pathname === '/webhook') return ok({});
    if (u.pathname === '/instance/connect' || u.pathname === '/instance/status') return ok({ instance: { status: 'connecting', qrcode: `QR-${srv}` } });
  }
  throw new Error('rede não esperada: ' + url);
}
const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const fn = async (name, body, token) => { const r = await post(`/functions/v1/${name}`, body, token); const j = await r.json(); return { status: r.status, ...j }; };
async function signup(who, nome) {
  const s = await (await post('/auth/signup', { email: `${nome.toLowerCase().replace(/\W/g, '')}${stamp}@kobly.test`, password: 'senha-forte-123', nome })).json();
  who.token = s.session.access_token; who.userId = s.session.user.id;
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  const config = { jwtSecret: 'segredo-jwt-integracao', requireConfirm: false, allowedOrigins: [], loginPerMin: 1000, signupPerMin: 1000, secretKey: KEY.toString('base64'), publicBaseUrl: 'https://api.kobly.test' };
  ({ server } = createApp({ pool, config, fetchImpl: fakeFetch })); // sem servidor no ambiente: só os cadastrados
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await signup(ADM, 'Admin Kobly'); await signup(A, 'Empresa SV');
  await pool.query(`update public.profiles set tipo_user_geral = 'Administrador' where auth_id = $1`, [ADM.userId]);
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query('set local role kobly_authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: A.userId, role: 'kobly_authenticated' })]);
    await c.query(`select public.create_own_org('Empresa SV')`); await c.query('commit');
  } finally { c.release(); }
});
after(async () => { if (skip) return; await new Promise((r) => server.close(r)); await pool.end(); });

test('escolha do servidor: o de menor ocupação, nunca um cheio ou pausado', () => {
  const s = (id, used, capacity, active = true, created_at = id) => ({ id, used, capacity, active, created_at });
  assert.equal(pickServer([s('a', 250, 300), s('b', 40, 100)]).id, 'b', '40% < 83%');
  assert.equal(pickServer([s('a', 300, 300), s('b', 100, 100)]), null);
  assert.equal(pickServer([s('a', 0, 300, false), s('b', 299, 300)]).id, 'b');
  assert.equal(pickServer([s('2', 10, 100), s('1', 10, 100)]).id, '1', 'empate: o mais antigo');
});

test('só o Administrador gerencia os servidores', { skip }, async () => {
  assert.equal((await fn('uazapi-servers', { action: 'list' }, A.token)).status, 403);
  assert.equal((await fn('uazapi', { action: 'list' }, A.token)).configured, false, 'sem servidor, a opção fica desligada para o cliente');
  assert.equal((await fn('uazapi-servers', { action: 'add', base_url: 'http://s1.uazapi.test', admin_token: 'adm-s1-0000' }, ADM.token)).status, 422, 'só https');
  const s1 = await fn('uazapi-servers', { action: 'add', label: 'PRO 1', base_url: 'https://s1.uazapi.test', admin_token: 'adm-s1-0000', capacity: 1 }, ADM.token);
  assert.equal(s1.status, 200, JSON.stringify(s1)); ADM.s1 = s1.id;
  ADM.s2 = (await fn('uazapi-servers', { action: 'add', label: 'PRO 2', base_url: 'https://s2.uazapi.test', admin_token: 'adm-s2-0000', capacity: 1 }, ADM.token)).id;
  assert.equal((await fn('uazapi-servers', { action: 'add', base_url: 'https://s2.uazapi.test', admin_token: 'outro-token' }, ADM.token)).status, 422, 'servidor repetido');
  const raw = (await pool.query(`select admin_token_enc from public.uazapi_servers where id = $1`, [ADM.s1])).rows[0].admin_token_enc;
  assert.equal(raw.includes('adm-s1-0000'), false, 'admintoken cifrado');
  const list = await fn('uazapi-servers', { action: 'list' }, ADM.token);
  assert.deepEqual(list.totals, { capacity: 2, used: 0 }); assert.equal(list.servers[0].token_hint, '…0000'); assert.equal(list.servers[0].adminToken, undefined);
});

test('números distribuídos entre os servidores; cheio dá aviso claro; cada número fala com o seu servidor', { skip }, async () => {
  const n1 = await fn('uazapi', { action: 'create', label: 'Vendas' }, A.token);
  assert.equal(n1.status, 200, JSON.stringify(n1)); assert.equal(n1.qrcode, 'QR-s1', 'primeiro vai para o servidor mais antigo');
  const n2 = await fn('uazapi', { action: 'create', label: 'Suporte' }, A.token);
  assert.equal(n2.qrcode, 'QR-s2', 'o PRO 1 encheu: o segundo vai para o PRO 2');
  const full = await fn('uazapi', { action: 'create', label: 'Extra' }, A.token);
  assert.equal(full.status, 503); assert.match(full.message, /servidores de WhatsApp estão cheios/);

  await fn('uazapi', { action: 'status', id: n2.instance.id }, A.token);
  assert.equal(net.at(-1).host, 's2.uazapi.test', 'status do número 2 vai para o servidor 2');
  await fn('uazapi', { action: 'status', id: n1.instance.id }, A.token);
  assert.equal(net.at(-1).host, 's1.uazapi.test');

  assert.equal((await fn('uazapi-servers', { action: 'remove', id: ADM.s1 }, ADM.token)).status, 422, 'servidor com números não sai');
  assert.equal((await fn('uazapi-servers', { action: 'update', id: ADM.s1, capacity: 3 }, ADM.token)).status, 200);
  assert.equal((await fn('uazapi-servers', { action: 'update', id: ADM.s2, active: false }, ADM.token)).status, 200);
  const n3 = await fn('uazapi', { action: 'create', label: 'Extra' }, A.token);
  assert.equal(n3.qrcode, 'QR-s1', 'com limite maior e o PRO 2 pausado, vai para o PRO 1');
  const tot = (await fn('uazapi-servers', { action: 'list' }, ADM.token)).totals;
  assert.deepEqual(tot, { capacity: 3, used: 2 }, 'servidor pausado não entra na capacidade livre');

  assert.equal((await fn('uazapi', { action: 'remove', id: n2.instance.id }, A.token)).ok, true);
  assert.equal((await fn('uazapi-servers', { action: 'remove', id: ADM.s2 }, ADM.token)).ok, true, 'servidor vazio pode sair');
});
