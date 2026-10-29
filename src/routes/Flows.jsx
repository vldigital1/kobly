import React, { useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Card, DataTable, Icon, IconButton, Input, PageHeader, Select } from '@/ds';
import { starterGraph } from '@/lib/flowGraph.js';
import { useAsync } from '@/lib/hooks.jsx';
import { EmptyState, ErrorState, Modal, SkeletonTable } from '@/lib/ui.jsx';
import { fmtDateTime, useTargetOrg } from '@/lib/workspace.jsx';
import { useKobly } from '@/store/store.jsx';
import { askConfirm } from '@/lib/confirm.jsx';

// Editor do fluxo em grafo: carregado só quando aberto (traz o React Flow junto).
const KoblyFlowGraphEditor = React.lazy(() => import('@/routes/FlowGraphEditor.jsx').then((m) => ({ default: m.KoblyFlowGraphEditor })));

// Kobly — Fluxos. Todos os fluxos (WhatsApp e e-mail) em grafo da conta (publicados e rascunhos),
// quantos leads estão em cada um e atalho para criar um fluxo novo do zero. Compartilhar: cada fluxo tem um código e
// um link de prévia; quem tem o código importa na conta dele (versão mais nova, como rascunho, com etiquetas, e-mails
// e agentes; o que é da conta — pagamento, Pixel — fica na lista "falta configurar"). KoblyFlows

const OPEN_KEY = 'kobly:openflow';

