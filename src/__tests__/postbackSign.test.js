import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signPostback, signedPostbackHeaders, usedUnsignedRecently } from '@/lib/postbackSign.js';
import { verifyPostbackAuth } from '../../server/src/ingest/auth.js';

describe('assinatura do postback (navegador ⇄ servidor)', () => {
  const secret = 'a'.repeat(64), body = '{"event":"pix_generated","email":"x@y.test"}', t = 1_800_000_000;

  it('o HMAC do navegador é idêntico ao do servidor', async () => {
    expect(await signPostback(secret, t, body)).toBe(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
  });

  it('cabeçalhos gerados pela tela passam na verificação do servidor (inclusive no modo estrito)', async () => {
    const h = await signedPostbackHeaders('pbk_abc', secret, body, t);
    expect(h['X-Kobly-Token']).toBe('pbk_abc');
    const headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    expect(verifyPostbackAuth({ token: { signing_secret: secret, hottok: null, require_signature: true }, headers, rawBody: body, nowS: t })).toEqual({ ok: true, mode: 'assinado' });
  });

  it('aviso de uso só pela URL vale por 7 dias', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(usedUnsignedRecently({ last_unsigned_at: '2026-10-20T12:00:00Z' }, now)).toBe(true);
    expect(usedUnsignedRecently({ last_unsigned_at: '2026-10-10T12:00:00Z' }, now)).toBe(false);
    expect(usedUnsignedRecently({ last_unsigned_at: null }, now)).toBe(false);
  });
});
