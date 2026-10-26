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

### IA com a chave do cliente, novos gateways e Facebook Ads (migrações `0076`, `0077`)
- **IA (BYOK)** — rota `ai-keys` (providers | list | connect | models | set_model | activate | remove). Provedores: OpenAI, Google Gemini, DeepSeek e OpenRouter pela API no formato OpenAI; Anthropic (Claude) pelo SDK oficial `@anthropic-ai/sdk` (modelo padrão `claude-opus-5-5`, com `fallbacks: "default"` nos modelos que aceitam). A chave é conferida listando os modelos, fica cifrada e uma só fica ativa por empresa. `src/ai/router.js` → `forOrg(orgId)`: o motor, o agente e o copiloto usam a chave da empresa. A chave da plataforma (`AI_API_KEY`) só vale para quem não tem chave se `AI_PLATFORM_FALLBACK=true`; sem isso os blocos de IA saem por "Erro" pedindo a chave.
- **Gateways** — `src/payments/pix_br.js`: Mercado Pago (`POST /v1/payments` com `X-Idempotency-Key`, consulta `GET /v1/payments/{id}`) e Woovi/OpenPix (`POST /api/v1/charge?return_existing=true`, consulta `GET /api/v1/charge/{id}`), ambos só Pix em BRL. Cada provedor diz o que cobra (`methods`), se aceita valor livre e como ler o aviso; a validação do fluxo avisa se o bloco Cobrança pedir outra moeda. Na Woovi o webhook é cadastrado no painel dela (botão "Copiar webhook").
- **Facebook Ads** — rota `meta-ads` (discover | connect | accounts | disconnect | insights). Marketing API `GET /act_{id}/insights?level=campaign` (`META_ADS_GRAPH_BASE`, padrão v26.0), token de usuário do sistema com `ads_read`, cifrado e enviado no cabeçalho. Cache de 1 min; a tela atualiza a cada minuto. Cruza com a Kobly por `utm_campaign` = nome ou ID da campanha: leads, compras do checkout, vendas recuperadas e ROAS real.
- **SMS desligado** — `src/lib/features.js` (`SMS_ENABLED = false`) esconde o SMS das telas; nas funções do Supabase, `process-steps` pula e `bulk-send` recusa SMS enquanto `SMS_ENABLED` não for `true`. Nada foi apagado.
- Testes: `test/byok_gateways_ads.unit.test.js`, `test/byok_gateways_ads.integration.test.js`.

### PushinPay, SyncPay, Cakto e PerfectPay (migração `0078`)
- **PushinPay** (`doc.pushinpay.com.br`): `POST https://api.pushinpay.com.br/api/pix/cashIn` (centavos, mín. R$ 0,50, `webhook_url` por cobrança), consulta `GET /api/transactions/{id}` (status created | paid | canceled | expired; a PushinPay limita a consulta a 1 por minuto, por isso só consultamos ao receber o aviso). Credencial conferida por uma consulta de transação inexistente (404 = token aceito, 401 = recusado).
- **SyncPay** (`syncpay.apidog.io`): token em `POST /api/partner/v1/auth-token` (Client ID + Secret, vale 1 h e fica em cache — pedir de novo antes dá 429), cobrança `POST /cash-in` (reais, mín. R$ 1,00, `client.cpf` se o lead tiver documento), consulta `GET /transaction/{identifier}`. A SyncPay não publica a lista de status: só um status claramente "pago" (paid, completed, approved…) confirma; qualquer outro deixa pendente. **Testar com uma cobrança real de R$ 1,00 antes de usar em produção.**
- Avisos de gateway em `application/x-www-form-urlencoded` também são aceitos (além de JSON).
- **Postback Cakto** (`{ secret, event, data }`: purchase_approved, purchase_refused, pix_gerado, boleto_gerado, refund, chargeback, checkout_abandonment, subscription_canceled) e **PerfectPay** (`sale_status_enum`: 2/10 aprovada, 1 pendente → boleto ou Pix, 0 + checkout_saved ou 12 → abandono, 5 recusada, 6/13 cancelada, 7 reembolso, 9 chargeback; UTMs vêm em `metadata`). A PerfectPay é reconhecida antes da NexoPayt (as duas mandam `customer` sem `event`). Mesma regra no `postback-receiver` do Supabase.
- Sem documentação pública utilizável (não implementados): NexusPag (páginas bloqueiam leitura automática; faltam campos da resposta e a consulta), SigiloPay, Beehive, Kairos, SkalePayments, Wiven, Magn.cash; postbacks de Kiwify, Kirvano, Braip, GGCheckout, MundPay, Payt e Zenith (formato do aviso de venda não publicado).
- Testes: `test/more_gateways.unit.test.js`, `test/more_gateways.integration.test.js`.

