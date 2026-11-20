// Sandboxed workspace with branch isolation. Each run gets its own copy of the target
// repository with its own git history: `main` holds the baseline and all agent work happens
// on `agent/<runId>`. Nothing reaches `main` until a human approves.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { FileChange } from '../types.ts';
import { normalisePath } from './policy.ts';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'aeo-agent',
  GIT_AUTHOR_EMAIL: 'agent@aeo.local',
  GIT_COMMITTER_NAME: 'aeo-agent',
  GIT_COMMITTER_EMAIL: 'agent@aeo.local',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: '/nonexistent', // ignore the operator's global git config and hooks
};

export class Workspace {
  readonly dir: string;
  readonly branch: string;

  constructor(dir: string, branch: string) {
    this.dir = dir;
    this.branch = branch;
  }

  static create(sourceRepo: string, dir: string, branch: string): Workspace {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      cpSync(sourceRepo, dir, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.endsWith('/.git') });
    }
    const ws = new Workspace(dir, branch);
    if (!existsSync(join(dir, '.git'))) {
      ws.git('init', '-q', '-b', 'main');
      ws.git('add', '-A');
      ws.git('commit', '-q', '-m', 'baseline: target repository snapshot');
      ws.git('checkout', '-q', '-b', branch);
    }
    return ws;
  }

  git(...args: string[]): string {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: this.dir,
      env: GIT_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  /** Resolves a repo-relative path and refuses anything that escapes the workspace (incl. symlinks). */
  resolveSafe(relPath: string): string {
    const n = normalisePath(relPath);
    if (!n) throw new Error(`unsafe path ${relPath}`);
    const abs = resolve(this.dir, n);
    const root = realpathSync(this.dir);
    let probe = abs;
    while (!existsSync(probe)) probe = dirname(probe);
    const real = realpathSync(probe);
    if (relative(root, real).startsWith('..')) throw new Error(`path ${relPath} escapes the workspace`);
    return abs;
  }

  read(relPath: string): string | null {
    const abs = this.resolveSafe(relPath);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  }

  write(changes: FileChange[]): void {
    for (const c of changes) {
      const abs = this.resolveSafe(c.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, c.content);
    }
  }

  commit(message: string): string {
    this.git('add', '-A');
    const status = this.git('status', '--porcelain');
    if (status) this.git('commit', '-q', '-m', message);
    return this.head();
  }

  /** Discards uncommitted changes (used when resuming after a crash mid-iteration). */
  resetToHead(): void {
    this.git('reset', '-q', '--hard');
    this.git('clean', '-q', '-fd');
  }

  head(): string {
    return this.git('rev-parse', '--short', 'HEAD');
  }

  diffFromMain(): string {
    return this.git('diff', 'main...HEAD');
  }

  diffStat(): { files: string[]; added: number; removed: number } {
    const out = this.git('diff', '--numstat', 'main...HEAD');
    let added = 0;
    let removed = 0;
    const files: string[] = [];
    for (const line of out.split('\n').filter(Boolean)) {
      const [a, r, f] = line.split('\t');
      added += Number(a) || 0;
      removed += Number(r) || 0;
      files.push(f);
    }
    return { files, added, removed };
  }

  /** Merge the agent branch into main. Only called after human approval. */
  mergeToMain(message: string): string {
    this.git('checkout', '-q', 'main');
    this.git('merge', '-q', '--no-ff', '-m', message, this.branch);
    return this.head();
  }

  listFiles(): string[] {
    return this.git('ls-files').split('\n').filter(Boolean);
  }
}
