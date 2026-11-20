// Writes three artifacts per run:
//   evidence.md   - the review summary a human approver reads (tests, risks, decisions)
//   report.html   - self-contained visual run report (timeline, gates, usage, cost, diff)
//   metrics.json  - machine-readable metrics (used to build the README charts)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunStore } from '../state/store.ts';
import type { RunState, UsageRecord, WorkflowEvent } from '../types.ts';

export interface RunMetrics {
  runId: string;
  scenario: string;
  status: string;
  iterations: number;
  modelCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelLatencyMs: number;
  simulated: boolean;
  score: number | null;
  byAgent: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number }>;
  byProvider: Record<string, number>;
  gates: { n: number; gate: string; tests: string; sast: number }[];
}

export function computeMetrics(state: RunState): RunMetrics {
  const byAgent: RunMetrics['byAgent'] = {};
  const byProvider: Record<string, number> = {};
  for (const u of state.usage) {
    const role = u.agent.split('.')[0];
    const a = (byAgent[role] ??= { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 });
    a.calls += 1;
    a.inputTokens += u.inputTokens;
    a.outputTokens += u.outputTokens;
    a.costUsd += u.costUsd;
    a.latencyMs += u.latencyMs;
    byProvider[u.provider] = (byProvider[u.provider] ?? 0) + 1;
  }
  return {
    runId: state.runId,
    scenario: state.scenario,
    status: state.status,
    iterations: state.artifacts.iterations.length,
    modelCalls: state.usage.length,
    failedCalls: state.usage.filter((u) => u.outcome !== 'ok').length,
    inputTokens: sum(state.usage, 'inputTokens'),
    outputTokens: sum(state.usage, 'outputTokens'),
    costUsd: round(sum(state.usage, 'costUsd'), 4),
    modelLatencyMs: sum(state.usage, 'latencyMs'),
    simulated: state.usage.some((u) => u.simulated),
    score: state.artifacts.evaluation?.score ?? null,
    byAgent,
    byProvider,
    gates: state.artifacts.iterations.map((i) => ({
      n: i.n,
      gate: i.gate,
      tests: i.checks ? `${i.checks.tests.passed}/${i.checks.tests.total}` : '-',
      sast: i.checks?.sast.length ?? 0,
    })),
  };
}

export function writeReports(state: RunState, store: RunStore): void {
  const dir = store.runDir(state.runId);
  const events = store.events(state.runId);
  const metrics = computeMetrics(state);
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2));
  writeFileSync(join(dir, 'evidence.md'), evidenceMarkdown(state, metrics));
  writeFileSync(join(dir, 'report.html'), html(state, metrics, events));
}

// ---------------------------------------------------------------- evidence.md