### Plataformas com página própria e Zenith (migração `0079`)
- Integrações → **Plataformas** (aba inicial): um cartão por plataforma de venda e por gateway (`src/lib/platforms.js`, `src/routes/PlatformsTab.jsx`), cada um com a sua página (o que faz, passo a passo, conexões, último aviso). Sem o arquivo de logo oficial, o cartão mostra as iniciais na cor da marca (`logo` no catálogo aponta para `/assets/platforms/<id>.svg` quando houver).
- Rota `platforms` (list | connect_manual | connect_api | update_secret | disconnect). Cada conexão é um `postback_token` com `platform` e `platform_secret`; a URL é a do `postback-receiver` de sempre (funciona no Supabase e no servidor novo).
  - **Kiwify (API)**: `POST https://public-api.kiwify.com/v1/oauth/token` (client_id/client_secret) e `POST /v1/webhooks` com `x-kiwify-account-id`, `products: "all"`, gatilhos de venda e um token gerado pela Kobly. Cada aviso vem com `?signature=` = HMAC-SHA1(token, corpo cru); conferido com o vetor oficial da documentação.
  - **Cakto (API)**: `POST https://api.cakto.com.br/public_api/token/`, `GET /products/` (o webhook exige a lista de produtos) e `POST /webhook/`; o `fields.secret` da resposta é conferido no campo `secret` de cada aviso.
  - **Hotmart** (hottok), **PerfectPay** (`token` no corpo), **Payt** (`integration_key` no corpo) e **Kirvano** (sem prova documentada): pela URL, com passo a passo. Com a chave salva, aviso sem a prova certa é recusado (401).
  - Desconectar desativa a URL e, nas conexões por API, remove o webhook da conta do cliente.
- Postback reconhece **Kiwify** (`order_id`, `order_status`, `webhook_event_type`; cliente/produto/valor lidos em `Customer`/`customer`, `Commissions.charge_amount` em centavos) e **Kirvano** (`event` PIX_GENERATED, SALE_APPROVED, ABANDONED_CART…, `total_price` em texto "R$ 1.169,80"). Payt ganhou `expired` e `peding_refund` (grafia da doc). O formato que o código chamava de NexoPayt é o da Payt.
- **Zenith** no bloco Cobrança (`src/payments/zenith.js`): `POST /integrations/checkouts` (X-API-Key/X-API-Secret, Idempotency-Key, valor em centavos), SPEI em MXN (CLABE no `nextAction.bank_transfer`), consulta `GET /integrations/checkouts/:id`; ao conectar, registra o webhook da Kobly em `/integrations/webhooks/endpoints` e confere a chave em `/integrations/payment-methods`. Opção de sandbox.
- Testes: `test/platforms.unit.test.js`, `test/platforms.integration.test.js`.

### Conexões, WhatsApp por QR Code (Uazapi) e pixels TikTok/Google (migração `0080`)
- Integrações virou menu vertical: **Conexões** (primeiro), **Gateways de pagamento** (checkouts e gateways num nome só), **Trackeamento** (saiu do menu lateral), IA, Postback, Configuração da loja (identidade e remetente), Tags, Modelos, Acesso de IA. A aba "Pagamentos e alertas" saiu: gateway em Gateways, Pixel em Trackeamento, Telegram em Conexões. Outra tela abre uma seção gravando o id em `sessionStorage['kobly:int-section']`.
- **Uazapi** (`src/whatsapp/uazapi.js`, rota `uazapi`: list | create | qrcode | status | disconnect | remove): servidor da Kobly em `UAZAPI_BASE_URL` + `UAZAPI_ADMIN_TOKEN` (sem eles a opção aparece desativada). `POST /instance/create` (admintoken) → token da instância cifrado; `POST /webhook` aponta para `/webhooks/uazapi/<id>` (eventos messages e connection, sem o que a própria API enviou); `POST /instance/connect` gera o QR; `GET /instance/status` é consultado pela tela a cada 3 s. Disconnect/excluir usam `POST /instance/disconnect` e `DELETE /instance` (não estavam na parte pública da doc: conferir no servidor real).
- Aviso da Uazapi só é aceito com o `token` da própria instância; mensagens de grupo e as enviadas pela conta são ignoradas. A mensagem entra em `whatsapp_inbound_messages` (`instance_id`) e segue o mesmo caminho do oficial (Chats ao vivo, retomada de fluxos).
- Envio de texto: API oficial quando a empresa tem; senão o número do QR (`waRouted` em app.js). Sem API oficial não há janela de 24 h (fluxo e Chats liberam o texto livre). Modelos, mídia e botões continuam só pela API oficial.
- **Pixels** (`src/payments/pixel.js`, coluna `provider`): Meta (API de Conversões), **TikTok** (`POST business-api.tiktok.com/open_api/v1.3/event/track/`, `Access-Token`, e-mail e telefone +DDI em SHA-256, compra = CompletePayment, lead = SubmitForm) e **Google** (GA4 Measurement Protocol `mp/collect?measurement_id=G-…&api_secret=…`, client_id estável por lead, purchase com transaction_id; o "Testar" usa `/debug/mp/collect`).
- Testes: `test/uazapi_pixels.unit.test.js`, `test/uazapi_pixels.integration.test.js`.

