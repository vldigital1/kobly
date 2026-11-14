// Central de ajuda da Kobly. Um motor só para a página pública (/ajuda) e para o menu Ajuda do painel:
//   mountHelp(elemento, { embed, theme, chamado })
// O conteúdo vem de /ajuda/conteudo.json. Na página pública a navegação usa o endereço (#/artigo/...),
// dentro do painel ela fica só na tela. Artigo lido e progresso das trilhas ficam guardados no navegador.

const ICONS = {
  rocket: '<path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2z"/><path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z"/>',
  'git-branch': '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v12M18 15a9 9 0 0 0-9-9"/>',
  'message-circle': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
  'shopping-cart': '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2 2h3l2.7 12.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 1.9-1.5L23 6H6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  sparkles: '<path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2zM5 3v4M3 5h4M19 17v4M17 19h4"/>',
  'credit-card': '<rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/>',
  'life-buoy': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="m4.9 4.9 4.3 4.3M14.8 14.8l4.3 4.3M14.8 9.2l4.3-4.3M4.9 19.1l4.3-4.3"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  arrow: '<path d="M5 12h14M13 5l7 7-7 7"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
};
const icon = (n) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ICONS.book}</svg>`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const strip = (h) => String(h || '').replace(/<[^>]+>/g, '');
const store = {
  get(k, d) { try { const v = localStorage.getItem('kobly:ajuda:' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('kobly:ajuda:' + k, JSON.stringify(v)); } catch (e) { /* sem armazenamento */ } },
};
// YouTube, Vimeo, Loom ou arquivo .mp4
function videoHtml(url) {
  if (!url) return '';
  const yt = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/.exec(url);
  if (yt) return `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${yt[1]}" title="Vídeo do tutorial" allow="accelerometer; encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>`;
  const vm = /vimeo\.com\/(\d+)/.exec(url);
  if (vm) return `<div class="video"><iframe src="https://player.vimeo.com/video/${vm[1]}" title="Vídeo do tutorial" allow="fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
  const lo = /loom\.com\/share\/([\w-]+)/.exec(url);
  if (lo) return `<div class="video"><iframe src="https://www.loom.com/embed/${lo[1]}" title="Vídeo do tutorial" allowfullscreen loading="lazy"></iframe></div>`;
  if (/\.mp4(\?|$)/.test(url)) return `<div class="video"><video src="${esc(url)}" controls preload="metadata"></video></div>`;
  return '';
}

