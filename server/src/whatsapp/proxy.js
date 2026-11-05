// Proxy por número (Uazapi): o cliente troca o proxy padrão da Uazapi (IPs brasileiros) por um próprio.
// Formatos aceitos: http://usuario:senha@ip:porta  e  socks5://usuario:senha@ip:porta (usuário/senha opcionais).
// Antes de salvar, a Kobly testa: abre conexão com o proxy e pede passagem até o WhatsApp (web.whatsapp.com:443).
// Endereços internos (localhost, 10.x, 192.168.x...) são recusados — o teste não pode virar porta para a rede interna.
import net from 'node:net';
import dns from 'node:dns/promises';
import { blockedHost } from '../flows/runtime.js';

const TARGET_HOST = 'web.whatsapp.com', TARGET_PORT = 443;

// valida e separa o endereço; devolve { url (normalizado), protocol, host, port, user, pass, display }
export function parseProxy(raw) {
  const s = String(raw || '').trim();
  if (!s) return { error: 'Cole o endereço do proxy.' };
  if (s.length > 500) return { error: 'Endereço do proxy grande demais.' };
  let u;
  try { u = new URL(/^[a-z0-9]+:\/\//i.test(s) ? s : `http://${s}`); } catch { return { error: 'Endereço inválido. Use http://usuario:senha@ip:porta' }; }
  const protocol = u.protocol.replace(':', '').toLowerCase();
  if (!['http', 'socks5'].includes(protocol)) return { error: 'Use um proxy http:// ou socks5://' };
  const port = Number(u.port);
  if (!u.hostname || !port || port < 1 || port > 65535) return { error: 'Falta a porta do proxy (ex.: http://usuario:senha@200.100.50.10:8080).' };
  if (u.pathname && u.pathname !== '/') return { error: 'O endereço do proxy não leva caminho depois da porta.' };
  if (blockedHost(u.hostname)) return { error: 'Esse endereço é interno e não pode ser usado como proxy.' };
  const user = decodeURIComponent(u.username || ''), pass = decodeURIComponent(u.password || '');
  const auth = user ? `${encodeURIComponent(user)}${pass ? `:${encodeURIComponent(pass)}` : ''}@` : '';
  const host = u.hostname.includes(':') ? `[${u.hostname.replace(/^\[|\]$/g, '')}]` : u.hostname;
  return { url: `${protocol}://${auth}${host}:${port}`, protocol, host: u.hostname.replace(/^\[|\]$/g, ''), port, user, pass, display: `${protocol}://${user ? `${user}:•••@` : ''}${host}:${port}` };
}

function connectSocket(host, port, ms) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, ms);
    sock.once('connect', () => { clearTimeout(t); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}
// lê do socket até a condição ficar verdadeira (ou estourar o tempo)
function readUntil(sock, done, ms) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, ms);
    const onData = (d) => { buf = Buffer.concat([buf, d]); if (done(buf)) { cleanup(); resolve(buf); } };
    const onErr = (e) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); reject(new Error('closed')); };
    function cleanup() { clearTimeout(t); sock.off('data', onData); sock.off('error', onErr); sock.off('end', onEnd); }
    sock.on('data', onData); sock.once('error', onErr); sock.once('end', onEnd);
  });
}

async function httpTunnel(sock, p, ms) {
  const auth = p.user ? `Proxy-Authorization: Basic ${Buffer.from(`${p.user}:${p.pass}`).toString('base64')}\r\n` : '';
  sock.write(`CONNECT ${TARGET_HOST}:${TARGET_PORT} HTTP/1.1\r\nHost: ${TARGET_HOST}:${TARGET_PORT}\r\n${auth}\r\n`);
  const head = (await readUntil(sock, (b) => b.includes('\r\n\r\n'), ms)).toString('latin1');
  const code = Number((head.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/) || [])[1]);
  if (code === 407) return { ok: false, error: 'O proxy recusou o usuário/senha.' };
  if (code !== 200) return { ok: false, error: code ? `O proxy não liberou a passagem até o WhatsApp (HTTP ${code}).` : 'Isso não parece um proxy http.' };
  return { ok: true };
}

async function socks5Tunnel(sock, p, ms) {
  sock.write(Buffer.from(p.user ? [5, 2, 0, 2] : [5, 1, 0]));
  const hello = await readUntil(sock, (b) => b.length >= 2, ms);
  if (hello[0] !== 5) return { ok: false, error: 'Isso não parece um proxy socks5.' };
  if (hello[1] === 2) {
    const u = Buffer.from(p.user), w = Buffer.from(p.pass);
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([w.length]), w]));
    const a = await readUntil(sock, (b) => b.length >= 2, ms);
    if (a[1] !== 0) return { ok: false, error: 'O proxy recusou o usuário/senha.' };
  } else if (hello[1] !== 0) return { ok: false, error: p.user ? 'O proxy não aceitou o jeito de entrar.' : 'O proxy pede usuário e senha.' };
  const h = Buffer.from(TARGET_HOST);
  sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([TARGET_PORT >> 8, TARGET_PORT & 255])]));
  const r = await readUntil(sock, (b) => b.length >= 2, ms);
  if (r[1] !== 0) return { ok: false, error: `O proxy não liberou a passagem até o WhatsApp (código ${r[1]}).` };
  return { ok: true };
}

// testa o proxy de verdade; devolve { ok, ms, error? }
export async function testProxy(raw, { timeoutMs = 8000, lookup = dns.lookup, allowInternal = false } = {}) { // allowInternal: só nos testes automáticos
  const p = typeof raw === 'string' ? parseProxy(raw) : raw;
  if (p.error) return { ok: false, error: p.error };
  // o nome pode apontar para um IP interno: confere depois de resolver
  let ip;
  try { ip = net.isIP(p.host) ? p.host : (await lookup(p.host)).address; } catch { return { ok: false, error: 'Não achei esse endereço (confira o IP/domínio do proxy).' }; }
  if (blockedHost(ip) && !allowInternal) return { ok: false, error: 'Esse endereço é interno e não pode ser usado como proxy.' };
  const t0 = Date.now();
  let sock;
  try {
    sock = await connectSocket(ip, p.port, timeoutMs);
    const r = p.protocol === 'socks5' ? await socks5Tunnel(sock, p, timeoutMs) : await httpTunnel(sock, p, timeoutMs);
    return { ...r, ms: Date.now() - t0 };
  } catch (e) {
    const m = String(e && (e.code || e.message) || '');
    if (m === 'timeout' || m === 'ETIMEDOUT') return { ok: false, error: 'O proxy não respondeu a tempo.' };
    if (m === 'ECONNREFUSED') return { ok: false, error: 'O proxy recusou a conexão (porta fechada?).' };
    return { ok: false, error: 'Não consegui falar com o proxy.' };
  } finally { if (sock) sock.destroy(); }
}
