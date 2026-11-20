// Durable workflow state. state.json is the checkpoint (written atomically after every
// step); events.jsonl is the append-only execution history used for audit and reports.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunState, WorkflowEvent } from '../types.ts';

export class RunStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  runDir(runId: string): string {
    return join(this.root, runId);
  }

  save(state: RunState): void {
    const dir = this.runDir(state.runId);
    mkdirSync(dir, { recursive: true });
    state.updatedAt = new Date().toISOString();
    const tmp = join(dir, 'state.json.tmp');
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, join(dir, 'state.json')); // atomic on POSIX: a crash never leaves half a checkpoint
  }

  load(runId: string): RunState {
    const file = join(this.runDir(runId), 'state.json');
    if (!existsSync(file)) throw new Error(`No run named ${runId} in ${this.root}`);
    return JSON.parse(readFileSync(file, 'utf8')) as RunState;
  }

  append(event: WorkflowEvent): void {
    const dir = this.runDir(event.runId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n');
  }

  events(runId: string): WorkflowEvent[] {
    const file = join(this.runDir(runId), 'events.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as WorkflowEvent);
  }

  list(): string[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.root, d.name, 'state.json')))
      .map((d) => d.name)
      .sort();
  }
}