export async function mountHelp(root, opts = {}) {
  if (root.__kbh) return root.__kbh; // já montada neste elemento (o React pode chamar duas vezes)
  let done; root.__kbh = new Promise((r) => { done = r; });
  const embed = !!opts.embed;
  const chamado = opts.chamado || 'https://app.koblay.io/';
  const data = await fetch((opts.base || '/ajuda/') + 'conteudo.json', { cache: 'no-cache' }).then((r) => r.json());
  const cats = Object.fromEntries(data.categorias.map((c) => [c.id, c]));
  const arts = Object.fromEntries(data.artigos.map((a) => [a.id, a]));
  const base = opts.base || '/ajuda/';
  let route = { view: 'home', tab: 'artigos' };
  let q = '';

  root.classList.add('kbh');
  const setTheme = (t) => root.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
  setTheme(opts.theme || (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'));

  // endereço da página pública: #/artigo/<id>, #/categoria/<id>, #/trilha/<id>, #/academy
  const fromHash = () => {
    const h = decodeURIComponent((location.hash || '').replace(/^#\/?/, ''));
    const [kind, id] = h.split('/');
    if (kind === 'artigo' && arts[id]) return { view: 'art', id };
    if (kind === 'categoria' && cats[id]) return { view: 'cat', id };
    if (kind === 'trilha' && data.trilhas.some((t) => t.id === id)) return { view: 'trail', id };
    if (kind === 'academy') return { view: 'home', tab: 'academy' };
    return { view: 'home', tab: 'artigos' };
  };
  const toHash = (r) => (r.view === 'art' ? `#/artigo/${r.id}` : r.view === 'cat' ? `#/categoria/${r.id}` : r.view === 'trail' ? `#/trilha/${r.id}` : r.tab === 'academy' ? '#/academy' : '#/');
  function go(r) {
    route = r; q = r.keepQuery ? q : '';
    if (!embed && location.hash !== toHash(r)) history.pushState(null, '', toHash(r));
    render();
    if (r.scroll === false) return; // trocar de aba não pula a tela
    if (embed) root.scrollIntoView({ block: 'start', behavior: 'smooth' }); else window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  if (!embed) {
    route = fromHash();
    const sync = () => { const r = fromHash(); if (toHash(r) !== toHash(route)) { route = r; q = ''; render(); window.scrollTo(0, 0); } };
    window.addEventListener('popstate', sync); window.addEventListener('hashchange', sync);
  }

  const lidos = () => store.get('lidos', []);
  const toggleLido = (id) => { const l = lidos(); store.set('lidos', l.includes(id) ? l.filter((x) => x !== id) : [...l, id]); render(); };
  const progresso = (t) => { const l = lidos(); const n = t.artigos.filter((id) => l.includes(id)).length; return { n, total: t.artigos.length, pct: Math.round((n / t.artigos.length) * 100) }; };
  const porCat = (id) => data.artigos.filter((a) => a.cat === id);
  const shot = (img, alt) => (img ? `<div class="shot" data-zoom="${esc(base + 'img/' + img)}"><img src="${esc(base + 'img/' + img)}" alt="${esc(alt)}" loading="lazy" onerror="this.parentNode.remove()"></div>` : '');

  function header(sub) {
    return `<section class="top">
      <span class="eyebrow"><i></i>Central de ajuda da Kobly</span>
      <h1>${sub || 'Como podemos <b>ajudar</b>?'}</h1>
      <p>Passo a passo de cada tela, conexões, fluxos e respostas para as dúvidas mais comuns.</p>
      <label class="search">${icon('search')}<input id="kbh-q" type="search" placeholder="Busque: conectar WhatsApp, Pix, Instagram, janela de 24 h…" value="${esc(q)}" autocomplete="off"></label>
      <div class="tabs" role="tablist">
        <button type="button" data-tab="artigos" class="${route.tab !== 'academy' ? 'on' : ''}">${icon('book')}Artigos</button>
        <button type="button" data-tab="academy" class="${route.tab === 'academy' ? 'on' : ''}">${icon('play')}Academy</button>
      </div>
    </section>`;
  }
  function trailCards(list) {
    return `<div class="trails">${list.map((t) => { const p = progresso(t); return `<button type="button" class="trail" data-trail="${t.id}">
      <span class="tag">${esc(t.nivel)}</span><h3>${esc(t.titulo)}</h3><p>${esc(t.desc)}</p>
      <div class="meta"><span>${icon('book')} ${t.artigos.length} aulas</span><span>${icon('clock')} ${esc(t.tempo)}</span><span>${p.pct}% feito</span></div>
      <div class="bar"><i style="width:${p.pct}%"></i></div></button>`; }).join('')}</div>`;
  }
  function artRows(list, numbered = false) {
    const l = lidos();
    return `<div class="list">${list.map((a, i) => `<button type="button" class="row" data-art="${a.id}">
      <span class="num${l.includes(a.id) ? ' ok' : ''}">${l.includes(a.id) ? icon('check') : numbered ? i + 1 : icon(cats[a.cat] ? cats[a.cat].icone : 'book')}</span>
      <span style="min-width:0"><b>${esc(a.titulo)}</b><small>${esc(a.resumo)}</small></span><span class="go">${icon('arrow')}</span></button>`).join('')}</div>`;
  }
  function faqHtml(list) {
    return `<div class="faq">${list.map((f) => `<details><summary>${esc(f.q)}</summary><div class="a">${esc(f.a)}</div></details>`).join('')}</div>`;
  }

  function viewHome() {
    if (q.trim()) {
      const t = norm(q).split(/\s+/).filter(Boolean);
      const hit = (s) => t.every((w) => norm(s).includes(w));
      const a = data.artigos.filter((x) => hit(x.titulo + ' ' + x.resumo + ' ' + x.passos.map((p) => p.t + ' ' + strip(p.d)).join(' ')));
      const f = data.faq.filter((x) => hit(x.q + ' ' + x.a));
      return header() + `<div class="sec"><div><h2>Resultados para “${esc(q)}”</h2><p>${a.length} artigo(s) e ${f.length} pergunta(s)</p></div></div>`
        + (a.length ? artRows(a) : '') + (f.length ? `<div class="sec"><h2>Perguntas frequentes</h2></div>` + faqHtml(f) : '')
        + (!a.length && !f.length ? `<div class="empty">Nada encontrado. Tente outra palavra ou <a href="${esc(chamado)}" target="_blank" rel="noopener">abra um chamado</a>.</div>` : '');
    }
    if (route.tab === 'academy') {
      return header('Aprenda a Kobly <b>na prática</b>') + `<div class="sec"><div><h2>Trilhas guiadas</h2><p>Caminhos em ordem, do zero ao avançado. Marque cada aula como feita e acompanhe o progresso.</p></div></div>`
        + trailCards(data.trilhas)
        + `<div class="sec"><div><h2>Todas as aulas por tema</h2><p>Escolha um tema e vá direto ao passo a passo.</p></div></div>`
        + data.categorias.map((c) => { const l = porCat(c.id); return l.length ? `<div class="sec" style="margin-top:22px"><h2 style="font-size:17px">${icon(c.icone)} ${esc(c.nome)}</h2><button type="button" class="link" data-cat="${c.id}">Ver tudo</button></div>${artRows(l.slice(0, 4))}` : ''; }).join('');
    }
    return header()
      + `<div class="sec"><div><h2>Comece por um tema</h2><p>Tudo o que dá para fazer na Kobly, explicado passo a passo.</p></div></div>`
      + `<div class="grid">${data.categorias.map((c) => `<button type="button" class="card" data-cat="${c.id}"><span class="badge">${icon(c.icone)}</span><h3>${esc(c.nome)}</h3><p>${esc(c.desc)}</p><div class="n">${porCat(c.id).length + data.faq.filter((f) => f.cat === c.id).length} conteúdos</div></button>`).join('')}</div>`
      + `<div class="sec"><div><h2>Trilhas guiadas</h2><p>Siga na ordem e deixe tudo funcionando.</p></div><button type="button" class="link" data-tab="academy">Ver Academy</button></div>`
      + trailCards(data.trilhas.slice(0, 3))
      + `<div class="sec"><div><h2>Perguntas frequentes</h2><p>As dúvidas que mais chegam no suporte.</p></div></div>` + faqHtml(data.faq.slice(0, 10));
  }
  function viewCat() {
    const c = cats[route.id]; const l = porCat(c.id); const f = data.faq.filter((x) => x.cat === c.id);
    return `<div class="crumbs"><button type="button" data-home>Central de ajuda</button><span>›</span><span>${esc(c.nome)}</span></div>
      <section class="top" style="padding:34px 36px"><span class="eyebrow"><i></i>${l.length} artigo(s)</span><h1>${esc(c.nome)}</h1><p>${esc(c.desc)}</p></section>`
      + (l.length ? artRows(l) : '') + (f.length ? `<div class="sec"><h2>Perguntas frequentes</h2></div>` + faqHtml(f) : '');
  }
  function viewTrail() {
    const t = data.trilhas.find((x) => x.id === route.id); const p = progresso(t);
    return `<div class="crumbs"><button type="button" data-tab="academy">Academy</button><span>›</span><span>${esc(t.titulo)}</span></div>
      <section class="top" style="padding:34px 36px"><span class="eyebrow"><i></i>${esc(t.nivel)} · ${esc(t.tempo)}</span><h1>${esc(t.titulo)}</h1><p>${esc(t.desc)}</p>
      <div class="bar" style="max-width:420px;background:rgba(255,255,255,.15)"><i style="width:${p.pct}%"></i></div><p style="font-size:14px;margin-top:8px">${p.n} de ${p.total} aulas feitas</p></section>`
      + artRows(t.artigos.map((id) => arts[id]).filter(Boolean), true);
  }
  function viewArt() {
    const a = arts[route.id]; const c = cats[a.cat]; const l = lidos();
    const trail = data.trilhas.find((t) => t.artigos.includes(a.id) && (route.trail ? t.id === route.trail : true));
    const seq = trail ? trail.artigos : porCat(a.cat).map((x) => x.id);
    const i = seq.indexOf(a.id); const prev = arts[seq[i - 1]]; const next = arts[seq[i + 1]];
    const rel = porCat(a.cat).filter((x) => x.id !== a.id).slice(0, 6);
    return `<div class="crumbs"><button type="button" data-home>Central de ajuda</button><span>›</span><button type="button" data-cat="${c.id}">${esc(c.nome)}</button><span>›</span><span>${esc(a.titulo)}</span></div>
    <div class="art"><article class="paper">
      <h1>${esc(a.titulo)}</h1><p class="lead">${esc(a.resumo)}</p>
      <div class="chips"><span class="chip">${icon('clock')} ${esc(a.tempo || '3 min')} de leitura</span><span class="chip">${icon(c.icone)} ${esc(c.nome)}</span>${trail ? `<span class="chip">${icon('play')} Trilha: ${esc(trail.titulo)}</span>` : ''}</div>
      ${videoHtml(a.video)}
      ${a.antes && a.antes.length ? `<div class="box"><h3>${icon('info')} Antes de começar</h3><ul>${a.antes.map((x) => `<li>${x}</li>`).join('')}</ul></div>` : ''}
      <h2 class="steps-h">Passo a passo</h2>
      ${a.passos.map((p, k) => `<section class="step"><span class="k">${k + 1}</span><h3>${esc(p.t)}</h3><p>${p.d}</p>${shot(p.img, p.t)}</section>`).join('')}
      ${a.dicas && a.dicas.length ? `<div class="box tip"><h3>${icon('bulb')} Dicas</h3><ul>${a.dicas.map((x) => `<li>${x}</li>`).join('')}</ul></div>` : ''}
      <button type="button" class="done${l.includes(a.id) ? ' on' : ''}" data-done="${a.id}">${icon('check')} ${l.includes(a.id) ? 'Concluído' : 'Marcar como concluído'}</button>
      <div class="navx">${prev ? `<button type="button" data-art="${prev.id}"><small>Anterior</small><b>${esc(prev.titulo)}</b></button>` : '<span></span>'}${next ? `<button type="button" data-art="${next.id}" style="text-align:right"><small>Próximo</small><b>${esc(next.titulo)}</b></button>` : ''}</div>
    </article>
    <aside class="side">
      ${rel.length ? `<div class="panel"><h4>Mais em ${esc(c.nome)}</h4>${rel.map((x) => `<button type="button" class="l" data-art="${x.id}">${esc(x.titulo)}</button>`).join('')}</div>` : ''}
      <div class="help"><h4>Ainda com dúvida?</h4><p>Fale com o suporte da Kobly: respondemos rápido.</p><a href="${esc(chamado)}" ${embed ? '' : 'target="_blank" rel="noopener"'} data-chamado>Abrir um chamado</a></div>
    </aside></div>`;
  }

  function render() {
    const html = route.view === 'art' ? viewArt() : route.view === 'cat' ? viewCat() : route.view === 'trail' ? viewTrail() : viewHome();
    const focused = document.activeElement && document.activeElement.id === 'kbh-q';
    const pos = focused ? document.activeElement.selectionStart : null;
    root.innerHTML = `<div class="wrap">${html}</div>`;
    if (!embed) document.title = route.view === 'art' ? `${arts[route.id].titulo} — Ajuda Kobly` : route.view === 'cat' ? `${cats[route.id].nome} — Ajuda Kobly` : 'Central de ajuda — Kobly';
    const inp = root.querySelector('#kbh-q');
    if (inp && focused) { inp.focus(); try { inp.setSelectionRange(pos, pos); } catch (e) { /* ok */ } }
  }
  root.addEventListener('input', (e) => { if (e.target.id === 'kbh-q') { q = e.target.value; route = { view: 'home', tab: route.tab || 'artigos' }; render(); } });
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-art],[data-cat],[data-trail],[data-tab],[data-home],[data-done],[data-zoom],[data-chamado]');
    if (!el) return;
    if (el.dataset.chamado !== undefined && opts.onChamado) { e.preventDefault(); opts.onChamado(); return; }
    if (el.dataset.zoom) { const z = document.createElement('div'); z.className = 'zoom'; z.innerHTML = `<img src="${esc(el.dataset.zoom)}" alt="">`; z.onclick = () => z.remove(); root.appendChild(z); return; }
    if (el.dataset.done) { toggleLido(el.dataset.done); return; }
    if (el.dataset.art) return go({ view: 'art', id: el.dataset.art, trail: route.view === 'trail' ? route.id : route.trail });
    if (el.dataset.cat) return go({ view: 'cat', id: el.dataset.cat });
    if (el.dataset.trail) return go({ view: 'trail', id: el.dataset.trail });
    if (el.dataset.tab) return go({ view: 'home', tab: el.dataset.tab, scroll: false });
    if (el.dataset.home !== undefined) return go({ view: 'home', tab: 'artigos' });
  });
  render();
  const handle = { setTheme, go };
  done(handle);
  return handle;
}
