import React, { useEffect, useRef, useState } from 'react';
import { Banner, Button } from '@/ds';

// Kobly — formulário de cartão da Stripe dentro da Kobly (Payment Element). O número do cartão é digitado num
// quadro seguro da própria Stripe: nunca passa pela Kobly. mode 'payment' paga uma fatura (clientSecret de um
// PaymentIntent); mode 'setup' só salva o cartão (SetupIntent). O script vem sempre de js.stripe.com.
let loading = null;
export function loadStripe(pk) {
  if (!pk) return Promise.reject(new Error('Chave pública da Stripe ausente.'));
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      if (window.Stripe) { resolve(window.Stripe); return; }
      const s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/'; s.async = true;
      s.onload = () => (window.Stripe ? resolve(window.Stripe) : reject(new Error('Stripe não carregou.')));
      s.onerror = () => { loading = null; reject(new Error('Não deu para carregar o formulário do cartão. Confira a internet.')); };
      document.head.appendChild(s);
    });
  }
  return loading.then((S) => S(pk, { locale: 'pt-BR' }));
}

const dark = () => document.documentElement.getAttribute('data-theme') !== 'light';
const appearance = () => ({
  theme: dark() ? 'night' : 'stripe',
  variables: { colorPrimary: '#ff6201', borderRadius: '12px', fontFamily: 'Lexend, system-ui, sans-serif', ...(dark() ? { colorBackground: '#16181f' } : {}) },
});

// 3D Secure de uma cobrança já criada (upgrade no cartão salvo): o banco pede confirmação
export async function confirmNextAction(pk, clientSecret) {
  const stripe = await loadStripe(pk);
  const r = await stripe.handleNextAction({ clientSecret });
  if (r.error) throw new Error(r.error.message || 'O banco não confirmou o pagamento.');
  return r.paymentIntent;
}

export function StripeForm({ publishableKey, clientSecret, mode = 'payment', submitLabel = 'Pagar', onSuccess, onCancel }) {
  const box = useRef(null);
  const st = useRef({});
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    loadStripe(publishableKey).then((stripe) => {
      if (!alive || !box.current) return;
      const elements = stripe.elements({ clientSecret, appearance: appearance(), locale: 'pt-BR' });
      const el = elements.create('payment', { layout: 'tabs', wallets: { applePay: 'auto', googlePay: 'auto' } });
      el.on('ready', () => alive && setReady(true));
      el.mount(box.current);
      st.current = { stripe, elements, el };
    }).catch((e) => alive && setErr(e.message));
    return () => { alive = false; try { st.current.el && st.current.el.destroy(); } catch { /* ok */ } };
  }, [publishableKey, clientSecret]);
  async function submit() {
    const { stripe, elements } = st.current;
    if (!stripe) return;
    setBusy(true); setErr(null);
    const confirmParams = { return_url: window.location.href };
    const r = mode === 'setup'
      ? await stripe.confirmSetup({ elements, confirmParams, redirect: 'if_required' })
      : await stripe.confirmPayment({ elements, confirmParams, redirect: 'if_required' });
    setBusy(false);
    if (r.error) { setErr(r.error.message || 'O cartão não foi aceito.'); return; }
    onSuccess && onSuccess(mode === 'setup' ? r.setupIntent : r.paymentIntent);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div ref={box} style={{ minHeight: ready ? 0 : 180 }} />
      {!ready && !err && <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>Abrindo o formulário seguro do cartão…</div>}
      {err && <Banner tone="danger">{err}</Banner>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {onCancel && <Button variant="ghost" onClick={onCancel} disabled={busy}>Voltar</Button>}
        <Button variant="primary" iconLeft="lock" loading={busy} disabled={!ready || busy} onClick={submit}>{submitLabel}</Button>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--text-subtle)' }}>🔒 Pagamento processado pela Stripe. A Kobly não vê nem guarda o número do cartão.</div>
    </div>
  );
}
