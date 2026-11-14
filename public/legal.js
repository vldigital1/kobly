// Páginas públicas: tema claro/escuro (mesma preferência da página de vendas), índice automático e barra de leitura.
(function () {
  var root = document.documentElement, KEY = 'kobly:site-theme';
  function setTheme(t) { root.setAttribute('data-theme', t); try { localStorage.setItem(KEY, t); } catch (e) {} }
  var btn = document.getElementById('theme');
  if (btn) btn.addEventListener('click', function () { setTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); });

  // índice: monta a partir dos títulos <h2> quando a página não trouxe um pronto
  var toc = document.getElementById('toc'), article = document.querySelector('article');
  if (toc && article && !toc.querySelector('a')) {
    var heads = article.querySelectorAll('h2');
    if (heads.length) {
      var t = document.createElement('h4'); t.textContent = toc.getAttribute('data-title') || 'Nesta página'; toc.appendChild(t);
      heads.forEach(function (h, i) {
        if (!h.id) h.id = 's' + (i + 1);
        var a = document.createElement('a'); a.href = '#' + h.id; a.textContent = h.textContent.replace(/^\d+\.\s*/, ''); toc.appendChild(a);
      });
    } else toc.remove();
  }
  // destaca no índice a seção que está na tela
  var links = toc ? Array.prototype.slice.call(toc.querySelectorAll('a[href^="#"]')) : [];
  var targets = links.map(function (a) { return document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))); });
  var bar = document.querySelector('.progress');
  function onScroll() {
    var y = window.scrollY, max = document.documentElement.scrollHeight - window.innerHeight;
    if (bar) bar.style.setProperty('--p', max > 0 ? Math.min(1, y / max) : 0);
    var cur = -1;
    targets.forEach(function (el, i) { if (el && el.getBoundingClientRect().top < 140) cur = i; });
    links.forEach(function (a, i) { a.classList.toggle('on', i === cur); });
  }
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
})();
