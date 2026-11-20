// Deterministic quality checks. These decide the gates; agent opinions never override them.
//   1. unit + acceptance tests  (node --test, sandboxed child process with timeout)
//   2. line coverage of src/    (node's built-in coverage)
//   3. lint                     (house rules for the payments codebase)
//   4. static security scan     (PCI-focused rules: PAN in logs, secrets, eval, etc.)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '../config.ts';
import type { CheckResults, CoverageResult, LintIssue, SecurityFinding, TestResult } from '../types.ts';

interface ProcResult {
  code: number | null;
  out: string;
  timedOut: boolean;
  durationMs: number;
}

function runNode(cwd: string, args: string[], timeoutMs: number): Promise<ProcResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    // Minimal environment: no API keys, tokens or proxy settings leak into code under test.
    const child = spawn(process.execPath, args, {
      cwd,
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const cap = (d: Buffer) => {
      if (out.length < 2_000_000) out += d.toString();
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out, timedOut, durationMs: Date.now() - started });
    });
  });
}

export function parseTap(out: string, durationMs: number, timedOut: boolean): TestResult {
  const num = (k: string) => Number(out.match(new RegExp(`^# ${k} (\\d+)`, 'm'))?.[1] ?? 0);
  const failures: TestResult['failures'] = [];
  const lines = out.split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/^\s*not ok \d+ - (.+)$/);
    if (!m || /\.test\.js$/.test(m[1])) return; // skip file-level summary lines
    const block = lines.slice(i + 1, i + 25).join('\n');
    const msg =
      block.match(/error: \|-?\s*\n\s*(.+)/)?.[1] ??
      block.match(/error: '(.+)'/)?.[1] ??
      block.match(/error: (.+)/)?.[1] ??
      'assertion failed';
    failures.push({ name: m[1].trim(), message: msg.trim() });
  });
  return {
    passed: num('pass'),
    failed: num('fail') + (timedOut ? 1 : 0),
    total: num('tests'),
    failures,
    durationMs,
    timedOut,
    rawTail: out.split('\n').slice(-40).join('\n'),
  };
}

export function parseCoverage(out: string): number {
  // Average the line % of files under src/ from the coverage table.
  const rows = out.split('\n');
  let inSrc = false;
  const pcts: number[] = [];
  for (const row of rows) {
    const m = row.match(/^#\s(\s*)([\w./-]+)\s*\|\s*([\d.]*)\s*\|/);
    if (!m) continue;
    const [, indent, name, pct] = m;
    if (indent.length === 0) inSrc = name === 'src';
    else if (inSrc && pct) pcts.push(Number(pct));
  }
  if (!pcts.length) return 0;
  return Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 100) / 100;
}

export async function runTests(dir: string): Promise<{ tests: TestResult; coverage: CoverageResult }> {
  const r = await runNode(dir, ['--test', '--test-reporter=tap', '--experimental-test-coverage'], LIMITS.testTimeoutMs);
  const tests = parseTap(r.out, r.durationMs, r.timedOut);
  const linePct = parseCoverage(r.out);
  return { tests, coverage: { linePct, threshold: LIMITS.coverageThresholdPct, ok: linePct >= LIMITS.coverageThresholdPct } };
}

export function lint(dir: string, files: string[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const file of files.filter((f) => f.endsWith('.js'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    text.split('\n').forEach((line, i) => {
      const at = (rule: string, message: string) => issues.push({ file, line: i + 1, rule, message });
      if (/^\s*var\s/.test(line)) at('no-var', 'use const or let');
      if (file.startsWith('src/') && /console\.(log|debug)\(/.test(line)) at('no-console', 'use the structured logger in src/logger.js');
      if (/\b(TODO|FIXME|XXX)\b/.test(line)) at('no-todo', 'unfinished work left in the change');
      if (/\b(test|it)\.only\(/.test(line)) at('no-only-tests', '.only() skips the rest of the suite');
      if (/\b(test|it)\.skip\(/.test(line)) at('no-skipped-tests', 'skipped tests hide failures');
      if (line.length > 140) at('max-len', 'line longer than 140 characters');
      if (file.startsWith('src/') && /parseFloat\(|toFixed\(/.test(line) && !file.endsWith('money.js'))
        at('money-integer-only', 'amounts are integer paise; do not use floating point outside money.js');
    });
  }
  return issues;
}

const SAST_RULES: { id: string; severity: SecurityFinding['severity']; title: string; test: (line: string) => boolean; fix: string }[] = [
  {
    id: 'PCI-001',
    severity: 'critical',
    title: 'Payment object logged without redaction (card number exposure)',
    // logging a raw payment / card object, i.e. log(...) containing `payment` or `card` not wrapped in redact()
    test: (l) => {
      const code = stripStrings(l);
      return /\blog\(/.test(code) && /\b(payment|card|cardNumber)\b/.test(code) && !/redact\(/.test(code);
    },
    fix: 'Pass payment data through redact() or log only identifiers (paymentId, refundId).',
  },
  {
    id: 'SEC-002',
    severity: 'critical',
    title: 'Hardcoded secret or API key',
    test: (l) => /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(l),
    fix: 'Load secrets from the secret manager / environment, never from source.',
  },
  {
    id: 'SEC-003',
    severity: 'high',
    title: 'Dynamic code execution',
    test: (l) => /\beval\(|new Function\(/.test(l),
    fix: 'Remove eval/new Function.',
  },
  {
    id: 'SEC-004',
    severity: 'high',
    title: 'Shell command execution from service code',
    test: (l) => /child_process|\bexecSync\(|\bspawn\(/.test(l),
    fix: 'Service code must not spawn processes.',
  },
  {
    id: 'SEC-005',
    severity: 'medium',
    title: 'Math.random used for identifiers',
    test: (l) => /Math\.random\(/.test(l),
    fix: 'Use crypto.randomUUID() for identifiers.',
  },
];

function stripStrings(line: string): string {
  return line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");
}

export function securityScan(dir: string, files: string[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const file of files.filter((f) => f.startsWith('src/') && f.endsWith('.js'))) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const rule of SAST_RULES) {
        if (rule.test(line)) {
          findings.push({ id: rule.id, severity: rule.severity, file, line: i + 1, title: rule.title, recommendation: rule.fix, source: 'sast' });
        }
      }
    });
  }
  return findings;
}

export async function runAllChecks(dir: string, changedFiles: string[]): Promise<CheckResults> {
  const [{ tests, coverage }, lintIssues, sast] = await Promise.all([
    runTests(dir),
    Promise.resolve(lint(dir, changedFiles)),
    Promise.resolve(securityScan(dir, changedFiles)),
  ]);
  return { tests, coverage, lint: lintIssues, sast };
}
