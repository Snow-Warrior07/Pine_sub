// Live demo: a browser simulator of the orchestrator, and a real-model mode that runs the
// Analyst and Architect agents on Claude with the visitor's own API key.
// Validation, JSON extraction, repair re-prompts and the scope policy are ports of
// src/agents/schemas.ts, src/llm/json.ts, src/llm/gateway.ts and src/tools/policy.ts.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =====================================================================================
   Shared: schema validation, JSON extraction, policy (ports of the Node code)
   ===================================================================================== */
const str = (o = {}) => ({ type: 'string', ...o });
const arr = (items, o = {}) => ({ type: 'array', items, ...o });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function validate(value, schema, path = '$') {
  const errors = [];
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return [`${path}: expected string, got ${typeOf(value)}`];
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: must be at least ${schema.minLength} characters`);
      if (schema.pattern && !schema.pattern.test(value)) errors.push(`${path}: "${value}" does not match ${schema.pattern}`);
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: unsupported value "${value}" (allowed: ${schema.enum.join(', ')})`);
      return errors;
    case 'array':
      if (!Array.isArray(value)) return [`${path}: expected array, got ${typeOf(value)}`];
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: allows at most ${schema.maxItems} item(s)`);
      value.forEach((v, i) => errors.push(...validate(v, schema.items, `${path}[${i}]`)));
      return errors;
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected object, got ${typeOf(value)}`];
      for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key}: missing required field`);
      for (const [key, v] of Object.entries(value)) {
        const sub = schema.properties[key];
        if (!sub) { errors.push(`${path}.${key}: unexpected field`); continue; }
        errors.push(...validate(v, sub, `${path}.${key}`));
      }
      return errors;
    }
  }
  return errors;
}

const ROLES = ['analyst', 'architect', 'developer', 'qa', 'security', 'release'];
const relPath = str({ minLength: 1, pattern: /^(?!\/)(?!.*\.\.)[\w./-]+$/ });
const SCHEMAS = {
  'analyst.clarify': obj({
    summary: str({ minLength: 10 }),
    acceptance_criteria: arr(obj({ id: str({ pattern: /^AC-\d+$/ }), given: str({ minLength: 3 }), when: str({ minLength: 3 }), then: str({ minLength: 3 }) }), { minItems: 1, maxItems: 12 }),
    tasks: arr(obj({ id: str({ pattern: /^T-\d+$/ }), title: str({ minLength: 3 }), owner_agent: str({ enum: ROLES }), depends_on: arr(str()) }), { minItems: 1, maxItems: 20 }),
    assumptions: arr(str()),
    open_questions: arr(str()),
    out_of_scope: arr(str()),
  }),
  'architect.design': obj({
    impacted_components: arr(obj({ path: relPath, change_type: str({ enum: ['create', 'modify', 'read_only'] }), reason: str({ minLength: 3 }) }), { minItems: 1 }),
    approach: str({ minLength: 10 }),
    api_contract: arr(str()),
    allowed_files: arr(relPath, { minItems: 1, maxItems: 10 }),
    forbidden_files: arr(obj({ path: relPath, reason: str() })),
    decisions: arr(obj({ id: str({ pattern: /^ADR-\d+$/ }), decision: str(), rationale: str() })),
    risks: arr(str()),
  }),
};

const JSON_RULE = 'Respond with a single JSON object only, no prose and no code fences. Do not add fields that are not in the contract.';
const SYSTEM_PROMPTS = {
  'analyst.clarify': `You are the Analyst agent in a software delivery team.
Responsibility: turn a product requirement into testable acceptance criteria and a task plan.
You do not design or write code.
Write each acceptance criterion as Given/When/Then with ids AC-1, AC-2, ...
Make tasks with ids T-1, T-2, ... owned by one of: analyst, architect, developer, qa, security, release.
List assumptions you made and open questions a human should answer.
Contract: {"summary": string, "acceptance_criteria": [{"id","given","when","then"}], "tasks": [{"id","title","owner_agent","depends_on": string[]}], "assumptions": string[], "open_questions": string[], "out_of_scope": string[]}
${JSON_RULE}`,
  'architect.design': `You are the Architect agent.
