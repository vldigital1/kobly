// WhatsApp por QR Code: toda conversa do número aparece em Conversas (contato novo vira lead, o que a empresa
// manda pelo celular entra como "celular") e o histórico recente é importado ao conectar.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/uazapi_history.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createUazapi, contactPhone, messageText } from '../src/whatsapp/uazapi.js';
import { createInbox } from '../src/workspace/inbox.js';
import { encrypt } from '../src/whatsapp/crypto.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const stamp = Date.now();
const T0 = 1_761_600_000_000; // ms
let pool, uaz, inbox;
const A = {};
const calls = [];

// servidor Uazapi de mentira: 2 conversas (uma com @lid sem telefone, que fica de fora) e um grupo
async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  const body = init.body ? JSON.parse(init.body) : {};
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  if (u.pathname === '/chat/find') {
    assert.equal(body.wa_isGroup, false);
    return ok({ chats: [
      { wa_chatid: '5547911112222@s.whatsapp.net', phone: '5547911112222', wa_contactName: 'Maria Cliente', wa_isGroup: false },
      { wa_chatid: '120363000000000000@g.us', wa_isGroup: true },
      { wa_chatid: '99887766@lid', wa_isGroup: false },
    ], pagination: { hasMore: false } });
  }
  if (u.pathname === '/message/find') {
    if (body.chatid !== '5547911112222@s.whatsapp.net') return ok({ messages: [] });
    return ok({ messages: [
      { messageid: `h3-${stamp}`, chatid: body.chatid, fromMe: true, text: 'Pode sim, te mando o link', messageTimestamp: T0 + 3000 },
      { messageid: `h2-${stamp}`, chatid: body.chatid, fromMe: false, messageType: 'AudioMessage', text: '', messageTimestamp: T0 + 2000 },
      { messageid: `h1-${stamp}`, chatid: body.chatid, fromMe: false, senderName: 'Maria', text: 'Oi, ainda tem?', messageTimestamp: T0 + 1000 },
      { messageid: `h0-${stamp}`, chatid: body.chatid, fromMe: true, wasSentByApi: true, text: 'mensagem do fluxo', messageTimestamp: T0 },
    ] });
  }
  if (u.pathname === '/message/download') return ok({ fileURL: `https://cdn.uaz.test/${body.id}.mp3`, mimetype: 'audio/mpeg' });
  if (u.pathname === '/chat/avatar') return ok({ url: body.number === '5547911112222' ? 'https://pps.whatsapp.net/maria.jpg' : '' });
  if (u.pathname === '/call/make') { calls.push(body.number); return ok({ response: 'ok' }); }
  throw new Error('rede não esperada: ' + url);
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  uaz = createUazapi({ pool, secretKey: KEY, base: 'https://uaz.test', adminToken: 'adm-0000000', fetchImpl: fakeFetch, onInbound });
  inbox = createInbox({ pool, whatsapp: { freeTextAllowed: async () => true, mediaLink: (o, x) => uaz.mediaLink(o, x), avatarOf: (o, p) => uaz.avatarOf(o, p), ringCall: (o, p) => uaz.ringCall(o, p) } });
  A.orgId = (await pool.query(`insert into public.organizations (nome) values ('Loja Histórico') returning id`)).rows[0].id;
  A.inst = (await pool.query(`insert into public.whatsapp_uazapi_instances (organization_id, label, instance_name, token_enc, status, phone) values ($1,'Vendas',$2,$3,'connected','5547999990000') returning id, webhook_public_id`,
    [A.orgId, `hist-${stamp}`, encrypt('tok-hist', KEY)])).rows[0];
});
after(async () => { if (skip) return; await pool.end(); });

