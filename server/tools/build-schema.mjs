// Gera o esquema do Kobly para o dize-db a partir de supabase/migrations/.
//   node server/tools/build-schema.mjs <pasta-de-saída>
// Transformações (todas mecânicas, sem mexer na lógica das migrações):
//  - papéis anon/authenticated/service_role -> kobly_anon/kobly_authenticated/kobly_service_role
//  - remove `create extension` de pg_cron/pg_net (viram stubs em 000_bootstrap.sql)
//  - exclui migrações que não valem aqui (EXCLUDE abaixo)
//  - acrescenta 900_grants.sql (o Supabase concedia privilégios de tabela por padrão)
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = process.argv[2];
if (!out) { console.error('uso: build-schema.mjs <saida>'); process.exit(2); }

// 0013 cria usuários demo com senha publicada no repositório: nunca entra.
const EXCLUDE = new Map([
  ['0013_seed_demo_auth_users.sql', 'usuários demo com senha publicada'],
]);

export function transform(sql) {
  let s = sql;
  s = s.replace(/^\s*create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;\s*$/gim, '-- (removido) create extension $1');
  s = s.replace(/\bservice_role\b/g, 'kobly_service_role');
  s = s.replace(/\banon\b/g, 'kobly_anon');
  s = s.replace(/\bauthenticated\b/g, 'kobly_authenticated');
  return s;
}

mkdirSync(out, { recursive: true });
const dir = join(root, 'supabase', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const manifest = [];
for (const f of files) {
  if (EXCLUDE.has(f)) { manifest.push({ file: f, skipped: EXCLUDE.get(f) }); continue; }
  const body = transform(readFileSync(join(dir, f), 'utf8'));
  writeFileSync(join(out, f), body);
  manifest.push({ file: f, sha256: createHash('sha256').update(body).digest('hex') });
}
const grants = `-- 900_grants.sql — privilégios de tabela/sequência (o Supabase concedia por padrão).
-- A RLS (ligada nas tabelas) é quem restringe linhas; aqui só se habilita o acesso aos objetos.
grant select, insert, update, delete on all tables in schema public to kobly_authenticated;
grant usage, select on all sequences in schema public to kobly_authenticated;
grant all on all tables in schema public to kobly_service_role;
grant all on all sequences in schema public to kobly_service_role;
grant select on all tables in schema public to kobly_anon;
-- Tabelas com segredo/escrita só pelo serviço: o grant em massa acima NÃO pode valer para elas.
revoke all on public.whatsapp_accounts from kobly_authenticated, kobly_anon;
grant select (id, organization_id, waba_id, phone_number_id, display_phone, verified_name, quality_rating,
              messaging_limit, status, last_error, webhook_public_id, verify_token, connected_at, created_at, updated_at)
  on public.whatsapp_accounts to kobly_authenticated;
revoke all on public.whatsapp_templates from kobly_authenticated, kobly_anon;
grant select on public.whatsapp_templates to kobly_authenticated;
-- Motor de fluxos (0069): grafo, execuções, trilha e caixa de entrada são escritos só pelo serviço.
revoke all on public.flow_graph_versions, public.flow_executions, public.flow_execution_events, public.whatsapp_inbound_messages from kobly_authenticated, kobly_anon;
grant select on public.flow_graph_versions, public.flow_executions, public.flow_execution_events, public.whatsapp_inbound_messages to kobly_authenticated;
-- Pagamentos, vendas e Pixel (0070): segredos não legíveis; escrita só pelo serviço.
revoke all on public.payment_integrations, public.payment_charges, public.payment_webhook_events, public.flow_sales, public.pixel_configs from kobly_authenticated, kobly_anon;
grant select (id, organization_id, provider, label, client_id, sandbox, status, last_error, created_at, updated_at) on public.payment_integrations to kobly_authenticated;
grant select on public.payment_charges, public.flow_sales to kobly_authenticated;
grant select (id, organization_id, label, pixel_id, test_event_code, created_at, updated_at) on public.pixel_configs to kobly_authenticated;
-- Canais de alerta (0071): token do bot não legível; escrita só pelo serviço.
revoke all on public.notification_channels from kobly_authenticated, kobly_anon;
grant select (id, organization_id, kind, label, default_chat_id, created_at, updated_at) on public.notification_channels to kobly_authenticated;
-- Tokens do MCP (0072): só o hash fica no banco; escrita só pelo serviço.
revoke all on public.mcp_tokens from kobly_authenticated, kobly_anon;
grant select (id, organization_id, label, token_prefix, last_used_at, revoked_at, created_at) on public.mcp_tokens to kobly_authenticated;
-- Chats ao vivo e configurações da automação (0074): escrita só pelo serviço.
revoke all on public.whatsapp_outbound_messages, public.quick_replies, public.custom_fields, public.global_variables, public.ai_agents from kobly_authenticated, kobly_anon;
grant select on public.whatsapp_outbound_messages, public.quick_replies, public.custom_fields, public.global_variables, public.ai_agents to kobly_authenticated;
-- Produtos e UTMify (0075): token da UTMify não legível; escrita só pelo serviço.
revoke all on public.products, public.tracking_integrations from kobly_authenticated, kobly_anon;
grant select on public.products to kobly_authenticated;
grant select (id, organization_id, provider, token_hint, status, last_error, last_sent_at, created_at, updated_at) on public.tracking_integrations to kobly_authenticated;
-- Chaves de IA dos clientes (0076): chave não legível; escrita só pelo serviço.
revoke all on public.ai_credentials from kobly_authenticated, kobly_anon;
grant select (id, organization_id, provider, label, key_hint, model, is_active, status, last_error, last_used_at, created_at, updated_at) on public.ai_credentials to kobly_authenticated;
-- Conta de anúncios do Facebook (0077): token não legível; escrita só pelo serviço.
revoke all on public.meta_ads_accounts from kobly_authenticated, kobly_anon;
grant select (id, organization_id, ad_account_id, name, currency, token_hint, status, last_error, last_sync_at, created_at, updated_at) on public.meta_ads_accounts to kobly_authenticated;
`;
writeFileSync(join(out, '900_grants.sql'), grants);
manifest.push({ file: '900_grants.sql', sha256: createHash('sha256').update(grants).digest('hex') });
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`${manifest.filter((m) => m.sha256).length} arquivos, ${manifest.filter((m) => m.skipped).length} excluídos`);
