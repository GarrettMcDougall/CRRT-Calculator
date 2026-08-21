/**
 * calc.js — CRRT calculation engine
 *
 * PURE FUNCTIONS ONLY. No DOM access. No rounding inside math — rounding
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

    let ffFlag = 'green';
    if (filtrationFraction > 0.25) ffFlag = 'red';
    else if (filtrationFraction > 0.20) ffFlag = 'amber';

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
   * CVVHDF splits the effluent budget 50% dialysate / 50% convective so the
   * caller's pre/post split of the replacement portion is meaningful.
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
    ffCeiling = 0.20,
    maxPreFraction = 0.80,
  }) {
    const floor50 = (v) => Math.max(0, Math.floor(v / 50) * 50);
    const round50 = (v) => Math.max(0, Math.round(v / 50) * 50);
    const citratePre = citratePreFilter ? citrateFlow_mL_hr : 0;
    const plasmaFlow = bloodFlow_mL_min * 60 * (1 - hematocrit);
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
        !Number.isFinite(weightKg) || weightKg <= 0) {
      warnings.push('Enter a blood flow, haematocrit, and weight above zero before generating a starting prescription.');
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
    if (citratePre > 0) {
      const plasmaWater = plasmaFlow * 0.93;
      const floorEffluent = citratePre + netUltrafiltration_mL_hr;
      const floorDilution = plasmaWater / Math.max(plasmaWater + citratePre, 1e-6);
      const floorDelivered = (floorEffluent / weightKg) * floorDilution * uptimeFraction;
      if (Number.isFinite(floorDelivered) && floorDelivered > targetDeliveredDose_mL_kg_hr * 1.10) {
        // Blood flow that would bring the citrate-imposed floor down to target.
        // Citrate flow scales with blood flow, so the floor scales with Qb/weight.
        const qbForTarget = bloodFlow_mL_min * (targetDeliveredDose_mL_kg_hr / floorDelivered);
        warnings.push(
          `The citrate solution alone delivers about ${floorDelivered.toFixed(1)} mL/kg/hr, above the ${targetDeliveredDose_mL_kg_hr.toFixed(1)} mL/kg/hr target, before any dialysate or replacement is added. `
          + `A dilute pre-filter citrate solution runs at roughly ten times blood flow, so its volume sets a minimum dose. `
          + `Reduce blood flow to roughly ${Math.round(qbForTarget / 10) * 10} mL/min, switch to a concentrated citrate product, or accept the higher dose and monitor phosphate, magnesium and drug levels closely.`
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
      preFraction = preFractionFor(qrTotal);
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
        // CVVHDF: 50% dialysate, 50% convective — gives a balanced starting
        // point that the caller's pre/post split can then act on meaningfully.
        const available = Math.max(0, requiredEffluent - netUltrafiltration_mL_hr - citratePre);
        qrTotal = Math.min(convectionCap, available * 0.50);
        qd = Math.max(0, requiredEffluent - qrTotal - netUltrafiltration_mL_hr - citratePre);
      }
    }

    // Convective volumes round DOWN so rounding never pushes FF over the ceiling.
    const flows = {
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
      });
      if (trial.filtrationFraction <= ffCeiling || flows.replacementPost_mL_hr <= 0) break;
      flows.replacementPost_mL_hr -= 50;
    }

    if (wantsConvection && convectionCap <= 0) {
      warnings.push('At this blood flow, haematocrit, and fluid-removal rate, no convective volume can be added without exceeding the filtration-fraction ceiling. Increase blood flow, or switch to a diffusive modality (CVVHD).');
    }

    // Check whether the FF ceiling prevented reaching the target.
    const achievableEffluent = flows.dialysateFlow_mL_hr + flows.replacementPre_mL_hr + flows.replacementPost_mL_hr + netUltrafiltration_mL_hr + citratePre;
    const finalPre = flows.replacementPre_mL_hr;
    const finalDilution = plasmaFlow / Math.max(plasmaFlow + finalPre + citratePre, 1e-6);
    const targetEffluent = (targetDeliveredDose_mL_kg_hr * weightKg) / Math.max(finalDilution * uptimeFraction, 1e-6);
    const targetAchieved = (targetEffluent - achievableEffluent) <= Math.max(25, targetEffluent * 0.02);

    if (!targetAchieved) {
      const qrNeeded = Math.max(0, targetEffluent - netUltrafiltration_mL_hr - citratePre);
      const plasmaFlowNeeded = (qrNeeded * (1 - ffCeiling * maxPreFraction) + netUltrafiltration_mL_hr + citratePre) / ffCeiling - citratePre;
      const qbNeeded = plasmaFlowNeeded / (60 * (1 - hematocrit));
      warnings.push(
        `Target dose is not achievable in ${modality} at Qb ${Math.round(bloodFlow_mL_min)} mL/min without exceeding a filtration fraction of ${Math.round(ffCeiling * 100)}%. `
        + (modality === 'CVVH'
          ? `Add dialysate (switch to CVVHDF): diffusive clearance does not consume filtration fraction, or increase blood flow to roughly ${asQb(qbNeeded)}.`
          : `Increase blood flow to roughly ${asQb(qbNeeded)}, or accept the lower delivered dose.`)
      );
      return finalise(flows, {
        targetAchieved: false,
        minBloodFlowForTarget_mL_min: Number.isFinite(qbNeeded) && qbNeeded > 0 ? Math.ceil(qbNeeded / 10) * 10 : null,
        rationale: 'Flows are capped by the filtration-fraction ceiling; delivered dose falls short of target. See warnings.',
      });
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
   * Estimated hourly calcium loss into effluent (order-of-magnitude only —
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

  return {
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
