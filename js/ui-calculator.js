/**
 * ui-calculator.js — the Prescribe mode. One continuous prescription
 * builder: circuit & dose, then a modality-specific anticoagulation panel,
 * then solutions/electrolytes. Re-renders whole panel on any input change
 * (no framework, so this keeps state/DOM in sync simply and safely).
 */
window.CRRTUICalculator = (function () {
  'use strict';

  const C = window.CRRTCalc;
  let CONFIG = null;

  // ---- module state (clinical inputs — never persisted to localStorage) ----
  let state = {
    weightKg: 80,
    heightCm: null,
    sex: 'unspecified',
    hematocrit: 0.30,
    modality: 'CVVHDF',
    bloodFlow_mL_min: 150,
    dialysateFlow_mL_hr: 1500,
    replacementPre_mL_hr: 0,
    replacementPost_mL_hr: 500,
    netUltrafiltration_mL_hr: 100,
    nonCRRTIntake_mL_hr: 0,
    uptimeFraction: 1.0,

    anticoag: 'citrate', // 'citrate' | 'heparin' | 'none'

    // citrate
    citratePreset: 'acda',
    citrateConcentration_mmol_L: 113,
    citratePreFilter: false,
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
    bolusUnitsPerKg: 25,
    infusionUnitsPerKgHr: 7.5,
    heparinConcentration_units_mL: 100,

    // solutions
    serumPO4_mmol_L: '',
    serumNa_mmol_L: '',
    solutionNa_mmol_L: 140,
  };

  function num(v, fallback = 0) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function fmt(v, digits = 1) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return v.toFixed(digits);
  }

  function el(id) { return document.getElementById(id); }

  // -----------------------------------------------------------------------
  async function mount(root) {
    if (!CONFIG) CONFIG = await window.CRRTStore.loadConfig();
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

    const bmi = C.computeBMIAndAdjustedWeight({ weightKg: state.weightKg, heightCm: state.heightCm, sex: state.sex });

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
      <p class="muted small">A continuous prescription builder — circuit and dose are coupled to anticoagulation and fluid removal below, because that's how they actually behave.</p>

      <div class="grid-2">
        <div>
          ${renderCircuitCard(dose, bmi)}
          ${renderAnticoagSelector()}
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

  function getCitrateFlow() {
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
  function renderCircuitCard(dose, bmi) {
    return `
    <div class="card">
      <h2>Circuit &amp; dose</h2>
      <div class="input-row">
        <div class="field">
          <label for="weightKg">Weight <span class="unit">kg</span></label>
          <input type="number" id="weightKg" value="${state.weightKg}" min="1" step="0.5">
        </div>
        <div class="field">
          <label for="heightCm">Height <span class="unit">cm (optional)</span></label>
          <input type="number" id="heightCm" value="${state.heightCm ?? ''}" min="0" step="1">
        </div>
        <div class="field">
          <label for="hematocrit">Hematocrit <span class="unit">fraction</span></label>
          <input type="number" id="hematocrit" value="${state.hematocrit}" min="0.1" max="0.6" step="0.01">
        </div>
      </div>

      ${bmi.bmi ? `
        <div class="warning-inline">
          BMI ${fmt(bmi.bmi)}. ${bmi.bmi > 30 ? `Dosing to actual weight may over-prescribe in obesity. Adjusted body weight ≈ <strong>${fmt(bmi.adjustedBodyWeightKg)} kg</strong> — shown for comparison, not as a recommendation. Use clinical judgement.` : 'Within normal range for weight-based dosing.'}
        </div>` : ''}

      <label>Modality</label>
      <div class="btn-group" id="modalityGroup">
        ${['CVVH', 'CVVHD', 'CVVHDF', 'SCUF'].map(m => `<button type="button" class="btn-toggle ${state.modality === m ? 'selected' : ''}" data-modality="${m}">${m}</button>`).join('')}
      </div>

      <div class="input-row mt-4">
        <div class="field">
          <label for="bloodFlow">Blood flow (Qb) <span class="unit">mL/min</span></label>
          <input type="number" id="bloodFlow" value="${state.bloodFlow_mL_min}" min="0" step="10">
        </div>
        ${state.modality !== 'CVVH' && state.modality !== 'SCUF' ? `
        <div class="field">
          <label for="dialysateFlow">Dialysate (Qd) <span class="unit">mL/hr</span></label>
          <input type="number" id="dialysateFlow" value="${state.dialysateFlow_mL_hr}" min="0" step="50">
        </div>` : ''}
      </div>
      ${state.bloodFlow_mL_min > 250 ? `<div class="warning-inline">Qb > 250 mL/min — access-dependent; confirm catheter and access pressure limits.</div>` : ''}

      <div class="input-row">
        <div class="field">
          <label for="replacementPre">Pre-dilution replacement <span class="unit">mL/hr</span></label>
          <input type="number" id="replacementPre" value="${state.replacementPre_mL_hr}" min="0" step="50">
        </div>
        <div class="field">
          <label for="replacementPost">Post-dilution replacement <span class="unit">mL/hr</span></label>
          <input type="number" id="replacementPost" value="${state.replacementPost_mL_hr}" min="0" step="50">
        </div>
      </div>

      <div class="input-row">
        <div class="field">
          <label for="netUF">Net UF / patient fluid removal <span class="unit">mL/hr</span></label>
          <input type="number" id="netUF" value="${state.netUltrafiltration_mL_hr}" min="0" step="10">
        </div>
        <div class="field">
          <label for="nonCRRTIntake">Other fluid intake <span class="unit">mL/hr (optional)</span></label>
          <input type="number" id="nonCRRTIntake" value="${state.nonCRRTIntake_mL_hr}" min="0" step="10">
        </div>
        <div class="field">
          <label for="uptime">Expected uptime <span class="unit">fraction (1.0 = no downtime)</span></label>
          <input type="number" id="uptime" value="${state.uptimeFraction}" min="0.1" max="1" step="0.01">
        </div>
      </div>

      <div class="output-block">
        <div class="output-row"><span class="label">Effluent rate</span><span class="value">${fmt(dose.effluentRate_mL_hr, 0)} mL/hr</span></div>
        <div class="output-row"><span class="label">Prescribed dose</span><span class="value">${fmt(dose.prescribedDose_mL_kg_hr)} mL/kg/hr</span></div>
        <div class="output-row"><span class="label">Pre-dilution–corrected dose</span><span class="value">${fmt(dose.correctedDose_mL_kg_hr)} mL/kg/hr</span></div>
        <div class="output-row"><span class="label">Delivered dose (corrected × uptime)</span><span class="value big">${fmt(dose.correctedDeliveredDose_mL_kg_hr)} mL/kg/hr</span></div>
        <div class="output-row"><span class="label">Filtration fraction</span><span class="value">${fmt(dose.filtrationFraction * 100)}% <span class="flag ${dose.ffFlag}">${dose.ffFlag}</span></span></div>
        <div class="output-row"><span class="label">Total UF (crosses membrane)</span><span class="value">${fmt(dose.totalUltrafiltration_mL_hr, 0)} mL/hr</span></div>
        <div class="output-row"><span class="label">Net fluid balance</span><span class="value">${fmt(dose.netFluidBalance_mL_hr, 0)} mL/hr</span></div>
      </div>
      ${dose.prescribedDose_mL_kg_hr > 40 ? `<div class="warning-inline hard">Prescribed dose above trial-tested range. RENAL and ATN showed no benefit over 20–25 mL/kg/hr delivered.</div>` : ''}
      ${dose.ffFlag === 'amber' ? `<div class="warning-inline">FF 25–30%: haemoconcentration risk. Expect shortened filter life — consider increasing Qb, shifting replacement pre-filter, or reducing post-filter rate.</div>` : ''}
      ${dose.ffFlag === 'red' ? `<div class="warning-inline hard">FF &gt; 30%: significant haemoconcentration risk to the filter. Adjust flow/dilution settings now.</div>` : ''}

      <details class="working">
        <summary>Show working</summary>
        <div class="formula">effluent = Qd + replacementPre + replacementPost + netUF (+ citrate if pre-filter)
         = ${fmt(state.dialysateFlow_mL_hr, 0)} + ${fmt(state.replacementPre_mL_hr, 0)} + ${fmt(state.replacementPost_mL_hr, 0)} + ${fmt(state.netUltrafiltration_mL_hr, 0)} + ${fmt(dose.citrateAsPreDilution_mL_hr, 0)}
         = ${fmt(dose.effluentRate_mL_hr, 0)} mL/hr

prescribed dose = effluent / weight = ${fmt(dose.effluentRate_mL_hr, 0)} / ${state.weightKg} = ${fmt(dose.prescribedDose_mL_kg_hr)} mL/kg/hr

plasma water flow = Qb × 60 × (1 − Hct) × 0.93
 = ${state.bloodFlow_mL_min} × 60 × (1 − ${state.hematocrit}) × 0.93 = ${fmt(dose.plasmaWaterFlow_mL_hr, 0)} mL/hr

dilution factor = plasma water / (plasma water + pre-dilution total) = ${fmt(dose.dilutionFactor, 3)}
corrected dose = prescribed × dilution factor = ${fmt(dose.correctedDose_mL_kg_hr)} mL/kg/hr
delivered = corrected × uptime (${state.uptimeFraction}) = ${fmt(dose.correctedDeliveredDose_mL_kg_hr)} mL/kg/hr

FF = (replacementPost + netUF) / (plasma flow + pre-dilution total) = ${fmt(dose.filtrationFraction * 100)}%</div>
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
    const preset = (CONFIG.citrate?.presets || []).find(p => p.id === state.citratePreset) || {};
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
    const caMl = C.calciumMlPerHour({ caTarget_mmol_hr: caLoss.caLoss_mmol_hr, product: state.calciumProduct });

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
      acidosis_underbuffering: { title: 'Metabolic acidosis — under-buffering', body: 'Normal calcium ratio. Increase bicarbonate (dialysate or systemic).', cls: 'amber' },
      acidosis_accumulation: { title: 'Metabolic acidosis — citrate accumulation', body: 'High calcium ratio. This is a metabolism failure, not under-buffering — reduce or stop citrate rather than adding buffer.', cls: 'red' },
      normal: { title: 'No acid-base concern flagged', body: '', cls: 'green' },
    };

    return `
    <div class="card accent-card mod-citrate">
      <h2><span class="tag">Citrate</span> Regional citrate anticoagulation</h2>

      <div class="field">
        <label for="citratePreset">Citrate solution preset</label>
        <select id="citratePreset">
          ${(CONFIG.citrate?.presets || []).map(p => `<option value="${p.id}" ${state.citratePreset === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}
        </select>
        <div class="small muted">${preset.source || ''} — verify against your local product monograph.</div>
      </div>

      <div class="input-row">
        <div class="field">
          <label for="citrateConc">Citrate concentration <span class="unit">mmol/L</span></label>
          <input type="number" id="citrateConc" value="${state.citrateConcentration_mmol_L}" min="1" step="0.5" ${state.citratePreset !== 'custom' ? 'disabled' : ''}>
        </div>
        <div class="field">
          <label for="citrateTargetDose">Target citrate dose <span class="unit">mmol/L blood</span></label>
          <input type="number" id="citrateTargetDose" value="${state.citrateTargetDose_mmol_L}" min="1" max="6" step="0.1">
        </div>
        <div class="field">
          <label><input type="checkbox" id="citratePreFilterOverride" ${state.citratePreFilter ? 'checked' : ''}> Solution is pre-filter diluent</label>
        </div>
      </div>

      <div class="output-block">
        <div class="output-row"><span class="label">Citrate infusion rate</span><span class="value big">${fmt(citrateFlow)} mL/hr</span></div>
        <div class="output-row"><span class="label">Actual delivered dose</span><span class="value">${fmt(doseCheck.actualCitrateDose_mmol_L, 2)} mmol/L <span class="flag ${doseCheck.doseFlag}">${doseCheck.doseFlag}</span></span></div>
      </div>
      ${state.citratePreFilter ? `<div class="warning-inline">This solution is counted as pre-filter (pre-dilution) fluid above — it changes effluent dose and the pre-dilution correction.</div>` : ''}

      <details class="working">
        <summary>Show working</summary>
        <div class="formula">citrate flow = target dose × Qb × 60 / concentration
 = ${state.citrateTargetDose_mmol_L} × ${state.bloodFlow_mL_min} × 60 / ${state.citrateConcentration_mmol_L} = ${fmt(citrateFlow)} mL/hr</div>
      </details>

      <h3 class="mt-4">Calcium replacement</h3>
      <div class="warning-inline">Order-of-magnitude estimate only — titrate against your site's calcium nomogram, not this number alone.</div>
      <div class="input-row">
        <div class="field">
          <label for="effluentTotalCa">Effluent total Ca <span class="unit">mmol/L (config default)</span></label>
          <input type="number" id="effluentTotalCa" value="${state.effluentTotalCa_mmol_L}" min="0" step="0.1">
        </div>
        <div class="field">
          <label for="calciumProduct">Calcium product</label>
          <select id="calciumProduct">
            <option value="cacl2_10pct" ${state.calciumProduct === 'cacl2_10pct' ? 'selected' : ''}>CaCl₂ 10% (0.68 mmol/mL) — central line preferred</option>
            <option value="ca_gluconate_10pct" ${state.calciumProduct === 'ca_gluconate_10pct' ? 'selected' : ''}>Ca gluconate 10% (0.22 mmol/mL)</option>
          </select>
        </div>
      </div>
      <div class="output-block">
        <div class="output-row"><span class="label">Estimated Ca loss</span><span class="value">${fmt(caLoss.caLoss_mmol_hr, 2)} mmol/hr</span></div>
        <div class="output-row"><span class="label">Estimated starting infusion</span><span class="value">${fmt(caMl.mL_hr, 2)} mL/hr</span></div>
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
      ${!accumulation ? `<div class="small muted">Enter total Ca and systemic iCa above to enable this panel — the calcium ratio is required to distinguish accumulation from under-buffering.</div>` : ''}
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
    const rows = (table.bySystemicICa || []).map(r => `<div class="output-row"><span class="label">${describeRange(r, 'systemicICa_mmol_L')}</span><span class="value">${r.action}</span></div>`).join('');
    return `<div class="output-block">${rows}</div><p class="small muted">Placeholder nomogram — replace in config/local-protocol.json with your site's approved table.</p>`;
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
      weightKg: state.weightKg,
      bolusUnitsPerKg: state.bolusUnitsPerKg,
      infusionUnitsPerKgHr: state.infusionUnitsPerKgHr,
      heparinConcentration_units_mL: state.heparinConcentration_units_mL,
    });
    const targets = CONFIG.heparin?.targets || {};

    return `
    <div class="card accent-card mod-heparin">
      <h2><span class="tag">Heparin</span> Systemic heparin</h2>
      <div class="warning-inline">Omit the bolus in active bleeding, recent surgery, post-cardiotomy, or thrombocytopenia.</div>

      <div class="input-row">
        <div class="field"><label for="bolusUnitsPerKg">Bolus <span class="unit">U/kg</span></label><input type="number" id="bolusUnitsPerKg" value="${state.bolusUnitsPerKg}" min="0" max="30" step="1"></div>
        <div class="field"><label for="infusionUnitsPerKgHr">Infusion <span class="unit">U/kg/hr</span></label><input type="number" id="infusionUnitsPerKgHr" value="${state.infusionUnitsPerKgHr}" min="0" max="15" step="0.5"></div>
        <div class="field"><label for="heparinConc">Solution concentration <span class="unit">U/mL</span></label><input type="number" id="heparinConc" value="${state.heparinConcentration_units_mL}" min="1" step="1"></div>
      </div>

      <div class="output-block">
        <div class="output-row"><span class="label">Bolus dose</span><span class="value">${fmt(h.bolusUnits, 0)} units</span></div>
        <div class="output-row"><span class="label">Infusion rate</span><span class="value big">${fmt(h.infusionRate_mL_hr, 2)} mL/hr</span></div>
        <div class="output-row"><span class="label">Infusion dose</span><span class="value">${fmt(h.infusionUnits_hr, 0)} units/hr</span></div>
      </div>

      <p class="small muted">Targets (config): aPTT ${targets.aPTT_s?.min ?? '—'}–${targets.aPTT_s?.max ?? '—'} s (or ${targets.aPTTMultipleOfBaseline ?? '1.5'}× baseline)${targets.antiXa_IU_mL ? `; anti-Xa ${targets.antiXa_IU_mL.min}–${targets.antiXa_IU_mL.max} IU/mL if used` : ''}.</p>

      <div class="warning-inline hard">
        <strong>HIT:</strong> if platelets fall &gt; 50% from baseline or thrombosis develops, stop ALL heparin including flushes. Alternatives: argatroban or bivalirudin. Consider a 4Ts assessment (not scored in this app).
      </div>
    </div>`;
  }

  function renderNoAnticoagPanel() {
    return `
    <div class="card accent-card mod-none">
      <h2><span class="tag">None</span> No anticoagulation strategy</h2>
      <p>Higher blood flow, pre-dilution replacement, and minimising circuit interruptions extend filter life without anticoagulation. Accept shorter filter life as the trade-off — this is the expected and correct cost of this strategy in active bleeding or high bleeding risk, not evidence the approach is wrong.</p>
    </div>`;
  }

  // -----------------------------------------------------------------------
  function renderSolutionsPanel(dose) {
    let po4 = null;
    if (state.serumPO4_mmol_L !== '') {
      po4 = C.estimatePhosphateRemoval({ effluentRate_mL_hr: dose.effluentRate_mL_hr, serumPO4_mmol_L: num(state.serumPO4_mmol_L) });
    }
    let naCheck = null;
    if (state.serumNa_mmol_L !== '') {
      naCheck = C.sodiumGradientCheck({ serumNa_mmol_L: num(state.serumNa_mmol_L), solutionNa_mmol_L: num(state.solutionNa_mmol_L) });
    }

    return `
    <div class="card">
      <h2>Solutions &amp; electrolytes</h2>

      <h3>Phosphate</h3>
      <div class="input-row">
        <div class="field"><label for="serumPO4">Serum PO₄ <span class="unit">mmol/L</span></label><input type="number" id="serumPO4" value="${state.serumPO4_mmol_L}" step="0.1"></div>
      </div>
      ${po4 ? `<div class="output-block"><div class="output-row"><span class="label">Estimated PO₄ removal</span><span class="value">${fmt(po4.po4Removal_mmol_day, 1)} mmol/day</span></div></div>` : ''}
      <p class="small muted">Hypophosphataemia is near-universal by 24–48 h on conventional-dose CRRT. Use a phosphate-containing solution or replace separately; monitor at least ${CONFIG.electrolytes?.phosphateMonitoringMinFrequencyHours ?? 12}-hourly, more often in the first 48 h or at high dose.</p>

      <h3 class="mt-4">Sodium safety</h3>
      <div class="input-row">
        <div class="field"><label for="serumNa">Serum Na⁺ <span class="unit">mmol/L</span></label><input type="number" id="serumNa" value="${state.serumNa_mmol_L}" step="1"></div>
        <div class="field"><label for="solutionNa">Solution Na⁺ <span class="unit">mmol/L</span></label><input type="number" id="solutionNa" value="${state.solutionNa_mmol_L}" step="1"></div>
      </div>
      ${naCheck ? `
      <div class="output-block"><div class="output-row"><span class="label">Gradient</span><span class="value">${fmt(naCheck.gradient_mmol_L, 0)} mmol/L <span class="flag ${naCheck.flag ? 'red' : 'green'}">${naCheck.flag ? 'caution' : 'ok'}</span></span></div></div>
      ${naCheck.flag ? `<div class="warning-inline hard">Gradient exceeds ~10–12 mmol/L. CRRT corrects sodium fast and continuously — for chronic hyponatraemia, consider custom low-sodium solution, D5W into the circuit, or reduced effluent dose. Involve a staff physician and pharmacy.</div>` : ''}` : ''}

      <p class="small muted mt-4">Also expect magnesium losses (worse with citrate), and re-check antimicrobial and other renally-cleared drug dosing against a CRRT-specific reference — standard renal dosing tables don't apply.</p>
    </div>`;
  }

  // -----------------------------------------------------------------------
  function wireEvents(root) {
    const bind = (id, key, isFloat = true, transform = null) => {
      const node = el(id);
      if (!node) return;
      node.addEventListener('input', () => {
        let v = node.type === 'checkbox' ? node.checked : node.value;
        if (transform) v = transform(v);
        else if (isFloat && node.type === 'number') v = v === '' ? '' : v;
        state[key] = v;
        render(root);
      });
      node.addEventListener('change', () => {
        let v = node.type === 'checkbox' ? node.checked : node.value;
        if (transform) v = transform(v);
        state[key] = v;
        render(root);
      });
    };

    bind('weightKg', 'weightKg');
    bind('heightCm', 'heightCm', true, v => v === '' ? null : parseFloat(v));
    bind('hematocrit', 'hematocrit');
    bind('bloodFlow', 'bloodFlow_mL_min');
    bind('dialysateFlow', 'dialysateFlow_mL_hr');
    bind('replacementPre', 'replacementPre_mL_hr');
    bind('replacementPost', 'replacementPost_mL_hr');
    bind('netUF', 'netUltrafiltration_mL_hr');
    bind('nonCRRTIntake', 'nonCRRTIntake_mL_hr');
    bind('uptime', 'uptimeFraction');

    root.querySelectorAll('[data-modality]').forEach(btn => {
      btn.addEventListener('click', () => { state.modality = btn.dataset.modality; render(root); });
    });
    root.querySelectorAll('[data-anticoag]').forEach(btn => {
      btn.addEventListener('click', () => { state.anticoag = btn.dataset.anticoag; render(root); });
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
    const preFilterCb = el('citratePreFilterOverride');
    if (preFilterCb) preFilterCb.addEventListener('change', () => { state.citratePreFilter = preFilterCb.checked; render(root); });
    bind('effluentTotalCa', 'effluentTotalCa_mmol_L');
    const calciumProductSel = el('calciumProduct');
    if (calciumProductSel) calciumProductSel.addEventListener('change', () => { state.calciumProduct = calciumProductSel.value; render(root); });
    bind('totalCa', 'totalCa_mmol_L');
    bind('systemicICa', 'systemicICa_mmol_L');
    bind('postFilterICa', 'postFilterICa_mmol_L');
    bind('pH', 'pH');
    bind('hco3', 'hco3_mmol_L');

    // heparin
    bind('bolusUnitsPerKg', 'bolusUnitsPerKg');
    bind('infusionUnitsPerKgHr', 'infusionUnitsPerKgHr');
    bind('heparinConc', 'heparinConcentration_units_mL');

    // solutions
    bind('serumPO4', 'serumPO4_mmol_L');
    bind('serumNa', 'serumNa_mmol_L');
    bind('solutionNa', 'solutionNa_mmol_L');
  }

  return { mount };
})();
