window.CRRTUITeaching = (function () {
  'use strict';

  const Store = window.CRRTStore;
  let cases = null, quiz = null, troubleshooting = null, theory = null;

  async function ensureData() {
    if (!cases) cases = await Store.loadData('cases');
    if (!quiz) quiz = await Store.loadData('quiz');
    if (!troubleshooting) troubleshooting = await Store.loadData('troubleshooting');
    if (!theory) theory = await Store.loadData('theory');
  }

  // =========================================================================
  // Hub
  // =========================================================================
  async function mountHub(root) {
    await ensureData();
    const caseProgress = Store.get('caseProgress', {});
    const quizStats = Store.get('quizStats', { attempted: 0, correct: 0 });

    root.innerHTML = `
      <h1>Learn</h1>
      <p class="muted small">Guided order-building, branching cases, a troubleshooting simulator, and a quiz bank.</p>
      <div class="grid-cols">
        <a href="#/learn/builder" class="card" style="text-decoration:none;color:inherit;display:block;">
          <h3>Guided prescription builder</h3>
          <p class="small muted">Nine steps from indication to monitoring, with a printable order sheet at the end.</p>
        </a>
        <a href="#/learn/cases" class="card" style="text-decoration:none;color:inherit;display:block;">
          <h3>Cases</h3>
          <p class="small muted">${Object.keys(caseProgress).length} / ${cases.length} completed</p>
        </a>
        <a href="#/learn/troubleshoot" class="card" style="text-decoration:none;color:inherit;display:block;">
          <h3>Troubleshooting simulator</h3>
          <p class="small muted">Interactive circuit: localise the alarm before you see the answer.</p>
        </a>
        <a href="#/learn/quiz" class="card" style="text-decoration:none;color:inherit;display:block;">
          <h3>Quiz</h3>
          <p class="small muted">${quizStats.attempted > 0 ? `${quizStats.correct}/${quizStats.attempted} correct so far` : `${quiz.length} questions`}</p>
        </a>
      </div>
    `;
  }

  // =========================================================================
  // Guided builder
  // =========================================================================
  const BUILDER_STEPS = [
    {
      key: 'indication', title: 'Is CRRT indicated, and is it indicated now?',
      theoryLink: 'timing',
      options: [
        { label: 'Refractory hyperkalaemia, severe acidosis, diuretic-refractory volume overload, uraemic complications, or select intoxications', order: 'Indication: trigger-based (see selected trigger)', why: 'STARRT-AKI and related trials found no benefit, and even a signal of harm, from initiating by AKI stage alone. Watchful waiting with explicit trigger criteria is the current default.' },
        { label: 'Rising creatinine / AKI stage alone, no trigger yet', order: 'Indication: AKI stage alone (reconsider)', why: 'This is the pattern the timing trials argue against. Consider watchful waiting with defined trigger criteria instead of acting on stage alone.' },
      ],
    },
    {
      key: 'crrtVsIhd', title: 'CRRT vs intermittent HD vs PIRRT?',
      theoryLink: 'modality',
      options: [
        { label: 'CRRT: haemodynamically unstable or raised ICP/cerebral oedema', order: 'Modality class: CRRT', why: 'CRRT\'s slow, continuous solute and fluid removal is gentler on haemodynamics and cerebral perfusion than intermittent HD.' },
        { label: 'Intermittent HD: stable, resource-limited setting', order: 'Modality class: Intermittent HD', why: 'A stable patient without ICP concerns can tolerate the faster shifts of intermittent HD, which is often more resource-efficient.' },
      ],
    },
    {
      key: 'access', title: 'Access site and catheter',
      theoryLink: 'circuit',
      options: [
        { label: 'Right internal jugular', order: 'Access: Right IJ; catheter length selected for confirmed tip position', why: 'Usually the shortest, straightest route. Choose length from patient anatomy and the catheter product, then confirm tip position.' },
        { label: 'Femoral', order: 'Access: Femoral; length selected to place the tip in the IVC', why: 'Acceptable when practical. A catheter that is too short increases recirculation, and hip flexion may impair flow.' },
        { label: 'Left internal jugular', order: 'Access: Left IJ; length selected for confirmed tip position', why: 'Usable, but the longer curved course can impair flow. Avoid a fixed length rule.' },
      ],
    },
    {
      key: 'modality', title: 'Modality',
      theoryLink: 'modality',
      options: [
        { label: 'CVVHDF: diffusion + convection', order: 'Modality: CVVHDF', why: 'No mortality difference vs CVVH/CVVHD; most units default here as a practical middle ground.' },
        { label: 'CVVH: convection only', order: 'Modality: CVVH', why: 'Better theoretical middle-molecule clearance at high post-dilution rates, at the cost of filter life.' },
        { label: 'CVVHD: diffusion only', order: 'Modality: CVVHD', why: 'Gentler on the filter for a given dose than high-rate CVVH.' },
        { label: 'SCUF: fluid removal only', order: 'Modality: SCUF', why: 'Appropriate only when the sole goal is fluid removal in a metabolically stable patient, with no meaningful solute clearance.' },
      ],
    },
    {
      key: 'dose', title: 'Dose',
      theoryLink: 'dose',
      options: [
        { label: 'Calculate a prescription that will deliver 20–25 mL/kg/hr', order: 'Dose: target delivered 20–25 mL/kg/hr; calculate prescribed rate from expected uptime and pre-dilution', why: 'A fixed 25–30 rule can underdose or overdose. The calculator solves from the delivered target, expected downtime, and pre-filter dilution.' },
        { label: 'Prescribe exactly 20–25 mL/kg/hr', order: 'Dose: prescribe 20–25 mL/kg/hr', why: 'Without a downtime margin, delivered dose will likely fall below target once circuit changes and interruptions are accounted for.' },
      ],
    },
    {
      key: 'anticoag', title: 'Anticoagulation',
      theoryLink: 'anticoagulation',
      options: [
        { label: 'Regional citrate when the protocol and monitoring are suitable', order: 'Anticoagulation: Regional citrate', why: 'KDIGO-preferred default because it improves filter life and reduces bleeding. Severe liver failure or shock raises accumulation risk and requires protocol-specific assessment and close monitoring.' },
        { label: 'Systemic heparin', order: 'Anticoagulation: Systemic heparin', why: 'Reasonable where citrate is unavailable or contraindicated.' },
        { label: 'None: active bleeding or high bleeding risk', order: 'Anticoagulation: None (optimise flow/dilution instead)', why: 'The correct default with active bleeding: accept shorter filter life as the trade-off.' },
      ],
    },
    {
      key: 'fluid', title: 'Fluid removal',
      theoryLink: 'fluid',
      options: [
        { label: 'Set net UF to what current haemodynamics tolerate, reassess frequently', order: 'Fluid removal: net UF titrated to haemodynamic tolerance', why: 'High UF rates risk outpacing plasma refill. Titrate to tolerance in real time rather than fixing a rate to a 24-hour target.' },
      ],
    },
    {
      key: 'solutions', title: 'Solutions and electrolytes',
      theoryLink: 'complications',
      options: [
        { label: 'Anticipate hypophosphataemia; plan potassium bath and monitoring up front', order: 'Solutions: phosphate-aware plan, K+ bath selected, monitoring scheduled', why: 'Hypophosphataemia is common during CRRT, especially with phosphate-free solutions and longer treatment. Plan monitoring and replacement rather than waiting for a severe value.' },
      ],
    },
    {
      key: 'monitoring', title: 'Monitoring',
      theoryLink: 'order-anatomy',
      options: [
        { label: 'Set a lab schedule and pressure limits, and specify which parameters are nurse-titrated', order: 'Monitoring: lab schedule + pressure limits + titration parameters specified', why: 'A complete order includes titration boundaries for bedside-titrated parameters (commonly calcium rate, heparin rate), not just a starting point.' },
      ],
    },
  ];

  let builderState = { stepIndex: 0, order: {} };

  async function mountBuilder(root) {
    await ensureData();
    builderState = { stepIndex: 0, order: {} };
    renderBuilder(root);
  }

  function renderBuilder(root) {
    const step = BUILDER_STEPS[builderState.stepIndex];
    const done = builderState.stepIndex >= BUILDER_STEPS.length;

    if (done) {
      root.innerHTML = `
        <h1>Guided prescription builder</h1>
        <div class="card">
          <h2>Assembled order</h2>
          <div class="order-sheet">
            ${BUILDER_STEPS.map(s => `<div class="item"><span class="k">${s.title}</span><span class="v">${builderState.order[s.key] || '–'}</span></div>`).join('')}
          </div>
          <div class="mt-4">
            <button class="secondary" onclick="window.print()">Print order sheet</button>
            <a href="#/learn/builder"><button class="primary" style="margin-left:0.5rem;">Start over</button></a>
          </div>
        </div>
      `;
      return;
    }

    root.innerHTML = `
      <h1>Guided prescription builder</h1>
      <div class="step-progress">
        ${BUILDER_STEPS.map((s, i) => `<div class="dot ${i < builderState.stepIndex ? 'done' : i === builderState.stepIndex ? 'current' : ''}"></div>`).join('')}
      </div>
      <div class="grid-2">
        <div class="card">
          <h2>Step ${builderState.stepIndex + 1} of ${BUILDER_STEPS.length}: ${step.title}</h2>
          <div id="builderOptions">
            ${step.options.map((o, i) => `<button type="button" class="case-option" data-idx="${i}">${o.label}</button>`).join('')}
          </div>
          <div id="builderFeedback"></div>
        </div>
        <div class="card order-sheet">
          <h3>Order sheet so far</h3>
          ${Object.keys(builderState.order).length === 0 ? '<p class="small muted">Nothing assembled yet.</p>' :
            BUILDER_STEPS.filter(s => builderState.order[s.key]).map(s => `<div class="item"><span class="k">${s.title}</span><span class="v">${builderState.order[s.key]}</span></div>`).join('')}
        </div>
      </div>
    `;

    root.querySelectorAll('#builderOptions .case-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const opt = step.options[parseInt(btn.dataset.idx, 10)];
        builderState.order[step.key] = opt.order;
        document.getElementById('builderFeedback').innerHTML = `
          <div class="feedback-box">
            <p>${opt.why}</p>
            <a href="#/theory/${step.theoryLink}" class="small">Read more in Theory →</a>
            <div class="mt-4"><button class="primary" id="builderNext">Next</button></div>
          </div>`;
        document.getElementById('builderNext').addEventListener('click', () => {
          builderState.stepIndex++;
          renderBuilder(root);
        });
      });
    });
  }

  // =========================================================================
  // Cases
  // =========================================================================
  async function mountCasesList(root) {
    await ensureData();
    const progress = Store.get('caseProgress', {});
    root.innerHTML = `
      <h1>Cases</h1>
      <div class="grid-cols">
        ${cases.map(c => `
          <a href="#/learn/case/${c.id}" class="card accent-card mod-${c.tag}" style="text-decoration:none;color:inherit;display:block;">
            <span class="tag">${c.tag === 'none' ? 'no anticoag' : c.tag}</span>
            <h3>${c.title}</h3>
            <p class="small muted">${progress[c.id] ? 'Completed' : 'Not started'}</p>
          </a>`).join('')}
      </div>
    `;
  }

  let caseRunState = null;

  async function mountCase(root, caseId) {
    await ensureData();
    const c = cases.find(x => x.id === caseId);
    if (!c) { root.innerHTML = `<p>Case not found. <a href="#/learn/cases">Back to cases</a></p>`; return; }
    caseRunState = { case: c, stepIndex: 0, answered: false };
    renderCase(root);
  }

  function renderCase(root) {
    const { case: c, stepIndex } = caseRunState;
    const done = stepIndex >= c.steps.length;

    if (done) {
      const progress = Store.get('caseProgress', {});
      progress[c.id] = true;
      Store.set('caseProgress', progress);

      root.innerHTML = `
        <h1>${c.title}</h1>
        <div class="card accent-card mod-${c.tag}">
          <h2>Debrief</h2>
          <p>${c.debrief}</p>
          <a href="#/learn/cases"><button class="primary">Back to cases</button></a>
        </div>
      `;
      return;
    }

    const step = c.steps[stepIndex];
    root.innerHTML = `
      <h1>${c.title}</h1>
      <div class="card accent-card mod-${c.tag}">
        <p><strong>Stem:</strong> ${c.stem}</p>
      </div>
      <div class="step-progress">
        ${c.steps.map((s, i) => `<div class="dot ${i < stepIndex ? 'done' : i === stepIndex ? 'current' : ''}"></div>`).join('')}
      </div>
      <div class="card">
        <h3>${step.prompt}</h3>
        <div id="caseOptions">
          ${step.options.map((o, i) => `<button type="button" class="case-option" data-idx="${i}">${o.text}</button>`).join('')}
        </div>
        <div id="caseFeedback"></div>
      </div>
    `;

    root.querySelectorAll('#caseOptions .case-option').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        const opt = step.options[i];
        root.querySelectorAll('#caseOptions .case-option').forEach((b, j) => {
          const cls = step.options[j].correct ? 'chosen-correct' : (j === i ? 'chosen-incorrect' : null);
          if (cls) b.classList.add(cls);
          b.disabled = true;
        });
        document.getElementById('caseFeedback').innerHTML = `
          <div class="feedback-box">
            <p>${opt.feedback}</p>
            <button class="primary mt-4" id="caseNext">${stepIndex + 1 < c.steps.length ? 'Next' : 'See debrief'}</button>
          </div>`;
        document.getElementById('caseNext').addEventListener('click', () => {
          caseRunState.stepIndex++;
          renderCase(root);
        });
      });
    });
  }

  // =========================================================================
  // Troubleshooting simulator
  // =========================================================================
  async function mountTroubleshoot(root) {
    await ensureData();
    renderTroubleshootList(root);
  }

  function renderTroubleshootList(root) {
    root.innerHTML = `
      <h1>Troubleshooting simulator</h1>
      <p class="muted small">Pick an alarm pattern. Try to localise the problem before revealing the answer.</p>
      <div class="grid-cols">
        ${troubleshooting.map(t => `<button type="button" class="card" style="text-align:left;cursor:pointer;" data-id="${t.id}">
          <h3 style="margin-bottom:0.25rem;">${t.alarm}</h3>
        </button>`).join('')}
      </div>
    `;
    root.querySelectorAll('[data-id]').forEach(btn => {
      btn.addEventListener('click', () => renderTroubleshootDetail(root, btn.dataset.id));
    });
  }

  function renderTroubleshootDetail(root, id) {
    const t = troubleshooting.find(x => x.id === id);
    const zoneMap = {
      'high-access-negative': 'access', 'high-return': 'return', 'rising-tmp': 'filter',
      'filter-pressure-drop': 'filter', 'air-detected': 'air', 'blood-leak': 'filter',
    };
    const svg = window.CRRTSchematic.render({
      qb_mL_min: 150, prefilterActive: false, postfilterActive: true, ff: 0.15,
      accentVar: '--citrate', alarm: { zone: zoneMap[id] || null },
    });

    root.innerHTML = `
      <h1>${t.alarm}</h1>
      <div class="grid-2">
        <div class="card">
          ${t.pressurePattern ? `
          <h3>Pressure pattern</h3>
          <div class="output-block">
            ${Object.entries(t.pressurePattern).map(([k, v]) => `<div class="output-row"><span class="label">${k}</span><span class="value">${v}</span></div>`).join('')}
          </div>` : ''}
          <details class="working" open>
            <summary>Reveal: what this localises, differential, and first actions</summary>
            <p><strong>${t.localises}</strong></p>
            <p><strong>Differential:</strong></p>
            <ul>${t.differential.map(d => `<li>${d}</li>`).join('')}</ul>
            <p><strong>First actions:</strong></p>
            <ul>${t.firstActions.map(a => `<li>${a}</li>`).join('')}</ul>
          </details>
        </div>
        <div class="card schematic-wrap">
          ${svg}
        </div>
      </div>
      <a href="#/learn/troubleshoot"><button class="secondary mt-4">Back to list</button></a>
    `;
  }

  // =========================================================================
  // Quiz
  // =========================================================================
  let quizState = null;

  async function mountQuiz(root) {
    await ensureData();
    quizState = { order: shuffle(quiz.map((_, i) => i)), index: 0, score: 0 };
    renderQuiz(root);
  }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function renderQuiz(root) {
    if (quizState.index >= quizState.order.length) {
      const stats = Store.get('quizStats', { attempted: 0, correct: 0 });
      stats.attempted += quizState.order.length;
      stats.correct += quizState.score;
      Store.set('quizStats', stats);

      root.innerHTML = `
        <h1>Quiz complete</h1>
        <div class="card">
          <h2>${quizState.score} / ${quizState.order.length}</h2>
          <a href="#/learn/quiz"><button class="primary">Take again</button></a>
        </div>
      `;
      return;
    }

    const q = quiz[quizState.order[quizState.index]];
    root.innerHTML = `
      <h1>Quiz</h1>
      <div class="quiz-meta"><span class="tag">${q.topic}</span><span>${q.difficulty}</span><span>Question ${quizState.index + 1} of ${quizState.order.length}</span></div>
      <div class="card">
        <h3>${q.question}</h3>
        <div id="quizOptions">
          ${q.options.map((o, i) => `<button type="button" class="case-option" data-idx="${i}">${o.text}</button>`).join('')}
        </div>
        <div id="quizFeedback"></div>
      </div>
    `;

    root.querySelectorAll('#quizOptions .case-option').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        const opt = q.options[i];
        if (opt.correct) quizState.score++;
        root.querySelectorAll('#quizOptions .case-option').forEach((b, j) => {
          const cls = q.options[j].correct ? 'chosen-correct' : (j === i ? 'chosen-incorrect' : null);
          if (cls) b.classList.add(cls);
          b.disabled = true;
        });
        document.getElementById('quizFeedback').innerHTML = `
          <div class="feedback-box">
            ${q.options.map(o => `<p><strong>${o.correct ? '✓' : '✗'}</strong> ${o.text}: ${o.explain}</p>`).join('')}
            <button class="primary mt-4" id="quizNext">${quizState.index + 1 < quizState.order.length ? 'Next' : 'See score'}</button>
          </div>`;
        document.getElementById('quizNext').addEventListener('click', () => {
          quizState.index++;
          renderQuiz(root);
        });
      });
    });
  }

  return { mountHub, mountBuilder, mountCasesList, mountCase, mountTroubleshoot, mountQuiz };
})();
