// The orchestrator is a deterministic state machine. Models produce proposals; this code
// decides what happens next, enforces every limit, persists a checkpoint after every step
// and stops at the human approval gate.
import { join, resolve } from 'node:path';
import { LIMITS, MODELS } from './config.ts';
import { ModelGateway, AgentOutputError, BudgetExceededError, ProvidersUnavailableError } from './llm/gateway.ts';
import { MockProvider, createFaultState } from './llm/mockProvider.ts';
import { AnthropicProvider } from './llm/anthropicProvider.ts';
import type { LlmProvider } from './llm/provider.ts';
import { RunStore } from './state/store.ts';
import { Workspace } from './tools/workspace.ts';
import { ActionLedger, checkChangeScope, hashChangeset, sanitiseAllowedFiles } from './tools/policy.ts';
import { runAllChecks } from './tools/checks.ts';
import { inspectRepo } from './tools/repoInspector.ts';
import { evaluateRun } from './eval/rubric.ts';
import { writeReports } from './report/report.ts';
import { ROOT, type Scenario } from './scenarios.ts';
import { readFileSync } from 'node:fs';
import type {
  AnalystOutput,
  ArchitectOutput,
  DeveloperOutput,
  DeviationReviewOutput,
  IterationRecord,
  QaReviewOutput,
  QaTestsOutput,
  ReleaseOutput,
  RunState,
  SecurityFinding,
  SecurityReviewOutput,
  StepName,
  WorkflowEvent,
} from './types.ts';

export class Escalation extends Error {
  readonly options: string[];
  readonly context: Record<string, unknown>;
  constructor(reason: string, options: string[], context: Record<string, unknown> = {}) {
    super(reason);
    this.name = 'Escalation';
    this.options = options;
    this.context = context;
  }
}

export interface OrchestratorOptions {
  store: RunStore;
  provider: 'mock' | 'anthropic';
  scenario: Scenario;
  backoffBaseMs?: number;
  print?: (line: string) => void;
}

const STEPS: StepName[] = ['intake', 'analysis', 'inspection', 'architecture', 'test_authoring', 'implementation', 'evaluation', 'release'];
const AGENT_NAMES = new Set(['analyst', 'architect', 'developer', 'qa', 'security', 'release', 'orchestrator']);

interface Ctx {
  state: RunState;
  ws: Workspace;
  gateway: ModelGateway;
  ledger: ActionLedger;
}