### Vários servidores Uazapi (migração `0081`)
- `uazapi_servers` (endereço, admintoken cifrado, limite de números, ativo). Tela **Servidores WhatsApp** só para o Administrador da Kobly (rota `uazapi-servers`: list | add | update | remove; a rota confere `tipo_user_geral = 'Administrador'`, sem empresa-alvo).
- Número novo vai para o servidor ativo com menor ocupação proporcional (`pickServer`); cada instância guarda `server_id` e todas as chamadas dela (QR, status, envio, excluir) vão para o servidor dela. Sem vaga em nenhum: erro claro "servidores cheios".
- O servidor do ambiente (`UAZAPI_BASE_URL` + `UAZAPI_ADMIN_TOKEN`) continua valendo como mais um, com limite `UAZAPI_CAPACITY` (padrão 300); instâncias dele ficam com `server_id` nulo.
- Pausar um servidor tira ele da distribuição (os números que já estão continuam funcionando). Servidor com números não pode ser removido. A tela avisa quando a ocupação total passa de 80%.
- Teste: `test/uazapi_servers.integration.test.js`.

### Mídia com upload e "apagar ao aplicar etiqueta" (migração `0082`)
- Bucket `flow-media` (`storage.js`): imagem, vídeo, áudio e arquivo dos blocos de mídia, até 30 MB (limites do WhatsApp por tipo: imagem 5, vídeo/áudio 16, documento 30). O tipo vem do conteúdo (`sniffMedia`); a extensão é corrigida para o tipo real e documentos são servidos como download. **Produção (Supabase):** criar o bucket público `flow-media` antes de publicar o front.
- No editor, cada mídia é um bloco próprio (Imagem, Vídeo, Áudio, Arquivo) com aba Arquivo (upload) ou URL. O bloco salvo continua `send_media` + `kind`.
- Mídia pelo WhatsApp por QR Code não depende da janela de 24 h (como o texto). Envio: `POST /send/media { number, type, file, text, docName }` na Uazapi (`audio` vai como `ptt`).
- Texto e mídia aceitam `delete_on_tag` (id de etiqueta). Enviado pela Uazapi, o id da mensagem vai para `flow_message_deletions` (`waiting`); o gatilho em `lead_tags` marca `due` quando a etiqueta entra (pelo fluxo ou à mão) e o `tick()` apaga com `POST /message/delete { id }` (até 3 tentativas, 5 min entre elas). Pela API oficial da Meta a opção não tem efeito (a Meta não apaga mensagem enviada).
- Conferido contra um servidor Uazapi real (2026-10-26): texto, imagem, PDF por `/send/media` e `/message/delete` funcionaram.
- Testes: `test/flow_media.unit.test.js`, `test/delete_on_tag.integration.test.js`.

### Bloco "Enviar e-mail" e campanhas dentro de Fluxos
- `send_email` (`email_id` de `public.emails`) no motor de grafo, com o mesmo envio do `process-steps` (`src/email/flowEmail.js`): remetente do domínio verificado da empresa → `<sender_local>@RESEND_SENDING_DOMAIN` → `MAIL_FROM`; link de descadastro assinado (`{{unsubscribe_url}}` e "Descadastrar" do rodapé) e `List-Unsubscribe` one-click; `reply_to` da empresa; quem está em `email_suppressions` não recebe.
- Variáveis do fluxo valem no assunto e no HTML (no HTML o valor entra escapado). Uma saída só ("Próximo"): lead sem e-mail ou descadastrado segue sem receber; 4xx definitivo do Resend encerra o fluxo do lead; 5xx/429/rede repetem.
- Conta em `email_events` (canal `email`), `lead_metrics.enviados` e `campaign_stats.emails_enviados`, como as campanhas.
- Variáveis de ambiente: `RESEND_API_KEY`, `MAIL_FROM`, `RESEND_SENDING_DOMAIN`, `UNSUBSCRIBE_SECRET`, `PUBLIC_BASE_URL`.
- Front: "Novo fluxo" na tela Campanhas leva para Fluxos; campanhas no formato antigo seguem rodando e editáveis ("Criar no formato antigo" ainda existe).
- Teste: `test/email_block.integration.test.js`.

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
