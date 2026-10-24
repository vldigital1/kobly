// Ambiente LOCAL completo da Kobly (só para desenvolvimento/demonstração), com um comando:
//   node tools/dev-local.mjs          (Ctrl+C para parar tudo)
// Sobe: PostgreSQL portátil → esquema completo → PostgREST → kobly-api.
// Na primeira vez cria o banco, um usuário Cliente de teste e dados de demonstração.
// Tudo fica em ~/.kobly-local (KOBLY_LOCAL_DIR): FORA do OneDrive (não sincroniza o banco) e num caminho
// só com caracteres simples (o PostgreSQL no Windows não aceita "Á" no caminho da instalação).
//   ~/.kobly-local/pgsql   binários do PostgreSQL (zip oficial "windows-x64-binaries": pastas bin, lib, share)
//   ~/.kobly-local/bin     postgrest.exe (release oficial do PostgREST para Windows)
//   ~/.kobly-local/pgdata  dados · credenciais.json  conta de teste e segredos locais
// O front sobe à parte: na raiz, `node scripts/dev-local-front.mjs` (Vite com /api → esta API).
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const LD = process.env.KOBLY_LOCAL_DIR || join(homedir(), '.kobly-local');
const BIN = join(LD, 'pgsql', 'bin');
const DATA = join(LD, 'pgdata');
const CREDS = join(LD, 'credenciais.json');
const PG_PORT = 54329, REST_PORT = 54330, API_PORT = 4120, FRONT = 'http://localhost:5173';
const exe = (n) => join(BIN, `${n}.exe`);
const log = (...a) => console.log('[dev-local]', ...a);

if (!existsSync(exe('postgres'))) { console.error(`PostgreSQL portátil não encontrado em ${BIN}. Veja o README do servidor (seção "Ambiente local").`); process.exit(1); }
if (!existsSync(join(LD, 'bin', 'postgrest.exe'))) { console.error(`PostgREST não encontrado em ${join(LD, 'bin')}.`); process.exit(1); }

// segredos e conta de teste: gerados uma vez e guardados fora do git
let creds;
if (existsSync(CREDS)) creds = JSON.parse(readFileSync(CREDS, 'utf8'));
else {
  creds = { aviso: 'Somente para o ambiente local de desenvolvimento. Não use em produção.', email: 'demo@kobly.local',
    senha: `Demo-${randomBytes(9).toString('base64url')}`, jwt_secret: randomBytes(32).toString('hex'), kobly_secret_key: randomBytes(32).toString('base64') };
  mkdirSync(LD, { recursive: true }); writeFileSync(CREDS, JSON.stringify(creds, null, 2));
  log('credenciais de teste criadas em', CREDS);
}

// Esquema montado pelo build-schema (mesmas transformações do banco de produção), na ordem do manifesto.
function buildSchema() {
  const out = mkdtempSync(join(tmpdir(), 'kobly-schema-'));
  execFileSync(process.execPath, [join(SERVER, 'tools/build-schema.mjs'), out], { stdio: 'ignore' });
  return { out, files: JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).filter((m) => !m.skipped).map((m) => m.file) };
}
async function markApplied(c, files) {
  await c.query(`create schema if not exists kobly_local; create table if not exists kobly_local.applied (file text primary key, at timestamptz not null default now())`);
  for (const file of files) await c.query(`insert into kobly_local.applied (file) values ($1) on conflict do nothing`, [file]);
}

// 1) PostgreSQL
const fresh = !existsSync(join(DATA, 'PG_VERSION'));
if (fresh) {
  log('criando o cluster do PostgreSQL…');
  execFileSync(exe('initdb'), ['-D', DATA, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C'], { stdio: 'inherit' });
}
try { execFileSync(exe('pg_ctl'), ['status', '-D', DATA], { stdio: 'ignore' }); log('PostgreSQL já estava rodando'); }
catch {
  execFileSync(exe('pg_ctl'), ['start', '-D', DATA, '-w', '-l', join(LD, 'postgres.log'), '-o', `-p ${PG_PORT} -c listen_addresses=127.0.0.1`], { stdio: 'ignore' });
  log(`PostgreSQL ouvindo em 127.0.0.1:${PG_PORT}`);
}
const admin = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:${PG_PORT}/postgres` });
await admin.connect();
const dbExists = (await admin.query(`select 1 from pg_database where datname = 'kobly'`)).rowCount > 0;
if (!dbExists) {
  await admin.query(`create database kobly`);
  await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'kobly_authenticator') then create role kobly_authenticator noinherit login; end if; end $$`);
}
await admin.end();

