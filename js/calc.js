/**
 * calc.js: CRRT calculation engine
 *
 * PURE FUNCTIONS ONLY. No DOM access. No rounding inside math; rounding
 * happens at render time in the UI layer. Every function takes a single
 * object argument and returns a single object. Units are explicit in every
 * key name (e.g. _mL_hr, _mmol_L).
 *
 * This module is loaded both by the app UI and by tests/tests.html.
 * Works as a plain <script> (attaches to window.CRRTCalc) and, if the
 * environment supports it, as an ES module export.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.CRRTCalc = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------
  // 3.1 Circuit and dose
  // ---------------------------------------------------------------------

  /**
   * Compute effluent rate, prescribed/corrected/delivered dose, plasma
   * flow, and filtration fraction.
   *
   * @param {Object} p
   * @param {number} p.weightKg
   * @param {number} p.hematocrit                 fraction, e.g. 0.30
   * @param {string} [p.modality]                  'CVVH'|'CVVHD'|'CVVHDF'|'SCUF'
   * @param {number} p.bloodFlow_mL_min             Qb
   * @param {number} [p.dialysateFlow_mL_hr=0]      Qd
   * @param {number} [p.replacementPre_mL_hr=0]
   * @param {number} [p.replacementPost_mL_hr=0]
   * @param {number} [p.netUltrafiltration_mL_hr=0] patient fluid removal
   * @param {number} [p.citrateFlow_mL_hr=0]        citrate solution rate
   * @param {boolean} [p.citratePreFilter=true]     counts as pre-dilution fluid
   * @param {number} [p.uptimeFraction=1.0]         fraction of the day the circuit actually runs
   * @param {number} [p.nonCRRTIntake_mL_hr=0]      other fluid intake, for net balance
   * @param {number} [p.ffCeiling=0.25]             protocol FF ceiling; at or below is green
   * @param {number} [p.ffRedThreshold=0.30]        above this is red; between ceiling and this is amber
   */
  function computeDoseAndFF(p) {
    const {
      weightKg,
      hematocrit,
      bloodFlow_mL_min,
      dialysateFlow_mL_hr = 0,
      replacementPre_mL_hr = 0,
      replacementPost_mL_hr = 0,
      netUltrafiltration_mL_hr = 0,
      citrateFlow_mL_hr = 0,
      citratePreFilter = true,
      uptimeFraction = 1.0,
      nonCRRTIntake_mL_hr = 0,
      ffCeiling = 0.25,
      ffRedThreshold = 0.30,
    } = p;

    const citrateAsPreDilution = citratePreFilter ? citrateFlow_mL_hr : 0;

    const effluentRate_mL_hr =
      dialysateFlow_mL_hr +
      replacementPre_mL_hr +
      replacementPost_mL_hr +
      netUltrafiltration_mL_hr +
      citrateAsPreDilution;

    const prescribedDose_mL_kg_hr = effluentRate_mL_hr / weightKg;
    const deliveredDose_mL_kg_hr = prescribedDose_mL_kg_hr * uptimeFraction;

    // Pre-dilution correction. KDIGO defines this using plasma flow.
    const plasmaFlow_mL_hr = bloodFlow_mL_min * 60 * (1 - hematocrit);
    const plasmaWaterFlow_mL_hr = plasmaFlow_mL_hr;
    const totalPreDilution_mL_hr = replacementPre_mL_hr + citrateAsPreDilution;
    const dilutionFactor =
      plasmaWaterFlow_mL_hr / (plasmaWaterFlow_mL_hr + totalPreDilution_mL_hr);
    const correctedDose_mL_kg_hr = prescribedDose_mL_kg_hr * dilutionFactor;
    const correctedDeliveredDose_mL_kg_hr = correctedDose_mL_kg_hr * uptimeFraction;

    // Filtration fraction
    // All pre- and post-filter replacement fluid must ultimately cross the
    // membrane to maintain balance. It therefore belongs in total UF and the
    // FF numerator. The previous implementation omitted pre-dilution fluid.
    const ffNumerator_mL_hr =
      replacementPre_mL_hr +
      replacementPost_mL_hr +
      netUltrafiltration_mL_hr +
      citrateAsPreDilution;
    const ffDenominator_mL_hr = plasmaFlow_mL_hr + totalPreDilution_mL_hr;
    const filtrationFraction = ffNumerator_mL_hr / ffDenominator_mL_hr;

    // Flags follow the configured protocol ceiling: within it is green,
    // above it is amber, and above the red threshold is red.
    const redAt = Math.max(ffRedThreshold, ffCeiling);
    let ffFlag = 'green';
    if (filtrationFraction > redAt) ffFlag = 'red';
    else if (filtrationFraction > ffCeiling) ffFlag = 'amber';

    // Total UF vs net UF
    const totalUltrafiltration_mL_hr = ffNumerator_mL_hr;
    // Conventional sign: positive means net fluid accumulation.
    const estimatedPatientBalance_mL_hr = nonCRRTIntake_mL_hr - netUltrafiltration_mL_hr;

    return {
      effluentRate_mL_hr,
      prescribedDose_mL_kg_hr,
      deliveredDose_mL_kg_hr,
      plasmaWaterFlow_mL_hr,
      dilutionFactor,
      correctedDose_mL_kg_hr,
      correctedDeliveredDose_mL_kg_hr,
      plasmaFlow_mL_hr,
      filtrationFraction,
      ffFlag,
      totalUltrafiltration_mL_hr,
      estimatedPatientBalance_mL_hr,
      citrateAsPreDilution_mL_hr: citrateAsPreDilution,
    };
  }

  /**
   * Build a coherent generic starting prescription around a target delivered
   * small-solute dose. The filtration-fraction ceiling is a hard constraint:
   * flows are never generated that would require an FF above ffCeiling.
   * When the target is unreachable at the given Qb, the function sets
   * targetAchieved:false and populates warnings explaining what to change.
   *
   * CVVHDF splits the effluent budget 50% dialysate / 50% convective.
   *
   * preFilterShare is the protocol's MINIMUM share of replacement fluid given
   * pre-filter (for example 0.50 with heparin, 0.20 with citrate, where the
   * citrate itself is counted separately as pre-filter fluid). It is applied
   * inside the solver, not afterwards, so the dose compensation for
   * pre-dilution, the FF ceiling, the predictions and the warnings all
   * describe exactly the flows returned. A higher pre-filter share can be
   * chosen by the solver when needed to hold FF under the ceiling; shifting
   * replacement pre-filter can only lower FF, never raise it.
   */
  function suggestPrescription({
    weightKg,
    hematocrit = 0.30,
    modality = 'CVVHDF',
    bloodFlow_mL_min = 150,
    targetDeliveredDose_mL_kg_hr = 22.5,
    uptimeFraction = 0.90,
    netUltrafiltration_mL_hr = 0,
    citrateFlow_mL_hr = 0,
    citratePreFilter = true,
    ffCeiling = 0.25,
    ffRedThreshold = 0.30,
    preFilterShare = 0,
    maxPreFraction = 0.80,
  }) {
    const floor50 = (v) => Math.max(0, Math.floor(v / 50) * 50);
    const round50 = (v) => Math.max(0, Math.round(v / 50) * 50);
    const citratePre = citratePreFilter ? citrateFlow_mL_hr : 0;
    const plasmaFlow = bloodFlow_mL_min * 60 * (1 - hematocrit);
    const minPreShare = Math.min(maxPreFraction, Math.max(0, Number.isFinite(preFilterShare) ? preFilterShare : 0));
    const warnings = [];

    // Assemble result, running computeDoseAndFF for accurate predictions.
    const finalise = (flows, extra) => {
      const check = computeDoseAndFF({
        weightKg, hematocrit, bloodFlow_mL_min,
        ...flows,
        netUltrafiltration_mL_hr,
        citrateFlow_mL_hr,
        citratePreFilter,
        uptimeFraction,
        ffCeiling,
        ffRedThreshold,
      });
      return {
        bloodFlow_mL_min,
        ...flows,
        predictedDeliveredDose_mL_kg_hr: check.correctedDeliveredDose_mL_kg_hr,
        predictedFiltrationFraction: check.filtrationFraction,
        predictedFfFlag: check.ffFlag,
        warnings,
        ...extra,
      };
    };

    // Guard: without valid inputs there is no circuit to prescribe.
    if (!Number.isFinite(plasmaFlow) || plasmaFlow <= 0 ||
        !Number.isFinite(weightKg) || weightKg <= 0 ||
        !Number.isFinite(hematocrit) || hematocrit < 0 || hematocrit >= 1 ||
        !Number.isFinite(uptimeFraction) || uptimeFraction <= 0 || uptimeFraction > 1 ||
        !Number.isFinite(netUltrafiltration_mL_hr) || netUltrafiltration_mL_hr < 0 ||
        !Number.isFinite(citrateFlow_mL_hr) || citrateFlow_mL_hr < 0 ||
        (modality !== 'SCUF' && (!Number.isFinite(targetDeliveredDose_mL_kg_hr) || targetDeliveredDose_mL_kg_hr <= 0))) {
      warnings.push('Enter a weight, blood flow and target dose above zero, a haematocrit between 0 and 1, an uptime between 0 and 100%, and a net UF of zero or more before generating a starting prescription.');
      return finalise(
        { dialysateFlow_mL_hr: 0, replacementPre_mL_hr: 0, replacementPost_mL_hr: 0 },
        { targetAchieved: false, rationale: 'Insufficient inputs.' }
      );
    }

    // Baseline check: net UF plus pre-filter citrate may already fill the
    // FF budget before any replacement is added. Runs before SCUF so SCUF
    // with a dangerously high UF rate still receives a warning.
    const asQb = (v) => (Number.isFinite(v) && v > 0 ? `${Math.ceil(v / 10) * 10} mL/min` : 'a higher rate');
    const baselineFF = (netUltrafiltration_mL_hr + citratePre) / (plasmaFlow + citratePre);
    if (!Number.isFinite(baselineFF) || baselineFF > ffCeiling) {
      const qbForNetUF = ((netUltrafiltration_mL_hr + citratePre) / ffCeiling - citratePre) / (60 * (1 - hematocrit));
      warnings.push(
        (Number.isFinite(baselineFF)
          ? `Net ultrafiltration${citratePre > 0 ? ' plus pre-filter citrate' : ''} alone gives a filtration fraction of ${Math.round(baselineFF * 100)}%, above the ${Math.round(ffCeiling * 100)}% ceiling, before any replacement fluid is added. `
          : `Blood flow is too low to support the requested net ultrafiltration${citratePre > 0 ? ' plus pre-filter citrate' : ''} at any replacement rate. `)
        + `Reduce the fluid-removal rate or increase blood flow to roughly ${asQb(qbForNetUF)}.`
      );
    }

    if (modality === 'SCUF') {
      return finalise(
        { dialysateFlow_mL_hr: 0, replacementPre_mL_hr: 0, replacementPost_mL_hr: 0 },
        { targetAchieved: warnings.length === 0, rationale: 'SCUF targets fluid removal only. No small-solute dose is prescribed.' }
      );
    }

    // Dose FLOOR check. A dilute pre-filter citrate solution (e.g. Regiocit or
    // Prismocitrate 18 mmol/L) runs at roughly 10x blood flow in L/hr, so its
    // volume alone can already exceed the target dose in a small patient or at
    // a high blood flow. No choice of dialysate or replacement can bring the
    // dose back down, so this must be surfaced rather than silently delivered.
    let floorWarned = false;
    if (citratePre > 0 || netUltrafiltration_mL_hr > 0) {
      // Same plasma-flow basis as computeDoseAndFF, so this floor matches the
      // delivered dose the output table will show.
      const floorEffluent = citratePre + netUltrafiltration_mL_hr;
      const floorDilution = plasmaFlow / Math.max(plasmaFlow + citratePre, 1e-6);
      const floorDelivered = (floorEffluent / weightKg) * floorDilution * uptimeFraction;
      if (Number.isFinite(floorDelivered) && floorDelivered > targetDeliveredDose_mL_kg_hr * 1.10) {
        // Blood flow that would bring the citrate-imposed floor down to target.
        // Citrate flow scales with blood flow, so the floor scales with Qb/weight.
        const qbForTarget = bloodFlow_mL_min * (targetDeliveredDose_mL_kg_hr / floorDelivered);
        floorWarned = true;
        const citrateDominant = citratePre >= netUltrafiltration_mL_hr;
        warnings.push(citrateDominant
          ? `The citrate solution${netUltrafiltration_mL_hr > 0 ? ' plus net ultrafiltration' : ''} alone delivers about ${floorDelivered.toFixed(1)} mL/kg/hr, above the ${targetDeliveredDose_mL_kg_hr.toFixed(1)} mL/kg/hr target, before any dialysate or replacement is added. `
            + `A dilute pre-filter citrate solution runs at roughly ten times blood flow, so its volume sets a minimum dose. `
            + `Reduce blood flow to roughly ${Math.round(qbForTarget / 10) * 10} mL/min, switch to a concentrated citrate product, or accept the higher dose and monitor phosphate, magnesium and drug levels closely.`
          : `Net ultrafiltration${citratePre > 0 ? ' plus pre-filter citrate' : ''} alone delivers about ${floorDelivered.toFixed(1)} mL/kg/hr, above the ${targetDeliveredDose_mL_kg_hr.toFixed(1)} mL/kg/hr target, before any dialysate or replacement is added. `
            + `Fluid removal counts toward effluent dose. Accept the higher dose while this fluid-removal rate is needed, and monitor phosphate, magnesium and drug levels closely.`
        );
      }
    }

    // Maximum convective volume that keeps FF at or below the ceiling
    // given a pre-dilution fraction p:
    //   (qr + netUF + citratePre) <= FF * (plasmaFlow + qr*p + citratePre)
    const convectionCapAt = (p) => {
      const denom = 1 - ffCeiling * p;
      if (denom <= 0) return Infinity;
      return (ffCeiling * (plasmaFlow + citratePre) - netUltrafiltration_mL_hr - citratePre) / denom;
    };
    const convectionCap = Math.max(0, convectionCapAt(maxPreFraction));

    // Pre-dilution fraction needed to hold FF at the ceiling for a given qr.
    const preFractionFor = (qr) => {
      if (qr <= 0) return 0;
      const totalUF = qr + netUltrafiltration_mL_hr + citratePre;
      const preNeeded = totalUF / ffCeiling - plasmaFlow - citratePre;
      return Math.min(maxPreFraction, Math.max(0, preNeeded / qr));
    };

    const wantsConvection = modality === 'CVVH' || modality === 'CVVHDF';
    let qrTotal = 0, qd = 0, preFraction = 0;

    for (let i = 0; i < 40; i++) {
      preFraction = qrTotal > 0 ? Math.max(minPreShare, preFractionFor(qrTotal)) : minPreShare;
      const pre = qrTotal * preFraction;
      const dilutionFactor = plasmaFlow / Math.max(plasmaFlow + pre + citratePre, 1e-6);
      const requiredEffluent = (targetDeliveredDose_mL_kg_hr * weightKg) / Math.max(dilutionFactor * uptimeFraction, 1e-6);

      if (modality === 'CVVHD') {
        qrTotal = 0;
        qd = Math.max(0, requiredEffluent - netUltrafiltration_mL_hr - citratePre);
      } else if (modality === 'CVVH') {
        qrTotal = Math.min(convectionCap, Math.max(0, requiredEffluent - netUltrafiltration_mL_hr - citratePre));
        qd = 0;
      } else {
        // CVVHDF: 50% dialysate, 50% convective, as a balanced starting point.
        const available = Math.max(0, requiredEffluent - netUltrafiltration_mL_hr - citratePre);
        qrTotal = Math.min(convectionCap, available * 0.50);
        qd = Math.max(0, requiredEffluent - qrTotal - netUltrafiltration_mL_hr - citratePre);
      }
    }

    // Convective volumes round DOWN so rounding never pushes FF over the ceiling.
    let flows = {
      dialysateFlow_mL_hr: round50(qd),
      replacementPre_mL_hr: floor50(qrTotal * preFraction),
      replacementPost_mL_hr: floor50(qrTotal * (1 - preFraction)),
    };

    // Belt-and-braces: trim post-filter in 50 mL steps if rounding still
    // leaves FF above the ceiling.
    for (let guard = 0; guard < 200; guard++) {
      const trial = computeDoseAndFF({
        weightKg, hematocrit, bloodFlow_mL_min, ...flows,
        netUltrafiltration_mL_hr, citrateFlow_mL_hr, citratePreFilter, uptimeFraction,
        ffCeiling, ffRedThreshold,
      });
      if (trial.filtrationFraction <= ffCeiling) break;
      if (flows.replacementPost_mL_hr > 0) flows.replacementPost_mL_hr -= 50;
      else if (flows.replacementPre_mL_hr > 0) flows.replacementPre_mL_hr -= 50;
      else break;
    }

    // A residual replacement rate under 100 mL/hr is not a meaningful order.
    // A small post-filter rate folds into pre-filter (this can only lower FF).
    // A small pre-filter rate folds into post-filter only if FF stays within
    // the ceiling. The top-up below restores any dose lost.
    if (modality === 'CVVHDF' && flows.replacementPre_mL_hr + flows.replacementPost_mL_hr < 100) {
      // Total replacement too small to order: dialysate top-up covers it.
      flows = { ...flows, replacementPre_mL_hr: 0, replacementPost_mL_hr: 0 };
    }
    if (wantsConvection) {
      if (flows.replacementPost_mL_hr > 0 && flows.replacementPost_mL_hr < 100 && flows.replacementPre_mL_hr > 0) {
        flows = { ...flows,
          replacementPre_mL_hr: flows.replacementPre_mL_hr + flows.replacementPost_mL_hr,
          replacementPost_mL_hr: 0 };
      }
      if (flows.replacementPre_mL_hr > 0 && flows.replacementPre_mL_hr < 100 && flows.replacementPost_mL_hr > 0) {
        const folded = { ...flows,
          replacementPost_mL_hr: flows.replacementPost_mL_hr + flows.replacementPre_mL_hr,
          replacementPre_mL_hr: 0 };
        if (computeDoseAndFF({
          weightKg, hematocrit, bloodFlow_mL_min, ...folded,
          netUltrafiltration_mL_hr, citrateFlow_mL_hr, citratePreFilter, uptimeFraction,
          ffCeiling, ffRedThreshold,
        }).filtrationFraction <= ffCeiling) flows = folded;
      }
    }

    const evaluate = (fl) => computeDoseAndFF({
      weightKg, hematocrit, bloodFlow_mL_min, ...fl,
      netUltrafiltration_mL_hr, citrateFlow_mL_hr, citratePreFilter, uptimeFraction,
      ffCeiling, ffRedThreshold,
    });

    // Recover dose lost to rounding convective flows down. Dialysate costs no
    // filtration fraction, so modalities that use it top up there. Pure CVVH
    // can only add convection while FF stays within the ceiling.
    const doseTolerance = 0.25;
    for (let guard = 0; guard < 400; guard++) {
      const now = evaluate(flows);
      if (!(now.correctedDeliveredDose_mL_kg_hr < targetDeliveredDose_mL_kg_hr - doseTolerance)) break;
      if (modality === 'CVVHD' || modality === 'CVVHDF') {
        flows = { ...flows, dialysateFlow_mL_hr: flows.dialysateFlow_mL_hr + 50 };
        continue;
      }
      // Grow an existing post-filter rate first (more efficient); if there
      // is none, grow pre-filter so a token 50 mL/hr post rate is not created.
      const morePost = { ...flows, replacementPost_mL_hr: flows.replacementPost_mL_hr + 50 };
      const morePre = { ...flows, replacementPre_mL_hr: flows.replacementPre_mL_hr + 50 };
      const order = flows.replacementPost_mL_hr > 0 ? [morePost, morePre] : [morePre, morePost];
      const next = order.find(fl => evaluate(fl).filtrationFraction <= ffCeiling);
      if (!next) break;
      flows = next;
    }

    if (wantsConvection && convectionCap <= 0) {
      warnings.push('At this blood flow, haematocrit, and fluid-removal rate, no convective volume can be added without exceeding the filtration-fraction ceiling. Increase blood flow, or switch to a diffusive modality (CVVHD).');
    }

    // Was the target reached? Only pure CVVH can be limited by the FF
    // ceiling here, because every other modality can add dialysate.
    const finalCheck = evaluate(flows);
    const targetAchieved = finalCheck.correctedDeliveredDose_mL_kg_hr >= targetDeliveredDose_mL_kg_hr - 0.5;

    if (!targetAchieved) {
      const finalPre = flows.replacementPre_mL_hr;
      const finalDilution = plasmaFlow / Math.max(plasmaFlow + finalPre + citratePre, 1e-6);
      const targetEffluent = (targetDeliveredDose_mL_kg_hr * weightKg) / Math.max(finalDilution * uptimeFraction, 1e-6);
      const qrNeeded = Math.max(0, targetEffluent - netUltrafiltration_mL_hr - citratePre);
      const plasmaFlowNeeded = (qrNeeded * (1 - ffCeiling * maxPreFraction) + netUltrafiltration_mL_hr + citratePre) / ffCeiling - citratePre;
      const qbNeeded = plasmaFlowNeeded / (60 * (1 - hematocrit));
      warnings.push(
        modality === 'CVVH'
          ? `Target dose is not achievable in CVVH at Qb ${Math.round(bloodFlow_mL_min)} mL/min without exceeding a filtration fraction of ${Math.round(ffCeiling * 100)}%. Add dialysate (switch to CVVHDF), because diffusive clearance does not consume filtration fraction, or increase blood flow to roughly ${asQb(qbNeeded)}.`
          : `The generated flows deliver ${finalCheck.correctedDeliveredDose_mL_kg_hr.toFixed(1)} mL/kg/hr, below the ${targetDeliveredDose_mL_kg_hr.toFixed(1)} mL/kg/hr target. Review the inputs and adjust flows manually.`
      );
      return finalise(flows, {
        targetAchieved: false,
        minBloodFlowForTarget_mL_min: Number.isFinite(qbNeeded) && qbNeeded > 0 ? Math.ceil(qbNeeded / 10) * 10 : null,
        rationale: 'Flows are capped by the filtration-fraction ceiling; delivered dose falls short of target. See warnings.',
      });
    }

    // Diffusive modality generated with no dialysate: the citrate solution
    // and net UF already provide the dose. Say so, because the machine is
    // then running as pre-dilution haemofiltration with citrate alone.
    if ((modality === 'CVVHD' || modality === 'CVVHDF') && flows.dialysateFlow_mL_hr === 0 && !floorWarned) {
      warnings.push(`No dialysate${modality === 'CVVHDF' ? ' or replacement' : ''} is needed: the ${citratePre > 0 ? 'citrate solution' : 'fixed volumes'}${netUltrafiltration_mL_hr > 0 ? ' and net ultrafiltration' : ''} already deliver the target dose at this blood flow. Clearance is then entirely convective from pre-filter fluid. Confirm this is intended, or lower blood flow if a dialysate component is wanted.`);
    }

    // Overshoot not already explained (for example 50 mL/hr rounding in a
    // very small patient) still needs to be surfaced.
    if (!floorWarned && finalCheck.correctedDeliveredDose_mL_kg_hr > targetDeliveredDose_mL_kg_hr * 1.10) {
      warnings.push(`The generated flows deliver ${finalCheck.correctedDeliveredDose_mL_kg_hr.toFixed(1)} mL/kg/hr, above the ${targetDeliveredDose_mL_kg_hr.toFixed(1)} mL/kg/hr target, because machine flows are set in 50 mL/hr steps. Check the weight entered and adjust flows manually.`);
    }

    return finalise(flows, {
      targetAchieved: true,
      rationale: 'Flows rounded to 50 mL/hr, corrected for expected downtime and pre-filter dilution, constrained so filtration fraction stays at or below the ceiling.',
    });
  }

  /**
   * Adjusted body weight helper for the obesity advisory.
   * Devine formula. Returns null if height not provided.
   */
  function computeBMIAndAdjustedWeight({ weightKg, heightCm, sex = 'unspecified' }) {
    if (!heightCm) return { bmi: null, adjustedBodyWeightKg: null };
    const heightM = heightCm / 100;
    const bmi = weightKg / (heightM * heightM);

    if (sex !== 'male' && sex !== 'female') {
      return { bmi, ibwKg: null, adjustedBodyWeightKg: null };
    }

    // Devine IBW (kg): assumes heightCm > 152.4
    const heightIn = heightCm / 2.54;
    const inchesOver5ft = Math.max(0, heightIn - 60);
    let ibwKg;
    if (sex === 'female') {
      ibwKg = 45.5 + 2.3 * inchesOver5ft;
    } else {
      ibwKg = 50 + 2.3 * inchesOver5ft;
    }
    const adjustedBodyWeightKg = ibwKg + 0.4 * (weightKg - ibwKg);

    return { bmi, ibwKg, adjustedBodyWeightKg };
  }

  // ---------------------------------------------------------------------
  // 3.2 Regional citrate anticoagulation
  // ---------------------------------------------------------------------

  /**
   * Citrate infusion rate needed to hit a target dose (mmol citrate per
   * litre of blood flow).
   */
  function citrateFlowFromTargetDose({
    bloodFlow_mL_min,
    targetCitrateDose_mmol_L,
    citrateConcentration_mmol_L,
  }) {
    const citrateFlow_mL_hr =
      (targetCitrateDose_mmol_L * bloodFlow_mL_min * 60) / citrateConcentration_mmol_L;
    return { citrateFlow_mL_hr };
  }

  /**
   * Inverse: given an actual citrate infusion rate, what dose is being
   * delivered per litre of blood flow.
   */
  function citrateDoseFromFlow({
    citrateFlow_mL_hr,
    citrateConcentration_mmol_L,
    bloodFlow_mL_min,
  }) {
    const actualCitrateDose_mmol_L =
      (citrateFlow_mL_hr * citrateConcentration_mmol_L) / (bloodFlow_mL_min * 60);

    let doseFlag = 'green';
    if (actualCitrateDose_mmol_L < 2.0 || actualCitrateDose_mmol_L > 5.0) {
      doseFlag = 'red';
    } else if (actualCitrateDose_mmol_L < 3.0 || actualCitrateDose_mmol_L > 4.0) {
      doseFlag = 'amber';
    }

    return { actualCitrateDose_mmol_L, doseFlag };
  }

  /**
   * Estimated hourly calcium loss into effluent (order-of-magnitude only;
   * UI must label this as an estimate, not a prescription).
   */
  function estimateCalciumLoss({ effluentRate_mL_hr, effluentTotalCa_mmol_L = 1.5 }) {
    const effluentRate_L_hr = effluentRate_mL_hr / 1000;
    const caLoss_mmol_hr = effluentRate_L_hr * effluentTotalCa_mmol_L;
    return { caLoss_mmol_hr };
  }

  /**
   * Convert an elemental-calcium mmol/hr requirement into mL/hr of a given
   * product.
   * CaCl2 10% = 0.68 mmol elemental Ca / mL
   * Ca gluconate 10% = 0.22 mmol elemental Ca / mL
   */
  const CALCIUM_PRODUCT_CONCENTRATION_mmol_mL = {
    cacl2_10pct: 0.68,
    ca_gluconate_10pct: 0.22,
  };

  function calciumMlPerHour({ caTarget_mmol_hr, product = 'cacl2_10pct' }) {
    const conc = CALCIUM_PRODUCT_CONCENTRATION_mmol_mL[product];
    if (!conc) throw new Error(`Unknown calcium product: ${product}`);
    return { mL_hr: caTarget_mmol_hr / conc, concentration_mmol_mL: conc };
  }

  /**
   * Citrate accumulation ratio and flag.
   */
  function citrateAccumulationCheck({ totalCa_mmol_L, systemicICa_mmol_L }) {
    const caRatio = totalCa_mmol_L / systemicICa_mmol_L;
    return { caRatio, accumulationFlag: caRatio > 2.5 };
  }

  /**
   * Qualitative acid-base discrimination for citrate patients.
   * Returns one of: 'alkalosis', 'acidosis_underbuffering',
   * 'acidosis_accumulation', 'normal'.
   */
  function citrateAcidBasePattern({ pH, hco3_mmol_L, caRatio, hco3Normal = [22, 26], pHNormal = [7.35, 7.45] }) {
    const isAlkalotic = pH > pHNormal[1] || hco3_mmol_L > hco3Normal[1];
    const isAcidotic = pH < pHNormal[0] || hco3_mmol_L < hco3Normal[0];
    const accumulating = caRatio > 2.5;

    if (isAlkalotic) return 'alkalosis';
    if (isAcidotic && accumulating) return 'acidosis_accumulation';
    if (isAcidotic && !accumulating) return 'acidosis_underbuffering';
    return 'normal';
  }

  // ---------------------------------------------------------------------
  // 3.3 Systemic heparin
  // ---------------------------------------------------------------------

  function computeHeparinDosing({
    weightKg,
    bolusUnits = null,
    bolusUnitsPerKg = null,
    infusionUnitsPerKgHr = 7.5,
    heparinConcentration_units_mL,
  }) {
    const calculatedBolusUnits = bolusUnits !== null
      ? bolusUnits
      : weightKg * (bolusUnitsPerKg || 0);
    const infusionUnits_hr = weightKg * infusionUnitsPerKgHr;
    const infusionRate_mL_hr = infusionUnits_hr / heparinConcentration_units_mL;
    return { bolusUnits: calculatedBolusUnits, infusionUnits_hr, infusionRate_mL_hr };
  }

  // ---------------------------------------------------------------------
  // 3.4 Phosphate
  // ---------------------------------------------------------------------

  function estimatePhosphateRemoval({ effluentRate_mL_hr, serumPO4_mmol_L }) {
    const effluentRate_L_hr = effluentRate_mL_hr / 1000;
    const po4Removal_mmol_day = effluentRate_L_hr * serumPO4_mmol_L * 24;
    return { po4Removal_mmol_day };
  }

  // ---------------------------------------------------------------------
  // 3.5 Sodium safety
  // ---------------------------------------------------------------------

  function sodiumGradientCheck({ serumNa_mmol_L, solutionNa_mmol_L, warnThreshold = 10 }) {
    const gradient_mmol_L = Math.abs(solutionNa_mmol_L - serumNa_mmol_L);
    return { gradient_mmol_L, flag: gradient_mmol_L > warnThreshold };
  }

  // ---------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------

  /**
   * Delivered-dose check from what the machine actually removed.
   *
   * KDIGO advises checking the delivered dose, not just the prescribed one.
   * The measured effluent volume already includes downtime, so no uptime
   * factor is applied. The pre-dilution correction uses the dilution factor
   * of the current settings, which assumes they were unchanged over the
   * period.
   *
   * @param {number} effluentVolume_mL     total effluent over the period
   * @param {number} periodHours           length of the period (usually 24)
   * @param {number} weightKg              dosing weight
   * @param {number} [dilutionFactor=1]    from computeDoseAndFF for the current settings
   * @param {number} [prescribedEffluent_mL_hr]  current prescribed effluent rate
   * @param {number} [runningHours]        hours the circuit actually ran, if known
   */
  function deliveredDoseFromEffluent({
    effluentVolume_mL,
    periodHours = 24,
    weightKg,
    dilutionFactor = 1,
    prescribedEffluent_mL_hr = null,
    runningHours = null,
  }) {
    const valid = Number.isFinite(effluentVolume_mL) && effluentVolume_mL > 0 &&
      Number.isFinite(periodHours) && periodHours > 0 &&
      Number.isFinite(weightKg) && weightKg > 0;
    if (!valid) return { valid: false };
    const df = Number.isFinite(dilutionFactor) && dilutionFactor > 0 && dilutionFactor <= 1 ? dilutionFactor : 1;
    const averageEffluent_mL_hr = effluentVolume_mL / periodHours;
    const deliveredUncorrected_mL_kg_hr = averageEffluent_mL_hr / weightKg;
    const deliveredCorrected_mL_kg_hr = deliveredUncorrected_mL_kg_hr * df;
    const effectiveUptime = Number.isFinite(prescribedEffluent_mL_hr) && prescribedEffluent_mL_hr > 0
      ? averageEffluent_mL_hr / prescribedEffluent_mL_hr
      : null;
    const reportedUptime = Number.isFinite(runningHours) && runningHours > 0 && runningHours <= periodHours
      ? runningHours / periodHours
      : null;
    return {
      valid: true,
      averageEffluent_mL_hr,
      deliveredUncorrected_mL_kg_hr,
      deliveredCorrected_mL_kg_hr,
      dilutionFactorUsed: df,
      effectiveUptime,
      reportedUptime,
    };
  }

  /**
   * Hand-calculation method for teaching. Returns every intermediate value
   * so the Learn tab can walk a trainee through the arithmetic one step at a
   * time. It uses one correction round for pre-dilution (what a clinician
   * would do on paper) and then checks the result with computeDoseAndFF.
   * The Prescribe tab's suggestPrescription iterates further and enforces
   * the FF ceiling, so its flows may differ by a rounding step.
   *
   * CVVHDF budget: half dialysate, half replacement. Replacement pre-filter
   * share: 20% with citrate (the citrate is separate pre-filter fluid), 50%
   * otherwise.
   */
  function teachingPrescription({
    weightKg,
    hematocrit = 0.30,
    modality = 'CVVHDF',
    anticoag = 'citrate',
    citrateConcentration_mmol_L = 18,
    citrateDose_mmol_L = 3,
    bloodFlow_mL_min = 150,
    targetDeliveredDose_mL_kg_hr = 25,
    uptimeFraction = 0.9,
    netUltrafiltration_mL_hr = 0,
    ffCeiling = 0.25,
    ffRedThreshold = 0.30,
  }) {
    const round50 = (v) => Math.max(0, Math.round(v / 50) * 50);
    const citrate = anticoag === 'citrate';
    const preShare = citrate ? 0.20 : 0.50;

    // 1. Downtime-adjusted effluent, before any pre-dilution correction.
    const effluentBeforeDilution_mL_hr = (targetDeliveredDose_mL_kg_hr * weightKg) / uptimeFraction;

    // 2. Citrate flow (citrate solution runs pre-filter).
    const citrateFlow_mL_hr = citrate && citrateConcentration_mmol_L > 0
      ? (citrateDose_mmol_L * bloodFlow_mL_min * 60) / citrateConcentration_mmol_L
      : 0;

    // 3. Plasma flow and a first estimate of pre-filter replacement.
    const plasmaFlow_mL_hr = bloodFlow_mL_min * 60 * (1 - hematocrit);
    const fixed_mL_hr = netUltrafiltration_mL_hr + citrateFlow_mL_hr;
    const firstRemainder = effluentBeforeDilution_mL_hr - fixed_mL_hr;
    const convectiveShare = modality === 'CVVH' ? 1 : modality === 'CVVHDF' ? 0.5 : 0;
    const preEstimate_mL_hr = round50(Math.max(0, firstRemainder) * convectiveShare * preShare);

    // 4. Dilution factor and corrected effluent target.
    const preFilterTotal_mL_hr = citrateFlow_mL_hr + preEstimate_mL_hr;
    const dilutionFactor = plasmaFlow_mL_hr / (plasmaFlow_mL_hr + preFilterTotal_mL_hr);
    const effluentTarget_mL_hr = effluentBeforeDilution_mL_hr / dilutionFactor;

    // 5. Split what remains after the fixed volumes.
    const remainder_mL_hr = effluentTarget_mL_hr - fixed_mL_hr;
    // Under 100 mL/hr left over is not worth ordering: the fixed volumes
    // (citrate solution and net UF) already provide the dose.
    const floorExceeded = remainder_mL_hr < 100;
    let dialysate = 0, pre = 0, post = 0;
    if (!floorExceeded) {
      const replacementTotal = remainder_mL_hr * convectiveShare;
      pre = round50(replacementTotal * preShare);
      post = round50(replacementTotal - pre);
      dialysate = modality === 'CVVH' ? 0 : round50(remainder_mL_hr - pre - post);
    }

    const evaluate = (qd, qpre, qpost) => computeDoseAndFF({
      weightKg, hematocrit, bloodFlow_mL_min,
      dialysateFlow_mL_hr: qd,
      replacementPre_mL_hr: qpre,
      replacementPost_mL_hr: qpost,
      netUltrafiltration_mL_hr,
      citrateFlow_mL_hr,
      citratePreFilter: true,
      uptimeFraction,
      ffCeiling,
      ffRedThreshold,
    });

    // 6. First check of filtration fraction.
    const initial = { dialysateFlow_mL_hr: dialysate, replacementPre_mL_hr: pre, replacementPost_mL_hr: post };
    const initialCheck = evaluate(dialysate, pre, post);

    // 7. If FF is above the ceiling, fix it the way a clinician would.
    //    CVVHDF: move post-filter replacement to dialysate (dose unchanged).
    //    CVVH: move post-filter replacement pre-filter (dose falls a little).
    let ffAdjustment = null;
    if (initialCheck.filtrationFraction > ffCeiling && !floorExceeded) {
      const numeratorWithoutPost = pre + netUltrafiltration_mL_hr + citrateFlow_mL_hr;
      if (modality === 'CVVHDF') {
        const postMax = ffCeiling * (plasmaFlow_mL_hr + pre + citrateFlow_mL_hr) - numeratorWithoutPost;
        const newPost = Math.max(0, Math.floor(postMax / 50) * 50);
        const shift = post - newPost;
        dialysate += shift; post = newPost;
        ffAdjustment = { move_mL_hr: shift, from: 'post-filter replacement', to: 'dialysate', doseEffect: 'none' };
      } else if (modality === 'CVVH') {
        const numerator = pre + post + netUltrafiltration_mL_hr + citrateFlow_mL_hr;
        const needed = numerator / ffCeiling - plasmaFlow_mL_hr - citrateFlow_mL_hr - pre;
        const shift = Math.min(post, Math.ceil(needed / 50) * 50);
        pre += shift; post -= shift;
        ffAdjustment = { move_mL_hr: shift, from: 'post-filter replacement', to: 'pre-filter replacement', doseEffect: 'falls' };
      }
    }
    const check = evaluate(dialysate, pre, post);
    if (ffAdjustment) {
      ffAdjustment.ffBefore = initialCheck.filtrationFraction;
      ffAdjustment.ffAfter = check.filtrationFraction;
      ffAdjustment.stillAbove = check.filtrationFraction > ffCeiling;
    }

    return {
      preShare,
      effluentBeforeDilution_mL_hr,
      citrateFlow_mL_hr,
      plasmaFlow_mL_hr,
      fixed_mL_hr,
      preEstimate_mL_hr,
      preFilterTotal_mL_hr,
      dilutionFactor,
      effluentTarget_mL_hr,
      remainder_mL_hr,
      floorExceeded,
      initialSplit: initial,
      initialCheck,
      ffAdjustment,
      dialysateFlow_mL_hr: dialysate,
      replacementPre_mL_hr: pre,
      replacementPost_mL_hr: post,
      check,
      ffAboveCeiling: check.filtrationFraction > ffCeiling,
    };
  }

  return {
    teachingPrescription,
    deliveredDoseFromEffluent,
    computeDoseAndFF,
    suggestPrescription,
    computeBMIAndAdjustedWeight,
    citrateFlowFromTargetDose,
    citrateDoseFromFlow,
    estimateCalciumLoss,
    calciumMlPerHour,
    CALCIUM_PRODUCT_CONCENTRATION_mmol_mL,
    citrateAccumulationCheck,
    citrateAcidBasePattern,
    computeHeparinDosing,
    estimatePhosphateRemoval,
    sodiumGradientCheck,
  };
});
