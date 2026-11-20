// Guardrails and limits. Every loop in the workflow is bounded by one of these numbers.

export const LIMITS = {
  /** Developer -> QA/Security -> Developer loops before a human is pulled in. */
  maxImplementationIterations: 3,
  /** Architect/Developer negotiation rounds per iteration before escalation. */
  maxDeviationRounds: 1,
  /** Transient-error retries per provider per call. */
  maxProviderRetries: 2,
  /** Re-prompts when a model returns malformed or schema-invalid output. */
  maxRepairAttempts: 2,
  /** Consecutive failures that open a provider's circuit breaker. */
  circuitBreakerThreshold: 3,
  /** Hard cap on model calls in one run (stops runaway loops). */
  maxModelCallsPerRun: 40,
  /** Hard cap on estimated spend per run, USD. */
  maxCostUsdPerRun: 2.0,
  /** Test process wall-clock limit. */
  testTimeoutMs: 60_000,
  /** Minimum line coverage of src/ for the quality gate. */
  coverageThresholdPct: 80,
  /** Largest diff a single run may produce (lines added + removed). */
  maxDiffLines: 400,
};

/** Paths no agent may ever write, whatever the architect allows. */
export const PROTECTED_PATHS = [
  '.git/',
  '.github/',
  'config/',
  'package.json',
  'package-lock.json',
  'test/acceptance/', // owned by the QA agent; the developer cannot weaken its own exam
];

/** Directories the developer agent may write into at all (further narrowed by the design). */
export const WRITABLE_ROOTS = ['src/', 'test/'];

/** USD per million tokens. Mock calls are priced as if they were these models. */
export const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

export const MODELS = {
  primary: process.env.AEO_PRIMARY_MODEL ?? 'claude-opus-5-5',
  secondary: process.env.AEO_SECONDARY_MODEL ?? 'claude-sonnet-5-5',
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? PRICING['claude-opus-5-5'];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
