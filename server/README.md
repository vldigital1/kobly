# kobly-api (dize-db)

Substitui o Supabase do Kobly por: Postgres no dize-db + PostgREST (mesma API de tabelas que o front já usa)
+ este serviço (login/sessões; depois, as rotas que eram Edge Functions).

## Peças
- `sql/000_bootstrap.sql` (em `server/sql/`): papéis `kobly_anon|authenticated|service_role`, schemas `auth`, `vault`, `cron`, `net`, `extensions`, e `auth.uid()/jwt()/role()` lendo `request.jwt.claims` (o PostgREST preenche).
- `tools/build-schema.mjs`: gera o esquema a partir de `supabase/migrations/` (troca os nomes dos papéis; **exclui a 0013**, que criava usuários demo com senha publicada) + `900_grants.sql`.
- `src/`: login (PBKDF2 100k), JWT HS256 de 1 h, refresh rotativo de 30 dias (só o SHA-256 fica no banco), trava de conta após 5 falhas, limite por IP, recuperação de senha de uso único.
- `tools/create-user.mjs`: cria usuário de teste/operação (senha vem de `KOBLY_NEW_PASSWORD`, nunca de argumento).

## Rotas
`/rest/v1/*` → PostgREST (RLS por JWT); `/functions/v1/<nome>` → rotas que eram Edge Functions (501 `not_ported` até serem portadas); tempo real do chat = consulta periódica no cliente.
`POST /auth/login|signup|refresh|logout|recover|reset|confirm|password`, `GET /auth/user`, `GET /health`.

## Testes
`npm test` (unitários sempre; integração só com `KOBLY_TEST_DATABASE_URL` apontando para um Postgres **descartável** com o esquema aplicado).

Sem Postgres instalado, use o banco de teste em memória (PGlite, Postgres real em WebAssembly), montado igual ao dize-db:
- `npm run test:db` — aplica bootstrap + todas as migrações + grants e diz se passou (checagem rápida de migração nova).
- `npm run test:db:serve` — idem e fica ouvindo em `postgres://postgres@127.0.0.1:5544/postgres`; em outro terminal:
  `KOBLY_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5544/postgres npm test` (unitários + integração).
- Limite: o PGlite tem uma conexão só (o socket multiplexa o pool), então disputa entre workers concorrentes (`skip locked`) só é prova num Postgres de verdade.

## Ambiente local completo (Windows, sem instalar nada como administrador)
`node tools/dev-local.mjs` sobe PostgreSQL 18 portátil + esquema completo + PostgREST + kobly-api; na primeira vez cria uma conta Cliente de teste e dados de demonstração (seed_demo + uma campanha com fluxo em grafo). Depois, na raiz: `node scripts/dev-local-front.mjs` → http://localhost:5173.
- Tudo fica em `~/.kobly-local` (ou `KOBLY_LOCAL_DIR`): **fora do OneDrive** (não sincroniza arquivos de banco) e num caminho sem acento (o PostgreSQL no Windows não aceita "Á" no caminho).
  - `pgsql/` — zip oficial "postgresql-18.x-windows-x64-binaries" (bin, lib, share; pode apagar pgAdmin/doc/symbols).
  - `bin/postgrest.exe` — release oficial do PostgREST para Windows (usa a `libpq.dll` de `pgsql/bin`).
  - `pgdata/` dados · `credenciais.json` e-mail/senha da conta de teste e segredos locais (nunca usar em produção).
- Portas: PostgreSQL 54329, PostgREST 54330, API 4120. Ctrl+C para tudo. Para recomeçar do zero: apague `~/.kobly-local/pgdata`.
- Ao subir de novo, aplica só as migrações novas (controle em `kobly_local.applied`; bancos criados antes dele contam como montados até a 0073).

## Estado
Etapa 1 (banco + login) e Etapa 2 (front ligado: `src/api/apiClient.js`) prontas em desenvolvimento (`https://kobly-api-dev.dizevolv.com`). Ainda 501: ai-chat, send-email, send-whatsapp (substituído pela rota whatsapp-account; envio das campanhas depende do motor), send-sms, bulk-send, asaas, resend-admin, invite-client, webhooks de entrada e agendador. `cron.schedule`/`net.http_post` são stubs: o agendador (process-steps, process-bulk, reset de uso) passa a ser do serviço.

