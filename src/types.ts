// Shared types for the workflow. Every agent has an explicit input and output contract;
// the output contracts are enforced at runtime by the schemas in src/agents/schemas.ts.

export type AgentRole = 'analyst' | 'architect' | 'developer' | 'qa' | 'security' | 'release';

// ---------- Agent outputs (the hand-off contracts) ----------

export interface AcceptanceCriterion {
  id: string; // "AC-1"
  given: string;
  when: string;
  then: string;
}

export interface PlannedTask {
  id: string; // "T-1"
  title: string;
  owner_agent: AgentRole;
  depends_on: string[];
}

export interface AnalystOutput {
  summary: string;
  acceptance_criteria: AcceptanceCriterion[];
  tasks: PlannedTask[];
  assumptions: string[];
  open_questions: string[];
  out_of_scope: string[];
}

export interface ImpactedComponent {
  path: string;
  change_type: 'create' | 'modify' | 'read_only';
  reason: string;
}

export interface ArchitectOutput {
  impacted_components: ImpactedComponent[];
  approach: string;
  api_contract: string[];
  allowed_files: string[];
  forbidden_files: { path: string; reason: string }[];
  decisions: { id: string; decision: string; rationale: string }[];
  risks: string[];
}

export interface FileChange {
  path: string;
  action: 'create' | 'modify';
  content: string;
}

export interface DesignDeviation {
  path: string;
  proposal: string;
  justification: string;
}

export interface DeveloperOutput {
  summary: string;
  changes: FileChange[];
  design_deviations: DesignDeviation[];
  tests_added: string[];
}

export interface DeviationReviewOutput {
  decision: 'accept' | 'reject';
  rationale: string;
  amended_allowed_files: string[];
}

export interface QaTestsOutput {
  test_file: string;
  content: string;
  criteria_covered: string[];
}

export interface QaReviewOutput {
  verdict: 'pass' | 'fail';
  failing_criteria: string[];
  feedback_for_developer: string;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface SecurityFinding {
  id: string;
  severity: Severity;
  file: string;
  line: number;
  title: string;
  recommendation: string;
  source?: 'sast' | 'agent';
}

export interface SecurityReviewOutput {
  verdict: 'pass' | 'block';
  findings: SecurityFinding[];
  summary: string;
}

export interface ReleaseOutput {
  title: string;
  summary: string;
  test_evidence: string[];
  known_risks: string[];
  rollback_plan: string;
  recommendation: 'approve' | 'reject';
}

// ---------- Tool results (deterministic, produced by code, not by models) ----------

export interface TestResult {
  passed: number;
  failed: number;
  total: number;
  failures: { name: string; message: string }[];
  durationMs: number;
  timedOut: boolean;
  rawTail: string;
}

export interface CoverageResult {
  linePct: number;
  threshold: number;
  ok: boolean;
}

export interface LintIssue {
  file: string;
  line: number;
  rule: string;
  message: string;
}

export interface CheckResults {
  tests: TestResult;
  coverage: CoverageResult;
  lint: LintIssue[];
  sast: SecurityFinding[];
}

// ---------- Workflow state ----------

export type RunStatus =
  | 'RUNNING'
  | 'PAUSED' // waiting for an external condition (e.g. model provider outage); resumable
  | 'ESCALATED' // automation stopped; a human must decide
  | 'AWAITING_APPROVAL' // all gates green; waiting for a human to approve merge + deploy
  | 'DEPLOYED'
  | 'REJECTED'
  | 'FAILED';

export type StepName =
  | 'intake'
  | 'analysis'
  | 'inspection'
  | 'architecture'
  | 'test_authoring'
  | 'implementation'
  | 'evaluation'
  | 'release';

export interface IterationRecord {
  n: number;
  developerSummary: string;
  filesChanged: string[];
  changesetHash: string;
  policyViolations: string[];
  deviations: { deviation: DesignDeviation; decision: DeviationReviewOutput }[];
  checks?: CheckResults;
  qa?: QaReviewOutput;
  security?: SecurityReviewOutput;
  gate: 'pass' | 'fail' | 'blocked_by_policy' | 'no_progress';
  feedback: string[];
}

export interface Approval {
  decision: 'approved' | 'rejected';
  by: string;
  note: string;
  at: string;
}

export interface RunState {
  runId: string;
  scenario: string;
  requirementPath: string;
  requirementText: string;
  repoPath: string;
  workspace: string;
  branch: string;
  status: RunStatus;
  statusReason: string;
  createdAt: string;
  updatedAt: string;
  completedSteps: StepName[];
  resumeCount: number;
  artifacts: {
    analysis?: AnalystOutput;
    inspection?: RepoInspection;
    design?: ArchitectOutput;
    qaTests?: QaTestsOutput;
    iterations: IterationRecord[];
    evaluation?: Evaluation;
    release?: ReleaseOutput;
    finalDiff?: string;
  };
  approval?: Approval;
  deployment?: { at: string; environment: string; commit: string; simulated: true };
  usage: UsageRecord[];
  actionLedger: string[]; // idempotency keys of side effects already performed
  escalation?: { reason: string; options: string[]; context: Record<string, unknown> };
  /** Decisions a human gave when answering an escalation; passed to the developer agent. */
  humanGuidance: { by: string; text: string; at: string; answering: string }[];
  /** Iteration cap; grows by LIMITS.maxImplementationIterations only when a human answers an escalation. */
  iterationBudget: number;
}

export interface RepoInspection {
  files: { path: string; lines: number; exports: string[]; imports: string[] }[];
  keywordHits: { path: string; keyword: string; count: number }[];
  dependents: Record<string, string[]>; // file -> files that import it
}

export interface UsageRecord {
  at: string;
  agent: string; // "developer.implement"
  provider: string;
  model: string;
  attempt: number;
  outcome: 'ok' | 'invalid_output' | 'provider_error' | 'circuit_open';
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  simulated: boolean;
  error?: string;
}

export interface Evaluation {
  score: number;
  maxScore: number;
  criteria: { name: string; points: number; max: number; detail: string }[];
  baseline: { linesChanged: number; testsPassed: number; filesTouched: number };
  candidate: { linesChanged: number; testsPassed: number; filesTouched: number };
}

export interface WorkflowEvent {
  ts: string;
  runId: string;
  type: string;
  step?: string;
  agent?: string;
  message: string;
  data?: Record<string, unknown>;
}