// mesmo papel do runtime dos fluxos: guarda a mensagem e liga ao lead pelo telefone
async function onInbound({ orgId, instanceId, message }) {
  const lead = (await pool.query(`select id from public.leads where organization_id = $1 and right(regexp_replace(coalesce(telefone,''), '\\D', '', 'g'), 10) = $2`, [orgId, message.from.slice(-10)])).rows[0];
  await pool.query(`insert into public.whatsapp_inbound_messages (organization_id, instance_id, wa_message_id, from_phone, lead_id, msg_type, body) values ($1,$2,$3,$4,$5,'text',$6) on conflict (wa_message_id) do nothing`,
    [orgId, instanceId, message.id, message.from, lead && lead.id, message.text.body]);
  return true;
}
const ctx = () => ({ orgId: A.orgId, role: 'Cliente' });
const hook = (message, chat) => uaz.receiveWebhook(A.inst.webhook_public_id, JSON.stringify({ EventType: 'messages', token: 'tok-hist', message, chat }));
const conversas = async () => (await inbox.handle(ctx(), {}, { action: 'list' })).conversations;

test('telefone do contato: JID, chat.phone ou sender_pn; @lid sem telefone fica de fora', () => {
  assert.equal(contactPhone({ chatid: '5511987654321@s.whatsapp.net' }), '5511987654321');
  assert.equal(contactPhone({ chatid: 'x@lid', sender_pn: '5511987654321@s.whatsapp.net' }), '5511987654321');
  assert.equal(contactPhone({ chatid: 'x@lid', fromMe: true, sender_pn: '5547999990000@s.whatsapp.net' }, { phone: '+55 11 98765-4321' }), '5511987654321');
  assert.equal(contactPhone({ chatid: 'x@lid', fromMe: true }), '');
  assert.equal(messageText({ messageType: 'AudioMessage' }), '[áudio]');
  assert.equal(messageText({ text: ' oi ' }), 'oi');
});

test('contato novo que escreve vira lead e aparece em Conversas; resposta pelo celular entra como "celular"', { skip }, async () => {
  await hook({ messageid: `n1-${stamp}`, chatid: '5521933334444@s.whatsapp.net', sender: '5521933334444@s.whatsapp.net', senderName: 'João Novo', text: 'Bom dia', fromMe: false, messageTimestamp: Date.now() });
  const lead = (await pool.query(`select id, nome, utm from public.leads where organization_id = $1 and telefone = '5521933334444'`, [A.orgId])).rows[0];
  assert.equal(lead.nome, 'João Novo'); assert.equal(lead.utm.utm_source, 'whatsapp');
  await hook({ messageid: `n2-${stamp}`, chatid: '5521933334444@s.whatsapp.net', sender: '5547999990000@s.whatsapp.net', text: 'Bom dia! Como posso ajudar?', fromMe: true, messageTimestamp: Date.now() + 1000 });
  await hook({ messageid: `n2-${stamp}`, chatid: '5521933334444@s.whatsapp.net', text: 'Bom dia! Como posso ajudar?', fromMe: true }); // reentrega: não duplica
  const c = (await conversas()).find((x) => x.lead_id === lead.id);
  assert.equal(c.ultima, 'Bom dia! Como posso ajudar?'); assert.equal(c.ultima_de, 'celular');
  const m = await inbox.handle(ctx(), {}, { action: 'messages', lead_id: lead.id });
  assert.deepEqual(m.messages.map((x) => x.de), ['lead', 'celular']);
  // grupo e o próprio número não entram
  await hook({ messageid: `g1-${stamp}`, chatid: '120363000000000000@g.us', isGroup: true, text: 'grupo', fromMe: false });
  assert.equal((await pool.query(`select count(*)::int as n from public.leads where organization_id = $1`, [A.orgId])).rows[0].n, 1);
});

