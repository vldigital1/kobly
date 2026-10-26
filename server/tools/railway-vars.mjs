// Monta as variáveis do Railway (api e postgrest) prontas para colar no "Raw Editor".
//   node server/tools/railway-vars.mjs --email voce@exemplo.com --dir C:\pasta
// Grava 3 arquivos na pasta: 1-api.txt, 2-postgrest.txt e senha-do-site.txt (a senha do Administrador,
// gerada aqui). Copiar de arquivo evita o texto estragado que sai ao copiar da janela do terminal.
// Os mesmos segredos vão para os dois serviços (JWT e senha do banco precisam ser iguais nos dois).
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : ''; };
const email = String(arg('--email') || '').trim().toLowerCase();
const dir = arg('--dir');
if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email) || !dir) { console.error('uso: railway-vars.mjs --email voce@exemplo.com --dir <pasta>'); process.exit(2); }

const jwt = randomBytes(32).toString('hex');
const pgPass = randomBytes(24).toString('hex');
const senha = `Kobly-${randomBytes(9).toString('base64url')}`;
const api = [
  'DATABASE_URL="${{Postgres.DATABASE_URL}}"',
  `JWT_SECRET="${jwt}"`,
  `KOBLY_SECRET_KEY="${randomBytes(32).toString('base64')}"`,
  `UNSUBSCRIBE_SECRET="${randomBytes(32).toString('hex')}"`,
  `PGRST_AUTHENTICATOR_PASSWORD="${pgPass}"`,
  'POSTGREST_URL="http://${{postgrest.RAILWAY_PRIVATE_DOMAIN}}:3000"',
  'HOST="::"',
  'PORT="8080"',
  'TRUST_PROXY="true"',
  'PUBLIC_BASE_URL="https://${{RAILWAY_PUBLIC_DOMAIN}}"',
  'STORAGE_DIR="/data/storage"',
  'REQUIRE_EMAIL_CONFIRM="false"',
  'ENGINE_ENABLED="true"',
  `KOBLY_ADMIN_EMAIL="${email}"`,
  `KOBLY_ADMIN_PASSWORD="${senha}"`,
];
const pgrst = [
  `PGRST_DB_URI="postgresql://kobly_authenticator:${pgPass}@\${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/\${{Postgres.PGDATABASE}}"`,
  'PGRST_DB_SCHEMAS="public"',
  'PGRST_DB_ANON_ROLE="kobly_anon"',
  `PGRST_JWT_SECRET="${jwt}"`,
  'PGRST_SERVER_HOST="*"',
  'PGRST_SERVER_PORT="3000"',
  'PGRST_DB_POOL="10"',
];
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, '1-api.txt'), api.join('\r\n') + '\r\n');
writeFileSync(join(dir, '2-postgrest.txt'), pgrst.join('\r\n') + '\r\n');
writeFileSync(join(dir, 'senha-do-site.txt'), `Login do site da Kobly (Administrador)\r\nE-mail: ${email}\r\nSenha:  ${senha}\r\n`);
console.log(`arquivos gravados em ${dir}`);
