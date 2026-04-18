/* Search overlay controller for the map page.
 *
 * Fetches every named building / path / POI from /api/features once and
 * filters client-side. A campus-sized dataset is small enough (a few
 * thousand rows at most) that round-tripping on every keystroke isn't
 * worth the latency, and having the full list in memory makes it trivial
 * to reuse for routing later (snap a typed name to an (lon,lat) point).
 *
 * Depends on map.js having already published `window.MaristMap.ready`.
 */
(function () {
  const input = document.getElementById("search-q");
  const list = document.getElementById("search-results");
  const card = document.getElementById("search-card");
  const placeEl = document.getElementById("search-placeholder-cycle");
  const wrapEl = document.getElementById("search-input-wrap");

  if (!input || !list || !card || !wrapEl) {
    console.warn("[search] overlay elements missing; skipping init");
    return;
  }

  const PLACEHOLDER_PHRASES = [
    "Find Red Foxes…",
    "Traverse Marist…",
    "Search places…",
    "Where in Hancock am I?",
    "Lower Town vs Upper Town…",
    "Plot your next sprint to class…",
    "The Hudson has opinions…",
    "Lost? Join the club.",
    "Fox dens, cafés, and naps…",
    "Avoid the stairs (good luck)…",
    "Rotunda traffic report…",
    "River views, river moods…",
  ];

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  function highlight(text, q) {
    if (!q) return escapeHtml(text);
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    const a = escapeHtml(text.slice(0, idx));
    const b = escapeHtml(text.slice(idx, idx + q.length));
    const c = escapeHtml(text.slice(idx + q.length));
    return a + "<strong>" + b + "</strong>" + c;
  }

  // --- data --------------------------------------------------------------

  let PLACES = [];
  let placesReady = false;
  let placesError = null;

  async function loadPlaces() {
    try {
      const res = await fetch("/api/features", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      PLACES = Array.isArray(data.features) ? data.features : [];
      placesReady = true;
      console.log(
        `[search] loaded ${PLACES.length} features from /api/features`,
      );
      // If the user typed before the fetch resolved, re-render now.
      if (input.value.trim()) syncResults();
    } catch (err) {
      placesError = err;
      console.warn("[search] could not load /api/features:", err);
      // Re-render so the user sees the error instead of silently empty results.
      if (input.value.trim()) syncResults();
    }
  }

  // Kick off the fetch immediately; search still works offline but will show
  // an empty result set until the promise resolves.
  loadPlaces();

  // --- filtering ---------------------------------------------------------

  // Split the query into whitespace tokens and require every token to
  // appear somewhere in the haystack. This lets "library cannavino" match
  // "James A. Cannavino Library" without caring about order.
  function tokenize(q) {
    return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  function placeHaystack(p) {
    return (
      (p.name || "") +
      " " +
      (p.subtitle || "") +
      " " +
      (p.kind || "")
    ).toLowerCase();
  }

  // Score so exact / prefix matches on the title rise to the top.
  function scorePlace(p, tokens) {
    const name = (p.name || "").toLowerCase();
    let score = 0;
    for (const t of tokens) {
      const i = name.indexOf(t);
      if (i === 0) score += 5;
      else if (i > 0) score += 2;
      else if (placeHaystack(p).includes(t)) score += 1;
      else return -1;
    }
    // Gently prefer buildings over paths; they're what most searches want.
    if (p.kind === "building") score += 0.5;
    return score;
  }

  function filterPlaces(q) {
    const tokens = tokenize(q);
    if (!tokens.length) return [];
    const scored = [];
    for (const p of PLACES) {
      const s = scorePlace(p, tokens);
      if (s >= 0) scored.push({ p, s });
    }
    scored.sort(
      (a, b) => b.s - a.s || (a.p.name || "").localeCompare(b.p.name || ""),
    );
    // Keep the dropdown manageable; 50 is plenty for a campus.
    return scored.slice(0, 50).map((x) => x.p);
  }

  // --- placeholder cycle -------------------------------------------------

  let phraseIdx = 0;
  let cycleTimer = null;

  function stopPlaceholderCycle() {
    if (cycleTimer) {
      window.clearInterval(cycleTimer);
      cycleTimer = null;
    }
  }

  function advancePlaceholderPhrase() {
    if (!wrapEl.classList.contains("search-input-wrap--faux-empty")) return;
    placeEl.classList.add("search-placeholder-cycle--exit");
    window.setTimeout(() => {
      if (!wrapEl.classList.contains("search-input-wrap--faux-empty")) {
        placeEl.classList.remove("search-placeholder-cycle--exit");
        return;
      }
      phraseIdx = (phraseIdx + 1) % PLACEHOLDER_PHRASES.length;
      placeEl.textContent = PLACEHOLDER_PHRASES[phraseIdx];
      placeEl.classList.remove("search-placeholder-cycle--exit");
    }, 450);
  }

  function startPlaceholderCycle() {
    if (cycleTimer) return;
    cycleTimer = window.setInterval(advancePlaceholderPhrase, 4800);
  }

  function syncPlaceholderOverlay() {
    const q = input.value.trim();
    const focused = document.activeElement === input;
    const showFaux = !q && !focused;
    wrapEl.classList.toggle("search-input-wrap--faux-empty", showFaux);
    if (placeEl) {
      placeEl.classList.toggle("search-placeholder-cycle--off", !showFaux);
      if (showFaux) {
        placeEl.classList.remove("search-placeholder-cycle--exit");
        placeEl.textContent =
          PLACEHOLDER_PHRASES[phraseIdx % PLACEHOLDER_PHRASES.length];
        startPlaceholderCycle();
      } else {
        stopPlaceholderCycle();
      }
    }
  }

  // --- rendering ---------------------------------------------------------

  const KIND_LABEL = { building: "Building", path: "Path", poi: "Place" };

  function renderResultRow(p, q, i) {
    const kindClass = `search-result__kind--${p.kind || "poi"}`;
    const kindLabel = KIND_LABEL[p.kind] || "Place";
    return (
      `<li class="search-result" role="option" id="search-opt-${i}" tabindex="-1" ` +
      `data-idx="${i}">` +
      `<span class="search-result__icon" aria-hidden="true">` +
      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-6-4.35-6-10a6 6 0 1 1 12 0c0 5.65-6 10-6 10z"/><circle cx="12" cy="11" r="2.5"/></svg>` +
      `</span>` +
      `<span class="search-result__text">` +
      `<span class="search-result__title">${highlight(p.name || "", q.trim())}</span>` +
      `<span class="search-result__sub">${escapeHtml(p.subtitle || "")}</span>` +
      `</span>` +
      `<span class="search-result__kind ${kindClass}">${escapeHtml(kindLabel)}</span>` +
      `</li>`
    );
  }

  let currentMatches = [];

  function emptyMessage() {
    if (!placesReady && !placesError) return "Loading campus data…";
    if (placesError) return "Could not load campus data";
    return "No matching places";
  }

  function syncResults() {
    const q = input.value;
    const matches = filterPlaces(q);
    currentMatches = matches;
    input.setAttribute("aria-expanded", matches.length > 0 ? "true" : "false");
    if (!q.trim()) {
      list.hidden = true;
      list.innerHTML = "";
      card.classList.remove("search-card--open");
      return;
    }
    if (matches.length === 0) {
      list.innerHTML = `<li class="search-result search-result--empty" role="option">${escapeHtml(emptyMessage())}</li>`;
      list.hidden = false;
      card.classList.add("search-card--open");
      return;
    }
    list.innerHTML = matches.map((p, i) => renderResultRow(p, q, i)).join("");
    list.hidden = false;
    card.classList.add("search-card--open");
  }

  function onInput() {
    syncResults();
    syncPlaceholderOverlay();
  }

  // --- selection ---------------------------------------------------------

  function closeDropdown() {
    list.hidden = true;
    card.classList.remove("search-card--open");
    input.setAttribute("aria-expanded", "false");
  }

  function selectPlace(p) {
    if (!p) return;
    const mmap = window.MaristMap;
    if (mmap && mmap.map && Number.isFinite(p.lon) && Number.isFinite(p.lat)) {
      // flyTo lands smoothly even if we're already near the target.
      mmap.map.flyTo({
        center: [p.lon, p.lat],
        zoom: Math.max(mmap.map.getZoom(), 18),
        speed: 1.2,
        essential: true,
      });
      new maplibregl.Popup({
        closeButton: true,
        closeOnClick: true,
        maxWidth: "22rem",
      })
        .setLngLat([p.lon, p.lat])
        .setHTML(
          `<strong>${escapeHtml(p.name || "")}</strong>` +
            `<div class="tag">${escapeHtml(p.subtitle || "")}</div>`,
        )
        .addTo(mmap.map);
    }
    input.value = p.name || "";
    closeDropdown();
    input.blur();
    syncPlaceholderOverlay();
  }

  list.addEventListener("click", (e) => {
    const row = e.target.closest(".search-result");
    if (!row) return;
    const idx = Number(row.dataset.idx);
    if (!Number.isFinite(idx)) return;
    selectPlace(currentMatches[idx]);
  });

  // --- input wiring ------------------------------------------------------

  input.addEventListener("input", onInput);
  input.addEventListener("focus", () => {
    syncResults();
    syncPlaceholderOverlay();
  });
  input.addEventListener("blur", syncPlaceholderOverlay);

  document.addEventListener("click", (e) => {
    if (!card.contains(e.target)) closeDropdown();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDropdown();
      input.blur();
      return;
    }
    if (e.key === "Enter" && currentMatches.length) {
      e.preventDefault();
      selectPlace(currentMatches[0]);
    }
  });

  syncPlaceholderOverlay();
})();
