// Scores the agent's final change against a fixed rubric and against a human-written
// baseline solution run through exactly the same checks.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from '../config.ts';
import { SCENARIO_DIR } from '../scenarios.ts';
import { runTests } from '../tools/checks.ts';
import { Workspace } from '../tools/workspace.ts';
import type { Evaluation, RunState } from '../types.ts';

const BASELINE_FILES: Record<string, string> = {
  'src/payments.js': 'payments.js',
  'src/refunds.js': 'refunds.js',
  'test/refunds.test.js': 'refunds.test.js',
};

async function measureBaseline(ws: Workspace, acceptancePath: string | undefined): Promise<Evaluation['baseline']> {
  const dir = mkdtempSync(join(tmpdir(), 'aeo-baseline-'));
  try {
    // Start from main (the untouched repository) plus the QA acceptance tests.
    const target = join(dir, 'repo');
    ws.git('clone', '-q', '--branch', 'main', ws.dir, target);
    const mainWs = new Workspace(target, 'baseline-solution');
    mainWs.git('checkout', '-q', '-b', 'baseline-solution');
    if (acceptancePath) {
      const content = ws.read(acceptancePath);
      if (content) mainWs.write([{ path: acceptancePath, action: 'create', content }]);
      mainWs.commit('acceptance tests');
    }
    const before = mainWs.head();
    for (const [target, src] of Object.entries(BASELINE_FILES)) {
      writeFileSync(join(mainWs.dir, target), readFileSync(join(SCENARIO_DIR, 'fixtures', 'baseline', src)));
    }
    mainWs.commit('baseline solution');
    const numstat = mainWs.git('diff', '--numstat', `${before}..HEAD`);
    const lines = numstat.split('\n').filter(Boolean).map((l) => l.split('\t'));
    const { tests } = await runTests(mainWs.dir);
    return {
      linesChanged: lines.reduce((s, [a, r]) => s + Number(a) + Number(r), 0),
      testsPassed: tests.passed,
      filesTouched: lines.length,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function evaluateRun(state: RunState, ws: Workspace): Promise<Evaluation> {
  const last = state.artifacts.iterations.at(-1)!;
  const checks = last.checks!;
  const acs = state.artifacts.analysis!.acceptance_criteria.map((a) => a.id);
  const covered = new Set(state.artifacts.qaTests?.criteria_covered ?? []);
  const failingAc = new Set(checks.tests.failures.map((f) => f.name.match(/AC-\d+/)?.[0]).filter(Boolean));
  const verified = acs.filter((id) => covered.has(id) && !failingAc.has(id));

  // Candidate size excludes the QA acceptance tests (they are not the developer's change).
  const acceptance = state.artifacts.qaTests?.test_file;
  const numstat = ws.git('diff', '--numstat', 'main...HEAD').split('\n').filter(Boolean).map((l) => l.split('\t'));
  const devLines = numstat.filter(([, , f]) => f !== acceptance);
  const candidate = {
    linesChanged: devLines.reduce((s, [a, r]) => s + Number(a) + Number(r), 0),
    testsPassed: checks.tests.passed,
    filesTouched: devLines.length,
  };
  const baseline = await measureBaseline(ws, acceptance);

  const blocking = [...checks.sast, ...(last.security?.findings ?? [])].filter((f) => f.severity === 'critical' || f.severity === 'high');
  const touched = new Set(devLines.map(([, , f]) => f));
  const outOfScope = [...touched].filter((f) => !state.artifacts.design!.allowed_files.includes(f));
  const sizeRatio = baseline.linesChanged ? candidate.linesChanged / baseline.linesChanged : 1;
  const iterations = state.artifacts.iterations.length;

  const criteria: Evaluation['criteria'] = [
    { name: 'Acceptance criteria verified by passing tests', max: 30, points: Math.round((30 * verified.length) / acs.length), detail: `${verified.length}/${acs.length} (${verified.join(', ')})` },
    { name: 'Full test suite green', max: 20, points: checks.tests.failed === 0 && checks.tests.total > 0 ? 20 : 0, detail: `${checks.tests.passed}/${checks.tests.total} passed` },
    { name: 'No critical/high security findings', max: 15, points: blocking.length === 0 ? 15 : 0, detail: `${blocking.length} blocking, ${checks.sast.length} total` },
    { name: 'Stayed within the design scope', max: 10, points: outOfScope.length === 0 ? 10 : 0, detail: outOfScope.length ? `out of scope: ${outOfScope.join(', ')}` : `${touched.size} file(s), all allowed` },
    { name: `Coverage >= ${LIMITS.coverageThresholdPct}%`, max: 10, points: checks.coverage.ok ? 10 : 0, detail: `${checks.coverage.linePct}%` },
    { name: 'Change size vs human baseline', max: 10, points: sizeRatio <= 1.5 ? 10 : sizeRatio <= 2.5 ? 5 : 0, detail: `${candidate.linesChanged} vs ${baseline.linesChanged} lines (${sizeRatio.toFixed(2)}x)` },
    { name: 'Iterations to converge', max: 5, points: iterations === 1 ? 5 : iterations === 2 ? 3 : 1, detail: `${iterations} of ${LIMITS.maxImplementationIterations}` },
  ];
  return {
    score: criteria.reduce((s, c) => s + c.points, 0),
    maxScore: criteria.reduce((s, c) => s + c.max, 0),
    criteria,
    baseline,
    candidate,
  };
}
