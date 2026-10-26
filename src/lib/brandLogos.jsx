import React from 'react';

// Logos dos canais desenhados em SVG (sem arquivo externo): WhatsApp, WhatsApp Oficial (com selo), Instagram,
// Telegram e Messenger. `size` é o lado do quadrado; `rounded` dá o formato de ícone de app.

function Tile({ size, radius, bg, children, label }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label={label} style={{ flex: 'none', display: 'block' }}>
      {bg}
      {children}
    </svg>
  );
}

export function WhatsAppLogo({ size = 40, verified = false }) {
  return (
    <Tile size={size} label={verified ? 'WhatsApp Oficial' : 'WhatsApp'} bg={(<>
      <defs><linearGradient id="kl-wa" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5BF07A" /><stop offset="1" stopColor="#1EBE52" /></linearGradient></defs>
      <rect width="48" height="48" rx="13" fill="url(#kl-wa)" />
    </>)}>
      {/* balão com o rabinho embaixo à esquerda */}
      <path d="M24 9.5c-8 0-14.5 6.3-14.5 14.2 0 2.7.8 5.3 2.2 7.5L9.6 38.4l7.5-2c2.1 1.1 4.5 1.7 6.9 1.7 8 0 14.5-6.4 14.5-14.3S32 9.5 24 9.5z" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinejoin="round" />
      {/* telefone */}
      <path d="M19.2 17.6c.4-.9 1-1 1.4-1h1c.3 0 .6.1.8.6l1.2 2.9c.1.3.1.6-.1.9l-.8 1c-.2.2-.2.5 0 .8.8 1.4 2.4 3 4 3.8.3.2.6.1.8-.1l1-1.2c.2-.3.6-.3.9-.2l2.8 1.3c.4.2.6.4.5.8-.1 1.2-.9 2.6-2.6 2.9-1.4.3-3.6-.2-6.4-2.3-3-2.3-4.3-4.6-4.6-6-.3-1.4.3-2.7 1.1-3.2z" fill="#fff" />
      {verified && (<>
        <circle cx="38" cy="38" r="8.5" fill="#1D9BF0" stroke="#0d1018" strokeWidth="2" />
        <path d="M34.3 38.1l2.5 2.4 4.9-5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </>)}
    </Tile>
  );
}

export function InstagramLogo({ size = 40 }) {
  return (
    <Tile size={size} label="Instagram" bg={(<>
      <defs>
        <radialGradient id="kl-ig" cx="0.3" cy="1.07" r="1.25">
          <stop offset="0" stopColor="#FFDD55" /><stop offset="0.12" stopColor="#FFDD55" /><stop offset="0.5" stopColor="#FF543E" /><stop offset="1" stopColor="#C837AB" />
        </radialGradient>
        <radialGradient id="kl-ig2" cx="-0.15" cy="0.07" r="0.6"><stop offset="0" stopColor="#3771C8" /><stop offset="0.13" stopColor="#3771C8" /><stop offset="1" stopColor="#6600FF" stopOpacity="0" /></radialGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#kl-ig)" />
      <rect width="48" height="48" rx="13" fill="url(#kl-ig2)" />
    </>)}>
      <rect x="11" y="11" width="26" height="26" rx="8" fill="none" stroke="#fff" strokeWidth="2.8" />
      <circle cx="24" cy="24" r="6.2" fill="none" stroke="#fff" strokeWidth="2.8" />
      <circle cx="31.6" cy="16.4" r="1.8" fill="#fff" />
    </Tile>
  );
}

export function TelegramLogo({ size = 40 }) {
  return (
    <Tile size={size} label="Telegram" bg={(<>
      <defs><linearGradient id="kl-tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#37BBFE" /><stop offset="1" stopColor="#007DBB" /></linearGradient></defs>
      <rect width="48" height="48" rx="13" fill="url(#kl-tg)" />
    </>)}>
      <path d="M10.8 23.2l23.6-9.1c1.1-.4 2.1.3 1.7 1.9l-4 18.9c-.3 1.3-1.1 1.7-2.2 1l-6.1-4.5-2.9 2.8c-.3.3-.6.6-1.2.6l.4-6.2 11.3-10.2c.5-.4-.1-.7-.8-.3l-14 8.8-6-1.9c-1.3-.4-1.3-1.3.2-1.8z" fill="#fff" />
    </Tile>
  );
}

export function MessengerLogo({ size = 40 }) {
  return (
    <Tile size={size} label="Messenger" bg={(<>
      <defs><radialGradient id="kl-ms" cx="0.19" cy="0.99" r="1.1"><stop offset="0" stopColor="#0099FF" /><stop offset="0.6" stopColor="#A033FF" /><stop offset="0.9" stopColor="#FF5280" /><stop offset="1" stopColor="#FF7061" /></radialGradient></defs>
      <rect width="48" height="48" rx="13" fill="url(#kl-ms)" />
    </>)}>
      <path d="M24 9.5c-8.2 0-14.5 6-14.5 14 0 4.2 1.7 7.8 4.6 10.3.2.2.4.5.4.8l.1 2.6c0 .8.9 1.4 1.7 1l2.9-1.3c.2-.1.5-.1.8 0 1.3.4 2.7.6 4.1.6 8.2 0 14.5-6 14.5-14S32.2 9.5 24 9.5z" fill="#fff" />
      <path d="M15.3 27.7l4.3-6.8c.7-1.1 2.1-1.3 3.1-.6l3.4 2.6c.3.2.7.2 1 0l4.6-3.5c.6-.5 1.4.3 1 .9l-4.3 6.8c-.7 1.1-2.1 1.3-3.1.6l-3.4-2.6c-.3-.2-.7-.2-1 0l-4.6 3.5c-.6.5-1.4-.2-1-.9z" fill="url(#kl-ms)" />
    </Tile>
  );
}

// Logo pelo id do canal da tela Conexões
export function ChannelLogo({ kind, size = 40 }) {
  if (kind === 'qr') return <WhatsAppLogo size={size} />;
  if (kind === 'oficial') return <WhatsAppLogo size={size} verified />;
  if (kind === 'instagram') return <InstagramLogo size={size} />;
  if (kind === 'telegram') return <TelegramLogo size={size} />;
  if (kind === 'messenger') return <MessengerLogo size={size} />;
  return null;
}

// Plataformas de anúncio (tela Trackeamento)
export function MetaLogo({ size = 40 }) {
  return (
    <Tile size={size} label="Meta" bg={<rect width="48" height="48" rx="13" fill="#0866FF" />}>
      <path d="M11 28.5c0-5.6 2.9-11 6.6-11 2.6 0 4.6 2.6 6.4 5.7 1.8-3.1 3.8-5.7 6.4-5.7 3.7 0 6.6 5.4 6.6 11 0 3.3-1.4 5.2-3.8 5.2-2.6 0-4.3-2.4-6.9-6.9l-2.3-4-2.3 4c-2.6 4.5-4.3 6.9-6.9 6.9-2.4 0-3.8-1.9-3.8-5.2z" fill="none" stroke="#fff" strokeWidth="3" strokeLinejoin="round" />
    </Tile>
  );
}
export function TikTokLogo({ size = 40 }) {
  const note = 'M27.5 10h4.2c.4 3.3 2.6 5.6 5.8 5.9v4.3c-2.2 0-4.2-.7-5.8-1.9v9.6c0 4.8-3.8 8.6-8.6 8.6s-8.6-3.8-8.6-8.6 3.8-8.6 8.6-8.6c.4 0 .9 0 1.3.1v4.4c-.4-.1-.8-.2-1.3-.2-2.4 0-4.3 1.9-4.3 4.3s1.9 4.3 4.3 4.3 4.4-1.9 4.4-4.3V10z';
  return (
    <Tile size={size} label="TikTok" bg={<rect width="48" height="48" rx="13" fill="#000" />}>
      <path d={note} fill="#25F4EE" transform="translate(-1.2 -1)" />
      <path d={note} fill="#FE2C55" transform="translate(1.2 1)" />
      <path d={note} fill="#fff" />
    </Tile>
  );
}
export function GoogleAdsLogo({ size = 40 }) {
  return (
    <Tile size={size} label="Google Ads" bg={<rect width="48" height="48" rx="13" fill="#fff" />}>
      <rect x="21.5" y="8.5" width="8.5" height="30" rx="4.25" fill="#4285F4" transform="rotate(-30 25.75 23.5)" />
      <rect x="18" y="8.5" width="8.5" height="30" rx="4.25" fill="#FBBC04" transform="rotate(30 22.25 23.5)" />
      <circle cx="13.6" cy="34.2" r="4.4" fill="#34A853" />
    </Tile>
  );
}
export function UtmifyLogo({ size = 40 }) {
  return <img src="/assets/platforms/utmify.png" alt="UTMify" width={size} height={size} style={{ borderRadius: size * 0.27, flex: 'none', display: 'block' }} />;
}