Responsibility: from the acceptance criteria and a static inspection of the repository, identify the
impacted components and propose the smallest design that meets the criteria.
You own the design. You decide which files the developer may change ("allowed_files", at most 10) and which
files must not change ("forbidden_files"), with reasons. Prefer new modules over editing files owned by other teams.
Record significant decisions as ADR-1, ADR-2, ...
Contract: {"impacted_components": [{"path","change_type": "create"|"modify"|"read_only","reason"}], "approach": string, "api_contract": string[], "allowed_files": string[], "forbidden_files": [{"path","reason"}], "decisions": [{"id","decision","rationale"}], "risks": string[]}
${JSON_RULE}`,
};

function parseModelJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'empty response' };
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf('{'), end = candidate.lastIndexOf('}');
  if (start === -1) return { ok: false, error: 'no JSON object found in response' };
  if (end < start) return { ok: false, error: 'JSON object is not closed (response looks truncated)' };
  try { return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) }; }
  catch (e) { return { ok: false, error: `invalid JSON: ${e.message}` }; }
}

const PROTECTED_PATHS = ['.git/', '.github/', 'config/', 'package.json', 'package-lock.json', 'test/acceptance/'];
const WRITABLE_ROOTS = ['src/', 'test/'];
function normalisePath(p) {
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\0')) return null;
  const parts = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join('/');
}
const isProtected = (path) => PROTECTED_PATHS.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
function sanitiseAllowedFiles(files) {
  const kept = [], dropped = [];
  for (const f of files) {
    const p = normalisePath(f);
    if (!p || isProtected(p) || !WRITABLE_ROOTS.some((r) => p.startsWith(r))) dropped.push(f); else kept.push(p);
  }
  return { files: [...new Set(kept)], dropped };
}

const PRICING = { 'claude-opus-5-5': { input: 4, output: 20 }, 'claude-sonnet-5-5': { input: 2, output: 10 } };
const costUsd = (model, i, o) => { const p = PRICING[model] ?? PRICING['claude-opus-5-5']; return (i * p.input + o * p.output) / 1e6; };
const AGENT_NAMES = new Set(['analyst', 'architect', 'developer', 'qa', 'security', 'release', 'orchestrator']);

/* =====================================================================================
   Terminal + pipeline helpers
   ===================================================================================== */
function makeTerm(el) {
  const t0 = performance.now();
  return {
    clear() { el.innerHTML = ''; },
    line(msg, { agent = '', cls = '' } = {}) {
      const t = ((performance.now() - t0) / 1000).toFixed(1);
      el.insertAdjacentHTML('beforeend', `<div class="ln"><span class="t">+${t}s</span><span class="a">${esc(agent)}</span><span class="${cls}">${esc(msg)}</span></div>`);
      el.scrollTop = el.scrollHeight;
    },
  };
}
function setStage(strip, agent) {
  $$('[data-ag]', strip).forEach((s) => s.classList.toggle('on', s.dataset.ag === agent));
}
function setBadge(el, status) {
  const labels = { RUNNING: 'Running', AWAITING_APPROVAL: 'Awaiting approval', DEPLOYED: 'Deployed', ESCALATED: 'Escalated', PAUSED: 'Paused', REJECTED: 'Rejected', IDLE: 'Ready', FAILED: 'Failed' };
  el.className = `badge st-${status}`;
  el.textContent = labels[status] || status;
}

/* =====================================================================================
   Mode 1: simulator
   ===================================================================================== */
const PRESETS = {
  '01': { label: '01 · Minimum demo (one failed check)', f: { bug: true } },
  '02': { label: '02 · Architect and developer disagree', f: { disagree: true } },
  '03': { label: '03 · Code keeps failing tests', f: { bug: true, persist: true } },
  '04': { label: '04 · Security finds a critical issue', f: { pan: true } },
  '05': { label: '05 · Malformed agent output', f: { malformed: true } },
  '06': { label: '06 · Primary model goes down', f: { failover: true } },
  '07': { label: '07 · All models down, then resume', f: { outage: true } },
  '08': { label: '08 · Developer edits an unrelated file', f: { scope: true } },
  '09': { label: '09 · Developer repeats the same change', f: { bug: true, repeat: true } },
  '10': { label: '10 · Disagreement escalates to a human', f: { disagree: true, insist: true } },
  clean: { label: 'Clean run (no faults)', f: {} },
};
const FAULTS = [
  ['bug', 'Developer forgets earlier partial refunds', 'First implementation fails acceptance test AC-2'],
  ['persist', 'Developer never fixes the bug', 'Every iteration fails, so the loop budget runs out'],
  ['pan', 'Developer logs the card number', 'Static scan raises PCI-001 (critical)'],
  ['malformed', 'Analyst returns malformed JSON', 'Truncated JSON and an unknown agent name'],
  ['failover', 'Primary model goes down', 'Returns 503 until the circuit breaker opens'],
  ['outage', 'All models go down mid-run', 'The run pauses at a checkpoint'],
  ['scope', 'Developer edits an unrelated file', 'Tries to change src/settlement.js'],
  ['repeat', 'Developer resubmits the same change', 'Identical content hash after feedback'],
  ['disagree', 'Developer wants to change the Finance ledger', 'Raises a design deviation on src/ledger.js'],
  ['insist', 'Developer refuses the architect\'s ruling', 'The disagreement persists'],
];
// Simulated token counts per call, from the recorded runs (mock provider, characters ÷ 4).
const TOKENS = { analyst: [363, 789], architect: [1787, 766], qa: [850, 330], developer: [2552, 1610], security: [2558, 34], release: [1589, 177] };

function initSimulator(root) {
  const presetSel = $('#sim-preset', root), faultsEl = $('#sim-faults', root), budgetEl = $('#sim-budget', root);
  const budgetOut = $('#sim-budget-out', root), runBtn = $('#sim-run', root), speedSel = $('#sim-speed', root);
  const termEl = $('#sim-term', root), strip = $('#sim-strip', root), badge = $('#sim-badge', root);
  const gatesEl = $('#sim-gates', root), statsEl = $('#sim-stats', root), actionsEl = $('#sim-actions', root);

  presetSel.innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
  faultsEl.innerHTML = FAULTS.map(([k, name, hint]) =>
    `<label class="fault"><input type="checkbox" data-f="${k}"><span><b>${esc(name)}</b><small>${esc(hint)}</small></span></label>`).join('');
  const applyPreset = () => { const f = PRESETS[presetSel.value].f; $$('[data-f]', faultsEl).forEach((c) => (c.checked = !!f[c.dataset.f])); };
  presetSel.addEventListener('change', applyPreset);
  budgetEl.addEventListener('input', () => (budgetOut.textContent = budgetEl.value));
  presetSel.value = '01'; budgetEl.value = '3';
  applyPreset();

  let run = null, token = 0;
  const term = { current: null };

  function newRun() {
    const f = Object.fromEntries($$('[data-f]', faultsEl).map((c) => [c.dataset.f, c.checked]));
    return {
      id: 'sim-' + new Date().toISOString().slice(11, 19).replace(/:/g, ''),
      f, budget: +budgetEl.value, iteration: 0, status: 'RUNNING', done: new Set(), calls: 0, failed: 0, cost: 0,
      provider: 'claude-opus-5-5', gates: [], lastHash: null, guidance: null, approvedBy: null, merges: 0, deviationRuled: false,
    };
  }
  const delay = () => 380 / +speedSel.value;
  async function emit(msg, opts = {}) {
    const my = token;
    await sleep(opts.wait ?? delay());
    if (my !== token) throw new Error('cancelled');
    if (opts.agent) setStage(strip, opts.agent);
    term.current.line(msg, opts);
  }
  function call(agent, { ok = true } = {}) {
    run.calls++; if (!ok) run.failed++;
    const [i, o] = TOKENS[agent];
    run.cost += costUsd(run.provider, i, o);
    renderStats();
  }
  function renderStats() {
    statsEl.innerHTML = `<div><small>Iterations</small><b>${run.iteration}/${run.budget}</b></div>
      <div><small>Model calls</small><b>${run.calls}${run.failed ? ` <em>(${run.failed} failed or rejected)</em>` : ''}</b></div>
      <div><small>Est. cost</small><b>$${run.cost.toFixed(4)}</b></div>
      <div><small>Model</small><b>${run.provider.replace('claude-', '')}</b></div>`;
    gatesEl.innerHTML = run.gates.map((g) => `<span class="gate ${g.gate}">#${g.n} ${g.gate.replace(/_/g, ' ')}${g.tests ? ' · ' + g.tests : ''}${g.sast ? ' · SAST ' + g.sast : ''}</span>`).join('');
  }
  function status(s, why) {
    run.status = s; setBadge(badge, s); renderActions();
    if (why) term.current.line(why, { cls: s === 'DEPLOYED' ? 'ok' : s === 'AWAITING_APPROVAL' ? 'hum' : s === 'REJECTED' ? 'bad' : 'warn' });
  }

  async function step(name, fn) {
    if (run.done.has(name)) { await emit(`Step ${name} already completed (checkpoint); skipped`, { cls: 't' }); return; }
    await fn();
    run.done.add(name);
  }

  async function model(agent) {
    // Provider failover: the primary fails during the first call while the fault is on.
    if (run.f.failover && run.provider === 'claude-opus-5-5') {
      for (let k = 1; k <= 2; k++) { call(agent, { ok: false }); await emit(`claude-opus-5-5 error: 503 overloaded. Retry ${k}/2 in ${500 * 2 ** (k - 1)}ms`, { cls: 'warn' }); }
      call(agent, { ok: false });
      await emit('claude-opus-5-5 unavailable (503 overloaded); circuit opened. Failing over to claude-sonnet-5-5', { cls: 'warn' });
      run.provider = 'claude-sonnet-5-5';
    }
    call(agent);
  }

  async function workflow() {
    await step('intake', async () => {
      await emit(`Run ${run.id} started`);
      await emit(`Sandbox workspace created; agent work isolated on branch agent/${run.id}`);
    });
    await step('analysis', async () => {
      if (run.f.malformed) {
        call('analyst', { ok: false });
        await emit('analyst.clarify output rejected: JSON object is not closed (response looks truncated). Asking for a corrected response (1/2)', { agent: 'analyst', cls: 'bad' });
        call('analyst', { ok: false });
        await emit('analyst.clarify output rejected: $.tasks[3].owner_agent: unsupported value "deploy_bot". Asking for a corrected response (2/2)', { agent: 'analyst', cls: 'bad' });
      }
      await model('analyst');
      await emit('Analyst: 6 acceptance criteria, 6 tasks, 1 open question(s)', { agent: 'analyst' });
      await emit('Open question recorded for the approver: should partial refunds respect the 180-day refund window?', { cls: 'hum' });
    });
    await step('inspection', async () => {
      await emit('Repository inspected: 7 JS files; strongest matches src/payments.js (payment×51, refund×10)');
    });
    await step('architecture', async () => {
      await model('architect');
      await emit('Architect: 6 impacted components; developer scope = src/refunds.js, src/payments.js, test/refunds.test.js', { agent: 'architect' });
      await emit('ADR-2: src/ledger.js is owned by Finance; refunds use the existing recordEntry API', { agent: 'architect' });
    });
    await step('test_authoring', async () => {
      await model('qa');
      await emit('QA wrote test/acceptance/refunds.acceptance.test.js before any implementation, covering AC-1 … AC-6', { agent: 'qa' });
    });
    if (run.f.outage && !run.resumedFromOutage) {
      for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5']) { call('developer', { ok: false }); await emit(`${m} unavailable (connection reset); circuit opened`, { cls: 'warn' }); }
      return status('PAUSED', 'All model providers are down. Run paused at a checkpoint; completed steps will not repeat on resume.');
    }
    await implementation();
  }

  async function implementation() {
    run.done.delete('implementation');
    while (run.iteration < run.budget) {
      run.iteration++;
      const n = run.iteration;
      const guided = !!run.guidance;
      await emit(`Iteration ${n}/${run.budget}`, { cls: 't' });

      // Design disagreement on the Finance-owned ledger.
      if (run.f.disagree && !guided && !(run.deviationRuled && !run.f.insist)) {
        await model('developer');
        await emit('Developer raises a design deviation: modify src/ledger.js to add a REFUND entry type', { agent: 'developer', cls: 'warn' });
        await model('architect');
        await emit('Architect rejects the deviation (ADR-2: ledger.js is Finance-owned; use recordEntry with type REFUND)', { agent: 'architect', cls: 'warn' });
        run.deviationRuled = true;
        if (run.f.insist && n >= 2) {
          run.gates.push({ n, gate: 'fail' }); renderStats();
          return status('ESCALATED', 'Persistent disagreement after the deviation round: both positions recorded. A human must decide.');
        }
        if (run.f.insist) { run.gates.push({ n, gate: 'fail' }); renderStats(); await emit('Developer insists; one more round allowed', { cls: 'warn' }); continue; }
        await emit('Developer complies with the architect\'s ruling', { agent: 'developer' });
      }

      await model('developer');
      const touchesSettlement = run.f.scope && n === 1 && !guided;
      const files = touchesSettlement ? 'src/payments.js, src/refunds.js, src/settlement.js' : 'src/payments.js, src/refunds.js, test/refunds.test.js';
      await emit(`Developer: refund service with ${n === 1 && run.f.bug && !guided ? 'amount validation' : 'cumulative-balance guard'}, idempotency keys and REFUND ledger entries (${files})`, { agent: 'developer' });

      if (touchesSettlement) {
        await emit('Policy: src/settlement.js is not in the architect\'s allowed_files; unrelated file changes are blocked. Change set rejected before touching the workspace', { cls: 'bad' });
        run.gates.push({ n, gate: 'blocked_by_policy' }); renderStats();
        continue;
      }

      const failing = !guided && ((run.f.bug && (n === 1 || run.f.persist)) || (run.f.repeat && n >= 1 && run.f.bug));
      const hash = failing ? 'a07cdb3' : 'f3e91c0';
      if (run.f.repeat && run.lastHash === hash && !guided) {
        await emit(`Change set ${hash} is identical to iteration ${n - 1}: no re-apply, no re-test`, { cls: 'bad' });
        run.gates.push({ n, gate: 'no_progress' }); renderStats();
        return status('ESCALATED', 'No progress: the developer repeated an action. Escalated to a human instead of looping.');
      }
      run.lastHash = hash;
      await emit(`Applied 3 file(s) on agent/${run.id} at ${hash}`);

      const panLeak = run.f.pan && n === 1 && !guided;
      const tests = failing ? '14/15' : '15/15';
      await emit(`Checks: tests ${tests} passed, coverage 93.36%, lint 0, SAST ${panLeak ? 1 : 0}`);
      await model('qa'); await model('security');
      const problems = [];
      if (failing) problems.push('QA: test "AC-2 cumulative refunds can never exceed the captured amount" failed');
      if (panLeak) problems.push('Security: PCI-001 critical, card number written to the log in src/refunds.js:14');
      if (panLeak) await emit('Security agent confirms PCI-001 and blocks the release path', { agent: 'security', cls: 'bad' });

      if (problems.length) {
        run.gates.push({ n, gate: 'fail', tests, sast: panLeak ? 1 : 0 }); renderStats();
        await emit(`Iteration ${n} failed: ${problems.join('; ')}`, { cls: 'bad' });
        if (n < run.budget) await emit('Feedback sent to the developer', { agent: 'qa' });
        continue;
      }
      run.gates.push({ n, gate: 'pass', tests }); renderStats();
      await emit(`Iteration ${n}: all gates green`, { cls: 'ok' });
      return finish();
    }
    return status('ESCALATED', `Iteration budget (${run.budget}) spent without passing every gate. Escalated to a human with the evidence.`);
  }

  async function finish() {
    run.done.add('implementation');
    const score = Math.max(80, 100 - 2 * (run.iteration - 1));
    await emit(`Rubric score ${score}/100 against the human baseline`);
    await model('release');
    await emit('Release: evidence pack assembled, agent recommends "approve". Waiting for a human.', { agent: 'release' });
    setStage(strip, '');
    status('AWAITING_APPROVAL', 'All gates passed. Merge and deployment need human approval.');
  }

  function renderActions() {
    const s = run?.status;
    const nameField = `<input type="text" id="sim-name" placeholder="Your name (not an agent)" maxlength="40">`;
    if (s === 'AWAITING_APPROVAL' || s === 'DEPLOYED') {
      actionsEl.innerHTML = `<p class="act-h">${s === 'DEPLOYED' ? 'Try approving again: the merge must not repeat.' : 'You are the approver.'}</p>
        <div class="act-row">${nameField}<button type="button" class="btn primary" data-act="approve">Approve merge & deploy</button>${s === 'AWAITING_APPROVAL' ? '<button type="button" class="btn" data-act="reject">Reject</button>' : ''}</div>`;
    } else if (s === 'ESCALATED') {
      actionsEl.innerHTML = `<p class="act-h">A human must decide how to continue.</p>
        <div class="act-row">${nameField}<input type="text" id="sim-guidance" placeholder="Guidance, e.g. side with the architect" maxlength="120">
        <button type="button" class="btn primary" data-act="guide">Resume with guidance</button><button type="button" class="btn" data-act="reject">Reject</button></div>`;
    } else if (s === 'PAUSED') {
      actionsEl.innerHTML = `<p class="act-h">The providers are back.</p><div class="act-row"><button type="button" class="btn primary" data-act="resume">Resume from checkpoint</button></div>`;
    } else actionsEl.innerHTML = '';
  }

  function humanName() {
    const v = ($('#sim-name', actionsEl)?.value || '').trim();
    if (!v || AGENT_NAMES.has(v.toLowerCase())) {
      term.current.line(!v ? 'Refused: a named human must take this decision' : `Refused: "${v}" is an agent; only a named human can decide`, { cls: 'bad' });
      return null;
    }
    return v;
  }

  actionsEl.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act || !run) return;
    try {
      if (act === 'approve') {
        const by = humanName(); if (!by) return;
        if (run.status === 'DEPLOYED') { term.current.line(`approval.duplicate: already approved by ${run.approvedBy}; merge and deploy are not repeated (idempotency key exists)`, { cls: 'warn' }); return; }
        run.approvedBy = by;
        term.current.line(`Approved by ${by}`, { cls: 'hum' });
        await emit(`Merged agent/${run.id} into main at 7a41bd2 (exactly once)`, { cls: 'ok' });
        await emit('Deployment to production simulated for commit 7a41bd2', { cls: 'ok' });
        status('DEPLOYED', `Deployed: approved by ${by}`);
      } else if (act === 'reject') {
        const by = humanName(); if (!by) return;
        status('REJECTED', `Rejected by ${by}. main is untouched.`);
      } else if (act === 'resume') {
        run.resumedFromOutage = true;
        term.current.line('Run resumed from checkpoint', { cls: 'ok' });
        setBadge(badge, 'RUNNING'); actionsEl.innerHTML = '';
        await workflow();
      } else if (act === 'guide') {
        const by = humanName(); if (!by) return;
        const g = ($('#sim-guidance', actionsEl).value || 'Side with the architect; fix the cumulative-refund guard').trim();
        run.guidance = g; run.budget = run.iteration + 1;
        term.current.line(`Human guidance from ${by}: ${g}`, { cls: 'hum' });
        setBadge(badge, 'RUNNING'); actionsEl.innerHTML = '';
        await implementation();
      }
    } catch (err) { if (err.message !== 'cancelled') throw err; }
  });

  runBtn.addEventListener('click', async () => {
    token++;
    run = newRun();
    term.current = makeTerm(termEl); term.current.clear();
    setBadge(badge, 'RUNNING'); actionsEl.innerHTML = ''; renderStats();
    try { await workflow(); } catch (err) { if (err.message !== 'cancelled') throw err; }
  });
  setBadge(badge, 'IDLE');
}

