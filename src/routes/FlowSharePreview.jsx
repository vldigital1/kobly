import React, { useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Icon } from '@/ds';

// Kobly — prévia pública de fluxo compartilhado (app.koblay.io/?fluxo=código). Qualquer pessoa vê o desenho, sem
// login. "Importar na minha conta" leva ao app (login, se precisar) e abre Fluxos → Importar com o código.

const KoblyFlowReadOnly = React.lazy(() => import('@/routes/FlowGraphEditor.jsx').then((m) => ({ default: m.FlowReadOnly })));

const CSS = `
.fp { min-height: 100vh; display: flex; flex-direction: column; background: radial-gradient(circle at 0% 0%, rgba(255,98,1,.16), transparent 45%), #0b0c11; color: var(--text-body); font-family: var(--font-sans); }
.fp-top { display: flex; align-items: center; gap: 14px; padding: 14px 20px; border-bottom: 1px solid rgba(255,255,255,.07); flex-wrap: wrap; }
.fp-logo { display: flex; align-items: center; gap: 8px; font-weight: 900; font-size: 20px; color: #ff6201; letter-spacing: .02em; text-decoration: none; }
.fp-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; color: var(--text-muted); background: rgba(255,255,255,.06); }
.fp-btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 12px; border: 0; cursor: pointer; font-family: var(--font-sans); font-size: 14px; font-weight: 700; color: #fff; background: linear-gradient(135deg, #ff9452, #ff6201); box-shadow: 0 0 20px rgba(255,98,1,.35); text-decoration: none; }
.fp-btn.ghost { background: rgba(255,255,255,.06); box-shadow: none; color: var(--text-strong); border: 1px solid rgba(255,255,255,.12); }
.fp-body { flex: 1; display: flex; padding: 16px 20px 20px; min-height: 0; }
.fp-canvas { flex: 1; border-radius: 18px; overflow: hidden; border: 1px solid rgba(255,255,255,.08); min-height: 70vh; }
.fp-msg { margin: auto; text-align: center; max-width: 420px; padding: 40px 20px; color: var(--text-muted); }
`;

export function KoblyFlowSharePreview({ code }) {
  const [st, setSt] = useState({ loading: true });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    KoblyApi.flowSharePreview(code).then((r) => setSt(r && r.graph ? { data: r } : { error: (r && (r.message || r.error)) || 'Esse fluxo não existe ou o código foi desativado.' }))
      .catch(() => setSt({ error: 'Não deu para abrir agora. Tente de novo em instantes.' }));
  }, [code]);
  const d = st.data;
  function importar() {
    try { sessionStorage.setItem('kobly:import-flow', code); sessionStorage.setItem('kbly_view', 'fluxos'); } catch { /* ok */ }
    window.location.href = `${window.location.origin}/`;
  }
  function copiar() { try { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* ok */ } }
  return (
    <div className="fp">
      <style>{CSS}</style>
      <div className="fp-top">
        <a className="fp-logo" href="/"><Icon name="zap" size={20} />KOBLY</a>
        {d && <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 800, fontSize: 17, color: 'var(--text-strong)' }}>{d.nome}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            <span className="fp-chip"><Icon name="git-branch" size={12} />{d.blocos} blocos</span>
            <span className="fp-chip"><Icon name="building-2" size={12} />Compartilhado por {d.conta}</span>
            {d.inclui.emails > 0 && <span className="fp-chip"><Icon name="mail" size={12} />{d.inclui.emails} e-mail(s)</span>}
            {d.inclui.agentes > 0 && <span className="fp-chip"><Icon name="bot" size={12} />{d.inclui.agentes} agente(s)</span>}
          </div>
        </div>}
        {d && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="fp-btn ghost" onClick={copiar}><Icon name={copied ? 'check' : 'copy'} size={16} />{copied ? 'Código copiado' : 'Copiar código'}</button>
          <button type="button" className="fp-btn" onClick={importar}><Icon name="download" size={16} />Importar na minha conta</button>
        </div>}
      </div>
      <div className="fp-body">
        {st.loading && <div className="fp-msg">Abrindo o fluxo…</div>}
        {st.error && <div className="fp-msg"><Icon name="circle-x" size={34} style={{ color: '#fb7185' }} /><div style={{ marginTop: 10, fontSize: 16, color: 'var(--text-strong)' }}>{st.error}</div><a href="/" style={{ color: '#ff9452', display: 'inline-block', marginTop: 14 }}>Ir para a Kobly</a></div>}
        {d && <div className="fp-canvas"><React.Suspense fallback={<div className="fp-msg">Desenhando…</div>}><KoblyFlowReadOnly graph={d.graph} lookups={d.lookups} /></React.Suspense></div>}
      </div>
    </div>
  );
}
