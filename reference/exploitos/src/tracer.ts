// Minimal observability. Every agent step -> one JSONL line.
// Iteration 3 frontend will tail this same file / event stream.
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const TRACE_DIR = "traces";
if (!existsSync(TRACE_DIR)) mkdirSync(TRACE_DIR, { recursive: true });

export type TraceEvent = {
  ts: string;
  run_id: string;
  agent: string;
  phase: "start" | "thinking" | "done" | "error";
  message: string;
  data?: unknown;
};

export class Tracer {
  runId: string;
  file: string;
  constructor(runId: string) {
    this.runId = runId;
    this.file = join(TRACE_DIR, `${runId}.jsonl`);
  }
  emit(ev: Omit<TraceEvent, "ts" | "run_id">) {
    const full: TraceEvent = {
      ts: new Date().toISOString(),
      run_id: this.runId,
      ...ev,
    };
    appendFileSync(this.file, JSON.stringify(full) + "\n");
    // Also print to terminal so iteration 0 is visibly traced.
    const tag = `[${full.agent}:${full.phase}]`;
    console.log(`${tag} ${full.message}`);
  }
}

export function newRunId(): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[:.]/g, "-");
  return `run_${stamp}_${Math.random().toString(36).slice(2, 7)}`;
}
