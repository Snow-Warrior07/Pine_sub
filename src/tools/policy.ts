// Policy guard: deterministic rules that sit between agent output and the workspace.
// Agents propose; this code decides what is allowed to touch the repository.
import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { PROTECTED_PATHS, WRITABLE_ROOTS } from '../config.ts';
import type { FileChange } from '../types.ts';

export interface PolicyVerdict {
  allowed: FileChange[];
  violations: string[];
}

export function normalisePath(p: string): string | null {
  if (!p || isAbsolute(p) || p.includes('\0')) return null;
  const n = normalize(p).replace(/\\/g, '/');
  if (n.startsWith('../') || n === '..' || n.startsWith('/')) return null;
  return n;
}

export function isProtected(path: string): boolean {
  return PROTECTED_PATHS.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

/**
 * Checks a developer change set against the design's file scope and the global protected list.
 * Any violation rejects the whole change set: partial application of an agent's change is
 * harder to reason about than a clean retry.
 */
export function checkChangeScope(changes: FileChange[], allowedFiles: string[]): PolicyVerdict {
  const violations: string[] = [];
  const allowedSet = new Set(allowedFiles.map((f) => normalisePath(f)).filter(Boolean) as string[]);
  const seen = new Set<string>();

  for (const c of changes) {
    const path = normalisePath(c.path);
    if (!path) {
      violations.push(`Rejected unsafe path "${c.path}" (absolute or escapes the repository)`);
      continue;
    }
    if (seen.has(path)) violations.push(`Duplicate change for ${path} in one change set`);
    seen.add(path);
    if (isProtected(path)) {
      violations.push(`${path} is a protected path; agents may not modify it`);
      continue;
    }
    if (!WRITABLE_ROOTS.some((r) => path.startsWith(r))) {
      violations.push(`${path} is outside the writable roots (${WRITABLE_ROOTS.join(', ')})`);
      continue;
    }
    if (!allowedSet.has(path)) {
      violations.push(`${path} is not in the architect's allowed_files; unrelated file changes are blocked`);
    }
  }
  return { allowed: violations.length ? [] : changes, violations };
}

/** Architects cannot widen scope to protected paths either. */
export function sanitiseAllowedFiles(files: string[]): { files: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const f of files) {
    const p = normalisePath(f);
    if (!p || isProtected(p) || !WRITABLE_ROOTS.some((r) => p.startsWith(r))) dropped.push(f);
    else kept.push(p);
  }
  return { files: [...new Set(kept)], dropped };
}

export function hashChangeset(changes: FileChange[]): string {
  const h = createHash('sha256');
  for (const c of [...changes].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(c.path).update('\0').update(c.content).update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * Idempotency ledger for side effects (apply, commit, merge, deploy). The key is derived
 * from the action and its inputs, so a repeated or replayed action is detected instead of
 * performed twice, including after a crash and resume.
 */
export class ActionLedger {
  private readonly keys: Set<string>;
  constructor(existing: string[]) {
    this.keys = new Set(existing);
  }
  static key(action: string, ...parts: string[]): string {
    return `${action}:${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)}`;
  }
  has(key: string): boolean {
    return this.keys.has(key);
  }
  add(key: string): void {
    this.keys.add(key);
  }
  toJSON(): string[] {
    return [...this.keys];
  }
}
