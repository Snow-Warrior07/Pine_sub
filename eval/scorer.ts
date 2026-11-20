// LLM-as-judge scorer for ZeroDayOS eval pipeline.
// Scores each pipeline output on 5 dimensions (0–2 each, max 10 total).
// Also runs rule-based checks against fixture expectations.

import { chatJSON } from "../src/llm.js";
import type { AnalystOutput, ValidatorOutput, RemediationOutput, ReporterOutput } from "../src/agents.js";
import type { EvalFixture } from "./fixtures.js";
import { SEVERITY_ORDER } from "./fixtures.js";
import type { LangfuseTraceClient } from "../src/langfuse.js";

export type DimensionScore = {
  dimension: string;
  score: number;     // 0 | 1 | 2
  max: number;       // always 2
  rationale: string;
};

export type EvalResult = {
  fixture_id: string;
  passed: boolean;          // true if all rule-based checks pass AND total_score >= threshold
  total_score: number;      // sum of dimension scores (max 10)
  max_score: number;        // 10
  dimensions: DimensionScore[];
  rule_failures: string[];  // empty if all rules pass
};

const THRESHOLD = 6; // out of 10 — minimum passing score

// ─── Rule-based checks (deterministic, fast) ─────────────────────────────────
function runRuleChecks(
  fixture: EvalFixture,
  analyst: AnalystOutput,
  validator: ValidatorOutput,
  remediation: RemediationOutput,
  reporter: ReporterOutput,
): string[] {
  const failures: string[] = [];
  const { expected } = fixture;

  // CWE match
  const cweMatch = expected.cwe_ids.some((cwe) =>
    analyst.cwe_id.includes(cwe) || analyst.reasoning?.includes(cwe)
  );
  if (!cweMatch) {
    failures.push(
      `CWE mismatch: expected one of [${expected.cwe_ids.join(", ")}], got "${analyst.cwe_id}"`
    );
  }

  // CVSS floor
  if (analyst.cvss_score < expected.min_cvss) {
    failures.push(
      `CVSS too low: expected >= ${expected.min_cvss}, got ${analyst.cvss_score}`
    );
  }

  // Severity floor
  const actualOrder   = SEVERITY_ORDER[analyst.severity] ?? 0;
  const expectedOrder = SEVERITY_ORDER[expected.severity_floor] ?? 0;
  if (actualOrder < expectedOrder) {
    failures.push(
      `Severity too low: expected >= ${expected.severity_floor}, got ${analyst.severity}`
    );
  }

  // Exploit reachability
  if (validator.exploit_reachable !== expected.exploit_reachable) {
    failures.push(
      `Exploit reachability mismatch: expected ${expected.exploit_reachable}, got ${validator.exploit_reachable}`
    );
  }

  // Patch content — at least ONE of the expected strings must appear
  const patchText = (remediation.patched_code + " " + remediation.code_diff).toLowerCase();
  const patchHit  = expected.patch_must_contain.some((s) => patchText.includes(s.toLowerCase()));
  if (!patchHit) {
    failures.push(
      `Patch missing expected content. At least one of [${expected.patch_must_contain.join(", ")}] must appear in patched_code/code_diff.`
    );
  }

  // Issue content — ALL required strings must appear
  const issueText = reporter.markdown.toLowerCase();
  for (const required of expected.issue_must_contain) {
    if (!issueText.includes(required.toLowerCase())) {
      failures.push(`Issue missing required content: "${required}"`);
    }
  }

  return failures;
}

// ─── LLM-as-judge scoring (5 dimensions × 2 points each) ────────────────────

const JUDGE_SYSTEM = `You are a senior security engineer evaluating an AI-generated vulnerability report.
Score each dimension from 0 to 2. Be strict — a score of 2 requires excellence, not just adequacy.

Scoring scale:
  0 = Missing, wrong, or dangerously misleading
  1 = Partially correct / present but incomplete or imprecise
  2 = Accurate, complete, and actionable

Dimensions:
1. analyst_accuracy    — Is the vulnerability correctly identified and classified? Is the CVSS justification sound?
2. validator_quality   — Does the validator's reachability assessment match the actual code? Is the evidence cited specific?
3. patch_correctness   — Does the patch actually fix the root cause? Is the diff clean and correct?
4. report_quality      — Is the GitHub Issue report professionally formatted, actionable, and complete?
5. overall_usefulness  — Would a senior security engineer accept this as a high-quality triage output without rework?

Output contract (STRICT): Return ONLY a single JSON object, no prose, no markdown fences.
Schema:
{
  "analyst_accuracy":   { "score": 0|1|2, "rationale": string },
  "validator_quality":  { "score": 0|1|2, "rationale": string },
  "patch_correctness":  { "score": 0|1|2, "rationale": string },
  "report_quality":     { "score": 0|1|2, "rationale": string },
  "overall_usefulness": { "score": 0|1|2, "rationale": string }
}`;

type JudgeOutput = Record<string, { score: number; rationale: string }>;

async function runLLMJudge(
  fixture: EvalFixture,
  analyst: AnalystOutput,
  validator: ValidatorOutput,
  remediation: RemediationOutput,
  reporter: ReporterOutput,
  trace?: LangfuseTraceClient,
): Promise<DimensionScore[]> {
  const user = `## Vulnerable Code (fixture: ${fixture.id})
\`\`\`
${fixture.snippet}
\`\`\`

## Analyst Output
${JSON.stringify(analyst, null, 2)}

## Validator Output
${JSON.stringify(validator, null, 2)}

## Remediation Output
${JSON.stringify({ fix_summary: remediation.fix_summary, patched_code: remediation.patched_code, code_diff: remediation.code_diff }, null, 2)}

## GitHub Issue (first 1500 chars)
${reporter.markdown.slice(0, 1500)}

Score each dimension.`;

  const judged = await chatJSON<JudgeOutput>({
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: user }],
    maxTokens: 800,
    trace,
    agentName: `Judge-${fixture.id}`,
  });

  const DIMENSION_NAMES = [
    "analyst_accuracy",
    "validator_quality",
    "patch_correctness",
    "report_quality",
    "overall_usefulness",
  ];

  return DIMENSION_NAMES.map((dim) => ({
    dimension: dim,
    score: Math.min(2, Math.max(0, Math.round(judged[dim]?.score ?? 0))),
    max: 2,
    rationale: judged[dim]?.rationale ?? "No rationale provided",
  }));
}

// ─── Main scorer entry point ──────────────────────────────────────────────────
export async function scoreRun(opts: {
  fixture: EvalFixture;
  analyst: AnalystOutput;
  validator: ValidatorOutput;
  remediation: RemediationOutput;
  reporter: ReporterOutput;
  trace?: LangfuseTraceClient;
}): Promise<EvalResult> {
  const { fixture, analyst, validator, remediation, reporter, trace } = opts;

  const [ruleFailures, dimensions] = await Promise.all([
    Promise.resolve(runRuleChecks(fixture, analyst, validator, remediation, reporter)),
    runLLMJudge(fixture, analyst, validator, remediation, reporter, trace),
  ]);

  const total = dimensions.reduce((sum, d) => sum + d.score, 0);
  const passed = ruleFailures.length === 0 && total >= THRESHOLD;

  return {
    fixture_id: fixture.id,
    passed,
    total_score: total,
    max_score: 10,
    dimensions,
    rule_failures: ruleFailures,
  };
}

export { THRESHOLD };
