// Deterministic offline provider. It plays back scripted responses for "creative" tasks
// (requirements analysis, design, code) and derives "judgement" tasks (QA review, security
// review, release notes) from the evidence it is given, the way a model would.
// Faults from the scenario are injected here so every failure path can be demonstrated
// without an API key or network access.
import type { Fault, Scenario } from '../scenarios.ts';
import { loadResponseFixture, readFixtureText } from '../scenarios.ts';
import { ProviderError, type LlmProvider, type LlmRequest, type LlmResponse } from './provider.ts';
import type { CheckResults, SecurityFinding } from '../types.ts';

export interface MockFaultState {
  remaining: Map<Fault, number>;
  activated: Set<Fault>;
  deviationReviews: number;
}

export function createFaultState(scenario: Scenario, resumeCount: number): MockFaultState {
  const remaining = new Map<Fault, number>();
  for (const f of scenario.faults) {
    if (f.type === 'unavailable' && f.firstRunOnly && resumeCount > 0) continue;
    remaining.set(f, f.times);
  }
  return { remaining, activated: new Set(), deviationReviews: 0 };
}

export class MockProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  private readonly role: 'primary' | 'secondary';
  private readonly scenario: Scenario;
  private readonly faults: MockFaultState;

  constructor(role: 'primary' | 'secondary', model: string, scenario: Scenario, faults: MockFaultState) {
    this.role = role;
    this.name = `mock-${role}`;
    this.model = model;
    this.scenario = scenario;
    this.faults = faults;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const fault = this.matchFault(req);
    if (fault?.type === 'unavailable') {
      throw new ProviderError(`503 overloaded_error from ${this.name} (injected outage)`, true, 503);
    }
    const text =
      fault?.type === 'respond'
        ? fault.payloadFile
          ? readFixtureText(fault.payloadFile)
          : (fault.payload ?? '')
        : this.respond(req);

    const inputTokens = Math.ceil((req.system.length + req.user.length) / 4);
    const outputTokens = Math.ceil(text.length / 4);
    const perToken = this.role === 'primary' ? 12 : 7;
    return {
      text,
      model: this.model,
      inputTokens,
      outputTokens,
      latencyMs: 450 + outputTokens * perToken,
      simulated: true,
    };
  }

  private matchFault(req: LlmRequest): Fault | undefined {
    for (const [fault, left] of this.faults.remaining) {
      if (left <= 0) continue;
      if (fault.type === 'unavailable' && fault.startAt && !this.faults.activated.has(fault)) {
        if (req.task !== fault.startAt) continue;
        this.faults.activated.add(fault);
      }
      if (fault.task && fault.task !== req.task) continue;
      const target = fault.provider ?? 'any';
      if (target !== 'any' && target !== this.role) continue;
      this.faults.remaining.set(fault, left - 1);
      return fault;
    }
    return undefined;
  }

  private respond(req: LlmRequest): string {
    const input = req.input as Record<string, unknown>;
    switch (req.task) {
      case 'qa.review':
        return JSON.stringify(qaReview(input.checks as CheckResults));
      case 'security.review':
        return JSON.stringify(securityReview(input.sast_findings as SecurityFinding[]));
      case 'architect.review_deviation': {
        const decisions = this.scenario.deviationDecisions ?? ['reject'];
        const decision = decisions[Math.min(this.faults.deviationReviews++, decisions.length - 1)];
        const dev = input.deviation as { path: string };
        return JSON.stringify(
          decision === 'accept'
            ? { decision, rationale: `Change to ${dev.path} is required by the acceptance criteria.`, amended_allowed_files: [dev.path] }
            : {
                decision,
                rationale: `${dev.path} is owned by the Finance platform team and ADR-2 keeps ledger entry types unchanged. Record partial refunds as REFUND entries with the refund id as reference; settlement already nets them correctly.`,
                amended_allowed_files: [],
              },
        );
      }
      case 'release.assemble':
        return JSON.stringify(releaseNotes(input));
      default: {
        const files = this.scenario.script[req.task];
        if (!files || files.length === 0) throw new ProviderError(`mock has no script for ${req.task}`, false);
        const idx = Math.min(Math.max(req.iteration, 1) - 1, files.length - 1);
        return loadResponseFixture(files[idx]);
      }
    }
  }
}

function qaReview(checks: CheckResults) {
  const failing = [...new Set(checks.tests.failures.map((f) => f.name.match(/AC-\d+/)?.[0] ?? f.name))];
  const problems: string[] = checks.tests.failures.map((f) => `Test "${f.name}" failed: ${f.message}`);
  if (!checks.coverage.ok) problems.push(`Line coverage ${checks.coverage.linePct}% is below ${checks.coverage.threshold}%.`);
  for (const l of checks.lint) problems.push(`${l.file}:${l.line} ${l.rule}: ${l.message}`);
  return {
    verdict: problems.length ? 'fail' : 'pass',
    failing_criteria: failing,
    feedback_for_developer: problems.length
      ? problems.join(' ')
      : `All ${checks.tests.total} tests pass, coverage ${checks.coverage.linePct}%, no lint issues.`,
  };
}

function securityReview(sast: SecurityFinding[]) {
  const blocking = sast.filter((f) => f.severity === 'critical' || f.severity === 'high');
  return {
    verdict: blocking.length ? 'block' : 'pass',
    findings: sast.map((f) => ({ ...f, source: 'sast' })),
    summary: blocking.length
      ? `Confirmed ${blocking.length} blocking finding(s): ${blocking.map((f) => f.title).join('; ')}.`
      : 'No blocking findings. Diff reviewed for PAN exposure, secrets, injection and authorisation.',
  };
}

function releaseNotes(input: Record<string, unknown>) {
  const files = (input.files_changed as string[]) ?? [];
  const checks = input.final_checks as CheckResults;
  const iterations = input.iterations as number;
  return {
    title: `REQ-101: partial refunds (${files.length} files)`,
    summary: `Adds partial refunds with cumulative-amount guard and idempotency keys. Converged in ${iterations} iteration(s).`,
    test_evidence: [
      `${checks.tests.passed}/${checks.tests.total} tests passed (regression, developer unit and QA acceptance suites)`,
      `Line coverage ${checks.coverage.linePct}% (threshold ${checks.coverage.threshold}%)`,
      `Static security scan: ${checks.sast.length} finding(s); lint: ${checks.lint.length} issue(s)`,
    ],
    known_risks: [
      'Idempotency index is in memory; it must move to the database before multi-instance deployment.',
      'Concurrent refunds on the same payment are not serialised (single-threaded sample service).',
    ],
    rollback_plan: 'Revert the merge commit; no schema or ledger entry-type changes were made, so no data migration is needed.',
    recommendation: 'approve',
  };
}
