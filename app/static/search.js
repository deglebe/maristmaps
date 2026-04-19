/* Sidebar controller for the search card.
 *
 * Two modes share the same card DOM:
 *
 *   single      One search box. Matches across outdoor features
 *               (buildings / POIs / paths from /api/features) AND indoor
 *               targets (rooms / entrances / buildings from
 *               /api/indoor/index). Buildings render with their rooms
 *               inline underneath — Google-Maps style: type "hancock" and
 *               you get Hancock on top then all its rooms; type "3194"
 *               and you get every 3194 across the campus.
 *
 *   directions  Two outdoor fields (From / To) that populate
 *               MaristRoute.setStart/setEnd. The indoor per-side pickers
 *               live in their own inputs and are owned by indoor.js.
 *
 * We coordinate with other modules by DOM events:
 *   - MaristRoute emits `mmap:route-changed` → we reflect the summary +
 *     button state; auto-flip to directions mode if an endpoint was set
 *     externally (e.g. the right-click "directions from here" menu).
 */
(function () {
  const card = document.getElementById('search-card');
  if (!card) {
    console.warn('[search] #search-card missing; sidebar disabled');
    return;
  }

  // ---- small utilities -------------------------------------------------

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function tokenize(q) {
    return String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  function highlight(text, queryTokens) {
    const s = String(text ?? '');
    if (!queryTokens.length) return escapeHtml(s);
    // Match the longest token that appears. Good enough visually — we
    // don't try to highlight every occurrence of every token.
    const lower = s.toLowerCase();
    const ordered = queryTokens.slice().sort((a, b) => b.length - a.length);
    for (const qt of ordered) {
      const idx = lower.indexOf(qt);
      if (idx >= 0) {
        return (
          escapeHtml(s.slice(0, idx))
          + '<strong>' + escapeHtml(s.slice(idx, idx + qt.length)) + '</strong>'
          + escapeHtml(s.slice(idx + qt.length))
        );
      }
    }
    return escapeHtml(s);
  }

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

  // Rooms / entrances are ambiguous on their own ("3194" could be in
  // several buildings), so we prefix the building name for a committed
  // pick. Buildings and outdoor features (POIs / paths) already carry
  // a full label in `name`.
  function committedLabel(item) {
    if (!item) return '';
    if ((item.kind === 'room' || item.kind === 'entrance') && item.building) {
      return `${item.building} ${item.name || ''}`.trim();
    }
    return item.name || '';
  }

  // ---- data model ------------------------------------------------------
  //
  // We build ONE flat `ITEMS` list out of two endpoints. Each item has:
  //   id       stable dedup key
  //   kind     'building' | 'poi' | 'path' | 'room' | 'entrance'
  //   name     primary display label
  //   subtitle secondary display label
  //   building string | null   (set on room/entrance/building)
  //   lon,lat  numbers (for flyTo / popup)
  //   tokens   lowercase strings used by the matcher
  //   endpoint opaque payload accepted by MaristRoute (indoor targets only)

  let ITEMS = [];
  // Buildings name -> array of room items in that building. Used to
  // render child rows under a matched building header.
  let ROOMS_BY_BUILDING = new Map();
  let dataReady = false;
  let dataError = null;

  function buildingKey(name) {
    return String(name || '').trim().toLowerCase();
  }

  function normalizeFeature(f) {
    const name = f.name || '';
    const tokens = [];
    const lowerName = name.toLowerCase();
    if (lowerName) {
      tokens.push(lowerName);
      for (const w of lowerName.split(/\s+/).filter(Boolean)) tokens.push(w);
    }
    if (f.subtitle) tokens.push(String(f.subtitle).toLowerCase());
    if (f.kind) tokens.push(String(f.kind).toLowerCase());
    return {
      id: `feat/${f.id}`,
      kind: f.kind || 'poi',
      name,
      subtitle: f.subtitle || '',
      building: f.kind === 'building' ? name : null,
      lon: Number(f.lon),
      lat: Number(f.lat),
      tokens,
      endpoint: null,
    };
  }

  function normalizeTarget(t) {
    const kind = t.kind || 'room';
    let idKey;
    if (kind === 'building') idKey = `bld/${buildingKey(t.building || t.label)}`;
    else if (kind === 'entrance') idKey = `ent/${buildingKey(t.building)}/${t.room || t.label}`;
    else idKey = `room/${buildingKey(t.building)}/${t.room || t.label}`;
    return {
      id: `indoor/${idKey}`,
      kind,
      name: t.label || '',
      subtitle: t.sublabel || '',
      building: t.building || null,
      floor: t.floor || null,
      lon: Number(t.lon),
      lat: Number(t.lat),
      tokens: Array.isArray(t.tokens) ? t.tokens.slice() : [],
      endpoint: t.endpoint || null,
    };
  }

  function hasCoords(it) {
    return Number.isFinite(it.lon) && Number.isFinite(it.lat);
  }

  async function loadData() {
    const [featRes, idxRes] = await Promise.allSettled([
      fetch('/api/features', { headers: { Accept: 'application/json' } }),
      fetch('/api/indoor/index', { headers: { Accept: 'application/json' } }),
    ]);

    const items = [];
    const seenFeatureBuildings = new Set();

    if (featRes.status === 'fulfilled' && featRes.value.ok) {
      try {
        const data = await featRes.value.json();
        for (const f of (data.features || [])) {
          const it = normalizeFeature(f);
          if (!hasCoords(it)) continue;
          items.push(it);
          if (it.kind === 'building' && it.name) {
            seenFeatureBuildings.add(buildingKey(it.name));
          }
        }
      } catch (err) {
        console.warn('[search] /api/features parse failed:', err);
      }
    } else {
      console.warn('[search] /api/features fetch failed');
    }

    const roomsByBuilding = new Map();

    if (idxRes.status === 'fulfilled' && idxRes.value.ok) {
      try {
        const data = await idxRes.value.json();
        for (const t of (data.targets || [])) {
          const it = normalizeTarget(t);
          if (it.kind === 'building') {
            // Only add a target-building if /api/features didn't already
            // provide it. This avoids two "Hancock" rows that differ
            // only in subtitle, and prefers the outdoor centroid.
            if (seenFeatureBuildings.has(buildingKey(it.name))) continue;
            if (!hasCoords(it)) continue;
            items.push(it);
            continue;
          }
          if (!hasCoords(it)) continue;
          items.push(it);
          if (it.kind === 'room' && it.building) {
            const key = buildingKey(it.building);
            if (!roomsByBuilding.has(key)) roomsByBuilding.set(key, []);
            roomsByBuilding.get(key).push(it);
          }
        }
      } catch (err) {
        console.warn('[search] /api/indoor/index parse failed:', err);
      }
    } else {
      console.warn('[search] /api/indoor/index fetch failed');
    }

    // Stable natural-ish sort for children: numeric room codes first
    // (001, 1021, ...), then lexicographic for the rest.
    const roomCmp = (a, b) => {
      const an = Number((a.name.match(/\d+/) || [])[0]);
      const bn = Number((b.name.match(/\d+/) || [])[0]);
      const aHas = Number.isFinite(an);
      const bHas = Number.isFinite(bn);
      if (aHas && bHas && an !== bn) return an - bn;
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      return a.name.localeCompare(b.name);
    };
    for (const list of roomsByBuilding.values()) list.sort(roomCmp);

    ITEMS = items;
    ROOMS_BY_BUILDING = roomsByBuilding;
    dataReady = true;
    console.log(
      `[search] loaded ${items.length} items `
      + `(buildings: ${items.filter((i) => i.kind === 'building').length}, `
      + `rooms: ${items.filter((i) => i.kind === 'room').length})`,
    );

    // Re-render any open dropdowns now that data arrived.
    if (single.input.value.trim()) single.sync();
    if (isDirectionsMode()) directions.sync();
  }

  // ---- matcher ---------------------------------------------------------

  // Per-token score: exact=6, prefix=5, substring=2. All tokens in the
  // query must hit somewhere, else the item is excluded. Matches
  // indoor.js's scoreTarget fairly closely so the two feel consistent.
  function scoreItem(item, qTokens) {
    if (!qTokens.length) return -1;
    let total = 0;
    const tgtTokens = item.tokens;
    for (const qt of qTokens) {
      let best = 0;
      for (const tt of tgtTokens) {
        if (tt === qt) { best = 6; break; }
        if (tt.startsWith(qt)) best = Math.max(best, 5);
        else if (tt.includes(qt)) best = Math.max(best, 2);
      }
      if (best === 0) return -1;
      total += best;
    }
    // Tiebreak: prefer "bigger" kinds first so a building edges out a
    // path of the same name.
    const kindBoost = ({
      building: 0.6, room: 0.3, entrance: 0.15, poi: 0.1, path: 0,
    }[item.kind] || 0);
    return total + kindBoost;
  }

  function search(q, limit = 40) {
    const toks = tokenize(q);
    if (!toks.length) return { tokens: toks, matches: [] };
    const scored = [];
    for (const it of ITEMS) {
      const s = scoreItem(it, toks);
      if (s > 0) scored.push({ it, s });
    }
    scored.sort((a, b) =>
      b.s - a.s
      || (a.it.name || '').localeCompare(b.it.name || '')
    );
    return { tokens: toks, matches: scored.slice(0, limit).map((x) => x.it) };
  }

  // ---- rendering helpers ----------------------------------------------

  const KIND_LABEL = {
    building: 'Building', path: 'Path', poi: 'Place',
    room: 'Room', entrance: 'Entrance',
  };

  function renderRow(item, qTokens, rowIdx, opts = {}) {
    const kind = item.kind || 'poi';
    const kindClass = `search-result__kind--${kind}`;
    const kindLabel = KIND_LABEL[kind] || 'Place';
    const extraCls = opts.child ? ' search-result--child' : '';
    return (
      `<li class="search-result${extraCls}" role="option" ` +
      `id="search-opt-${rowIdx}" tabindex="-1" data-idx="${rowIdx}">` +
      `<span class="search-result__icon search-result__icon--${kind}" aria-hidden="true"></span>` +
      `<span class="search-result__text">` +
      `<span class="search-result__title">${highlight(item.name || '', qTokens)}</span>` +
      `<span class="search-result__sub">${escapeHtml(item.subtitle || '')}</span>` +
      `</span>` +
      `<span class="search-result__kind ${kindClass}">${escapeHtml(kindLabel)}</span>` +
      `</li>`
    );
  }

  function emptyMessage() {
    if (!dataReady && !dataError) return 'Loading campus data…';
    if (dataError) return 'Could not load campus data';
    return 'No matching places';
  }

  // Arrange flat matches into a visually-grouped list:
  //   - If a match is a building, inline its rooms as children below.
  //   - Non-building matches render as regular rows.
  //   - Each item appears at most once.
  // Returns { rows, order } where `rows` is the HTML string and
  // `order` is a flat array of items mapping rowIdx -> item (so the
  // click/keyboard handlers can resolve a click to an item).
  function buildGroupedRows(matches, qTokens, opts = {}) {
    const rows = [];
    const order = [];
    const seen = new Set();
    const CHILDREN_MAX = opts.childrenMax ?? 30;

    const push = (item, { child = false } = {}) => {
      const idx = order.length;
      order.push(item);
      rows.push(renderRow(item, qTokens, idx, { child }));
      seen.add(item.id);
    };

    for (const it of matches) {
      if (seen.has(it.id)) continue;
      push(it);
      if (it.kind === 'building' && it.name) {
        const key = buildingKey(it.name);
        const roomList = ROOMS_BY_BUILDING.get(key) || [];
        let shown = 0;
        for (const r of roomList) {
          if (seen.has(r.id)) continue;
          if (shown >= CHILDREN_MAX) break;
          push(r, { child: true });
          shown++;
        }
        if (roomList.length > shown) {
          rows.push(
            `<li class="search-result search-result--more" aria-hidden="true">` +
            `+${roomList.length - shown} more rooms — refine your search</li>`
          );
          // Decoy row; no entry in `order` so it isn't clickable.
        }
      }
    }
    return { html: rows.join(''), order };
  }

  // ---- mode plumbing ---------------------------------------------------
  //
  // Both modes need to tell each other when to open/close. We stash the
  // current mode in card.dataset.mode (which also drives CSS). Call
  // setMode('single'|'directions', {focus}) to flip.

  function setMode(mode, opts = {}) {
    const focus = opts.focus !== false;
    card.dataset.mode = mode;
    const singlePane = card.querySelector('[data-mode="single"]');
    const directionsPane = card.querySelector('[data-mode="directions"]');
    if (singlePane) singlePane.hidden = (mode !== 'single');
    if (directionsPane) directionsPane.hidden = (mode !== 'directions');
    if (mode === 'single') {
      single.closeDropdown();
      single.syncPlaceholderOverlay();
      if (focus) setTimeout(() => single.input.focus(), 0);
    } else if (mode === 'directions') {
      single.closeDropdown();
      // Pre-fill the start with the user's live GPS so they only have
      // to pick a destination. No-op if a start is already set or if
      // we don't yet have a GPS fix.
      if (window.MaristRoute && typeof window.MaristRoute.useGpsAsStartIfEmpty === 'function') {
        window.MaristRoute.useGpsAsStartIfEmpty();
      }
      if (focus) {
        // Defer so any pending mmap:route-changed event has populated
        // selected state before we pick a side.
        setTimeout(() => {
          const which = directions.firstEmptySide();
          const target = which === 'from'
            ? directions.fromInput
            : directions.toInput;
          target.focus();
        }, 0);
      }
      directions.sync();
    }
  }

  function isDirectionsMode() {
    return card.dataset.mode === 'directions';
  }

  // ---- single mode -----------------------------------------------------

  const single = (() => {
    const input = document.getElementById('search-q');
    const list = document.getElementById('search-results');
    const wrapEl = document.getElementById('search-input-wrap');
    const placeEl = document.getElementById('search-placeholder-cycle');
    const iconBtn = document.getElementById('search-icon-btn');

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

    let currentOrder = [];

    function syncPlaceholderOverlay() {
      if (!wrapEl || !placeEl) return;
      const q = input.value.trim();
      const focused = document.activeElement === input;
      const showFaux = !q && !focused && card.dataset.mode === 'single';
      wrapEl.classList.toggle('search-input-wrap--faux-empty', showFaux);
      placeEl.classList.toggle('search-placeholder-cycle--off', !showFaux);
      if (showFaux) {
        placeEl.classList.remove('search-placeholder-cycle--exit');
        placeEl.textContent = PLACEHOLDER_PHRASES[phraseIdx % PLACEHOLDER_PHRASES.length];
        startPlaceholderCycle();
      } else {
        stopPlaceholderCycle();
      }
    }

    function startPlaceholderCycle() {
      if (cycleTimer) return;
      cycleTimer = window.setInterval(() => {
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
      }, 4800);
    }

    function stopPlaceholderCycle() {
      if (cycleTimer) {
        window.clearInterval(cycleTimer);
        cycleTimer = null;
      }
    }

    function closeDropdown() {
      list.hidden = true;
      list.innerHTML = '';
      card.classList.remove('search-card--open');
      input.setAttribute('aria-expanded', 'false');
      currentOrder = [];
    }

    function openEmpty() {
      list.innerHTML =
        `<li class="search-result search-result--empty" role="option">${escapeHtml(emptyMessage())}</li>`;
      list.hidden = false;
      card.classList.add('search-card--open');
      input.setAttribute('aria-expanded', 'false');
    }

    function sync() {
      const q = input.value;
      if (!q.trim()) {
        closeDropdown();
        return;
      }
      const { tokens, matches } = search(q);
      if (!matches.length) {
        openEmpty();
        currentOrder = [];
        return;
      }
      const { html, order } = buildGroupedRows(matches, tokens);
      list.innerHTML = html;
      list.hidden = false;
      card.classList.add('search-card--open');
      input.setAttribute('aria-expanded', 'true');
      currentOrder = order;
    }

    function selectItem(item) {
      if (!item) return;
      const mmap = window.MaristMap;
      if (mmap && mmap.map && hasCoords(item)) {
        mmap.map.flyTo({
          center: [item.lon, item.lat],
          zoom: Math.max(mmap.map.getZoom(), 18),
          speed: 1.2,
          essential: true,
        });
        const popup = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: true,
          maxWidth: '22rem',
        })
          .setLngLat([item.lon, item.lat])
          .setHTML(
            `<strong>${escapeHtml(item.name || '')}</strong>` +
            `<div class="tag">${escapeHtml(item.subtitle || '')}</div>` +
            `<div class="popup-actions">` +
            `  <button type="button" class="popup-action popup-action--to" data-action="directions">Directions</button>` +
            `</div>`
          )
          .addTo(mmap.map);
        const root = popup.getElement();
        if (root) {
          root.addEventListener('click', (ev) => {
            const btn = ev.target.closest('button[data-action="directions"]');
            if (!btn) return;
            ev.preventDefault();
            const route = window.MaristRoute;
            if (!route) return;
            route.setEnd({ lon: item.lon, lat: item.lat, label: item.name || null });
            popup.remove();
          });
        }
      }
      input.value = committedLabel(item);
      closeDropdown();
      input.blur();
    }

    // ---- events ----
    input.addEventListener('input', () => { sync(); syncPlaceholderOverlay(); });
    input.addEventListener('focus', () => { sync(); syncPlaceholderOverlay(); });
    input.addEventListener('blur', () => {
      // Tiny delay so a click on a result still registers before we hide.
      setTimeout(syncPlaceholderOverlay, 0);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDropdown();
        input.blur();
        return;
      }
      if (e.key === 'Enter' && currentOrder.length) {
        e.preventDefault();
        selectItem(currentOrder[0]);
      }
    });

    list.addEventListener('mousedown', (e) => {
      // mousedown (not click) so the input's `blur` handler doesn't fire
      // first and close the dropdown before the click lands.
      const row = e.target.closest('.search-result');
      if (!row || row.classList.contains('search-result--empty')
        || row.classList.contains('search-result--more')) return;
      const idx = Number(row.dataset.idx);
      if (!Number.isFinite(idx)) return;
      e.preventDefault();
      selectItem(currentOrder[idx]);
    });

    if (iconBtn) {
      iconBtn.addEventListener('click', () => {
        input.focus();
        sync();
      });
    }

    document.addEventListener('click', (e) => {
      if (!card.contains(e.target)) closeDropdown();
    });

    return { input, sync, closeDropdown, syncPlaceholderOverlay };
  })();

  // ---- directions mode -------------------------------------------------
  //
  // One input per side. Each side holds a `committed` Item (or null).
  // Rules:
  //   - committed=null  → open autocomplete across all kinds (grouped).
  //   - committed=a building that has rooms → SCOPED. We render a
  //       "Hancock ✕" chip in the field and the input becomes a
  //       narrow-filter that searches only rooms+entrances inside that
  //       building. Clearing the chip (✕, backspace when empty, or the
  //       field clear button) drops back to free state.
  //   - committed=anything else (outdoor POI/path, room, entrance,
  //       indoorless building) → input shows the label; typing clears
  //       the commit and re-opens free search.
  //
  // The committed pick is also what drives routing: buildings with
  // indoor data route via MaristIndoor as kind=building (best entrance);
  // rooms/entrances route via MaristIndoor; everything else routes via
  // MaristRoute with lon/lat.

  const directions = (() => {
    const pane = card.querySelector('[data-mode="directions"]');
    const list = document.getElementById('directions-results');
    const summary = document.getElementById('directions-summary');
    const swapBtn = document.getElementById('directions-swap-btn');
    const gpxBtn = document.getElementById('directions-gpx-btn');
    const clearBtn = document.getElementById('directions-clear-btn');
    const closeBtn = document.getElementById('directions-close-btn');

    function fieldFor(side) {
      return {
        field: document.querySelector(`.directions-field[data-side="${side}"]`),
        input: document.getElementById(`directions-${side}`),
        clear: document.getElementById(`directions-clear-${side}-btn`),
        scope: document.getElementById(`directions-scope-${side}`),
      };
    }
    const ui = { from: fieldFor('from'), to: fieldFor('to') };

    /** Which field is receiving autocomplete right now. */
    let active = 'from';
    /** Final pick per side (what gets routed). */
    const selected = { from: null, to: null };
    /** Rows currently rendered in the shared dropdown. */
    let currentOrder = [];

    const PLACEHOLDER_FREE = {
      from: 'Choose starting point…',
      to: 'Choose destination…',
    };
    const PLACEHOLDER_SCOPED = 'Room or entrance…';

    function setActive(which) {
      active = which;
      if (pane) pane.dataset.active = which;
    }
    function otherSide(which) {
      return which === 'from' ? 'to' : 'from';
    }
    function currentInput() {
      return ui[active].input;
    }

    // ---- scope helpers --------------------------------------------------

    function canScope(item) {
      if (!item || item.kind !== 'building') return false;
      const children = ROOMS_BY_BUILDING.get(buildingKey(item.name));
      return !!(children && children.length);
    }

    function isScoped(side) {
      return canScope(selected[side]);
    }

    function isIndoorCommit(item) {
      if (!item) return false;
      if (item.kind === 'room' || item.kind === 'entrance') return true;
      if (item.kind === 'building' && ROOMS_BY_BUILDING.has(buildingKey(item.name))) {
        return true;
      }
      return false;
    }

    // ---- UI refresh ----------------------------------------------------

    function refreshFieldUI(side) {
      const { input, scope } = ui[side];
      const item = selected[side];
      input.placeholder = PLACEHOLDER_FREE[side];
      if (scope) {
        scope.hidden = true;
        const labelEl = scope.querySelector('.directions-scope__label');
        if (labelEl) labelEl.textContent = '';
      }
      if (!item) {
        input.value = '';
        return;
      }
      if (canScope(item)) {
        if (scope) {
          scope.hidden = false;
          const labelEl = scope.querySelector('.directions-scope__label');
          if (labelEl) labelEl.textContent = item.name || '';
        }
        input.value = '';
        input.placeholder = PLACEHOLDER_SCOPED;
      } else {
        input.value = committedLabel(item);
      }
    }

    // ---- routing propagation -------------------------------------------

    function pushToRouting(side, item) {
      // Clear whichever leg isn't relevant first so the two state
      // machines don't "double-commit" on the same side.
      if (!item) {
        if (window.MaristIndoor) window.MaristIndoor.setSide(side, null);
        if (window.MaristRoute) {
          if (side === 'from') window.MaristRoute.setStart(null);
          else window.MaristRoute.setEnd(null);
        }
        return;
      }
      if (isIndoorCommit(item)) {
        if (window.MaristRoute) {
          if (side === 'from') window.MaristRoute.setStart(null);
          else window.MaristRoute.setEnd(null);
        }
        if (window.MaristIndoor) {
          // Hand setSide a real target when we have one (rooms /
          // entrances come straight from list_targets). Buildings from
          // /api/features build a bare endpoint — MaristIndoor's
          // setSide will promote to a full target when available, or
          // forward the bare payload otherwise.
          const tgt = {
            endpoint: item.endpoint
              || { kind: 'building', building: item.building || item.name },
            label: item.name,
            kind: item.kind,
            building: item.building || item.name,
          };
          window.MaristIndoor.setSide(side, tgt);
        }
        return;
      }
      if (window.MaristIndoor) window.MaristIndoor.setSide(side, null);
      if (window.MaristRoute) {
        const pt = { lon: item.lon, lat: item.lat, label: item.name || null };
        if (side === 'from') window.MaristRoute.setStart(pt);
        else window.MaristRoute.setEnd(pt);
      }
    }

    function commit(side, item) {
      selected[side] = item || null;
      refreshFieldUI(side);
      pushToRouting(side, item);
    }

    // Drop a non-scoping committed pick without touching the user's
    // currently-typed input value. Used by the `input` handler: the
    // user's keystroke is already sitting in input.value and we must
    // not clear it the way commit(null) would.
    function invalidateCommit(side) {
      selected[side] = null;
      const { scope } = ui[side];
      if (scope) scope.hidden = true;
      pushToRouting(side, null);
    }

    // ---- dropdown ------------------------------------------------------

    function closeDropdown() {
      if (!list) return;
      list.hidden = true;
      list.innerHTML = '';
      currentOrder = [];
    }

    function renderMatches(matches, tokens, opts = {}) {
      if (!list) return;
      if (!matches.length) {
        list.innerHTML =
          `<li class="search-result search-result--empty" role="option">${escapeHtml(emptyMessage())}</li>`;
        list.hidden = false;
        currentOrder = [];
        return;
      }
      const grouped = buildGroupedRows(matches, tokens, opts);
      list.innerHTML = grouped.html;
      list.hidden = false;
      currentOrder = grouped.order;
    }

    function syncScoped() {
      const { input } = ui[active];
      const building = selected[active];
      const key = buildingKey(building.name);
      const rooms = ROOMS_BY_BUILDING.get(key) || [];
      const tokens = tokenize(input.value);
      let matches;
      if (!tokens.length) {
        // Empty scoped query: browse mode. Show the whole room list.
        matches = rooms.slice(0, 80);
      } else {
        const scored = [];
        for (const r of rooms) {
          const s = scoreItem(r, tokens);
          if (s > 0) scored.push({ r, s });
        }
        // Also include matching entrances for the same building, since
        // they're valid route endpoints too and there aren't many.
        for (const it of ITEMS) {
          if (it.kind !== 'entrance') continue;
          if (buildingKey(it.building) !== key) continue;
          const s = scoreItem(it, tokens);
          if (s > 0) scored.push({ r: it, s });
        }
        scored.sort((a, b) =>
          b.s - a.s
          || (a.r.name || '').localeCompare(b.r.name || '')
        );
        matches = scored.slice(0, 40).map((x) => x.r);
      }
      renderMatches(matches, tokens, { childrenMax: 0 });
    }

    function syncFree() {
      const q = ui[active].input.value;
      if (!q.trim()) {
        closeDropdown();
        return;
      }
      const { tokens, matches } = search(q);
      renderMatches(matches, tokens);
    }

    function sync() {
      if (isScoped(active)) syncScoped();
      else syncFree();
    }

    // ---- selection -----------------------------------------------------

    function pick(item) {
      if (!item) return;
      const side = active;
      // If the user picked the scoped building from within its own
      // dropdown (shouldn't normally appear, but just in case), treat
      // it as a no-op.
      if (isScoped(side) && item.id === selected[side].id) {
        closeDropdown();
        return;
      }
      if (canScope(item)) {
        // Enter scope: keep focus here so the user can type a room.
        commit(side, item);
        closeDropdown();
        ui[side].input.focus();
        sync();
        return;
      }
      commit(side, item);
      closeDropdown();
      // Advance to the other side if empty; otherwise blur so the map
      // route is the thing in focus.
      const other = otherSide(side);
      if (!selected[other]) {
        setActive(other);
        currentInput().focus();
      } else {
        ui[side].input.blur();
      }
    }

    // ---- event wiring --------------------------------------------------

    function bindField(side) {
      const { input, clear, scope } = ui[side];

      input.addEventListener('focus', () => {
        setActive(side);
        sync();
      });
      input.addEventListener('input', () => {
        setActive(side);
        // Typing after a non-scope commit invalidates it so the
        // dropdown opens on the typed query, not on the stale label.
        // Scoped commits stay — typing narrows rather than invalidates.
        if (selected[side] && !isScoped(side)) {
          invalidateCommit(side);
        }
        sync();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (currentOrder.length) {
            e.preventDefault();
            pick(currentOrder[0]);
          }
          return;
        }
        if (e.key === 'Escape') {
          closeDropdown();
          input.blur();
          return;
        }
        if (e.key === 'Backspace' && isScoped(side) && input.value === '') {
          // Drop the scope chip when the user backspaces into it.
          e.preventDefault();
          commit(side, null);
          sync();
        }
      });

      if (scope) {
        const chipClear = scope.querySelector('.directions-scope__clear');
        if (chipClear) {
          // mousedown so the input doesn't blur-and-close first.
          chipClear.addEventListener('mousedown', (e) => {
            e.preventDefault();
            setActive(side);
            commit(side, null);
            input.focus();
            sync();
          });
        }
      }

      if (clear) {
        clear.addEventListener('mousedown', (e) => {
          e.preventDefault();
          setActive(side);
          commit(side, null);
          input.focus();
          closeDropdown();
        });
      }
    }

    bindField('from');
    bindField('to');

    if (list) {
      list.addEventListener('mousedown', (e) => {
        const row = e.target.closest('.search-result');
        if (!row || row.classList.contains('search-result--empty')
          || row.classList.contains('search-result--more')) return;
        const idx = Number(row.dataset.idx);
        if (!Number.isFinite(idx)) return;
        e.preventDefault();
        pick(currentOrder[idx]);
      });
    }

    document.addEventListener('click', (e) => {
      if (!card.contains(e.target)) closeDropdown();
    });

    // ---- overall actions -----------------------------------------------

    if (swapBtn) {
      swapBtn.addEventListener('click', () => {
        const a = selected.from, b = selected.to;
        selected.from = b;
        selected.to = a;
        refreshFieldUI('from');
        refreshFieldUI('to');
        pushToRouting('from', selected.from);
        pushToRouting('to', selected.to);
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        commit('from', null);
        commit('to', null);
        closeDropdown();
        if (window.MaristRoute) window.MaristRoute.clear();
        setActive('from');
        ui.from.input.focus();
      });
    }
    if (gpxBtn) {
      gpxBtn.addEventListener('click', () => {
        if (window.MaristRoute) window.MaristRoute.exportGpx();
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        commit('from', null);
        commit('to', null);
        closeDropdown();
        if (window.MaristRoute) window.MaristRoute.clear();
        setMode('single');
      });
    }

    // ---- react to route state changes (event from routing.js) ----------

    document.addEventListener('mmap:route-changed', (ev) => {
      const detail = ev.detail || {};

      // An external source (e.g. the right-click "directions from here"
      // menu) can call MaristRoute.setStart/setEnd directly. When that
      // happens while we're in single mode, flip into directions.
      const hasAnyEndpoint = !!(detail.from || detail.to);
      if (hasAnyEndpoint && card.dataset.mode !== 'directions') {
        setMode('directions', { focus: false });
      }

      // If routing.js got an outdoor endpoint we didn't already know
      // about (right-click menu path), synthesize a minimal Item so the
      // field shows the right label.
      for (const side of ['from', 'to']) {
        const ep = detail[side];
        if (!ep) {
          // Only clear UI if we hadn't set an indoor-only commit on
          // this side. Otherwise detail[side] reflects outdoor-only
          // state and we shouldn't wipe the chip.
          if (selected[side] && !isIndoorCommit(selected[side])) {
            selected[side] = null;
            refreshFieldUI(side);
          }
          continue;
        }
        if (!selected[side] || (
          !isIndoorCommit(selected[side])
          && (selected[side].lon !== ep.lon || selected[side].lat !== ep.lat)
        )) {
          selected[side] = {
            id: `ext/${side}/${ep.lat.toFixed(6)},${ep.lon.toFixed(6)}`,
            kind: 'poi',
            name: ep.label || `${ep.lat.toFixed(5)}, ${ep.lon.toFixed(5)}`,
            subtitle: 'Pinned location',
            lon: ep.lon,
            lat: ep.lat,
            tokens: [],
            endpoint: null,
          };
          refreshFieldUI(side);
        }
      }

      // Summary + button states.
      if (swapBtn) swapBtn.disabled = !(selected.from && selected.to);
      if (gpxBtn) gpxBtn.disabled = !detail.route;
      if (!summary) return;
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

    // Initial placeholders so the fields read correctly on first paint.
    refreshFieldUI('from');
    refreshFieldUI('to');

    return {
      get fromInput() { return ui.from.input; },
      get toInput() { return ui.to.input; },
      firstEmptySide() { return selected.from ? 'to' : 'from'; },
      sync,
      closeDropdown,
    };
  })();

  // ---- mode toggle buttons --------------------------------------------

  const enterBtn = document.getElementById('directions-enter-btn');
  if (enterBtn) enterBtn.addEventListener('click', () => setMode('directions'));

  // The HTML starts with data-mode="single"; re-assert without stealing
  // focus from the map on load.
  setMode('single', { focus: false });

  // ---- kick off data load ----------------------------------------------

  function buildAgentLocationPayload() {
    const out = {};
    const snap = window.MaristRoute && window.MaristRoute.snapshot;
    if (snap && snap.from && Number.isFinite(snap.from.lon) && Number.isFinite(snap.from.lat)) {
      out.from_lon = snap.from.lon;
      out.from_lat = snap.from.lat;
      if (snap.from.label) out.from_label = snap.from.label;
      return out;
    }
    const geo = window.MaristGeo && window.MaristGeo.getLast && window.MaristGeo.getLast();
    if (geo && Number.isFinite(geo.lon) && Number.isFinite(geo.lat)) {
      out.from_lon = geo.lon;
      out.from_lat = geo.lat;
      out.from_label = 'Your location';
      return out;
    }
    const mmap = window.MaristMap;
    if (mmap && mmap.map) {
      const c = mmap.map.getCenter();
      out.from_lon = c.lng;
      out.from_lat = c.lat;
      out.from_label = 'Map view center';
    }
    return out;
  }

  async function invokeCampusAgent(message) {
    const body = { message, ...buildAgentLocationPayload() };
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || `HTTP ${res.status}`);
    }
    return res.json();
  }

  function playAgentAudio(b64, mime, onEnded) {
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      if (typeof onEnded === 'function') onEnded();
    };
    if (!b64) { fire(); return; }
    const url = `data:${mime || 'audio/mpeg'};base64,${b64}`;
    const a = new Audio(url);
    a.addEventListener('ended', fire);
    a.addEventListener('error', fire);
    a.play().catch((err) => {
      console.warn('[search] audio play failed', err);
      fire();
    });
  }

  const MAX_CLARIFICATION_MIC_ROUNDS = 16;
  let clarificationMicRounds = 0;
  let agentInFlight = false;
  let voiceCaptureActive = false;

  function handleAgentPipelineResult(agent) {
    if (agent.reply) {
      document.dispatchEvent(new CustomEvent('mmap:agent-reply', {
        detail: {
          reply: agent.reply,
          navigated: !!agent.navigated,
          response_code: agent.response_code,
          reopen_mic: !!agent.reopen_mic,
        },
      }));
    }
    if (agent.navigated && agent.route && window.MaristRoute) {
      window.MaristRoute.setRouteFromServer(agent.route);
      setMode('directions');
      clarificationMicRounds = 0;
    }
    const reopen = agent.reopen_mic === true
      || agent.response_code === 'CLARIFICATION_PENDING'
      || (agent.response_code_numeric === 1);
    const afterPlayback = () => {
      if (agent.navigated) return;
      if (!reopen) {
        clarificationMicRounds = 0;
        return;
      }
      if (clarificationMicRounds >= MAX_CLARIFICATION_MIC_ROUNDS) {
        console.warn('[search] max voice clarification rounds');
        clarificationMicRounds = 0;
        return;
      }
      clarificationMicRounds++;
      window.setTimeout(() => startVoiceCapture({ fromAutoFollowup: true }), 450);
    };
    if (agent.audio_base64) {
      playAgentAudio(agent.audio_base64, agent.audio_mime, afterPlayback);
    } else {
      afterPlayback();
    }
  }

  const voiceBtn = document.getElementById('search-voice-btn');
  let startVoiceCapture = async () => {};

  if (voiceBtn) {
    let cancelRecording = null;

    voiceBtn.addEventListener('click', () => {
      if (voiceBtn.classList.contains('search-voice-btn--processing')) return;
      if (typeof cancelRecording === 'function') {
        cancelRecording();
        return;
      }
      startVoiceCapture({ fromAutoFollowup: false });
    });

    startVoiceCapture = async function startVoiceCapture(opts) {
      const fromFollowup = !!(opts && opts.fromAutoFollowup);
      if (voiceCaptureActive || agentInFlight) {
        // Auto-followup or duplicate event fired while we're already
        // recording or waiting on the agent — drop it. Without this,
        // a single utterance can be transcribed and routed twice,
        // making the agent reply audibly twice.
        return;
      }
      if (!fromFollowup) {
        clarificationMicRounds = 0;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.warn('[search] microphone not available', err);
        return;
      }
      voiceCaptureActive = true;

      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const mr = new MediaRecorder(stream, { mimeType: mime });
      const chunks = [];
      mr.addEventListener('dataavailable', (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      });

      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const SILENCE_MS = 2000;
      const MAX_MS = 90000;
      const SPEECH_RMS = 0.028;
      const SILENCE_RMS = 0.02;

      let hadSpeech = false;
      let silenceAt = null;
      let raf = 0;
      let cleaned = false;
      const t0 = performance.now();

      function cleanupTracks() {
        if (cleaned) return;
        cleaned = true;
        stream.getTracks().forEach((t) => t.stop());
        audioCtx.close().catch(() => {});
        voiceCaptureActive = false;
      }

      function setUiRecording(on) {
        voiceBtn.classList.toggle('search-voice-btn--recording', on);
        voiceBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }

      function setUiProcessing(on) {
        voiceBtn.classList.toggle('search-voice-btn--processing', on);
        if (on) {
          voiceBtn.setAttribute('aria-busy', 'true');
          voiceBtn.setAttribute('aria-label', 'Working on your request…');
          voiceBtn.setAttribute('title', 'Working on your request…');
        } else {
          voiceBtn.removeAttribute('aria-busy');
          voiceBtn.setAttribute('aria-label', 'Voice search');
          voiceBtn.setAttribute('title', 'Voice search');
        }
      }

      function finish(transcode) {
        cancelAnimationFrame(raf);
        cancelRecording = null;
        setUiRecording(false);
        mr.onstop = () => {
          cleanupTracks();
          if (!transcode || !chunks.length) return;
          const blob = new Blob(chunks, { type: mime });
          if (blob.size < 120) return;
          setUiProcessing(true);
          (async () => {
            try {
              const fd = new FormData();
              fd.append('audio', blob, 'speech.webm');
              const tr = await fetch('/api/agent/transcribe', { method: 'POST', body: fd });
              if (!tr.ok) throw new Error(await tr.text());
              const js = await tr.json();
              const text = (js.text || '').trim();
              if (!text) return;
              // Drop the transcript into the input visually but DON'T trigger
              // the place-search dropdown — voice input is rarely a place
              // name and "No matching places" is wrong UX while the agent
              // is actually working on it.
              single.input.value = text;
              single.closeDropdown();
              if (agentInFlight) {
                console.warn('[search] dropping duplicate voice agent call');
                return;
              }
              agentInFlight = true;
              try {
                const agent = await invokeCampusAgent(text);
                handleAgentPipelineResult(agent);
              } finally {
                agentInFlight = false;
              }
            } catch (e) {
              console.warn('[search] voice agent pipeline failed', e);
            } finally {
              setUiProcessing(false);
            }
          })();
        };
        try {
          if (mr.state === 'recording') mr.stop();
          else cleanupTracks();
        } catch (_e) {
          cleanupTracks();
        }
      }

      cancelRecording = () => finish(false);

      setUiRecording(true);
      mr.start(200);

      function tick() {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();

        if (rms >= SPEECH_RMS) {
          hadSpeech = true;
          silenceAt = null;
        } else if (hadSpeech && rms < SILENCE_RMS) {
          if (silenceAt === null) silenceAt = now;
          else if (now - silenceAt >= SILENCE_MS) {
            finish(true);
            return;
          }
        } else {
          silenceAt = null;
        }

        if (now - t0 >= MAX_MS) {
          finish(true);
          return;
        }
        raf = requestAnimationFrame(tick);
      }
      raf = requestAnimationFrame(tick);
    }
  }

  loadData().catch((err) => {
    dataError = err;
    console.warn('[search] data load failed:', err);
    if (single.input.value.trim()) single.sync();
  });

  // Optional external hook for other modules that want the full place
  // list (e.g. a future "snap to named place" feature).
  window.MaristSearch = {
    get items() { return ITEMS.slice(); },
    search,
  };
})();
