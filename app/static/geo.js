/* Live GPS helper. Watches the browser geolocation API in the background
 * and exposes the latest fix on `window.MaristGeo` so other modules
 * (routing, search, agent) can default the trip start to the user's
 * actual location instead of the map view center.
 *
 * No UI; just a data source. Failures (denied permission, no signal)
 * leave `getLast()` returning null — callers should fall back gracefully.
 */
(function () {
  const STATE = { last: null, error: null, watchId: null };
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) {
      try { fn(STATE.last); } catch (e) { /* ignore */ }
    }
  }

  function update(pos) {
    if (!pos || !pos.coords) return;
    STATE.last = {
      lon: pos.coords.longitude,
      lat: pos.coords.latitude,
      accuracy: pos.coords.accuracy,
      ts: pos.timestamp || Date.now(),
    };
    STATE.error = null;
    notify();
  }

  function fail(err) {
    STATE.error = err;
    // Don't wipe the last-known fix on transient errors — stale GPS is
    // better than no GPS for "default start" use cases.
  }

  function startWatch() {
    if (STATE.watchId != null) return;
    if (!('geolocation' in navigator)) return;
    try {
      STATE.watchId = navigator.geolocation.watchPosition(update, fail, {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 15000,
      });
    } catch (e) {
      console.warn('[geo] watchPosition unavailable', e);
    }
  }

  function requestOnce() {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('geolocation unavailable'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => { update(pos); resolve(STATE.last); },
        (err) => { fail(err); reject(err); },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
      );
    });
  }

  startWatch();

  window.MaristGeo = {
    /** Latest known fix or null. Shape: { lon, lat, accuracy, ts }. */
    getLast() { return STATE.last && { ...STATE.last }; },
    /** Subscribe to fix updates. Returns an unsubscribe function. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Force a one-shot prompt; resolves with the new fix. */
    requestOnce,
    /** Was geolocation refused or unavailable? */
    get error() { return STATE.error; },
  };
})();
