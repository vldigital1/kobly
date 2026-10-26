// Monta e atualiza o banco do Kobly num PostgreSQL de servidor (Railway, VPS...). Roda antes de cada deploy:
//   DATABASE_URL=... PGRST_AUTHENTICATOR_PASSWORD=... node tools/migrate.mjs
// - Banco vazio: bootstrap (papéis, schemas auth/vault/...) + todas as migrações + grants + sessão.
// - Banco já montado: aplica só as migrações novas (controle em kobly_meta.applied) e refaz os grants.
// - Papel kobly_authenticator (login do PostgREST) com a senha de PGRST_AUTHENTICATOR_PASSWORD.
// - Primeiro Administrador (opcional): KOBLY_ADMIN_EMAIL + KOBLY_ADMIN_PASSWORD (mín. 12), só se ainda não existir.
// O usuário de DATABASE_URL precisa poder criar papéis (no Railway, o "postgres" pode).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log('[migrate]', ...a);
const url = process.env.DATABASE_URL;
const authPass = process.env.PGRST_AUTHENTICATOR_PASSWORD || '';
if (!url) { console.error('[migrate] defina DATABASE_URL'); process.exit(2); }
if (authPass.length < 16) { console.error('[migrate] defina PGRST_AUTHENTICATOR_PASSWORD (mín. 16 caracteres)'); process.exit(2); }

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

function buildSchema() {
  const out = mkdtempSync(join(tmpdir(), 'kobly-schema-'));
  execFileSync(process.execPath, [join(SERVER, 'tools/build-schema.mjs'), out], { stdio: 'ignore' });
  return { out, files: JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).filter((m) => !m.skipped).map((m) => m.file) };
}

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const { writer, dbname } = (await c.query(`select current_user as writer, current_database() as dbname`)).rows[0];
  // papel de login do PostgREST (senha sempre a da variável: trocar a variável troca a senha)
  await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'kobly_authenticator') then create role kobly_authenticator noinherit login; end if; end $$`);
  await c.query(`alter role kobly_authenticator with login noinherit password ${lit(authPass)}`);

  const fresh = !(await c.query(`select to_regclass('auth.users') as t`)).rows[0].t;
  const { out, files } = buildSchema();
  await c.query(`create schema if not exists kobly_meta; create table if not exists kobly_meta.applied (file text primary key, at timestamptz not null default now())`);
  const mark = async (list) => { for (const f of list) await c.query(`insert into kobly_meta.applied (file) values ($1) on conflict do nothing`, [f]); };

  if (fresh) {
    log(`banco vazio: montando tudo (${files.length} arquivos)…`);
    const boot = readFileSync(join(SERVER, 'sql/000_bootstrap.sql'), 'utf8').replace(/^\\set .*$/gm, '')
      .replace(/:"writer"/g, ident(writer)).replace(/:"authenticator"/g, '"kobly_authenticator"').replace(/:"dbname"/g, ident(dbname));
    await c.query(boot);
    await c.query(`set search_path to "$user", public, extensions`);
    for (const f of files) { log(`aplicando ${f}`); await c.query(readFileSync(join(out, f), 'utf8')); }
    await c.query(readFileSync(join(SERVER, 'sql/001_session_grace.sql'), 'utf8'));
    await mark(files);
  } else {
    await c.query(`set search_path to "$user", public, extensions`);
    const done = new Set((await c.query(`select file from kobly_meta.applied`)).rows.map((r) => r.file));
    if (!done.size) { // banco montado antes deste controle: considera tudo aplicado
      log('banco já montado sem controle de versões: registrando as migrações atuais como aplicadas');
      await mark(files); done.clear(); files.forEach((f) => done.add(f));
    }
    const pending = files.filter((f) => !done.has(f) && f !== '900_grants.sql');
    for (const f of pending) { log(`aplicando ${f}`); await c.query(readFileSync(join(out, f), 'utf8')); }
    if (pending.length) { await c.query(readFileSync(join(out, '900_grants.sql'), 'utf8')); await mark(pending); }
    log(pending.length ? `${pending.length} migração(ões) nova(s) aplicada(s)` : 'banco em dia');
  }
} finally { await c.end(); }

// primeiro Administrador da Kobly (painel de servidores WhatsApp, clientes, planos)
const adminEmail = (process.env.KOBLY_ADMIN_EMAIL || '').trim().toLowerCase();
if (adminEmail && process.env.KOBLY_ADMIN_PASSWORD) {
  const d = new pg.Client({ connectionString: url }); await d.connect();
  const exists = (await d.query(`select 1 from auth.users where lower(email) = $1`, [adminEmail])).rowCount > 0;
  await d.end();
  if (!exists) {
    execFileSync(process.execPath, [join(SERVER, 'tools/create-user.mjs'), adminEmail, 'Administrador', 'Administrador Kobly'],
      { env: { ...process.env, KOBLY_NEW_PASSWORD: process.env.KOBLY_ADMIN_PASSWORD }, stdio: 'inherit' });
    log(`Administrador criado: ${adminEmail}`);
  }
}
log('pronto');