test('histórico: importa as conversas recentes sem duplicar e sem o que a Kobly já mandou', { skip }, async () => {
  const wait = async () => {
    for (let i = 0; i < 50; i++) {
      const r = (await pool.query(`select history_status, history_count, history_error from public.whatsapp_uazapi_instances where id = $1`, [A.inst.id])).rows[0];
      if (r.history_status && r.history_status !== 'running') return r;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    throw new Error('importação não terminou');
  };
  await uaz.handle(ctx(), {}, { action: 'import_history', id: A.inst.id });
  const r = await wait();
  assert.equal(r.history_status, 'done', r.history_error); assert.equal(r.history_count, 3);
  const lead = (await pool.query(`select id, nome, whatsapp_last_inbound_at from public.leads where organization_id = $1 and telefone = '5547911112222'`, [A.orgId])).rows[0];
  assert.equal(lead.nome, 'Maria Cliente');
  assert.equal(new Date(lead.whatsapp_last_inbound_at).getTime(), T0 + 2000);
  const m = await inbox.handle(ctx(), {}, { action: 'messages', lead_id: lead.id });
  assert.deepEqual(m.messages.map((x) => [x.de, x.body]), [['lead', 'Oi, ainda tem?'], ['lead', '[áudio]'], ['celular', 'Pode sim, te mando o link']]);
  // de novo: nada duplica
  await uaz.handle(ctx(), {}, { action: 'import_history', id: A.inst.id });
  assert.equal((await wait()).history_count, 0);
  assert.equal((await inbox.handle(ctx(), {}, { action: 'messages', lead_id: lead.id })).messages.length, 3);
  // a lista da conexão mostra o andamento
  const inst = (await uaz.handle(ctx(), {}, { action: 'list' })).instances.find((i) => i.id === A.inst.id);
  assert.equal(inst.history_status, 'done');
});

test('chat: áudio toca pelo link, foto do contato, ligação, notas, limpar e arquivar', { skip }, async () => {
  const lead = (await pool.query(`select id from public.leads where organization_id = $1 and telefone = '5547911112222'`, [A.orgId])).rows[0].id;
  let m = await inbox.handle(ctx(), {}, { action: 'messages', lead_id: lead });
  const audio = m.messages.find((x) => x.tipo === 'audio');
  assert.ok(audio, 'áudio guardado com o tipo');
  const r = await inbox.handle(ctx(), {}, { action: 'media', lead_id: lead, id: audio.id, de: 'lead' });
  assert.equal(r.url, `https://cdn.uaz.test/h2-${stamp}.mp3`);
  assert.equal((await inbox.handle(ctx(), {}, { action: 'media', lead_id: lead, id: audio.id, de: 'lead' })).url, r.url, 'segunda vez vem do banco');
  const av = await inbox.handle(ctx(), {}, { action: 'avatars', lead_ids: [lead] });
  assert.equal(av.avatars[lead], 'https://pps.whatsapp.net/maria.jpg');
  assert.equal((await inbox.handle(ctx(), {}, { action: 'list' })).conversations.find((c) => c.lead_id === lead).avatar_url, 'https://pps.whatsapp.net/maria.jpg');
  await inbox.handle(ctx(), {}, { action: 'call', lead_id: lead });
  assert.deepEqual(calls, ['5547911112222']);
  await inbox.handle(ctx(), {}, { action: 'notes', lead_id: lead, text: 'cliente quer boleto' });
  assert.equal((await inbox.handle(ctx(), {}, { action: 'messages', lead_id: lead })).lead.chat_notes, 'cliente quer boleto');
  // arquivar: sai de "Todas", vai para "Arquivadas"
  await inbox.handle(ctx(), {}, { action: 'archive', lead_id: lead, archived: true });
  assert.ok(!(await inbox.handle(ctx(), {}, { action: 'list' })).conversations.some((c) => c.lead_id === lead));
  assert.ok((await inbox.handle(ctx(), {}, { action: 'list', filtro: 'arquivadas' })).conversations.some((c) => c.lead_id === lead));
  await inbox.handle(ctx(), {}, { action: 'archive', lead_id: lead, archived: false });
  // não lidas: o lead mandou 2 depois da última resposta? a última foi do celular, então 0
  assert.equal((await inbox.handle(ctx(), {}, { action: 'list' })).conversations.find((c) => c.lead_id === lead).nao_lidas, 0);
  // limpar: a conversa fica vazia na Kobly
  await inbox.handle(ctx(), {}, { action: 'clear', lead_id: lead });
  m = await inbox.handle(ctx(), {}, { action: 'messages', lead_id: lead });
  assert.equal(m.messages.length, 0);
  await assert.rejects(inbox.handle({ orgId: A.orgId, role: 'Suporte' }, {}, { action: 'clear', lead_id: lead }), /não pode/);
});
