// Proxy por número: validar o endereço, testar (http CONNECT e socks5) e trocar na Uazapi só se o teste passar.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/uazapi_proxy.integration.test.js   (sem a variável, só os testes do proxy)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { parseProxy, testProxy } from '../src/whatsapp/proxy.js';
import { createUazapi } from '../src/whatsapp/uazapi.js';
import { encrypt, decrypt } from '../src/whatsapp/crypto.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const stamp = Date.now();

test('endereço: normaliza, mascara a senha e recusa o que não serve', () => {
  const p = parseProxy('http://joao:s3nha@200.100.50.10:8080');
  assert.equal(p.url, 'http://joao:s3nha@200.100.50.10:8080');
  assert.equal(p.display, 'http://joao:•••@200.100.50.10:8080');
  assert.equal(parseProxy('200.100.50.10:3128').url, 'http://200.100.50.10:3128');
  assert.equal(parseProxy('socks5://u:p@proxy.exemplo.com:1080').protocol, 'socks5');
  assert.match(parseProxy('').error, /Cole/);
  assert.match(parseProxy('ftp://1.2.3.4:21').error, /http/);
  assert.match(parseProxy('http://1.2.3.4').error, /porta/);
  assert.match(parseProxy('http://127.0.0.1:8080').error, /interno/);
  assert.match(parseProxy('http://192.168.0.5:8080').error, /interno/);
  assert.match(parseProxy('http://1.2.3.4:8080/x').error, /caminho/);
});

