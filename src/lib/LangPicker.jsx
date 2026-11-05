import { LANGS, getLang, setLang } from '@/lib/i18n.js';

// Escolher idioma da tela. Os nomes ficam sempre no próprio idioma (data-no-i18n).
const CODE = { pt: 'PT', es: 'ES', en: 'EN' };

export function LangPicker({ compact = false }) {
  const cur = getLang();
  if (compact) {
    return (
      <div data-no-i18n style={{ display: 'flex', justifyContent: 'center', gap: 6 }}>
        {LANGS.map((l) => (
          <button key={l.id} type="button" onClick={() => l.id !== cur && setLang(l.id)} aria-pressed={cur === l.id}
            style={{ padding: '5px 10px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-xs)', fontWeight: 600,
              color: cur === l.id ? 'var(--text-strong)' : 'var(--text-muted)', background: cur === l.id ? 'var(--accent-soft)' : 'transparent',
              border: `1px solid ${cur === l.id ? 'var(--border-accent)' : 'var(--border-subtle)'}` }}>
            <span style={{ marginRight: 6, fontSize: 10, fontWeight: 800, letterSpacing: '0.04em', opacity: 0.7 }}>{CODE[l.id]}</span>{l.label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div data-no-i18n style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
      {LANGS.map((l) => (
        <button key={l.id} type="button" onClick={() => l.id !== cur && setLang(l.id)} aria-pressed={cur === l.id}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '12px 8px', borderRadius: 12, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', fontWeight: 600,
            color: cur === l.id ? 'var(--text-strong)' : 'var(--text-muted)', background: cur === l.id ? 'var(--accent-soft)' : 'var(--surface-sunken)',
            border: `1px solid ${cur === l.id ? 'var(--border-accent)' : 'var(--border-subtle)'}` }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.06em', lineHeight: 1, padding: '4px 7px', borderRadius: 6, background: 'var(--surface-card)', border: '1px solid var(--border-subtle)' }}>{CODE[l.id]}</span>{l.label}
        </button>
      ))}
    </div>
  );
}