function KoblyFlows() {
  const store = useKobly();
  const { orgId, picker, canEdit } = useTargetOrg();
  const list = useAsync(async () => {
    if (!orgId) return [];
    const r = await KoblyApi.flowGraph('list', {}, orgId);
    if (r.error) throw new Error(r.error);
    return r.flows || [];
  }, [orgId]);
  const [open, setOpen] = useState(() => { try { const s = sessionStorage.getItem(OPEN_KEY); return s ? JSON.parse(s) : null; } catch { return null; } });
  const [novo, setNovo] = useState(null); // nome do fluxo em criação
  // vindo do "Novo fluxo" da tela Campanhas: abre direto a criação (lido uma vez, num efeito)
  useEffect(() => { try { if (sessionStorage.getItem('kobly:newflow')) { sessionStorage.removeItem('kobly:newflow'); sessionStorage.removeItem(OPEN_KEY); setOpen(null); setNovo(''); } } catch { /* ok */ } }, []);
  const [busy, setBusy] = useState(false);
  const [trad, setTrad] = useState(null); // { flow, language, voice } — traduzir para outro idioma
  // Campanhas do formato antigo (lista de etapas): a tela Campanhas saiu; as que ainda existem aparecem aqui só para pausar ou excluir
  const legacy = useAsync(async () => (orgId ? ((await KoblyApi.listCampaigns()).campaigns || []).filter((c) => c.empresaId === orgId) : []), [orgId]);

  const openFlow = (f) => { setOpen(f); try { f ? sessionStorage.setItem(OPEN_KEY, JSON.stringify(f)) : sessionStorage.removeItem(OPEN_KEY); } catch { /* ok */ } };

  async function create() {
    setBusy(true);
    try {
      const c = await KoblyApi.createCampaign({ blank: true }, orgId, novo.trim() || 'Novo fluxo');
      // 1º rascunho (gatilho → fim): o fluxo já aparece na lista mesmo se sair do editor sem salvar
      await KoblyApi.flowGraph('save_draft', { campaign_id: c.id, graph: starterGraph(), note: 'fluxo criado' }, orgId);
      setNovo(null);
      store.notify('success', `Fluxo "${c.nome}" criado. Monte os blocos e publique.`);
      openFlow({ id: c.id, nome: c.nome, empresaId: c.empresaId });
    } catch (e) { store.notify('danger', e.message || 'Não foi possível criar o fluxo.'); } finally { setBusy(false); }
  }
  // Traduzir: cópia do fluxo noutro idioma (textos pela IA do cliente, áudios pela ElevenLabs dele)
  async function openTranslate(f) {
    setTrad({ flow: f, language: 'en', voice: null, loading: true });
    const v = await KoblyApi.voice('status', {}, orgId);
    setTrad((t) => t && { ...t, loading: false, voice: v.error ? { connected: false } : v });
  }
  async function translate() {
    setTrad((t) => ({ ...t, running: true }));
    const r = await KoblyApi.voice('translate_flow', { campaign_id: trad.flow.campaign_id, language: trad.language }, orgId);
    if (r.error) { setTrad((t) => ({ ...t, running: false })); store.notify('danger', r.error); return; }
    setTrad(null); list.reload();
    store.notify('success', `Pronto! "${r.nome}" criado com ${r.textos} texto(s)${r.audios ? ` e ${r.audios} áudio(s)` : ''} traduzidos. Revise e publique.`);
    if (r.aviso) store.notify('warning', r.aviso);
  }
  // ---- compartilhar por código (como no ZapData e na Leona) -------------------------------------
  const [shr, setShr] = useState(null); // { flow, code, link, loading }
  const [imp, setImp] = useState(null); // { code, preview, nome, loading, running, result }
  async function openShare(f, renew = false) {
    if (renew && !(await askConfirm('O código atual para de funcionar. Quem ainda não importou vai precisar do código novo.', { title: 'Gerar novo código?', confirmLabel: 'Gerar novo', danger: false }))) return;
    setShr({ flow: f, loading: true });
    const r = await KoblyApi.flowGraph('share', { campaign_id: f.campaign_id, renew }, orgId);
    if (r.error) { setShr(null); store.notify('danger', r.error); return; }
    setShr({ flow: f, code: r.code, link: r.link, loading: false });
    if (renew) store.notify('success', 'Código novo gerado. O antigo não funciona mais.');
  }
  const copy = (text, msg) => { try { navigator.clipboard.writeText(text); store.notify('success', msg); } catch { store.notify('warning', 'Selecione e copie à mão.'); } };
  async function checkCode(code) {
    const c = String(code || '').trim();
    setImp((x) => ({ ...x, code: c, preview: null, error: null }));
    if (!/^[0-9a-f-]{36}$/i.test(c)) return;
    setImp((x) => ({ ...x, loading: true }));
    const r = await KoblyApi.flowGraph('share_preview', { code: c }, orgId);
    setImp((x) => (x && x.code === c ? { ...x, loading: false, preview: r.error ? null : r, error: r.error || null, nome: r.error ? x.nome : (x.nome || r.nome) } : x));
  }
  async function runImport() {
    setImp((x) => ({ ...x, running: true }));
    const r = await KoblyApi.flowGraph('import', { code: imp.code, nome: imp.nome }, orgId);
    if (r.error) { setImp((x) => ({ ...x, running: false })); store.notify('danger', r.error); return; }
    setImp((x) => ({ ...x, running: false, result: r })); list.reload();
  }
  // veio do link de prévia ("Importar na minha conta"): abre a importação com o código
  useEffect(() => {
    if (!orgId) return;
    let c = null; try { c = sessionStorage.getItem('kobly:import-flow'); if (c) sessionStorage.removeItem('kobly:import-flow'); } catch { /* ok */ }
    if (c) { setImp({ code: '', nome: '' }); checkCode(c); }
  }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function toggleLegacy(c) {
    const status = c.status === 'Ativa' ? 'Pausada' : 'Ativa';
    await KoblyApi.setCampaignStatus(c.id, status);
    legacy.setData((d) => d.map((x) => (x.id === c.id ? { ...x, status } : x)));
    store.notify('info', `"${c.nome}" → ${status}`);
  }
  async function removeLegacy(c) {
    if (!(await askConfirm(`Excluir a campanha "${c.nome}"? Os envios agendados dela param e isso não pode ser desfeito.`))) return;
    const r = await KoblyApi.deleteCampaign(c.id);
    if (r.error) { store.notify('danger', r.error); return; }
    legacy.setData((d) => d.filter((x) => x.id !== c.id));
    store.notify('success', `Campanha "${c.nome}" excluída.`);
  }
  async function toggle(f) {
    const status = f.status === 'Ativa' ? 'Pausada' : 'Ativa';
    if (status === 'Ativa' && !f.active_version) { store.notify('warning', 'Publique uma versão do fluxo antes de ativar.'); return; }
    await KoblyApi.setCampaignStatus(f.campaign_id, status);
    list.setData((d) => d.map((x) => (x.campaign_id === f.campaign_id ? { ...x, status } : x)));
    store.notify('info', `"${f.nome}" → ${status}`);
  }

  if (open) {
    return (
      <React.Suspense fallback={<SkeletonTable rows={4} />}>
        <KoblyFlowGraphEditor campaign={open} notify={store.notify} onBack={() => { openFlow(null); list.reload(); }} />
      </React.Suspense>
    );
  }

  const flows = list.data || [];
  const flowIds = new Set(flows.map((f) => f.campaign_id));
  const oldOnes = (legacy.data || []).filter((c) => !flowIds.has(c.id));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader style={{ marginBottom: 0 }} action={canEdit && orgId ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Button variant="secondary" iconLeft="download" onClick={() => setImp({ code: '', nome: '' })}>Importar fluxo</Button><Button variant="primary" iconLeft="plus" onClick={() => setNovo('')}>Novo fluxo</Button></div> : null}>
        Automações de WhatsApp e e-mail: gatilho do checkout, mensagens, e-mails, botões, IA, cobrança e venda, tudo num desenho só.
        Cada fluxo tem rascunhos e versões; só a versão publicada roda.
      </PageHeader>
      {picker}
      {list.status === 'error' ? <ErrorState message={list.error} onRetry={list.reload} /> : list.status === 'loading' ? <SkeletonTable /> : (
        <Card pad={false}>
          <DataTable
            rowKey="campaign_id"
            zebra
            empty={!orgId
              ? <EmptyState compact icon="users" title="Selecione uma conta" message="Escolha a conta do cliente acima para ver os fluxos." />
              : <EmptyState compact icon="git-branch" title="Nenhum fluxo ainda" message="Crie seu primeiro fluxo: e-mail, WhatsApp ou os dois no mesmo desenho." action={canEdit ? <Button variant="primary" iconLeft="plus" onClick={() => setNovo('')}>Novo fluxo</Button> : null} />}
            columns={[
              { key: 'nome', header: 'Fluxo', render: (r) => (
                <button onClick={() => openFlow({ id: r.campaign_id, nome: r.nome, empresaId: orgId })} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'start', fontFamily: 'var(--font-sans)' }}>
                  <span style={{ display: 'block', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{r.nome}</span>
                  <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{(r.eventos || []).join(', ') || 'gatilho não definido'} · salvo {fmtDateTime(r.last_saved_at)}</span>
                </button>
              ) },
              { key: 'status', header: 'Situação', render: (r) => (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {r.active_version ? <Badge tone={r.status === 'Ativa' ? 'success' : 'neutral'} dot>{r.status === 'Ativa' ? `Rodando · v${r.active_version}` : `Publicado v${r.active_version} · ${r.status === 'Rascunho' ? 'não ativado' : r.status.toLowerCase()}`}</Badge> : <Badge tone="warning">Não publicado</Badge>}
                  {r.drafts > 0 && <Badge tone="info">{r.drafts} rascunho{r.drafts > 1 ? 's' : ''}</Badge>}
                </div>
              ) },
              { key: 'ativos', header: 'Leads no fluxo', align: 'end', render: (r) => <span style={{ fontWeight: 'var(--fw-semibold)', color: r.leads_ativos ? 'var(--text-strong)' : 'var(--text-muted)' }}>{r.leads_ativos}</span> },
              { key: 'total', header: 'Total de leads', align: 'end', render: (r) => r.leads_total },
              { key: 'acao', header: '', align: 'end', width: 140, render: (r) => (
                <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                  {canEdit && <IconButton icon={r.status === 'Ativa' ? 'pause' : 'play'} size="sm" aria-label={r.status === 'Ativa' ? 'Pausar fluxo' : 'Ativar fluxo'} onClick={() => toggle(r)} />}
                  {canEdit && <IconButton icon="languages" size="sm" aria-label="Traduzir para outro idioma" onClick={() => openTranslate(r)} />}
                  <IconButton icon="share-2" size="sm" aria-label="Exportar fluxo (código para outra conta)" title="Exportar fluxo" onClick={() => openShare(r)} />
                  <IconButton icon="pencil" size="sm" aria-label="Abrir no editor" onClick={() => openFlow({ id: r.campaign_id, nome: r.nome, empresaId: orgId })} />
                </div>
              ) },
            ]}
            rows={flows}
          />
        </Card>
      )}
      {flows.some((f) => f.status === 'Ativa' && !f.active_version) && <Banner tone="warning">Há fluxo ativo sem versão publicada: ele não roda até você publicar no editor.</Banner>}

      {oldOnes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>Campanhas antigas</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
              Criadas no formato antigo (lista de etapas). As ativas continuam enviando. Para mudar alguma, crie um fluxo novo com os mesmos e-mails (bloco E-mail → copiar) e depois pause ou exclua a antiga.
            </div>
          </div>
          <Card pad={false}>
            <DataTable rowKey="id" zebra rows={oldOnes} columns={[
              { key: 'nome', header: 'Campanha', render: (c) => (<>
                <span style={{ display: 'block', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{c.nome}</span>
                <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{(c.fluxo || []).length} etapas · criada {c.criadoEm || '—'}</span>
              </>) },
              { key: 'status', header: 'Situação', render: (c) => <Badge tone={c.status === 'Ativa' ? 'success' : c.status === 'Pausada' ? 'warning' : 'neutral'} dot>{c.status}</Badge> },
              { key: 'env', header: 'E-mails enviados', align: 'end', render: (c) => (c.stats && c.stats.emailsEnviados) || 0 },
              { key: 'acao', header: '', align: 'end', width: 110, render: (c) => (
                <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                  {canEdit && c.status !== 'Rascunho' && <IconButton icon={c.status === 'Ativa' ? 'pause' : 'play'} size="sm" aria-label={c.status === 'Ativa' ? 'Pausar campanha' : 'Ativar campanha'} onClick={() => toggleLegacy(c)} />}
                  {canEdit && <IconButton icon="trash-2" size="sm" variant="danger" aria-label="Excluir campanha" onClick={() => removeLegacy(c)} />}
                </div>
              ) },
            ]} />
          </Card>
        </div>
      )}

      <Modal open={!!trad} onClose={() => !(trad && trad.running) && setTrad(null)} title="Traduzir fluxo" subtitle={trad ? `Cria uma cópia de "${trad.flow.nome}" no idioma escolhido. O original não muda.` : ''}
        footer={<><Button variant="ghost" disabled={!!(trad && trad.running)} onClick={() => setTrad(null)}>Cancelar</Button><Button variant="primary" iconLeft="languages" loading={!!(trad && trad.running)} disabled={!trad || trad.loading || trad.running} onClick={translate}>{trad && trad.running ? 'Traduzindo…' : 'Traduzir'}</Button></>}>
        {trad && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Select label="Idioma" value={trad.language} onChange={(e) => setTrad((t) => ({ ...t, language: e.target.value }))}
              options={((trad.voice && trad.voice.languages) || [{ id: 'en', label: 'Inglês' }, { id: 'es', label: 'Espanhol' }, { id: 'pt', label: 'Português' }]).map((l) => ({ value: l.id, label: l.label }))} />
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)', lineHeight: 1.6 }}>
              <div>• Textos, botões e legendas: traduzidos pela sua chave de IA (Integrações → IA).</div>
              <div>• Áudios: transcritos e regravados {trad.voice && trad.voice.connected ? <>com a voz <b>{trad.voice.voice_name || 'escolhida'}</b> da sua ElevenLabs.</> : 'pela ElevenLabs.'}</div>
              <div>• Modelos aprovados da Meta não são traduzidos: escolha um modelo no idioma certo no fluxo novo.</div>
            </div>
            {trad.voice && !trad.voice.connected && <Banner tone="info">Se o fluxo tiver áudios, conecte antes a ElevenLabs em Integrações → Voz (ElevenLabs). Fluxo só com texto traduz normalmente.</Banner>}
            {trad.running && <Banner tone="info">Isso pode levar um ou dois minutos se houver muitos áudios. Não feche esta janela.</Banner>}
          </div>
        )}
      </Modal>
      <Modal open={!!shr} onClose={() => setShr(null)} title="Exportar fluxo" subtitle={shr ? `Use o código abaixo para compartilhar ou importar "${shr.flow.nome}" em outra conta.` : ''} width={560}
        footer={<><Button variant="ghost" iconLeft="refresh-cw" disabled={!shr || shr.loading} onClick={() => openShare(shr.flow, true)}>Gerar novo código</Button><Button variant="secondary" onClick={() => setShr(null)}>Fechar</Button></>}>
        {shr && (shr.loading ? <div style={{ color: 'var(--text-muted)' }}>Gerando código…</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input readOnly value={shr.code} onFocus={(e) => e.target.select()} aria-label="Código do fluxo"
                style={{ flex: 1, minWidth: 0, padding: '12px 14px', borderRadius: 12, border: '2px solid #ff6201', background: 'rgba(0,0,0,.3)', color: 'var(--text-strong)', fontFamily: 'var(--font-mono)', fontSize: 14, outline: 'none' }} />
              <IconButton icon="copy" aria-label="Copiar código" onClick={() => copy(shr.code, 'Código copiado!')} />
            </div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-strong)' }}>Ou compartilhe via link com prévia:</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input readOnly value={shr.link} onFocus={(e) => e.target.select()} aria-label="Link de prévia"
                style={{ flex: 1, minWidth: 0, padding: '11px 14px', borderRadius: 12, border: '1px solid rgba(255,255,255,.12)', background: 'rgba(0,0,0,.3)', color: 'var(--text-body)', fontSize: 13.5, outline: 'none' }} />
              <IconButton icon="link" aria-label="Copiar link" onClick={() => copy(shr.link, 'Link copiado!')} />
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', lineHeight: 1.5 }}>Quem importar recebe sempre a versão mais nova deste fluxo. Contas de pagamento, Pixel e chaves não vão junto.</div>
          </div>
        ))}
      </Modal>
      <Modal open={!!imp} onClose={() => !(imp && imp.running) && setImp(null)} title={imp && imp.result ? 'Fluxo importado' : 'Importar fluxo'} subtitle={imp && !imp.result ? 'Cole o código que você recebeu. O fluxo entra como rascunho: nada roda até você revisar e publicar.' : ''} width={560}
        footer={imp && imp.result
          ? <><Button variant="ghost" onClick={() => setImp(null)}>Fechar</Button><Button variant="primary" iconLeft="pencil" onClick={() => { const r = imp.result; setImp(null); openFlow({ id: r.campaign_id, nome: r.nome, empresaId: orgId }); }}>Abrir no editor</Button></>
          : <><Button variant="ghost" disabled={!!(imp && imp.running)} onClick={() => setImp(null)}>Cancelar</Button><Button variant="primary" iconLeft="download" loading={!!(imp && imp.running)} disabled={!imp || imp.running || !imp.preview || !String(imp.nome || '').trim()} onClick={runImport}>Importar</Button></>}>
        {imp && !imp.result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Input label="Código do fluxo" value={imp.code || ''} autoFocus placeholder="ex.: e5b37179-8ab2-4b8b-88b8-05d048acad87" onChange={(e) => checkCode(e.target.value)} />
            {imp.loading && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Procurando o fluxo…</div>}
            {imp.error && <Banner tone="danger">{imp.error}</Banner>}
            {imp.preview && (<>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 14, borderRadius: 14, background: 'rgba(255,98,1,.08)', border: '1px solid rgba(255,148,82,.3)' }}>
                <span style={{ width: 42, height: 42, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg, #ff9452, #ff6201)', color: '#fff', flex: 'none' }}><Icon name="git-branch" size={20} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{imp.preview.nome}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Compartilhado por {imp.preview.conta}</div>
                </div>
                <a href={imp.preview.link} target="_blank" rel="noreferrer" style={{ fontSize: 'var(--text-sm)', color: '#ff9452', whiteSpace: 'nowrap' }}>Ver prévia ↗</a>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Badge tone="info">{imp.preview.blocos} blocos</Badge>
                {imp.preview.inclui.etiquetas > 0 && <Badge tone="neutral">{imp.preview.inclui.etiquetas} etiqueta(s)</Badge>}
                {imp.preview.inclui.emails > 0 && <Badge tone="neutral">{imp.preview.inclui.emails} e-mail(s)</Badge>}
                {imp.preview.inclui.agentes > 0 && <Badge tone="neutral">{imp.preview.inclui.agentes} agente(s) de IA</Badge>}
                {imp.preview.inclui.modelos > 0 && <Badge tone="warning">{imp.preview.inclui.modelos} modelo(s) do WhatsApp</Badge>}
              </div>
              <Input label="Nome do fluxo nesta conta" value={imp.nome || ''} onChange={(e) => setImp({ ...imp, nome: e.target.value })} />
            </>)}
          </div>
        )}
        {imp && imp.result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Banner tone="success" title={`"${imp.result.nome}" criado como rascunho.`}>{imp.result.criados.etiquetas} etiqueta(s), {imp.result.criados.emails} e-mail(s) e {imp.result.criados.agentes} agente(s) prontos nesta conta.</Banner>
            {imp.result.pendencias.length > 0 ? <Banner tone="warning" title="Falta configurar antes de publicar:"><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{imp.result.pendencias.map((t, i) => <li key={i}>{t}</li>)}</ul></Banner>
              : <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Nada pendente. Abra no editor, revise e publique.</div>}
          </div>
        )}
      </Modal>
      <Modal open={novo !== null} onClose={() => setNovo(null)} title="Novo fluxo" subtitle="Você monta os blocos no editor; nada roda até publicar e ativar."
        footer={<><Button variant="ghost" onClick={() => setNovo(null)}>Cancelar</Button><Button variant="primary" iconLeft="arrow-right" disabled={busy} onClick={create}>Criar e abrir editor</Button></>}>
        <Input label="Nome do fluxo" value={novo || ''} placeholder="Ex.: Pix pendente — México" onChange={(e) => setNovo(e.target.value)} autoFocus />
      </Modal>
    </div>
  );
}

export { KoblyFlows };
