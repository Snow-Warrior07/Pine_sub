// The model gateway is the only path from agents to models. It owns:
//   * transient-error retries with exponential backoff
//   * a circuit breaker per provider and failover to the next provider
//   * JSON parsing, schema validation and bounded "repair" re-prompts
//   * usage, latency and cost accounting for every attempt, including failed ones
//   * hard per-run budgets (call count and USD)
import { LIMITS, costUsd } from '../config.ts';
import { SCHEMAS, validate, type AgentTask } from '../agents/schemas.ts';
import { SYSTEM_PROMPTS } from '../agents/prompts.ts';
import { parseModelJson } from './json.ts';
import { ProviderError, type LlmProvider, type LlmRequest } from './provider.ts';
import type { UsageRecord } from '../types.ts';

export class ProvidersUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvidersUnavailableError';
  }
}

export class AgentOutputError extends Error {
  readonly task: AgentTask;
  readonly validationErrors: string[];
  constructor(task: AgentTask, validationErrors: string[]) {
    super(`${task} returned invalid output after ${LIMITS.maxRepairAttempts} repair attempts: ${validationErrors.slice(0, 3).join('; ')}`);
    this.name = 'AgentOutputError';
    this.task = task;
    this.validationErrors = validationErrors;
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  constructor(threshold: number, cooldownMs: number) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }
  get isOpen(): boolean {
    if (this.openedAt === null) return false;
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.openedAt = null; // half-open: allow one trial request
      this.failures = this.threshold - 1;
      return false;
    }
    return true;
  }
  success(): void {
    this.failures = 0;
    this.openedAt = null;
  }
  failure(): boolean {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
    return this.openedAt !== null;
  }
}

export interface GatewayHooks {
  onUsage(record: UsageRecord): void;
  onEvent(type: string, message: string, data?: Record<string, unknown>): void;
  sleep?(ms: number): Promise<void>;
  backoffBaseMs?: number;
  breakerCooldownMs?: number;
}

export class ModelGateway {
  private readonly providers: LlmProvider[];
  private readonly breakers: Map<string, CircuitBreaker>;
  private readonly hooks: GatewayHooks;
  private calls: number;
  private spend: number;

  constructor(providers: LlmProvider[], hooks: GatewayHooks, priorUsage: UsageRecord[] = []) {
    this.providers = providers;
    this.hooks = hooks;
    this.breakers = new Map(
      providers.map((p) => [p.name, new CircuitBreaker(LIMITS.circuitBreakerThreshold, hooks.breakerCooldownMs ?? 30_000)]),
    );
    this.calls = priorUsage.length;
    this.spend = priorUsage.reduce((s, u) => s + u.costUsd, 0);
  }

  async call<T>(task: AgentTask, input: unknown, iteration = 0): Promise<T> {
    const baseUser = JSON.stringify(input, null, 2);
    let repairs = 0;
    let lastErrors: string[] = [];

    for (const provider of this.providers) {
      const breaker = this.breakers.get(provider.name)!;
      if (breaker.isOpen) {
        this.hooks.onEvent('provider.circuit_open', `Skipping ${provider.name}: circuit open`, { task, provider: provider.name });
        continue;
      }

      let transientFailures = 0;
      let user = baseUser;
      while (true) {
        this.enforceBudget(task);
        const req: LlmRequest = { task, system: SYSTEM_PROMPTS[task], user, input, iteration };
        const started = Date.now();
        let resp;
        try {
          resp = await provider.complete(req);
        } catch (err) {
          const e = err instanceof ProviderError ? err : new ProviderError(String(err), true);
          this.record(task, provider, transientFailures + repairs + 1, 'provider_error', 0, 0, Date.now() - started, true, e.message);
          if (!e.retryable) throw e;
          const opened = breaker.failure();
          transientFailures += 1;
          if (opened || transientFailures > LIMITS.maxProviderRetries) {
            this.hooks.onEvent('provider.failover', `${provider.name} unavailable (${e.message}); ${opened ? 'circuit opened' : 'retries exhausted'}`, {
              task,
              provider: provider.name,
            });
            break;
          }
          const delay = (this.hooks.backoffBaseMs ?? 500) * 2 ** (transientFailures - 1);
          this.hooks.onEvent('provider.retry', `${provider.name} error: ${e.message}. Retry ${transientFailures}/${LIMITS.maxProviderRetries} in ${delay}ms`, {
            task,
            provider: provider.name,
          });
          await (this.hooks.sleep ?? defaultSleep)(delay);
          continue;
        }
        breaker.success();

        const parsed = parseModelJson(resp.text);
        const errors = parsed.ok ? validate(parsed.value, SCHEMAS[task]) : [parsed.error];
        if (errors.length === 0) {
          this.record(task, provider, transientFailures + repairs + 1, 'ok', resp.inputTokens, resp.outputTokens, resp.latencyMs, resp.simulated, undefined, resp.model);
          return (parsed as { ok: true; value: unknown }).value as T;
        }

        this.record(task, provider, transientFailures + repairs + 1, 'invalid_output', resp.inputTokens, resp.outputTokens, resp.latencyMs, resp.simulated, errors.join('; '), resp.model);
        lastErrors = errors;
        repairs += 1;
        if (repairs > LIMITS.maxRepairAttempts) throw new AgentOutputError(task, errors);
        this.hooks.onEvent('agent.output_rejected', `${task} output rejected (${errors.length} problem(s)); asking for a corrected response (${repairs}/${LIMITS.maxRepairAttempts})`, {
          task,
          errors: errors.slice(0, 5),
        });
        user = `${baseUser}\n\nYour previous response was rejected by the output validator:\n- ${errors.slice(0, 10).join('\n- ')}\nReturn the corrected JSON object only.`;
      }
    }
    throw new ProvidersUnavailableError(
      `No model provider available for ${task}${lastErrors.length ? ` (last errors: ${lastErrors.join('; ')})` : ''}`,
    );
  }

  private enforceBudget(task: AgentTask): void {
    if (this.calls >= LIMITS.maxModelCallsPerRun)
      throw new BudgetExceededError(`Model call budget exhausted (${LIMITS.maxModelCallsPerRun}) before ${task}`);
    if (this.spend >= LIMITS.maxCostUsdPerRun)
      throw new BudgetExceededError(`Cost budget exhausted ($${this.spend.toFixed(2)} >= $${LIMITS.maxCostUsdPerRun}) before ${task}`);
  }

  private record(
    task: AgentTask,
    provider: LlmProvider,
    attempt: number,
    outcome: UsageRecord['outcome'],
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
    simulated: boolean,
    error?: string,
    model = provider.model,
  ): void {
    const cost = costUsd(model, inputTokens, outputTokens);
    this.calls += 1;
    this.spend += cost;
    this.hooks.onUsage({
      at: new Date().toISOString(),
      agent: task,
      provider: provider.name,
      model,
      attempt,
      outcome,
      inputTokens,
      outputTokens,
      latencyMs,
      costUsd: cost,
      simulated,
      error,
    });
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
