// ZeroDayOS Evaluation Pipeline
// Runs the 5-agent chain against each golden fixture, scores outputs,
// pushes results to a Langfuse dataset, and exits non-zero if quality drops.
//
// Usage:
//   npm run eval                  — runs all fixtures
//   npm run eval -- --fixture sqli-001   — run one fixture
//
// Exit codes:
//   0  all fixtures passed
//   1  one or more fixtures failed (CI gates on this)

import "dotenv/config";
import { langfuse } from "../src/langfuse.js";
import { FIXTURES } from "./fixtures.js";
import { scoreRun, THRESHOLD } from "./scorer.js";
import {
  runAnalyst,
  runValidator,
  runRemediation,
  runReporter,
  type ReconOutput,
} from "../src/agents.js";
import { Tracer, newRunId } from "../src/tracer.js";

// ── CLI arg: --fixture <id> ───────────────────────────────────────────────────
const fixtureArg = process.argv.includes("--fixture")
  ? process.argv[process.argv.indexOf("--fixture") + 1]
  : null;

const fixtures = fixtureArg
  ? FIXTURES.filter((f) => f.id === fixtureArg)
  : FIXTURES;

if (fixtures.length === 0) {
  console.error(`No fixture found with id "${fixtureArg}"`);
  process.exit(1);
}

// ── Langfuse dataset (creates if it doesn't exist) ───────────────────────────
const DATASET_NAME = "zerodayos-eval";

async function ensureDataset() {
  // createDataset is idempotent in Langfuse v3 — safe to call every time.
  // If the dataset already exists it returns the existing one.
  return langfuse.createDataset({
    name: DATASET_NAME,
    description: "ZeroDayOS golden fixture eval — automated CI quality gate",
  });
}

// ── Null tracer for eval (no file I/O needed) ─────────────────────────────────
function silentTracer(): Tracer {
  const t = new Tracer(newRunId());
  const origEmit = t.emit.bind(t);
  t.emit = (ev) => {
    // Only print done/error to keep eval output clean
    if (ev.phase === "done" || ev.phase === "error") origEmit(ev);
  };
  return t;
}

// ── Run one fixture ───────────────────────────────────────────────────────────
async function evalFixture(fixture: typeof FIXTURES[number]) {
  console.log(`\n▶ Running fixture: ${fixture.id} — ${fixture.description}`);
  const runId = `eval-${fixture.id}-${Date.now()}`;
  const tracer = silentTracer();

  // Create a Langfuse trace for this eval run
  const lfTrace = langfuse.trace({
    id: runId,
    name: `eval-${fixture.id}`,
    input: { fixture_id: fixture.id, snippet: fixture.snippet },
    tags: ["zerodayos", "eval"],
  });

  // Build a synthetic ReconOutput from the fixture — skips GitHub API
  const fakeRecon: ReconOutput = {
    repo: "eval-fixture",
    selected_files: ["fixture.js"],
    file_content: fixture.snippet,
    recon_summary: fixture.context,
  };

  // Run agents 2–5 (Analyst → Reporter). Recon is bypassed.
  const context  = `Files scanned: fixture.js. Recon notes: ${fixture.context}`;
  const analyst  = await runAnalyst(tracer, fixture.snippet, context, lfTrace);
  const validator   = await runValidator(tracer, fixture.snippet, analyst, lfTrace);
  const remediation = await runRemediation(tracer, fixture.snippet, analyst, lfTrace);
  const reporter    = await runReporter(tracer, fakeRecon, analyst, validator, remediation, lfTrace);

  // Score the outputs
  const result = await scoreRun({ fixture, analyst, validator, remediation, reporter, trace: lfTrace });

  // ── Push to Langfuse dataset ──────────────────────────────────────────────
  // 1. Upsert a dataset item for this fixture
  const datasetItem = await langfuse.createDatasetItem({
    datasetName: DATASET_NAME,
    input: { fixture_id: fixture.id, snippet: fixture.snippet, context: fixture.context },
    expectedOutput: fixture.expected,
    metadata: { fixture_id: fixture.id },
    id: fixture.id,   // stable id so re-runs update instead of duplicate
  });

  // 2. Link the trace to the dataset item as a run
  const RUN_NAME = `run-${new Date().toISOString().slice(0, 10)}`;
  await langfuse.createDatasetRunItem({
    datasetItemId: datasetItem.id,
    observationId: runId,   // links to our trace by id
    runName: RUN_NAME,
    metadata: { total_score: result.total_score, passed: result.passed },
  });

  // 3. Push per-dimension scores onto the trace
  for (const d of result.dimensions) {
    langfuse.score({
      traceId: runId,
      name: d.dimension,
      value: d.score,
      comment: d.rationale,
    });
  }
  // Push the aggregate score too
  langfuse.score({
    traceId: runId,
    name: "total_score",
    value: result.total_score,
    comment: result.passed ? "PASSED" : `FAILED — ${result.rule_failures.join("; ")}`,
  });

  // Update trace with final result
  lfTrace.update({
    output: {
      passed: result.passed,
      total_score: result.total_score,
      rule_failures: result.rule_failures,
    },
  });

  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`ZeroDayOS Eval Pipeline — ${fixtures.length} fixture(s)`);
  console.log(`Quality threshold: ${THRESHOLD}/10 per fixture`);
  console.log(`${"═".repeat(60)}`);

  await ensureDataset();
  const results = [];

  for (const fixture of fixtures) {
    try {
      const result = await evalFixture(fixture);
      results.push(result);

      // Per-fixture summary
      const icon = result.passed ? "✅" : "❌";
      console.log(`\n${icon} ${fixture.id}: ${result.total_score}/${result.max_score}`);
      for (const d of result.dimensions) {
        const bar = "█".repeat(d.score) + "░".repeat(d.max - d.score);
        console.log(`   ${bar} ${d.dimension} (${d.score}/${d.max}): ${d.rationale.slice(0, 80)}`);
      }
      if (result.rule_failures.length > 0) {
        console.log(`   ⚠  Rule failures:`);
        for (const f of result.rule_failures) console.log(`      • ${f}`);
      }
    } catch (err) {
      console.error(`\n❌ ${fixture.id}: THREW — ${(err as Error).message}`);
      results.push({
        fixture_id: fixture.id,
        passed: false,
        total_score: 0,
        max_score: 10,
        dimensions: [],
        rule_failures: [`Threw: ${(err as Error).message}`],
      });
    }
  }

  // Flush Langfuse before printing final summary
  await langfuse.flushAsync();

  // Final summary
  const passed  = results.filter((r) => r.passed).length;
  const failed  = results.length - passed;
  const avgScore = results.reduce((s, r) => s + r.total_score, 0) / results.length;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`EVAL SUMMARY`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Fixtures : ${results.length}`);
  console.log(`Passed   : ${passed}`);
  console.log(`Failed   : ${failed}`);
  console.log(`Avg score: ${avgScore.toFixed(1)} / 10`);
  console.log(`Langfuse dataset: https://cloud.langfuse.com/datasets/${DATASET_NAME}`);
  console.log(`${"═".repeat(60)}\n`);

  if (failed > 0) {
    console.error(`CI GATE: ${failed} fixture(s) failed. Blocking release.`);
    process.exit(1);
  }

  console.log("CI GATE: All fixtures passed. ✅");
  process.exit(0);
}

main().catch((err) => {
  console.error("Eval pipeline crashed:", err);
  process.exit(1);
});
