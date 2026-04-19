/* Theme toggle (dark <-> light).
 *
 * The inline bootstrap in base.html has already set
 * `document.documentElement.dataset.theme` to "dark" or "light" before
 * this script loads. This file:
 *
 *   - Injects a floating slider control pinned to the bottom-right of
 *     the viewport. It's purely DOM + CSS — anything with the class
 *     `theme-toggle-mount` also gets an inline toggle so we don't fight
 *     over positioning on non-map pages.
 *   - Flips `data-theme` on <html> when the user clicks.
 *   - Persists the choice to localStorage.
 *   - Dispatches a `mmap:theme-change` CustomEvent on `document` so
 *     map.js can repaint the basemap layers without reloading.
 *
 * Exposes `window.MaristTheme` with `{ get(), set(theme), toggle() }`.
 */
(function () {
  var STORAGE_KEY = 'maristmaps.theme';
  var EVENT_NAME = 'mmap:theme-change';

  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'light' : 'dark';
  }

  function setTheme(next, opts) {
    var theme = next === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (_) {
      /* private mode etc. — silently ignore */
    }
    var persist = !(opts && opts.silent);
    if (persist) {
      document.dispatchEvent(
        new CustomEvent(EVENT_NAME, { detail: { theme: theme } })
      );
    }
    updateSwitches();
  }

  function toggle() {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  }

  /**
   * Build one switch element. The markup is:
   *
   *   <button class="theme-toggle" aria-pressed="...">
   *     <span class="theme-toggle__track">
   *       <span class="theme-toggle__thumb">
   *         <svg class="theme-toggle__icon theme-toggle__icon--sun">…</svg>
   *         <svg class="theme-toggle__icon theme-toggle__icon--moon">…</svg>
   *       </span>
   *     </span>
   *     <span class="theme-toggle__label">Dark mode</span>
   *   </button>
   */
  function buildSwitch(opts) {
    opts = opts || {};
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle' + (opts.floating ? ' theme-toggle--floating' : '');
    btn.setAttribute('aria-label', 'Toggle dark mode');
    btn.title = 'Toggle dark mode';

    btn.innerHTML = [
      '<span class="theme-toggle__track" aria-hidden="true">',
        '<span class="theme-toggle__thumb">',
          // sun
          '<svg class="theme-toggle__icon theme-toggle__icon--sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
            '<circle cx="12" cy="12" r="4"/>',
            '<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
          '</svg>',
          // moon
          '<svg class="theme-toggle__icon theme-toggle__icon--moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
            '<path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z"/>',
          '</svg>',
        '</span>',
      '</span>',
    ].join('');

    btn.addEventListener('click', toggle);
    return btn;
  }

  var switches = [];

  function updateSwitches() {
    var theme = currentTheme();
    for (var i = 0; i < switches.length; i++) {
      switches[i].setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      switches[i].dataset.theme = theme;
    }
  }

  function mountFloating() {
    // Only add the floating toggle on pages that have a map viewport —
    // anywhere else, the toggle would float over bare body content
    // and look out of place.
    if (!document.querySelector('.map-viewport, body.map-view')) {
      return;
    }
    var anchor = document.querySelector('.map-viewport') || document.body;
    var el = buildSwitch({ floating: true });
    anchor.appendChild(el);
    switches.push(el);
  }

  function mountInline() {
    var targets = document.querySelectorAll('.theme-toggle-mount');
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (t.dataset.themeMounted === '1') continue;
      var el = buildSwitch({ floating: false });
      t.appendChild(el);
      t.dataset.themeMounted = '1';
      switches.push(el);
    }
  }

  function init() {
    mountFloating();
    mountInline();
    updateSwitches();
  }

  window.MaristTheme = {
    get: currentTheme,
    set: setTheme,
    toggle: toggle,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