/* =====================================================================================
   Mode 2: real Claude with the visitor's API key
   ===================================================================================== */
const REQUIREMENTS = {
  'REQ-101 · Partial refunds': `# REQ-101: Partial refunds for captured payments

Merchants today can only refund the full amount of a payment. They need to refund part
of a captured payment, for example when one item of a multi-item order is returned.

- A captured payment can be refunded in one or more parts.
- The total refunded must never exceed the captured amount.
- Merchants' systems retry on network failures, so a retried refund request must not refund twice.
- Finance needs every refund to appear in the ledger.
- Card numbers must never appear in logs (PCI DSS).`,
  'REQ-102 · Refund reasons': `# REQ-102: Refund reason codes

Support teams need to know why money goes back to customers.

- Every refund must carry a reason code: item_returned, damaged, duplicate_charge, goodwill or other.
- "other" requires a free-text note of at most 200 characters.
- Merchants can list refunds for a payment with their reason codes.
- Existing full refunds keep working; they default to reason "other" with note "legacy".`,
  'REQ-103 · Daily settlement cap': `# REQ-103: Daily refund cap per merchant

Risk wants to limit exposure from compromised merchant accounts.

- A merchant cannot refund more than 5,00,000 paise in total per calendar day (IST).
- A refund that would exceed the cap is rejected with a clear error and nothing is recorded.
- The cap is configurable per merchant by the Risk team.
- Every rejected refund is logged without card numbers.`,
};
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.12.0/+esm';