## WhatsApp oficial (Meta Cloud API) — uma conta por empresa
- Cada empresa conecta o PRÓPRIO número (tela Integrações → WhatsApp): ID da conta WhatsApp Business, ID do número e token permanente. O serviço confere na Meta antes de salvar.
- Token e segredo do app ficam **cifrados** (AES-256-GCM, chave `KOBLY_SECRET_KEY` no ambiente do serviço) em `whatsapp_accounts`; o cliente só lê as colunas seguras (grant por coluna) e não escreve direto.
- Só modelos **aprovados** pela Meta iniciam conversa: `whatsapp_templates` (sincronizar/criar pela tela; status atualiza por webhook).
- Webhook por empresa: `GET/POST /webhooks/whatsapp/<id>` — verificação por token, POST validado por `X-Hub-Signature-256` (segredo do app da empresa, ou `META_APP_SECRET` global). Grava entregue/lido/falha em `email_events` e trata "SAIR" como descadastro (`leads.whatsapp_opt_out`).
- Rota: `POST /functions/v1/whatsapp-account` com `action` = status | connect | disconnect | sync_templates | create_template | send_test.
- Variáveis de ambiente: `KOBLY_SECRET_KEY` (32 bytes base64), `PUBLIC_BASE_URL`, `POSTGREST_URL`, opcionais `META_APP_SECRET`, `META_GRAPH_BASE`.
- O usuário do banco do serviço precisa poder `set role kobly_authenticated` (o `000_bootstrap.sql` concede ao :writer; o serviço checa isso ao subir).

## Entrada de vendas e motor de disparos
- `POST /functions/v1/postback-receiver?token=pbk_…` (público; o token identifica a empresa). Aceita o contrato Kobly, Hotmart, NexoPayt e ENTITY. Evento desconhecido/sem e-mail → 200 + `webhook_dead_letter`; reentrega → 200 `deduped`; token inválido → 401. Cria/atualiza o lead, credita venda recuperada e enfileira os passos das campanhas **Ativas** cujo gatilho casa.
- Motor (`src/engine/steps.js`): a cada `ENGINE_INTERVAL_MS` (30 s; `ENGINE_ENABLED=false` desliga) pega passos vencidos com lease (`for update skip locked`), executa **WhatsApp por modelo aprovado** e tags; retry com backoff (4 tentativas), SAIR respeitado, condição comprou/não comprou, cota estornada ao desistir.
- E-mail e SMS ainda NÃO foram portados: seus passos ficam na fila, intocados.

## Motor de fluxos em grafo (fase 1)
Migração `0069`. Campanha com versão de grafo **ativa** sai do motor antigo (etapas lineares) e passa a rodar aqui; as demais seguem iguais.
- Grafo: `{ version: 1, start: 'ini', nodes: [{ ref, type, data, next: { <saída>: <ref> } }] }`, validado em `src/flows/graph.js` (tipos, saídas, alvos, laço sem espera).
- Blocos: `trigger` (eventos de checkout; `stop_on_purchase`), `send_template`, `send_text` (janela de 24 h; com `fallback_template_id` troca sozinho para o modelo quando a janela está fechada), `delay` (fixo ou aleatório), `wait_reply` (salva em variável; saídas `reply`/`timeout`), `condition` (etiqueta, variável, comprou, janela aberta, dia, horário, país por DDI; E/OU), `tag`, `set_var` (texto ou conta), `end`.
- Variáveis nos textos: `{{nome}}`, `{{primeiro_nome}}`, `{{produto}}`, `{{valor}}`, `{{cta_link}}`, `{{resposta}}`, `{{hora_atual}}`, `{{lead.email}}`, `{{evento.tipo}}`, `{{var.x}}`.
- Execução por lead em `flow_executions` (uma viva por campanha+lead), trilha por bloco em `flow_execution_events`. Ciclo a cada `FLOW_INTERVAL_MS` (5 s); resposta do lead retoma na hora.
- Caixa de entrada: o webhook da Meta grava tudo em `whatsapp_inbound_messages`, atualiza `leads.whatsapp_last_inbound_at` (janela de 24 h) e retoma quem aguardava resposta.
- Compra aprovada encerra as execuções de recuperação do lead.
- Rota: `POST /functions/v1/flow-graph` com `action` = validate | get | save (nova versão ativa) | activate (desfazer para uma versão) | deactivate (volta ao motor antigo) | stats (leads por bloco) | cancel_execution.

