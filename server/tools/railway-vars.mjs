// Monta, prontos para colar no "Raw Editor" do Railway, os textos das variáveis do api e do postgrest.
//   node server/tools/railway-vars.mjs
// Pergunta só o e-mail e a senha do Administrador; gera os segredos novos e já coloca o MESMO segredo
// nos dois serviços (o JWT e a senha do banco precisam ser iguais nos dois). Nada é salvo em arquivo.
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const rl = createInterface({ input });
const lines = rl[Symbol.asyncIterator]();
const ask = async (q) => { output.write(q); const r = await lines.next(); if (r.done) { console.error('\nentrada encerrada'); process.exit(1); } return String(r.value).trim(); };
let email = '';
while (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) email = await ask('Seu e-mail de administrador: ');
let senha = '';
while (senha.length < 12 || /[<>"\s]/.test(senha)) senha = await ask('Senha do administrador (12+ caracteres, sem espaço): ');
rl.close();

const jwt = randomBytes(32).toString('hex');
const pgPass = randomBytes(24).toString('hex');
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
const line = '='.repeat(70);
console.log(`\n${line}\n1) COPIE ESTE BLOCO -> Railway, servico "api" -> Variables -> Raw Editor (apague tudo e cole)\n${line}`);
console.log(api.join('\n'));
console.log(`\n${line}\n2) COPIE ESTE BLOCO -> Railway, servico "postgrest" -> Variables -> Raw Editor (apague tudo e cole)\n${line}`);
console.log(pgrst.join('\n'));
console.log(`\n${line}\nNao mande estes textos para ninguem. Depois de colar os dois, clique em Deploy.\n${line}\n`);
