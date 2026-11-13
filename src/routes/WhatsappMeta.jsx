// Aba WhatsApp (API oficial da Meta). Cada empresa conecta o PRÓPRIO número: os disparos
// saem do WhatsApp dela. A API oficial só inicia conversa com MODELOS aprovados pela Meta.
import { useCallback, useEffect, useRef, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Card, Icon, Input, Select, Spinner } from '@/ds';
import { useAsync } from '@/lib/hooks.jsx';
import { PhoneField } from '@/lib/ui.jsx';
import { useKobly } from '@/store/store.jsx';
import { askConfirm } from '@/lib/confirm.jsx';

const TPL_TONE = { APPROVED: 'success', PENDING: 'warning', IN_APPEAL: 'warning', REJECTED: 'danger', PAUSED: 'danger', DISABLED: 'danger' };
const TPL_LABEL = { APPROVED: 'Aprovado', PENDING: 'Em análise', IN_APPEAL: 'Em recurso', REJECTED: 'Rejeitado', PAUSED: 'Pausado', DISABLED: 'Desativado' };
const QUALITY = { GREEN: ['success', 'Qualidade alta'], YELLOW: ['warning', 'Qualidade média'], RED: ['danger', 'Qualidade baixa'], UNKNOWN: ['neutral', 'Qualidade em avaliação'] };

function CopyRow({ label, value }) {
  const store = useKobly();
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
      <div style={{ flex: 1 }}><Input label={label} value={value} readOnly onChange={() => {}} /></div>
      <Button variant="secondary" size="sm" iconLeft="copy" onClick={() => { navigator.clipboard?.writeText(value); store.notify('success', 'Copiado'); }}>Copiar</Button>
    </div>
  );
}

// SDK do Facebook (só para o "Conectar com Facebook" do WhatsApp): carregado uma vez, quando a tela abre
let fbSdk = null;
function loadFbSdk(appId, version) {
  if (fbSdk) return fbSdk;
  fbSdk = new Promise((resolve, reject) => {
    if (window.FB) { window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version }); resolve(window.FB); return; }
    window.fbAsyncInit = () => { window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version }); resolve(window.FB); };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js'; s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
    s.onerror = () => { fbSdk = null; reject(new Error('Não deu para abrir o login do Facebook. Desative o bloqueador de anúncios para a Kobly e tente de novo.')); };
    document.body.appendChild(s);
  });
  return fbSdk;
}

