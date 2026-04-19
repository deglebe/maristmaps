/* Indoor endpoint controls + step-list renderer.
 */

(function () {
  const state = {
    targets: [],        // flat list from /api/indoor/index
    from: null,         // { endpoint, label } | null
    to: null,
    preferElevator: false,
  };

  const els = {
    fromInput: document.getElementById('directions-from-indoor'),
    fromList: document.getElementById('directions-from-indoor-results'),
    fromClear: document.getElementById('directions-clear-from-indoor-btn'),
    toInput: document.getElementById('directions-to-indoor'),
    toList: document.getElementById('directions-to-indoor-results'),
    toClear: document.getElementById('directions-clear-to-indoor-btn'),
    elev: document.getElementById('directions-prefer-elevator'),
    steps: document.getElementById('directions-steps'),
  };

  if (!els.fromInput || !els.toInput) {
    window.MaristIndoor = {
      snapshot: () => ({ from: null, to: null, preferElevator: false }),
      setSide: () => {},
      swap: () => {},
      renderSteps: () => {},
      ready: Promise.resolve(),
    };
    return;
  }

  // --- load target index ------------------------------------------------

  const readyPromise = (async () => {
    try {
      const res = await fetch('/api/indoor/index', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.targets = Array.isArray(data.targets) ? data.targets : [];
    } catch (err) {
      console.warn('[indoor] /api/indoor/index failed:', err);
      state.targets = [];
    }
  })();

  // --- matcher ----------------------------------------------------------

  function tokenize(q) {
    return String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  // Return [score, matchedTokens] for one target vs one query.
  // Returns score <= 0 when not all query tokens had at least a substring
  // hit. Keeping the function pure makes it trivial to unit-test later.
  function scoreTarget(target, queryTokens) {
    if (!queryTokens.length) return [0, []];
    const targetTokens = target.tokens || [];
    let total = 0;
    for (const qt of queryTokens) {
      let best = 0;
      for (const tt of targetTokens) {
        if (tt === qt) { best = Math.max(best, 6); break; }
        if (tt.startsWith(qt)) { best = Math.max(best, 5); continue; }
        if (tt.includes(qt))   { best = Math.max(best, 2); continue; }
      }
      if (best === 0) return [-1, []]; // all-tokens-must-hit
      total += best;
    }
    // Gentle priority: buildings > rooms > entrances when scores are tied.
    const kindBoost = ({ building: 0.5, room: 0.25, entrance: 0 }[target.kind] || 0);
    return [total + kindBoost, queryTokens];
  }

  function searchTargets(q, limit = 12) {
    const toks = tokenize(q);
    if (!toks.length) return [];
    const scored = [];
    for (const t of state.targets) {
      const [s] = scoreTarget(t, toks);
      if (s > 0) scored.push({ t, s });
    }
    scored.sort((a, b) =>
      b.s - a.s
      || (a.t.building || '').localeCompare(b.t.building || '')
      || (a.t.label || '').localeCompare(b.t.label || '')
    );
    return scored.slice(0, limit).map((x) => x.t);
  }

  // --- rendering --------------------------------------------------------

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function renderRow(t, i, q) {
    const kind = t.kind || 'room';
    return (
      `<li class="search-result indoor-result indoor-result--${kind}" ` +
      `role="option" data-idx="${i}">` +
      `<span class="indoor-result__icon" aria-hidden="true"></span>` +
      `<span class="search-result__text">` +
      `<span class="search-result__title">${highlight(t.label || '', q)}</span>` +
      `<span class="search-result__sub">${escapeHtml(t.sublabel || '')}</span>` +
      `</span>` +
      `<span class="search-result__kind search-result__kind--${kind}">${escapeHtml(kind)}</span>` +
      `</li>`
    );
  }

  function highlight(text, q) {
    const toks = tokenize(q);
    if (!toks.length) return escapeHtml(text);
    // Highlight the longest query token that appears in the text.
    const lower = String(text).toLowerCase();
    for (const qt of toks.slice().sort((a, b) => b.length - a.length)) {
      const idx = lower.indexOf(qt);
      if (idx >= 0) {
        return (
          escapeHtml(text.slice(0, idx))
          + '<strong>' + escapeHtml(text.slice(idx, idx + qt.length)) + '</strong>'
          + escapeHtml(text.slice(idx + qt.length))
        );
      }
    }
    return escapeHtml(text);
  }

  // --- per-side controllers --------------------------------------------

  function makeSide(side) {
    const input = side === 'from' ? els.fromInput : els.toInput;
    const list = side === 'from' ? els.fromList : els.toList;
    const clearBtn = side === 'from' ? els.fromClear : els.toClear;

    let current = [];

    function sync() {
      const q = input.value;
      const matches = searchTargets(q);
      current = matches;
      if (!q.trim()) {
        list.hidden = true;
        list.innerHTML = '';
        return;
      }
      if (!matches.length) {
        list.innerHTML =
          `<li class="search-result search-result--empty" role="option">No matches</li>`;
        list.hidden = false;
        return;
      }
      list.innerHTML = matches.map((t, i) => renderRow(t, i, q)).join('');
      list.hidden = false;
    }

    function closeList() {
      list.hidden = true;
    }

    function pick(target) {
      if (!target) return;
      input.value = target.label + (target.kind === 'room' ? '' : '');
      // For rooms, show "1021 · Hancock" so the user can tell which
      // building they committed to without opening the dropdown again.
      if (target.building && target.kind !== 'building') {
        input.value = `${target.label} · ${target.building}`;
      } else {
        input.value = target.label;
      }
      closeList();
      setState(side, target);
    }

    list.addEventListener('click', (e) => {
      const row = e.target.closest('.search-result');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      if (!Number.isFinite(idx)) return;
      pick(current[idx]);
    });

    input.addEventListener('input', () => {
      // Typing invalidates the previously-committed pick until the user
      // selects again — otherwise every keystroke would re-fire routing
      // against a stale endpoint.
      if (state[side]) setState(side, null, { silent: false });
      sync();
    });
    input.addEventListener('focus', sync);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && current.length) {
        e.preventDefault();
        pick(current[0]);
      } else if (e.key === 'Escape') {
        closeList();
        input.blur();
      }
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        closeList();
        setState(side, null);
        input.focus();
      });
    }

    return { input, list, sync, closeList };
  }

  const fromSide = makeSide('from');
  const toSide = makeSide('to');

  document.addEventListener('click', (e) => {
    const card = document.getElementById('search-card');
    if (card && !card.contains(e.target)) {
      fromSide.closeList();
      toSide.closeList();
    }
  });

  if (els.elev) {
    els.elev.addEventListener('change', () => {
      state.preferElevator = !!els.elev.checked;
      emit();
    });
  }

  // --- state + public API ----------------------------------------------

  function setState(side, target, { silent = false } = {}) {
    const next = target
      ? { endpoint: target.endpoint, label: target.label, kind: target.kind, building: target.building }
      : null;
    const prev = state[side];
    if (sameState(prev, next)) return;
    state[side] = next;
    if (!silent) emit();
  }

  function sameState(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return JSON.stringify(a.endpoint) === JSON.stringify(b.endpoint);
  }

  function snapshot() {
    return {
      from: state.from && { ...state.from },
      to: state.to && { ...state.to },
      preferElevator: state.preferElevator,
    };
  }

  function emit() {
    document.dispatchEvent(new CustomEvent('mmap:indoor-changed', {
      detail: snapshot(),
    }));
  }

  /** Apply an indoor endpoint programmatically. No-op if target is null. */
  function setSide(side, target) {
    if (target == null) {
      const input = side === 'from' ? els.fromInput : els.toInput;
      input.value = '';
      setState(side, null);
      return true;
    }
    // Accept either a full target (from our list) or a bare endpoint dict.
    if (!target.tokens) {
      // Try to find a matching target by its endpoint payload.
      const found = state.targets.find((t) =>
        JSON.stringify(t.endpoint) === JSON.stringify(target.endpoint || target),
      );
      if (!found) return false;
      target = found;
    }
    const input = side === 'from' ? els.fromInput : els.toInput;
    input.value = target.building && target.kind !== 'building'
      ? `${target.label} · ${target.building}`
      : target.label;
    setState(side, target);
    return true;
  }

  function swap() {
    const a = state.from, b = state.to;
    const aText = els.fromInput.value, bText = els.toInput.value;
    state.from = b; state.to = a;
    els.fromInput.value = bText; els.toInput.value = aText;
    emit();
  }

  // --- step list rendering ---------------------------------------------

  function renderSteps(route) {
    const ol = els.steps;
    if (!ol) return;
    if (!route || !Array.isArray(route.phases) || !route.phases.length) {
      ol.hidden = true; ol.innerHTML = '';
      return;
    }
    const parts = [];
    route.phases.forEach((phase) => {
      parts.push(renderPhaseHeader(phase));
      for (const step of phase.steps || []) parts.push(renderStep(step));
    });
    ol.innerHTML = parts.join('');
    ol.hidden = false;
  }

  function fmtMeters(m) {
    if (!Number.isFinite(m)) return '';
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(2)} km`;
  }

  function renderPhaseHeader(phase) {
    let summary = '';
    if (phase.kind === 'outdoor') {
      summary = `Outdoor · ${fmtMeters(phase.distance_m)}`;
    } else {
      const b = phase.building || '';
      const floors = phase.from_floor != null && phase.to_floor != null
        ? ` · Floor ${phase.from_floor}${phase.from_floor !== phase.to_floor ? ' → ' + phase.to_floor : ''}`
        : '';
      const conn = phase.connector_used
        ? ` · via ${phase.connector_kind || 'stairs'} ${phase.connector_used}`
        : '';
      const fallback = phase.used_fallback ? ' <span class="phase-badge">fallback</span>' : '';
      summary = `Indoor · ${escapeHtml(b)}${floors}${conn}${fallback} · ${fmtMeters(phase.distance_m)}`;
    }
    return (
      `<li class="step step--phase-header">` +
      `<span class="step__chip step__chip--${phase.kind}">${phase.kind}</span>` +
      `<span class="step__summary">${summary}</span>` +
      `</li>`
    );
  }

  // ---- shared icon SVGs ------------------------------------------------
  //
  // Reused between step rows (inline chips) and map markers (routing.js).
  // Shapes match tools/csv_viz.html so anyone familiar with that debugger
  // recognizes them:
  //   - door:     blue rectangle (entrance)
  //   - stairs:   orange triangle
  //   - elevator: red triangle pointing up, with base bar
  //   - start/end dots are drawn by the existing map circle layer.
  //
  // Each builder takes a pixel size and returns an SVG string. Keeping
  // these as string-returning functions lets callers scale for chips vs
  // full markers without touching the path definitions.

  const ICONS = {
    door(size = 14) {
      const h = Math.round(size * 16 / 14);
      return (
        `<svg width="${size}" height="${h}" viewBox="0 0 14 16" aria-hidden="true">` +
        `<rect x="2" y="2" width="10" height="13" rx="1.5" ` +
        `fill="#5a9fff" stroke="#0d2540" stroke-width="1.5"/>` +
        `<circle cx="9.5" cy="9" r="0.9" fill="#0d2540"/>` +
        `</svg>`
      );
    },
    stairs(size = 14) {
      return (
        `<svg width="${size}" height="${size}" viewBox="0 0 14 14" aria-hidden="true">` +
        `<path d="M7 2 L12 12 L2 12 Z" fill="#daa520" ` +
        `stroke="#402c05" stroke-width="1.5" stroke-linejoin="round"/>` +
        `</svg>`
      );
    },
    elevator(size = 14) {
      // Red up-triangle with a short base bar beneath it — reads as an
      // elevator-up pictogram at small sizes.
      return (
        `<svg width="${size}" height="${size}" viewBox="0 0 14 14" aria-hidden="true">` +
        `<path d="M7 2 L12 10 L2 10 Z" fill="#e74c3c" ` +
        `stroke="#4a0f08" stroke-width="1.4" stroke-linejoin="round"/>` +
        `<rect x="3" y="11" width="8" height="1.6" rx="0.3" ` +
        `fill="#e74c3c" stroke="#4a0f08" stroke-width="1"/>` +
        `</svg>`
      );
    },
  };

  // Map step.kind (and connector_kind for change_floor / exit_connector)
  // to an icon name. Central so both the step renderer and the map-marker
  // builder agree on which kind of step shows which glyph.
  function iconNameForStep(step) {
    switch (step.kind) {
      case 'exit_room':
      case 'enter_building':
      case 'exit_building':
        return 'door';
      case 'change_floor':
      case 'exit_connector':
        return step.connector_kind === 'elevator' ? 'elevator' : 'stairs';
      default:
        return null;
    }
  }

  function renderStepIcon(step) {
    const name = iconNameForStep(step);
    if (!name) return '';
    return `<span class="step__icon step__icon--${name}">${ICONS[name](14)}</span>`;
  }

  function renderStep(step) {
    const icon = renderStepIcon(step);
    const turn = step.turn
      ? `<span class="step__turn step__turn--${step.turn}">${escapeHtml(step.turn)}</span>`
      : '';
    return (
      `<li class="step step--${escapeHtml(step.kind)}">` +
      `${icon}${turn}<span class="step__text">${escapeHtml(step.text)}</span>` +
      `</li>`
    );
  }

  window.MaristIndoor = {
    snapshot,
    setSide,
    swap,
    renderSteps,
    ready: readyPromise,
    // expose matcher + icons for callers (routing.js uses icons for map markers)
    _search: searchTargets,
    icons: ICONS,
    iconNameForStep,
  };
})();
