import { KoblyStoreProvider } from '@/store/store.jsx';
import { Shell } from '@/shell/AppShell.jsx';
import { KoblyFlowSharePreview } from '@/routes/FlowSharePreview.jsx';

// app.koblay.io/?fluxo=código → prévia pública do fluxo compartilhado (sem login)
const sharedFlow = (() => { try { const c = new URLSearchParams(window.location.search).get('fluxo'); return c && /^[0-9a-f-]{36}$/i.test(c) ? c : null; } catch { return null; } })();

export default function App() {
  if (sharedFlow) return <KoblyFlowSharePreview code={sharedFlow} />;
  return (
    <KoblyStoreProvider>
      <Shell />
    </KoblyStoreProvider>
  );
}
