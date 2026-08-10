/**
 * schematic.js — renders the live circuit SVG shared by the Prescribe
 * calculator and the troubleshooting simulator. Pure function: state in,
 * SVG markup out. No DOM writes here.
 */
window.CRRTSchematic = (function () {
  'use strict';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /**
   * @param {Object} s
   * @param {number} s.qb_mL_min
   * @param {boolean} s.prefilterActive
   * @param {boolean} s.postfilterActive
   * @param {number} s.ff  filtration fraction 0-1
   * @param {string} s.accentVar  CSS var name, e.g. '--citrate' or '--heparin'
   * @param {Object} [s.pressures] { access, filter, returnP, tmp } mmHg, or null
   * @param {Object} [s.alarm] { zone: 'access'|'filter'|'return'|'air'|'leak'|null }
   */
  function render(s) {
    const {
      qb_mL_min = 150,
      prefilterActive = false,
      postfilterActive = true,
      ff = 0.1,
      accentVar = '--citrate',
      pressures = null,
      alarm = null,
    } = s;

    const lineWidth = clamp(2 + qb_mL_min / 60, 2, 8).toFixed(1);
    const filterColor = ff > 0.30 ? 'var(--alarm)' : ff > 0.25 ? 'var(--amber)' : `var(${accentVar})`;

    const zoneStroke = (zone) => (alarm && alarm.zone === zone ? 'var(--alarm)' : 'var(--hairline)');
    const zoneWidth = (zone) => (alarm && alarm.zone === zone ? 3 : 1);

    return `
<svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="CRRT circuit schematic">
  <style>
    .lbl { font: 600 11px 'IBM Plex Mono', monospace; fill: var(--muted); }
    .lbl-accent { font: 700 11px 'IBM Plex Mono', monospace; fill: var(${accentVar}); }
    .box { fill: var(--panel-raised); stroke: var(--hairline); stroke-width: 1; }
    .port { fill: var(${accentVar}); opacity: 0.9; }
    .port.inactive { fill: var(--hairline); opacity: 0.4; }
  </style>

  <!-- Patient -->
  <rect x="20" y="150" width="70" height="60" rx="6" class="box"/>
  <text x="55" y="184" text-anchor="middle" class="lbl">Patient</text>

  <!-- Access line -->
  <line x1="90" y1="165" x2="160" y2="165" stroke="${zoneStroke('access')}" stroke-width="${zoneWidth('access') || lineWidth}"/>
  <text x="125" y="155" text-anchor="middle" class="lbl">access</text>

  <!-- Pump -->
  <circle cx="180" cy="165" r="20" class="box"/>
  <text x="180" y="169" text-anchor="middle" class="lbl">Qb</text>
  <text x="180" y="200" text-anchor="middle" class="lbl">${qb_mL_min} mL/min</text>

  <!-- Pre-filter port -->
  <line x1="200" y1="165" x2="260" y2="165" stroke="var(--hairline)" stroke-width="${lineWidth}"/>
  <circle cx="230" cy="150" r="6" class="port ${prefilterActive ? '' : 'inactive'}"/>
  <text x="230" y="135" text-anchor="middle" class="${prefilterActive ? 'lbl-accent' : 'lbl'}">pre-dilution</text>

  <!-- Filter -->
  <rect x="260" y="130" width="60" height="70" rx="6" fill="${filterColor}" opacity="0.18" stroke="${filterColor}" stroke-width="2"/>
  <text x="290" y="169" text-anchor="middle" class="lbl" fill="${filterColor}">filter</text>
  <text x="290" y="215" text-anchor="middle" class="lbl">FF ${(ff * 100).toFixed(1)}%</text>

  <!-- Effluent line -->
  <line x1="290" y1="200" x2="290" y2="270" stroke="${zoneStroke('effluent')}" stroke-width="2"/>
  <rect x="255" y="270" width="70" height="36" rx="6" class="box"/>
  <text x="290" y="292" text-anchor="middle" class="lbl">effluent</text>

  <!-- Post-filter port -->
  <line x1="320" y1="165" x2="380" y2="165" stroke="${zoneStroke('filter')}" stroke-width="${zoneWidth('filter') || lineWidth}"/>
  <circle cx="350" cy="150" r="6" class="port ${postfilterActive ? '' : 'inactive'}"/>
  <text x="350" y="135" text-anchor="middle" class="${postfilterActive ? 'lbl-accent' : 'lbl'}">post-dilution</text>

  <!-- Deaeration chamber -->
  <circle cx="410" cy="165" r="18" class="box" stroke="${alarm && alarm.zone === 'air' ? 'var(--alarm)' : 'var(--hairline)'}" stroke-width="${alarm && alarm.zone === 'air' ? 3 : 1}"/>
  <text x="410" y="169" text-anchor="middle" class="lbl" font-size="9">air trap</text>

  <!-- Return line -->
  <line x1="428" y1="165" x2="500" y2="165" stroke="${zoneStroke('return')}" stroke-width="${zoneWidth('return') || lineWidth}"/>
  <text x="464" y="155" text-anchor="middle" class="lbl">return</text>

  <!-- Return to patient -->
  <rect x="500" y="150" width="70" height="60" rx="6" class="box"/>
  <text x="535" y="184" text-anchor="middle" class="lbl">Patient</text>

  ${pressures ? `
  <text x="125" y="230" text-anchor="middle" class="lbl">${pressures.access ?? '—'} mmHg</text>
  <text x="290" y="230" text-anchor="middle" class="lbl">TMP ${pressures.tmp ?? '—'} mmHg</text>
  <text x="464" y="230" text-anchor="middle" class="lbl">${pressures.returnP ?? '—'} mmHg</text>
  ` : ''}
</svg>`;
  }

  return { render };
})();
