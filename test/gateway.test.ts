// The model gateway: retries, circuit breaker, failover, output repair and budgets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway, AgentOutputError, ProvidersUnavailableError, BudgetExceededError } from '../src/llm/gateway.ts';
import { ProviderError, type LlmProvider, type LlmRequest, type LlmResponse } from '../src/llm/provider.ts';
import type { UsageRecord } from '../src/types.ts';

const VALID_QA = JSON.stringify({ verdict: 'pass', failing_criteria: [], feedback_for_developer: 'ok' });

class FakeProvider implements LlmProvider {
  readonly name: string;
  readonly model = 'claude-opus-5-5';
  calls = 0;
  private readonly script: (string | Error)[];
  constructor(name: string, script: (string | Error)[]) {
    this.name = name;
    this.script = script;
  }
  async complete(_req: LlmRequest): Promise<LlmResponse> {
    const next = this.script[Math.min(this.calls++, this.script.length - 1)];
    if (next instanceof Error) throw next;
    return { text: next, model: this.model, inputTokens: 100, outputTokens: 50, latencyMs: 5, simulated: true };
  }
}

function gateway(providers: LlmProvider[]) {
  const usage: UsageRecord[] = [];
  const events: string[] = [];
  const gw = new ModelGateway(providers, {
    onUsage: (u) => usage.push(u),
    onEvent: (type) => events.push(type),
    sleep: async () => {},
    backoffBaseMs: 0,
  });
  return { gw, usage, events };
}

const outage = () => new ProviderError('503 overloaded', true, 503);

test('retries transient errors on the same provider, then succeeds', async () => {
  const p = new FakeProvider('p', [outage(), VALID_QA]);
  const { gw, usage, events } = gateway([p]);
  const out = await gw.call<{ verdict: string }>('qa.review', {});
  assert.equal(out.verdict, 'pass');
  assert.deepEqual(usage.map((u) => u.outcome), ['provider_error', 'ok']);
  assert.ok(events.includes('provider.retry'));
});

test('opens the circuit and fails over to the secondary provider', async () => {
  const primary = new FakeProvider('primary', [outage()]);
  const secondary = new FakeProvider('secondary', [VALID_QA]);
  const { gw, usage, events } = gateway([primary, secondary]);
  await gw.call('qa.review', {});
  await gw.call('qa.review', {});
  assert.equal(primary.calls, 3, 'primary is not called again once its circuit is open');
  assert.equal(secondary.calls, 2);
  assert.ok(events.includes('provider.failover'));
  assert.ok(events.includes('provider.circuit_open'));
  assert.equal(usage.filter((u) => u.outcome === 'provider_error').length, 3);
});

test('throws ProvidersUnavailableError when every provider is down', async () => {
  const { gw } = gateway([new FakeProvider('a', [outage()]), new FakeProvider('b', [outage()])]);
  await assert.rejects(gw.call('qa.review', {}), ProvidersUnavailableError);
});

test('non-retryable provider errors stop immediately', async () => {
  const p = new FakeProvider('p', [new ProviderError('400 bad request', false, 400), VALID_QA]);
  const { gw } = gateway([p]);
  await assert.rejects(gw.call('qa.review', {}), /400 bad request/);
  assert.equal(p.calls, 1);
});

test('repairs malformed and unsupported output by re-prompting', async () => {
  const p = new FakeProvider('p', ['Sure! {"verdict": "pa', JSON.stringify({ verdict: 'maybe', failing_criteria: [], feedback_for_developer: '' }), VALID_QA]);
  const { gw, usage } = gateway([p]);
  const out = await gw.call<{ verdict: string }>('qa.review', {});
  assert.equal(out.verdict, 'pass');
  assert.deepEqual(usage.map((u) => u.outcome), ['invalid_output', 'invalid_output', 'ok']);
});

test('gives up after the repair budget with AgentOutputError', async () => {
  const p = new FakeProvider('p', ['not json']);
  const { gw } = gateway([p]);
  await assert.rejects(gw.call('qa.review', {}), AgentOutputError);
  assert.equal(p.calls, 3);
});

test('enforces the per-run model call budget', async () => {
  const p = new FakeProvider('p', [VALID_QA]);
  const prior = Array.from({ length: 40 }, () => ({ costUsd: 0 }) as UsageRecord);
  const gw = new ModelGateway([p], { onUsage: () => {}, onEvent: () => {} }, prior);
  await assert.rejects(gw.call('qa.review', {}), BudgetExceededError);
  assert.equal(p.calls, 0);
});
