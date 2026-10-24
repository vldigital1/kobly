import React, { useCallback, useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Button, Card, DataTable, IconButton, Input, PageHeader, Select } from '@/ds';
import { EmptyState, ErrorState, Modal, SkeletonTable } from '@/lib/ui.jsx';
import { useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Produtos. Catálogo da empresa: casa com o nome/ID que o checkout manda (apelidos), mostra
// abandonos, compras aprovadas e vendas recuperadas pelo fluxo por produto, e sugere cadastrar os
// produtos que já apareceram nos eventos. A UTMify recebe o produto do catálogo nas vendas do fluxo. KoblyProducts

const MOEDAS = ['BRL', 'MXN', 'COP', 'ARS', 'CLP', 'PEN', 'USD', 'EUR'];
const money = (v, moeda = 'BRL') => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: moeda }));
const blank = (nome = '', preco = '') => ({ nome, aliases: [], preco, moeda: 'BRL', checkout_url: '', ativo: true });

function KoblyProducts() {
  const store = useKobly();
  const { orgId, picker, canEdit } = useTargetOrg();
  const [st, setSt] = useState({ loading: true, error: null, products: [], seen: [] });
  const [dias, setDias] = useState('30');
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!orgId) { setSt({ loading: false, error: null, products: [], seen: [] }); return; }
    if (!quiet) setSt((s) => ({ ...s, loading: true }));
    const r = await KoblyApi.products('list', { days: Number(dias) }, orgId);
    setSt({ loading: false, error: r.error, products: r.products || [], seen: r.seen || [] });
  }, [orgId, dias]);
  useEffect(() => { load(); }, [load]);

  async function save() {
    setBusy(true);
    const r = await KoblyApi.products('upsert', { item: edit }, orgId);
    setBusy(false);
    if (r.error) { store.notify('danger', r.error); return; }
    store.notify('success', 'Produto salvo.'); setEdit(null); load(true);
  }
  async function remove(p) {
    if (!confirm(`Excluir "${p.nome}" do catálogo? Os eventos e vendas continuam no histórico.`)) return;
    const r = await KoblyApi.products('delete', { id: p.id }, orgId);
    if (r.error) store.notify('danger', r.error); else load(true);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader style={{ marginBottom: 0 }} action={canEdit && orgId ? <Button variant="primary" iconLeft="plus" onClick={() => setEdit(blank())}>Novo produto</Button> : null}>
        O que você vende. Cada produto casa com o nome (ou ID) que o checkout manda; use apelidos quando a plataforma muda o nome.
      </PageHeader>
      {picker}
      {!orgId ? <EmptyState icon="users" title="Selecione uma conta" message="Escolha a conta do cliente acima." /> : st.error ? <ErrorState message={st.error} onRetry={() => load()} /> : (<>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Select value={dias} onChange={(e) => setDias(e.target.value)} options={[{ value: '7', label: 'Últimos 7 dias' }, { value: '30', label: 'Últimos 30 dias' }, { value: '90', label: 'Últimos 90 dias' }]} style={{ width: 180 }} />
        </div>
        {st.loading ? <SkeletonTable /> : (
          <Card pad={false}>
            <DataTable rowKey="id" zebra rows={st.products}
              empty={<EmptyState compact icon="package" title="Nenhum produto cadastrado" message={st.seen.length ? 'Cadastre com um clique os produtos que já chegaram do checkout (abaixo).' : 'Cadastre o produto que você vende para acompanhar abandonos e recuperação.'} />}
              columns={[
                { key: 'nome', header: 'Produto', render: (p) => (
                  <div>
                    <span style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{p.nome}</span>{!p.ativo && <Badge size="sm" tone="neutral" style={{ marginInlineStart: 6 }}>inativo</Badge>}
                    {p.aliases.length > 0 && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>também: {p.aliases.join(', ')}</div>}
                  </div>
                ) },
                { key: 'preco', header: 'Preço', align: 'end', render: (p) => money(p.preco, p.moeda) },
                { key: 'aband', header: 'Abandonos', align: 'end', render: (p) => p.eventos_abandono },
                { key: 'aprov', header: 'Aprovadas', align: 'end', render: (p) => p.aprovadas },
                { key: 'rec', header: 'Recuperadas (fluxo)', align: 'end', render: (p) => <span style={{ color: p.recuperadas ? 'var(--status-success-fg)' : 'var(--text-muted)', fontWeight: 'var(--fw-semibold)' }}>{p.recuperadas}</span> },
                { key: 'receita', header: 'Receita aprovada', align: 'end', render: (p) => money(p.receita, p.moeda) },
                { key: 'acao', header: '', align: 'end', width: 90, render: (p) => canEdit ? (
                  <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                    <IconButton icon="pencil" size="sm" aria-label="Editar produto" onClick={() => setEdit({ ...p, preco: p.preco ?? '' })} />
                    <IconButton icon="trash-2" size="sm" aria-label="Excluir produto" onClick={() => remove(p)} />
                  </div>
                ) : null },
              ]} />
          </Card>
        )}
        {st.seen.length > 0 && (
          <Card title="Vistos no checkout, fora do catálogo" subtitle="Nomes de produto que chegaram nos eventos dos últimos 90 dias.">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {st.seen.map((s) => (
                <div key={s.nome} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: 'var(--text-strong)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.nome}</div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{s.eventos} evento(s){s.ultimo_valor != null ? ` · ${money(s.ultimo_valor)}` : ''}</div>
                  </div>
                  {canEdit && <Button size="sm" variant="secondary" iconLeft="plus" onClick={() => setEdit(blank(s.nome, s.ultimo_valor ?? ''))}>Cadastrar</Button>}
                </div>
              ))}
            </div>
          </Card>
        )}
      </>)}

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit && edit.id ? 'Editar produto' : 'Novo produto'} width={520}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancelar</Button><Button variant="primary" disabled={busy} onClick={save}>Salvar</Button></>}>
        {edit && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Input label="Nome" value={edit.nome} onChange={(e) => setEdit({ ...edit, nome: e.target.value })} placeholder="Guia completo" />
            <Input label="Apelidos (separe por vírgula)" value={edit.aliases.join(', ')} onChange={(e) => setEdit({ ...edit, aliases: e.target.value.split(',').map((x) => x.trimStart()) })}
              hint="Outros nomes ou IDs com que o checkout manda este produto (ex.: o ID da Hotmart)." />
            <div style={{ display: 'flex', gap: 8 }}>
              <Input label="Preço" value={edit.preco ?? ''} onChange={(e) => setEdit({ ...edit, preco: e.target.value })} placeholder="97,00" style={{ flex: 1 }} />
              <Select label="Moeda" value={edit.moeda} onChange={(e) => setEdit({ ...edit, moeda: e.target.value })} options={MOEDAS.map((m) => ({ value: m, label: m }))} style={{ width: 120 }} />
            </div>
            <Input label="Link do checkout (opcional)" value={edit.checkout_url || ''} onChange={(e) => setEdit({ ...edit, checkout_url: e.target.value })} placeholder="https://pay.hotmart.com/…" />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>
              <input type="checkbox" checked={edit.ativo !== false} onChange={(e) => setEdit({ ...edit, ativo: e.target.checked })} /> Ativo
            </label>
          </div>
        )}
      </Modal>
    </div>
  );
}

export { KoblyProducts };
