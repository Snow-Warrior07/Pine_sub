// Thin wrapper over OpenCode Zen's Anthropic-compatible /v1/messages endpoint.
// Every call is tracked as a Langfuse generation (tokens, cost, latency, input/output).
import "dotenv/config";
import { langfuse } from "./langfuse";
import type { LangfuseTraceClient } from "./langfuse";

const API_KEY = process.env.ZEN_API_KEY!;
const BASE_URL = process.env.ZEN_BASE_URL || "https://opencode.ai/zen/v1";
const MODEL    = process.env.MODEL || "claude-sonnet-4-6";

if (!API_KEY) throw new Error("ZEN_API_KEY missing. Set it in .env");

export type ChatMessage = { role: "user" | "assistant"; content: string };

export async function chat(opts: {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  // Langfuse context — passed down from the pipeline trace
  trace?: LangfuseTraceClient;
  agentName?: string;   // e.g. "Analyst" — used as the generation name
}): Promise<string> {
  const startTime = Date.now();

  const body = {
    model: MODEL,
    max_tokens: opts.maxTokens ?? 2048,
    system: opts.system,
    messages: opts.messages,
  };

  const res = await fetch(`${BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Zen API ${res.status}: ${errBody}`);
  }

  const json: any = await res.json();
  const endTime = Date.now();

  const text = (json?.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  // ── Langfuse generation ──────────────────────────────────────────────────
  // Record this LLM call under the parent trace if one was provided.
  if (opts.trace) {
    const usage = json?.usage ?? {};
    opts.trace.generation({
      name: opts.agentName ? `${opts.agentName} LLM call` : "LLM call",
      model: MODEL,
      // Langfuse understands Anthropic's token field names directly
      usage: {
        input:  usage.input_tokens  ?? 0,
        output: usage.output_tokens ?? 0,
        total:  (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        unit:   "TOKENS",
      },
      input:  { system: opts.system, messages: opts.messages },
      output: text,
      startTime: new Date(startTime),
      endTime:   new Date(endTime),
      metadata: {
        latency_ms: endTime - startTime,
        stop_reason: json?.stop_reason,
        zen_cost: json?.cost,           // Zen returns cost per call as a string
        cache_read_tokens:  usage.cache_read_input_tokens  ?? 0,
        cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
      },
    });
  }

  return text;
}

// Helper: force a JSON object out of the model.
// Passes trace context through to chat() so every call is recorded.
export async function chatJSON<T = unknown>(opts: {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  trace?: LangfuseTraceClient;
  agentName?: string;
}): Promise<T> {
  const raw = await chat(opts);
  // Strip markdown fences the model may wrap output in.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Fast path: valid JSON
  try {
    return JSON.parse(cleaned) as T;
  } catch (_) {}

  // Repair path: close open strings/arrays/objects for truncated JSON.
  const repaired = repairJSON(cleaned);
  try {
    return JSON.parse(repaired) as T;
  } catch (e) {
    throw new Error(
      `Failed to parse JSON (even after repair) from model.\nRaw:\n${raw.slice(0, 500)}\n\nError: ${(e as Error).message}`
    );
  }
}

/**
 * Best-effort repair for truncated JSON.
 * Closes unclosed strings, arrays, and objects in stack order.
 */
function repairJSON(s: string): string {
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") stack.push("{");
    else if (ch === "[") stack.push("[");
    else if (ch === "}" || ch === "]") stack.pop();
  }

  let result = s;
  if (inString) result += '"';
  for (let i = stack.length - 1; i >= 0; i--) {
    result += stack[i] === "{" ? "}" : "]";
  }
  return result;
}