const DB_URL = `postgres://postgres@127.0.0.1:${PG_PORT}/kobly`;
if (!dbExists) {
  log('aplicando bootstrap + migrações…');
  const c = new pg.Client({ connectionString: DB_URL }); await c.connect();
  const boot = readFileSync(join(SERVER, 'sql/000_bootstrap.sql'), 'utf8').replace(/^\\set .*$/gm, '')
    .replace(/:"writer"/g, '"postgres"').replace(/:"authenticator"/g, '"kobly_authenticator"').replace(/:"dbname"/g, '"kobly"');
  await c.query(boot);
  await c.query(`set search_path to "$user", public, extensions`);
  const { out, files } = buildSchema();
  for (const file of files) await c.query(readFileSync(join(out, file), 'utf8'));
  await c.query(readFileSync(join(SERVER, 'sql/001_session_grace.sql'), 'utf8'));
  await markApplied(c, files);
  await c.end();

  log('criando a conta de teste e os dados de demonstração…');
  execFileSync(process.execPath, [join(SERVER, 'tools/create-user.mjs'), creds.email, 'Cliente', 'Conta Demo', 'Loja Demo'],
    { env: { ...process.env, DATABASE_URL: DB_URL, KOBLY_NEW_PASSWORD: creds.senha }, stdio: 'ignore' });
  const d = new pg.Client({ connectionString: DB_URL }); await d.connect();
  const org = (await d.query(`select p.organization_id from public.profiles p join auth.users u on u.id = p.auth_id where lower(u.email) = $1`, [creds.email])).rows[0].organization_id;
  const seed = readFileSync(join(SERVER, 'tools/seed_demo.sql'), 'utf8').replace(/^\\set .*$/gm, '').replace(/:'org'/g, `'${org}'`).replace(/:'tamanho'/g, `'80'`);
  await d.query(seed);
  // uma campanha de demonstração já com fluxo em grafo publicado (para abrir no editor novo)
  const camp = (await d.query(`insert into public.campaigns (organization_id, nome, status_campanha, legacy_id) values ($1,'Demo — fluxo em grafo (México)','Rascunho','seed-demo') returning id`, [org])).rows[0].id;
  const flow = (await d.query(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [camp, org])).rows[0].id;
  await d.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active, source, note) values ($1,$2,1,$3::jsonb,true,'editor','demonstração local')`,
    [org, flow, JSON.stringify(demoGraph())]);
  await d.end();
}

// Banco que já existia: aplica só as migrações novas (as já aplicadas ficam em kobly_local.applied).
// Bancos criados antes deste controle foram montados até a 0073: essas contam como aplicadas.
if (dbExists) {
  const c = new pg.Client({ connectionString: DB_URL }); await c.connect();
  await c.query(`set search_path to "$user", public, extensions`);
  const { out, files } = buildSchema();
  const tracked = (await c.query(`select to_regclass('kobly_local.applied') as t`)).rows[0].t;
  if (!tracked) await markApplied(c, files.filter((f) => !/^\d{4}_/.test(f) || f.slice(0, 4) <= '0073'));
  const done = new Set((await c.query(`select file from kobly_local.applied`)).rows.map((x) => x.file));
  const pending = files.filter((f) => !done.has(f) && f !== '900_grants.sql');
  for (const file of pending) { log(`aplicando ${file}…`); await c.query(readFileSync(join(out, file), 'utf8')); }
  if (pending.length) { await c.query(readFileSync(join(out, '900_grants.sql'), 'utf8')); await markApplied(c, pending); }
  await c.end();
}

// 2) PostgREST e 3) kobly-api — processos filhos com log prefixado
const children = [];
function run(name, cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const pipe = (s) => s.on('data', (b) => String(b).split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`)));
  pipe(p.stdout); pipe(p.stderr);
  p.on('exit', (code) => { console.log(`[${name}] saiu (${code})`); });
  children.push(p); return p;
}
run('postgrest', join(LD, 'bin', 'postgrest.exe'), [], {
  PATH: `${BIN};${process.env.PATH}`, // libpq.dll vem do PostgreSQL portátil
  PGRST_DB_URI: `postgres://kobly_authenticator@127.0.0.1:${PG_PORT}/kobly`, PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'kobly_anon',
  PGRST_JWT_SECRET: creds.jwt_secret, PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: String(REST_PORT), PGRST_DB_POOL: '5',
});
run('api', process.execPath, [join(SERVER, 'src/index.js')], {
  DATABASE_URL: DB_URL, JWT_SECRET: creds.jwt_secret, PORT: String(API_PORT), HOST: '127.0.0.1', ALLOWED_ORIGINS: FRONT, SITE_URL: FRONT,
  POSTGREST_URL: `http://127.0.0.1:${REST_PORT}`, KOBLY_SECRET_KEY: creds.kobly_secret_key, PUBLIC_BASE_URL: `http://127.0.0.1:${API_PORT}`,
  REQUIRE_EMAIL_CONFIRM: 'false', ENGINE_ENABLED: 'true',
});
log(`API em http://127.0.0.1:${API_PORT} · PostgREST em http://127.0.0.1:${REST_PORT} · login de teste em ${CREDS}`);
log('agora suba o front: na raiz do projeto, `node scripts/dev-local-front.mjs` → http://localhost:5173');