### Fase 2 — blocos de conversa
- `send_media` (imagem/áudio/vídeo/documento por link https), `send_buttons` (até 3 = botões, 4–10 = lista; cada opção vira a saída `opt_<id>`, mais `other`/`timeout`/`failed`; também casa a resposta digitada pelo texto ou número da opção).
- `delay` em segundos (`seconds` ou `min_seconds`/`max_seconds`, aleatório) com `typing: true` ("digitando..." com a janela aberta). Esperas curtas retomam no segundo certo.
- `ai_classify` (saídas `out_<chave>` + `other`/`error`) e `ai_extract` (campos viram variáveis; `ok`/`missing`/`error`). A mensagem do lead vai como dado delimitado e só valem chaves configuradas.
- IA: `AI_API_KEY` (obrigatória para os blocos de IA), `AI_BASE_URL` (padrão `https://api.deepseek.com`), `AI_MODEL` (padrão `deepseek-chat`). Qualquer API compatível com OpenAI.
- Editor visual: `src/routes/FlowGraphEditor.jsx` (Campanhas → ícone de ramificação). Prévia sem backend em DEV: `/flow-preview.html`.

### Fase 3 — dinheiro (migração `0070`)
- Cada empresa conecta a PRÓPRIA conta XPag (Integrações → Pagamentos e Pixel; rota `payment-integrations`: list | connect | disconnect). O Client Secret é validado na XPag (`GET /balance`) e guardado cifrado (`KOBLY_SECRET_KEY`).
- Bloco `payment`: BRL Pix, MXN SPEI/OXXO, COP Nequi/Bre-B, ARS transferência, CLP. Saídas `charge_created` (segue o funil com `{{pagamento_codigo}}`, `{{pagamento_qr}}`, `{{pagamento_link}}`, `{{pagamento_valor}}`…), `error` e `payment_approved`.
- `payment_approved` é PREEMPÇÃO, não espera: quando o pagamento é confirmado (até `listen_hours`, padrão 48 h), a execução é puxada para essa saída esteja onde estiver (até reaberta se já tinha terminado).
- Confirmação: `POST /webhooks/payments/xpag/<token>` (o token só identifica a credencial). A XPag não documenta assinatura no aviso, então o serviço **consulta a transação na API** (`GET /consult-transaction`) antes de liberar. Aviso repetido é ignorado; se a consulta falhar, responde 503 e o gateway reenvia.
- Cada nova passagem pelo bloco gera cobrança nova (`external_id = kb-<execução>-<bloco>-<n>`); a repetição após falha temporária reusa a mesma (idempotente).
- `record_sale`: grava em `flow_sales` (uma por cobrança) e soma em vendas recuperadas da campanha. A condição "comprou" também considera cobranças confirmadas.
- `pixel`: API de Conversões da Meta (rota `pixel-configs`: list | save | delete | test). E-mail/telefone só em hash SHA-256; Purchase usa o id da cobrança como `event_id` (sem contagem dupla).
### Fase 4 — escala (migração `0071`)
- `ai_agent`: conversa em vários turnos (objetivo + base de conhecimento + tom). Cada resposta do lead vira um turno; a IA devolve a resposta e a ação (`continuar`/`concluido`/`humano`). Saídas `done`, `handoff`, `expiration` (sem resposta no prazo) e `error`. Histórico (últimas 24 falas) fica na execução. Sem `opening`, responde a última mensagem do lead; nunca pede senha/cartão.
- `split` (teste A/B por pesos, saída `var_<id>`; o lead fica sempre no mesmo caminho), `checkpoint` (ponto contado no funil).
- `wait_until`: próximo horário comercial (dias + abre/fecha) ou data e hora, sempre no fuso da empresa (`organizations.timezone`, horário de verão incluso).
- `notify`: alerta no Telegram pelo bot da empresa (rota `notify-channels`: list | save | delete | test; token cifrado, conferido com `getMe`). O fluxo segue mesmo se o alerta falhar.
- `flow-graph` action `stats` agora devolve `by_ref` (leads por bloco) e `waiting_at` (parados agora) — o botão "Métricas" do editor mostra no canvas.
### Fase 5 — MCP da Kobly e copiloto (migração `0072`)
- `POST /mcp` (Model Context Protocol, HTTP): `Authorization: Bearer kbmcp_...`. Tokens em Integrações → Acesso de IA (rota `mcp-tokens`: list | create | revoke); o token aparece uma vez, no banco fica só o SHA-256; 60 chamadas/min por token. A empresa vem SEMPRE do token.
- Ferramentas: `kobly_guia` (formato, regras e todos os blocos), `kobly_listar_campanhas`, `kobly_recursos` (modelos, etiquetas, contas de pagamento, pixels, canais — sem segredos), `kobly_ler_fluxo`, `kobly_validar_fluxo`, `kobly_salvar_rascunho`, `kobly_metricas` (sem dados pessoais), `kobly_copiloto`. Não existe ferramenta de publicar.
- Rascunhos: `flow_graph_versions.is_draft/source/note`. `flow-graph` ganhou `save_draft`, `get_version` e `copilot`; `activate` (publicar rascunho ou voltar versão) revalida antes.
- Copiloto (`src/flows/copilot.js`): regras sobre a trilha real (não responde, janela fechada, falha de envio, erro/baixa conversão da cobrança, IA sem saída, agente abandonado/pedindo humano, A/B com vencedor ou empate, estrutura sem venda/pixel/plano B). Mínimo de 20 leads por bloco (30 por caminho no A/B). A IA só resume os fatos calculados.
- Conectar no Claude Code: `claude mcp add --transport http kobly https://<api>/mcp --header "Authorization: Bearer <token>"`.
- Variável opcional: `XPAG_BASE_URL` (padrão `https://api.xpag.global`). Testado contra o sandbox público da XPag: Pix e SPEI criados e consultados; pagamento simulado passa a `confirmed` na consulta. Valor livre (SPEI) foi recusado no sandbox — conferir em produção.

