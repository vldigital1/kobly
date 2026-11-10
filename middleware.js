// Vercel (roda antes dos arquivos): em koblay.io e www.koblay.io a página inicial é a página de vendas
// (public/site.html). Em app.koblay.io nada muda: continua abrindo o painel.
export const config = { matcher: '/' };

const SITE_HOSTS = new Set(['koblay.io', 'www.koblay.io']);

export default function middleware(request) {
  const host = (request.headers.get('host') || '').toLowerCase().split(':')[0];
  if (!SITE_HOSTS.has(host)) return undefined; // segue normal
  return new Response(null, { headers: { 'x-middleware-rewrite': new URL('/site', request.url).toString() } });
}
