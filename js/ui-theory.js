window.CRRTUITheory = (function () {
  'use strict';

  let sections = null;

  async function mount(root, sectionId) {
    if (!sections) sections = await window.CRRTStore.loadData('theory');
    render(root, sectionId);
  }

  function render(root, sectionId) {
    root.innerHTML = `
      <h1>Theory</h1>
      <div class="toc">
        ${sections.map(s => `<a href="#/theory/${s.id}">${s.title}</a>`).join('')}
      </div>
      ${sections.map(s => renderSection(s)).join('')}
    `;

    if (sectionId) {
      const target = document.getElementById(`theory-${sectionId}`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function renderSection(s) {
    return `
    <div class="card theory-section" id="theory-${s.id}">
      <h2>${s.title}</h2>
      ${s.body.map(p => `<p>${p}</p>`).join('')}
      <div class="high-yield">
        <h3>High yield</h3>
        <ul>${s.highYield.map(h => `<li>${h}</li>`).join('')}</ul>
      </div>
      ${!s.reviewed ? `<p class="small muted mt-4">⚠ Verify against current guidelines/local protocol.</p>` : ''}
    </div>`;
  }

  return { mount };
})();
