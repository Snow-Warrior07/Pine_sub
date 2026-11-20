// Unit tests for the deterministic guardrails: schema validation, JSON parsing, file-scope
// policy, idempotency keys and the static checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMAS, validate } from '../src/agents/schemas.ts';
import { parseModelJson } from '../src/llm/json.ts';
import { ActionLedger, checkChangeScope, hashChangeset, sanitiseAllowedFiles } from '../src/tools/policy.ts';
import { lint, parseCoverage, parseTap, securityScan } from '../src/tools/checks.ts';

test('schema rejects unsupported enum values, missing and unexpected fields', () => {
  const errors = validate({ verdict: 'maybe', failing_criteria: [], extra: 1 }, SCHEMAS['qa.review']);
  assert.ok(errors.some((e) => e.includes('unsupported value "maybe"')));
  assert.ok(errors.some((e) => e.includes('feedback_for_developer: missing')));
  assert.ok(errors.some((e) => e.includes('extra: unexpected field')));
});

test('schema rejects path traversal in developer changes', () => {
  const errors = validate(
    { summary: 'hello', changes: [{ path: '../../etc/passwd', action: 'modify', content: 'x' }], design_deviations: [], tests_added: [] },
    SCHEMAS['developer.implement'],
  );
  assert.ok(errors.some((e) => e.includes('does not match')));
});

test('JSON parser handles fences and reports truncation', () => {
  assert.deepEqual(parseModelJson('Here you go:\n```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } });
  const truncated = parseModelJson('Sure! {"a": [1, 2');
  assert.equal(truncated.ok, false);
  assert.match((truncated as { error: string }).error, /truncated|invalid JSON/);
  assert.equal(parseModelJson('no json here').ok, false);
});

test('scope policy blocks unrelated, protected and escaping paths', () => {
  const allowed = ['src/refunds.js', 'test/refunds.test.js'];
  const mk = (path: string) => ({ path, action: 'modify' as const, content: 'x' });
  assert.equal(checkChangeScope([mk('src/refunds.js')], allowed).violations.length, 0);
  assert.match(checkChangeScope([mk('src/settlement.js')], allowed).violations[0], /not in the architect's allowed_files/);
  assert.match(checkChangeScope([mk('config/gateway.config.json')], allowed).violations[0], /protected/);
  assert.match(checkChangeScope([mk('test/acceptance/refunds.acceptance.test.js')], allowed).violations[0], /protected/);
  assert.match(checkChangeScope([mk('../outside.js')], allowed).violations[0], /unsafe path/);
  assert.match(checkChangeScope([mk('/etc/passwd')], allowed).violations[0], /unsafe path/);
  // One bad file rejects the whole change set.
  assert.equal(checkChangeScope([mk('src/refunds.js'), mk('src/settlement.js')], allowed).allowed.length, 0);
});

test('architect cannot widen scope to protected paths', () => {
  const { files, dropped } = sanitiseAllowedFiles(['src/refunds.js', '.github/workflows/ci.yml', 'package.json', 'README.md']);
  assert.deepEqual(files, ['src/refunds.js']);
  assert.deepEqual(dropped, ['.github/workflows/ci.yml', 'package.json', 'README.md']);
});

test('change set hash is order-independent and content-sensitive', () => {
  const a = { path: 'a.js', action: 'create' as const, content: '1' };
  const b = { path: 'b.js', action: 'create' as const, content: '2' };
  assert.equal(hashChangeset([a, b]), hashChangeset([b, a]));
  assert.notEqual(hashChangeset([a, b]), hashChangeset([a, { ...b, content: '3' }]));
});

test('action ledger detects repeated side effects', () => {
  const ledger = new ActionLedger([]);
  const key = ActionLedger.key('merge', 'run-1', 'agent/run-1');
  assert.equal(ledger.has(key), false);
  ledger.add(key);
  const restored = new ActionLedger(ledger.toJSON());
  assert.equal(restored.has(ActionLedger.key('merge', 'run-1', 'agent/run-1')), true);
});

test('TAP parser extracts counts and failing test names', () => {
  const tap = [
    'ok 1 - AC-1 partial refund',
    'not ok 2 - AC-2 cumulative refunds can never exceed the captured amount',
    '  ---',
    "  error: 'Missing expected exception.'",
    '  ...',
    'not ok 3 - test/acceptance/refunds.acceptance.test.js',
    '# tests 2',
    '# pass 1',
    '# fail 1',
  ].join('\n');
  const r = parseTap(tap, 10, false);
  assert.equal(r.total, 2);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.failures, [{ name: 'AC-2 cumulative refunds can never exceed the captured amount', message: 'Missing expected exception.' }]);
});

test('coverage parser averages src/ files only', () => {
  const out = [
    '# file | line % | branch % | funcs % | uncovered lines',
    '# src |  |  |  | ',
    '#  a.js | 100.00 | 100.00 | 100.00 | ',
    '#  b.js |  80.00 | 100.00 | 100.00 | ',
    '# test |  |  |  | ',
    '#  a.test.js | 10.00 | 100.00 | 100.00 | ',
    '# all files | 63.00 | 100.00 | 100.00 | ',
  ].join('\n');
  assert.equal(parseCoverage(out), 90);
});

test('security scan flags PAN logging and secrets without false positives on event names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aeo-sast-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'src', 'x.js'),
    [
      "log('payment.captured', { paymentId: id });", // fine: event name + id only
      "log('payment.created', { payment: redact(payment) });", // fine: redacted
      "log('refund.created', { refund: record, payment });", // PAN leak
      "const apiKey = 'sk_live_1234567890abcdef';", // secret
    ].join('\n'),
  );
  const findings = securityScan(dir, ['src/x.js']);
  assert.deepEqual(findings.map((f) => `${f.id}@${f.line}`), ['PCI-001@3', 'SEC-002@4']);
  assert.ok(findings.every((f) => f.severity === 'critical'));
});

test('lint catches focused tests, console logging and floating point money', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aeo-lint-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src', 'a.js'), "console.log('x');\nconst v = parseFloat(amount);\n");
  writeFileSync(join(dir, 'test', 'a.test.js'), "test.only('x', () => {});\n");
  const rules = lint(dir, ['src/a.js', 'test/a.test.js']).map((i) => i.rule).sort();
  assert.deepEqual(rules, ['money-integer-only', 'no-console', 'no-only-tests']);
});