function evidenceMarkdown(s: RunState, m: RunMetrics): string {
  const a = s.artifacts;
  const last = a.iterations.at(-1);
  const out: string[] = [];
  out.push(`# Review summary: ${a.release?.title ?? s.runId}`, '');
  out.push(`| Field | Value |`, `|---|---|`);
  out.push(`| Run | \`${s.runId}\` (scenario \`${s.scenario}\`) |`);
  out.push(`| Status | **${s.status}**: ${s.statusReason} |`);
  out.push(`| Branch | \`${s.branch}\` (main untouched until approval) |`);
  out.push(`| Iterations | ${m.iterations} |`);
  out.push(`| Model calls | ${m.modelCalls} (${m.failedCalls} failed or rejected) |`);
  out.push(`| Tokens | ${m.inputTokens.toLocaleString()} in / ${m.outputTokens.toLocaleString()} out |`);
  out.push(`| Estimated cost | $${m.costUsd.toFixed(4)}${m.simulated ? ' (simulated: mock provider priced as Claude)' : ''} |`);
  if (a.evaluation) out.push(`| Rubric score | ${a.evaluation.score}/${a.evaluation.maxScore} |`);
  out.push('');

  if (a.release) {
    out.push('## Summary', '', a.release.summary, '');
    out.push('## Test evidence', '', ...a.release.test_evidence.map((t) => `- ${t}`), '');
    out.push('## Known risks', '', ...a.release.known_risks.map((t) => `- ${t}`), '');
    out.push('## Rollback plan', '', a.release.rollback_plan, '');
  }
  if (a.analysis) {
    out.push('## Acceptance criteria', '', '| ID | Given | When | Then | Verified |', '|---|---|---|---|---|');
    const failing = new Set(last?.checks?.tests.failures.map((f) => f.name.match(/AC-\d+/)?.[0]) ?? []);
    for (const c of a.analysis.acceptance_criteria) {
      const ok = last?.checks && a.qaTests?.criteria_covered.includes(c.id) && !failing.has(c.id);
      out.push(`| ${c.id} | ${c.given} | ${c.when} | ${c.then} | ${ok ? 'yes' : 'no'} |`);
    }
    out.push('');
    if (a.analysis.open_questions.length) out.push('## Open questions for the approver', '', ...a.analysis.open_questions.map((q) => `- ${q}`), '');
    if (a.analysis.assumptions.length) out.push('## Assumptions made by the agents', '', ...a.analysis.assumptions.map((q) => `- ${q}`), '');
  }
  if (a.design) {
    out.push('## Design decisions', '', ...a.design.decisions.map((d) => `- **${d.id}**: ${d.decision}. _${d.rationale}_`), '');
  }
  out.push('## Iteration history', '', '| # | Gate | Tests | Coverage | SAST | Feedback |', '|---|---|---|---|---|---|');
  for (const it of a.iterations) {
    const c = it.checks;
    out.push(`| ${it.n} | ${it.gate} | ${c ? `${c.tests.passed}/${c.tests.total}` : '-'} | ${c ? `${c.coverage.linePct}%` : '-'} | ${c ? c.sast.length : '-'} | ${it.feedback.join('<br>').replace(/\|/g, '\\|') || '-'} |`);
  }
  out.push('');
  if (a.evaluation) {
    out.push('## Rubric', '', '| Criterion | Points | Detail |', '|---|---|---|');
    for (const c of a.evaluation.criteria) out.push(`| ${c.name} | ${c.points}/${c.max} | ${c.detail} |`);
    out.push('');
  }
  if (s.escalation) {
    out.push('## Escalation: a human decision is needed', '', s.escalation.reason, '', ...s.escalation.options.map((o) => `- [ ] ${o}`), '');
  }
  if (s.approval) out.push('## Human decision', '', `${s.approval.decision} by **${s.approval.by}** at ${s.approval.at}${s.approval.note ? `: ${s.approval.note}` : ''}`, '');
  if (s.status === 'AWAITING_APPROVAL') {
    out.push('## Approve or reject', '', '```bash', `npm run approve -- ${s.runId} --by "<your name>" --note "<why>"`, '```', '', '```bash', `npm run reject -- ${s.runId} --by "<your name>" --note "<why>"`, '```', '');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- report.html

function html(s: RunState, m: RunMetrics, events: WorkflowEvent[]): string {
  const esc = (t: unknown) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const statusClass = s.status === 'DEPLOYED' || s.status === 'AWAITING_APPROVAL' ? 'ok' : s.status === 'PAUSED' ? 'warn' : 'bad';
  const agents = Object.entries(m.byAgent);
  const maxCost = Math.max(...agents.map(([, a]) => a.costUsd), 0.000001);
  const costBars = agents
    .map(([name, a], i) => {
      const w = (a.costUsd / maxCost) * 300;
      return `<g transform="translate(0,${i * 30})"><text x="0" y="16" class="lbl">${esc(name)}</text><rect x="90" y="4" width="${w.toFixed(1)}" height="16" rx="3" class="bar"/><text x="${(96 + w).toFixed(1)}" y="16" class="val">$${a.costUsd.toFixed(4)} · ${a.calls} call${a.calls === 1 ? '' : 's'}</text></g>`;
    })
    .join('');
  const gateRows = s.artifacts.iterations
    .map((it) => `<tr><td>${it.n}</td><td><span class="pill ${it.gate === 'pass' ? 'ok' : 'bad'}">${esc(it.gate)}</span></td><td>${it.checks ? `${it.checks.tests.passed}/${it.checks.tests.total}` : '-'}</td><td>${it.checks ? `${it.checks.coverage.linePct}%` : '-'}</td><td>${it.checks?.sast.length ?? '-'}</td><td>${esc(it.feedback.join(' | '))}</td></tr>`)
    .join('');
  const usageRows = s.usage
    .map((u: UsageRecord) => `<tr><td>${esc(u.agent)}</td><td>${esc(u.provider)}</td><td>${esc(u.model)}</td><td><span class="pill ${u.outcome === 'ok' ? 'ok' : 'bad'}">${esc(u.outcome)}</span></td><td>${u.inputTokens}</td><td>${u.outputTokens}</td><td>${u.latencyMs}</td><td>$${u.costUsd.toFixed(4)}</td></tr>`)
    .join('');
  const eventRows = events
    .map((e) => `<tr class="ev-${esc(e.type.split('.')[0])}"><td>${esc(e.ts.slice(11, 19))}</td><td><code>${esc(e.type)}</code></td><td>${esc(e.agent ?? '')}</td><td>${esc(e.message)}</td></tr>`)
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Run ${esc(s.runId)}</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--card:#fff;--line:#e7e5e4;--ok:#15803d;--bad:#b91c1c;--warn:#b45309;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--card:#1c1917;--line:#292524;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--accent:#60a5fa}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;overflow-x:auto}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:16px}
.kpi b{display:block;font-size:18px;overflow-wrap:anywhere}.pill{padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid currentColor}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
svg .lbl,svg .val{fill:var(--fg);font-size:12px}svg .bar{fill:var(--accent)}
pre{white-space:pre-wrap;font-size:12px;max-height:480px;overflow:auto}
.ev-gate td,.ev-policy td,.ev-disagreement td,.ev-provider td,.ev-run td{font-weight:600}
</style></head><body><main>
<h1>${esc(s.artifacts.release?.title ?? 'Agent workflow run')}</h1>
<div class="muted">Run <code>${esc(s.runId)}</code> · scenario <code>${esc(s.scenario)}</code> · branch <code>${esc(s.branch)}</code></div>
<div class="kpis">
<div class="card kpi"><span class="muted">Status</span><b class="${statusClass}">${esc(s.status.replace(/_/g, ' '))}</b></div>
<div class="card kpi"><span class="muted">Iterations</span><b>${m.iterations}</b></div>
<div class="card kpi"><span class="muted">Model calls</span><b>${m.modelCalls}</b><span class="muted">${m.failedCalls} failed/rejected</span></div>
<div class="card kpi"><span class="muted">Est. cost${m.simulated ? ' (simulated)' : ''}</span><b>$${m.costUsd.toFixed(4)}</b></div>
<div class="card kpi"><span class="muted">Rubric</span><b>${m.score ?? '-'}${m.score !== null ? '/100' : ''}</b></div>
</div>
<p class="card">${esc(s.statusReason)}</p>
<h2>Gates per iteration</h2><div class="card"><table><tr><th>#</th><th>Gate</th><th>Tests</th><th>Coverage</th><th>SAST</th><th>Feedback to developer</th></tr>${gateRows}</table></div>
<h2>Estimated cost by agent</h2><div class="card"><svg width="100%" height="${agents.length * 30}" viewBox="0 0 640 ${agents.length * 30}" role="img" aria-label="Cost by agent">${costBars}</svg></div>
<h2>Timeline</h2><div class="card"><table><tr><th>Time</th><th>Event</th><th>Agent</th><th>Message</th></tr>${eventRows}</table></div>
<h2>Model usage (every attempt, including failures)</h2><div class="card"><table><tr><th>Task</th><th>Provider</th><th>Model</th><th>Outcome</th><th>In tok</th><th>Out tok</th><th>Latency ms</th><th>Cost</th></tr>${usageRows}</table></div>
<h2>Final diff (agent branch vs main)</h2><div class="card"><pre>${esc(s.artifacts.finalDiff ?? 'No diff: run did not reach evaluation.')}</pre></div>
</main></body></html>`;
}

function sum<K extends keyof UsageRecord>(rows: UsageRecord[], k: K): number {
  return rows.reduce((s, r) => s + (r[k] as number), 0);
}
function round(n: number, d: number): number {
  return Math.round(n * 10 ** d) / 10 ** d;
}
