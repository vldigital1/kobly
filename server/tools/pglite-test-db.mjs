// Banco de TESTE descartável, sem instalar Postgres: PGlite (Postgres real em WebAssembly) montado
// exatamente como o dize-db — bootstrap → migrações transformadas pelo build-schema → 900_grants → 001_session_grace.
//
//   node tools/pglite-test-db.mjs            só aplica tudo e diz se passou (checagem das migrações)
//   node tools/pglite-test-db.mjs --serve    deixa ouvindo em postgres://postgres@127.0.0.1:5544/postgres
//   KOBLY_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5544/postgres npm run test:integration
//
// Limite: o PGlite tem UMA conexão; o socket multiplexa as do pool. Transações concorrentes não ficam
// isoladas, então testes de disputa entre workers (skip locked) só valem num Postgres de verdade.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { moddatetime } from '@electric-sql/pglite/contrib/moddatetime';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PGLITE_PORT || 5544);
const db = await PGlite.create({ extensions: { pgcrypto, uuid_ossp, citext, moddatetime } });

async function run(label, sql) {
  try { await db.exec(sql); console.log('ok  ', label); }
  catch (e) {
    console.error('FALHOU', label, '→', e.message);
    const pos = Number(e.position); if (pos) console.error('   perto de:', JSON.stringify(sql.slice(Math.max(0, pos - 160), pos + 80)));
    process.exit(1);
  }
}

await run('papel authenticator', `create role kobly_authenticator noinherit login`);
const boot = readFileSync(join(SERVER, 'sql/000_bootstrap.sql'), 'utf8')
  .replace(/^\\set .*$/gm, '')
  .replace(/:"writer"/g, '"postgres"').replace(/:"authenticator"/g, '"kobly_authenticator"').replace(/:"dbname"/g, '"postgres"');
await run('000_bootstrap.sql', boot);
await db.exec(`set search_path to "$user", public, extensions`);

const out = mkdtempSync(join(tmpdir(), 'kobly-schema-'));
execFileSync(process.execPath, [join(SERVER, 'tools/build-schema.mjs'), out], { stdio: 'inherit' });
for (const m of JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))) {
  if (m.skipped) { console.log('pula', m.file, `(${m.skipped})`); continue; }
  await run(m.file, readFileSync(join(out, m.file), 'utf8'));
}
await run('001_session_grace.sql', readFileSync(join(SERVER, 'sql/001_session_grace.sql'), 'utf8'));
const t = await db.query(`select count(*)::int n from information_schema.tables where table_schema = 'public'`);
console.log(`\nbanco pronto: ${t.rows[0].n} tabelas em public`);

if (process.argv.includes('--serve')) {
  await new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1', maxConnections: 10 }).start();
  console.log(`ouvindo em postgres://postgres@127.0.0.1:${PORT}/postgres`);
} else await db.close();
