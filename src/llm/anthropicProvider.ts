// Real provider for Claude via the official Anthropic SDK. Optional: the demo runs offline
// with the mock provider. Enable with `--provider anthropic` and ANTHROPIC_API_KEY set.
// The SDK's own retries are disabled so that the gateway owns retry, failover and accounting.
import { ProviderError, type LlmProvider, type LlmRequest, type LlmResponse } from './provider.ts';

export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  private client: unknown;

  constructor(name: string, model: string) {
    this.name = name;
    this.model = model;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    let Anthropic;
    try {
      Anthropic = (await import('@anthropic-ai/sdk')).default;
    } catch {
      throw new ProviderError('@anthropic-ai/sdk is not installed (run npm install)', false);
    }
    this.client ??= new Anthropic({ maxRetries: 0, timeout: 120_000 });
    const client = this.client as InstanceType<typeof Anthropic>;

    const started = Date.now();
    try {
      // Streaming keeps long developer outputs (whole files) clear of HTTP timeouts.
      const stream = client.messages.stream({
        model: this.model,
        max_tokens: 32_000,
        system: req.system,
        output_config: { effort: 'medium' },
        messages: [{ role: 'user', content: req.user }],
      });
      const msg = await stream.finalMessage();

      if (msg.stop_reason === 'refusal') {
        throw new ProviderError(`model declined the request (refusal)`, false);
      }
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return {
        text,
        model: msg.model,
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        latencyMs: Date.now() - started,
        simulated: false,
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Anthropic.APIConnectionError) throw new ProviderError(`connection error: ${err.message}`, true);
      if (err instanceof Anthropic.RateLimitError) throw new ProviderError('429 rate limited', true, 429);
      if (err instanceof Anthropic.InternalServerError) throw new ProviderError(`${err.status} server error`, true, err.status);
      if (err instanceof Anthropic.APIError) throw new ProviderError(`${err.status} ${err.message}`, false, err.status);
      throw new ProviderError(String(err), true);
    }
  }
}
