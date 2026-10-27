import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { API_BASE_URL } from '@/api/supabaseClient.js';
import { Badge, Banner, Button, Card, Icon, IconButton, Input } from '@/ds';
import { askConfirm } from '@/lib/confirm.jsx';

// Kobly — Integrações → Acesso de IA (MCP). Gera tokens para assistentes de IA (Claude, ChatGPT…)
// montarem fluxos da conta. O assistente só salva RASCUNHOS; publicar é sempre no editor.
// O token aparece uma única vez. KoblyMcpTab

const fmt = (d) => (d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca');

function KoblyMcpTab({ empresaId, notify = () => {} }) {
  const [list, setList] = useState({ loading: true, items: [], error: null });
  const [label, setLabel] = useState('');
  const [novo, setNovo] = useState(null);
  const [busy, setBusy] = useState(false);
  const url = `${API_BASE_URL.replace(/\/$/, '')}/mcp`;

  const load = useCallback(async () => {
    const r = await KoblyApi.mcpTokens('list', {}, empresaId);
    setList({ loading: false, items: r.tokens || [], error: r.error });
  }, [empresaId]);
  useEffect(() => { load(); }, [load]);

  async function create() {
    setBusy(true);
    const r = await KoblyApi.mcpTokens('create', { label: label || 'Assistente de IA' }, empresaId);
    setBusy(false);
    if (r.error) { notify('danger', r.error); return; }
    setNovo(r.token); setLabel(''); load();
  }
  async function revoke(t) {
    if (!(await askConfirm(`Revogar "${t.label}"? O assistente que usa este token perde o acesso na hora.`))) return;
    const r = await KoblyApi.mcpTokens('revoke', { id: t.id }, empresaId);
    if (r.error) notify('danger', r.error); else load();
  }
  const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); notify('success', `${what} copiado`); } catch { notify('warning', 'Não consegui copiar; selecione e copie manualmente.'); } };
  const cmd = novo ? `claude mcp add --transport http kobly ${url} --header "Authorization: Bearer ${novo}"` : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <span style={{ color: 'var(--accent)', display: 'flex', marginTop: 2 }}><Icon name="bot" size={18} /></span>
          <div>
            <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>Acesso de IA (MCP)</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 2 }}>
              Conecte o Claude, o ChatGPT ou outro assistente compatível com MCP para criar e ajustar fluxos conversando. O assistente lê os blocos e recursos da conta, valida e salva <strong>rascunhos</strong>. Quem publica é sempre uma pessoa, no editor.
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Input label="Endereço do MCP" value={url} readOnly style={{ flex: 1, minWidth: 260 }} />
          <Button variant="secondary" iconLeft="copy" onClick={() => copy(url, 'Endereço')}>Copiar</Button>
        </div>

        {novo && (
          <Banner tone="warning" title="Copie o token agora: ele não aparece de novo.">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
              <code style={{ wordBreak: 'break-all', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{novo}</code>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button size="sm" iconLeft="copy" onClick={() => copy(novo, 'Token')}>Copiar token</Button>
                <Button size="sm" variant="secondary" iconLeft="copy" onClick={() => copy(cmd, 'Comando do Claude Code')}>Copiar comando do Claude Code</Button>
                <Button size="sm" variant="ghost" onClick={() => setNovo(null)}>Já copiei</Button>
              </div>
            </div>
          </Banner>
        )}

        {list.error && <Banner tone="danger">{list.error}</Banner>}
        {list.items.map((t) => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', opacity: t.revoked_at ? 0.6 : 1 }}>
            <Icon name="key-round" size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{t.label}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{t.token_prefix}… · último uso {fmt(t.last_used_at)}</div>
            </div>
            {t.revoked_at ? <Badge tone="neutral">Revogado</Badge> : <Badge tone="success" dot>Ativo</Badge>}
            {!t.revoked_at && <IconButton icon="trash-2" size="sm" aria-label="Revogar" onClick={() => revoke(t)} />}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Input label="Nome do acesso" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Claude do Vitor" style={{ flex: 1, minWidth: 200 }} />
          <Button onClick={create} loading={busy} iconLeft="plus">Gerar token</Button>
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>
          Peça ao assistente, por exemplo: "Leia o guia da Kobly e monte um fluxo de recuperação de Pix gerado para o México com OXXO e lembrete em 6 horas; salve como rascunho na campanha X."
        </div>
      </Card>
    </div>
  );
}
export { KoblyMcpTab };
