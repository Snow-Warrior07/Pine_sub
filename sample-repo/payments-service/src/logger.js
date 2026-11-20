// Structured logger. Card numbers (PAN) must never be written in clear text:
// always pass payment objects through redact() before logging them.
let sink = (line) => process.stdout.write(line + '\n');

export function setLogSink(fn) {
  sink = fn;
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'cardNumber' && typeof v === 'string') out[k] = '****' + v.slice(-4);
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

export function log(event, data = {}) {
  sink(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}