// "Conectar com Facebook": cadastro incorporado da Meta. O cliente entra no Facebook, escolhe (ou cria) a conta do
// WhatsApp Business e o número, confirma por SMS e volta. A Kobly recebe o código + os IDs e faz o resto.
function EmbeddedConnect({ cfg, empresaId, onDone, onManual }) {
  const store = useKobly();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const got = useRef({ code: null, ids: null });
  const finish = useCallback(async () => {
    const { code, ids } = got.current;
    if (!code || !ids) return;
    got.current = { code: null, ids: null };
    const r = await KoblyApi.whatsappAccount('embedded_connect', { code, waba_id: ids.waba_id, phone_number_id: ids.phone_number_id }, empresaId);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    store.notify('success', 'WhatsApp conectado!');
    if (r.registerWarning) store.notify('warning', r.registerWarning);
    onDone(r);
  }, [empresaId, onDone, store]);
  useEffect(() => {
    function onMsg(e) {
      if (!/(^|\.)facebook\.com$/.test(new URL(e.origin).hostname)) return;
      let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
      if (!d || d.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (String(d.event || '').startsWith('FINISH') && d.data && d.data.waba_id && d.data.phone_number_id) { got.current.ids = { waba_id: String(d.data.waba_id), phone_number_id: String(d.data.phone_number_id) }; finish(); }
      else if (d.event === 'FINISH_ONLY_WABA') { setBusy(false); setErr('A conta foi criada, mas nenhum número foi escolhido. Clique de novo e escolha o número.'); }
      else if (d.event === 'CANCEL') { setBusy(false); setErr(d.data && d.data.error_message ? `A Meta avisou: ${d.data.error_message}` : 'Você fechou a janela antes de terminar. Nada foi conectado.'); }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [finish]);
  async function start() {
    setErr(null); setBusy(true);
    let FB;
    try { FB = await loadFbSdk(cfg.app_id, cfg.graph_version); } catch (e) { setBusy(false); setErr(e.message); return; }
    FB.login((resp) => {
      const code = resp && resp.authResponse && resp.authResponse.code;
      if (!code) { if (!got.current.ids) { setBusy(false); setErr((e) => e || 'Login cancelado. Nada foi conectado.'); } return; }
      got.current.code = code; finish();
    }, { config_id: cfg.config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {}, featureType: '', sessionInfoVersion: '3' } });
  }
  return (
    <Card icon="message-circle" title="Conectar o WhatsApp da sua empresa" subtitle="API oficial da Meta, com o seu número. Leva uns 2 minutos e não precisa copiar nada.">
      <div className="wam-es">
        <div className="wam-steps">
          {[['1', 'Clique em', 'Conectar com Facebook', 'e entre com o Facebook que administra a empresa.'],
            ['2', 'Escolha (ou crie) a', 'conta do WhatsApp Business', 'e o número que vai enviar as mensagens.'],
            ['3', 'Confirme o número com o', 'código por SMS', 'ou ligação. Pronto: a Kobly ativa tudo sozinha.']].map(([n, a, b, c]) => (
            <div key={n} className="wam-step"><i>{n}</i><span>{a} <b>{b}</b> {c}</span></div>
          ))}
        </div>
        <Banner tone="info" title="Antes de começar">O número não pode estar em uso no app comum do WhatsApp (nem no WhatsApp Business do celular). Use um número novo ou apague a conta do WhatsApp nele antes.</Banner>
        {err && <Banner tone="danger">{err}</Banner>}
        <button type="button" className="wam-fb" disabled={busy} onClick={start}>
          {busy ? <Spinner size={16} /> : <Icon name="facebook" size={18} />}{busy ? 'Esperando a Meta…' : 'Conectar com Facebook'}
        </button>
        <button type="button" className="wam-link" onClick={onManual}>Já tenho o token e os IDs: conectar manualmente</button>
      </div>
      <style>{`
.wam-es { display: flex; flex-direction: column; gap: 14px; max-width: 560px; }
.wam-steps { display: flex; flex-direction: column; gap: 10px; }
.wam-step { display: flex; gap: 10px; align-items: flex-start; font-size: var(--text-sm); color: var(--text-body); }
.wam-step i { font-style: normal; flex: none; width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center; font-size: 12px; font-weight: 700; color: #fff; background: linear-gradient(135deg, #25D366, #128C7E); }
.wam-fb { display: flex; align-items: center; justify-content: center; gap: 10px; height: 46px; border: 0; border-radius: 12px; cursor: pointer; font: 600 15px var(--font-sans); color: #fff; background: #1877F2; box-shadow: 0 8px 24px -10px rgba(24, 119, 242, .8); transition: transform .15s, filter .15s; }
.wam-fb:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.08); }
.wam-fb:disabled { opacity: .6; cursor: progress; }
.wam-link { background: none; border: 0; padding: 2px; cursor: pointer; color: var(--text-muted); font: 500 var(--text-xs) var(--font-sans); text-decoration: underline; text-underline-offset: 3px; align-self: center; }
.wam-link:hover { color: var(--text-strong); }
`}</style>
    </Card>
  );
}

export function ConnectForm({ empresaId, onDone }) {
  const cfg = useAsync(() => KoblyApi.whatsappAccount('embedded_config', {}, empresaId), [empresaId]);
  const [manual, setManual] = useState(false);
  if (cfg.status === 'loading') return <Banner tone="info" title="Carregando…"><Spinner size={13} /></Banner>;
  const es = cfg.data && !cfg.data.error && cfg.data.enabled ? cfg.data : null;
  if (es && !manual) return <EmbeddedConnect cfg={es} empresaId={empresaId} onDone={onDone} onManual={() => setManual(true)} />;
  return <ManualConnectForm empresaId={empresaId} onDone={onDone} onBack={es ? () => setManual(false) : null} />;
}

function ManualConnectForm({ empresaId, onDone, onBack }) {
  const store = useKobly();
  const [f, setF] = useState({ waba_id: '', phone_number_id: '', access_token: '', app_secret: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const ready = /^\d{5,25}$/.test(f.waba_id.trim()) && /^\d{5,25}$/.test(f.phone_number_id.trim()) && f.access_token.trim().length >= 20;
  async function connect() {
    setBusy(true); setErr(null);
    const r = await KoblyApi.whatsappAccount('connect', f, empresaId);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    store.notify('success', 'WhatsApp conectado');
    onDone(r);
  }
  return (
    <Card icon="message-circle" title="Conectar o WhatsApp da sua empresa" subtitle="Os envios saem do número que você conectar aqui, pela API oficial da Meta.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
        <Banner tone="info" title="Onde encontrar">
          No painel da Meta (developers.facebook.com → seu app → WhatsApp → Configuração da API) ficam o <b>ID do número</b> e o <b>ID da conta do WhatsApp Business</b>.
          O <b>token</b> deve ser permanente (usuário do sistema), com as permissões whatsapp_business_messaging e whatsapp_business_management.
        </Banner>
        <Input label="ID da conta do WhatsApp Business" value={f.waba_id} onChange={set('waba_id')} placeholder="somente números" />
        <Input label="ID do número de telefone" value={f.phone_number_id} onChange={set('phone_number_id')} placeholder="somente números" />
        <Input label="Token de acesso permanente" type="password" value={f.access_token} onChange={set('access_token')} placeholder="EAAG…" />
        <Input label="Segredo do app (opcional, recomendado)" type="password" value={f.app_secret} onChange={set('app_secret')} placeholder="usado para validar os avisos de entrega" />
        {err && <Banner tone="danger">{err}</Banner>}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" iconLeft="plug" disabled={!ready || busy} onClick={connect}>{busy ? 'Conferindo na Meta…' : 'Conectar'}</Button>
          {onBack && <Button variant="ghost" onClick={onBack}>Voltar para "Conectar com Facebook"</Button>}
        </div>
      </div>
    </Card>
  );
}

function NewTemplate({ empresaId, onClose, onCreated }) {
  const store = useKobly();
  const [f, setF] = useState({ name: '', category: 'MARKETING', body: '', ex: '', url: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function create() {
    setBusy(true); setErr(null);
    const examples = f.ex.split('|').map((x) => x.trim()).filter(Boolean);
    const buttons = f.url.trim() ? [{ type: 'URL', text: 'Finalizar compra', url: f.url.trim(), example: 'abc' }] : [];
    const r = await KoblyApi.whatsappAccount('create_template', { name: f.name, category: f.category, body: f.body, examples, buttons, language: 'pt_BR' }, empresaId);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    store.notify('success', 'Modelo enviado para análise da Meta');
    onCreated();
  }
  return (
    <Card icon="plus" title="Novo modelo de mensagem" subtitle="A Meta analisa cada modelo antes de liberar o envio (costuma levar de minutos a 1 dia).">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
        <Input label="Nome interno (minúsculas, números e _)" value={f.name} onChange={set('name')} placeholder="recuperar_carrinho" />
        <Select label="Categoria" value={f.category} onChange={set('category')} options={[{ value: 'MARKETING', label: 'Marketing (promoções, recuperação)' }, { value: 'UTILITY', label: 'Utilidade (status de pedido)' }]} />
        <Input label="Texto — use {{1}}, {{2}} para nome, produto…" value={f.body} onChange={set('body')} placeholder="Oi {{1}}, você deixou {{2}} no carrinho. Responda SAIR para não receber mais." />
        <Input label="Exemplos das variáveis, separados por |" value={f.ex} onChange={set('ex')} placeholder="Ana | Tênis Runner" />
        <Input label="Botão com link (opcional, https)" value={f.url} onChange={set('url')} placeholder="https://sualoja.com/carrinho/{{1}}" />
        {err && <Banner tone="danger">{err}</Banner>}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" disabled={busy || !f.name || !f.body} onClick={create}>{busy ? 'Enviando…' : 'Enviar para análise'}</Button>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        </div>
      </div>
    </Card>
  );
}

export function WhatsappMetaTab({ empresaId }) {
  const store = useKobly();
  const acc = useAsync(() => KoblyApi.whatsappAccount('status', {}, empresaId), [empresaId]);
  const tpls = useAsync(() => KoblyApi.listWhatsappTemplates(), [empresaId]);
  const [busy, setBusy] = useState('');
  const [creating, setCreating] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testTpl, setTestTpl] = useState('');
  const [testVars, setTestVars] = useState('');
  const [result, setResult] = useState(null);

  if (acc.status === 'loading') return <Banner tone="info" title="Verificando conexão…"><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Spinner size={13} /> Consultando o WhatsApp da empresa.</div></Banner>;
  const d = acc.data;
  if (acc.status === 'error' || (d && d.error)) return <Banner tone="danger">{(d && d.error) || acc.error}</Banner>;
  if (!d.account) return <ConnectForm empresaId={empresaId} onDone={() => { acc.reload(); tpls.reload(); }} />;

  const a = d.account;
  const [qTone, qLabel] = QUALITY[a.quality_rating] || QUALITY.UNKNOWN;
  const list = tpls.data || [];
  const approved = list.filter((t) => t.status === 'APPROVED');

  async function run(key, fn, okMsg) {
    setBusy(key); const r = await fn(); setBusy('');
    if (r.error) { store.notify('danger', r.error); return r; }
    if (okMsg) store.notify('success', okMsg(r));
    return r;
  }
  async function refresh() { await run('refresh', () => KoblyApi.whatsappAccount('status', { refresh: true }, empresaId)); acc.reload(); }
  async function sync() { const r = await run('sync', () => KoblyApi.whatsappAccount('sync_templates', {}, empresaId), (x) => `${x.synced} modelo(s) sincronizado(s)`); if (!r.error) tpls.reload(); }
  async function disconnect() {
    if (!(await askConfirm('Desconectar o WhatsApp desta empresa? As campanhas com WhatsApp param de enviar até conectar de novo.'))) return;
    const r = await run('desconectar', () => KoblyApi.whatsappAccount('disconnect', {}, empresaId), () => 'WhatsApp desconectado');
    if (!r.error) { acc.reload(); tpls.reload(); }
  }
  async function sendTest() {
    setResult(null);
    const variables = testVars.split('|').map((x) => x.trim());
    const r = await run('test', () => KoblyApi.whatsappAccount('send_test', { to: testPhone, template_id: testTpl, variables }, empresaId));
    setResult(r.error ? { ok: false, msg: r.error } : { ok: true, msg: 'Mensagem enviada — confira o WhatsApp.' });
  }
  const sel = list.find((t) => t.id === testTpl);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card icon="message-circle" title="WhatsApp da empresa" subtitle="Envios pela API oficial da Meta, a partir do número conectado."
        action={<div style={{ display: 'flex', gap: 8 }}><Button size="sm" variant="ghost" iconLeft="refresh-cw" disabled={busy === 'refresh'} onClick={refresh}>Atualizar</Button><Button size="sm" variant="ghost" iconLeft="unplug" disabled={busy === 'desconectar'} onClick={disconnect}>Desconectar</Button></div>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {a.status === 'connected'
            ? <Banner tone="success" title={`Conectado · ${a.display_phone || ''}`}>{a.verified_name || 'Número verificado'}</Banner>
            : <Banner tone="danger" title="Problema na conexão">{a.last_error || 'Conecte de novo com um token válido.'}</Banner>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Badge tone={qTone}>{qLabel}</Badge>
            {a.messaging_limit && <Badge tone="neutral">Limite: {a.messaging_limit.replace('TIER_', '').replace('K', ' mil/dia')}</Badge>}
          </div>
          {a.embedded ? (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="check-circle-2" size={14} />Conectado com um clique: avisos de entrega, respostas e descadastro já chegam sozinhos.</div>
          ) : (<>
          <Banner tone="info" title="Avisos de entrega (opcional)">
            Para ver “entregue/lido” e receber pedidos de descadastro (SAIR), cadastre este endereço no painel da Meta (WhatsApp → Configuração → Webhook) e assine “messages”.
          </Banner>
          <CopyRow label="URL de retorno (callback)" value={a.webhook_url} />
          <CopyRow label="Token de verificação" value={a.verify_token} />
          {!a.has_app_secret && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}><Icon name="info" size={14} /> Sem o segredo do app, os avisos de entrega não podem ser validados e são recusados. Conecte de novo informando o segredo.</div>}
          </>)}
        </div>
      </Card>

      <Card icon="file-text" title="Modelos de mensagem" subtitle="A Meta só permite iniciar conversa com modelos aprovados."
        action={<div style={{ display: 'flex', gap: 8 }}><Button size="sm" variant="secondary" iconLeft="refresh-cw" disabled={busy === 'sync'} onClick={sync}>{busy === 'sync' ? 'Sincronizando…' : 'Sincronizar com a Meta'}</Button><Button size="sm" variant="primary" iconLeft="plus" onClick={() => setCreating(true)}>Novo modelo</Button></div>}>
        {list.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Nenhum modelo ainda. Crie um ou sincronize os que já existem na sua conta.</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {list.map((t) => (
              <div key={t.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between', borderTop: '1px solid var(--border-default)', paddingTop: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{t.name} <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>· {t.language} · {t.category === 'MARKETING' ? 'Marketing' : t.category === 'UTILITY' ? 'Utilidade' : t.category}</span></div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t.body_text}</div>
                  {t.rejected_reason && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--status-danger-fg)' }}>Motivo: {t.rejected_reason}</div>}
                </div>
                <Badge tone={TPL_TONE[t.status] || 'neutral'}>{TPL_LABEL[t.status] || t.status}</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
      {creating && <NewTemplate empresaId={empresaId} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); tpls.reload(); }} />}

      <Card icon="send" title="Enviar teste" subtitle="Dispara um modelo aprovado para o seu número.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
          <Select label="Modelo aprovado" value={testTpl} onChange={(e) => setTestTpl(e.target.value)} options={[{ value: '', label: approved.length ? 'Escolha um modelo' : 'Nenhum modelo aprovado ainda' }, ...approved.map((t) => ({ value: t.id, label: t.name }))]} />
          {sel && sel.variable_count > 0 && <Input label={`Valores das ${sel.variable_count} variáveis, separados por |`} value={testVars} onChange={(e) => setTestVars(e.target.value)} placeholder="Ana | Tênis Runner" />}
          <PhoneField label="Telefone de teste" value={testPhone} onChange={setTestPhone} />
          <div><Button variant="primary" iconLeft="send" disabled={!testTpl || testPhone.replace(/\D/g, '').length < 10 || busy === 'test'} onClick={sendTest}>{busy === 'test' ? 'Enviando…' : 'Enviar teste'}</Button></div>
          {result && <Banner tone={result.ok ? 'success' : 'danger'}>{result.msg}</Banner>}
        </div>
      </Card>
    </div>
  );
}
