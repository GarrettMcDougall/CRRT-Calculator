(function () {
  'use strict';

  const viewRoot = document.getElementById('view-root');
  const navLinks = () => document.querySelectorAll('nav.top-nav a.nav-link');

  async function enableAutomaticUpdates() {
    if (!('serviceWorker' in navigator)) return;

    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    });

    try {
      const registration = await navigator.serviceWorker.register('./sw.js', {
        scope: './',
        updateViaCache: 'none'
      });

      // Force a service-worker update check on every online app launch.
      // Network-first fetch handling also refreshes each requested app file.
      if (navigator.onLine) await registration.update();
      window.addEventListener('online', () => registration.update());
    } catch (error) {
      console.warn('Automatic update check unavailable.', error);
    }
  }

  function setActiveNav(hash) {
    const section = '#/' + (hash.split('/')[1] || 'prescribe');
    navLinks().forEach(a => {
      a.classList.toggle('active', a.getAttribute('href').startsWith(section));
    });
  }

  async function mountSettings(root) {
    const config = await window.CRRTStore.loadConfig();
    root.innerHTML = `
      <h1>Settings</h1>
      <div class="card">
        <h2>Local protocol config</h2>
        <p class="small muted">This app reads <code>config/local-protocol.json</code> at runtime. Fork this repository and edit that file to set your site's approved targets, solution presets, and titration tables.</p>
        <p><span class="flag ${config.reviewed ? 'green' : 'red'}">${config.reviewed ? 'reviewed' : 'unreviewed'}</span> — the config's top-level <code>reviewed</code> flag.</p>
        <details class="working">
          <summary>View raw config</summary>
          <div class="formula">${JSON.stringify(config, null, 2).replace(/</g, '&lt;')}</div>
        </details>
      </div>
      <div class="card">
        <h2>Appearance</h2>
        <div class="btn-group">
          <button type="button" class="btn-toggle" id="themeDark">Dark (default)</button>
          <button type="button" class="btn-toggle" id="themeLight">Light / print</button>
        </div>
      </div>
      <div class="card">
        <h2>Teaching progress</h2>
        <p class="small muted">Case completion and quiz stats are stored locally in your browser only — nothing is uploaded.</p>
        <button class="secondary" id="resetProgress">Reset teaching progress</button>
      </div>
    `;
    document.getElementById('themeDark').addEventListener('click', () => document.documentElement.removeAttribute('data-theme'));
    document.getElementById('themeLight').addEventListener('click', () => document.documentElement.setAttribute('data-theme', 'light'));
    document.getElementById('resetProgress').addEventListener('click', () => {
      window.CRRTStore.resetAll();
      alert('Teaching progress reset.');
    });
  }

  async function route() {
    const hash = location.hash || '#/prescribe';
    setActiveNav(hash);
    const parts = hash.replace(/^#\//, '').split('/');

    try {
      if (parts[0] === 'prescribe' || parts[0] === '') {
        await window.CRRTUICalculator.mount(viewRoot);
      } else if (parts[0] === 'theory') {
        await window.CRRTUITheory.mount(viewRoot, parts[1]);
      } else if (parts[0] === 'learn') {
        if (!parts[1]) await window.CRRTUITeaching.mountHub(viewRoot);
        else if (parts[1] === 'builder') await window.CRRTUITeaching.mountBuilder(viewRoot);
        else if (parts[1] === 'cases') await window.CRRTUITeaching.mountCasesList(viewRoot);
        else if (parts[1] === 'case' && parts[2]) await window.CRRTUITeaching.mountCase(viewRoot, parts[2]);
        else if (parts[1] === 'troubleshoot') await window.CRRTUITeaching.mountTroubleshoot(viewRoot);
        else if (parts[1] === 'quiz') await window.CRRTUITeaching.mountQuiz(viewRoot);
        else await window.CRRTUITeaching.mountHub(viewRoot);
      } else if (parts[0] === 'settings') {
        await mountSettings(viewRoot);
      } else {
        await window.CRRTUICalculator.mount(viewRoot);
      }
    } catch (err) {
      console.error(err);
      viewRoot.innerHTML = `<div class="card"><h2>Something went wrong loading this view</h2><div class="warning-inline hard">${err.message}</div></div>`;
    }

    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('DOMContentLoaded', () => {
    enableAutomaticUpdates();
    route();
  });
})();
