(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- theme ---------- */
  const root = document.documentElement;
  try { const t = localStorage.getItem('aeo-theme'); if (t) root.dataset.theme = t; } catch {}
  $('#theme').addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('aeo-theme', root.dataset.theme); } catch {}
    bg.readColors();
  });

  /* ---------- responsive background: dot grid that reacts to pointer, scroll and size ---------- */
  const bg = (() => {
    const c = $('#bg'), ctx = c.getContext('2d');
    let w = 0, h = 0, dpr = 1, dot = '24,24,27', glow = '37,99,235';
    const target = { x: -999, y: -999 }, pos = { x: -999, y: -999 };
    let lastMove = 0, raf = 0;

    function readColors() {
      const cs = getComputedStyle(root);
      dot = cs.getPropertyValue('--dot').trim() || dot;
      glow = cs.getPropertyValue('--glow').trim() || glow;
      kick();
    }
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = innerWidth; h = innerHeight;
      c.width = w * dpr; c.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      kick();
    }
    function draw(now) {
      raf = 0;
      // when the pointer is idle (or on touch screens), let the light drift slowly
      if (!reduced && now - lastMove > 2500) {
        const k = now / 6000;
        target.x = w * (0.5 + 0.35 * Math.cos(k));
        target.y = h * (0.4 + 0.25 * Math.sin(k * 1.3));
      }
      pos.x += (target.x - pos.x) * 0.08;
      pos.y += (target.y - pos.y) * 0.08;

      ctx.clearRect(0, 0, w, h);
      const gap = w < 600 ? 22 : 28;
      const R = Math.max(140, Math.min(w, h) * 0.28);
      const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, R * 1.6);
      g.addColorStop(0, `rgba(${glow},0.10)`);
      g.addColorStop(1, `rgba(${glow},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      const off = (scrollY * 0.15) % gap;
      for (let y = -off; y < h + gap; y += gap) {
        for (let x = gap / 2; x < w; x += gap) {
          const dx = x - pos.x, dy = y - pos.y, d = Math.hypot(dx, dy);
          const near = Math.max(0, 1 - d / R);
          const push = near * near * 6;
          const px = x + (d ? (dx / d) * push : 0), py = y + (d ? (dy / d) * push : 0);
          ctx.fillStyle = near > 0 ? `rgba(${glow},${0.12 + near * 0.5})` : `rgba(${dot},0.09)`;
          ctx.beginPath();
          ctx.arc(px, py, 1 + near * 0.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      const settled = Math.abs(target.x - pos.x) < 0.3 && Math.abs(target.y - pos.y) < 0.3;
      if (!reduced && (!settled || now - lastMove > 2500)) kick();
    }
    function kick() { if (!raf) raf = requestAnimationFrame(draw); }
    function move(x, y) { target.x = x; target.y = y; lastMove = performance.now(); kick(); }

    addEventListener('pointermove', (e) => move(e.clientX, e.clientY), { passive: true });
    addEventListener('touchmove', (e) => { const t = e.touches[0]; if (t) move(t.clientX, t.clientY); }, { passive: true });
    addEventListener('scroll', kick, { passive: true });
    addEventListener('resize', resize);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
    resize(); readColors();
    pos.x = target.x = w * 0.7; pos.y = target.y = h * 0.3;
    return { readColors };
  })();

  /* ---------- agents ---------- */
  const agents = [
    { n: 'analyst', name: 'Analyst', role: 'Turns the raw requirement into testable scope.',
      in: 'Raw requirement', out: 'Acceptance criteria (Given/When/Then, AC-n), tasks with owners, assumptions, open questions, out of scope',
      can: 'Shape the scope, flag open questions', cannot: 'Design or write code',
      demo: '6 acceptance criteria, 6 tasks, 1 open question (the 180-day refund window, recorded for the approver).' },
    { n: 'architect', name: 'Architect', role: 'Designs the change and sets the developer\'s file scope.',
      in: 'Criteria + static repo inspection', out: 'Impacted components, approach, API contract, allowed_files, forbidden_files, ADRs, risks',
      can: 'Set the file scope, rule on design deviations', cannot: 'Allow protected paths (the policy strips them)',
      demo: '6 impacted components. Scope = src/refunds.js, src/payments.js, test/refunds.test.js.' },
    { n: 'qa', name: 'QA', role: 'Writes the exam before the code exists, then reviews real results.',
      in: 'Criteria + API contract, later real test, coverage and lint results', out: 'Acceptance test file, criteria covered, verdict, failing criteria, feedback for the developer',
      can: 'Turn failures into actionable feedback', cannot: 'Change source code or override a failing test',
      demo: 'Wrote test/acceptance/refunds.acceptance.test.js covering AC-1 to AC-6. Caught the AC-2 bug in iteration 1.' },
    { n: 'developer', name: 'Developer', role: 'Implements the change inside the allowed files.',
      in: 'Design, allowed files with current content, feedback, human guidance', out: 'Change set (full file contents), design deviations, tests added',
      can: 'Change allowed files, formally disagree with the design', cannot: 'Touch other files, edit acceptance tests, merge',
      demo: 'Iteration 1 forgot earlier partial refunds (14/15). Iteration 2 added a cumulative-balance guard (15/15).' },
    { n: 'security', name: 'Security', role: 'Reviews the diff with the static scanner\'s findings.',
      in: 'Diff + static scanner findings', out: 'Verdict (pass / block), findings with severity',
      can: 'Block the release path', cannot: 'Downgrade a scanner finding',
      demo: 'No findings in the minimum demo. In scenario 04 it confirms PCI-001 (card number logged) and blocks.' },
    { n: 'release', name: 'Release', role: 'Assembles the evidence pack for the human approver.',
      in: 'Everything above', out: 'Title, summary, test evidence, known risks, rollback plan, recommendation',
      can: 'Recommend approve or reject', cannot: 'Approve, merge or deploy',
      demo: 'Recommends "approve". The run stops at AWAITING_APPROVAL until a named human decides.' },
  ];
  const pipe = $('#pipeline'), panel = $('#agent');
  pipe.innerHTML = agents.map((a, i) =>
    `<li><button type="button" role="tab" id="ag-${a.n}" aria-selected="${i === 0}" data-i="${i}"><span class="n">0${i + 1}</span><span class="nm">${a.name}</span></button></li>`).join('');
  function showAgent(i) {
    const a = agents[i];
    $$('button', pipe).forEach((b, j) => b.setAttribute('aria-selected', j === i));
    panel.innerHTML = `<h3>${a.name}</h3><p class="role">${a.role}</p><dl>
      <div><dt>Receives</dt><dd>${a.in}</dd></div>
      <div><dt>Returns (validated JSON)</dt><dd>${a.out}</dd></div>
      <div><dt>Can</dt><dd class="can">${a.can}</dd></div>
      <div><dt>Cannot</dt><dd class="cannot">${a.cannot}</dd></div>
      <div style="grid-column:1/-1"><dt>In the minimum demo</dt><dd>${a.demo}</dd></div></dl>`;
  }
  pipe.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showAgent(+b.dataset.i); });
  pipe.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const cur = $$('button', pipe).findIndex((b) => b.getAttribute('aria-selected') === 'true');
    const nx = (cur + (e.key === 'ArrowRight' ? 1 : agents.length - 1)) % agents.length;
    showAgent(nx); $$('button', pipe)[nx].focus();
  });
  showAgent(0);

  /* ---------- scenarios ---------- */
  const list = $('#scn-list'), scn = $('#scn');
  let runs = [], timer = 0;
  const statusLabel = { DEPLOYED: 'Deployed', AWAITING_APPROVAL: 'Awaiting approval', ESCALATED: 'Escalated', REJECTED: 'Rejected' };
  const cls = (e) => {
    if (/failed|escalated|violation|security_blocked|output_rejected|repeat_detected|circuit_open|paused|disagreement/.test(e.type)) return e.type.includes('provider') || e.type.includes('paused') ? 'warn' : 'bad';
    if (/gate\.passed|merge|deploy|resumed/.test(e.type)) return 'ok';
    if (/approval|human/.test(e.type)) return 'hum';
    if (e.type.startsWith('provider')) return 'warn';
    return '';
  };
  const line = (e) => `<div class="ln"><span class="t">+${(e.t / 1000).toFixed(2)}s</span><span class="a">${esc(e.agent || '')}</span><span class="${cls(e)}">${esc(e.message)}</span></div>`;

  function showRun(i) {
    clearInterval(timer);
    const r = runs[i], m = r.metrics;
    $$('button', list).forEach((b, j) => b.setAttribute('aria-selected', j === i));
    const demos = [].concat(r.demonstrates || []);
    scn.className = `scn card st-${m.status}`;
    scn.innerHTML = `
      <span class="badge">${statusLabel[m.status] || m.status}</span>
      <h3 style="margin-top:10px">${esc(r.title)}</h3>
      <div class="demos">${demos.map((d) => `<span>${esc(d)}</span>`).join('')}</div>
      <p class="desc">${esc(r.description)}</p>
      <div class="kpis">
        <div><small>Iterations</small><b>${m.iterations}</b></div>
        <div><small>Model calls</small><b>${m.modelCalls}</b></div>
        <div><small>Est. cost</small><b>$${m.costUsd.toFixed(4)}</b></div>
        <div><small>Rubric</small><b>${m.score ?? '–'}${m.score != null ? '/100' : ''}</b></div>
      </div>
      <div class="gates">${m.gates.map((g) => `<span class="gate ${g.gate}">#${g.n} ${g.gate.replace(/_/g, ' ')}${g.tests !== '-' ? ' · ' + g.tests : ''}${g.sast ? ' · SAST ' + g.sast : ''}</span>`).join('')}</div>
      <div class="term-bar">
        <button type="button" id="replay">▶ Replay event log</button>
        <button type="button" id="all">Show all</button>
        <span class="grow"></span>
        <a href="reports/${r.id}.html" target="_blank" rel="noopener">Full HTML report ↗</a>
      </div>
      <div class="term" id="term" aria-live="off"></div>`;
    const term = $('#term', scn);
    const showAll = () => { clearInterval(timer); term.innerHTML = r.events.map(line).join(''); };
    const replay = () => {
      clearInterval(timer); term.innerHTML = ''; let k = 0;
      timer = setInterval(() => {
        if (k >= r.events.length) return clearInterval(timer);
        term.insertAdjacentHTML('beforeend', line(r.events[k++]));
        term.scrollTop = term.scrollHeight;
      }, 120);
    };
    $('#replay', scn).onclick = replay;
    $('#all', scn).onclick = showAll;
    reduced ? showAll() : replay();
  }

  fetch('data/runs.json').then((r) => r.json()).then((data) => {
    runs = data;
    list.innerHTML = runs.map((r, i) =>
      `<button type="button" role="tab" aria-selected="false" data-i="${i}" class="st-${r.metrics.status}"><span class="id">${r.id.slice(0, 2)}</span><span>${esc(r.title)}</span><span class="dot" title="${statusLabel[r.metrics.status]}"></span></button>`).join('');
    list.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showRun(+b.dataset.i); });
    // start the replay only when the section scrolls into view
    const io = new IntersectionObserver(([en]) => { if (en.isIntersecting) { showRun(0); io.disconnect(); } }, { threshold: 0.25 });
    io.observe($('#scenarios'));
  }).catch(() => { scn.innerHTML = '<p class="muted">Scenario data could not be loaded.</p>'; });

  /* ---------- autonomy decisions ---------- */
  const decisions = [
    ['agent', 'Acceptance criteria, task plan', 'Analyst agent', 'Cheap to revise. Open questions are surfaced to the approver.'],
    ['agent', 'Design and file scope', 'Architect agent, narrowed by policy', 'Bounded by protected paths that no agent can widen.'],
    ['agent', 'Code changes', 'Developer agent, only on an isolated branch', 'Nothing reaches main without a human.'],
    ['agent', 'Design disagreement (first round)', 'Architect agent', 'Clear ownership and a recorded rationale.'],
    ['tool', 'Pass or fail of a quality gate', 'Deterministic tools', 'Agents cannot grade their own work. If an agent says "pass" and the evidence disagrees, the evidence wins.'],
    ['tool', 'Scope, repeats and idempotency', 'Policy guard', 'Out-of-scope change sets are rejected before they touch the workspace.'],
    ['human', 'Design disagreement (persists)', 'Human', 'Cross-team ownership conflicts are organisational decisions.'],
    ['human', 'Loop exhausted, no progress, invalid output, budget exceeded', 'Human (escalation)', 'Repeating a failing strategy wastes money and hides the problem.'],
    ['human', 'Merge to main, deploy', 'Named human only', 'Irreversible, customer-impacting and in PCI scope. Agent names are refused.'],
  ];
  $('#decisions').innerHTML = decisions.map(([k, what, who, why]) =>
    `<div class="dec card ${k}"><span class="who">${who}</span><h3>${what}</h3><p>${why}</p></div>`).join('');
  $('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    $$('.chip').forEach((c) => c.classList.toggle('on', c === b));
    $$('.dec').forEach((d) => d.classList.toggle('hide', b.dataset.f !== 'all' && !d.classList.contains(b.dataset.f)));
  });

  /* ---------- chart tabs ---------- */
  const alts = { 'calls-by-scenario': 'Model calls per scenario, by outcome', 'cost-by-agent': 'Estimated cost by agent in the minimum demo', 'tokens-by-agent': 'Tokens by agent across all scenarios' };
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', x === t); });
    const img = $('#chart');
    img.src = `assets/${t.dataset.chart}.svg`; img.alt = alts[t.dataset.chart];
    img.removeAttribute('width'); img.removeAttribute('height');
  }));

  /* ---------- copy buttons ---------- */
  $$('.copy').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; }
    catch { b.textContent = 'Press Ctrl+C'; }
    setTimeout(() => (b.textContent = 'Copy'), 1500);
  }));

  /* ---------- reveal, count-up, active nav ---------- */
  if (!reduced) {
    $$('.section > *').forEach((el) => el.classList.add('reveal'));
    const ro = new IntersectionObserver((ens) => ens.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); ro.unobserve(en.target); } }), { threshold: 0.1 });
    $$('.reveal').forEach((el) => ro.observe(el));
    $$('[data-count]').forEach((el) => {
      const end = +el.dataset.count, t0 = performance.now();
      const step = (now) => { const p = Math.min(1, (now - t0) / 900); el.textContent = Math.round(end * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  }
  const links = $$('.nav nav a');
  const so = new IntersectionObserver((ens) => ens.forEach((en) => {
    if (en.isIntersecting) links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + en.target.id));
  }), { rootMargin: '-45% 0px -50% 0px' });
  $$('main section[id]').forEach((s) => so.observe(s));
})();
