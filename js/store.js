/**
 * store.js — localStorage wrapper (UI prefs + teaching progress ONLY,
 * never clinical inputs) and runtime config loader.
 */
window.CRRTStore = (function () {
  'use strict';

  const KEY_PREFIX = 'crrt-app:';
  let _config = null;

  function get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(KEY_PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function set(key, value) {
    try {
      localStorage.setItem(KEY_PREFIX + key, JSON.stringify(value));
    } catch (e) {
      /* storage unavailable — fail silently, app still works this session */
    }
  }

  function resetAll() {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(KEY_PREFIX))
      .forEach((k) => localStorage.removeItem(k));
  }

  const FILE_PROTOCOL_HINT =
    "This page was opened directly from disk (file://) — browsers block the app " +
    "from loading its own data files that way. Serve the folder over http instead: " +
    "run `python3 -m http.server` (or `npx serve`) inside the crrt-app folder and " +
    "open the localhost link, or push it to GitHub Pages.";

  function describeFetchFailure(err, path) {
    const isFileProtocol = typeof location !== 'undefined' && location.protocol === 'file:';
    const base = `Could not load ${path}.`;
    return isFileProtocol ? `${base} ${FILE_PROTOCOL_HINT}` : `${base} ${err.message}`;
  }

  async function loadConfig() {
    if (_config) return _config;
    try {
      const res = await fetch('config/local-protocol.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      _config = await res.json();
    } catch (e) {
      console.error(describeFetchFailure(e, 'config/local-protocol.json'), e);
      _config = {};
    }
    return _config;
  }

  async function loadData(name) {
    const path = `data/${name}.json`;
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      throw new Error(describeFetchFailure(e, path));
    }
  }

  async function loadVersion() {
    try {
      const res = await fetch('version.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  return { get, set, resetAll, loadConfig, loadData, loadVersion };
})();
