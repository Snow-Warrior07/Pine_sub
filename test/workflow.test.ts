// End-to-end: every scenario through the real orchestrator, workspace, git and test runner
// (mock model provider only). Also covers the human approval, rejection and resume paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.ts';
import { RunStore } from '../src/state/store.ts';
import { listScenarios, loadScenario } from '../src/scenarios.ts';
import { Workspace } from '../src/tools/workspace.ts';

const store = new RunStore(mkdtempSync(join(tmpdir(), 'aeo-runs-')));
const orch = (id: string) => new Orchestrator({ store, provider: 'mock', scenario: loadScenario(id), print: () => {}, backoffBaseMs: 0 });

for (const id of listScenarios()) {
  test(`scenario ${id} reaches its expected state`, async () => {
    const sc = loadScenario(id);
    const state = await orch(id).start(`t-${id}`);
    assert.equal(state.status, sc.expect.status, state.statusReason);
    if (sc.expect.iterations !== undefined) assert.equal(state.artifacts.iterations.length, sc.expect.iterations);
    // main is never touched before approval
    const ws = new Workspace(state.workspace, state.branch);
    assert.equal(ws.git('log', '--oneline', 'main').split('\n').length, 1);
  });
}

test('minimum demo: one failed check, then approval merges exactly once', async () => {
  const id = '01-happy-path';
  const s = await orch(id).start('t-approve');
  assert.equal(s.artifacts.iterations[0].gate, 'fail');
  assert.match(s.artifacts.iterations[0].feedback.join(' '), /AC-2/);
  assert.equal(s.artifacts.iterations[1].gate, 'pass');
  assert.ok((s.artifacts.evaluation?.score ?? 0) >= 90);

  assert.throws(() => orch(id).approve('t-approve', 'developer', 'self-approval'), /named human/);
  const approved = orch(id).approve('t-approve', 'Asha', 'reviewed');
  assert.equal(approved.status, 'DEPLOYED');
  orch(id).approve('t-approve', 'Asha', 'double click');
  const ws = new Workspace(approved.workspace, approved.branch);
  const merges = ws.git('log', '--merges', '--oneline', 'main').split('\n').filter(Boolean);
  assert.equal(merges.length, 1, 'second approval must not merge again');
  const evidence = readFileSync(join(store.runDir('t-approve'), 'evidence.md'), 'utf8');
  assert.match(evidence, /approved by \*\*Asha\*\*/);
});

test('rejection leaves main untouched', async () => {
  const s = await orch('01-happy-path').start('t-reject');
  const rejected = orch('01-happy-path').reject('t-reject', 'Asha', 'needs refund window');
  assert.equal(rejected.status, 'REJECTED');
  assert.throws(() => orch('01-happy-path').approve('t-reject', 'Asha', ''), /nothing to approve/);
  const ws = new Workspace(s.workspace, s.branch);
  assert.equal(ws.git('log', '--oneline', 'main').split('\n').length, 1);
});

test('security gate blocks a critical finding even though other checks pass', async () => {
  const s = await orch('04-security-critical').start('t-sec');
  const first = s.artifacts.iterations[0];
  assert.equal(first.gate, 'fail');
  assert.ok(first.checks!.sast.some((f) => f.id === 'PCI-001' && f.severity === 'critical'));
  assert.equal(first.security!.verdict, 'block');
});

test('paused run resumes from its checkpoint without repeating completed work', async () => {
  const id = '07-provider-outage-resume';
  const paused = await orch(id).start('t-resume');
  assert.equal(paused.status, 'PAUSED');
  assert.deepEqual(paused.completedSteps, ['intake', 'analysis', 'inspection', 'architecture', 'test_authoring']);
  const resumed = await orch(id).resume('t-resume');
  assert.equal(resumed.status, 'AWAITING_APPROVAL');
  const okCalls = (task: string) => resumed.usage.filter((u) => u.agent === task && u.outcome === 'ok').length;
  assert.equal(okCalls('analyst.clarify'), 1, 'analysis not repeated');
  assert.equal(okCalls('architect.design'), 1, 'design not repeated');
  const ws = new Workspace(resumed.workspace, resumed.branch);
  const qaCommits = ws.git('log', '--oneline', '--grep', '^qa:').split('\n').filter(Boolean);
  assert.equal(qaCommits.length, 1, 'acceptance tests committed once');
});

test('escalated run continues only with a named human decision', async () => {
  const id = '10-disagreement-escalation';
  const s = await orch(id).start('t-guidance');
  assert.equal(s.status, 'ESCALATED');
  assert.equal((await orch(id).resume('t-guidance')).status, 'ESCALATED', 'no guidance: stays escalated');
  const resumed = await orch(id).resume('t-guidance', { by: 'Priya', text: 'Side with the architect' });
  assert.equal(resumed.status, 'AWAITING_APPROVAL');
  assert.equal(resumed.humanGuidance[0].by, 'Priya');
});

test('every model attempt is accounted for, including failures', async () => {
  const s = await orch('06-provider-failover').start('t-usage');
  const failed = s.usage.filter((u) => u.outcome === 'provider_error');
  assert.equal(failed.length, 3);
  assert.ok(s.usage.some((u) => u.provider === 'mock-secondary' && u.outcome === 'ok'));
  assert.ok(s.usage.every((u) => u.costUsd >= 0 && u.latencyMs >= 0));
});