export class Orchestrator {
  private readonly opts: OrchestratorOptions;
  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
  }

  // ------------------------------------------------------------------ lifecycle

  async start(runId: string): Promise<RunState> {
    const sc = this.opts.scenario;
    const requirementPath = resolve(ROOT, sc.requirement);
    const runDir = this.opts.store.runDir(runId);
    const now = new Date().toISOString();
    const state: RunState = {
      runId,
      scenario: sc.id,
      requirementPath: sc.requirement,
      requirementText: readFileSync(requirementPath, 'utf8'),
      repoPath: sc.repo,
      workspace: join(runDir, 'workspace'),
      branch: `agent/${runId}`,
      status: 'RUNNING',
      statusReason: 'started',
      createdAt: now,
      updatedAt: now,
      completedSteps: [],
      resumeCount: 0,
      artifacts: { iterations: [] },
      usage: [],
      actionLedger: [],
      humanGuidance: [],
      iterationBudget: LIMITS.maxImplementationIterations,
    };
    this.opts.store.save(state);
    this.emit(state, 'run.started', `Run ${runId} started for scenario "${sc.title}"`, { scenario: sc.id });
    return this.drive(state);
  }

  async resume(runId: string, guidance?: { by: string; text: string }): Promise<RunState> {
    const state = this.opts.store.load(runId);
    if (state.status === 'ESCALATED') {
      if (!guidance?.text || !guidance.by || AGENT_NAMES.has(guidance.by.toLowerCase())) {
        this.say(`Run ${runId} is ESCALATED; resuming needs a human decision: --by <name> --guidance "<decision>"`);
        return state;
      }
      state.humanGuidance.push({ ...guidance, at: new Date().toISOString(), answering: state.escalation?.reason ?? '' });
      state.iterationBudget = state.artifacts.iterations.length + LIMITS.maxImplementationIterations;
      this.emit(state, 'human.guidance', `${guidance.by} answered the escalation: "${guidance.text}". Iteration budget reset to ${state.iterationBudget}.`);
      state.escalation = undefined;
    } else if (state.status !== 'PAUSED' && state.status !== 'FAILED') {
      this.say(`Run ${runId} is ${state.status}; only PAUSED, FAILED or ESCALATED runs can be resumed.`);
      return state;
    }
    state.resumeCount += 1;
    state.status = 'RUNNING';
    state.statusReason = `resumed (#${state.resumeCount})`;
    this.emit(state, 'run.resumed', `Resuming from checkpoint; completed steps: ${state.completedSteps.join(', ') || 'none'}`);
    return this.drive(state);
  }

  approve(runId: string, by: string, note: string): RunState {
    const state = this.opts.store.load(runId);
    if (!by || AGENT_NAMES.has(by.toLowerCase())) throw new Error('Approval must be given by a named human, not an agent');
    if (state.status === 'DEPLOYED') {
      this.emit(state, 'approval.duplicate', `Run already approved by ${state.approval?.by}; merge and deploy are not repeated`);
      this.opts.store.save(state);
      return state;
    }
    if (state.status !== 'AWAITING_APPROVAL') throw new Error(`Run ${runId} is ${state.status}; nothing to approve`);

    const ws = new Workspace(state.workspace, state.branch);
    const ledger = new ActionLedger(state.actionLedger);
    state.approval = { decision: 'approved', by, note, at: new Date().toISOString() };
    this.emit(state, 'approval.granted', `Approved by ${by}${note ? `: ${note}` : ''}`);

    const mergeKey = ActionLedger.key('merge', runId, state.branch);
    let commit = ws.head();
    if (!ledger.has(mergeKey)) {
      commit = ws.mergeToMain(`Merge ${state.branch}: ${state.artifacts.release?.title ?? state.runId} (approved by ${by})`);
      ledger.add(mergeKey);
      this.emit(state, 'merge.completed', `Merged ${state.branch} into main at ${commit}`);
    }
    const deployKey = ActionLedger.key('deploy', runId, commit);
    if (!ledger.has(deployKey)) {
      state.deployment = { at: new Date().toISOString(), environment: 'production (simulated)', commit, simulated: true };
      ledger.add(deployKey);
      this.emit(state, 'deploy.completed', `Deployment to production simulated for commit ${commit}`);
    }
    state.actionLedger = ledger.toJSON();
    state.status = 'DEPLOYED';
    state.statusReason = `approved by ${by}`;
    this.opts.store.save(state);
    writeReports(state, this.opts.store);
    return state;
  }

  reject(runId: string, by: string, note: string): RunState {
    const state = this.opts.store.load(runId);
    if (!by || AGENT_NAMES.has(by.toLowerCase())) throw new Error('Rejection must be given by a named human');
    if (!['AWAITING_APPROVAL', 'ESCALATED', 'PAUSED'].includes(state.status)) throw new Error(`Run ${runId} is ${state.status}; cannot reject`);
    state.approval = { decision: 'rejected', by, note, at: new Date().toISOString() };
    state.status = 'REJECTED';
    state.statusReason = `rejected by ${by}: ${note}`;
    this.emit(state, 'approval.rejected', `Rejected by ${by}: ${note}. Branch ${state.branch} kept for inspection; main untouched.`);
    this.opts.store.save(state);
    writeReports(state, this.opts.store);
    return state;
  }

  // ------------------------------------------------------------------ engine

  private async drive(state: RunState): Promise<RunState> {
    const ws = Workspace.create(resolve(ROOT, state.repoPath), state.workspace, state.branch);
    const ctx: Ctx = { state, ws, gateway: this.buildGateway(state), ledger: new ActionLedger(state.actionLedger) };

    try {
      for (const step of STEPS) {
        if (state.completedSteps.includes(step)) continue;
        this.emit(state, 'step.started', `Step ${step} started`, undefined, step);
        await this[step](ctx);
        state.completedSteps.push(step);
        state.actionLedger = ctx.ledger.toJSON();
        this.emit(state, 'step.completed', `Step ${step} completed`, undefined, step);
        this.opts.store.save(state);
      }
      state.status = 'AWAITING_APPROVAL';
      state.statusReason = 'All gates passed. Merge and deployment need human approval.';
      this.emit(state, 'approval.requested', state.statusReason);
    } catch (err) {
      this.handleFailure(state, err);
    }
    state.actionLedger = ctx.ledger.toJSON();
    this.opts.store.save(state);
    writeReports(state, this.opts.store);
    return state;
  }

  private handleFailure(state: RunState, err: unknown): void {
    if (err instanceof ProvidersUnavailableError) {
      state.status = 'PAUSED';
      state.statusReason = `Model providers unavailable: ${err.message}. State checkpointed; run "resume ${state.runId}" when service recovers.`;
      this.emit(state, 'run.paused', state.statusReason);
    } else if (err instanceof Escalation) {
      state.status = 'ESCALATED';
      state.statusReason = err.message;
      state.escalation = { reason: err.message, options: err.options, context: err.context };
      this.emit(state, 'run.escalated', `Escalated to a human: ${err.message}`, { options: err.options });
    } else if (err instanceof AgentOutputError || err instanceof BudgetExceededError) {
      state.status = 'ESCALATED';
      state.statusReason = err.message;
      state.escalation = { reason: err.message, options: ['Inspect the agent output in events.jsonl', 'Adjust the prompt or model and resume', 'Reject the run'], context: {} };
      this.emit(state, 'run.escalated', `Escalated to a human: ${err.message}`);
    } else {
      state.status = 'FAILED';
      state.statusReason = err instanceof Error ? err.message : String(err);
      this.emit(state, 'run.failed', `Unexpected failure: ${state.statusReason}`, { stack: err instanceof Error ? err.stack : undefined });
    }
  }

  private buildGateway(state: RunState): ModelGateway {
    let providers: LlmProvider[];
    if (this.opts.provider === 'anthropic') {
      providers = [new AnthropicProvider('anthropic-primary', MODELS.primary), new AnthropicProvider('anthropic-secondary', MODELS.secondary)];
    } else {
      const faults = createFaultState(this.opts.scenario, state.resumeCount);
      providers = [
        new MockProvider('primary', MODELS.primary, this.opts.scenario, faults),
        new MockProvider('secondary', MODELS.secondary, this.opts.scenario, faults),
      ];
    }
    return new ModelGateway(
      providers,
      {
        onUsage: (u) => state.usage.push(u),
        onEvent: (type, message, data) => this.emit(state, type, message, data),
        backoffBaseMs: this.opts.backoffBaseMs,
      },
      state.usage,
    );
  }

  // ------------------------------------------------------------------ steps

  private async intake({ state, ws }: Ctx): Promise<void> {
    this.emit(state, 'workspace.ready', `Sandbox workspace created; agent work isolated on branch ${state.branch} (main = baseline ${ws.git('rev-parse', '--short', 'main')})`);
  }

  private async analysis({ state, gateway }: Ctx): Promise<void> {
    const out = await gateway.call<AnalystOutput>('analyst.clarify', { requirement: state.requirementText });
    state.artifacts.analysis = out;
    this.emit(state, 'agent.output', `Analyst: ${out.acceptance_criteria.length} acceptance criteria, ${out.tasks.length} tasks, ${out.open_questions.length} open question(s)`, {
      acceptance_criteria: out.acceptance_criteria.map((a) => a.id),
    }, 'analysis', 'analyst');
    if (out.open_questions.length) {
      this.emit(state, 'human.question_recorded', `Open questions recorded for the approver (not blocking): ${out.open_questions.join(' | ')}`);
    }
  }

  private async inspection({ state, ws }: Ctx): Promise<void> {
    state.artifacts.inspection = inspectRepo(ws.dir, ws.listFiles(), state.requirementText);
    const top = state.artifacts.inspection.keywordHits.slice(0, 4).map((h) => `${h.path}(${h.keyword}×${h.count})`);
    this.emit(state, 'tool.output', `Repository inspected: ${state.artifacts.inspection.files.length} JS files; strongest keyword matches ${top.join(', ')}`);
  }

  private async architecture({ state, gateway }: Ctx): Promise<void> {
    const a = state.artifacts.analysis!;
    const out = await gateway.call<ArchitectOutput>('architect.design', {
      requirement: state.requirementText,
      acceptance_criteria: a.acceptance_criteria,
      repository: state.artifacts.inspection,
    });
    const { files, dropped } = sanitiseAllowedFiles(out.allowed_files);
    if (dropped.length) this.emit(state, 'policy.scope_narrowed', `Policy removed protected or out-of-root paths from the design scope: ${dropped.join(', ')}`);
    out.allowed_files = files;
    state.artifacts.design = out;
    this.emit(state, 'agent.output', `Architect: ${out.impacted_components.length} impacted components; developer scope = ${files.join(', ')}`, {
      forbidden: out.forbidden_files.map((f) => f.path),
    }, 'architecture', 'architect');
  }

  private async test_authoring({ state, gateway, ws, ledger }: Ctx): Promise<void> {
    const out = await gateway.call<QaTestsOutput>('qa.generate_tests', {
      acceptance_criteria: state.artifacts.analysis!.acceptance_criteria,
      api_contract: state.artifacts.design!.api_contract,
    });
    state.artifacts.qaTests = { ...out, content: `[${out.content.length} chars]` };
    const key = ActionLedger.key('qa-tests', state.runId, out.test_file, out.content);
    if (!ledger.has(key)) {
      ws.write([{ path: out.test_file, action: 'create', content: out.content }]);
      ws.commit(`qa: acceptance tests for ${out.criteria_covered.join(', ')}`);
      ledger.add(key);
    }
    const missing = state.artifacts.analysis!.acceptance_criteria.map((c) => c.id).filter((id) => !out.criteria_covered.includes(id));
    this.emit(state, 'agent.output', `QA wrote ${out.test_file} before any implementation, covering ${out.criteria_covered.join(', ')}${missing.length ? `; NOT covered: ${missing.join(', ')}` : ''}`, undefined, 'test_authoring', 'qa');
  }

  private async implementation(ctx: Ctx): Promise<void> {
    const { state, gateway, ws, ledger } = ctx;
    const design = state.artifacts.design!;
    const analysis = state.artifacts.analysis!;

    while (true) {
      const n = state.artifacts.iterations.length + 1;
      if (n > state.iterationBudget) {
        throw new Escalation(`Iteration budget exhausted: ${state.iterationBudget} implementation attempts did not pass all gates`, [
          'Take over the branch manually',
          'Clarify the requirement or design and start a new run',
          'Reject the run',
        ], { lastFeedback: state.artifacts.iterations.at(-1)?.feedback });
      }
      ws.resetToHead(); // never build on half-applied work from an interrupted iteration
      const prev = state.artifacts.iterations.at(-1);
      this.emit(state, 'iteration.started', `Iteration ${n}/${state.iterationBudget}`, undefined, 'implementation');

      const currentFiles = Object.fromEntries(design.allowed_files.map((f) => [f, ws.read(f)]).filter(([, c]) => c !== null));
      const dev = await gateway.call<DeveloperOutput>('developer.implement', {
        requirement: state.requirementText,
        acceptance_criteria: analysis.acceptance_criteria,
        design,
        allowed_files: design.allowed_files,
        current_files: currentFiles,
        acceptance_tests: state.artifacts.qaTests?.test_file,
        feedback_from_previous_iteration: prev?.feedback ?? [],
        human_guidance: state.humanGuidance.map((g) => `${g.by}: ${g.text}`),
      }, n);

      const record: IterationRecord = {
        n,
        developerSummary: dev.summary,
        filesChanged: dev.changes.map((c) => c.path),
        changesetHash: hashChangeset(dev.changes),
        policyViolations: [],
        deviations: [],
        gate: 'fail',
        feedback: [],
      };
      this.emit(state, 'agent.output', `Developer: ${dev.summary} (${record.filesChanged.join(', ')})`, { hash: record.changesetHash }, 'implementation', 'developer');

      // 1. Disagreement: developer proposes changing the design; the architect decides (bounded).
      if (dev.design_deviations.length) {
        const rejected = await this.resolveDeviations(ctx, dev, record);
        if (rejected.length) {
          const persistent = rejected.filter((d) => prev?.deviations.some((p) => p.deviation.path === d.deviation.path && p.decision.decision === 'reject'));
          state.artifacts.iterations.push(record);
          this.opts.store.save(state);
          if (persistent.length) {
            throw new Escalation(`Architect and developer still disagree about ${persistent.map((d) => d.deviation.path).join(', ')} after ${LIMITS.maxDeviationRounds} round(s)`, [
              'Side with the architect: developer must implement within the design',
              'Side with the developer: amend the design and resume',
              'Ask the owning team (Finance platform) to decide',
            ], { developer: persistent.map((d) => d.deviation), architect: persistent.map((d) => d.decision) });
          }
          continue;
        }
      }


      // 2. Repeated action / no progress: the same change set again will fail the same way.
      const repeatOf = state.artifacts.iterations.find((it) => it.changesetHash === record.changesetHash);
      if (repeatOf) {
        record.gate = 'no_progress';
        record.feedback = [`Change set identical to iteration ${repeatOf.n}`];
        state.artifacts.iterations.push(record);
        this.emit(state, 'policy.repeat_detected', `Developer returned the identical change set as iteration ${repeatOf.n} (hash ${record.changesetHash}). Not re-applying or re-testing it.`);
        throw new Escalation(`No progress: developer repeated the change set from iteration ${repeatOf.n}`, [
          'Give the developer agent new guidance and resume',
          'Take over the branch manually',
          'Reject the run',
        ], { feedback: repeatOf.feedback });
      }

      // 3. Scope policy: only files the design allows; never protected paths.
      const scope = checkChangeScope(dev.changes, design.allowed_files);
      if (scope.violations.length) {
        record.gate = 'blocked_by_policy';
        record.policyViolations = scope.violations;
        record.feedback = [...scope.violations, `Only change: ${design.allowed_files.join(', ')}`];
        state.artifacts.iterations.push(record);
        this.emit(state, 'policy.violation', `Change set blocked before touching the workspace: ${scope.violations.join('; ')}`, undefined, 'implementation');
        this.opts.store.save(state);
        continue;
      }

      // 4. Apply exactly once (idempotent across retries and resumes) and commit on the agent branch.
      const applyKey = ActionLedger.key('apply', state.runId, record.changesetHash);
      if (ledger.has(applyKey)) {
        this.emit(state, 'action.duplicate_skipped', `Change set ${record.changesetHash} was already applied; skipping duplicate apply`);
      } else {
        ws.write(scope.allowed);
        const commit = ws.commit(`developer: iteration ${n} - ${dev.summary}`);
        ledger.add(applyKey);
        state.actionLedger = ledger.toJSON();
        this.emit(state, 'workspace.commit', `Applied ${scope.allowed.length} file(s) on ${state.branch} at ${commit}`);
      }

      // 5. Deterministic checks, then QA and security agents review the evidence in parallel.
      const stat = ws.diffStat();
      const checks = await runAllChecks(ws.dir, stat.files);
      record.checks = checks;
      this.emit(state, 'tool.output', `Checks: tests ${checks.tests.passed}/${checks.tests.total} passed, coverage ${checks.coverage.linePct}%, lint ${checks.lint.length}, SAST ${checks.sast.length}`, {
        failures: checks.tests.failures,
      }, 'implementation');

      const [qa, sec] = await Promise.all([
        gateway.call<QaReviewOutput>('qa.review', { acceptance_criteria: analysis.acceptance_criteria, checks }, n),
        gateway.call<SecurityReviewOutput>('security.review', { diff: ws.diffFromMain(), sast_findings: checks.sast }, n),
      ]);
      record.qa = qa;
      record.security = sec;

      // 6. Gate. Evidence decides; an agent saying "pass" cannot override a failing check.
      const testsOk = checks.tests.total > 0 && checks.tests.failed === 0 && !checks.tests.timedOut;
      const blocking = dedupeFindings([...checks.sast, ...sec.findings]).filter((f) => f.severity === 'critical' || f.severity === 'high');
      const diffOk = stat.added + stat.removed <= LIMITS.maxDiffLines;
      if (qa.verdict === 'pass' && !testsOk) this.emit(state, 'agent.claim_contradicted', 'QA agent reported pass but tests failed; the test result wins');
      if (sec.verdict === 'pass' && blocking.length) this.emit(state, 'agent.claim_contradicted', 'Security agent reported pass but the scanner found blocking issues; the scanner wins');

      const passed = testsOk && checks.coverage.ok && checks.lint.length === 0 && blocking.length === 0 && diffOk;
      record.gate = passed ? 'pass' : 'fail';
      if (!testsOk || !checks.coverage.ok || checks.lint.length) record.feedback.push(`QA: ${qa.feedback_for_developer}`);
      for (const f of blocking) record.feedback.push(`SECURITY ${f.severity.toUpperCase()} ${f.id} at ${f.file}:${f.line}: ${f.title}. ${f.recommendation}`);
      if (!diffOk) record.feedback.push(`Diff of ${stat.added + stat.removed} lines exceeds the ${LIMITS.maxDiffLines}-line limit; reduce the change.`);
      state.artifacts.iterations.push(record);

      if (blocking.length) {
        this.emit(state, 'gate.security_blocked', `Security gate BLOCKED: ${blocking.map((f) => `${f.severity} ${f.id} ${f.file}:${f.line}`).join('; ')}. Release cannot proceed; routed back to developer.`, undefined, 'implementation', 'security');
      }
      this.emit(state, passed ? 'gate.passed' : 'gate.failed', passed ? `Iteration ${n}: all gates green` : `Iteration ${n} failed: ${record.feedback.join(' | ')}`, undefined, 'implementation');
      this.opts.store.save(state);
      if (passed) return;
    }
  }

  private async resolveDeviations(ctx: Ctx, dev: DeveloperOutput, record: IterationRecord) {
    const { state, gateway } = ctx;
    const design = state.artifacts.design!;
    for (const deviation of dev.design_deviations) {
      this.emit(state, 'disagreement.raised', `Developer disagrees with the design: wants to change ${deviation.path} (${deviation.proposal}). Reason: ${deviation.justification}`, undefined, 'implementation', 'developer');
      const decision = await gateway.call<DeviationReviewOutput>('architect.review_deviation', { design, deviation, developer_summary: dev.summary }, record.n);
      record.deviations.push({ deviation, decision });
      if (decision.decision === 'accept') {
        const { files } = sanitiseAllowedFiles([...design.allowed_files, ...decision.amended_allowed_files]);
        design.allowed_files = files;
        this.emit(state, 'disagreement.resolved', `Architect accepted: ${decision.rationale}. Scope is now ${files.join(', ')}`, undefined, 'implementation', 'architect');
      } else {
        this.emit(state, 'disagreement.rejected', `Architect rejected the deviation: ${decision.rationale}`, undefined, 'implementation', 'architect');
      }
    }
    const rejected = record.deviations.filter((d) => d.decision.decision === 'reject');
    if (rejected.length) {
      record.gate = 'fail';
      record.feedback = rejected.map((d) => `Architect rejected your proposal for ${d.deviation.path}: ${d.decision.rationale} Implement within the design.`);
    }
    return rejected;
  }

  private async evaluation({ state, ws }: Ctx): Promise<void> {
    state.artifacts.evaluation = await evaluateRun(state, ws);
    state.artifacts.finalDiff = ws.diffFromMain();
    const e = state.artifacts.evaluation;
    this.emit(state, 'eval.scored', `Rubric score ${e.score}/${e.maxScore} (baseline: ${e.baseline.linesChanged} lines, candidate: ${e.candidate.linesChanged} lines)`);
  }

  private async release({ state, gateway, ws }: Ctx): Promise<void> {
    const last = state.artifacts.iterations.at(-1)!;
    const out = await gateway.call<ReleaseOutput>('release.assemble', {
      requirement: state.requirementText,
      acceptance_criteria: state.artifacts.analysis!.acceptance_criteria,
      files_changed: ws.diffStat().files,
      final_checks: last.checks,
      security: last.security,
      iterations: state.artifacts.iterations.length,
      evaluation: state.artifacts.evaluation,
      open_questions: state.artifacts.analysis!.open_questions,
    });
    state.artifacts.release = out;
    this.emit(state, 'agent.output', `Release: evidence pack assembled, agent recommends "${out.recommendation}". Waiting for a human.`, undefined, 'release', 'release');
  }

  // ------------------------------------------------------------------ observability

  private emit(state: RunState, type: string, message: string, data?: Record<string, unknown>, step?: string, agent?: string): void {
    const event: WorkflowEvent = { ts: new Date().toISOString(), runId: state.runId, type, step, agent, message, data };
    this.opts.store.append(event);
    this.say(formatEvent(event));
  }

  private say(line: string): void {
    (this.opts.print ?? console.log)(line);
  }
}

function dedupeFindings(findings: SecurityFinding[]): SecurityFinding[] {
  const seen = new Map<string, SecurityFinding>();
  for (const f of findings) {
    const key = `${f.id}|${f.file}|${f.line}`;
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()];
}

const ICONS: Record<string, string> = {
  'gate.passed': '✅',
  'gate.failed': '❌',
  'gate.security_blocked': '🛑',
  'policy.violation': '🚫',
  'policy.repeat_detected': '🔁',
  'provider.retry': '⏳',
  'provider.failover': '🔀',
  'agent.output_rejected': '⚠️ ',
  'disagreement.raised': '⚔️ ',
  'disagreement.rejected': '🏛️ ',
  'disagreement.resolved': '🤝',
  'run.paused': '⏸️ ',
  'run.escalated': '🙋',
  'human.guidance': '🧭',
  'approval.requested': '🧑‍⚖️',
  'approval.granted': '✍️ ',
  'deploy.completed': '🚀',
};

export function formatEvent(e: WorkflowEvent): string {
  const t = e.ts.slice(11, 19);
  const icon = ICONS[e.type] ?? '  ';
  const who = (e.agent ?? '').padEnd(9);
  return `${t} ${icon} ${who} ${e.message}`;
}