function stopAll() {
  log('parando…');
  for (const c of children) { try { c.kill(); } catch { /* já saiu */ } }
  try { execFileSync(exe('pg_ctl'), ['stop', '-D', DATA, '-m', 'fast'], { stdio: 'ignore' }); } catch { /* já parado */ }
  process.exit(0);
}
process.on('SIGINT', stopAll); process.on('SIGTERM', stopAll);

function demoGraph() {
  return { version: 1, start: 'ini', nodes: [
    { ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado', 'Compra Recusada'] }, next: { default: 'hc' }, position: { x: 0, y: 120 } },
    { ref: 'hc', type: 'wait_until', data: { mode: 'business_hours', days: [1, 2, 3, 4, 5, 6], from: '08:00', to: '21:00' }, next: { default: 'ab' }, position: { x: 300, y: 120 } },
    { ref: 'ab', type: 'split', data: { variants: [{ id: 'a', weight: 50 }, { id: 'b', weight: 50 }] }, next: { var_a: 'txa', var_b: 'txb' }, position: { x: 600, y: 120 } },
    { ref: 'txa', type: 'send_text', data: { text: 'Hola {{primeiro_nome}}! Vi que tu pago quedó pendiente. ¿Te ayudo a terminar?' }, next: { sent: 'esp', window_closed: 'fim' }, position: { x: 900, y: 0 } },
    { ref: 'txb', type: 'send_text', data: { text: '{{primeiro_nome}}, tu acceso a {{produto}} sigue reservado. ¿Quieres el código para pagar en OXXO?' }, next: { sent: 'esp', window_closed: 'fim' }, position: { x: 900, y: 240 } },
    { ref: 'esp', type: 'wait_reply', data: { save_as: 'resposta', timeout_minutes: 1380 }, next: { reply: 'ia', timeout: 'fim' }, position: { x: 1200, y: 120 } },
    { ref: 'ia', type: 'ai_classify', data: { input: '{{resposta}}', outputs: [{ key: 'quer_pagar', description: 'quer pagar ou pediu o código' }, { key: 'duvida', description: 'tem uma dúvida sobre o produto' }, { key: 'nao', description: 'recusou' }] }, next: { out_quer_pagar: 'cnt', out_duvida: 'ag', out_nao: 'fim', other: 'ag', error: 'fim' }, position: { x: 1500, y: 120 } },
    { ref: 'ag', type: 'ai_agent', data: { objective: 'Tirar dúvidas sobre o guia e levar o lead a pagar.', knowledge: 'Guia digital com 50 receitas, entrega por PDF na hora, $120 MXN, pagamento por OXXO ou SPEI.', max_turns: 6, timeout_minutes: 60 }, next: { done: 'cnt', handoff: 'fim', expiration: 'fim' }, position: { x: 1800, y: 260 } },
    { ref: 'cnt', type: 'checkpoint', data: { name: 'quer pagar' }, next: { default: 'fim' }, position: { x: 1800, y: 0 } },
    { ref: 'fim', type: 'end', data: {}, next: {}, position: { x: 2100, y: 120 } },
  ] };
}
