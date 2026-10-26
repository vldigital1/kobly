// Gera os segredos do servidor para colar nas variáveis do Railway. Rode no SEU computador:
//   node server/tools/gen-secrets.mjs
// Cada execução gera valores novos. Guarde num gerenciador de senhas; trocar KOBLY_SECRET_KEY depois
// invalida tokens já cifrados (WhatsApp, gateways, chaves de IA), e trocar JWT_SECRET desloga todo mundo.
import { randomBytes } from 'node:crypto';
console.log(`JWT_SECRET=${randomBytes(32).toString('hex')}`);
console.log(`KOBLY_SECRET_KEY=${randomBytes(32).toString('base64')}`);
console.log(`UNSUBSCRIBE_SECRET=${randomBytes(32).toString('hex')}`);
console.log(`PGRST_AUTHENTICATOR_PASSWORD=${randomBytes(24).toString('hex')}`);