function initReal(root) {
  const keyEl = $('#rm-key', root), modelEl = $('#rm-model', root), presetEl = $('#rm-preset', root), reqEl = $('#rm-req', root);
  const runBtn = $('#rm-run', root), stopBtn = $('#rm-stop', root), termEl = $('#rm-term', root), strip = $('#rm-strip', root);
  const badge = $('#rm-badge', root), statsEl = $('#rm-stats', root), outEl = $('#rm-out', root), liveEl = $('#rm-live', root);

  presetEl.innerHTML = Object.keys(REQUIREMENTS).map((k) => `<option>${esc(k)}</option>`).join('') + '<option value="">Write your own…</option>';
  const fill = () => { if (presetEl.value) reqEl.value = REQUIREMENTS[presetEl.value]; else { reqEl.value = ''; reqEl.focus(); } };
  presetEl.addEventListener('change', fill); fill();

  let inspection = null, current = null;
  const usage = { calls: 0, rejected: 0, input: 0, output: 0, cost: 0, ms: 0 };
  const renderStats = () => {
    statsEl.innerHTML = `<div><small>Model calls</small><b>${usage.calls}${usage.rejected ? ` <em>(${usage.rejected} rejected)</em>` : ''}</b></div>
      <div><small>Tokens in / out</small><b>${usage.input.toLocaleString()} / ${usage.output.toLocaleString()}</b></div>
      <div><small>Cost (your key)</small><b>$${usage.cost.toFixed(4)}</b></div>
      <div><small>Model time</small><b>${(usage.ms / 1000).toFixed(1)}s</b></div>`;
  };

  // gateway.call(): stream one request, extract + validate JSON, re-prompt with the exact errors (max 2 repairs).
  async function callAgent(client, Anthropic, task, input, agent, term) {
    const model = modelEl.value;
    const baseUser = JSON.stringify(input, null, 2);
    let user = baseUser;
    for (let repairs = 0; ; ) {
      liveEl.textContent = '';
      const started = performance.now();
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 32000,
        system: SYSTEM_PROMPTS[task],
        output_config: { effort: 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [{ role: 'user', content: user }],
      });
      current = stream;
      stream.on('text', (d) => { liveEl.textContent += d; liveEl.scrollTop = liveEl.scrollHeight; });
      const msg = await stream.finalMessage();
      current = null;
      const ms = performance.now() - started;
      usage.calls++; usage.input += msg.usage.input_tokens; usage.output += msg.usage.output_tokens;
      usage.cost += costUsd(model, msg.usage.input_tokens, msg.usage.output_tokens); usage.ms += ms;
      renderStats();
      if (msg.model !== model) term.line(`${model} declined; served by ${msg.model} (server-side fallback)`, { agent, cls: 'warn' });
      if (msg.stop_reason === 'refusal') throw new Error(`The model declined the request (refusal${msg.stop_details?.category ? ': ' + msg.stop_details.category : ''})`);

      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const parsed = parseModelJson(text);
      const errors = parsed.ok ? validate(parsed.value, SCHEMAS[task]) : [parsed.error];
      term.line(`${task} on ${msg.model}: ${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out tokens, ${(ms / 1000).toFixed(1)}s`, { agent, cls: 't' });
      if (!errors.length) { term.line(`Output passed schema validation`, { agent, cls: 'ok' }); return parsed.value; }

      usage.rejected++; renderStats();
      repairs++;
      term.line(`Output rejected by the validator (${errors.length} problem(s)): ${errors.slice(0, 3).join('; ')}`, { agent, cls: 'bad' });
      if (repairs > 2) throw new Error(`${task} output still invalid after 2 repair attempts. The run escalates to a human.`);
      term.line(`Asking for a corrected response (${repairs}/2)`, { agent, cls: 'warn' });
      user = `${baseUser}\n\nYour previous response was rejected by the output validator:\n- ${errors.slice(0, 10).join('\n- ')}\nReturn the corrected JSON object only.`;
    }
  }

  function renderAnalysis(a) {
    return `<h4>Acceptance criteria <span class="muted">(Analyst)</span></h4>
      <div class="ac-list">${a.acceptance_criteria.map((c) => `<div class="ac"><b>${esc(c.id)}</b><span><i>Given</i> ${esc(c.given)} <i>when</i> ${esc(c.when)} <i>then</i> ${esc(c.then)}</span></div>`).join('')}</div>
      <div class="cols3">
        <div><h5>Tasks</h5><ul>${a.tasks.map((t) => `<li><code>${esc(t.id)}</code> ${esc(t.title)} <span class="own">${esc(t.owner_agent)}</span></li>`).join('')}</ul></div>
        <div><h5>Open questions for the approver</h5><ul>${a.open_questions.map((q) => `<li>${esc(q)}</li>`).join('') || '<li class="muted">None</li>'}</ul></div>
        <div><h5>Out of scope</h5><ul>${a.out_of_scope.map((q) => `<li>${esc(q)}</li>`).join('') || '<li class="muted">None</li>'}</ul></div>
      </div>`;
  }
  function renderDesign(d, dropped) {
    return `<h4>Design <span class="muted">(Architect)</span></h4>
      <p>${esc(d.approach)}</p>
      <div class="cols3">
        <div><h5>Developer may change</h5><ul>${d.allowed_files.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul>
          ${dropped.length ? `<p class="bad small">Policy removed: ${dropped.map((f) => `<code>${esc(f)}</code>`).join(', ')} (protected or outside src/ and test/)</p>` : '<p class="ok small">Policy check: scope accepted as proposed</p>'}</div>
        <div><h5>Must not change</h5><ul>${d.forbidden_files.map((f) => `<li><code>${esc(f.path)}</code> ${esc(f.reason)}</li>`).join('') || '<li class="muted">None</li>'}</ul></div>
        <div><h5>Decisions</h5><ul>${d.decisions.map((x) => `<li><b>${esc(x.id)}</b> ${esc(x.decision)}</li>`).join('') || '<li class="muted">None</li>'}</ul></div>
      </div>
      <p class="gate-note">This is where the real orchestrator hands over to QA (tests first), then the developer loop with real tests, coverage, lint and a PCI scan. Merge and deploy wait for a named human.</p>`;
  }

  runBtn.addEventListener('click', async () => {
    const key = keyEl.value.trim();
    const requirement = reqEl.value.trim();
    const term = makeTerm(termEl);
    if (!key) { keyEl.focus(); term.line('Enter your Anthropic API key first', { cls: 'bad' }); return; }
    if (requirement.length < 20) { reqEl.focus(); term.line('Write a requirement of at least a sentence', { cls: 'bad' }); return; }
    term.clear(); outEl.innerHTML = ''; Object.assign(usage, { calls: 0, rejected: 0, input: 0, output: 0, cost: 0, ms: 0 }); renderStats();
    runBtn.disabled = true; stopBtn.disabled = false; setBadge(badge, 'RUNNING');

    let Anthropic;
    try {
      term.line('Loading the official Anthropic SDK…', { cls: 't' });
      Anthropic = (await import(SDK_URL)).default;
      inspection ??= await fetch('data/inspection.json').then((r) => r.json());
      // maxRetries 0: like the project's gateway, retries are visible to you instead of hidden in the SDK.
      const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 0, timeout: 300_000 });

      setStage(strip, 'analyst');
      term.line(`Analyst on ${modelEl.value}: turning the requirement into acceptance criteria`, { agent: 'analyst' });
      const analysis = await callAgent(client, Anthropic, 'analyst.clarify', { requirement }, 'analyst', term);
      term.line(`Analyst: ${analysis.acceptance_criteria.length} acceptance criteria, ${analysis.tasks.length} tasks, ${analysis.open_questions.length} open question(s)`, { agent: 'analyst' });
      outEl.innerHTML = renderAnalysis(analysis);

      setStage(strip, 'architect');
      term.line(`Architect: designing against a static inspection of sample-repo/payments-service (${inspection.files.length} files)`, { agent: 'architect' });
      const design = await callAgent(client, Anthropic, 'architect.design', { requirement, acceptance_criteria: analysis.acceptance_criteria, repository: inspection }, 'architect', term);
      const { files, dropped } = sanitiseAllowedFiles(design.allowed_files);
      if (dropped.length) term.line(`Policy removed protected or out-of-root paths from the design scope: ${dropped.join(', ')}`, { cls: 'bad' });
      design.allowed_files = files;
      term.line(`Architect: ${design.impacted_components.length} impacted components; developer scope = ${files.join(', ') || '(empty)'}`, { agent: 'architect' });
      outEl.insertAdjacentHTML('beforeend', renderDesign(design, dropped));
      setStage(strip, '');
      setBadge(badge, 'AWAITING_APPROVAL');
      term.line('Design ready. In the full workflow, QA writes the acceptance tests next.', { cls: 'hum' });
    } catch (err) {
      setStage(strip, '');
      let msg = err?.message || String(err);
      if (Anthropic && err instanceof Anthropic.AuthenticationError) msg = 'Authentication failed: check your API key';
      else if (Anthropic && err instanceof Anthropic.PermissionDeniedError) msg = 'Your key does not have access to this model';
      else if (Anthropic && err instanceof Anthropic.RateLimitError) msg = 'Rate limited: wait a moment and try again';
      else if (Anthropic && err instanceof Anthropic.APIUserAbortError) msg = 'Stopped';
      else if (Anthropic && err instanceof Anthropic.APIConnectionError) msg = `Connection error: ${err.message}`;
      else if (Anthropic && err instanceof Anthropic.APIError) msg = `API error ${err.status}: ${err.message}`;
      term.line(msg, { cls: 'bad' });
      setBadge(badge, msg === 'Stopped' ? 'IDLE' : msg.includes('escalates') ? 'ESCALATED' : 'FAILED');
    } finally {
      runBtn.disabled = false; stopBtn.disabled = true; current = null;
    }
  });
  stopBtn.addEventListener('click', () => current?.abort());
  renderStats();
  setBadge(badge, 'IDLE');
}

/* ===================================================================================== */
const root = $('#live');
if (root) {
  initSimulator($('#sim', root));
  initReal($('#real', root));
  $$('.ltab', root).forEach((t) => t.addEventListener('click', () => {
    $$('.ltab', root).forEach((x) => { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', x === t); });
    $$('.lpane', root).forEach((p) => (p.hidden = p.id !== t.dataset.pane));
  }));
}
