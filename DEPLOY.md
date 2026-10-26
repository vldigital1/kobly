# Colocar a Kobly no ar (Railway + Vercel)

A Kobly tem duas partes:

| Parte | O que é | Onde roda |
|---|---|---|
| **Site** (raiz do repositório: `src/`, `public/`) | telas, editor de fluxos | **Vercel** |
| **Servidor** (`server/`) | login, dados, motor dos fluxos, webhooks, WhatsApp | **Railway** (3 serviços: PostgreSQL, PostgREST e a API) |

O site só funciona com o servidor no ar, então comece pelo Railway.

---

## 0. Gere os segredos (no seu computador)

Na pasta do projeto:

```bash
node server/tools/gen-secrets.mjs
```

Ele mostra 4 linhas (`JWT_SECRET`, `KOBLY_SECRET_KEY`, `UNSUBSCRIBE_SECRET`, `PGRST_AUTHENTICATOR_PASSWORD`). Guarde num lugar seguro (gerenciador de senhas). **Não** coloque no GitHub nem mande em conversa.

> Não troque `KOBLY_SECRET_KEY` depois de usar: ela cifra os tokens de WhatsApp, gateways e chaves de IA dos clientes.

---

## 1. Railway — projeto e banco

1. Entre em **railway.com** com sua conta do GitHub → **New Project** → **Deploy from GitHub repo** → escolha o repositório da Kobly.
2. No serviço que ele criou, abra **Settings**:
   - **Service name**: `api`
   - **Source → Root Directory**: deixe **vazio** (raiz do repositório)
   - **Config-as-code → Railway Config File**: `/server/railway.json` (monta pelo `Dockerfile` da raiz, que leva junto as migrações do banco)
   - **Source → Branch**: a branch com o código novo (`feat/fase1-motor-fluxo`, ou `main` se você juntou).
3. No projeto, clique **+ Create → Database → PostgreSQL**. (O nome do serviço fica `Postgres`.)

## 2. Railway — serviço `api` (o servidor da Kobly)

Em **api → Variables → Raw Editor**, cole (troque o que está entre `< >`):

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=<do passo 0>
KOBLY_SECRET_KEY=<do passo 0>
UNSUBSCRIBE_SECRET=<do passo 0>
PGRST_AUTHENTICATOR_PASSWORD=<do passo 0>
POSTGREST_URL=http://${{postgrest.RAILWAY_PRIVATE_DOMAIN}}:3000
HOST=::
TRUST_PROXY=true
PUBLIC_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
ALLOWED_ORIGINS=https://<seu-projeto>.vercel.app
SITE_URL=https://<seu-projeto>.vercel.app
STORAGE_DIR=/data/storage
REQUIRE_EMAIL_CONFIRM=false
ENGINE_ENABLED=true
KOBLY_ADMIN_EMAIL=<seu e-mail de administrador>
KOBLY_ADMIN_PASSWORD=<senha forte, mín. 12 caracteres>
```

Depois:

- **Settings → Networking → Generate Domain**: gera o endereço público da API (ex.: `api-production-xxxx.up.railway.app`). É ele que vai na Vercel.
- **+ Create → Volume** ligado ao `api`, **Mount path** `/data` (guarda logos e mídias dos fluxos entre deploys).

Opcionais (dá para pôr depois):

```
RESEND_API_KEY=            # envio de e-mails (bloco E-mail, convites, recuperar senha)
MAIL_FROM=Kobly <contato@seudominio.com>
RESEND_SENDING_DOMAIN=     # ex.: envio.koblay.io (verificado no Resend)
UAZAPI_BASE_URL=           # servidor Uazapi padrão (ou cadastre na tela Servidores WhatsApp)
UAZAPI_ADMIN_TOKEN=
AI_API_KEY=                # IA da plataforma (cada cliente pode usar a própria chave)
META_APP_SECRET=           # API Oficial do WhatsApp
```

A cada deploy o Railway roda `node tools/migrate.mjs` antes de ligar (está no `server/railway.json`): na primeira vez monta o banco inteiro e cria o Administrador; nas próximas aplica só as migrações novas.

## 3. Railway — serviço `postgrest`

1. **+ Create → Docker Image** → `postgrest/postgrest:v16.4` (a mesma versão testada no ambiente local).
2. **Settings → Service name**: `postgrest` (o nome precisa ser esse, a variável do `api` aponta para ele). **Não** gere domínio público: só o `api` fala com ele, pela rede interna.
3. **Variables → Raw Editor**:

```
PGRST_DB_URI=postgresql://kobly_authenticator:${{api.PGRST_AUTHENTICATOR_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{Postgres.PGDATABASE}}
PGRST_DB_SCHEMAS=public
PGRST_DB_ANON_ROLE=kobly_anon
PGRST_JWT_SECRET=${{api.JWT_SECRET}}
PGRST_SERVER_HOST=*
PGRST_SERVER_PORT=3000
PGRST_DB_POOL=10
```

> O papel `kobly_authenticator` é criado pelo primeiro deploy do `api`. Se o PostgREST subir antes e der erro de senha, clique **Redeploy** nele depois que o `api` terminar.

**Deploy** nos dois. Teste abrindo `https://<endereço-da-api>/health` → deve mostrar `{"ok":true}`.

---

## 4. Vercel — o site

1. **vercel.com** → **Add New → Project** → importe o mesmo repositório.
2. **Root Directory**: deixe a raiz (`./`). O `vercel.json` já configura o build (Vite → `dist`).
3. **Environment Variables**:
   ```
   VITE_API_URL=https://<endereço-da-api-do-railway>
   ```
4. **Deploy**. A Vercel dá um endereço `https://<seu-projeto>.vercel.app`.
5. Volte no Railway → `api` → Variables e confirme `ALLOWED_ORIGINS` e `SITE_URL` com esse endereço exato (sem `/` no fim). Se mudou, o `api` reinicia sozinho.

> Mudou o endereço da API? Atualize `VITE_API_URL` na Vercel e faça **Redeploy** (a variável entra no build).

---

## 5. Primeiro acesso

1. Abra o site da Vercel e entre com `KOBLY_ADMIN_EMAIL` / `KOBLY_ADMIN_PASSWORD`.
2. **Servidores WhatsApp** (menu do Administrador): cadastre o servidor Uazapi (endereço + admin token).
3. Saia e clique **Criar conta** para ter uma conta de Cliente (é ela que tem fluxos, leads, integrações).
4. Na conta de Cliente: **Integrações → Conexões → Nova conexão → WhatsApp** e leia o QR Code.
5. Os webhooks (Uazapi, checkouts, gateways) usam `PUBLIC_BASE_URL`, que já é público no Railway.

## Atualizar depois

Cada `git push` na branch escolhida faz o Railway e a Vercel publicarem sozinhos. Migrações novas em `supabase/migrations/` entram no próximo deploy do `api`.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| Site fica na tela de login / "Failed to fetch" | `VITE_API_URL` errado na Vercel, ou `ALLOWED_ORIGINS` sem o endereço da Vercel |
| Login funciona mas as telas não carregam (erro 502) | PostgREST fora do ar ou `POSTGREST_URL` errado; veja os logs do `postgrest` |
| Deploy do `api` falha no `migrate` | `PGRST_AUTHENTICATOR_PASSWORD` com menos de 16 caracteres ou `DATABASE_URL` vazio |
| QR Code não confirma / mensagens do lead não chegam | `PUBLIC_BASE_URL` errado (a Uazapi precisa alcançar a API) |
| Logos/mídias somem depois de um deploy | falta o Volume em `/data` |
