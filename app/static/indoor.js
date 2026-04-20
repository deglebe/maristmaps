/* Indoor endpoint state + step-list renderer.
 *
 * This module used to own two per-side autocomplete inputs that sat
 * beside the outdoor From/To fields. That duplicated the search surface,
 * so the per-side autocomplete now lives inside the unified directions
 * picker in search.js. What remains here:
 *
 *   - The indoor target index (rooms / entrances / buildings with
 *     indoor data) fetched from /api/indoor/index, used by setSide() to
 *     resolve bare endpoint payloads into full targets.
 *   - The {from, to, preferElevator} state + `mmap:indoor-changed`
 *     event that routing.js listens on to trigger /api/route calls.
 *   - The step-list renderer (renderSteps) and the shared icon palette
 *     (ICONS / iconNameForStep) that routing.js uses for on-map markers.
 */
(function () {
  const state = {
    targets: [], // full list from /api/indoor/index
    from: null, // { endpoint, label, kind, building } | null
    to: null,
    preferElevator: false,
  };

  const elev = document.getElementById("directions-prefer-elevator");
  const steps = document.getElementById("directions-steps");

  const readyPromise = (async () => {
    try {
      const res = await fetch("/api/indoor/index", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.targets = Array.isArray(data.targets) ? data.targets : [];
    } catch (err) {
      console.warn("[indoor] /api/indoor/index failed:", err);
      state.targets = [];
    }
  })();

  if (elev) {
    elev.addEventListener("change", () => {
      state.preferElevator = !!elev.checked;
      emit();
    });
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(
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

  function sameState(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return JSON.stringify(a.endpoint) === JSON.stringify(b.endpoint);
  }

  function setState(side, target, { silent = false } = {}) {
    const next = target
      ? {
          endpoint: target.endpoint,
          label: target.label,
          kind: target.kind,
          building: target.building,
        }
      : null;
    if (sameState(state[side], next)) return;
    state[side] = next;
    if (!silent) emit();
  }

  function snapshot() {
    return {
      from: state.from && { ...state.from },
      to: state.to && { ...state.to },
      preferElevator: state.preferElevator,
    };
  }

  function emit() {
    document.dispatchEvent(
      new CustomEvent("mmap:indoor-changed", {
        detail: snapshot(),
      }),
    );
  }

  /**
   * Apply an indoor endpoint programmatically. Accepts either a full
   * target (from state.targets) or a bare dict like
   *   { endpoint: {kind:'room', building:'Hancock', room:'1021'},
   *     label: '1021', kind: 'room', building: 'Hancock' }
   * Falls back to looking up the real target by endpoint payload so the
   * caller gets proper tokens/sublabel for free.
   * Returns true on success, false if the endpoint doesn't match any
   * known target.
   */
  function setSide(side, target) {
    if (target == null) {
      setState(side, null);
      return true;
    }
    if (!target.tokens) {
      const found = state.targets.find(
        (t) =>
          JSON.stringify(t.endpoint) ===
          JSON.stringify(target.endpoint || target),
      );
      if (found) target = found;
      // If no match, still accept: caller may have manually constructed
      // an endpoint (e.g. for a building that's not in locations). The
      // server can still route kind=building by name even without an
      // indexed target.
    }
    setState(side, target);
    return true;
  }

  function swap() {
    const a = state.from,
      b = state.to;
    state.from = b;
    state.to = a;
    emit();
  }

  function renderSteps(route) {
    const ol = steps;
    if (!ol) return;
    if (!route || !Array.isArray(route.phases) || !route.phases.length) {
      ol.hidden = true;
      ol.innerHTML = "";
      return;
    }
    const parts = [];
    route.phases.forEach((phase) => {
      parts.push(renderPhaseHeader(phase));
      for (const step of phase.steps || []) parts.push(renderStep(step));
    });
    ol.innerHTML = parts.join("");
    ol.hidden = false;
  }

  function fmtMeters(m) {
    if (!Number.isFinite(m)) return "";
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(2)} km`;
  }

  function renderPhaseHeader(phase) {
    let summary = "";
    if (phase.kind === "outdoor") {
      summary = `Outdoor · ${fmtMeters(phase.distance_m)}`;
    } else {
      const b = phase.building || "";
      const floors =
        phase.from_floor != null && phase.to_floor != null
          ? ` · Floor ${phase.from_floor}${phase.from_floor !== phase.to_floor ? " → " + phase.to_floor : ""}`
          : "";
      const conn = phase.connector_used
        ? ` · via ${phase.connector_kind || "stairs"} ${phase.connector_used}`
        : "";
      const fallback = phase.used_fallback
        ? ' <span class="phase-badge">fallback</span>'
        : "";
      summary = `Indoor · ${escapeHtml(b)}${floors}${conn}${fallback} · ${fmtMeters(phase.distance_m)}`;
    }
    return (
      `<li class="step step--phase-header">` +
      `<span class="step__chip step__chip--${phase.kind}">${phase.kind}</span>` +
      `<span class="step__summary">${summary}</span>` +
      `</li>`
    );
  }

  const ICONS = {
    door(size = 14) {
      const h = Math.round((size * 16) / 14);
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

  function iconNameForStep(step) {
    switch (step.kind) {
      case "exit_room":
      case "enter_building":
      case "exit_building":
        return "door";
      case "change_floor":
      case "exit_connector":
        return step.connector_kind === "elevator" ? "elevator" : "stairs";
      default:
        return null;
    }
  }

  function renderStepIcon(step) {
    const name = iconNameForStep(step);
    if (!name) return "";
    return `<span class="step__icon step__icon--${name}">${ICONS[name](14)}</span>`;
  }

  function renderStep(step) {
    const icon = renderStepIcon(step);
    const turn = step.turn
      ? `<span class="step__turn step__turn--${step.turn}">${escapeHtml(step.turn)}</span>`
      : "";
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
    get targets() {
      return state.targets.slice();
    },
    icons: ICONS,
    iconNameForStep,
  };
})();
