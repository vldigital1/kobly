import { useEffect, useState } from 'react';
import { Avatar, IconButton } from '@/ds';
import { onThemeChange, resolvedTheme, setThemePref } from '@/lib/theme.js';
import { Reveal } from '@/lib/motion.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Topbar. Eyebrow + título da rota + slot de ações + claro/escuro + avatar + sair.
// (O seletor de papel foi removido; troca-se de conta por logout + login.) KoblyTopbar

function Topbar({ eyebrow, title, actions, onMenu }) {
  const store = useKobly();
  const [theme, setTheme] = useState(() => resolvedTheme());
  useEffect(() => onThemeChange((t) => setTheme(t)), []);
  return (
    <header style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
      height: 'var(--topbar-height)', padding: '0 var(--content-pad)',
      borderBottom: '1px solid var(--border-subtle)', background: 'var(--surface-nav)', flex: 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        {onMenu && <IconButton icon="menu" variant="secondary" aria-label="Abrir menu" onClick={onMenu} />}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 'var(--text-2xs)', letterSpacing: 'var(--ls-eyebrow)', textTransform: 'uppercase', color: 'var(--text-subtle)', fontWeight: 'var(--fw-semibold)', whiteSpace: 'nowrap' }}>{eyebrow}</div>
          <Reveal key={title} y={4} style={{ fontSize: 'var(--text-2xl)', fontWeight: 'var(--fw-bold)', color: 'var(--text-strong)', letterSpacing: 'var(--ls-tight)', marginTop: 2 }}>{title}</Reveal>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 'none' }}>
        {actions}
        {actions && <span style={{ width: 1, height: 30, background: 'var(--border-subtle)' }}></span>}
        <IconButton icon={theme === 'light' ? 'moon' : 'sun'} aria-label={theme === 'light' ? 'Usar tema escuro' : 'Usar tema claro'} title={theme === 'light' ? 'Tema escuro' : 'Tema claro'} onClick={() => setThemePref(theme === 'light' ? 'dark' : 'light')} />
        <Avatar name={store.session.name} />
        <IconButton icon="log-out" aria-label="Sair" onClick={() => store.signOut()} />
      </div>
    </header>
  );
}

export const KoblyTopbar = Topbar;
