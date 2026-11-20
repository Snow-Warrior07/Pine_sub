// Models sometimes wrap JSON in prose or code fences, or stop mid-object. This extracts the
// outermost JSON object if there is one and reports a precise error if there is not.

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

export function parseModelJson(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'empty response' };

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1) return { ok: false, error: 'no JSON object found in response' };
  if (end < start) return { ok: false, error: 'JSON object is not closed (response looks truncated)' };

  try {
    return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) };
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
}
