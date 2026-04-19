/* Sidebar controller for the search card.
 *
 * Two modes, same card:
 *
 *  "single"      A single search input. Selecting a result flies the map
 *                to that feature and drops a popup.
 *
 *  "directions"  Two inputs (From / To). Selecting a result in whichever
 *                input is active populates that field and calls
 *                MaristRoute.setStart/setEnd. When both are set, the
 *                routing module computes the path and dispatches
 *                `mmap:route-changed`; we reflect the summary + GPX
 *                button state from that event.
 *
 * One /api/features fetch feeds autocomplete in both modes. The
 * placeholder-cycling easter eggs are kept in single mode.
 */
(function () {
  const card = document.getElementById('search-card');
  if (!card) {
    console.warn('[search] #search-card missing; sidebar disabled');
    return;
  }

  // ---- shared data -----------------------------------------------------

  let FEATURES = [];
  let featuresReady = false;
  let featuresError = null;
  const featuresReadyPromise = loadFeatures();

  async function loadFeatures() {
    try {
      const res = await fetch('/api/features', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      FEATURES = Array.isArray(data.features) ? data.features : [];
      featuresReady = true;
      console.log(`[search] loaded ${FEATURES.length} features from /api/features`);
      // Re-render whichever mode's results list was waiting on data.
      if (single.input.value.trim()) single.sync();
      if (isDirectionsMode()) directions.sync();
    } catch (err) {
      featuresError = err;
      console.warn('[search] could not load /api/features:', err);
      if (single.input.value.trim()) single.sync();
      if (isDirectionsMode()) directions.sync();
    }
  }

  // Expose the feature set so other scripts can snap to named places if
  // they want (e.g. a future "where am I" control).
  window.MaristSearch = {
    get features() { return FEATURES.slice(); },
    ready: featuresReadyPromise.then(() => FEATURES.slice()),
  };

  // ---- shared helpers --------------------------------------------------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function tokenize(q) {
    return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  function placeHaystack(p) {
    return (
      (p.name || '') + ' ' +
      (p.subtitle || '') + ' ' +
      (p.kind || '')
    ).toLowerCase();
  }

  function scorePlace(p, tokens) {
    const name = (p.name || '').toLowerCase();
    let score = 0;
    for (const t of tokens) {
      const i = name.indexOf(t);
      if (i === 0) score += 5;
      else if (i > 0) score += 2;
      else if (placeHaystack(p).includes(t)) score += 1;
      else return -1;
    }
    if (p.kind === 'building') score += 0.5;
    return score;
  }

  function filterPlaces(q) {
    const tokens = tokenize(q);
    if (!tokens.length) return [];
    const scored = [];
    for (const p of FEATURES) {
      const s = scorePlace(p, tokens);
      if (s >= 0) scored.push({ p, s });
    }
    scored.sort((a, b) =>
      b.s - a.s ||
      (a.p.name || '').localeCompare(b.p.name || '')
    );
    return scored.slice(0, 50).map((x) => x.p);
  }

  function highlight(text, q) {
    if (!q) return escapeHtml(text);
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    const a = escapeHtml(text.slice(0, idx));
    const b = escapeHtml(text.slice(idx, idx + q.length));
    const c = escapeHtml(text.slice(idx + q.length));
    return a + '<strong>' + b + '</strong>' + c;
  }

  function emptyMessage() {
    if (!featuresReady && !featuresError) return 'Loading campus data…';
    if (featuresError) return 'Could not load campus data';
    return 'No matching places';
  }

  const KIND_LABEL = { building: 'Building', path: 'Path', poi: 'Place' };

  function renderResultRow(p, q, i) {
    const kindClass = `search-result__kind--${p.kind || 'poi'}`;
    const kindLabel = KIND_LABEL[p.kind] || 'Place';
    return (
      `<li class="search-result" role="option" id="search-opt-${i}" tabindex="-1" ` +
      `data-idx="${i}">` +
      `<span class="search-result__icon" aria-hidden="true">` +
      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-6-4.35-6-10a6 6 0 1 1 12 0c0 5.65-6 10-6 10z"/><circle cx="12" cy="11" r="2.5"/></svg>` +
      `</span>` +
      `<span class="search-result__text">` +
      `<span class="search-result__title">${highlight(p.name || '', q.trim())}</span>` +
      `<span class="search-result__sub">${escapeHtml(p.subtitle || '')}</span>` +
      `</span>` +
      `<span class="search-result__kind ${kindClass}">${escapeHtml(kindLabel)}</span>` +
      `</li>`
    );
  }

  // ---- mode switching --------------------------------------------------

  /**
   * Switch the sidebar card between "single" search and "directions" mode.
   *
   * `opts.focus` defaults to true because mode changes are almost always
   * user-initiated (button click, right-click menu) and want keyboard
   * focus in the relevant field. The initial boot call passes false so
   * we don't steal focus from the map on page load.
   */
  function setMode(mode, opts = {}) {
    const focus = opts.focus !== false;
    card.dataset.mode = mode;
    card.querySelectorAll('[data-mode]').forEach((el) => {
      el.hidden = el.dataset.mode !== mode;
    });
    if (mode === 'single') {
      single.syncPlaceholder();
      if (focus) setTimeout(() => single.input.focus(), 0);
    } else if (mode === 'directions') {
      // Defer the focus decision so it reflects any input values the
      // caller sets *after* switching modes (e.g. the right-click
      // context menu flips us in via mmap:route-changed and then fills
      // the From field — we want focus on To, not From).
      if (focus) {
        setTimeout(() => {
          const target = !directions.fromInput.value
            ? directions.fromInput
            : directions.toInput;
          target.focus();
        }, 0);
      }
      directions.sync();
    }
  }

  // ---- single-search mode ----------------------------------------------

  const single = (() => {
    const input = document.getElementById('search-q');
    const list = document.getElementById('search-results');
    const placeEl = document.getElementById('search-placeholder-cycle');
    const wrapEl = document.getElementById('search-input-wrap');

    const PLACEHOLDER_PHRASES = [
      'Find Red Foxes…',
      'Traverse Marist…',
      'Search places…',
      'Where in Hancock am I?',
      'Lower Town vs Upper Town…',
      'Plot your next sprint to class…',
      'The Hudson has opinions…',
      'Lost? Join the club.',
      'Fox dens, cafés, and naps…',
      'Avoid the stairs (good luck)…',
      'Rotunda traffic report…',
      'River views, river moods…',
    ];

    let phraseIdx = 0;
    let cycleTimer = null;
    let currentMatches = [];

    function stopCycle() {
      if (cycleTimer) {
        window.clearInterval(cycleTimer);
        cycleTimer = null;
      }
    }

    function advancePhrase() {
      if (!placeEl) return;
      if (!wrapEl.classList.contains('search-input-wrap--faux-empty')) return;
      placeEl.classList.add('search-placeholder-cycle--exit');
      window.setTimeout(() => {
        if (!wrapEl.classList.contains('search-input-wrap--faux-empty')) {
          placeEl.classList.remove('search-placeholder-cycle--exit');
          return;
        }
        phraseIdx = (phraseIdx + 1) % PLACEHOLDER_PHRASES.length;
        placeEl.textContent = PLACEHOLDER_PHRASES[phraseIdx];
        placeEl.classList.remove('search-placeholder-cycle--exit');
      }, 450);
    }

    function startCycle() {
      if (cycleTimer) return;
      cycleTimer = window.setInterval(advancePhrase, 4800);
    }

    function syncPlaceholder() {
      const q = input.value.trim();
      const focused = document.activeElement === input;
      const showFaux = !q && !focused;
      wrapEl.classList.toggle('search-input-wrap--faux-empty', showFaux);
      if (placeEl) {
        placeEl.classList.toggle('search-placeholder-cycle--off', !showFaux);
        if (showFaux) {
          placeEl.classList.remove('search-placeholder-cycle--exit');
          placeEl.textContent = PLACEHOLDER_PHRASES[phraseIdx % PLACEHOLDER_PHRASES.length];
          startCycle();
        } else {
          stopCycle();
        }
      }
    }

    function closeDropdown() {
      list.hidden = true;
      card.classList.remove('search-card--open');
      input.setAttribute('aria-expanded', 'false');
    }

    function sync() {
      const q = input.value;
      const matches = filterPlaces(q);
      currentMatches = matches;
      input.setAttribute('aria-expanded', matches.length > 0 ? 'true' : 'false');
      if (!q.trim()) {
        list.hidden = true;
        list.innerHTML = '';
        card.classList.remove('search-card--open');
        return;
      }
      if (matches.length === 0) {
        list.innerHTML =
          `<li class="search-result search-result--empty" role="option">${escapeHtml(emptyMessage())}</li>`;
        list.hidden = false;
        card.classList.add('search-card--open');
        return;
      }
      list.innerHTML = matches.map((p, i) => renderResultRow(p, q, i)).join('');
      list.hidden = false;
      card.classList.add('search-card--open');
    }

    function selectPlace(p) {
      if (!p) return;
      const mmap = window.MaristMap;
      if (mmap && mmap.map && Number.isFinite(p.lon) && Number.isFinite(p.lat)) {
        mmap.map.flyTo({
          center: [p.lon, p.lat],
          zoom: Math.max(mmap.map.getZoom(), 18),
          speed: 1.2,
          essential: true,
        });
        new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '22rem' })
          .setLngLat([p.lon, p.lat])
          .setHTML(
            `<strong>${escapeHtml(p.name || '')}</strong>` +
            `<div class="tag">${escapeHtml(p.subtitle || '')}</div>`
          )
          .addTo(mmap.map);
      }
      input.value = p.name || '';
      closeDropdown();
      input.blur();
      syncPlaceholder();
    }

    list.addEventListener('click', (e) => {
      const row = e.target.closest('.search-result');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      if (!Number.isFinite(idx)) return;
      selectPlace(currentMatches[idx]);
    });

    input.addEventListener('input', () => { sync(); syncPlaceholder(); });
    input.addEventListener('focus', () => { sync(); syncPlaceholder(); });
    input.addEventListener('blur', syncPlaceholder);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDropdown();
        input.blur();
        return;
      }
      if (e.key === 'Enter' && currentMatches.length) {
        e.preventDefault();
        selectPlace(currentMatches[0]);
      }
    });

    // Click outside the whole card → close dropdown.
    document.addEventListener('click', (e) => {
      if (!card.contains(e.target)) closeDropdown();
    });

    syncPlaceholder();

    return { input, sync, syncPlaceholder };
  })();

  // ---- directions mode -------------------------------------------------

  const directions = (() => {
    const pane = card.querySelector('[data-mode="directions"]');
    const fromInput = document.getElementById('directions-from');
    const toInput = document.getElementById('directions-to');
    const list = document.getElementById('directions-results');
    const summary = document.getElementById('directions-summary');
    const swapBtn = document.getElementById('directions-swap-btn');
    const gpxBtn = document.getElementById('directions-gpx-btn');
    const clearBtn = document.getElementById('directions-clear-btn');
    const clearFromBtn = document.getElementById('directions-clear-from-btn');
    const clearToBtn = document.getElementById('directions-clear-to-btn');
    const closeBtn = document.getElementById('directions-close-btn');

    /** Which field is currently receiving autocomplete. */
    let active = 'from';

    /** The resolved feature selections, kept in sync with MaristRoute. */
    const selected = { from: null, to: null };
    let currentMatches = [];

    function setActive(which) {
      active = which;
      pane.dataset.active = which;
    }

    function currentInput() {
      return active === 'from' ? fromInput : toInput;
    }

    function closeDropdown() {
      list.hidden = true;
      list.innerHTML = '';
    }

    function sync() {
      const q = currentInput().value;
      const matches = filterPlaces(q);
      currentMatches = matches;
      if (!q.trim()) {
        closeDropdown();
        return;
      }
      if (matches.length === 0) {
        list.innerHTML =
          `<li class="search-result search-result--empty" role="option">${escapeHtml(emptyMessage())}</li>`;
        list.hidden = false;
        return;
      }
      list.innerHTML = matches.map((p, i) => renderResultRow(p, q, i)).join('');
      list.hidden = false;
    }

    function pushSelection(which, place) {
      selected[which] = place;
      const input = which === 'from' ? fromInput : toInput;
      input.value = place ? (place.name || '') : '';
      if (!window.MaristRoute) return;
      const pt = place
        ? { lon: place.lon, lat: place.lat, label: place.name || null }
        : null;
      if (which === 'from') window.MaristRoute.setStart(pt);
      else window.MaristRoute.setEnd(pt);
    }

    function selectPlace(p) {
      if (!p) return;
      pushSelection(active, p);
      closeDropdown();
      // If the other field is empty, advance focus there. If both now
      // have values, blur so the route is the main thing the user sees.
      const other = active === 'from' ? 'to' : 'from';
      if (!selected[other]) {
        setActive(other);
        currentInput().focus();
      } else {
        currentInput().blur();
      }
    }

    list.addEventListener('click', (e) => {
      const row = e.target.closest('.search-result');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      if (!Number.isFinite(idx)) return;
      selectPlace(currentMatches[idx]);
    });

    function bindField(which) {
      const input = which === 'from' ? fromInput : toInput;
      input.addEventListener('focus', () => { setActive(which); sync(); });
      input.addEventListener('input', () => {
        setActive(which);
        // Typing in a field invalidates the previous confirmed selection
        // for that field — but don't fire the route until the user picks
        // a new one, else every keystroke would clear the drawn line.
        selected[which] = null;
        sync();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && currentMatches.length) {
          e.preventDefault();
          selectPlace(currentMatches[0]);
          return;
        }
        if (e.key === 'Escape') {
          closeDropdown();
          input.blur();
        }
      });
    }
    bindField('from');
    bindField('to');

    document.addEventListener('click', (e) => {
      if (!card.contains(e.target)) closeDropdown();
    });

    // ---- endpoint clears ----
    clearFromBtn && clearFromBtn.addEventListener('click', () => {
      pushSelection('from', null);
      setActive('from');
      fromInput.focus();
      closeDropdown();
    });
    clearToBtn && clearToBtn.addEventListener('click', () => {
      pushSelection('to', null);
      setActive('to');
      toInput.focus();
      closeDropdown();
    });

    // ---- overall actions ----
    swapBtn.addEventListener('click', () => {
      if (!window.MaristRoute) return;
      [selected.from, selected.to] = [selected.to, selected.from];
      fromInput.value = selected.from ? (selected.from.name || '') : '';
      toInput.value = selected.to ? (selected.to.name || '') : '';
      window.MaristRoute.swap();
    });
    clearBtn && clearBtn.addEventListener('click', () => {
      selected.from = null;
      selected.to = null;
      fromInput.value = '';
      toInput.value = '';
      closeDropdown();
      if (window.MaristRoute) window.MaristRoute.clear();
      setActive('from');
      fromInput.focus();
    });
    gpxBtn.addEventListener('click', () => {
      if (window.MaristRoute) window.MaristRoute.exportGpx();
    });
    closeBtn.addEventListener('click', () => {
      setMode('single');
    });

    // ---- react to route state changes (event from routing.js) ----
    document.addEventListener('mmap:route-changed', (ev) => {
      const detail = ev.detail || {};

      // Anyone (e.g. the right-click context menu, or a future "directions
      // to here" popup button) can call MaristRoute.setStart/setEnd. When
      // they do while we're in single-search mode, flip into directions
      // mode so the user sees the synchronized From/To fields and the
      // summary/Export controls instead of just a line on the map.
      const hasAnyEndpoint = !!(detail.from || detail.to);
      if (hasAnyEndpoint && card.dataset.mode !== 'directions') {
        setMode('directions');
      }

      // Don't clobber in-progress typing if an input has focus and the
      // user hasn't yet confirmed a selection for that field.
      const activeEl = document.activeElement;

      // Keep input text aligned with the route's labels when the user
      // isn't actively typing.
      if (detail.from && activeEl !== fromInput) {
        fromInput.value = detail.from.label || fromInput.value || `${detail.from.lat.toFixed(5)}, ${detail.from.lon.toFixed(5)}`;
      }
      if (!detail.from && activeEl !== fromInput) {
        fromInput.value = '';
      }
      if (detail.to && activeEl !== toInput) {
        toInput.value = detail.to.label || toInput.value || `${detail.to.lat.toFixed(5)}, ${detail.to.lon.toFixed(5)}`;
      }
      if (!detail.to && activeEl !== toInput) {
        toInput.value = '';
      }

      // Summary + button states.
      swapBtn.disabled = !(detail.from && detail.to);
      gpxBtn.disabled = !detail.route;
      if (detail.status === 'loading') {
        summary.hidden = false;
        summary.textContent = 'Routing…';
      } else if (detail.status === 'error') {
        summary.hidden = false;
        summary.textContent = `No route: ${detail.error || 'unknown error'}`;
      } else if (detail.route) {
        summary.hidden = false;
        summary.textContent =
          `${fmtDistance(detail.route.distance_m)} · ${fmtDuration(detail.route.duration_s)}`;
      } else {
        summary.hidden = true;
        summary.textContent = '';
      }
    });

    return {
      fromInput, toInput,
      sync,
      setActive,
    };
  })();

  function isDirectionsMode() {
    return card.dataset.mode === 'directions';
  }

  // ---- mode toggle buttons --------------------------------------------

  const enterBtn = document.getElementById('directions-enter-btn');
  if (enterBtn) enterBtn.addEventListener('click', () => setMode('directions'));

  // The HTML already starts with data-mode="single"; re-assert the
  // state without focusing so we don't steal focus from the map on load.
  setMode('single', { focus: false });

  // ---- formatting ------------------------------------------------------

  function fmtDistance(m) {
    if (!Number.isFinite(m)) return '';
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(2)} km`;
  }

  function fmtDuration(s) {
    if (!Number.isFinite(s)) return '';
    const mins = Math.max(1, Math.round(s / 60));
    if (mins < 60) return `${mins} min walk`;
    const h = Math.floor(mins / 60);
    const r = mins % 60;
    return r ? `${h} h ${r} min walk` : `${h} h walk`;
  }
})();
