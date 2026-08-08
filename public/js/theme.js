// Tema tercihi: localStorage > sistem tercihi. <head> içinde senkron
// yüklenir ki sayfa ilk boyamada doğru temayla çizilsin.
(function () {
  var KEY = 'cd-theme';

  function apply(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) { /* gizli mod vb. */ }

  var initial = stored || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  apply(initial);

  window.CDTheme = {
    current: function () {
      return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    },
    toggle: function () {
      var next = this.current() === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* yoksay */ }
      return next;
    },
  };

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () { window.CDTheme.toggle(); });
    });
  });
})();
