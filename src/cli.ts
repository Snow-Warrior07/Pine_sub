#!/usr/bin/env node
// Command-line entry point.
//   node src/cli.ts demo [scenario]          run one scenario (default: 01-happy-path)
//   node src/cli.ts demo-all [--publish]     run every scenario and print a summary
//   node src/cli.ts run --scenario <id> [--provider mock|anthropic] [--run-id <id>]
//   node src/cli.ts run --requirement <file> --repo <dir> --provider anthropic
//   node src/cli.ts approve <runId> --by <name> [--note <text>]
//   node src/cli.ts reject  <runId> --by <name> --note <text>
//   node src/cli.ts resume  <runId> [--by <name> --guidance <decision>]   (guidance required for ESCALATED runs)
//   node src/cli.ts status  [runId]
//   node src/cli.ts scenarios
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Orchestrator } from './orchestrator.ts';
import { RunStore } from './state/store.ts';
import { ROOT, listScenarios, loadScenario, type Scenario } from './scenarios.ts';
import { computeMetrics } from './report/report.ts';
import type { RunState } from './types.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    scenario: { type: 'string' },
    provider: { type: 'string', default: process.env.AEO_PROVIDER ?? 'mock' },
    'run-id': { type: 'string' },
    requirement: { type: 'string' },
    repo: { type: 'string' },
    by: { type: 'string' },
    note: { type: 'string', default: '' },
    guidance: { type: 'string' },
    publish: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
});

const [command = 'help', ...rest] = positionals;
const store = new RunStore(resolve(process.env.AEO_RUNS_DIR ?? join(ROOT, 'runs')));
const provider = values.provider === 'anthropic' ? 'anthropic' : 'mock';
const print = values.quiet ? () => {} : (l: string) => console.log(l);

function orchestratorFor(scenario: Scenario) {
  return new Orchestrator({ store, provider, scenario, print, backoffBaseMs: provider === 'mock' ? 20 : 1000 });
}

function scenarioForRun(state: RunState): Scenario {
  try {
    return loadScenario(state.scenario);
  } catch {
    return adHocScenario(state.requirementPath, state.repoPath);
  }
}

function adHocScenario(requirement: string, repo: string): Scenario {
  return { id: 'ad-hoc', title: 'Ad-hoc requirement', demonstrates: [], description: '', requirement, repo, script: {}, faults: [], expect: { status: 'AWAITING_APPROVAL' } };
}

