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
   * small-solute dose. This is intentionally protocol-agnostic: it suggests
   * machine flows, but not local solution selection or titration nomograms.
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
  }) {
    if (modality === 'SCUF') {
      return {
        bloodFlow_mL_min,
        dialysateFlow_mL_hr: 0,
        replacementPre_mL_hr: 0,
        replacementPost_mL_hr: 0,
        rationale: 'SCUF targets fluid removal, not a small-solute dose.',
      };
    }

    let qd = modality === 'CVVHD' ? 1800 : modality === 'CVVHDF' ? 1200 : 0;
    let qrTotal = modality === 'CVVH' ? 1800 : modality === 'CVVHDF' ? 600 : 0;
    let preFraction = 0;

    for (let i = 0; i < 16; i += 1) {
      let pre = qrTotal * preFraction;
      let post = qrTotal - pre;
      let result = computeDoseAndFF({
        weightKg, hematocrit, bloodFlow_mL_min,
        dialysateFlow_mL_hr: qd,
        replacementPre_mL_hr: pre,
        replacementPost_mL_hr: post,
        netUltrafiltration_mL_hr,
        citrateFlow_mL_hr,
        citratePreFilter,
        uptimeFraction,
      });

      const scale = targetDeliveredDose_mL_kg_hr / Math.max(result.correctedDeliveredDose_mL_kg_hr, 0.1);
      qd *= scale;
      qrTotal *= scale;

      if (qrTotal > 0) {
        const plasmaFlow = bloodFlow_mL_min * 60 * (1 - hematocrit);
        const citratePre = citratePreFilter ? citrateFlow_mL_hr : 0;
        const totalUF = qrTotal + netUltrafiltration_mL_hr + citratePre;
        const preNeededForFF20 = Math.max(0, totalUF / 0.20 - plasmaFlow - citratePre);
        preFraction = Math.min(0.80, preNeededForFF20 / qrTotal);
      }
    }

    const round50 = (v) => Math.max(0, Math.round(v / 50) * 50);
    const suggested = {
      bloodFlow_mL_min,
      dialysateFlow_mL_hr: round50(qd),
      replacementPre_mL_hr: round50(qrTotal * preFraction),
      replacementPost_mL_hr: round50(qrTotal * (1 - preFraction)),
    };
    const check = computeDoseAndFF({
      weightKg, hematocrit, bloodFlow_mL_min,
      ...suggested,
      netUltrafiltration_mL_hr,
      citrateFlow_mL_hr,
      citratePreFilter,
      uptimeFraction,
    });
    return {
      ...suggested,
      predictedDeliveredDose_mL_kg_hr: check.correctedDeliveredDose_mL_kg_hr,
      predictedFiltrationFraction: check.filtrationFraction,
      rationale: 'Flows are rounded to 50 mL/h, account for expected downtime and pre-dilution, and aim for filtration fraction near or below 20% when convection is used.',
    };
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
