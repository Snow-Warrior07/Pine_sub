import type { AgentTask } from '../agents/schemas.ts';

export interface LlmRequest {
  task: AgentTask;
  system: string;
  user: string;
  /** Structured input, also serialised into `user`. The mock provider reads it directly. */
  input: unknown;
  iteration: number;
}

export interface LlmResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  simulated: boolean;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Raised by providers. `retryable` separates outages (retry, fail over) from bad requests (stop). */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
    this.status = status;
  }
}