### Chats ao vivo e Configurações (migração `0074`)
- Menu em seções (Principal / Operações / Gestão) com telas novas: **Fluxos** (lista dos fluxos em grafo; `flow-graph` ação `list`; criar fluxo já salva o 1º rascunho gatilho → fim), **Chats ao vivo**, **Agentes de IA** e **Configurações**.
- `whatsapp_outbound_messages`: tudo que sai pelo WhatsApp oficial (fluxo, agente, humano). Com `whatsapp_inbound_messages` forma a conversa.
- Rota `inbox`: list | messages | send (texto livre só com a janela de 24 h aberta) | pause. Assumir a conversa (`leads.automation_paused`) encerra as execuções vivas do lead; o motor não inicia nem retoma fluxos dele até devolver.
- Rota `workspace-settings`: get | update_org (nome, fuso) | upsert/delete por `kind` (quick_reply, custom_field, global_var, agent). Cliente só lê as tabelas; escrita só pela rota.
- Mensagens dos fluxos aceitam `{{global.chave}}` (variáveis globais) e `{{campo.chave}}` (`leads.custom_fields`). O bloco Agente de IA aceita `agent_id` (agente salvo); o que o bloco preencher sobrepõe o agente.
- Teste com banco: `test/workspace.integration.test.js`.

