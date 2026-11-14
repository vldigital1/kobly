// Todas as conexões de mensagem de uma empresa, num formato só: chips do WhatsApp por QR Code, números da API Oficial,
// contas do Instagram e Páginas do Messenger. Usado pelo Chat ao vivo (filtro) e pelo Gatilho do fluxo (escolher por onde).
// key = "<tipo>:<id>" identifica a conexão em todo lugar (filtro do chat, gatilho do fluxo, via de envio).

export const CONN_KINDS = ['uazapi', 'oficial', 'instagram', 'messenger'];
export const redeOf = (kind) => (kind === 'instagram' ? 'instagram' : kind === 'messenger' ? 'messenger' : 'whatsapp');
const UUID = /^[0-9a-f-]{36}$/i;

// "uazapi:<uuid>" -> { kind, id }; qualquer outra coisa -> null
export function parseConnKey(key) {
  const m = /^(uazapi|oficial|instagram|messenger):([0-9a-f-]{36})$/i.exec(String(key || '').trim());
  return m && UUID.test(m[2]) ? { kind: m[1].toLowerCase(), id: m[2].toLowerCase() } : null;
}

export async function listConnections(pool, orgId) {
  const q = (sql) => pool.query(sql, [orgId]).then((r) => r.rows).catch(() => []);
  const [qr, of, meta] = await Promise.all([
    q(`select id, label, phone, profile_name, status from public.whatsapp_uazapi_instances where organization_id = $1 order by created_at`),
    q(`select id, verified_name, display_phone, status from public.whatsapp_accounts where organization_id = $1 order by connected_at nulls last, created_at`),
    q(`select id, kind, name, username, status from public.meta_channels where organization_id = $1 order by created_at`),
  ]);
  return [
    ...qr.map((r) => ({ key: `uazapi:${r.id}`, kind: 'uazapi', id: r.id, rede: 'whatsapp', nome: r.label || r.profile_name || 'WhatsApp', detalhe: r.phone ? `+${String(r.phone).replace(/\D/g, '')}` : 'WhatsApp (QR Code)', conectado: r.status === 'connected' })),
    ...of.map((r) => ({ key: `oficial:${r.id}`, kind: 'oficial', id: r.id, rede: 'whatsapp', nome: r.verified_name || 'WhatsApp Oficial', detalhe: r.display_phone || 'API Oficial', conectado: r.status === 'connected' })),
    ...meta.map((r) => ({ key: `${r.kind}:${r.id}`, kind: r.kind, id: r.id, rede: r.kind, nome: r.kind === 'instagram' ? (r.username ? `@${r.username}` : r.name || 'Instagram') : r.name || 'Página do Facebook', detalhe: r.kind === 'instagram' ? 'Instagram' : 'Messenger', conectado: r.status === 'connected' })),
  ];
}
