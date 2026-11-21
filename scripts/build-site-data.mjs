// Builds site/data/runs.json from the committed sample runs and scenario definitions.
// Usage: node scripts/build-site-data.mjs
import { readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const runsDir = join(root, 'docs', 'sample-runs');
const out = join(root, 'site', 'data');
mkdirSync(out, { recursive: true });

const skip = new Set(['step.started', 'step.completed']);
const runs = [];

for (const id of readdirSync(runsDir).filter((d) => /^\d/.test(d)).sort()) {
  const scenario = JSON.parse(readFileSync(join(root, 'scenarios', `${id}.scenario.json`), 'utf8'));
  const metrics = JSON.parse(readFileSync(join(runsDir, id, 'metrics.json'), 'utf8'));
  const lines = readFileSync(join(runsDir, id, 'events.jsonl'), 'utf8').trim().split('\n');
  const t0 = Date.parse(JSON.parse(lines[0]).ts);
  const events = lines
    .map((l) => JSON.parse(l))
    .filter((e) => !skip.has(e.type))
    .map((e) => ({ t: Date.parse(e.ts) - t0, type: e.type, agent: e.agent ?? null, step: e.step ?? null, message: e.message }));

  runs.push({
    id,
    title: scenario.title,
    demonstrates: scenario.demonstrates ?? null,
    description: scenario.description,
    expect: scenario.expect,
    metrics: {
      status: metrics.status,
      iterations: metrics.iterations,
      modelCalls: metrics.modelCalls,
      failedCalls: metrics.failedCalls,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      costUsd: metrics.costUsd,
      score: metrics.score ?? null,
      byAgent: metrics.byAgent,
      byProvider: metrics.byProvider,
      gates: metrics.gates,
    },
    events,
  });
  copyFileSync(join(runsDir, id, 'report.html'), join(root, 'site', 'reports', `${id}.html`));
}

writeFileSync(join(out, 'runs.json'), JSON.stringify(runs));

// Static inspection of the sample repository, sent to the architect in the live demo.
const state = JSON.parse(readFileSync(join(runsDir, '01-happy-path', 'state.json'), 'utf8'));
writeFileSync(join(out, 'inspection.json'), JSON.stringify(state.artifacts.inspection));
console.log(`Wrote ${runs.length} runs to site/data/runs.json`);