### Equipe, Produtos e Trackeamento (migração `0075`)
- Rota `team`: list | invite | resend | set_role | remove. `profiles.team_role` = `admin` (configura tudo) ou `atendente`. O dono (`organizations.user_fundador_id`) é sempre admin e não sai. Convite = mesmo link de "definir senha" do convite de cliente; sem provedor de e-mail, o link volta para quem convidou repassar. Remover tira a empresa do perfil e apaga as sessões.
- Trava do atendente no servidor, num lugar só: `functions/index.js` → `atendentePode` (inbox; leitura de configurações/fluxos). Tudo que não estiver na lista é 403. O gatilho `profiles_team_role_guard` impede trocar o próprio papel pelo PostgREST. Limite: tabelas que o front grava direto pelo PostgREST (leads, pipeline, campanhas) seguem só a RLS da empresa; a tela esconde o que o atendente não usa.
- Rota `products`: list (números do período + nomes vistos no checkout fora do catálogo) | upsert | delete. Casa por nome ou apelido (ID do checkout).
- UTM: `src/ingest/utm.js` lê utm_*, src e sck do postback (topo, TrackingParameters, purchase.origin, utm/tracking, URL do checkout). `webhook_events.utm` guarda o do evento; `leads.utm` o 1º toque. O postback do Supabase (produção) faz o mesmo.
- Rota `tracking`: get | report (por utm_source/campaign/medium/content/src/sck) | connect_utmify (testa a credencial com `isTest`) | disconnect_utmify.
- UTMify (`src/tracking/utmify.js`, API `POST https://api.utmify.com.br/api-credentials/orders`): só as cobranças geradas pelo FLUXO vão (aguardando pagamento → pago), com os UTMs do lead; vendas que nascem no checkout não (a plataforma já envia). SPEI/Nequi/Bre-B/transferência entram como `pix`, OXXO como `boleto`; moeda fora da lista da UTMify é ignorada e marcada em `payment_charges.tracking_status`.
- Testes: `test/tracking.unit.test.js`, `test/team_tracking.integration.test.js`.

## E-mails, convite e sessão
- `src/mailer.js`: e-mails da Kobly (confirmar cadastro, recuperar senha, convite) com a marca; Resend via `RESEND_API_KEY`/`MAIL_FROM`; links no `SITE_URL`. Ver `docs/ONBOARDING.md`.
- `POST /functions/v1/invite-client` (Administrador/Gestor da conta): cria o acesso do cliente (perfil Cliente, sem senha) e envia o link para definir a senha (7 dias, uso único). Não puxa para a conta quem já pertence a outra.
- Refresh token rotativo com tolerância de 60 s (`auth.sessions.rotated_at`; ambientes antigos rodam `sql/001_session_grace.sql`): se a resposta da renovação se perde, a pessoa não é deslogada.

## Logo, descadastro e link de pós-compra
- Logo: `POST /storage/v1/object/branding/<org>/<arquivo>` (login, só da própria conta, PNG/JPG/WEBP/GIF até 2 MB, tipo conferido pelo conteúdo) e `GET /storage/v1/object/public/branding/...`. Disco em `STORAGE_DIR` (padrão `/var/lib/kobly-storage`; no systemd, liberar com `ReadWritePaths`).
- Descadastro: `GET|POST /functions/v1/unsubscribe?token=` (GET só confirma; POST grava em `email_suppressions`; one-click RFC 8058). Token assinado com `UNSUBSCRIBE_SECRET` (ou derivado de `KOBLY_SECRET_KEY`). `signUnsubToken` fica pronto para o envio de e-mail usar.
- Migração `0068`: `brands.link_area_membros`. Em "Compra Aprovada", o `{{cta_link}}` do WhatsApp leva para esse link; nos demais eventos segue o link de recuperação.

## Dados de demonstração (só ambientes de teste)
`server/tools/seed_demo.sql` cria, para UMA empresa, marca, tags, e-mails, 5 campanhas com fluxo, leads, eventos de checkout e e-mails enviados/abertos/clicados dos últimos 30 dias. Idempotente (tudo marcado `seed-demo`; reexecutar recria). Uso: `psql -c "set role <writer>" -v org=<uuid> -v tamanho=80 -f seed_demo.sql`. Nunca rodar em produção de cliente.