// servidores falsos (em 127.0.0.1): o teste do proxy normalmente recusa interno, então aqui passamos o objeto já separado
function fakeHttpProxy({ needAuth }) {
  return net.createServer((s) => {
    s.once('data', (d) => {
      const head = d.toString();
      const auth = /Proxy-Authorization: Basic (\S+)/.exec(head);
      if (needAuth && (!auth || Buffer.from(auth[1], 'base64').toString() !== 'joao:s3nha')) s.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      else if (/^CONNECT web\.whatsapp\.com:443 /.test(head)) s.write('HTTP/1.1 200 Connection established\r\n\r\n');
      else s.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
  });
}
function fakeSocks5() {
  return net.createServer((s) => {
    let step = 0;
    s.on('data', (d) => {
      if (step === 0) { step = 1; s.write(Buffer.from([5, 2])); return; } // pede usuário/senha
      if (step === 1) { step = 2; const ul = d[1]; const u = d.subarray(2, 2 + ul).toString(); const p = d.subarray(3 + ul).toString(); s.write(Buffer.from([1, u === 'ana' && p === 'pw' ? 0 : 1])); return; }
      const host = d.subarray(5, 5 + d[4]).toString();
      s.write(Buffer.from([5, host === 'web.whatsapp.com' ? 0 : 2, 0, 1, 0, 0, 0, 0, 0, 0]));
    });
  });
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
// o proxy falso só existe em 127.0.0.1: o nome "proxy.teste" resolve para lá e liberamos o interno só aqui
const at = (url, port) => ({ ...parseProxy(url.replace('PORT', String(port))), host: '127.0.0.1' });
const T = { lookup: async () => ({ address: '127.0.0.1' }), allowInternal: true, timeoutMs: 2000 };

test('a trava de endereço interno vale também depois de resolver o nome', async () => {
  const r = await testProxy(parseProxy('http://meu-proxy.exemplo.com:8080'), { lookup: async () => ({ address: '10.1.2.3' }) });
  assert.equal(r.ok, false); assert.match(r.error, /interno/);
});

test('túnel http: passa com a senha certa, 407 com a errada', async () => {
  const h = fakeHttpProxy({ needAuth: true }); const port = await listen(h);
  try {
    const ok = await testProxy(at('http://joao:s3nha@8.8.8.8:PORT', port), T);
    assert.equal(ok.ok, true, ok.error); assert.equal(typeof ok.ms, 'number');
    const bad = await testProxy(at('http://joao:errada@8.8.8.8:PORT', port), T);
    assert.equal(bad.ok, false); assert.match(bad.error, /usuário\/senha/);
  } finally { h.close(); }
});

test('túnel socks5 com usuário/senha; porta fechada dá erro claro', async () => {
  const s5 = fakeSocks5(); const port = await listen(s5);
  try {
    assert.equal((await testProxy(at('socks5://ana:pw@8.8.8.8:PORT', port), T)).ok, true);
    const bad = await testProxy(at('socks5://ana:x@8.8.8.8:PORT', port), T);
    assert.equal(bad.ok, false); assert.match(bad.error, /usuário\/senha/);
  } finally { s5.close(); }
  const r = await testProxy(at('http://8.8.8.8:PORT', 1), { ...T, timeoutMs: 1500 }); // porta 1: ninguém escuta
  assert.equal(r.ok, false); assert.ok(r.error);
});

let pool, uaz;
const A = {};
const calls = [];
let tester = async () => ({ ok: true, ms: 42 });
async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  calls.push({ path: u.pathname, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
}
before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  uaz = createUazapi({ pool, secretKey: KEY, base: 'https://uaz.test', adminToken: 'adm-0000000', fetchImpl: fakeFetch, proxyTester: (p) => tester(p) });
  A.org = (await pool.query(`insert into public.organizations (nome) values ('Loja Proxy ${stamp}') returning id`)).rows[0].id;
  A.outra = (await pool.query(`insert into public.organizations (nome) values ('Outra Proxy ${stamp}') returning id`)).rows[0].id;
  A.inst = (await pool.query(`insert into public.whatsapp_uazapi_instances (organization_id, label, instance_name, token_enc, status) values ($1,'Vendas',$2,$3,'connected') returning id`,
    [A.org, `proxy-${stamp}`, encrypt('tok-proxy', KEY)])).rows[0].id;
});
after(async () => { if (!skip) await pool.end(); });
const ctx = () => ({ orgId: A.org, role: 'Cliente' });

test('trocar para proxy próprio: testa, manda para a Uazapi e guarda cifrado', { skip }, async () => {
  calls.length = 0;
  const r = await uaz.handle(ctx(), {}, { action: 'proxy_set', id: A.inst, mode: 'custom', proxy_url: 'http://joao:s3nha@200.100.50.10:8080' });
  assert.equal(r.proxy_mode, 'custom'); assert.equal(r.proxy_display, 'http://joao:•••@200.100.50.10:8080');
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [['POST', '/instance/proxy', { proxy_url: 'http://joao:s3nha@200.100.50.10:8080' }]]);
  const row = (await pool.query(`select proxy_mode, proxy_url_enc, proxy_display from public.whatsapp_uazapi_instances where id = $1`, [A.inst])).rows[0];
  assert.equal(decrypt(row.proxy_url_enc, KEY), 'http://joao:s3nha@200.100.50.10:8080');
  const list = await uaz.handle(ctx(), {}, { action: 'list' });
  const i = list.instances.find((x) => x.id === A.inst);
  assert.equal(i.proxy_mode, 'custom'); assert.equal(JSON.stringify(list).includes('s3nha'), false, 'a senha nunca volta para a tela');
});

test('proxy que falha no teste não troca nada', { skip }, async () => {
  calls.length = 0;
  tester = async () => ({ ok: false, error: 'O proxy não respondeu a tempo.' });
  await assert.rejects(uaz.handle(ctx(), {}, { action: 'proxy_set', id: A.inst, mode: 'custom', proxy_url: 'http://9.9.9.9:3128' }), /não respondeu.*Nada foi trocado/);
  assert.equal(calls.length, 0);
  const t = await uaz.handle(ctx(), {}, { action: 'proxy_test', id: A.inst, proxy_url: 'http://9.9.9.9:3128' });
  assert.equal(t.ok, false); assert.match(t.error, /não respondeu/);
  await assert.rejects(uaz.handle(ctx(), {}, { action: 'proxy_test', id: A.inst, proxy_url: 'http://10.0.0.1:3128' }), /interno/);
  tester = async () => ({ ok: true, ms: 42 });
});

test('voltar ao proxy da Uazapi; outra empresa e Suporte não mexem', { skip }, async () => {
  calls.length = 0;
  const r = await uaz.handle(ctx(), {}, { action: 'proxy_set', id: A.inst, mode: 'uazapi' });
  assert.equal(r.proxy_mode, 'uazapi');
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [['DELETE', '/instance/proxy']]);
  const row = (await pool.query(`select proxy_mode, proxy_url_enc from public.whatsapp_uazapi_instances where id = $1`, [A.inst])).rows[0];
  assert.deepEqual(row, { proxy_mode: 'uazapi', proxy_url_enc: null });
  await assert.rejects(uaz.handle({ orgId: A.outra, role: 'Cliente' }, {}, { action: 'proxy_set', id: A.inst, mode: 'uazapi' }), /não encontrada/);
  await assert.rejects(uaz.handle({ orgId: A.org, role: 'Suporte' }, {}, { action: 'proxy_set', id: A.inst, mode: 'uazapi' }), /não pode/);
});
