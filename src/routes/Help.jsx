import { useEffect, useRef, useState } from 'react';
import { Banner, Spinner } from '@/ds';
import { useKobly } from '@/store/store.jsx';

// Kobly — Central de ajuda dentro do painel. É a mesma central da página pública (/ajuda): artigos passo a passo,
// Academy (trilhas) e perguntas frequentes, vindos de /ajuda/conteudo.json. "Abrir um chamado" leva para Chamados. KoblyHelp

const themeOfPanel = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

function KoblyHelp() {
  const store = useKobly();
  const ref = useRef(null);
  const nav = useRef(store.navigate); nav.current = store.navigate; // monta a central uma vez só
  const [st, setSt] = useState('loading');
  useEffect(() => {
    let alive = true, obs = null;
    if (!document.getElementById('kbh-css')) {
      const link = document.createElement('link');
      link.id = 'kbh-css'; link.rel = 'stylesheet'; link.href = '/ajuda/ajuda.css';
      document.head.appendChild(link);
    }
    // o motor fica na pasta public (é o mesmo da página /ajuda): baixa e carrega na hora, fora do empacotamento
    fetch('/ajuda/ajuda.js', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error('ajuda.js'); return r.text(); })
      .then((code) => { const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); return import(/* @vite-ignore */ url).finally(() => URL.revokeObjectURL(url)); })
      .then((m) => m.mountHelp(ref.current, { embed: true, theme: themeOfPanel(), onChamado: () => nav.current('chamados') }))
      .then((h) => {
        if (!alive) return;
        setSt('ok');
        // acompanha a troca de tema claro/escuro do painel
        obs = new MutationObserver(() => h.setTheme(themeOfPanel()));
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      })
      .catch(() => alive && setSt('error'));
    return () => { alive = false; if (obs) obs.disconnect(); };
  }, []);
  return (
    <div>
      {st === 'loading' && <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-muted)', padding: 12 }}><Spinner size={14} /> Abrindo a central de ajuda…</div>}
      {st === 'error' && <Banner tone="danger" title="Não deu para abrir a central de ajuda.">Confira a internet e tente de novo, ou abra em <a href="/ajuda" target="_blank" rel="noopener">app.koblay.io/ajuda</a>.</Banner>}
      <div ref={ref} />
    </div>
  );
}
export { KoblyHelp };
