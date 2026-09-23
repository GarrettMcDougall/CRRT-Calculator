/**
 * ui-prescribing.js: "Learn to prescribe". One walkthrough engine drives both
 * the guided prescription builder and the prescribing cases:
 *
 *   intro → decisions (verdict + why) → calculations (learner tries each
 *   step, then sees the worked answer) → effect explorer → order summary.
 *
 * All arithmetic comes from CRRTCalc.teachingPrescription and
 * computeDoseAndFF, so the numbers match the Prescribe tab's engine.
 */
window.CRRTUIPrescribing = (function () {
  'use strict';

  const C = window.CRRTCalc;
  const Store = new Proxy({}, { get: (_, k) => window.CRRTStore[k] });
  let DATA = null;
  let CONFIG = null;
  let run = null; // current walkthrough

  async function ensureData() {
    if (!DATA) DATA = await Store.loadData('prescribing');
    if (!CONFIG) CONFIG = await Store.loadConfig();
  }

  // ---- formatting ----------------------------------------------------------
  function fmt(v, d = 0) { return Number.isFinite(v) ? v.toFixed(d) : '–'; }
  function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  const VERDICT = {
    best: { cls: 'green', label: 'Preferred' },
    ok: { cls: 'amber', label: 'Reasonable' },
    avoid: { cls: 'red', label: 'Avoid' },
  };

  function ffLimits() {
    const f = (CONFIG && CONFIG.filtrationFraction) || {};
    const ceiling = Number.isFinite(f.ceiling) ? f.ceiling : 0.25;
    return { ffCeiling: ceiling, ffRedThreshold: Math.max(Number.isFinite(f.redThreshold) ? f.redThreshold : 0.30, ceiling) };
  }

  // ---- run state -----------------------------------------------------------
  function startRun(kind, src) {
    const p = src.patient;
    run = {
      kind, src,
      rx: Object.assign({ citrateDose: 3 }, p.defaults),
      order: {},
      index: 0,
      stepState: {},
      explore: null,
    };
  }

  function weights() {
    const p = run.src.patient;
    return C.computeBMIAndAdjustedWeight({ weightKg: p.weightKg, heightCm: p.heightCm, sex: p.sex });
  }

  function dosingWeight() {
    const w = weights();
    if (run.rx.weightBasis === 'adjusted' && w.adjustedBodyWeightKg) return w.adjustedBodyWeightKg;
    if (run.rx.weightBasis === 'ideal' && w.ibwKg) return w.ibwKg;
    return run.src.patient.weightKg;
  }

  function teach() {
    const rx = run.rx;
    return C.teachingPrescription(Object.assign({
      weightKg: dosingWeight(),
      hematocrit: run.src.patient.hematocrit,
      modality: rx.modality,
      anticoag: rx.anticoag,
      citrateConcentration_mmol_L: rx.citrateConc,
      citrateDose_mmol_L: rx.citrateDose,
      bloodFlow_mL_min: rx.bloodFlow,
      targetDeliveredDose_mL_kg_hr: rx.target,
      uptimeFraction: rx.uptime,
      netUltrafiltration_mL_hr: rx.netUF,
    }, ffLimits()));
  }

  function matches(when) {
    if (!when) return true;
    const rx = run.rx;
    if (when.anticoag && !when.anticoag.includes(rx.anticoag)) return false;
    if (when.modality && !when.modality.includes(rx.modality)) return false;
    if (typeof when.citrateDilute === 'boolean' && ((rx.citrateConc < 50) !== when.citrateDilute)) return false;
    return true;
  }

  // The step list depends on earlier choices, so it is rebuilt each render.
  // Earlier steps never change once passed, so the index stays valid.
  function steps() {
    const list = [{ type: 'intro' }];
    run.src.decisions.filter(d => matches(d.when)).forEach(d => list.push({ type: 'choice', d }));
    const calcs = ['weight', 'effluent0'];
    if (run.rx.anticoag === 'citrate') calcs.push('citrate');
    calcs.push('dilution', 'effluent', 'split', 'ff', 'check');
    calcs.forEach(c => list.push({ type: 'calc', c }));
    list.push({ type: 'explore' }, { type: 'summary' });
    return list;
  }

  // ---- mounting --------------------------------------------------------------
  async function mountBuilder(root) {
    await ensureData();
    startRun('builder', DATA.builder);
    render(root);
  }

  async function mountCasesList(root) {
    await ensureData();
    const progress = Store.get('rxCaseProgress', {});
    root.innerHTML = `
      <h1>Prescribing cases</h1>
      <p class="muted small">Short vignettes. Make the calls, then work out the numbers: weight, effluent, citrate, pre-dilution, the split and FF.</p>
      <div class="grid-cols">
        ${DATA.cases.map(c => `
          <a href="#/learn/prescribing/${c.id}" class="card accent-card mod-${c.tag}" style="text-decoration:none;color:inherit;display:block;">
            <span class="tag">${c.tag === 'none' ? 'no anticoagulation' : c.tag}</span>
            <h3>${esc(c.title)}</h3>
            <p class="small muted">${progress[c.id] ? 'Completed' : 'Not started'}</p>
          </a>`).join('')}
      </div>
      <p class="small mt-4"><a href="#/learn/cases">Advanced and troubleshooting cases →</a></p>`;
  }

  async function mountCase(root, id) {
    await ensureData();
    const c = DATA.cases.find(x => x.id === id);
    if (!c) { root.innerHTML = '<p>Case not found. <a href="#/learn/prescribing">Back to prescribing cases</a></p>'; return; }
    startRun('case', c);
    render(root);
  }

  // ---- rendering -------------------------------------------------------------
  function render(root) {
    const list = steps();
    const step = list[run.index];
    const title = run.kind === 'builder' ? DATA.builder.title : run.src.title;
    let body = '';
    if (step.type === 'intro') body = renderIntro();
    else if (step.type === 'choice') body = renderChoice(step.d);
    else if (step.type === 'calc') body = renderCalc(step.c);
    else if (step.type === 'explore') body = renderExplore();
    else body = renderSummary();

    root.innerHTML = `
      <h1>${esc(title)}</h1>
      <div class="step-progress">
        ${list.map((s, i) => `<div class="dot ${i < run.index ? 'done' : i === run.index ? 'current' : ''}"></div>`).join('')}
      </div>
      <div class="grid-2">
        <div>${body}</div>
        <div>${renderSidebar()}</div>
      </div>`;
    wire(root, step);
    if (typeof window.scrollTo === 'function') { try { window.scrollTo(0, 0); } catch (e) { /* jsdom */ } }
  }

  function renderSidebar() {
    const p = run.src.patient;
    const rx = run.rx;
    const orderLines = Object.values(run.order);
    return `
      <div class="card order-sheet">
        <h3>Patient</h3>
        <div class="item"><span class="k">Weight</span><span class="v">${fmt(p.weightKg)} kg${p.heightCm ? `, ${p.heightCm} cm` : ''}</span></div>
        <div class="item"><span class="k">Haematocrit</span><span class="v">${p.hematocrit}</span></div>
        <div class="item"><span class="k">Working prescription</span><span class="v">${rx.modality}, ${anticoagLabel(rx.anticoag)}</span></div>
        <h3 class="mt-4">Order sheet so far</h3>
        ${orderLines.length ? orderLines.map(l => `<div class="item"><span class="v">${esc(l)}</span></div>`).join('') : '<p class="small muted">Nothing decided yet.</p>'}
      </div>`;
  }

  function anticoagLabel(a) {
    return a === 'citrate' ? `regional citrate ${run.rx.citrateConc} mmol/L` : a === 'heparin' ? 'systemic heparin' : 'no anticoagulation';
  }

  function nav(nextLabel = 'Next', showNext = true) {
    return `<div class="mt-4 rx-nav">
      ${run.index > 0 ? '<button type="button" class="secondary" data-nav="back">Back</button>' : ''}
      ${showNext ? `<button type="button" class="primary" data-nav="next">${nextLabel}</button>` : ''}
    </div>`;
  }

  function renderIntro() {
    const isBuilder = run.kind === 'builder';
    return `
      <div class="card accent-card mod-${run.src.tag || 'citrate'}">
        <p><strong>${isBuilder ? 'Patient' : 'Stem'}:</strong> ${esc(run.src.stem)}</p>
      </div>
      <div class="card">
        <h2>How this works</h2>
        <p>Make each decision, then calculate the prescription by hand one step at a time.</p>
        <p class="small muted">Try each step before showing the working. Flows are rounded to 50 mL/hr. This is a generic teaching method; follow your local protocol.</p>
        ${nav('Start')}
      </div>`;
  }

  // ---- decisions ---------------------------------------------------------------
  function renderChoice(d) {
    const ss = run.stepState[d.key] || {};
    const opts = d.options.filter(o => matches(o.when));
    const picked = ss.picked !== undefined ? opts[ss.picked] : null;
    const accepted = picked && picked.verdict !== 'avoid';
    return `
      <div class="card">
        <span class="eyebrow">Decision</span>
        <h2>${esc(d.title)}</h2>
        <div id="rxOptions">
          ${opts.map((o, i) => {
            const tried = (ss.tried || []).includes(i);
            const cls = tried ? (o.verdict === 'avoid' ? 'chosen-incorrect' : 'chosen-correct') : '';
            return `<button type="button" class="case-option ${cls}" data-opt="${i}" ${accepted ? 'disabled' : ''}>${esc(o.label)}</button>`;
          }).join('')}
        </div>
        ${picked ? `
        <div class="feedback-box">
          <p><span class="flag ${VERDICT[picked.verdict].cls}">${VERDICT[picked.verdict].label}</span> ${esc(picked.feedback)}</p>
          ${picked.verdict === 'avoid' ? '<p class="small muted">Choose another option.</p>' : ''}
        </div>` : ''}
        ${accepted ? `
        <div class="teach-box">
          <h3>Why this matters</h3>
          <p>${esc(d.teach)}</p>
          ${d.theoryLink ? `<a href="#/theory/${d.theoryLink}" class="small">Read more in Theory →</a>` : ''}
        </div>
        ${d.effect ? renderEffects(d.effect) : ''}` : ''}
        ${nav('Next', !!accepted)}
      </div>`;
  }

  function renderEffects(key) {
    const e = DATA.effects[key];
    if (!e) return '';
    const cell = (t) => t ? esc(t) : '<span class="muted">No specific effect.</span>';
    return `
      <details class="working effects" open>
        <summary>Effect of changing ${esc(e.label.toLowerCase())}</summary>
        <p class="small"><strong>Typical values:</strong> ${esc(e.typical)}</p>
        <div class="effects-table">
          <div class="eh"></div><div class="eh">In general</div><div class="eh">With citrate</div><div class="eh">With heparin or no anticoagulation</div>
          ${[['Increase ↑', e.up], ['Decrease ↓', e.down]].map(([lab, v]) => `
          <div class="er">${lab}</div>
          <div><span class="elabel">In general: </span>${cell(v.both)}</div>
          <div><span class="elabel">With citrate: </span>${cell(v.citrate)}</div>
          <div><span class="elabel">With heparin or no anticoagulation: </span>${cell(v.heparin)}</div>`).join('')}
        </div>
      </details>`;
  }

  // ---- calculations ------------------------------------------------------------
  // Each calc returns { title, explain, formula, inputs:[{id,label,unit,answer,tol}], working, effects[], note }
  function calcSpec(c) {
    const t = teach();
    const rx = run.rx;
    const p = run.src.patient;
    const W = dosingWeight();
    const w = weights();
    const u = rx.uptime;
    const cit = rx.anticoag === 'citrate';
    const ceil = ffLimits().ffCeiling;
    switch (c) {
      case 'weight': {
        const basis = rx.weightBasis || 'actual';
        const working = basis === 'actual'
          ? `Dosing weight = actual weight = ${fmt(W, 1)} kg`
          : `IBW (Devine, ${p.sex}) = ${p.sex === 'female' ? '45.5' : '50'} + 2.3 × (height in inches − 60)
 = ${p.sex === 'female' ? '45.5' : '50'} + 2.3 × (${fmt(p.heightCm / 2.54, 1)} − 60) = ${fmt(w.ibwKg, 1)} kg
${basis === 'adjusted' ? `Adjusted weight = IBW + 0.4 × (actual − IBW)
 = ${fmt(w.ibwKg, 1)} + 0.4 × (${fmt(p.weightKg, 0)} − ${fmt(w.ibwKg, 1)}) = ${fmt(W, 1)} kg` : `Dosing weight = IBW = ${fmt(W, 1)} kg`}`;
        return {
          title: 'Step 1: dosing weight',
          explain: basis === 'actual'
            ? 'Dose is per kg. Usually actual or pre-illness weight.'
            : 'Adjusted weight: work out IBW, then add 40% of the excess.',
          inputs: [{ id: 'w', label: 'Dosing weight', unit: 'kg', answer: W, tol: 1 }],
          working,
        };
      }
      case 'effluent0':
        return {
          title: 'Step 2: effluent target, allowing for downtime',
          explain: `${fmt(rx.target, 1)} mL/kg/hr is the delivered target. The circuit runs about ${fmt(u * 100)}% of the day, so divide by uptime.`,
          formula: 'effluent (before pre-dilution) = target × weight ÷ uptime',
          inputs: [{ id: 'e0', label: 'Effluent before pre-dilution correction', unit: 'mL/hr', answer: t.effluentBeforeDilution_mL_hr, tol: 0.02, rel: true }],
          working: `= ${fmt(rx.target, 1)} × ${fmt(W, 1)} ÷ ${fmt(u, 2)} = ${fmt(t.effluentBeforeDilution_mL_hr)} mL/hr`,
          note: 'Usually 1500–3000 mL/hr in adults. Effluent = dialysate + replacement + net UF + any pre-filter citrate.',
        };
      case 'citrate':
        return {
          title: 'Step 3: citrate flow',
          explain: `Citrate is dosed per litre of blood: ${fmt(rx.citrateDose, 1)} mmol/L at Qb ${rx.bloodFlow}, using ${rx.citrateConc} mmol/L solution.`,
          formula: 'citrate flow (mL/hr) = citrate dose × Qb × 60 ÷ concentration',
          inputs: [{ id: 'cit', label: 'Citrate flow', unit: 'mL/hr', answer: t.citrateFlow_mL_hr, tol: 0.02, rel: true }],
          working: `= ${fmt(rx.citrateDose, 1)} × ${rx.bloodFlow} × 60 ÷ ${rx.citrateConc} = ${fmt(t.citrateFlow_mL_hr)} mL/hr`,
          note: rx.citrateConc < 50
            ? `Shortcut: 18 mmol/L at 3 mmol/L ≈ 10 × Qb. It runs pre-filter, so it counts toward effluent, pre-dilution and FF.`
            : `Shortcut: ACD-A at 3 mmol/L ≈ 1.6 × Qb. Small volume, so little effect on dose or FF.`,
          effects: ['citrateDose'],
        };
      case 'dilution':
        return {
          title: `Step ${cit ? 4 : 3}: pre-dilution correction`,
          explain: `Pre-filter fluid dilutes the blood, so each mL of effluent clears less. Use a first estimate of pre-filter replacement (${cit ? '20% of replacement with citrate' : '50% of replacement with heparin or no anticoagulation'}${rx.modality === 'CVVHD' ? '; none in CVVHD' : ''}): ${fmt(t.preEstimate_mL_hr)} mL/hr.`,
          formula: 'plasma flow = Qb × 60 × (1 − Hct)\ndilution factor = plasma flow ÷ (plasma flow + pre-filter fluid)',
          inputs: [
            { id: 'qp', label: 'Plasma flow', unit: 'mL/hr', answer: t.plasmaFlow_mL_hr, tol: 0.02, rel: true },
            { id: 'df', label: 'Dilution factor', unit: '0 to 1', answer: t.dilutionFactor, tol: 0.01, digits: 3 },
          ],
          working: `plasma flow = ${rx.bloodFlow} × 60 × (1 − ${p.hematocrit}) = ${fmt(t.plasmaFlow_mL_hr)} mL/hr
pre-filter fluid = ${cit ? `citrate ${fmt(t.citrateFlow_mL_hr)} + ` : ''}replacement estimate ${fmt(t.preEstimate_mL_hr)} = ${fmt(t.preFilterTotal_mL_hr)} mL/hr
dilution factor = ${fmt(t.plasmaFlow_mL_hr)} ÷ (${fmt(t.plasmaFlow_mL_hr)} + ${fmt(t.preFilterTotal_mL_hr)}) = ${fmt(t.dilutionFactor, 3)}`,
          note: t.dilutionFactor < 0.85
            ? `${fmt((1 - t.dilutionFactor) * 100)}% of clearance lost to dilution, mostly from the ${cit ? 'citrate' : 'pre-filter replacement'}.`
            : `Little lost to pre-dilution.`,
          effects: ['pre'],
        };
      case 'effluent':
        return {
          title: `Step ${cit ? 5 : 4}: effluent target after pre-dilution`,
          explain: 'Divide by the dilution factor.',
          formula: 'prescribed effluent = effluent before correction ÷ dilution factor',
          inputs: [{ id: 'e', label: 'Prescribed effluent', unit: 'mL/hr', answer: t.effluentTarget_mL_hr, tol: 0.02, rel: true }],
          working: `= ${fmt(t.effluentBeforeDilution_mL_hr)} ÷ ${fmt(t.dilutionFactor, 3)} = ${fmt(t.effluentTarget_mL_hr)} mL/hr
= ${fmt(t.effluentTarget_mL_hr / W, 1)} mL/kg/hr prescribed, to deliver ${fmt(rx.target, 1)} mL/kg/hr`,
          note: 'Why prescribed doses run 25–35 mL/kg/hr for a 20–25 delivered target.',
        };
      case 'split': {
        const fixedParts = [];
        if (rx.netUF > 0) fixedParts.push(`net UF ${rx.netUF}`);
        if (cit) fixedParts.push(`citrate ${fmt(t.citrateFlow_mL_hr)}`);
        const inputs = [];
        if (!t.floorExceeded) {
          if (rx.modality !== 'CVVH') inputs.push({ id: 'qd', label: 'Dialysate', unit: 'mL/hr', answer: t.initialSplit.dialysateFlow_mL_hr, tol: 50 });
          if (rx.modality !== 'CVVHD') {
            inputs.push({ id: 'pre', label: 'Pre-filter replacement', unit: 'mL/hr', answer: t.initialSplit.replacementPre_mL_hr, tol: 50 });
            inputs.push({ id: 'post', label: 'Post-filter replacement', unit: 'mL/hr', answer: t.initialSplit.replacementPost_mL_hr, tol: 50 });
          }
        }
        const share = Math.round(t.preShare * 100);
        const how = rx.modality === 'CVVHDF'
          ? `CVVHDF: half dialysate, half replacement (${share}% pre / ${100 - share}% post).`
          : rx.modality === 'CVVH'
            ? `CVVH: all replacement (${share}% pre / ${100 - share}% post).`
            : 'CVVHD: all dialysate.';
        return {
          title: `Step ${cit ? 6 : 5}: split the effluent`,
          explain: `Subtract the fixed volumes (${fixedParts.length ? fixedParts.join(' + ') + ' mL/hr' : 'none here'}), then split the rest. ${how} Round to 50.`,
          formula: 'remainder = prescribed effluent − net UF − citrate',
          inputs,
          working: t.floorExceeded
            ? `remainder = ${fmt(t.effluentTarget_mL_hr)} − ${fmt(t.fixed_mL_hr)} = ${fmt(t.remainder_mL_hr)} mL/hr
Less than 100 mL/hr is left, so no dialysate or replacement is needed: the citrate solution${rx.netUF > 0 ? ' and net UF' : ''} already provide the dose.`
            : `remainder = ${fmt(t.effluentTarget_mL_hr)} − ${fmt(t.fixed_mL_hr)} = ${fmt(t.remainder_mL_hr)} mL/hr
${rx.modality === 'CVVHDF' ? `replacement = ${fmt(t.remainder_mL_hr)} × 0.5 = ${fmt(t.remainder_mL_hr * 0.5)} mL/hr\n` : ''}${rx.modality !== 'CVVHD' ? `pre-filter = ${share}% → ${t.initialSplit.replacementPre_mL_hr} mL/hr; post-filter → ${t.initialSplit.replacementPost_mL_hr} mL/hr\n` : ''}${rx.modality !== 'CVVH' ? `dialysate → ${t.initialSplit.dialysateFlow_mL_hr} mL/hr` : ''}`,
          note: t.floorExceeded
            ? 'Dilute citrate sets a dose floor. If it is above target, lower Qb or use a concentrated citrate.'
            : 'Pre-filter replacement may differ slightly from the estimate. One round is enough on paper.',
          effects: ['dialysate', 'pre', 'post'],
        };
      }
      case 'ff': {
        const a = t.ffAdjustment;
        const s0 = t.initialSplit;
        return {
          title: `Step ${cit ? 7 : 6}: filtration fraction`,
          explain: `Everything crossing the membrane (replacement, net UF${cit ? ', citrate' : ''}) over plasma flow plus pre-filter fluid. Keep it ≤ ${fmt(ceil * 100)}%.`,
          formula: 'FF = (pre + post + net UF + pre-filter citrate) ÷ (plasma flow + pre + pre-filter citrate)',
          inputs: t.floorExceeded ? [] : [{ id: 'ff', label: 'Filtration fraction', unit: '%', answer: t.initialCheck.filtrationFraction * 100, tol: 0.7, digits: 1 }],
          working: `FF = (${s0.replacementPre_mL_hr} + ${s0.replacementPost_mL_hr} + ${rx.netUF} + ${fmt(t.citrateFlow_mL_hr)}) ÷ (${fmt(t.plasmaFlow_mL_hr)} + ${s0.replacementPre_mL_hr} + ${fmt(t.citrateFlow_mL_hr)})
 = ${fmt(t.initialCheck.filtrationFraction * 100, 1)}%${a ? `

Above the ${fmt(ceil * 100)}% ceiling. Fix: move ${a.move_mL_hr} mL/hr from ${a.from} to ${a.to}.
New flows: ${rx.modality !== 'CVVH' ? `dialysate ${t.dialysateFlow_mL_hr}, ` : ''}pre ${t.replacementPre_mL_hr}, post ${t.replacementPost_mL_hr} mL/hr → FF ${fmt(a.ffAfter * 100, 1)}%.
${a.doseEffect === 'none' ? 'Same effluent, same dose.' : 'Lower FF, but more pre-dilution, so dose drops a little.'}${a.stillAbove ? '\nStill above the ceiling with all replacement pre-filter. Use CVVHDF or raise Qb.' : ''}` : `

Under ${fmt(ceil * 100)}%. No change.`}`,
          note: 'Up with post-filter replacement, net UF, citrate volume and Hct. Down with higher Qb, or by moving fluid to dialysate or pre-filter.',
          effects: ['post'],
        };
      }
      case 'check': {
        const chk = t.check;
        const gen = C.suggestPrescription(Object.assign({
          weightKg: W, hematocrit: p.hematocrit, modality: rx.modality, bloodFlow_mL_min: rx.bloodFlow,
          targetDeliveredDose_mL_kg_hr: rx.target, uptimeFraction: u, netUltrafiltration_mL_hr: rx.netUF,
          citrateFlow_mL_hr: t.citrateFlow_mL_hr, citratePreFilter: cit, preFilterShare: t.preShare,
        }, ffLimits()));
        const diff = chk.correctedDeliveredDose_mL_kg_hr - rx.target;
        return {
          title: `Step ${cit ? 8 : 7}: check the delivered dose`,
          explain: 'Run the final flows back through to confirm the delivered dose.',
          formula: 'delivered = (effluent ÷ weight) × dilution factor × uptime',
          inputs: [],
          working: `effluent = ${rx.modality !== 'CVVH' ? `${t.dialysateFlow_mL_hr} + ` : ''}${rx.modality !== 'CVVHD' ? `${t.replacementPre_mL_hr} + ${t.replacementPost_mL_hr} + ` : ''}${rx.netUF}${cit ? ` + ${fmt(t.citrateFlow_mL_hr)}` : ''} = ${fmt(chk.effluentRate_mL_hr)} mL/hr
dilution factor with final flows = ${fmt(chk.dilutionFactor, 3)}
delivered = (${fmt(chk.effluentRate_mL_hr)} ÷ ${fmt(W, 1)}) × ${fmt(chk.dilutionFactor, 3)} × ${fmt(u, 2)} = ${fmt(chk.correctedDeliveredDose_mL_kg_hr, 1)} mL/kg/hr
FF = ${fmt(chk.filtrationFraction * 100, 1)}%`,
          note: `${Math.abs(diff) <= 1 ? `Within 1 mL/kg/hr of your ${fmt(rx.target, 1)} target.` : diff > 0 ? `${fmt(diff, 1)} mL/kg/hr above target${t.floorExceeded ? ': the citrate volume alone exceeds the target. Lower Qb or use a concentrated citrate.' : '.'}` : `${fmt(-diff, 1)} mL/kg/hr below target${t.ffAdjustment && t.ffAdjustment.doseEffect === 'falls' ? ', because replacement moved pre-filter to protect FF. Adding dialysate (CVVHDF) would recover it.' : '.'}`}
Prescribe tab generator: ${rx.modality !== 'CVVH' ? `dialysate ${gen.dialysateFlow_mL_hr}, ` : ''}${rx.modality !== 'CVVHD' ? `pre ${gen.replacementPre_mL_hr}, post ${gen.replacementPost_mL_hr}` : ''} mL/hr, delivering ${fmt(gen.predictedDeliveredDose_mL_kg_hr, 1)} mL/kg/hr at FF ${fmt(gen.predictedFiltrationFraction * 100, 1)}%.`,
        };
      }
    }
    return null;
  }

  function renderCalc(c) {
    const spec = calcSpec(c);
    const ss = run.stepState['calc-' + c] || {};
    const results = ss.results || {};
    return `
      <div class="card">
        <span class="eyebrow">Calculation</span>
        <h2>${esc(spec.title)}</h2>
        <p>${esc(spec.explain)}</p>
        ${spec.formula ? `<div class="formula-box">${esc(spec.formula)}</div>` : ''}
        ${spec.inputs.length ? `
        <div class="input-row aligned-row mt-4">
          ${spec.inputs.map(inp => `
            <div class="field">
              <label for="rx-${inp.id}">${esc(inp.label)} <span class="unit">${esc(inp.unit)}</span></label>
              <input type="number" id="rx-${inp.id}" step="any" value="${ss.values && ss.values[inp.id] !== undefined ? esc(ss.values[inp.id]) : ''}">
              ${results[inp.id] ? `<div class="small ${results[inp.id].ok ? 'rx-ok' : 'rx-bad'}">${results[inp.id].ok ? '✓ Correct' : `✗ Expected about ${fmt(inp.answer, inp.digits || 0)}`}</div>` : ''}
            </div>`).join('')}
        </div>
        <div class="mt-4">
          <button type="button" class="secondary" id="rxCheck">Check my answer</button>
          <button type="button" class="secondary" id="rxReveal">Show working</button>
        </div>` : ''}
        ${ss.revealed || !spec.inputs.length ? `<div class="formula-box worked">${esc(spec.working)}</div>` : ''}
        ${spec.note && (ss.revealed || !spec.inputs.length) ? `<p class="small">${esc(spec.note)}</p>` : ''}
        ${(ss.revealed || !spec.inputs.length) && spec.effects ? spec.effects.map(renderEffects).join('') : ''}
        ${nav('Next')}
      </div>`;
  }

  // ---- effect explorer -----------------------------------------------------------
  function baselineFlows() {
    const t = teach();
    return {
      bloodFlow: run.rx.bloodFlow,
      dialysate: run.rx.modality === 'CVVH' ? 0 : t.dialysateFlow_mL_hr,
      pre: run.rx.modality === 'CVVHD' ? 0 : t.replacementPre_mL_hr,
      post: run.rx.modality === 'CVVHD' ? 0 : t.replacementPost_mL_hr,
      netUF: run.rx.netUF,
      citrateDose: run.rx.citrateDose,
    };
  }

  function evaluateFlows(f) {
    const cit = run.rx.anticoag === 'citrate';
    const citrateFlow = cit ? (f.citrateDose * f.bloodFlow * 60) / run.rx.citrateConc : 0;
    const d = C.computeDoseAndFF(Object.assign({
      weightKg: dosingWeight(), hematocrit: run.src.patient.hematocrit, bloodFlow_mL_min: f.bloodFlow,
      dialysateFlow_mL_hr: f.dialysate, replacementPre_mL_hr: f.pre, replacementPost_mL_hr: f.post,
      netUltrafiltration_mL_hr: f.netUF, citrateFlow_mL_hr: citrateFlow, citratePreFilter: true,
      uptimeFraction: run.rx.uptime,
    }, ffLimits()));
    const ca = C.estimateCalciumLoss({ effluentRate_mL_hr: d.effluentRate_mL_hr, effluentTotalCa_mmol_L: 1.5 });
    return { d, citrateFlow, caLoss: ca.caLoss_mmol_hr };
  }

  const EXPLORE_VARS = [
    { key: 'bloodFlow', label: 'Blood flow', unit: 'mL/min', step: 10, effect: 'bloodFlow' },
    { key: 'dialysate', label: 'Dialysate', unit: 'mL/hr', step: 100, effect: 'dialysate', hideFor: ['CVVH'] },
    { key: 'pre', label: 'Pre-filter replacement', unit: 'mL/hr', step: 100, effect: 'pre', hideFor: ['CVVHD'] },
    { key: 'post', label: 'Post-filter replacement', unit: 'mL/hr', step: 100, effect: 'post', hideFor: ['CVVHD'] },
    { key: 'netUF', label: 'Net UF', unit: 'mL/hr', step: 50, effect: 'netUF' },
    { key: 'citrateDose', label: 'Citrate dose', unit: 'mmol/L', step: 0.5, effect: 'citrateDose', citrateOnly: true },
  ];

  function renderExplore() {
    if (!run.explore) run.explore = { base: baselineFlows(), now: baselineFlows(), last: null };
    const { base, now, last } = run.explore;
    const b = evaluateFlows(base), n = evaluateFlows(now);
    const cit = run.rx.anticoag === 'citrate';
    const vars = EXPLORE_VARS.filter(v => !(v.hideFor || []).includes(run.rx.modality) && (!v.citrateOnly || cit));
    const row = (label, bv, nv, unit, digits = 0) => {
      const delta = nv - bv;
      const arrow = Math.abs(delta) < 1e-9 ? '' : delta > 0 ? '↑' : '↓';
      return `<div class="output-row"><span class="label">${label}</span><span class="value">${fmt(bv, digits)} → <strong>${fmt(nv, digits)}</strong> ${unit} ${arrow}</span></div>`;
    };
    const ceil = ffLimits().ffCeiling;
    return `
      <div class="card">
        <span class="eyebrow">Explore</span>
        <h2>Change one thing at a time</h2>
        <p>Change one variable and see what moves.</p>
        ${vars.map(v => `
          <div class="explore-row">
            <span class="explore-label">${v.label}</span>
            <button type="button" class="secondary explore-btn" data-var="${v.key}" data-dir="-1" aria-label="Decrease ${v.label}">−</button>
            <span class="explore-val">${fmt(now[v.key], v.key === 'citrateDose' ? 1 : 0)} ${v.unit}</span>
            <button type="button" class="secondary explore-btn" data-var="${v.key}" data-dir="1" aria-label="Increase ${v.label}">+</button>
          </div>`).join('')}
        <div class="output-block mt-4">
          ${row('Effluent', b.d.effluentRate_mL_hr, n.d.effluentRate_mL_hr, 'mL/hr')}
          ${row('Delivered dose', b.d.correctedDeliveredDose_mL_kg_hr, n.d.correctedDeliveredDose_mL_kg_hr, 'mL/kg/hr', 1)}
          ${row('Filtration fraction', b.d.filtrationFraction * 100, n.d.filtrationFraction * 100, '%', 1)}
          ${cit ? row('Citrate flow', b.citrateFlow, n.citrateFlow, 'mL/hr') : ''}
          ${cit ? row('Calcium lost in effluent (illustrative)', b.caLoss, n.caLoss, 'mmol/hr', 2) : ''}
        </div>
        ${n.d.filtrationFraction > ceil ? `<div class="warning-inline">FF is above the ${fmt(ceil * 100)}% ceiling.</div>` : ''}
        ${last ? renderEffects(EXPLORE_VARS.find(v => v.key === last).effect) : '<p class="small muted">Press + or −.</p>'}
        <div class="mt-4"><button type="button" class="secondary" id="exploreReset">Reset to my prescription</button></div>
        ${nav('See the order')}
      </div>`;
  }

  // ---- summary -------------------------------------------------------------------
  function finalLines() {
    const t = teach();
    const rx = run.rx;
    const W = dosingWeight();
    const lines = [];
    lines.push(`Dosing weight: ${fmt(W, 1)} kg (${rx.weightBasis || 'actual'})`);
    if (!run.order.modality) lines.push(`Modality: ${rx.modality}`);
    if (rx.anticoag === 'citrate') lines.push(`Citrate ${rx.citrateConc} mmol/L at ${fmt(t.citrateFlow_mL_hr)} mL/hr (${fmt(rx.citrateDose, 1)} mmol/L blood); calcium per local nomogram`);
    else if (rx.anticoag === 'heparin') lines.push('Heparin per local nomogram');
    else lines.push('No anticoagulation');
    lines.push(`Qb ${rx.bloodFlow} mL/min`);
    if (rx.modality !== 'CVVH') lines.push(`Dialysate ${t.dialysateFlow_mL_hr} mL/hr`);
    if (rx.modality !== 'CVVHD') lines.push(`Replacement pre-filter ${t.replacementPre_mL_hr} mL/hr, post-filter ${t.replacementPost_mL_hr} mL/hr`);
    lines.push(`Net UF ${rx.netUF} mL/hr`);
    lines.push(`Effluent ${fmt(t.check.effluentRate_mL_hr)} mL/hr; expected delivered ${fmt(t.check.correctedDeliveredDose_mL_kg_hr, 1)} mL/kg/hr at ${fmt((1 - rx.uptime) * 100)}% downtime; FF ${fmt(t.check.filtrationFraction * 100, 1)}%`);
    return lines;
  }

  function renderSummary() {
    if (run.kind === 'case') {
      const progress = Store.get('rxCaseProgress', {});
      progress[run.src.id] = true;
      Store.set('rxCaseProgress', progress);
    }
    const monitoring = run.kind === 'builder' ? DATA.builder.monitoring : null;
    return `
      <div class="card">
        <h2>Your prescription</h2>
        <div class="order-sheet">
          ${Object.values(run.order).map(l => `<div class="item"><span class="v">${esc(l)}</span></div>`).join('')}
          ${finalLines().map(l => `<div class="item"><span class="v">${esc(l)}</span></div>`).join('')}
        </div>
        ${monitoring ? `<h3 class="mt-4">Monitoring</h3><ul>${monitoring.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
        ${run.src.debrief ? `<h3 class="mt-4">Debrief</h3><p>${esc(run.src.debrief)}</p>` : ''}
        ${run.rx.anticoag === 'none' ? '<p class="small muted">In the Prescribe tab, no anticoagulation appears as "Heparinized circuit only". Use a heparin-free prime if your protocol requires it.</p>' : ''}
        <div class="mt-4 rx-nav">
          <button type="button" class="secondary" data-nav="back">Back</button>
          <button type="button" class="secondary" id="rxPrint">Print</button>
          <button type="button" class="primary" id="rxOpen">Open in Prescribe tab</button>
          <button type="button" class="secondary" id="rxRestart">${run.kind === 'builder' ? 'Start over' : 'Back to prescribing cases'}</button>
        </div>
      </div>`;
  }

  // ---- events --------------------------------------------------------------------
  function checkAnswer(inp, raw) {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return { ok: false };
    const err = Math.abs(v - inp.answer);
    return { ok: inp.rel ? err <= Math.abs(inp.answer) * inp.tol + 0.5 : err <= inp.tol + 1e-9 };
  }

  function wire(root, step) {
    root.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.nav === 'next') run.index = Math.min(run.index + 1, steps().length - 1);
      else run.index = Math.max(0, run.index - 1);
      render(root);
    }));

    if (step.type === 'choice') {
      const d = step.d;
      const opts = d.options.filter(o => matches(o.when));
      root.querySelectorAll('[data-opt]').forEach(b => b.addEventListener('click', () => {
        const i = parseInt(b.dataset.opt, 10);
        const ss = run.stepState[d.key] || (run.stepState[d.key] = { tried: [] });
        ss.picked = i;
        if (!ss.tried.includes(i)) ss.tried.push(i);
        const o = opts[i];
        if (o.verdict !== 'avoid') {
          if (o.set) Object.assign(run.rx, o.set);
          // Later calculations depend on this choice: clear stale answers.
          Object.keys(run.stepState).filter(k => k.startsWith('calc-')).forEach(k => delete run.stepState[k]);
          if (o.order) run.order[d.key] = o.order; else delete run.order[d.key];
          run.explore = null;
        }
        render(root);
      }));
    }

    if (step.type === 'calc') {
      const spec = calcSpec(step.c);
      const key = 'calc-' + step.c;
      const ss = () => run.stepState[key] || (run.stepState[key] = {});
      const readValues = () => {
        const values = {};
        spec.inputs.forEach(inp => { const n = document.getElementById('rx-' + inp.id); if (n) values[inp.id] = n.value; });
        return values;
      };
      const chk = document.getElementById('rxCheck');
      if (chk) chk.addEventListener('click', () => {
        const s = ss();
        s.values = readValues();
        s.results = {};
        spec.inputs.forEach(inp => { s.results[inp.id] = checkAnswer(inp, s.values[inp.id]); });
        s.revealed = true;
        render(root);
      });
      const rev = document.getElementById('rxReveal');
      if (rev) rev.addEventListener('click', () => { const s = ss(); s.values = readValues(); s.revealed = true; render(root); });
    }

    if (step.type === 'explore') {
      root.querySelectorAll('.explore-btn').forEach(b => b.addEventListener('click', () => {
        const v = EXPLORE_VARS.find(x => x.key === b.dataset.var);
        const now = run.explore.now;
        const next = now[v.key] + v.step * parseInt(b.dataset.dir, 10);
        const min = v.key === 'bloodFlow' ? 50 : v.key === 'citrateDose' ? 1 : 0;
        const max = v.key === 'bloodFlow' ? 400 : v.key === 'citrateDose' ? 6 : 10000;
        now[v.key] = Math.min(max, Math.max(min, Math.round(next * 10) / 10));
        run.explore.last = v.key;
        render(root);
      }));
      const reset = document.getElementById('exploreReset');
      if (reset) reset.addEventListener('click', () => { run.explore = null; render(root); });
    }

    if (step.type === 'summary') {
      document.getElementById('rxPrint').addEventListener('click', () => window.print());
      document.getElementById('rxRestart').addEventListener('click', () => {
        if (run.kind === 'builder') { startRun('builder', DATA.builder); render(root); }
        else location.hash = '#/learn/prescribing';
      });
      document.getElementById('rxOpen').addEventListener('click', () => {
        const t = teach();
        const p = run.src.patient;
        const rx = run.rx;
        if (window.CRRTUICalculator && window.CRRTUICalculator.loadScenario) {
          window.CRRTUICalculator.loadScenario({
            actualWeightKg: p.weightKg, heightCm: p.heightCm, sex: p.sex, weightBasis: rx.weightBasis || 'actual',
            hematocrit: p.hematocrit, modality: rx.modality, anticoag: rx.anticoag, citrateConc: rx.citrateConc,
            citrateDose: rx.citrateDose, bloodFlow: rx.bloodFlow, netUF: rx.netUF, uptime: rx.uptime, target: rx.target,
            dialysate: t.dialysateFlow_mL_hr, pre: t.replacementPre_mL_hr, post: t.replacementPost_mL_hr,
          });
        }
        location.hash = '#/prescribe';
      });
    }
  }

  return { mountBuilder, mountCasesList, mountCase };
})();
