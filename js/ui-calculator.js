/**
 * ui-calculator.js: the Prescribe mode. One continuous prescription
 * builder: circuit & dose, then a modality-specific anticoagulation panel,
 * then solutions/electrolytes. Re-renders whole panel on any input change
 * (no framework, so this keeps state/DOM in sync simply and safely).
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

    anticoag: 'citrate', // 'citrate' | 'heparin' | 'none'

    // platform and commercially supplied fluids
    marketRegion: 'CA',
    solutionBrand: 'vantive',
    dialysateProductId: 'prismasate-bgk-2-0',
    replacementProductId: 'prismasol-bgk-2-0',
    citrateProductId: 'prismocitrate-18-0',

    // citrate
    citratePreset: 'acda',
    citrateConcentration_mmol_L: 113,
    citratePreFilter: true,
    citrateTargetDose_mmol_L: 3.0,
    citrateFlow_mL_hr: null, // if user enters flow directly instead of target dose
    postFilterICa_mmol_L: '',
    systemicICa_mmol_L: '',
    totalCa_mmol_L: '',
    calciumProduct: 'cacl2_10pct',
    effluentTotalCa_mmol_L: 1.5,
    pH: '',
    hco3_mmol_L: '',

    // heparin
    bolusUnits: 750,
    infusionUnitsPerKgHr: 7.5,
    heparinConcentration_units_mL: 100,

    // solutions
    serumPO4_mmol_L: '',
    serumK_mmol_L: '',
    serumNa_mmol_L: '',
    solutionNa_mmol_L: 140,
  };

  function num(v, fallback = 0) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function fmt(v, digits = 1) {
    if (v === null || v === undefined || Number.isNaN(v)) return '–';
    return v.toFixed(digits);
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

  // -----------------------------------------------------------------------
  async function mount(root) {
    if (!CONFIG) CONFIG = await window.CRRTStore.loadConfig();
    if (!SOLUTIONS) SOLUTIONS = await window.CRRTStore.loadData('solutions');
    normalizeProductSelections();
    render(root);
  }

  function render(root) {
    const dose = C.computeDoseAndFF({
      weightKg: state.weightKg,
      hematocrit: state.hematocrit,
      bloodFlow_mL_min: state.bloodFlow_mL_min,
      dialysateFlow_mL_hr: state.modality === 'CVVH' || state.modality === 'SCUF' ? 0 : state.dialysateFlow_mL_hr,
      replacementPre_mL_hr: state.replacementPre_mL_hr,
      replacementPost_mL_hr: state.replacementPost_mL_hr,
      netUltrafiltration_mL_hr: state.netUltrafiltration_mL_hr,
      citrateFlow_mL_hr: state.anticoag === 'citrate' ? getCitrateFlow() : 0,
      citratePreFilter: state.citratePreFilter,
      uptimeFraction: state.uptimeFraction,
      nonCRRTIntake_mL_hr: state.nonCRRTIntake_mL_hr,
    });

    const bmi = C.computeBMIAndAdjustedWeight({ weightKg: state.actualWeightKg, heightCm: state.heightCm, sex: state.sex });
    const suggestion = C.suggestPrescription({
      weightKg: state.weightKg,
      hematocrit: state.hematocrit,
      modality: state.modality,
      bloodFlow_mL_min: state.bloodFlow_mL_min,
      targetDeliveredDose_mL_kg_hr: state.targetDeliveredDose_mL_kg_hr,
      uptimeFraction: state.uptimeFraction,
      netUltrafiltration_mL_hr: state.netUltrafiltration_mL_hr,
      citrateFlow_mL_hr: state.anticoag === 'citrate' ? getCitrateFlow() : 0,
      citratePreFilter: state.anticoag === 'citrate' && state.citratePreFilter,
    });

    const accentClass = state.anticoag === 'citrate' ? 'mod-citrate' : state.anticoag === 'heparin' ? 'mod-heparin' : 'mod-none';
    const accentVar = state.anticoag === 'citrate' ? '--citrate' : state.anticoag === 'heparin' ? '--heparin' : '--muted';

    const schematicSvg = window.CRRTSchematic.render({
      qb_mL_min: state.bloodFlow_mL_min,
      prefilterActive: state.replacementPre_mL_hr > 0 || (state.anticoag === 'citrate' && state.citratePreFilter),
      postfilterActive: state.replacementPost_mL_hr > 0,
      ff: dose.filtrationFraction,
      accentVar,
    });

    root.innerHTML = `
      <h1>Prescribe</h1>

      <div class="grid-2">
        <div>
          ${renderSetupCard(bmi, suggestion)}
          ${renderPlatformCard()}
          ${renderCircuitCard(dose)}
          ${state.anticoag === 'citrate' ? renderCitratePanel(dose) : ''}
          ${state.anticoag === 'heparin' ? renderHeparinPanel() : ''}
          ${state.anticoag === 'none' ? renderNoAnticoagPanel() : ''}
          ${renderSolutionsPanel(dose)}
        </div>
        <div>
          <div class="card schematic-wrap ${accentClass}">
            <h3>Circuit</h3>
            ${schematicSvg}
            <div class="pressure-readout">
              <span>FF <span class="val">${fmt(dose.filtrationFraction * 100)}%</span></span>
              <span>Effluent <span class="val">${fmt(dose.effluentRate_mL_hr, 0)} mL/hr</span></span>
            </div>
          </div>
        </div>
      </div>

      <div class="mobile-summary">
        <span>Delivered dose: <strong>${fmt(dose.correctedDeliveredDose_mL_kg_hr)} mL/kg/hr</strong></span>
        <span>FF: <strong class="flag ${dose.ffFlag}">${fmt(dose.filtrationFraction * 100)}%</strong></span>
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
    return `
      <div class="card">
        <div class="card-title-row">
          <div><span class="eyebrow">Step 2</span><h2>Select the institution's platform</h2></div>
          <button type="button" class="primary" id="generatePrescription" ${state.modality === 'SCUF' ? 'disabled' : ''}>${state.setupGenerated ? 'Recalculate flows' : 'Generate starting prescription'}</button>
        </div>
        <div class="input-row">
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
            <div class="field-help">Platform: ${brand.platform || 'site-specific'}. Product connectors and integrated pumps may restrict compatible fluids.</div>
          </div>
        </div>
      </div>`;
  }

  function renderSetupCard(bmi, suggestion) {
    const downtimePercent = (1 - num(state.uptimeFraction, 0.9)) * 100;
    const basePrescribedTarget = num(state.uptimeFraction) > 0
      ? num(state.targetDeliveredDose_mL_kg_hr) / num(state.uptimeFraction)
      : null;
    const weightHelp = bmi.bmi === null
      ? 'Use the unit-approved dosing weight. Add height and an IBW formula if ideal or adjusted weight is being considered.'
      : bmi.bmi >= 30
        ? `BMI ${fmt(bmi.bmi)}. In high BMI, ideal or adjusted weight may avoid excessive initial CRRT dose. ${bmi.ibwKg ? `IBW ${fmt(bmi.ibwKg)} kg; adjusted weight ${fmt(bmi.adjustedBodyWeightKg)} kg.` : 'Select an IBW formula to calculate alternatives.'}`
        : `BMI ${fmt(bmi.bmi)}. Actual or pre-illness weight is generally used unless the local protocol specifies another basis.`;

    return `
      <div class="card guidance-card setup-card">
        <span class="eyebrow">Step 1</span>
        <h2>Define the treatment target</h2>

        <label>Anticoagulation strategy</label>
        <div class="btn-group" id="anticoagGroup">
          <button type="button" class="btn-toggle mod-citrate ${state.anticoag === 'citrate' ? 'selected' : ''}" data-anticoag="citrate">Regional citrate</button>
          <button type="button" class="btn-toggle mod-heparin ${state.anticoag === 'heparin' ? 'selected' : ''}" data-anticoag="heparin">Systemic heparin</button>
          <button type="button" class="btn-toggle mod-none ${state.anticoag === 'none' ? 'selected' : ''}" data-anticoag="none">No anticoagulation</button>
        </div>

        <div class="input-row mt-4">
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

        <div class="input-row">
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

        <div class="input-row mt-4">
          <div class="field">
            <label for="hematocrit">Hematocrit <span class="unit">fraction</span></label>
            <input type="number" id="hematocrit" value="${state.hematocrit}" min="0.1" max="0.6" step="0.01">
            <div class="field-help">Used to estimate plasma flow and filtration fraction.</div>
          </div>
          <div class="field">
            <label for="targetDeliveredDose">Target delivered dose <span class="unit">mL/kg/hr</span></label>
            <input type="number" id="targetDeliveredDose" value="${state.targetDeliveredDose_mL_kg_hr}" min="10" max="40" step="0.5">
            <div class="field-help">Routine adult AKI target: 20–25 delivered.</div>
          </div>
          <div class="field">
            <label for="downtimePercent">Expected downtime <span class="unit">%</span></label>
            <input type="number" id="downtimePercent" value="${fmt(downtimePercent, 0)}" min="0" max="50" step="1">
            <div class="field-help">Use your unit's observed downtime. Default 10%.</div>
          </div>
        </div>

        <label>Modality</label>
        <div class="btn-group" id="modalityGroup">
          ${['CVVHDF', 'CVVHD', 'CVVH', 'SCUF'].map(m => `<button type="button" class="btn-toggle ${state.modality === m ? 'selected' : ''}" data-modality="${m}">${m}</button>`).join('')}
        </div>

        ${state.modality === 'SCUF'
          ? '<div class="warning-inline">SCUF targets fluid removal rather than a delivered small-solute dose. Set net UF in the editable prescription below.</div>'
          : `<div class="setup-summary"><span>Delivered target <strong>${fmt(num(state.targetDeliveredDose_mL_kg_hr))}</strong></span><span>Downtime <strong>${fmt(downtimePercent, 0)}%</strong></span><span>Downtime-only target <strong>${fmt(basePrescribedTarget)} mL/kg/hr</strong></span></div>
             <p class="small muted">The generated flows also correct for citrate and other pre-filter dilution, then round machine flows to 50 mL/hr. ${state.setupGenerated ? `Current generated prediction: ${fmt(suggestion.predictedDeliveredDose_mL_kg_hr)} mL/kg/hr delivered.` : 'Generate the starting prescription, then edit any machine setting below.'}</p>`}
      </div>`;
  }

  function getCitrateFlow() {
    if (num(state.citrateConcentration_mmol_L) <= 0) return 0;
    if (state.citrateFlow_mL_hr !== null && state.citrateFlow_mL_hr !== '') {
      return num(state.citrateFlow_mL_hr);
    }
    return C.citrateFlowFromTargetDose({
      bloodFlow_mL_min: state.bloodFlow_mL_min,
      targetCitrateDose_mmol_L: state.citrateTargetDose_mmol_L,
      citrateConcentration_mmol_L: state.citrateConcentration_mmol_L,
    }).citrateFlow_mL_hr;
  }

  // -----------------------------------------------------------------------
  function renderCircuitCard(dose) {
    return `
    <div class="card">
      <span class="eyebrow">Step 3</span>
      <h2>Review and edit machine settings</h2>
      ${state.setupGenerated ? `
        <div class="guidance-grid">
          <div class="guidance-item"><strong>Generated for ${fmt(state.weightKg)} kg</strong><span>${state.modality}, ${state.anticoag === 'citrate' ? 'regional citrate' : state.anticoag === 'heparin' ? 'systemic heparin' : 'no anticoagulation'}.</span></div>
          <div class="guidance-item"><strong>${fmt(dose.correctedDeliveredDose_mL_kg_hr)} mL/kg/hr current</strong><span>Includes ${fmt((1 - state.uptimeFraction) * 100, 0)}% downtime and pre-filter dilution.${state.machineEdited ? ' Machine settings have been edited.' : ''}</span></div>
        </div>` : '<div class="warning-inline">The fields below remain editable. Use Generate starting prescription above to replace them with calculated starting values.</div>'}

      <div class="input-row mt-4">
        <div class="field">
          <label for="bloodFlow">Blood flow (Qb) <span class="unit">mL/min</span></label>
          <input type="number" id="bloodFlow" value="${state.bloodFlow_mL_min}" min="0" step="10">
          <div class="field-help">Suggested 150. A typical adult range is 100–200, limited by access and machine pressures.</div>
        </div>
        ${state.modality !== 'CVVH' && state.modality !== 'SCUF' ? `
        <div class="field">
          <label for="dialysateFlow">Dialysate (Qd) <span class="unit">mL/hr</span></label>
          <input type="number" id="dialysateFlow" value="${state.dialysateFlow_mL_hr}" min="0" step="50">
          <div class="field-help">Suggested by the guided panel from the remaining clearance requirement.</div>
        </div>` : ''}
      </div>
      ${state.bloodFlow_mL_min > 250 ? `<div class="warning-inline">Qb > 250 mL/min: access-dependent; confirm catheter and access pressure limits.</div>` : ''}

      ${state.modality !== 'CVVHD' && state.modality !== 'SCUF' ? `<div class="input-row">
        <div class="field">
          <label for="replacementPre">Pre-dilution replacement <span class="unit">mL/hr</span></label>
          <input type="number" id="replacementPre" value="${state.replacementPre_mL_hr}" min="0" step="50">
          <div class="field-help">Improves filter rheology and lowers FF, but dilutes solute before the membrane.</div>
        </div>
        <div class="field">
          <label for="replacementPost">Post-dilution replacement <span class="unit">mL/hr</span></label>
          <input type="number" id="replacementPost" value="${state.replacementPost_mL_hr}" min="0" step="50">
          <div class="field-help">More clearance-efficient, but increases haemoconcentration when FF rises.</div>
        </div>
      </div>` : ''}

      <div class="input-row">
        <div class="field">
          <label for="netUF">Net UF / patient fluid removal <span class="unit">mL/hr</span></label>
          <input type="number" id="netUF" value="${state.netUltrafiltration_mL_hr}" min="0" step="10">
          <div class="field-help">Start from the fluid goal and current tolerance. Use 0 mL/hr when active fluid removal is unsafe.</div>
        </div>
        <div class="field">
          <label for="nonCRRTIntake">Other fluid intake <span class="unit">mL/hr (optional)</span></label>
          <input type="number" id="nonCRRTIntake" value="${state.nonCRRTIntake_mL_hr}" min="0" step="10">
          <div class="field-help">Optional hourly intake estimate. It does not include urine, drains, or other outputs.</div>
        </div>
      </div>

      <div class="output-block">
        <div class="output-row"><span class="label">Effluent rate</span><span class="value">${fmt(dose.effluentRate_mL_hr, 0)} mL/hr</span></div>
        <div class="output-row"><span class="label">Prescribed dose</span><span class="value">${fmt(dose.prescribedDose_mL_kg_hr)} mL/kg/hr</span></div>
        <div class="output-row"><span class="label">Pre-dilution–corrected dose</span><span class="value">${fmt(dose.correctedDose_mL_kg_hr)} mL/kg/hr</span></div>
        <div class="output-row"><span class="label">Delivered dose (corrected × uptime)</span><span class="value big">${fmt(dose.correctedDeliveredDose_mL_kg_hr)} mL/kg/hr</span></div>
        <div class="output-row"><span class="label">Filtration fraction</span><span class="value">${fmt(dose.filtrationFraction * 100)}% <span class="flag ${dose.ffFlag}">${dose.ffFlag}</span></span></div>
        <div class="output-row"><span class="label">Total UF (crosses membrane)</span><span class="value">${fmt(dose.totalUltrafiltration_mL_hr, 0)} mL/hr</span></div>
        <div class="output-row"><span class="label">Estimated balance from entered intake and net UF</span><span class="value">${fmt(dose.estimatedPatientBalance_mL_hr, 0)} mL/hr</span></div>
      </div>
      ${dose.prescribedDose_mL_kg_hr > 40 ? `<div class="warning-inline hard">Prescribed dose above trial-tested range. RENAL and ATN showed no benefit over 20–25 mL/kg/hr delivered.</div>` : ''}
      ${dose.ffFlag === 'amber' ? `<div class="warning-inline">FF 20–25%: increasing haemoconcentration risk. Consider increasing Qb, shifting replacement pre-filter, or reducing convective flow.</div>` : ''}
      ${dose.ffFlag === 'red' ? `<div class="warning-inline hard">FF &gt; 25%: high haemoconcentration risk. Review blood flow and pre/post replacement split.</div>` : ''}

      <details class="working">
        <summary>Show working</summary>
        <div class="formula">effluent = Qd + replacementPre + replacementPost + netUF (+ citrate if pre-filter)
         = ${fmt(state.dialysateFlow_mL_hr, 0)} + ${fmt(state.replacementPre_mL_hr, 0)} + ${fmt(state.replacementPost_mL_hr, 0)} + ${fmt(state.netUltrafiltration_mL_hr, 0)} + ${fmt(dose.citrateAsPreDilution_mL_hr, 0)}
         = ${fmt(dose.effluentRate_mL_hr, 0)} mL/hr

prescribed dose = effluent / weight = ${fmt(dose.effluentRate_mL_hr, 0)} / ${state.weightKg} = ${fmt(dose.prescribedDose_mL_kg_hr)} mL/kg/hr

plasma flow = Qb × 60 × (1 − Hct)
 = ${state.bloodFlow_mL_min} × 60 × (1 − ${state.hematocrit}) = ${fmt(dose.plasmaWaterFlow_mL_hr, 0)} mL/hr

dilution factor = plasma water / (plasma water + pre-dilution total) = ${fmt(dose.dilutionFactor, 3)}
corrected dose = prescribed × dilution factor = ${fmt(dose.correctedDose_mL_kg_hr)} mL/kg/hr
delivered = corrected × uptime (${state.uptimeFraction}) = ${fmt(dose.correctedDeliveredDose_mL_kg_hr)} mL/kg/hr

FF = (replacementPre + replacementPost + citrate pre-filter + netUF) / (plasma flow + pre-dilution total) = ${fmt(dose.filtrationFraction * 100)}%</div>
      </details>
    </div>`;
  }

  // -----------------------------------------------------------------------
  function renderAnticoagSelector() {
    return `
    <div class="card">
      <h2>Anticoagulation</h2>
      <div class="btn-group" id="anticoagGroup">
        <button type="button" class="btn-toggle mod-citrate ${state.anticoag === 'citrate' ? 'selected' : ''}" data-anticoag="citrate">Regional citrate</button>
        <button type="button" class="btn-toggle mod-heparin ${state.anticoag === 'heparin' ? 'selected' : ''}" data-anticoag="heparin">Systemic heparin</button>
        <button type="button" class="btn-toggle mod-none ${state.anticoag === 'none' ? 'selected' : ''}" data-anticoag="none">None</button>
      </div>
    </div>`;
  }

  function renderCitratePanel(dose) {
    const citrateProduct = productById(state.citrateProductId);
    const citrateAvailable = !!(citrateProduct?.compositionVerified && num(citrateProduct.composition?.citrate) > 0);
    const citrateFlow = getCitrateFlow();
    const doseCheck = C.citrateDoseFromFlow({
      citrateFlow_mL_hr: citrateFlow,
      citrateConcentration_mmol_L: state.citrateConcentration_mmol_L,
      bloodFlow_mL_min: state.bloodFlow_mL_min,
    });

    const caLoss = C.estimateCalciumLoss({
      effluentRate_mL_hr: dose.effluentRate_mL_hr,
      effluentTotalCa_mmol_L: state.effluentTotalCa_mmol_L,
    });

    let accumulation = null;
    if (state.totalCa_mmol_L !== '' && state.systemicICa_mmol_L !== '') {
      accumulation = C.citrateAccumulationCheck({
        totalCa_mmol_L: num(state.totalCa_mmol_L),
        systemicICa_mmol_L: num(state.systemicICa_mmol_L),
      });
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

    return `
    <div class="card accent-card mod-citrate">
      <h2><span class="tag">Citrate</span> Regional citrate anticoagulation</h2>
      <p class="small muted">Please defer to local protocols and nomogram.</p>
      ${!citrateAvailable ? '<div class="warning-inline hard">No verified citrate product is selected. Choose the actual product in Solutions &amp; electrolytes before using any citrate-flow result.</div>' : ''}

      <div class="field">
        <label>Selected citrate source</label>
        <div class="output-block"><div class="output-row"><span class="label">${citrateProduct?.name || 'No verified citrate product available for this brand and market'}</span><span class="value">${citrateProduct?.composition?.citrate ? `${citrateProduct.composition.citrate} mmol/L` : 'not selected'}</span></div></div>
        <div class="small muted">Select or change the product in Solutions &amp; electrolytes. Confirm the formulation and machine-specific workflow locally.</div>
      </div>

      <div class="input-row">
        <div class="field">
          <label for="citrateConc">Citrate concentration <span class="unit">mmol/L</span></label>
          <input type="number" id="citrateConc" value="${state.citrateConcentration_mmol_L}" min="1" step="0.5" ${citrateProduct?.compositionVerified ? 'disabled' : ''}>
          <div class="field-help">Taken from the selected product. Verify the exact local formulation.</div>
        </div>
        <div class="field">
          <label for="citrateTargetDose">Target citrate dose <span class="unit">mmol/L blood</span></label>
          <input type="number" id="citrateTargetDose" value="${state.citrateTargetDose_mmol_L}" min="1" max="6" step="0.1" ${citrateAvailable ? '' : 'disabled'}>
          <div class="field-help">Suggested starting dose 3.0. A generic range is 3–4, then titrate to post-filter iCa using the local nomogram.</div>
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
 = ${state.citrateTargetDose_mmol_L} × ${state.bloodFlow_mL_min} × 60 / ${state.citrateConcentration_mmol_L} = ${fmt(citrateFlow)} mL/hr</div>
      </details>` : ''}

      <h3 class="mt-4">Calcium replacement</h3>
      <div class="warning-inline">The app estimates elemental calcium loss only. It does not convert that estimate into a stock calcium-product infusion, because prepared bag concentrations and starting nomograms are site-specific.</div>
      <div class="input-row">
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
      <div class="input-row">
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

      <h3 class="mt-4">Acid–base discrimination</h3>
      <div class="input-row">
        <div class="field"><label for="pH">Arterial/venous pH</label><input type="number" id="pH" value="${state.pH}" step="0.01"></div>
        <div class="field"><label for="hco3">HCO₃⁻ <span class="unit">mmol/L</span></label><input type="number" id="hco3" value="${state.hco3_mmol_L}" step="0.5"></div>
      </div>
      ${!accumulation ? `<div class="small muted">Enter total Ca and systemic iCa above to enable this panel. The calcium ratio is required to distinguish accumulation from under-buffering.</div>` : ''}
      ${acidBase ? `
      <div class="output-block accent-card mod-${acidBase === 'acidosis_accumulation' ? 'heparin' : 'citrate'}">
        <strong>${acidBaseCopy[acidBase].title}</strong>
        <p class="small">${acidBaseCopy[acidBase].body}</p>
      </div>` : ''}
      <p class="small muted">1 mmol citrate metabolised → 3 mmol bicarbonate regenerated. Also watch for hypernatraemia with concentrated trisodium citrate, and expect hypomagnesaemia with RCA.</p>
    </div>`;
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
    const h = C.computeHeparinDosing({
      weightKg: state.actualWeightKg,
      bolusUnits: state.bolusUnits,
      infusionUnitsPerKgHr: state.infusionUnitsPerKgHr,
      heparinConcentration_units_mL: state.heparinConcentration_units_mL,
    });
    const targets = CONFIG.heparin?.targets || {};

    return `
    <div class="card accent-card mod-heparin">
      <h2><span class="tag">Heparin</span> Systemic heparin</h2>
      <div class="warning-inline">Omit the bolus in active bleeding, recent surgery, post-cardiotomy, or thrombocytopenia.</div>

      <div class="input-row">
        <div class="field"><label for="bolusUnits">Bolus <span class="unit">units</span></label><input type="number" id="bolusUnits" value="${state.bolusUnits}" min="0" max="1000" step="50"><div class="field-help">Generic starting range 500–1000 units. Use 0 when the bolus is unsafe and follow the local protocol.</div></div>
        <div class="field"><label for="infusionUnitsPerKgHr">Infusion <span class="unit">U/kg/hr actual weight</span></label><input type="number" id="infusionUnitsPerKgHr" value="${state.infusionUnitsPerKgHr}" min="0" max="15" step="0.5"></div>
        <div class="field"><label for="heparinConc">Solution concentration <span class="unit">U/mL</span></label><input type="number" id="heparinConc" value="${state.heparinConcentration_units_mL}" min="1" step="1"></div>
      </div>

      <div class="output-block">
        <div class="output-row"><span class="label">Bolus dose</span><span class="value">${fmt(h.bolusUnits, 0)} units</span></div>
        <div class="output-row"><span class="label">Infusion rate</span><span class="value big">${fmt(h.infusionRate_mL_hr, 2)} mL/hr</span></div>
        <div class="output-row"><span class="label">Infusion dose</span><span class="value">${fmt(h.infusionUnits_hr, 0)} units/hr</span></div>
      </div>

      <p class="small muted">Generic infusion starting range: 5–10 U/kg/hr. Targets shown in config are placeholders until locally reviewed. Use the unit-approved aPTT or anti-Xa nomogram.</p>

      <div class="warning-inline hard">
        <strong>HIT:</strong> if platelets fall &gt; 50% from baseline or thrombosis develops, stop ALL heparin including flushes. Alternatives: argatroban or bivalirudin. Consider a 4Ts assessment (not scored in this app).
      </div>
    </div>`;
  }

  function renderNoAnticoagPanel() {
    return `
    <div class="card accent-card mod-none">
      <h2><span class="tag">None</span> No anticoagulation strategy</h2>
      <p>Higher blood flow, pre-dilution replacement, and minimising circuit interruptions extend filter life without anticoagulation. Accept shorter filter life as the trade-off: this is the expected and correct cost of this strategy in active bleeding or high bleeding risk, not evidence the approach is wrong.</p>
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
    const dialysate = productById(state.dialysateProductId);
    const replacement = productById(state.replacementProductId);
    const qd = state.modality === 'CVVH' || state.modality === 'SCUF' ? 0 : num(state.dialysateFlow_mL_hr);
    const qr = state.modality === 'CVVHD' || state.modality === 'SCUF' ? 0 : num(state.replacementPre_mL_hr) + num(state.replacementPost_mL_hr);
    const parts = [
      { flow: qd, sodium: dialysate?.compositionVerified ? dialysate.composition?.sodium : null },
      { flow: qr, sodium: replacement?.compositionVerified ? replacement.composition?.sodium : null }
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
    const citrate = productById(state.citrateProductId);
    let po4 = null;
    if (state.serumPO4_mmol_L !== '') {
      po4 = C.estimatePhosphateRemoval({ effluentRate_mL_hr: dose.effluentRate_mL_hr, serumPO4_mmol_L: num(state.serumPO4_mmol_L) });
    }
    const selectedNa = selectedSolutionSodium();
    let naCheck = null;
    if (state.serumNa_mmol_L !== '') {
      naCheck = C.sodiumGradientCheck({ serumNa_mmol_L: num(state.serumNa_mmol_L), solutionNa_mmol_L: selectedNa ?? num(state.solutionNa_mmol_L) });
    }

    return `
    <div class="card">
      <h2>Solutions &amp; electrolytes</h2>

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

      ${state.anticoag === 'citrate' ? `
      <div class="field mt-4">
        <label for="citrateProduct">Citrate product</label>
        <select id="citrateProduct">${renderProductOptions('citrate', state.citrateProductId)}</select>
        <div class="field-help">The selected concentration drives citrate-flow calculation. Confirm the local product, pump channel and RCA nomogram.</div>
      </div>
      ${renderComposition(citrate, 'Citrate')}
      ${!citrate ? '<div class="warning-inline hard">No verified citrate product is listed for this brand and market. Citrate-flow calculation is disabled. Choose the actual citrate supplier or add the locally approved product to the catalogue.</div>' : ''}` : ''}

      <h3 class="mt-4">Patient electrolytes</h3>
      <div class="input-row">
        <div class="field"><label for="serumK">Serum K⁺ <span class="unit">mmol/L</span></label><input type="number" id="serumK" value="${state.serumK_mmol_L}" step="0.1"><div class="field-help">Used to flag a selected K0 or K4 solution. It does not replace serial monitoring.</div></div>
        <div class="field"><label for="serumPO4">Serum PO₄ <span class="unit">mmol/L</span></label><input type="number" id="serumPO4" value="${state.serumPO4_mmol_L}" step="0.1"></div>
      </div>
      ${po4 ? `<div class="output-block"><div class="output-row"><span class="label">Estimated PO₄ removal</span><span class="value">${fmt(po4.po4Removal_mmol_day, 1)} mmol/day</span></div></div>` : ''}
      <p class="small muted">Hypophosphataemia is common during CRRT, particularly with phosphate-free solutions and longer treatment. Use a phosphate-containing solution or replace separately when indicated; follow the local monitoring schedule.</p>

      <h3 class="mt-4">Sodium safety</h3>
      <div class="input-row">
        <div class="field"><label for="serumNa">Serum Na⁺ <span class="unit">mmol/L</span></label><input type="number" id="serumNa" value="${state.serumNa_mmol_L}" step="1"></div>
        <div class="field"><label>Selected-fluid Na⁺ <span class="unit">mmol/L</span></label><input type="number" value="${selectedNa === null ? '' : fmt(selectedNa, 1)}" disabled><div class="field-help">Flow-weighted dialysate/replacement sodium. Citrate sodium and other infusions are not included.</div></div>
      </div>
      ${naCheck ? `
      <div class="output-block"><div class="output-row"><span class="label">Gradient</span><span class="value">${fmt(naCheck.gradient_mmol_L, 0)} mmol/L <span class="flag ${naCheck.flag ? 'red' : 'green'}">${naCheck.flag ? 'caution' : 'ok'}</span></span></div></div>
      ${naCheck.flag ? `<div class="warning-inline hard">A large solution-to-serum gradient can cause an unsafe correction rate. The gradient alone does not predict the 24-hour change. Build a patient-specific sodium plan, with frequent checks and local pharmacy/nephrology input, before starting.</div>` : ''}` : ''}

      <p class="small muted mt-4">Catalogue values support education and consistency checks, not product substitution. Verify the bag label, current monograph, connector compatibility and institution-approved protocol before use. Also expect magnesium losses with RCA, and re-check drug dosing against a CRRT-specific reference.</p>
    </div>`;
  }

  // -----------------------------------------------------------------------
  function wireEvents(root) {
    const bind = (id, key, isFloat = true, transform = null, onUpdate = null) => {
      const node = el(id);
      if (!node) return;
      const readValue = () => {
        let v = node.type === 'checkbox' ? node.checked : node.value;
        if (transform) v = transform(v);
        else if (isFloat && node.type === 'number') v = v === '' ? '' : v;
        return v;
      };
      node.addEventListener('input', () => {
        // Preserve focus while typing. The previous full re-render on every
        // keystroke made multi-digit entry effectively impossible.
        state[key] = readValue();
        if (onUpdate) onUpdate();
      });
      node.addEventListener('change', () => {
        state[key] = readValue();
        if (onUpdate) onUpdate();
        render(root);
      });
    };

    const setupChanged = () => { state.setupGenerated = false; };
    const weightInputsChanged = () => { syncDosingWeight(); setupChanged(); };

    bind('targetDeliveredDose', 'targetDeliveredDose_mL_kg_hr', true, null, setupChanged);
    bind('actualWeightKg', 'actualWeightKg', true, null, weightInputsChanged);
    bind('weightKg', 'weightKg', true, null, setupChanged);
    bind('heightCm', 'heightCm', true, v => v === '' ? null : parseFloat(v), weightInputsChanged);
    bind('hematocrit', 'hematocrit', true, null, setupChanged);
    bind('downtimePercent', 'uptimeFraction', true, v => 1 - Math.min(50, Math.max(0, num(v))) / 100, setupChanged);
    const machineChanged = () => { if (state.setupGenerated) state.machineEdited = true; };
    bind('bloodFlow', 'bloodFlow_mL_min', true, null, machineChanged);
    bind('dialysateFlow', 'dialysateFlow_mL_hr', true, null, machineChanged);
    bind('replacementPre', 'replacementPre_mL_hr', true, null, machineChanged);
    bind('replacementPost', 'replacementPost_mL_hr', true, null, machineChanged);
    bind('netUF', 'netUltrafiltration_mL_hr', true, null, machineChanged);
    bind('nonCRRTIntake', 'nonCRRTIntake_mL_hr', true, null, machineChanged);
    const sex = el('sex');
    if (sex) sex.addEventListener('change', () => {
      state.sex = sex.value;
      syncDosingWeight();
      state.setupGenerated = false;
      render(root);
    });

    const weightBasis = el('weightBasis');
    if (weightBasis) weightBasis.addEventListener('change', () => {
      state.weightBasis = weightBasis.value;
      syncDosingWeight();
      state.setupGenerated = false;
      render(root);
    });

    const generatePrescription = el('generatePrescription');
    if (generatePrescription) generatePrescription.addEventListener('click', () => {
      const suggestion = C.suggestPrescription({
        weightKg: num(state.weightKg),
        hematocrit: num(state.hematocrit),
        modality: state.modality,
        bloodFlow_mL_min: num(state.bloodFlow_mL_min),
        targetDeliveredDose_mL_kg_hr: num(state.targetDeliveredDose_mL_kg_hr),
        uptimeFraction: num(state.uptimeFraction),
        netUltrafiltration_mL_hr: num(state.netUltrafiltration_mL_hr),
        citrateFlow_mL_hr: state.anticoag === 'citrate' ? getCitrateFlow() : 0,
        citratePreFilter: state.anticoag === 'citrate' && state.citratePreFilter,
      });
      state.bloodFlow_mL_min = suggestion.bloodFlow_mL_min;
      state.dialysateFlow_mL_hr = suggestion.dialysateFlow_mL_hr;
      state.replacementPre_mL_hr = suggestion.replacementPre_mL_hr;
      state.replacementPost_mL_hr = suggestion.replacementPost_mL_hr;
      state.setupGenerated = true;
      state.machineEdited = false;
      render(root);
    });

    root.querySelectorAll('[data-modality]').forEach(btn => {
      btn.addEventListener('click', () => { state.modality = btn.dataset.modality; state.setupGenerated = false; render(root); });
    });
    root.querySelectorAll('[data-anticoag]').forEach(btn => {
      btn.addEventListener('click', () => { state.anticoag = btn.dataset.anticoag; state.setupGenerated = false; render(root); });
    });

    const marketRegion = el('marketRegion');
    if (marketRegion) marketRegion.addEventListener('change', () => {
      state.marketRegion = marketRegion.value;
      normalizeProductSelections();
      state.setupGenerated = false;
      render(root);
    });
    const solutionBrand = el('solutionBrand');
    if (solutionBrand) solutionBrand.addEventListener('change', () => {
      state.solutionBrand = solutionBrand.value;
      normalizeProductSelections();
      state.setupGenerated = false;
      render(root);
    });

    // citrate
    const presetSel = el('citratePreset');
    if (presetSel) presetSel.addEventListener('change', () => {
      const preset = (CONFIG.citrate?.presets || []).find(p => p.id === presetSel.value);
      state.citratePreset = presetSel.value;
      if (preset && preset.citrateConcentration_mmol_L !== null) {
        state.citrateConcentration_mmol_L = preset.citrateConcentration_mmol_L;
        state.citratePreFilter = !!preset.isPreFilterDiluent;
      }
      render(root);
    });
    bind('citrateConc', 'citrateConcentration_mmol_L');
    bind('citrateTargetDose', 'citrateTargetDose_mmol_L');
    bind('effluentTotalCa', 'effluentTotalCa_mmol_L');
    bind('totalCa', 'totalCa_mmol_L');
    bind('systemicICa', 'systemicICa_mmol_L');
    bind('postFilterICa', 'postFilterICa_mmol_L');
    bind('pH', 'pH');
    bind('hco3', 'hco3_mmol_L');

    // heparin
    bind('bolusUnits', 'bolusUnits');
    bind('infusionUnitsPerKgHr', 'infusionUnitsPerKgHr');
    bind('heparinConc', 'heparinConcentration_units_mL');

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
        if (key === 'citrateProductId' && product?.composition?.citrate) {
          state.citrateConcentration_mmol_L = product.composition.citrate;
          state.citrateFlow_mL_hr = null;
        }
        if (state.setupGenerated) state.machineEdited = true;
        render(root);
      });
    });
  }

  return { mount };
})();
