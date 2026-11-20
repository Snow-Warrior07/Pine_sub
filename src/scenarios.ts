// Scenarios drive the offline demo. A scenario = the default scripted model responses,
// optional per-scenario overrides, and injected faults (outages, malformed output, etc.).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentTask } from './agents/schemas.ts';
import type { RunStatus } from './types.ts';

export const ROOT = resolve(import.meta.dirname, '..');
export const SCENARIO_DIR = join(ROOT, 'scenarios');

export type Fault =
  /** Provider throws a retryable "503 overloaded" error. */
  | {
      type: 'unavailable';
      task?: AgentTask;
      provider: 'primary' | 'secondary' | 'any';
      times: number;
      /** Outage only on the first run, so `resume` can demonstrate recovery. */
      firstRunOnly?: boolean;
      /** Outage begins at the first request for this task and then affects every task (mid-workflow outage). */
      startAt?: AgentTask;
    }
  /** Provider returns this literal text instead of the scripted response. */
  | { type: 'respond'; task: AgentTask; provider?: 'primary' | 'secondary' | 'any'; times: number; payload?: string; payloadFile?: string };

export interface Scenario {
  id: string;
  title: string;
  demonstrates: string[];
  description: string;
  requirement: string;
  repo: string;
  /** Per-task list of response fixture files; entry i is used for iteration i+1 (last one repeats). */
  script: Partial<Record<AgentTask, string[]>>;
  faults: Fault[];
  /** Architect decisions on developer deviations, in order. Default: reject. */
  deviationDecisions?: ('accept' | 'reject')[];
  expect: { status: RunStatus; iterations?: number };
}

export function listScenarios(): string[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.scenario.json'))
    .map((f) => f.replace('.scenario.json', ''))
    .sort();
}

export function loadScenario(id: string): Scenario {
  const file = join(SCENARIO_DIR, `${id}.scenario.json`);
  if (!existsSync(file)) throw new Error(`Unknown scenario "${id}". Available: ${listScenarios().join(', ')}`);
  const defaults = JSON.parse(readFileSync(join(SCENARIO_DIR, 'default-script.json'), 'utf8')) as Scenario['script'];
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Scenario;
  return { ...raw, script: { ...defaults, ...raw.script }, faults: raw.faults ?? [] };
}

/** Reads a response fixture, inlining {"$fixture": "code/x.js"} references as file contents. */
export function loadResponseFixture(file: string): string {
  const raw = JSON.parse(readFileSync(join(SCENARIO_DIR, 'fixtures', 'responses', file), 'utf8'));
  const inline = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(inline);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.$fixture === 'string') return readFileSync(join(SCENARIO_DIR, 'fixtures', o.$fixture), 'utf8');
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, inline(x)]));
    }
    return v;
  };
  return JSON.stringify(inline(raw), null, 2);
}

export function readFixtureText(file: string): string {
  return readFileSync(join(SCENARIO_DIR, 'fixtures', file), 'utf8');
}
