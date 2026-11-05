import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { API_BASE_URL } from '@/api/supabaseClient.js';
import { Banner, Button, Icon, IconButton, Input } from '@/ds';
import { askConfirm } from '@/lib/confirm.jsx';
import { Modal } from '@/lib/ui.jsx';

// Kobly — Integrações → API pública. Chaves para gateways, checkouts e CRMs dispararem os fluxos da conta
// (POST /public/v1/flows/{id}/trigger). A chave aparece uma única vez; a documentação fica em /developers.
// KoblyPublicApiTab

const fmt = (d) => (d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca');
const CSS = `
.kpa { display: flex; flex-direction: column; gap: 16px; }
.kpa-head { display: flex; align-items: center; gap: 14px; padding-bottom: 16px; border-bottom: 1px solid var(--border-subtle); }
.kpa-ico { width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center; color: #ff9452; background: rgba(255,98,1,.12); border: 1px solid rgba(255,148,82,.3); flex: none; }
.kpa-new { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 99px; color: #34d399; background: rgba(52,211,153,.14); }
.kpa-card { border-radius: 18px; padding: 20px; background: var(--surface-card); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 16px; }
.kpa-empty { border: 1.5px dashed var(--border-default); border-radius: 14px; padding: 34px 16px; text-align: center; }
.kpa-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--border-subtle); background: var(--surface-sunken); }
.kpa-code { display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-radius: 12px; background: var(--surface-sunken); border: 1px solid var(--border-subtle); font-family: var(--font-mono); font-size: 12.5px; color: var(--text-body); word-break: break-all; }
`;

function KoblyPublicApiTab({ empresaId, notify = () => {} }) {
  const [list, setList] = useState({ loading: true, items: [], error: null });
  const [modal, setModal] = useState(false);
  const [label, setLabel] = useState('');
  const [novo, setNovo] = useState(null);
  const [busy, setBusy] = useState(false);
  const base = `${API_BASE_URL.replace(/\/$/, '')}/public/v1`;
  const docs = `${window.location.origin}/developers`;

  const load = useCallback(async () => {
    const r = await KoblyApi.publicApiKeys('list', {}, empresaId).catch((e) => ({ error: e.message }));
    setList({ loading: false, items: (r && r.keys) || [], error: r && r.error });
  }, [empresaId]);
  useEffect(() => { load(); }, [load]);

  async function create() {
    setBusy(true);
    const r = await KoblyApi.publicApiKeys('create', { label: label || 'Minha integração' }, empresaId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    setNovo(r.key); setLabel(''); load();
  }
  async function revoke(k) {
    if (!(await askConfirm(`Revogar "${k.label}"? O sistema que usa esta chave para de disparar fluxos na hora.`, { title: 'Revogar chave?', confirmLabel: 'Revogar' }))) return;
    const r = await KoblyApi.publicApiKeys('revoke', { id: k.id }, empresaId);
    if (r.error) notify('danger', r.error); else { notify('success', 'Chave revogada.'); load(); }
  }
  const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); notify('success', `${what} copiado`); } catch { notify('warning', 'Não consegui copiar; selecione e copie à mão.'); } };
  const ativos = list.items.filter((k) => !k.revoked_at);

  return (
    <div className="kpa">
      <style>{CSS}</style>
      <div className="kpa-head">
        <span className="kpa-ico"><Icon name="key-round" size={22} /></span>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><b style={{ fontSize: 20, color: 'var(--text-strong)' }}>API pública</b><span className="kpa-new">Novo</span></div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Dispare seus fluxos a partir de gateways, CRMs e sistemas externos.</div>
        </div>
      </div>

      <div className="kpa-card">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Conecte gateways, checkouts e CRMs à Kobly para disparar seus fluxos de WhatsApp.</div>
          <Button variant="secondary" iconLeft="external-link" onClick={() => window.open(docs, '_blank', 'noopener')}>Ver documentação</Button>
          <Button iconLeft="plus" onClick={() => { setModal(true); setNovo(null); }}>Nova chave</Button>
        </div>
        {list.error && <Banner tone="danger">{list.error}</Banner>}
        {list.loading ? <div className="kpa-empty" style={{ color: 'var(--text-muted)' }}>Carregando…</div>
          : ativos.length === 0 ? (
            <div className="kpa-empty">
              <div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>Nenhuma chave ainda</div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 4 }}>Crie uma chave e cole na plataforma que vai disparar seus fluxos.</div>
            </div>
          ) : ativos.map((k) => (
            <div key={k.id} className="kpa-row">
              <Icon name="key-round" size={16} style={{ color: '#ff9452' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{k.label}</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{k.key_prefix}… · criada {fmt(k.created_at)} · último uso {fmt(k.last_used_at)}</div>
              </div>
              <IconButton icon="trash-2" size="sm" aria-label="Revogar chave" title="Revogar" onClick={() => revoke(k)} />
            </div>
          ))}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Endereço da API</span>
          <div className="kpa-code"><span style={{ flex: 1 }}>{base}</span><IconButton icon="copy" size="sm" aria-label="Copiar endereço" onClick={() => copy(base, 'Endereço')} /></div>
        </div>
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title={novo ? 'Chave criada' : 'Nova chave'} width={520}
        footer={novo ? <Button onClick={() => setModal(false)}>Já copiei</Button>
          : <><Button variant="ghost" onClick={() => setModal(false)}>Cancelar</Button><Button iconLeft="plus" loading={busy} onClick={create}>Criar chave</Button></>}>
        {novo ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Banner tone="warning" title="Copie a chave agora">Ela não aparece de novo. Guarde só no servidor da sua plataforma.</Banner>
            <div className="kpa-code"><span style={{ flex: 1 }}>{novo}</span><IconButton icon="copy" size="sm" aria-label="Copiar chave" onClick={() => copy(novo, 'Chave')} /></div>
          </div>
        ) : (
          <Input label="Nome da chave" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ex.: Checkout Kiwify, meu CRM" />
        )}
      </Modal>
    </div>
  );
}
export { KoblyPublicApiTab };
