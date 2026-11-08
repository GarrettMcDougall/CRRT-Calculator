/**
 * ui-calculator.js: the Prescribe mode. One continuous prescription
 * builder: treatment target, platform and products, machine settings, then a
 * modality-specific anticoagulation panel, then solutions and electrolytes.
 *
 * Every value passed to the engine goes through engineInputs(), which
 * coerces form strings to numbers. Form fields return strings, and passing
 * them straight to the engine turned additions into string concatenation.
 */
window.CRRTUICalculator = (function () {
  'use strict';

  const C = window.CRRTCalc;
  let CONFIG = null;
  let SOLUTIONS = null;

  // ---- module state (clinical inputs: never persisted to localStorage) ----
  let state = {
    actualWeightKg: 80,
    weightKg: 80,
    weightBasis: 'actual',
    heightCm: null,
    sex: 'unspecified',
    hematocrit: 0.30,
    modality: 'CVVHDF',
    bloodFlow_mL_min: 150,
    dialysateFlow_mL_hr: 1500,
    replacementPre_mL_hr: 0,
    replacementPost_mL_hr: 500,
    netUltrafiltration_mL_hr: 0,
    nonCRRTIntake_mL_hr: 0,
    uptimeFraction: 0.90,
    targetDeliveredDose_mL_kg_hr: 22.5,
    setupGenerated: false,
    machineEdited: false,

    anticoag: 'citrate', // 'citrate' | 'heparin' | 'heparinized'

    // platform and commercially supplied fluids
    marketRegion: 'CA',
    solutionBrand: 'vantive',
    dialysateProductId: 'prismasate-bgk-2-0',
    replacementProductId: 'prismasol-bgk-2-0',
    citrateProductId: 'regiocit',

    // citrate
    citrateConcentration_mmol_L: 18,
    citratePreFilter: true,
    citrateTargetDose_mmol_L: 3.0,
    postFilterICa_mmol_L: '',
    systemicICa_mmol_L: '',
    totalCa_mmol_L: '',
    effluentTotalCa_mmol_L: 1.5,
    pH: '',
    hco3_mmol_L: '',

    // HHS protocol mode: null | 'citrate' | 'heparin'
    hhs: null,
    hhsNotice: '',
    hhsFlowsEdited: false,
    hhsOverrides: {},

    // collapsible panels (closed by default; remembered while the page is open)
    ui: { citrateOpen: false, solutionsOpen: false },

    // solutions
    serumPO4_mmol_L: '',
    serumK_mmol_L: '',
    serumNa_mmol_L: '',
    solutionNa_mmol_L: 140,
  };

  function num(v, fallback = 0) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  // Haematocrit as a fraction. The HHS sheets take %, so 24 is read as 0.24.
  function hctFraction() {
    const v = num(state.hematocrit, NaN);
    return v > 1 && v <= 100 ? v / 100 : v;
  }

  function fmt(v, digits = 1) {
    // Number.isFinite() also rejects Infinity, which zero weight, zero blood
    // flow, or Hct of 1 would otherwise surface to the user as "Infinity".
    if (v === null || v === undefined || !Number.isFinite(v)) return '–';
    // Round halves away from zero on the decimal value, as Excel displays it
    // (toFixed shows 39.05 as 39.0 because of binary storage; Excel shows 39.1).
    const scaled = Number((Number(Math.abs(v).toPrecision(15)) * Math.pow(10, digits)).toPrecision(15));
    const r = Math.sign(v) * Math.round(scaled) / Math.pow(10, digits);
    return r.toFixed(digits);
  }

  function el(id) { return document.getElementById(id); }

  function currentWeightMetrics() {
    return C.computeBMIAndAdjustedWeight({
      weightKg: num(state.actualWeightKg),
      heightCm: state.heightCm,
      sex: state.sex,
    });
  }

  function syncDosingWeight() {
    const metrics = currentWeightMetrics();
    if (state.weightBasis === 'actual') state.weightKg = num(state.actualWeightKg);
    if (state.weightBasis === 'ideal') {
      if (metrics.ibwKg) state.weightKg = metrics.ibwKg;
      else { state.weightBasis = 'actual'; state.weightKg = num(state.actualWeightKg); }
    }
    if (state.weightBasis === 'adjusted') {
      if (metrics.adjustedBodyWeightKg) state.weightKg = metrics.adjustedBodyWeightKg;
      else { state.weightBasis = 'actual'; state.weightKg = num(state.actualWeightKg); }
    }
  }

  // ---- protocol settings --------------------------------------------------

  // Filtration-fraction limits from config/local-protocol.json. A separate
  // ceiling may be set for dilute pre-filter citrate (under 50 mmol/L, e.g.
  // Regiocit or Prismocitrate 18 mmol/L). Both default to 25%.
  function ffLimits() {
    const f = (CONFIG && CONFIG.filtrationFraction) || {};
    const pick = (v, d) => (Number.isFinite(v) && v > 0 && v < 1 ? v : d);
    const base = pick(f.ceiling, 0.25);
    const dilutePreCitrate = state.anticoag === 'citrate' && state.citratePreFilter &&
      num(state.citrateConcentration_mmol_L) > 0 && num(state.citrateConcentration_mmol_L) < 50;
    const ceiling = dilutePreCitrate ? pick(f.ceilingWithPreFilterCitrate, base) : base;
    const red = Math.max(pick(f.redThreshold, 0.30), ceiling);
    return { ffCeiling: ceiling, ffRedThreshold: red };
  }

  // Protocol minimum share of replacement fluid given pre-filter. With
  // citrate, the citrate itself is additional pre-filter fluid.
  function preFilterShare() {
    return state.anticoag === 'citrate' ? 0.20 : 0.50;
  }

  function citrateActive() {
    return state.anticoag === 'citrate';
  }

  // ---- HHS protocol ------------------------------------------------------
  // Reproduces the HHS spreadsheets. Defaults live in
  // config/local-protocol.json (hhsProtocol) so the unit can edit them.
  function hhsCfg() {
    const h = (CONFIG && CONFIG.hhsProtocol) || {};
    const c = h.citrate || {}, hp = h.heparin || {};
    const n = (v, d) => (Number.isFinite(v) ? v : d);
    return {
      label: h.label || 'HHS protocol',
      ffPlasmaFactor: n(h.ffPlasmaFactor, 0.95),
      doseMin: n(h.doseGuidance && h.doseGuidance.min, 25),
      doseMax: n(h.doseGuidance && h.doseGuidance.max, 35),
      citrate: {
        productId: c.citrateProductId || 'regiocit',
        conc: n(c.citrateConcentration_mmol_L, 18),
        dose: n(c.citrateDose_mmol_L, 3),
        qb: n(c.bloodFlow_mL_min, 150),
        post: n(c.postFilter_mL_hr, 200),
        target: n(c.targetEffluentDose_mL_kg_hr, 25),
      },
      heparin: {
        modality: hp.modality === 'CVVH' ? 'CVVH' : 'CVVHDF',
        qbCVVHDF: n(hp.bloodFlowCVVHDF_mL_min, 200),
        qbCVVH: n(hp.bloodFlowCVVH_mL_min, 250),
        target: n(hp.targetEffluentDose_mL_kg_hr, 30),
        minPre: n(hp.minPre_mL_hr, 100),
        minPost: n(hp.minPost_mL_hr, 200),
      },
    };
  }

  function hhsAllowedModalities() {
    if (state.hhs === 'citrate') return ['CVVHDF'];
    if (state.hhs === 'heparin') return ['CVVHDF', 'CVVH'];
    return ['CVVHDF', 'CVVHD', 'CVVH', 'SCUF'];
  }

  function computeHHS() {
    const cfg = hhsCfg();
    return C.hhsPrescription({
      protocol: state.hhs,
      modality: state.modality,
      weightKg: num(state.weightKg),
      hematocrit: hctFraction(),
      bloodFlow_mL_min: num(state.bloodFlow_mL_min),
      targetEffluentDose_mL_kg_hr: num(state.targetDeliveredDose_mL_kg_hr),
      citrateDose_mmol_L: num(state.citrateTargetDose_mmol_L, 0),
      citrateConcentration_mmol_L: cfg.citrate.conc,
      netUltrafiltration_mL_hr: num(state.netUltrafiltration_mL_hr),
      infused_mL_hr: num(state.nonCRRTIntake_mL_hr),
      postFilterFixed_mL_hr: cfg.citrate.post,
      minPre_mL_hr: cfg.heparin.minPre,
      minPost_mL_hr: cfg.heparin.minPost,
      ffPlasmaFactor: cfg.ffPlasmaFactor,
      overrides: state.hhsOverrides,
    });
  }

  // Write the HHS flows into the prescription. As in the spreadsheets, a flow
  // typed by hand keeps its value and the others keep recalculating.
  function applyHHSFlows(force = false) {
    if (!state.hhs) return;
    if (force) { state.hhsOverrides = {}; state.hhsFlowsEdited = false; }
    const r = computeHHS();
    state.dialysateFlow_mL_hr = r.dialysateFlow_mL_hr;
    state.replacementPre_mL_hr = r.replacementPre_mL_hr;
    state.replacementPost_mL_hr = r.replacementPost_mL_hr;
    state.setupGenerated = true;
    state.machineEdited = false;
  }

  function hhsFlowTyped(key, stateKey) {
    const v = num(state[stateKey]);
    state.hhsOverrides = Object.assign({}, state.hhsOverrides, { [key]: v });
    state.hhsFlowsEdited = true;
    applyHHSFlows();
  }

  function startHHS(kind) {
    const cfg = hhsCfg();
    state.hhsNotice = '';
    state.hhs = kind;
    state.hhsFlowsEdited = false;
    state.hhsOverrides = {};
    if (kind === 'citrate') {
      state.anticoag = 'citrate';
      state.modality = 'CVVHDF';
      state.solutionBrand = 'vantive';
      if (!['CA', 'EU', 'ALL'].includes(state.marketRegion)) state.marketRegion = 'CA';
      state.citrateProductId = cfg.citrate.productId;
      normalizeProductSelections();
      state.citrateTargetDose_mmol_L = cfg.citrate.dose;
      state.bloodFlow_mL_min = cfg.citrate.qb;
      state.targetDeliveredDose_mL_kg_hr = cfg.citrate.target;
    } else {
      state.anticoag = 'heparin';
      state.modality = cfg.heparin.modality;
      state.bloodFlow_mL_min = state.modality === 'CVVH' ? cfg.heparin.qbCVVH : cfg.heparin.qbCVVHDF;
      state.targetDeliveredDose_mL_kg_hr = cfg.heparin.target;
    }
    applyHHSFlows(true);
  }

  function stopHHS() {
    state.hhs = null;
    state.hhsFlowsEdited = false;
    state.hhsOverrides = {};
    state.setupGenerated = false;
    state.targetDeliveredDose_mL_kg_hr = 22.5;
  }

  function getCitrateFlow() {
    if (state.hhs === 'citrate') return computeHHS().citrateFlow_mL_hr;
    if (!citrateActive()) return 0;
    const conc = num(state.citrateConcentration_mmol_L);
    if (conc <= 0) return 0;
    const flow = C.citrateFlowFromTargetDose({
      bloodFlow_mL_min: num(state.bloodFlow_mL_min),
      targetCitrateDose_mmol_L: num(state.citrateTargetDose_mmol_L),
      citrateConcentration_mmol_L: conc,
    }).citrateFlow_mL_hr;
    return Number.isFinite(flow) && flow > 0 ? flow : 0;
  }

  // Single source of numeric inputs for every engine call.
  function engineInputs() {
    const noQd = state.modality === 'CVVH' || state.modality === 'SCUF';
    const noQr = state.modality === 'CVVHD' || state.modality === 'SCUF';
    return {
      weightKg: num(state.weightKg),
      hematocrit: hctFraction(),
      bloodFlow_mL_min: num(state.bloodFlow_mL_min),
      dialysateFlow_mL_hr: noQd ? 0 : num(state.dialysateFlow_mL_hr),
      replacementPre_mL_hr: noQr ? 0 : num(state.replacementPre_mL_hr),
      replacementPost_mL_hr: noQr ? 0 : num(state.replacementPost_mL_hr),
      // HHS: the machine removes the net goal plus infusions, and both count
      // in effluent and FF, as in the HHS spreadsheets.
      netUltrafiltration_mL_hr: num(state.netUltrafiltration_mL_hr) + (state.hhs ? num(state.nonCRRTIntake_mL_hr) : 0),
      citrateFlow_mL_hr: getCitrateFlow(),
      citratePreFilter: citrateActive() && !!state.citratePreFilter,
      uptimeFraction: num(state.uptimeFraction, 0.9),
      nonCRRTIntake_mL_hr: num(state.nonCRRTIntake_mL_hr),
      ffPlasmaFactor: state.hhs ? hhsCfg().ffPlasmaFactor : 1,
      ...ffLimits(),
    };
  }

  function computeDose() {
    const d = C.computeDoseAndFF(engineInputs());
    if (!state.hhs) return d;
    const r = computeHHS();
    const { ffCeiling, ffRedThreshold } = ffLimits();
    const ff = r.filtrationFraction;
    const ffFlag = !Number.isFinite(ff) || ff < 0 || ff > ffRedThreshold ? 'red' : ff > ffCeiling ? 'amber' : 'green';
    return Object.assign({}, d, { effluentRate_mL_hr: r.effluent_mL_hr, prescribedDose_mL_kg_hr: r.effluentDose_mL_kg_hr, filtrationFraction: ff, ffFlag, hhs: r });
  }

  function computeSuggestion() {
    const i = engineInputs();
    return C.suggestPrescription({
      weightKg: i.weightKg,
      hematocrit: i.hematocrit,
      modality: state.modality,
      bloodFlow_mL_min: i.bloodFlow_mL_min,
      targetDeliveredDose_mL_kg_hr: num(state.targetDeliveredDose_mL_kg_hr),
      uptimeFraction: i.uptimeFraction,
      netUltrafiltration_mL_hr: i.netUltrafiltration_mL_hr,
      citrateFlow_mL_hr: i.citrateFlow_mL_hr,
      citratePreFilter: i.citratePreFilter,
      preFilterShare: preFilterShare(),
      ffCeiling: i.ffCeiling,
      ffRedThreshold: i.ffRedThreshold,
    });
  }

  // -----------------------------------------------------------------------
  async function mount(root) {
    if (!CONFIG) CONFIG = await window.CRRTStore.loadConfig();
    if (!SOLUTIONS) SOLUTIONS = await window.CRRTStore.loadData('solutions');
    normalizeProductSelections();
    render(root);
  }

  function accent() {
    if (state.anticoag === 'citrate') return { cls: 'mod-citrate', v: '--citrate' };
    if (state.anticoag === 'heparin') return { cls: 'mod-heparin', v: '--heparin' };
    return { cls: 'mod-none', v: '--muted' };
  }

  function schematicFor(dose) {
    const i = engineInputs();
    return window.CRRTSchematic.render({
      qb_mL_min: i.bloodFlow_mL_min,
      prefilterActive: i.replacementPre_mL_hr > 0 || (i.citratePreFilter && i.citrateFlow_mL_hr > 0),
      postfilterActive: i.replacementPost_mL_hr > 0,
      ff: dose.filtrationFraction,
      accentVar: accent().v,
      ffCeiling: i.ffCeiling,
      ffRedThreshold: i.ffRedThreshold,
    });
  }

  function pressureReadout(dose) {
    return `<span>FF <span class="val">${fmt(dose.filtrationFraction * 100)}%</span></span>
              <span>Effluent <span class="val">${fmt(dose.effluentRate_mL_hr, 0)} mL/hr</span></span>`;
  }

  function render(root) {
    const dose = computeDose();
    const bmi = currentWeightMetrics();
    const suggestion = computeSuggestion();

    root.innerHTML = `
      <h1>Prescribe</h1>

      <div class="grid-2">
        <div>
          ${renderSetupCard(bmi, suggestion)}
          ${renderPlatformCard()}
          ${renderCircuitCard(dose)}
          ${state.anticoag === 'citrate' ? renderCitratePanel(dose) : ''}
          ${state.anticoag === 'heparin' ? renderHeparinPanel() : ''}
          ${state.anticoag === 'heparinized' ? renderHeparinizedPanel() : ''}
          ${renderSolutionsPanel(dose)}
        </div>
        <div>
          <div class="card schematic-wrap ${accent().cls}">
            <h3>Circuit</h3>
            ${schematicFor(dose)}
            <div class="pressure-readout">${pressureReadout(dose)}</div>
          </div>
        </div>
      </div>

      <div class="mobile-summary">
        <span><span id="mob-label">${mobileDoseLabel()}</span>: <strong id="mob-delivered">${mobileDoseValue(dose)}</strong></span>
        <span>FF: <strong id="mob-ff" class="flag ${dose.ffFlag}">${fmt(dose.filtrationFraction * 100)}%</strong></span>
      </div>
    `;

    wireEvents(root);
  }

  function selectedBrand() {
    return (SOLUTIONS?.brands || []).find(b => b.id === state.solutionBrand) || (SOLUTIONS?.brands || [])[0] || { products: [] };
  }

  function productById(id) {
    return (SOLUTIONS?.brands || []).flatMap(b => b.products || []).find(p => p.id === id) || null;
  }

  function productsForRole(role, includeAllRegions = false) {
    return (selectedBrand().products || []).filter(p => p.roles.includes(role) && (includeAllRegions || state.marketRegion === 'ALL' || p.regions.includes(state.marketRegion)));
  }

  function firstVerifiedProduct(role) {
    return productsForRole(role).find(p => p.compositionVerified) || null;
  }

  function normalizeProductSelections() {
    const keys = { dialysate: 'dialysateProductId', replacement: 'replacementProductId', citrate: 'citrateProductId' };
    Object.entries(keys).forEach(([role, key]) => {
      const current = productsForRole(role).find(p => p.id === state[key] && p.compositionVerified);
      if (!current) state[key] = firstVerifiedProduct(role)?.id || '';
    });
    const citrate = productById(state.citrateProductId);
    if (citrate?.compositionVerified && citrate.composition?.citrate) {
      state.citrateConcentration_mmol_L = citrate.composition.citrate;
      state.citratePreFilter = true;
    } else if (!state.citrateProductId) {
      state.citrateConcentration_mmol_L = 0;
    }
  }

  function renderPlatformCard() {
    const brand = selectedBrand();
    const citrate = productById(state.citrateProductId);
    return `
      <div class="card">
        <span class="eyebrow">Step 2</span>
        <h2>Select the institution's platform</h2>
        <div class="input-row aligned-row">
          <div class="field">
            <label for="marketRegion">Market</label>
            <select id="marketRegion">
              ${[['CA','Canada'],['US','United States'],['EU','Europe'],['ALL','Show all markets']].map(([id,label]) => `<option value="${id}" ${state.marketRegion === id ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="solutionBrand">Manufacturer / brand</label>
            <select id="solutionBrand">
              ${(SOLUTIONS?.brands || []).map(b => `<option value="${b.id}" ${state.solutionBrand === b.id ? 'selected' : ''}>${b.label}</option>`).join('')}
            </select>
          </div>
        </div>
        <p class="small muted">Platform: ${brand.platform || 'site-specific'}. Product connectors and integrated pumps may restrict compatible fluids. Pharmacy must confirm what is stocked and approved locally.</p>

        ${state.anticoag === 'citrate' ? `
        <div class="field mt-4">
          <label for="citrateProduct">Citrate product</label>
          <select id="citrateProduct">${renderProductOptions('citrate', state.citrateProductId)}</select>
          <div class="field-help">The selected concentration drives citrate-flow calculation. Confirm the local product, pump channel and RCA nomogram.</div>
        </div>
        ${citrate ? renderComposition(citrate, 'Citrate') : '<div class="warning-inline hard">No verified citrate product is listed for this brand and market. Citrate-flow calculation is disabled. Choose the actual citrate supplier or add the locally approved product to the catalogue.</div>'}` : ''}

        <div class="generate-btn-wrap">
          ${state.hhs === 'heparin' ? '<button type="button" class="secondary" id="hhsCustom">Customize flow rates (100 / 0 / 200)</button>' : ''}
          <button type="button" class="primary" id="generatePrescription" ${state.modality === 'SCUF' ? 'disabled' : ''}>${state.hhs === 'citrate' ? 'Suggested citrate flow rates' : state.hhs === 'heparin' ? `Suggested ${state.modality} flow rates` : state.setupGenerated ? 'Recalculate flows' : 'Generate starting prescription'}</button>
        </div>
      </div>`;
  }

  function renderSetupCard(bmi, suggestion) {
    const downtimePercent = (1 - num(state.uptimeFraction, 0.9)) * 100;
    const basePrescribedTarget = num(state.uptimeFraction) > 0
      ? num(state.targetDeliveredDose_mL_kg_hr) / num(state.uptimeFraction)
      : null;
    const kdigoLink = 'Please refer to <a href="https://kdigo.org/wp-content/uploads/2026/03/KDIGO-2026-AKI-AKD-Guideline-Public-Review-Draft-March-2026.pdf?utm_source=chatgpt.com" target="_blank" rel="noopener">KDIGO 2026 Clinical Practice Guideline for AKI and AKD</a> for further info.';
    const weightHelp = bmi.bmi === null
      ? `Use the unit-approved dosing weight. Add height and an IBW formula if ideal or adjusted weight is being considered. ${kdigoLink}`
      : bmi.bmi >= 30
        ? `BMI ${fmt(bmi.bmi)}. In high BMI, ideal or adjusted weight may avoid excessive initial CRRT dose. ${bmi.ibwKg ? `IBW ${fmt(bmi.ibwKg)} kg; adjusted weight ${fmt(bmi.adjustedBodyWeightKg)} kg.` : 'Select an IBW formula to calculate alternatives.'}`
        : `BMI ${fmt(bmi.bmi)}. Actual or pre-illness weight is generally used unless the local protocol specifies another basis.`;

    const target = num(state.targetDeliveredDose_mL_kg_hr);
    const targetOutsideKdigo = target < 20 || target > 25;

    return `
      <div class="card guidance-card setup-card">
        <span class="eyebrow">Step 1</span>
        <h2>Establish treatment target</h2>

        ${renderHHSControls()}

        <label>Anticoagulation strategy</label>
        <div class="btn-group" id="anticoagGroup">
          <button type="button" class="btn-toggle mod-citrate ${state.anticoag === 'citrate' ? 'selected' : ''}" data-anticoag="citrate">Regional citrate</button>
          <button type="button" class="btn-toggle mod-heparin ${state.anticoag === 'heparin' ? 'selected' : ''}" data-anticoag="heparin">Systemic heparin</button>
          <button type="button" class="btn-toggle mod-none ${state.anticoag === 'heparinized' ? 'selected' : ''}" data-anticoag="heparinized">Heparinized circuit only</button>
        </div>

        <div class="input-row aligned-row mt-4">
          <div class="field">
            <label for="actualWeightKg">Actual weight <span class="unit">kg</span></label>
            <input type="number" id="actualWeightKg" value="${state.actualWeightKg}" min="1" step="0.5">
          </div>
          <div class="field">
            <label for="heightCm">Height <span class="unit">cm, optional</span></label>
            <input type="number" id="heightCm" value="${state.heightCm ?? ''}" min="100" max="230" step="1">
          </div>
          <div class="field">
            <label for="sex">IBW formula</label>
            <select id="sex">
              <option value="unspecified" ${state.sex === 'unspecified' ? 'selected' : ''}>Not selected</option>
              <option value="male" ${state.sex === 'male' ? 'selected' : ''}>Devine male</option>
              <option value="female" ${state.sex === 'female' ? 'selected' : ''}>Devine female</option>
            </select>
          </div>
        </div>

        <div class="input-row aligned-row">
          <div class="field">
            <label for="weightBasis">Dosing-weight basis</label>
            <select id="weightBasis">
              <option value="actual" ${state.weightBasis === 'actual' ? 'selected' : ''}>Actual weight</option>
              <option value="ideal" ${state.weightBasis === 'ideal' ? 'selected' : ''} ${bmi.ibwKg ? '' : 'disabled'}>Ideal body weight${bmi.ibwKg ? `, ${fmt(bmi.ibwKg)} kg` : ''}</option>
              <option value="adjusted" ${state.weightBasis === 'adjusted' ? 'selected' : ''} ${bmi.adjustedBodyWeightKg ? '' : 'disabled'}>Adjusted body weight${bmi.adjustedBodyWeightKg ? `, ${fmt(bmi.adjustedBodyWeightKg)} kg` : ''}</option>
              <option value="custom" ${state.weightBasis === 'custom' ? 'selected' : ''}>Custom dosing weight</option>
            </select>
          </div>
          <div class="field">
            <label for="weightKg">Dosing weight <span class="unit">kg</span></label>
            <input type="number" id="weightKg" value="${state.weightKg}" min="1" step="0.5" ${state.weightBasis === 'custom' ? '' : 'readonly'}>
          </div>
        </div>
        <div class="field-help weight-guidance">${weightHelp}</div>
        ${adultGuardWarning() ? `<div class="warning-inline hard">${adultGuardWarning()}</div>` : ''}

        <div class="input-row aligned-row mt-4">
          <div class="field">
            <label for="hematocrit">Hematocrit <span class="unit">0.24 or 24%</span></label>
            <input type="number" id="hematocrit" value="${state.hematocrit}" min="0.1" max="60" step="0.01">
            <div class="field-help">${num(state.hematocrit) > 1 && num(state.hematocrit) <= 100 ? `Read as ${fmt(num(state.hematocrit), 0)}% (${fmt(hctFraction(), 2)}).` : 'Enter as a fraction (0.24) or a percentage (24), as on the HHS sheet. Used for plasma flow and FF.'}</div>
            ${num(state.hematocrit) > 100 || (state.hematocrit !== '' && num(state.hematocrit) <= 0) ? '<div class="warning-inline hard">Haematocrit not valid. Enter 0.24 or 24.</div>' : ''}
          </div>
          <div class="field">
            <label for="targetDeliveredDose">${state.hhs ? 'Target effluent dose (prescribed)' : 'Target delivered dose'} <span class="unit">mL/kg/hr</span></label>
            <input type="number" id="targetDeliveredDose" value="${state.targetDeliveredDose_mL_kg_hr}" min="10" max="40" step="0.5">
            <div class="field-help">${state.hhs ? `HHS: effluent ÷ weight, usual ${hhsCfg().doseMin}–${hhsCfg().doseMax}. No pre-dilution or downtime correction.` : 'Routine adult AKI target: 20–25 delivered.'}</div>
          </div>
          <div class="field">
            <label for="downtimePercent">Expected downtime <span class="unit">%</span></label>
            <input type="number" id="downtimePercent" value="${fmt(downtimePercent, 0)}" min="0" max="50" step="1">
            <div class="field-help">Use your unit's observed downtime. Default 10%.</div>
          </div>
        </div>
        ${state.hhs && (target < hhsCfg().doseMin || target > hhsCfg().doseMax) ? `<div class="warning-inline">The target of ${fmt(target)} mL/kg/hr is outside the HHS usual range of ${hhsCfg().doseMin}–${hhsCfg().doseMax} mL/kg/hr (prescribed effluent). Confirm this is intended.</div>` : ''}
        ${!state.hhs && state.modality !== 'SCUF' && targetOutsideKdigo ? `<div class="warning-inline">The target of ${fmt(target)} mL/kg/hr is outside the KDIGO 20–25 mL/kg/hr delivered range. Confirm this is intended.</div>` : ''}

        <label>Modality</label>
        <div class="btn-group" id="modalityGroup">
          ${['CVVHDF', 'CVVHD', 'CVVH', 'SCUF'].map(m => `<button type="button" class="btn-toggle ${state.modality === m ? 'selected' : ''}" data-modality="${m}" ${hhsAllowedModalities().includes(m) ? '' : 'disabled title="Not part of the HHS protocol"'}>${m}</button>`).join('')}
        </div>

        ${state.hhs ? `<div id="hhs-summary">${renderHHSSummary()}</div>` : state.modality === 'SCUF'
          ? '<div class="warning-inline">SCUF targets fluid removal rather than a delivered small-solute dose. Set net UF in the editable prescription below.</div>'
          : `<div class="setup-summary"><span>Delivered target <strong>${fmt(target)}</strong></span><span>Downtime <strong>${fmt(downtimePercent, 0)}%</strong></span><span>Downtime-only target <strong>${fmt(basePrescribedTarget)} mL/kg/hr</strong></span></div>
             <p class="small muted">The generated flows also correct for citrate and other pre-filter dilution, then round machine flows to 50 mL/hr. ${state.setupGenerated ? `Current generated prediction: ${fmt(suggestion.predictedDeliveredDose_mL_kg_hr)} mL/kg/hr delivered at FF ${fmt(suggestion.predictedFiltrationFraction * 100)}%.` : 'Generate the starting prescription, then edit any machine setting below.'}</p>
             ${state.setupGenerated && suggestion.targetAchieved === false
               ? `<div class="warning-inline hard"><strong>Target dose not reached.</strong> The generated prescription delivers ${fmt(suggestion.predictedDeliveredDose_mL_kg_hr)} mL/kg/hr rather than the ${fmt(target)} requested. See the reason below.</div>`
               : ''}
             ${state.setupGenerated && suggestion.warnings && suggestion.warnings.length
               ? suggestion.warnings.map(w => `<div class="warning-inline generator-warning">${w}</div>`).join('')
               : ''}`}
      </div>`;
  }

  // ---- HHS protocol UI ----------------------------------------------------
  function renderHHSControls() {
    const label = hhsCfg().label;
    return `
        <div class="hhs-protocol">
          <span class="hhs-protocol-label">Local protocol</span>
          <div class="btn-group">
            <button type="button" class="btn-toggle mod-citrate ${state.hhs === 'citrate' ? 'selected' : ''}" data-hhs="citrate" aria-pressed="${state.hhs === 'citrate'}">${label}: Regional citrate</button>
            <button type="button" class="btn-toggle mod-heparin ${state.hhs === 'heparin' ? 'selected' : ''}" data-hhs="heparin" aria-pressed="${state.hhs === 'heparin'}">${label}: Heparin</button>
          </div>
          ${!state.hhs && state.hhsNotice ? `<div class="warning-inline">${state.hhsNotice}</div>` : ''}
          ${state.hhs ? `<div class="hhs-banner">
            <strong>${label} active (${state.hhs === 'citrate' ? 'regional citrate' : 'heparin or no anticoagulation'}).</strong>
            Flows follow the HHS spreadsheet and update as you change weight, target, blood flow${state.hhs === 'citrate' ? ', citrate dose' : ''}, net fluid removal or infusions. The target is the effluent dose (effluent ÷ weight), as on the sheet.
            <button type="button" class="secondary" id="hhsExit">Exit ${label}</button>
          </div>` : ''}
        </div>`;
  }

  function renderHHSSummary() {
    const r = computeHHS();
    const dose = computeDose();
    const i = engineInputs();
    const cfg = hhsCfg();
    const how = state.hhs === 'citrate'
      ? `Citrate ${fmt(r.citrateFlow_mL_hr, 0)} mL/hr pre-blood pump, post-filter ${fmt(r.replacementPost_mL_hr, 0)} mL/hr, the rest as dialysate.`
      : state.modality === 'CVVH'
        ? 'CVVH: half pre-filter (PBP), half post-filter.'
        : 'CVVHDF: 25% pre-filter (PBP), 50% dialysate, 25% post-filter.';
    return `
      <div class="setup-summary"><span>Effluent <strong>${fmt(r.effluent_mL_hr, 0)} mL/hr</strong></span><span>Effluent dose <strong>${fmt(r.effluentDose_mL_kg_hr)}</strong></span><span>FF <strong>${fmt(r.filtrationFraction * 100)}%</strong></span></div>
      <p class="small muted">${how} Machine fluid removal = net UF + infusions = ${fmt(r.machineFluidRemoval_mL_hr, 0)} mL/hr. Estimated delivered dose after pre-dilution and ${fmt((1 - i.uptimeFraction) * 100, 0)}% downtime: ${fmt(dose.correctedDeliveredDose_mL_kg_hr)} mL/kg/hr.${state.hhsFlowsEdited ? ` Typed by hand: ${Object.keys(state.hhsOverrides).map(k => ({ qd: 'dialysate', pre: 'pre-filter', post: 'post-filter' })[k]).join(', ')}; the other flows still follow the protocol.` : ''}</p>
      ${r.warnings.map(w => `<div class="warning-inline generator-warning">${w}</div>`).join('')}`;
  }

  // In HHS mode the effluent dose is the protocol's target basis.
  function mobileDoseLabel() { return state.hhs ? 'Effluent dose' : 'Delivered dose'; }
  function mobileDoseValue(dose) {
    return fmt(state.hhs ? dose.prescribedDose_mL_kg_hr : dose.correctedDeliveredDose_mL_kg_hr) + ' mL/kg/hr';
  }

  // ---- adult-only guard ---------------------------------------------------
  const ADULT_MIN_WEIGHT_KG = 30;
  function adultGuardWarning() {
    const actual = num(state.actualWeightKg);
    const dosing = num(state.weightKg);
    const low = (actual > 0 && actual < ADULT_MIN_WEIGHT_KG) || (dosing > 0 && dosing < ADULT_MIN_WEIGHT_KG);
    return low
      ? `This calculator is designed for adults. A weight below ${ADULT_MIN_WEIGHT_KG} kg is outside its intended use: paediatric CRRT uses different blood flows, circuit priming, dose targets and anticoagulation. Use a paediatric protocol and consult paediatric nephrology or critical care.`
      : '';
  }

  // ---- Step 3 output helpers (shared by render and live update) ----------

  function outputRows(dose) {
    return {
      'out-effluent': fmt(dose.effluentRate_mL_hr, 0) + ' mL/hr',
      'out-prescribed': fmt(dose.prescribedDose_mL_kg_hr) + ' mL/kg/hr',
      'out-corrected': fmt(dose.correctedDose_mL_kg_hr) + ' mL/kg/hr',
      'out-delivered': fmt(dose.correctedDeliveredDose_mL_kg_hr) + ' mL/kg/hr',
      'out-ff': fmt(dose.filtrationFraction * 100) + '% ',
      'out-totaluf': fmt(dose.totalUltrafiltration_mL_hr, 0) + ' mL/hr',
      'out-balance': fmt(dose.estimatedPatientBalance_mL_hr, 0) + ' mL/hr',
      'out-machineuf': fmt(num(state.netUltrafiltration_mL_hr) + num(state.nonCRRTIntake_mL_hr), 0) + ' mL/hr',
      'out-pbp': fmt(getCitrateFlow(), 0) + ' mL/hr',
      ...(dose.hhs ? {
        'out-ff': fmt(dose.filtrationFraction * 100) + '% (sheet shows ' + (Number.isFinite(dose.filtrationFraction) ? Math.round(dose.filtrationFraction * 100 + 1e-9) : '–') + '%) ',
        'out-deviation': (dose.hhs.doseDeviation_mL_kg_hr > 0 ? '+' : '') + fmt(dose.hhs.doseDeviation_mL_kg_hr) + ' mL/kg/hr',
        'out-prepost': (Number.isFinite(dose.hhs.percentPreFilter) ? Math.round(dose.hhs.percentPreFilter * 100 + 1e-9) + '% / ' + Math.round(dose.hhs.percentPostFilter * 100 + 1e-9) + '%' : '–'),
        'out-machineuf': fmt(dose.hhs.machineFluidRemoval_mL_hr, 0) + ' mL/hr',
        'out-current': fmt(dose.prescribedDose_mL_kg_hr) + ' mL/kg/hr effluent dose',
      } : {}),
    };
  }

  // Warnings about the CURRENT machine settings (after any manual edits).
  function currentSettingWarnings(dose) {
    const { ffCeiling, ffRedThreshold } = ffLimits();
    const out = [];
    const ceilingPct = Math.round(ffCeiling * 100);
    const redPct = Math.round(ffRedThreshold * 100);
    if (!Number.isFinite(dose.filtrationFraction) || !Number.isFinite(dose.correctedDeliveredDose_mL_kg_hr)) {
      out.push({ hard: true, text: 'The dose and filtration fraction cannot be calculated from the current inputs. Check that weight, blood flow and haematocrit are above zero and haematocrit is below 1.' });
      return out;
    }
    const i = engineInputs();
    if ([i.bloodFlow_mL_min, i.dialysateFlow_mL_hr, i.replacementPre_mL_hr, i.replacementPost_mL_hr, i.netUltrafiltration_mL_hr].some(v => v < 0)) {
      out.push({ hard: true, text: 'A flow or fluid-removal rate is negative. Enter zero or a positive value.' });
    }
    if (dose.prescribedDose_mL_kg_hr > 40) out.push({ hard: true, text: 'Prescribed dose above trial-tested range. RENAL and ATN showed no benefit over 20–25 mL/kg/hr delivered.' });
    if (dose.ffFlag === 'amber') out.push({ hard: false, text: `FF above the ${ceilingPct}% protocol ceiling: increasing haemoconcentration and filter-clotting risk. Consider increasing Qb, shifting replacement pre-filter, or reducing convective flow.` });
    if (dose.ffFlag === 'red') out.push({ hard: true, text: `FF above ${redPct}%: high haemoconcentration risk. Review blood flow and the pre/post replacement split.` });
    if (state.hhs === 'citrate') {
      const cd = num(state.citrateTargetDose_mmol_L, NaN);
      if (!(cd > 0)) out.push({ hard: true, text: 'Enter a citrate dose (mmol/L). With no dose, PBP citrate is 0.' });
      else if (cd > 6) out.push({ hard: true, text: `Citrate dose ${fmt(cd)} mmol/L is far above the usual 2–4. Enter the dose in mmol/L (2.0), not the sheet's hidden spinner value (20).` });
    }
    if (state.hhs) {
      const target = num(state.targetDeliveredDose_mL_kg_hr);
      const eff = dose.prescribedDose_mL_kg_hr;
      if (target > 0 && Math.abs(eff - target) > 2.5) {
        out.push({ hard: false, text: `Current settings give an effluent dose of ${fmt(eff)} mL/kg/hr, ${eff < target ? 'below' : 'above'} the ${fmt(target)} mL/kg/hr HHS target. Use the suggested flow rates button to restore the protocol flows.` });
      }
    } else if (!state.hhs && state.modality !== 'SCUF') {
      const target = num(state.targetDeliveredDose_mL_kg_hr);
      const delivered = dose.correctedDeliveredDose_mL_kg_hr;
      if (target > 0 && Math.abs(delivered - target) > 2.5) {
        out.push({ hard: false, text: `Current settings deliver ${fmt(delivered)} mL/kg/hr, ${delivered < target ? 'below' : 'above'} the ${fmt(target)} mL/kg/hr target. ${delivered < target ? 'Increase dialysate or replacement, or use Generate starting prescription.' : 'Reduce dialysate or replacement unless a higher dose is intended.'}` });
      }
    }
    return out;
  }

  function renderCurrentWarnings(dose) {
    return currentSettingWarnings(dose).map(w => `<div class="warning-inline${w.hard ? ' hard' : ''}">${w.text}</div>`).join('');
  }

  function renderCircuitCard(dose) {
    const i = engineInputs();
    return `
    <div class="card">
      <span class="eyebrow">Step 3</span>
      <h2>Review and edit machine settings</h2>
      ${state.setupGenerated ? `
        <div class="guidance-grid">
          <div class="guidance-item"><strong>${state.hhs ? `${hhsCfg().label} flows for` : 'Generated for'} ${fmt(num(state.weightKg))} kg</strong><span>${state.modality}, ${state.anticoag === 'citrate' ? 'regional citrate' : state.anticoag === 'heparin' ? 'systemic heparin' : 'heparinized circuit only'}.</span></div>
          ${state.hhs ? `<div class="guidance-item"><strong id="out-current">${fmt(dose.prescribedDose_mL_kg_hr)} mL/kg/hr effluent dose</strong><span>Effluent ÷ weight, as on the HHS sheet.</span></div>` : `<div class="guidance-item"><strong>${fmt(dose.correctedDeliveredDose_mL_kg_hr)} mL/kg/hr current</strong><span>Includes ${fmt((1 - i.uptimeFraction) * 100, 0)}% downtime and pre-filter dilution.${state.machineEdited ? ' Machine settings have been edited.' : ''}</span></div>`}
        </div>` : '<div class="warning-inline">Use Generate starting prescription above to calculate recommended values. Calculations will automatically update with changes to these fields.</div>'}

      <div class="input-row aligned-row mt-4">
        <div class="field">
          <label for="bloodFlow">Blood flow (Qb) <span class="unit">mL/min</span></label>
          <input type="number" id="bloodFlow" value="${state.bloodFlow_mL_min}" min="0" step="10">
          <div class="field-help">${state.hhs === 'citrate' ? `HHS default ${hhsCfg().citrate.qb} mL/min. Citrate flow follows blood flow.` : state.hhs === 'heparin' ? 'HHS: 200–300 mL/min for CVVHDF, 250–350 for CVVH. Adjust to keep FF under 25%.' : 'Suggested 150. A typical adult range is 100–200, limited by access and machine pressures.'}</div>
        </div>
        ${state.modality !== 'CVVH' && state.modality !== 'SCUF' ? `
        <div class="field">
          <label for="dialysateFlow">Dialysate (Qd) <span class="unit">mL/hr</span></label>
          <input type="number" id="dialysateFlow" value="${state.dialysateFlow_mL_hr}" min="0" step="50">
          <div class="field-help">${state.hhs === 'citrate' ? 'HHS: whatever effluent remains after citrate, post-filter replacement, net UF and infusions.' : state.hhs === 'heparin' ? 'HHS button: half of (target × weight − net removal − infusions).' : 'Suggested by the guided panel from the remaining clearance requirement.'}</div>
        </div>` : ''}
      </div>
      ${i.bloodFlow_mL_min > (state.hhs === 'heparin' ? 350 : 250) ? `<div class="warning-inline">Qb above ${state.hhs === 'heparin' ? 350 : 250} mL/min is access-dependent. Confirm catheter and access pressure limits.</div>` : ''}

      ${state.modality !== 'CVVHD' && state.modality !== 'SCUF' ? `<div class="input-row aligned-row">
        ${state.hhs === 'citrate' ? `<div class="field">
          <label for="hhsCitrateDose">Citrate dose <span class="unit">mmol/L</span></label>
          <input type="number" id="hhsCitrateDose" value="${state.citrateTargetDose_mmol_L}" min="0" max="6" step="0.1">
          <div class="field-help">The sheet's "Citrate Concentration". HHS default ${fmt(hhsCfg().citrate.dose)}; adjust per nomogram.</div>
          <label class="mt-4">Pre blood pump (PBP): citrate</label>
          <div class="readonly-value" id="out-pbp">${fmt(getCitrateFlow(), 0)} mL/hr</div>
          <div class="field-help">Qb × citrate dose × 60 ÷ ${fmt(hhsCfg().citrate.conc, 0)}, as on the sheet. Change Qb or citrate dose to change it.</div>
        </div>` : `<div class="field">
          <label for="replacementPre">${state.hhs ? 'Pre-blood pump (PBP) replacement' : 'Pre-dilution replacement'} <span class="unit">mL/hr</span></label>
          <input type="number" id="replacementPre" value="${state.replacementPre_mL_hr}" min="0" step="50">
          <div class="field-help">${state.hhs === 'heparin' ? `HHS button: ${state.modality === 'CVVH' ? 'half' : 'a quarter'} of (target × weight − net removal − infusions). Sheet minimum for custom flows ${hhsCfg().heparin.minPre} mL/hr.` : 'Improves filter rheology and lowers FF, but dilutes solute before the membrane.'}</div>
        </div>`}
        <div class="field">
          <label for="replacementPost">${state.hhs ? 'Post-filter replacement' : 'Post-dilution replacement'} <span class="unit">mL/hr</span></label>
          <input type="number" id="replacementPost" value="${state.replacementPost_mL_hr}" min="0" step="50">
          <div class="field-help">${state.hhs === 'citrate' ? `HHS default ${hhsCfg().citrate.post} mL/hr (the sheet's Suggested citrate flow rates button). If you change it, dialysate recalculates.` : state.hhs === 'heparin' ? `HHS button: ${state.modality === 'CVVH' ? 'half' : 'a quarter'} of (target × weight − net removal − infusions). Sheet minimum for custom flows ${hhsCfg().heparin.minPost} mL/hr.` : 'More clearance-efficient, but increases haemoconcentration when FF rises.'}</div>
        </div>
      </div>` : ''}

      <div class="input-row aligned-row">
        <div class="field">
          <label for="netUF">${state.hhs ? 'Net hourly fluid removal (patient goal)' : 'Net UF / patient fluid removal'} <span class="unit">mL/hr</span></label>
          <input type="number" id="netUF" value="${state.netUltrafiltration_mL_hr}" min="0" step="10">
          <div class="field-help">${state.hhs ? 'The net amount you want off the patient each hour. The machine removes this plus the infusions.' : 'Start from the fluid goal and current tolerance. Use 0 mL/hr when active fluid removal is unsafe.'}</div>
        </div>
        <div class="field">
          <label for="nonCRRTIntake">${state.hhs ? 'Total hourly infused fluids' : 'Other fluid intake'} <span class="unit">${state.hhs ? 'mL/hr' : 'mL/hr (optional)'}</span></label>
          <input type="number" id="nonCRRTIntake" value="${state.nonCRRTIntake_mL_hr}" min="0" step="10">
          <div class="field-help">${state.hhs ? 'Infusions currently running. HHS removes these through the machine, so they add to effluent, dose and FF.' : 'Optional hourly intake estimate. It does not include urine, drains, or other outputs.'}</div>
        </div>
      </div>

      ${state.hhs ? (() => { const r = outputRows(dose); return `
      <div class="output-block">
        <div class="output-row"><span class="label">Total effluent</span><span class="value" id="out-effluent">${r['out-effluent']}</span></div>
        <div class="output-row"><span class="label">Effluent dose (sheet: "Effluent Dose Delivered")</span><span class="value big" id="out-prescribed">${r['out-prescribed']}</span></div>
        <div class="output-row"><span class="label">Deviation from dose goal</span><span class="value" id="out-deviation">${r['out-deviation']}</span></div>
        <div class="output-row"><span class="label">Filtration fraction (HHS formula)</span><span class="value"><span id="out-ff">${r['out-ff']}</span><span class="flag ${dose.ffFlag}" id="out-ff-badge">${dose.ffFlag}</span></span></div>
        <div class="output-row"><span class="label">% pre-filter / % post-filter (as on the sheet)</span><span class="value" id="out-prepost">${r['out-prepost']}</span></div>
        <div class="output-row"><span class="label">Machine fluid removal setting (net removal + infusions)</span><span class="value" id="out-machineuf">${r['out-machineuf']}</span></div>
      </div>`; })() : (() => { const r = outputRows(dose); return `
      <div class="output-block">
        <div class="output-row"><span class="label">Effluent rate</span><span class="value" id="out-effluent">${r['out-effluent']}</span></div>
        <div class="output-row"><span class="label">${state.hhs ? 'Effluent dose (HHS target basis)' : 'Prescribed dose'}</span><span class="value${state.hhs ? ' big' : ''}" id="out-prescribed">${r['out-prescribed']}</span></div>
        <div class="output-row"><span class="label">Pre-dilution corrected dose</span><span class="value" id="out-corrected">${r['out-corrected']}</span></div>
        <div class="output-row"><span class="label">${state.hhs ? 'Estimated delivered dose (corrected × uptime)' : 'Delivered dose (corrected × uptime)'}</span><span class="value${state.hhs ? '' : ' big'}" id="out-delivered">${r['out-delivered']}</span></div>
        <div class="output-row"><span class="label">${state.hhs ? 'Filtration fraction (HHS formula)' : 'Filtration fraction'}</span><span class="value"><span id="out-ff">${r['out-ff']}</span><span class="flag ${dose.ffFlag}" id="out-ff-badge">${dose.ffFlag}</span></span></div>
        <div class="output-row"><span class="label">Total UF (crosses membrane)</span><span class="value" id="out-totaluf">${r['out-totaluf']}</span></div>
        ${state.hhs ? `<div class="output-row"><span class="label">Machine fluid removal setting (net UF + infusions)</span><span class="value" id="out-machineuf">${r['out-machineuf']}</span></div>` : ''}
        <div class="output-row"><span class="label">${state.hhs ? 'Patient net balance' : 'Estimated balance from entered intake and net UF'}</span><span class="value" id="out-balance">${r['out-balance']}</span></div>
      </div>`; })()}
      <div id="out-warnings">${renderCurrentWarnings(dose)}</div>

      ${state.hhs ? (() => { const h = dose.hhs; const hf = hctFraction(); return `<details class="working">
        <summary>Show working (HHS sheet formulas)</summary>
        <div class="formula">${state.hhs === 'citrate'
  ? `PBP (citrate) = Qb × citrate dose × 60 ÷ ${fmt(hhsCfg().citrate.conc, 0)}
 = ${fmt(num(state.bloodFlow_mL_min), 0)} × ${fmt(num(state.citrateTargetDose_mmol_L), 1)} × 60 ÷ ${fmt(hhsCfg().citrate.conc, 0)} = ${fmt(h.citrateFlow_mL_hr, 0)} mL/hr
dialysate = ROUND50(MAX(0, target × weight − PBP − post − net removal − infusions))${state.hhsOverrides.qd !== undefined ? '  (typed by hand: ' + fmt(h.dialysateFlow_mL_hr, 0) + ')' : `
 = ROUND50(MAX(0, ${fmt(num(state.targetDeliveredDose_mL_kg_hr))} × ${fmt(num(state.weightKg))} − ${fmt(h.citrateFlow_mL_hr, 0)} − ${fmt(h.replacementPost_mL_hr, 0)} − ${fmt(h.machineFluidRemoval_mL_hr - Math.max(0, num(state.nonCRRTIntake_mL_hr)), 0)} − ${fmt(Math.max(0, num(state.nonCRRTIntake_mL_hr)), 0)})) = ${fmt(h.dialysateFlow_mL_hr, 0)} mL/hr`}`
  : `X = target × weight − net removal − infusions = ${fmt(num(state.targetDeliveredDose_mL_kg_hr))} × ${fmt(num(state.weightKg))} − ${fmt(Math.max(0, num(state.netUltrafiltration_mL_hr)), 0)} − ${fmt(Math.max(0, num(state.nonCRRTIntake_mL_hr)), 0)}
${state.modality === 'CVVH' ? 'pre = ROUND50(X/2), post = ROUND50(X/2)' : 'pre = ROUND50(X/4), dialysate = ROUND50(X/2), post = ROUND50(X/4)'}${state.hhsFlowsEdited ? '  (typed by hand: ' + Object.keys(state.hhsOverrides).join(', ') + ')' : ''}
 → pre ${fmt(h.replacementPre_mL_hr, 0)}, dialysate ${fmt(h.dialysateFlow_mL_hr, 0)}, post ${fmt(h.replacementPost_mL_hr, 0)} mL/hr`}

total effluent = PBP + dialysate + post + net removal + infusions
 = ${fmt(h.citrateFlow_mL_hr + h.replacementPre_mL_hr, 0)} + ${fmt(h.dialysateFlow_mL_hr, 0)} + ${fmt(h.replacementPost_mL_hr, 0)} + ${fmt(Math.max(0, num(state.netUltrafiltration_mL_hr)), 0)} + ${fmt(Math.max(0, num(state.nonCRRTIntake_mL_hr)), 0)} = ${fmt(h.effluent_mL_hr, 0)} mL/hr
effluent dose = ${fmt(h.effluent_mL_hr, 0)} ÷ ${fmt(num(state.weightKg))} = ${fmt(h.effluentDose_mL_kg_hr)} mL/kg/hr

FF = (effluent − dialysate) ÷ (Qb × 60 × (1 − Hct) × ${hhsCfg().ffPlasmaFactor} + PBP)
 = (${fmt(h.effluent_mL_hr, 0)} − ${fmt(h.dialysateFlow_mL_hr, 0)}) ÷ (${fmt(num(state.bloodFlow_mL_min), 0)} × 60 × (1 − ${fmt(hf, 2)}) × ${hhsCfg().ffPlasmaFactor} + ${fmt(h.citrateFlow_mL_hr + h.replacementPre_mL_hr, 0)}) = ${fmt(h.filtrationFraction * 100, 2)}%

Not on the sheet: estimated delivered dose after pre-dilution and ${fmt((1 - num(state.uptimeFraction, 0.9)) * 100, 0)}% downtime = ${fmt(dose.correctedDeliveredDose_mL_kg_hr)} mL/kg/hr.</div>
      </details>`; })() : `<details class="working">
        <summary>Show working</summary>
        <div class="formula">effluent = Qd + replacementPre + replacementPost + netUF (+ citrate if pre-filter)
         = ${fmt(i.dialysateFlow_mL_hr, 0)} + ${fmt(i.replacementPre_mL_hr, 0)} + ${fmt(i.replacementPost_mL_hr, 0)} + ${fmt(i.netUltrafiltration_mL_hr, 0)} + ${fmt(dose.citrateAsPreDilution_mL_hr, 0)}
         = ${fmt(dose.effluentRate_mL_hr, 0)} mL/hr

prescribed dose = effluent / weight = ${fmt(dose.effluentRate_mL_hr, 0)} / ${fmt(i.weightKg)} = ${fmt(dose.prescribedDose_mL_kg_hr)} mL/kg/hr

plasma flow = Qb × 60 × (1 − Hct)
 = ${fmt(i.bloodFlow_mL_min, 0)} × 60 × (1 − ${fmt(i.hematocrit, 2)}) = ${fmt(dose.plasmaFlow_mL_hr, 0)} mL/hr

dilution factor = plasma flow / (plasma flow + pre-dilution total) = ${fmt(dose.dilutionFactor, 3)}
corrected dose = prescribed × dilution factor = ${fmt(dose.correctedDose_mL_kg_hr)} mL/kg/hr
delivered = corrected × uptime (${fmt(i.uptimeFraction, 2)}) = ${fmt(dose.correctedDeliveredDose_mL_kg_hr)} mL/kg/hr

FF = (replacementPre + replacementPost + citrate pre-filter + netUF) / (plasma flow + pre-dilution total) = ${fmt(dose.filtrationFraction * 100)}%
FF ceiling in use: ${fmt(i.ffCeiling * 100, 0)}% (config/local-protocol.json)${state.hhs ? `

HHS protocol (${state.hhs}):
${state.hhs === 'citrate'
  ? `citrate (PBP) = Qb × citrate dose × 60 ÷ ${fmt(num(state.citrateConcentration_mmol_L), 0)}
dialysate = ROUND50(target × weight − citrate − post ${fmt(num(state.replacementPost_mL_hr), 0)} − net UF − infusions)`
  : `X = target × weight − net UF − infusions
${state.modality === 'CVVH' ? 'pre = ROUND50(X/2), post = ROUND50(X/2)' : 'pre = ROUND50(X/4), dialysate = ROUND50(X/2), post = ROUND50(X/4)'}  (minimums: pre ${fmt(hhsCfg().heparin.minPre, 0)}, post ${fmt(hhsCfg().heparin.minPost, 0)})`}
effluent dose = effluent ÷ weight
FF (HHS) = (effluent − dialysate) ÷ (Qb × 60 × (1 − Hct) × ${hhsCfg().ffPlasmaFactor} + pre-filter fluid)` : ''}</div>
      </details>`}
    </div>`;
  }

  // -----------------------------------------------------------------------
  function renderCitratePanel(dose) {
    const citrateProduct = productById(state.citrateProductId);
    const citrateAvailable = !!(citrateProduct?.compositionVerified && num(citrateProduct.composition?.citrate) > 0);
    const citrateFlow = getCitrateFlow();
    const doseCheck = C.citrateDoseFromFlow({
      citrateFlow_mL_hr: citrateFlow,
      citrateConcentration_mmol_L: num(state.citrateConcentration_mmol_L),
      bloodFlow_mL_min: num(state.bloodFlow_mL_min),
    });

    const caLoss = C.estimateCalciumLoss({
      effluentRate_mL_hr: dose.effluentRate_mL_hr,
      effluentTotalCa_mmol_L: num(state.effluentTotalCa_mmol_L),
    });

    let accumulation = null;
    if (state.totalCa_mmol_L !== '' && state.systemicICa_mmol_L !== '') {
      accumulation = C.citrateAccumulationCheck({
        totalCa_mmol_L: num(state.totalCa_mmol_L),
        systemicICa_mmol_L: num(state.systemicICa_mmol_L),
      });
      if (!Number.isFinite(accumulation.caRatio)) accumulation = null;
    }

    let acidBase = null;
    if (state.pH !== '' && state.hco3_mmol_L !== '' && accumulation) {
      acidBase = C.citrateAcidBasePattern({
        pH: num(state.pH),
        hco3_mmol_L: num(state.hco3_mmol_L),
        caRatio: accumulation.caRatio,
      });
    }

    const acidBaseCopy = {
      alkalosis: { title: 'Metabolic alkalosis', body: 'Excess citrate delivery relative to clearance/metabolism. Reduce citrate dose, increase effluent flow, or reduce dialysate bicarbonate.', cls: 'amber' },
      acidosis_underbuffering: { title: 'Metabolic acidosis: under-buffering', body: 'Normal calcium ratio. Increase bicarbonate (dialysate or systemic).', cls: 'amber' },
      acidosis_accumulation: { title: 'Metabolic acidosis: citrate accumulation', body: 'High calcium ratio. This is a metabolism failure, not under-buffering; reduce or stop citrate rather than adding buffer.', cls: 'red' },
      normal: { title: 'No acid-base concern flagged', body: '', cls: 'green' },
    };

    const citrateAlert = !citrateAvailable || doseCheck.doseFlag === 'red' || (accumulation && accumulation.accumulationFlag) || acidBase === 'acidosis_accumulation';
    return `
    <details class="card accent-card mod-citrate collapsible" id="panel-citrate" ${state.ui.citrateOpen ? 'open' : ''}>
      <summary>
        <h2><span class="tag">Citrate</span> Regional citrate anticoagulation</h2>
        <span class="collapsed-hint">${citrateAvailable ? `Citrate ${fmt(citrateFlow, 0)} mL/hr` : 'No citrate product selected'}${citrateAlert ? ' <span class="flag red">review</span>' : ''}</span>
      </summary>
      <p class="small muted">Please defer to local protocols and nomogram.</p>
      ${!citrateAvailable ? '<div class="warning-inline hard">No verified citrate product is selected. Choose the actual product in Step 2 before using any citrate-flow result.</div>' : ''}

      <div class="field">
        <label>Selected citrate source</label>
        <div class="output-block"><div class="output-row"><span class="label">${citrateProduct?.name || 'No verified citrate product available for this brand and market'}</span><span class="value">${citrateProduct?.composition?.citrate ? `${citrateProduct.composition.citrate} mmol/L` : 'not selected'}</span></div></div>
        <div class="small muted">Select or change the product in Step 2. Confirm the formulation and machine-specific workflow locally.</div>
      </div>

      <div class="input-row aligned-row">
        <div class="field">
          <label for="citrateConc">Citrate concentration <span class="unit">mmol/L</span></label>
          <input type="number" id="citrateConc" value="${state.citrateConcentration_mmol_L}" min="1" step="0.5" ${citrateProduct?.compositionVerified ? 'disabled' : ''}>
          <div class="field-help">Taken from the selected product. Verify the exact local formulation.</div>
        </div>
        <div class="field">
          <label for="citrateTargetDose">Target citrate dose <span class="unit">mmol/L blood</span></label>
          <input type="number" id="citrateTargetDose" value="${state.citrateTargetDose_mmol_L}" min="1" max="6" step="0.1" ${citrateAvailable ? '' : 'disabled'}>
          <div class="field-help">${state.hhs === 'citrate' ? `HHS default ${fmt(hhsCfg().citrate.dose)}; adjust per the HHS nomogram. Also editable in Step 3.` : 'Suggested starting dose 3.0. A generic range is 3–4, then titrate to post-filter iCa using the local nomogram.'}</div>
        </div>
      </div>

      <div class="output-block">
        <div class="output-row"><span class="label">Citrate infusion rate</span><span class="value big">${citrateAvailable ? `${fmt(citrateFlow)} mL/hr` : 'not available'}</span></div>
        <div class="output-row"><span class="label">Actual delivered dose</span><span class="value">${citrateAvailable ? `${fmt(doseCheck.actualCitrateDose_mmol_L, 2)} mmol/L <span class="flag ${doseCheck.doseFlag}">${doseCheck.doseFlag}</span>` : 'not available'}</span></div>
      </div>
      ${state.citratePreFilter ? `<div class="warning-inline">This solution is counted as pre-filter (pre-dilution) fluid above; it changes effluent dose and the pre-dilution correction.</div>` : ''}

      ${citrateAvailable ? `<details class="working">
        <summary>Show working</summary>
        <div class="formula">citrate flow = target dose × Qb × 60 / concentration
 = ${fmt(num(state.citrateTargetDose_mmol_L), 2)} × ${fmt(num(state.bloodFlow_mL_min), 0)} × 60 / ${fmt(num(state.citrateConcentration_mmol_L), 0)} = ${fmt(citrateFlow)} mL/hr</div>
      </details>` : ''}

      <h3 class="mt-4">Calcium replacement</h3>
      <div class="warning-inline">The app estimates elemental calcium loss only. It does not convert that estimate into a stock calcium-product infusion, because prepared bag concentrations and starting nomograms are site-specific.</div>
      <div class="input-row aligned-row">
        <div class="field">
          <label for="effluentTotalCa">Effluent total Ca <span class="unit">mmol/L (config default)</span></label>
          <input type="number" id="effluentTotalCa" value="${state.effluentTotalCa_mmol_L}" min="0" step="0.1">
          <div class="field-help">Use only if your protocol supplies this estimate.</div>
        </div>
      </div>
      <div class="output-block">
        <div class="output-row"><span class="label">Estimated elemental Ca loss</span><span class="value">${fmt(caLoss.caLoss_mmol_hr, 2)} mmol/hr</span></div>
      </div>

      <h3 class="mt-4">Titration table</h3>
      ${renderCalciumTitrationTable()}

      <h3 class="mt-4">Accumulation check</h3>
      <div class="input-row aligned-row">
        <div class="field"><label for="totalCa">Total Ca <span class="unit">mmol/L</span></label><input type="number" id="totalCa" value="${state.totalCa_mmol_L}" step="0.1"></div>
        <div class="field"><label for="systemicICa">Systemic iCa <span class="unit">mmol/L</span></label><input type="number" id="systemicICa" value="${state.systemicICa_mmol_L}" step="0.01"></div>
        <div class="field"><label for="postFilterICa">Post-filter iCa <span class="unit">mmol/L</span></label><input type="number" id="postFilterICa" value="${state.postFilterICa_mmol_L}" step="0.01"></div>
      </div>
      ${accumulation ? `
      <div class="output-block">
        <div class="output-row"><span class="label">Total : ionised Ca ratio</span><span class="value big">${fmt(accumulation.caRatio, 2)} <span class="flag ${accumulation.accumulationFlag ? 'red' : 'green'}">${accumulation.accumulationFlag ? 'accumulation' : 'normal'}</span></span></div>
      </div>
      ${accumulation.accumulationFlag ? `
      <div class="warning-inline hard">
        Pattern suggests citrate accumulation: rising calcium requirement, falling systemic iCa despite escalating replacement, widening anion gap. At-risk: acute liver failure, cirrhosis with shock, profound hypoperfusion with failed lactate clearance.
        <br><strong>Options:</strong> reduce citrate dose; increase effluent to raise citrate clearance; or stop citrate and convert anticoagulation.
      </div>` : ''}` : ''}

      <h3 class="mt-4">Acid-base discrimination</h3>
      <div class="input-row aligned-row">
        <div class="field"><label for="pH">Arterial/venous pH</label><input type="number" id="pH" value="${state.pH}" step="0.01"></div>
        <div class="field"><label for="hco3">HCO₃⁻ <span class="unit">mmol/L</span></label><input type="number" id="hco3" value="${state.hco3_mmol_L}" step="0.5"></div>
      </div>
      ${!accumulation ? `<div class="small muted">Enter total Ca and systemic iCa above to enable this panel. The calcium ratio is required to distinguish accumulation from under-buffering.</div>` : ''}
      ${acidBase ? `
      <div class="output-block accent-card mod-${acidBase === 'acidosis_accumulation' ? 'heparin' : 'citrate'}" id="acid-base-result">
        <strong>${acidBaseCopy[acidBase].title}</strong>
        <p class="small">${acidBaseCopy[acidBase].body}</p>
      </div>` : ''}
      <p class="small muted">1 mmol citrate metabolised → 3 mmol bicarbonate regenerated. Also watch for hypernatraemia with concentrated trisodium citrate, and expect hypomagnesaemia with RCA.</p>
    </details>`;
  }

  function renderCalciumTitrationTable() {
    const table = CONFIG.citrate?.calciumTitrationTable;
    if (!table) return '<p class="small muted">No titration table in config.</p>';
    const rowsReviewed = [...(table.bySystemicICa || []), ...(table.byPostFilterICa || [])].every(r => r.reviewed === true);
    if (!CONFIG.reviewed || !rowsReviewed) {
      return '<div class="warning-inline hard">Local titration nomogram not validated. Add your approved systemic iCa and post-filter iCa tables in config/local-protocol.json before using this section.</div>';
    }
    const rows = (table.bySystemicICa || []).map(r => `<div class="output-row"><span class="label">${describeRange(r, 'systemicICa_mmol_L')}</span><span class="value">${r.action}</span></div>`).join('');
    return `<div class="output-block">${rows}</div>`;
  }

  function describeRange(r, key) {
    if (r[`${key}_below`] !== undefined) return `< ${r[`${key}_below`]}`;
    if (r[`${key}_above`] !== undefined) return `> ${r[`${key}_above`]}`;
    if (r[`${key.replace('_mmol_L', '')}_range`]) return `${r[`${key.replace('_mmol_L', '')}_range`].join('–')}`;
    return '';
  }

  // -----------------------------------------------------------------------
  function renderHeparinPanel() {
    return `
    <div class="card accent-card mod-heparin">
      <h2><span class="tag">Heparin</span> Systemic heparin</h2>
      <p class="small muted">Please defer to your local heparin anticoagulation protocol and nomogram for bolus dosing, infusion rates, monitoring targets, and titration.</p>
      <div class="warning-inline hard">
        <strong>HIT:</strong> if platelets fall &gt; 50% from baseline or thrombosis develops, stop ALL heparin, including flushes and heparin in the circuit prime. Alternatives: argatroban or bivalirudin. Consider a 4Ts assessment (not scored in this app).
      </div>
    </div>`;
  }

  function renderHeparinizedPanel() {
    return `
    <div class="card accent-card mod-none">
      <h2><span class="tag">Heparinized</span> Heparinized circuit only</h2>
      <p>The circuit priming solution contains heparin, but no systemic or regional anticoagulation is added during the run. Higher blood flow and pre-dilution replacement help extend filter life. Please defer to your local protocol for circuit priming and management.</p>
      <div class="warning-inline">Do not prime with heparin if HIT is suspected or confirmed.</div>
    </div>`;
  }

  // -----------------------------------------------------------------------
  function renderProductOptions(role, selectedId) {
    const products = productsForRole(role);
    if (!products.length) return '<option value="">No products listed for this brand and market</option>';
    const families = [...new Set(products.map(p => p.family))];
    return families.map(family => {
      const options = products.filter(p => p.family === family).map(p => `<option value="${p.id}" ${selectedId === p.id ? 'selected' : ''} ${p.compositionVerified ? '' : 'disabled'}>${p.name}${p.compositionVerified ? '' : ' (composition pending verification)'}</option>`).join('');
      return `<optgroup label="${family}">${options}</optgroup>`;
    }).join('');
  }

  function renderComposition(product, roleLabel) {
    if (!product?.compositionVerified) return `<div class="warning-inline">No verified ${roleLabel.toLowerCase()} composition is available for this selection. It cannot drive electrolyte checks.</div>`;
    const c = product.composition || {};
    const rows = [
      ['Na⁺', c.sodium], ['K⁺', c.potassium], ['Ca²⁺', c.calcium], ['Mg²⁺', c.magnesium],
      ['Cl⁻', c.chloride], ['HCO₃⁻', c.bicarbonate], ['PO₄', c.phosphate], ['Citrate', c.citrate]
    ].filter(([,value]) => value !== undefined).map(([label,value]) => `<span><strong>${label}</strong> ${value}</span>`).join('');
    return `<div class="solution-summary"><div class="card-title-row"><strong>${roleLabel}: ${product.name}</strong><span class="tag">${(product.regions || []).join(' / ')}</span></div><div class="composition-grid">${rows}</div><div class="small muted">mmol/L. ${product.source || ''}</div></div>`;
  }

  function selectedSolutionSodium() {
    const i = engineInputs();
    const dialysate = productById(state.dialysateProductId);
    const replacement = productById(state.replacementProductId);
    const parts = [
      { flow: i.dialysateFlow_mL_hr, sodium: dialysate?.compositionVerified ? dialysate.composition?.sodium : null },
      { flow: i.replacementPre_mL_hr + i.replacementPost_mL_hr, sodium: replacement?.compositionVerified ? replacement.composition?.sodium : null }
    ].filter(x => x.flow > 0 && Number.isFinite(x.sodium));
    const total = parts.reduce((sum, x) => sum + x.flow, 0);
    return total ? parts.reduce((sum, x) => sum + x.flow * x.sodium, 0) / total : null;
  }

  function renderSolutionGuidance(product, label) {
    if (!product?.compositionVerified) return '';
    const c = product.composition || {};
    const messages = [];
    if (state.anticoag === 'citrate' && c.calcium > 0) messages.push(`${label} contains calcium. This is not a standard calcium-free RCA pairing; use only if your approved protocol explicitly specifies it.`);
    if (c.potassium === 0) messages.push(`${label} is potassium-free. It may help initially in severe hyperkalaemia, but requires frequent potassium checks and a planned switch or replacement.`);
    if (c.potassium === 4 && state.serumK_mmol_L !== '' && num(state.serumK_mmol_L) >= 5.5) messages.push(`${label} contains 4 mmol/L potassium while the entered serum potassium is elevated. Consider a lower-potassium product if available and clinically appropriate.`);
    if (c.phosphate === 1 && state.serumPO4_mmol_L !== '' && num(state.serumPO4_mmol_L) > 1.5) messages.push(`${label} contains phosphate. Reassess its use while serum phosphate is elevated.`);
    if (c.phosphate === 0 && state.serumPO4_mmol_L !== '' && num(state.serumPO4_mmol_L) < 0.8) messages.push(`${label} is phosphate-free while the entered serum phosphate is low. Consider a phosphate-containing fluid or separate replacement under the local protocol.`);
    if (c.bicarbonate !== undefined && c.bicarbonate <= 22 && state.anticoag !== 'citrate') messages.push(`${label} has lower bicarbonate (${c.bicarbonate} mmol/L). Confirm the intended buffer plan.`);
    return messages.map(m => `<div class="warning-inline">${m}</div>`).join('');
  }

  function renderSolutionsPanel(dose) {
    const dialysate = productById(state.dialysateProductId);
    const replacement = productById(state.replacementProductId);
    let po4 = null;
    if (state.serumPO4_mmol_L !== '') {
      po4 = C.estimatePhosphateRemoval({ effluentRate_mL_hr: dose.effluentRate_mL_hr, serumPO4_mmol_L: num(state.serumPO4_mmol_L) });
    }
    const selectedNa = selectedSolutionSodium();
    let naCheck = null;
    if (state.serumNa_mmol_L !== '') {
      naCheck = C.sodiumGradientCheck({ serumNa_mmol_L: num(state.serumNa_mmol_L), solutionNa_mmol_L: selectedNa ?? num(state.solutionNa_mmol_L) });
    }

    const guidanceCount = [renderSolutionGuidance(state.modality !== 'CVVH' && state.modality !== 'SCUF' ? dialysate : null, 'x'),
      renderSolutionGuidance(state.modality !== 'CVVHD' && state.modality !== 'SCUF' ? replacement : null, 'x')].join('').split('warning-inline').length - 1;
    const solutionsAlert = (naCheck && naCheck.flag) || guidanceCount > 0;
    return `
    <details class="card collapsible" id="panel-solutions" ${state.ui.solutionsOpen ? 'open' : ''}>
      <summary>
        <h2>Solutions &amp; electrolytes</h2>
        <span class="collapsed-hint">${[productById(state.dialysateProductId), productById(state.replacementProductId)].filter(Boolean).map(p => p.name).filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'No products selected'}${solutionsAlert ? ' <span class="flag red">review</span>' : ''}</span>
      </summary>

      <p class="small muted">Showing ${selectedBrand().label} products for ${state.marketRegion === 'ALL' ? 'all listed markets' : state.marketRegion}. Greyed-out products remain in the catalogue for recognition, but cannot drive calculations until the current full composition is verified.</p>

      ${state.modality !== 'CVVH' && state.modality !== 'SCUF' ? `
      <div class="field">
        <label for="dialysateProduct">Dialysate product</label>
        <select id="dialysateProduct">${renderProductOptions('dialysate', state.dialysateProductId)}</select>
        <div class="field-help">Suggested choice depends first on anticoagulation compatibility, then potassium, phosphate and buffer needs.</div>
      </div>
      ${renderComposition(dialysate, 'Dialysate')}${renderSolutionGuidance(dialysate, 'The selected dialysate')}` : ''}

      ${state.modality !== 'CVVHD' && state.modality !== 'SCUF' ? `
      <div class="field mt-4">
        <label for="replacementProduct">Replacement product</label>
        <select id="replacementProduct">${renderProductOptions('replacement', state.replacementProductId)}</select>
        <div class="field-help">The same selected fluid is assumed for pre- and post-filter replacement. Add separate selectors later if your protocol routinely uses different bags.</div>
      </div>
      ${renderComposition(replacement, 'Replacement')}${renderSolutionGuidance(replacement, 'The selected replacement fluid')}` : ''}

      <h3 class="mt-4">Patient electrolytes</h3>
      <div class="input-row aligned-row">
        <div class="field"><label for="serumK">Serum K⁺ <span class="unit">mmol/L</span></label><input type="number" id="serumK" value="${state.serumK_mmol_L}" step="0.1"><div class="field-help">Used to flag a selected K0 or K4 solution. It does not replace serial monitoring.</div></div>
        <div class="field"><label for="serumPO4">Serum PO₄ <span class="unit">mmol/L</span></label><input type="number" id="serumPO4" value="${state.serumPO4_mmol_L}" step="0.1"></div>
      </div>
      ${po4 && Number.isFinite(po4.po4Removal_mmol_day) ? `<div class="output-block"><div class="output-row"><span class="label">Estimated PO₄ removal</span><span class="value">${fmt(po4.po4Removal_mmol_day, 1)} mmol/day</span></div></div>` : ''}
      <p class="small muted">Hypophosphataemia is common during CRRT, particularly with phosphate-free solutions and longer treatment. Use a phosphate-containing solution or replace separately when indicated; follow the local monitoring schedule.</p>

      <h3 class="mt-4">Sodium safety</h3>
      <div class="input-row aligned-row sodium-row">
        <div class="field"><label for="serumNa">Serum Na⁺ <span class="unit">mmol/L</span></label><input type="number" id="serumNa" value="${state.serumNa_mmol_L}" step="1"></div>
        <div class="field"><label for="selectedNa">Selected-fluid Na⁺ <span class="unit">mmol/L</span></label><input type="number" id="selectedNa" value="${selectedNa === null ? '' : fmt(selectedNa, 1)}" style="width:100%" disabled><div class="field-help">Flow-weighted dialysate/replacement sodium. Citrate sodium and other infusions are not included.</div></div>
      </div>
      ${naCheck && Number.isFinite(naCheck.gradient_mmol_L) ? `
      <div class="output-block"><div class="output-row"><span class="label">Gradient</span><span class="value">${fmt(naCheck.gradient_mmol_L, 0)} mmol/L <span class="flag ${naCheck.flag ? 'red' : 'green'}">${naCheck.flag ? 'caution' : 'ok'}</span></span></div></div>
      ${naCheck.flag ? `<div class="warning-inline hard">A large solution-to-serum gradient can cause an unsafe correction rate. The gradient alone does not predict the 24-hour change. Build a patient-specific sodium plan, with frequent checks and local pharmacy/nephrology input, before starting.</div>` : ''}` : ''}

      <p class="small muted mt-4">Catalogue values support education and consistency checks, not product substitution. Verify the bag label, current monograph, connector compatibility and institution-approved protocol before use. Also expect magnesium losses with RCA, and re-check drug dosing against a CRRT-specific reference.</p>
    </details>`;
  }

  // ---- live update while typing (no full re-render, so focus is kept) ----
  function updateOutputOnly(root) {
    if (state.hhs) {
      applyHHSFlows();
      [['dialysateFlow', 'dialysateFlow_mL_hr'], ['replacementPre', 'replacementPre_mL_hr'], ['replacementPost', 'replacementPost_mL_hr']].forEach(([id, key]) => {
        const node = document.getElementById(id);
        if (node && document.activeElement !== node) node.value = state[key];
      });
    }
    const dose = computeDose();
    const hs = document.getElementById('hhs-summary');
    if (hs && state.hhs) hs.innerHTML = renderHHSSummary();
    Object.entries(outputRows(dose)).forEach(([id, text]) => {
      const node = document.getElementById(id);
      if (node) node.textContent = text;
    });
    const ffBadge = document.getElementById('out-ff-badge');
    if (ffBadge) { ffBadge.textContent = dose.ffFlag; ffBadge.className = 'flag ' + dose.ffFlag; }
    const warn = document.getElementById('out-warnings');
    if (warn) warn.innerHTML = renderCurrentWarnings(dose);
    const mobD = document.getElementById('mob-delivered');
    if (mobD) mobD.textContent = mobileDoseValue(dose);
    const mobF = document.getElementById('mob-ff');
    if (mobF) { mobF.textContent = fmt(dose.filtrationFraction * 100) + '%'; mobF.className = 'flag ' + dose.ffFlag; }
    const schWrap = root ? root.querySelector('.schematic-wrap') : null;
    if (schWrap) {
      const existingSvg = schWrap.querySelector('svg');
      if (existingSvg) existingSvg.remove();
      const tmp = document.createElement('div');
      tmp.innerHTML = schematicFor(dose);
      const newSvg = tmp.querySelector('svg');
      const h3 = schWrap.querySelector('h3');
      if (h3 && newSvg) h3.after(newSvg);
      const pr = schWrap.querySelector('.pressure-readout');
      if (pr) pr.innerHTML = pressureReadout(dose);
    }
  }

  // -----------------------------------------------------------------------
  function wireEvents(root) {
    const bind = (id, key, isFloat = true, transform = null, onUpdate = null) => {
      const node = el(id);
      if (!node) return;
      const readValue = () => {
        let v = node.type === 'checkbox' ? node.checked : node.value;
        if (transform) v = transform(v);
        else if (isFloat && node.type === 'number') {
          // Store numbers, never strings. Blank stays '' so optional fields
          // can tell "not entered" from zero.
          const n = parseFloat(v);
          v = v === '' || !Number.isFinite(n) ? '' : n;
        }
        return v;
      };
      node.addEventListener('input', () => {
        // Preserve focus while typing: update outputs in place.
        state[key] = readValue();
        if (onUpdate) onUpdate();
        updateOutputOnly(root);
      });
      node.addEventListener('change', () => {
        state[key] = readValue();
        if (onUpdate) onUpdate();
        render(root);
      });
    };

    // In HHS mode the protocol formulas recalculate the flows instead.
    const setupChanged = () => { if (state.hhs) applyHHSFlows(); else state.setupGenerated = false; };
    const weightInputsChanged = () => { syncDosingWeight(); setupChanged(); };

    bind('targetDeliveredDose', 'targetDeliveredDose_mL_kg_hr', true, null, setupChanged);
    bind('actualWeightKg', 'actualWeightKg', true, null, weightInputsChanged);
    bind('weightKg', 'weightKg', true, null, setupChanged);
    bind('heightCm', 'heightCm', true, v => v === '' ? null : parseFloat(v), weightInputsChanged);
    bind('hematocrit', 'hematocrit', true, null, setupChanged);
    bind('downtimePercent', 'uptimeFraction', true, v => 1 - Math.min(50, Math.max(0, num(v))) / 100, setupChanged);
    const machineChanged = () => { if (state.hhs) applyHHSFlows(); else if (state.setupGenerated) state.machineEdited = true; };
    const flowEdited = (key, stateKey) => () => { if (state.hhs) hhsFlowTyped(key, stateKey); else if (state.setupGenerated) state.machineEdited = true; };
    bind('bloodFlow', 'bloodFlow_mL_min', true, null, machineChanged);
    bind('dialysateFlow', 'dialysateFlow_mL_hr', true, null, flowEdited('qd', 'dialysateFlow_mL_hr'));
    bind('replacementPre', 'replacementPre_mL_hr', true, null, flowEdited('pre', 'replacementPre_mL_hr'));
    bind('replacementPost', 'replacementPost_mL_hr', true, null, flowEdited('post', 'replacementPost_mL_hr'));
    bind('netUF', 'netUltrafiltration_mL_hr', true, null, machineChanged);
    bind('nonCRRTIntake', 'nonCRRTIntake_mL_hr', true, null, machineChanged);
    const sex = el('sex');
    if (sex) sex.addEventListener('change', () => {
      state.sex = sex.value;
      syncDosingWeight();
      setupChanged();
      render(root);
    });

    const weightBasis = el('weightBasis');
    if (weightBasis) weightBasis.addEventListener('change', () => {
      state.weightBasis = weightBasis.value;
      syncDosingWeight();
      setupChanged();
      render(root);
    });

    // The engine applies the protocol pre/post split (preFilterShare) and
    // all dose compensation itself, so its flows are used exactly as
    // returned. No post-processing here: the predictions and warnings it
    // produced describe these same flows.
    const generatePrescription = el('generatePrescription');
    if (generatePrescription) generatePrescription.addEventListener('click', () => {
      if (state.hhs) { applyHHSFlows(true); render(root); return; }
      const suggestion = computeSuggestion();
      state.bloodFlow_mL_min = suggestion.bloodFlow_mL_min;
      state.dialysateFlow_mL_hr = suggestion.dialysateFlow_mL_hr;
      state.replacementPre_mL_hr = suggestion.replacementPre_mL_hr;
      state.replacementPost_mL_hr = suggestion.replacementPost_mL_hr;
      state.setupGenerated = true;
      state.machineEdited = false;
      render(root);
    });

    root.querySelectorAll('[data-modality]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.modality = btn.dataset.modality;
        if (state.hhs) applyHHSFlows(true); else state.setupGenerated = false;
        render(root);
      });
    });
    root.querySelectorAll('[data-anticoag]').forEach(btn => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.anticoag;
        // The HHS heparin sheet also covers no anticoagulation; any other
        // change leaves the protocol.
        const keep = (state.hhs === 'citrate' && next === 'citrate') || (state.hhs === 'heparin' && next !== 'citrate');
        state.anticoag = next;
        if (state.hhs && !keep) stopHHS();
        if (!state.hhs) state.setupGenerated = false;
        render(root);
      });
    });
    root.querySelectorAll('[data-hhs]').forEach(btn => {
      btn.addEventListener('click', () => {
        // Tapping the active protocol again does nothing; use Exit to leave it.
        if (state.hhs !== btn.dataset.hhs) startHHS(btn.dataset.hhs);
        render(root);
      });
    });
    const hhsCustom = el('hhsCustom');
    if (hhsCustom) hhsCustom.addEventListener('click', () => {
      // Heparin sheet "Customize Flow Rates": pre 100, dialysate 0, post 200 as fixed values.
      state.hhsOverrides = state.modality === 'CVVH' ? { pre: 100, post: 200 } : { pre: 100, qd: 0, post: 200 };
      state.hhsFlowsEdited = true;
      applyHHSFlows();
      render(root);
    });
    const hhsExit = el('hhsExit');
    if (hhsExit) hhsExit.addEventListener('click', () => { stopHHS(); render(root); });

    const marketRegion = el('marketRegion');
    if (marketRegion) marketRegion.addEventListener('change', () => {
      state.marketRegion = marketRegion.value;
      normalizeProductSelections();
      if (state.hhs === 'citrate') { stopHHS(); state.hhsNotice = 'HHS protocol turned off: the market or brand changed, and the HHS citrate sheet is for Regiocit 18 mmol/L only.'; }
      else if (state.hhs) applyHHSFlows(); else state.setupGenerated = false;
      render(root);
    });
    const solutionBrand = el('solutionBrand');
    if (solutionBrand) solutionBrand.addEventListener('change', () => {
      state.solutionBrand = solutionBrand.value;
      normalizeProductSelections();
      if (state.hhs === 'citrate') { stopHHS(); state.hhsNotice = 'HHS protocol turned off: the market or brand changed, and the HHS citrate sheet is for Regiocit 18 mmol/L only.'; }
      else if (state.hhs) applyHHSFlows(); else state.setupGenerated = false;
      render(root);
    });

    // citrate
    bind('citrateConc', 'citrateConcentration_mmol_L', true, null, () => { if (state.hhs === 'citrate' && num(state.citrateConcentration_mmol_L) !== hhsCfg().citrate.conc) { stopHHS(); state.hhsNotice = 'HHS protocol turned off: the HHS citrate sheet uses 18 mmol/L.'; } });
    bind('citrateTargetDose', 'citrateTargetDose_mmol_L', true, null, setupChanged);
    bind('hhsCitrateDose', 'citrateTargetDose_mmol_L', true, null, setupChanged);
    bind('effluentTotalCa', 'effluentTotalCa_mmol_L');
    bind('totalCa', 'totalCa_mmol_L');
    bind('systemicICa', 'systemicICa_mmol_L');
    bind('postFilterICa', 'postFilterICa_mmol_L');
    bind('pH', 'pH');
    bind('hco3', 'hco3_mmol_L');

    // Remember which collapsible panels are open across re-renders.
    [['panel-citrate', 'citrateOpen'], ['panel-solutions', 'solutionsOpen']].forEach(([id, key]) => {
      const node = el(id);
      if (node) node.addEventListener('toggle', () => { state.ui[key] = node.open; });
    });

    // solutions
    bind('serumPO4', 'serumPO4_mmol_L');
    bind('serumK', 'serumK_mmol_L');
    bind('serumNa', 'serumNa_mmol_L');

    [['dialysateProduct','dialysateProductId'],['replacementProduct','replacementProductId'],['citrateProduct','citrateProductId']].forEach(([id,key]) => {
      const node = el(id);
      if (!node) return;
      node.addEventListener('change', () => {
        state[key] = node.value;
        const product = productById(node.value);
        if (key === 'citrateProductId') {
          state.citrateConcentration_mmol_L = product?.composition?.citrate || 0;
          state.citratePreFilter = true;
          if (state.hhs === 'citrate' && num(state.citrateConcentration_mmol_L) !== hhsCfg().citrate.conc) { stopHHS(); state.hhsNotice = 'HHS protocol turned off: the HHS citrate sheet is for 18 mmol/L citrate (Regiocit) only.'; }
          else if (state.hhs) applyHHSFlows(); else state.setupGenerated = false;
        } else if (state.setupGenerated) {
          state.machineEdited = true;
        }
        render(root);
      });
    });
  }

  // Load a prescription built in the Learn tab. Clinical state lives only in
  // this module (never localStorage), so this simply replaces it.
  function loadScenario(s) {
    const conc = num(s.citrateConc);
    Object.assign(state, {
      actualWeightKg: num(s.actualWeightKg, state.actualWeightKg),
      heightCm: s.heightCm || null,
      sex: s.sex === 'male' || s.sex === 'female' ? s.sex : 'unspecified',
      weightBasis: s.weightBasis || 'actual',
      hematocrit: num(s.hematocrit, state.hematocrit),
      modality: s.modality || state.modality,
      anticoag: s.anticoag === 'none' ? 'heparinized' : (s.anticoag || state.anticoag),
      marketRegion: 'CA',
      solutionBrand: 'vantive',
      citrateProductId: conc >= 100 && conc < 120 ? 'acd-a' : conc > 120 ? 'tsc-4-percent' : 'regiocit',
      citrateTargetDose_mmol_L: num(s.citrateDose, 3),
      bloodFlow_mL_min: num(s.bloodFlow, 150),
      dialysateFlow_mL_hr: num(s.dialysate),
      replacementPre_mL_hr: num(s.pre),
      replacementPost_mL_hr: num(s.post),
      netUltrafiltration_mL_hr: num(s.netUF),
      uptimeFraction: num(s.uptime, 0.9),
      targetDeliveredDose_mL_kg_hr: num(s.target, 22.5),
      setupGenerated: false,
      machineEdited: false,
      hhs: null,
      hhsFlowsEdited: false,
      hhsOverrides: {},
    });
    syncDosingWeight();
  }

  return { mount, loadScenario };
})();
