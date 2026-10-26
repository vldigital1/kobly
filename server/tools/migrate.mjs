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
// variável que ficou com o texto de exemplo do guia (<cole aqui ...>): para antes de montar qualquer coisa
const placeholders = ['JWT_SECRET', 'KOBLY_SECRET_KEY', 'UNSUBSCRIBE_SECRET', 'PGRST_AUTHENTICATOR_PASSWORD', 'KOBLY_ADMIN_EMAIL', 'KOBLY_ADMIN_PASSWORD']
  .filter((k) => /[<>]/.test(process.env[k] || ''));
if (placeholders.length) { console.error(`[migrate] ERRO: estas variáveis ainda estão com o texto de exemplo (<...>): ${placeholders.join(', ')}`); process.exit(2); }

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

function buildSchema() {
  const out = mkdtempSync(join(tmpdir(), 'kobly-schema-'));
  execFileSync(process.execPath, [join(SERVER, 'tools/build-schema.mjs'), out], { stdio: 'ignore' });
  return { out, files: JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).filter((m) => !m.skipped).map((m) => m.file) };
}

process.on('unhandledRejection', (e) => { console.error('[migrate] ERRO:', e && e.message ? e.message : e); process.exit(1); });
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const { writer, dbname } = (await c.query(`select current_user as writer, current_database() as dbname`)).rows[0];
  // papel de login do PostgREST (senha sempre a da variável: trocar a variável troca a senha)
  await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'kobly_authenticator') then create role kobly_authenticator noinherit login; end if; end $$`);
  await c.query(`alter role kobly_authenticator with login noinherit password ${lit(authPass)}`);

  const { out, files } = buildSchema();
  // aplica um arquivo dizendo qual falhou (a mensagem do Postgres sozinha não diz)
  const apply = async (name, sql) => {
    try { await c.query(sql); }
    catch (e) { throw new Error(`falhou em ${name}: ${e.message}${e.position ? ` (posição ${e.position})` : ''}`); }
  };
  const tracked = (await c.query(`select to_regclass('kobly_meta.applied') as t`)).rows[0].t
    && (await c.query(`select count(*)::int as n from kobly_meta.applied`)).rows[0].n > 0;
  const hasAuth = !!(await c.query(`select to_regclass('auth.users') as t`)).rows[0].t;

  if (!tracked && hasAuth) {
    // montagem anterior que parou no meio (sem nenhum usuário = sem dado real): limpa e começa de novo
    const users = (await c.query(`select count(*)::int as n from auth.users`)).rows[0].n;
    if (users > 0) throw new Error('o banco já tem usuários mas não tem o controle de migrações: confira à mão antes de continuar');
    log('montagem anterior incompleta: limpando o banco (não há usuários) para recomeçar');
    await c.query(`drop schema if exists public, auth, vault, cron, net, extensions, kobly_meta cascade; create schema public; grant all on schema public to ${ident(writer)}, public`);
  }

  // tudo numa transação: se um arquivo falhar, nada fica pela metade
  await c.query('begin');
  try {
    await c.query(`create schema if not exists kobly_meta; create table if not exists kobly_meta.applied (file text primary key, at timestamptz not null default now())`);
    const mark = async (list) => { for (const x of list) await c.query(`insert into kobly_meta.applied (file) values ($1) on conflict do nothing`, [x]); };
    if (!tracked) {
      log(`banco vazio: montando tudo (${files.length} arquivos)…`);
      const boot = readFileSync(join(SERVER, 'sql/000_bootstrap.sql'), 'utf8').replace(/^\\set .*$/gm, '')
        .replace(/:"writer"/g, ident(writer)).replace(/:"authenticator"/g, '"kobly_authenticator"').replace(/:"dbname"/g, ident(dbname));
      await apply('000_bootstrap.sql', boot);
      await c.query(`set local search_path to "$user", public, extensions`);
      for (const x of files) await apply(x, readFileSync(join(out, x), 'utf8'));
      await apply('001_session_grace.sql', readFileSync(join(SERVER, 'sql/001_session_grace.sql'), 'utf8'));
      await mark(files);
      log(`${files.length} arquivos aplicados`);
    } else {
      await c.query(`set local search_path to "$user", public, extensions`);
      const done = new Set((await c.query(`select file from kobly_meta.applied`)).rows.map((r) => r.file));
      const pending = files.filter((x) => !done.has(x) && x !== '900_grants.sql');
      for (const x of pending) { log(`aplicando ${x}`); await apply(x, readFileSync(join(out, x), 'utf8')); }
      if (pending.length) { await apply('900_grants.sql', readFileSync(join(out, '900_grants.sql'), 'utf8')); await mark(pending); }
      log(pending.length ? `${pending.length} migração(ões) nova(s) aplicada(s)` : 'banco em dia');
    }
    await c.query('commit');
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; }
} finally { await c.end(); }

// primeiro Administrador da Kobly (painel de servidores WhatsApp, clientes, planos)
const adminEmail = (process.env.KOBLY_ADMIN_EMAIL || '').trim().toLowerCase();
{ // usuário criado por engano com o texto de exemplo do guia como e-mail: apaga (a senha dele também era o exemplo)
  const d = new pg.Client({ connectionString: url }); await d.connect();
  const r = await d.query(`delete from auth.users where email like '<%' or email not like '%@%' returning email`).catch(() => ({ rowCount: 0 }));
  if (r.rowCount) log(`removido(s) ${r.rowCount} usuário(s) com e-mail de exemplo`);
  await d.end();
}
if (adminEmail && process.env.KOBLY_ADMIN_PASSWORD) {
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(adminEmail)) { console.error('[migrate] ERRO: KOBLY_ADMIN_EMAIL não é um e-mail válido'); process.exit(2); }
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