function newRunId(scenarioId: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${scenarioId.replace(/^\d+-/, '')}`;
}

function banner(text: string) {
  print('');
  print('═'.repeat(100));
  print(`  ${text}`);
  print('═'.repeat(100));
}

function summarise(s: RunState) {
  const m = computeMetrics(s);
  print('');
  print(`  Status      : ${s.status} - ${s.statusReason}`);
  print(`  Iterations  : ${m.iterations}   Model calls: ${m.modelCalls} (${m.failedCalls} failed/rejected)   Est. cost: $${m.costUsd.toFixed(4)}${m.simulated ? ' (simulated)' : ''}`);
  if (s.artifacts.evaluation) print(`  Rubric      : ${s.artifacts.evaluation.score}/${s.artifacts.evaluation.maxScore}`);
  print(`  Evidence    : ${join(store.runDir(s.runId), 'evidence.md')}`);
  print(`  Report      : ${join(store.runDir(s.runId), 'report.html')}`);
  if (s.status === 'AWAITING_APPROVAL') {
    print('');
    print(`  ▶ A human must decide:  npm run approve -- ${s.runId} --by "<name>" --note "<why>"`);
    print(`                          npm run reject  -- ${s.runId} --by "<name>" --note "<why>"`);
  }
  if (s.deployment) print(`  Deployed    : ${s.deployment.environment} at commit ${s.deployment.commit}, approved by ${s.approval?.by}`);
  if (s.status === 'PAUSED') print(`\n  ▶ Resume when the provider recovers:  npm run resume -- ${s.runId}`);
  if (s.status === 'ESCALATED' && s.escalation) {
    print('\n  ▶ Human decision needed. Options:');
    for (const o of s.escalation.options) print(`      - ${o}`);
    print(`    Continue with a decision:  npm run resume -- ${s.runId} --by "<name>" --guidance "<decision>"`);
    print(`    Or stop the run:           npm run reject -- ${s.runId} --by "<name>" --note "<why>"`);
  }
}

async function runScenario(id: string, runId?: string): Promise<RunState> {
  const scenario = loadScenario(id);
  banner(`${scenario.id}: ${scenario.title}`);
  print(`  ${scenario.description}`);
  print('');
  const state = await orchestratorFor(scenario).start(runId ?? newRunId(scenario.id));
  summarise(state);
  return state;
}

async function main() {
  switch (command) {
    case 'scenarios':
      for (const id of listScenarios()) {
        const s = loadScenario(id);
        console.log(`${id.padEnd(40)} ${s.title}`);
      }
      return;

    case 'demo': {
      await runScenario(rest[0] ?? values.scenario ?? '01-happy-path', values['run-id']);
      return;
    }

    case 'run': {
      if (values.requirement) {
        if (provider !== 'anthropic') throw new Error('Custom requirements need a real model: add --provider anthropic');
        const sc = adHocScenario(values.requirement, values.repo ?? 'sample-repo/payments-service');
        const state = await orchestratorFor(sc).start(values['run-id'] ?? newRunId('ad-hoc'));
        summarise(state);
        return;
      }
      await runScenario(values.scenario ?? '01-happy-path', values['run-id']);
      return;
    }

    case 'resume': {
      const runId = rest[0];
      if (!runId) throw new Error('usage: resume <runId>');
      const prior = store.load(runId);
      banner(`Resuming ${runId}`);
      const guidance = values.guidance ? { by: values.by ?? '', text: values.guidance } : undefined;
      const state = await orchestratorFor(scenarioForRun(prior)).resume(runId, guidance);
      summarise(state);
      return;
    }

    case 'approve':
    case 'reject': {
      const runId = rest[0];
      if (!runId || !values.by) throw new Error(`usage: ${command} <runId> --by <name> [--note <text>]`);
      const orch = orchestratorFor(scenarioForRun(store.load(runId)));
      const state = command === 'approve' ? orch.approve(runId, values.by, values.note ?? '') : orch.reject(runId, values.by, values.note ?? '');
      summarise(state);
      return;
    }

    case 'status': {
      const ids = rest[0] ? [rest[0]] : store.list();
      for (const id of ids) {
        const s = store.load(id);
        console.log(`${id.padEnd(48)} ${s.status.padEnd(18)} ${s.statusReason.slice(0, 90)}`);
      }
      return;
    }

    case 'demo-all':
      await demoAll();
      return;

    default:
      console.log('Commands: demo [scenario] | demo-all [--publish] | run | approve | reject | resume | status | scenarios');
      console.log('See README.md for details.');
  }
}

/** Runs every scenario, including the human steps a reviewer would take, and prints a summary. */
async function demoAll() {
  const rows: { id: string; expected: string; actual: string; ok: boolean; iterations: number; calls: number; cost: number; score: number | null }[] = [];
  for (const id of listScenarios()) {
    const scenario = loadScenario(id);
    const runId = `demo-${id}`;
    rmSync(store.runDir(runId), { recursive: true, force: true });
    let state = await runScenario(id, runId);
    const expectedFirst = scenario.expect.status;
    const firstOk = state.status === expectedFirst && (scenario.expect.iterations === undefined || state.artifacts.iterations.length === scenario.expect.iterations);

    if (state.status === 'PAUSED') {
      banner(`${id}: provider is back - resuming from checkpoint`);
      state = await orchestratorFor(scenario).resume(runId);
      summarise(state);
    }
    if (id === '10-disagreement-escalation' && state.status === 'ESCALATED') {
      banner(`${id}: a human answers the escalation`);
      state = await orchestratorFor(scenario).resume(runId, {
        by: 'Priya (Engineering Manager)',
        text: 'Side with the architect: keep ledger entry types unchanged (ADR-2). Use REFUND entries with the refund id as reference.',
      });
      summarise(state);
    }
    if (id === '01-happy-path' && state.status === 'AWAITING_APPROVAL') {
      banner(`${id}: human approval checkpoint`);
      const orch = orchestratorFor(scenario);
      state = orch.approve(runId, 'Release Manager (demo)', 'Evidence reviewed: all AC verified, no blocking findings');
      banner(`${id}: approval submitted a second time (double click / retry)`);
      state = orch.approve(runId, 'Release Manager (demo)', 'duplicate');
      summarise(state);
    }
    rows.push({ id, expected: expectedFirst, actual: state.status, ok: firstOk, iterations: state.artifacts.iterations.length, calls: state.usage.length, cost: computeMetrics(state).costUsd, score: state.artifacts.evaluation?.score ?? null });

    if (values.publish) {
      const out = join(ROOT, 'docs', 'sample-runs', id);
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
      for (const f of ['evidence.md', 'report.html', 'events.jsonl', 'metrics.json', 'state.json']) cpSync(join(store.runDir(runId), f), join(out, f));
    }
  }

  banner('Scenario summary');
  console.log('  ' + ['Scenario'.padEnd(38), 'Expected'.padEnd(18), 'Final'.padEnd(18), 'Iter', 'Calls', 'Cost($)', 'Score', 'OK'].join(' '));
  for (const r of rows) {
    console.log('  ' + [r.id.padEnd(38), r.expected.padEnd(18), r.actual.padEnd(18), String(r.iterations).padEnd(4), String(r.calls).padEnd(5), r.cost.toFixed(4).padEnd(7), String(r.score ?? '-').padEnd(5), r.ok ? '✔' : '✘'].join(' '));
  }
  const failed = rows.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n${failed.length} scenario(s) did not behave as expected: ${failed.map((f) => f.id).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
