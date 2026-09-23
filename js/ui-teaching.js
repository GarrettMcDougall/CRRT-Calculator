/**
 * ui-teaching.js: Learn tab (guided builder, cases, troubleshooting
 * simulator, quiz). Buttons that restart a view re-render directly, because
 * a link to the hash already showing does not fire hashchange.
 */
window.CRRTUITeaching = (function () {
  'use strict';

  // Resolved at call time so the module does not depend on script order.
  const Store = new Proxy({}, { get: (_, k) => window.CRRTStore[k] });
  let cases = null, quiz = null, troubleshooting = null, theory = null, prescribing = null;

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
    if (!prescribing) prescribing = await Store.loadData('prescribing');
    const rxDone = Object.keys(Store.get('rxCaseProgress', {})).length;
    const rxTotal = (prescribing.cases || []).length;

    root.innerHTML = `
      <h1>Learn</h1>
      <p class="muted small">Learn to prescribe, then practise with cases, a troubleshooting simulator and a quiz bank.</p>
      <div class="grid-cols">
        <a href="#/learn/builder" class="card" style="text-decoration:none;color:inherit;display:block;">
          <h3>Guided prescription builder</h3>
          <p class="small muted">Learn to prescribe CRRT step by step: each decision with its reasoning, then the dose, effluent, citrate, pre-dilution, replacement split and filtration fraction calculated by hand.</p>
        </a>
        <a href="#/learn/prescribing" class="card" style="text-decoration:none;color:inherit;display:block;">
          <h3>Prescribing cases</h3>
          <p class="small muted">${rxDone} / ${rxTotal} completed. Clinical vignettes that walk you through writing the prescription.</p>
        </a>
        <a href="#/learn/cases" class="card" style="text-decoration:none;color:inherit;display:block;">
          <h3>Advanced and troubleshooting cases</h3>
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
  // Cases
  // =========================================================================
  async function mountCasesList(root) {
    await ensureData();
    const progress = Store.get('caseProgress', {});
    root.innerHTML = `
      <h1>Advanced and troubleshooting cases</h1>
      <p class="small"><a href="#/learn/prescribing">New to prescribing? Start with the prescribing cases →</a></p>
      <div class="grid-cols">
        ${cases.map(c => `
          <a href="#/learn/case/${c.id}" class="card accent-card mod-${c.tag}" style="text-decoration:none;color:inherit;display:block;">
            <span class="tag">${c.tag === 'none' ? 'no anticoagulation' : c.tag}</span>
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
      'filter-pressure-drop': 'filter', 'air-detected': 'air', 'blood-leak': 'effluent',
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
          <details class="working">
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
      <button type="button" class="secondary mt-4" id="troubleshootBack">Back to list</button>
    `;
    document.getElementById('troubleshootBack').addEventListener('click', () => renderTroubleshootList(root));
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
          <button type="button" class="primary" id="quizRestart">Take again</button>
        </div>
      `;
      document.getElementById('quizRestart').addEventListener('click', () => mountQuiz(root));
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

  return { mountHub, mountCasesList, mountCase, mountTroubleshoot, mountQuiz };
})();
