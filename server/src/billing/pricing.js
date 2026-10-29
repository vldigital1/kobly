// Preços dos planos da Kobly (cobrança por conexão). Fonte única: servidor e testes usam daqui; a tela pede ao servidor.
//   Essencial: R$ 57 + R$ 27 por conexão a mais (1 a 10)
//   PRO:       R$ 87 + R$ 37 por conexão a mais (1 a 10)
//   Scale:     R$ 420 (10 conexões) + R$ 27 por conexão de 11 a 50 + R$ 20 por conexão acima de 50 (11 em diante)
//   Agência 5/10/20: R$ 397 / R$ 697 / R$ 1.197 (contas de clientes com o PRO e 1 conexão cada)
// Ciclos: mensal; trimestral = 3 meses com 5% de desconto; anual = 10 meses (2 grátis).

export const PLANS = {
  essencial: { nome: 'Essencial', min: 1, max: 10, base: 57, extra: 27, features: [] },
  pro: { nome: 'PRO', min: 1, max: 10, base: 87, extra: 37, features: ['canais', 'ia', 'anuncios', 'disparo', 'cobranca'] },
  scale: { nome: 'Scale', min: 11, max: 1000, features: ['canais', 'ia', 'anuncios', 'disparo', 'cobranca', 'prioridade'] },
  agencia5: { nome: 'Agência 5', fixed: 397, accounts: 5, features: ['canais', 'ia', 'anuncios', 'disparo', 'cobranca', 'agencia'] },
  agencia10: { nome: 'Agência 10', fixed: 697, accounts: 10, features: ['canais', 'ia', 'anuncios', 'disparo', 'cobranca', 'agencia'] },
  agencia20: { nome: 'Agência 20', fixed: 1197, accounts: 20, features: ['canais', 'ia', 'anuncios', 'disparo', 'cobranca', 'agencia'] },
};
export const CYCLES = { mensal: { meses: 1, fator: 1, dias: 30, asaas: 'MONTHLY', nome: 'Mensal' }, trimestral: { meses: 3, fator: 3 * 0.95, dias: 90, asaas: 'QUARTERLY', nome: 'Trimestral' }, anual: { meses: 12, fator: 10, dias: 365, asaas: 'YEARLY', nome: 'Anual' } };
export const EMAILS = { essencial: 10000, pro: 50000, scale: 200000, agencia: 50000 };
const r2 = (n) => Math.round(n * 100) / 100;
export const isAgency = (code) => /^agencia/.test(String(code || ''));

// valor de 1 mês para o plano e a quantidade de conexões
export function monthly(code, connections = 1) {
  const p = PLANS[code];
  if (!p) throw new Error('plano inválido');
  if (p.fixed) return p.fixed;
  const n = Math.round(Number(connections));
  if (!Number.isInteger(n) || n < p.min || n > p.max) throw new Error(`${p.nome}: de ${p.min} a ${p.max} conexões`);
  if (code === 'scale') return 420 + 27 * (Math.min(n, 50) - 10) + 20 * Math.max(0, n - 50);
  return p.base + p.extra * (n - 1);
}
// valor de cada cobrança do ciclo
export function priceOf(code, connections, cycle = 'mensal') {
  const c = CYCLES[cycle];
  if (!c) throw new Error('ciclo inválido');
  return r2(monthly(code, connections) * c.fator);
}
// conexões que o plano libera (Agência: 1 por conta de cliente; a conta da agência fica sem conexão própria)
export const connectionsOf = (code, connections) => (isAgency(code) ? 0 : Number(connections) || 1);

// upgrade no meio do ciclo: paga só a diferença dos dias que faltam; o que já pagou vira crédito
export function proration({ oldPrice, newPrice, cycle, periodEnd, now = new Date() }) {
  const dias = CYCLES[cycle].dias;
  const rest = Math.max(0, Math.min(dias, (new Date(periodEnd) - now) / 86400000));
  const novo = r2((newPrice * rest) / dias);
  const credito = r2((oldPrice * rest) / dias);
  return { dias_restantes: Math.ceil(rest), novo, credito, pagar: r2(Math.max(0, novo - credito)) };
}

// tabela para a tela
export function catalog() {
  return {
    planos: [
      { code: 'essencial', nome: 'Essencial', base: 57, extra: 27, min: 1, max: 10, emails: EMAILS.essencial, recursos: ['WhatsApp por QR Code', 'Fluxos, leads e checkouts ilimitados', 'Chat ao vivo e Pipeline', `${EMAILS.essencial.toLocaleString('pt-BR')} e-mails por mês`] },
      { code: 'pro', nome: 'PRO', base: 87, extra: 37, min: 1, max: 10, emails: EMAILS.pro, destaque: true, recursos: ['Tudo do Essencial', 'WhatsApp API oficial, Instagram e Messenger', 'Agente de IA e voz (sua chave)', 'Gestor de anúncios (Facebook e Google) e Pixel', 'Cobrança Pix no fluxo e disparo em massa', `${EMAILS.pro.toLocaleString('pt-BR')} e-mails por mês`] },
      { code: 'scale', nome: 'Scale', base: 420, min: 11, max: 1000, emails: EMAILS.scale, faixas: [{ ate: 50, extra: 27 }, { acima: 50, extra: 20 }], recursos: ['Tudo do PRO', 'A partir de 11 conexões, com preço menor por conexão', 'Suporte prioritário pelo WhatsApp', 'Onboarding com o time', `${EMAILS.scale.toLocaleString('pt-BR')} e-mails por mês`] },
    ],
    agencias: ['agencia5', 'agencia10', 'agencia20'].map((code) => ({ code, nome: PLANS[code].nome, contas: PLANS[code].accounts, preco: PLANS[code].fixed })),
    ciclos: Object.entries(CYCLES).map(([code, c]) => ({ code, nome: c.nome, meses: c.meses, fator: c.fator })),
  };
}
