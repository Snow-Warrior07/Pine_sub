// Builds the README charts (static SVG) from real run metrics in runs/demo-*/metrics.json.
// Run `npm run demo:all` first, then `npm run charts`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RunMetrics } from '../src/report/report.ts';
import type { RunState } from '../src/types.ts';

const ROOT = resolve(import.meta.dirname, '..');
const RUNS = join(ROOT, 'runs');
const OUT = join(ROOT, 'docs', 'assets');
mkdirSync(OUT, { recursive: true });

const scenarios = JSON.parse(JSON.stringify(
  ['01-happy-path', '02-architect-developer-disagreement', '03-tests-fail-escalation', '04-security-critical', '05-malformed-output',
    '06-provider-failover', '07-provider-outage-resume', '08-unrelated-file', '09-repeat-action', '10-disagreement-escalation'],
)) as string[];

const runs = scenarios
  .filter((id) => existsSync(join(RUNS, `demo-${id}`, 'state.json')))
  .map((id) => {
    const state = JSON.parse(readFileSync(join(RUNS, `demo-${id}`, 'state.json'), 'utf8')) as RunState;
    const metrics = JSON.parse(readFileSync(join(RUNS, `demo-${id}`, 'metrics.json'), 'utf8')) as RunMetrics;
    return { id, state, metrics };
  });
if (runs.length === 0) throw new Error('No demo runs found. Run `npm run demo:all` first.');

// Reference palette, slots 1-3 (validated all-pairs, light and dark).
const STYLE = `<style>
.bg{fill:#fcfcfb;stroke:#e4e3df}.t{fill:#0b0b0b;font:600 15px system-ui,sans-serif}.s{fill:#52514e;font:12px system-ui,sans-serif}
.l{fill:#0b0b0b;font:12px system-ui,sans-serif}.v{fill:#52514e;font:11px system-ui,sans-serif}.grid{stroke:#e4e3df}.gap{stroke:#fcfcfb;stroke-width:2}
.c1{fill:#2a78d6}.c2{fill:#eb6834}.c3{fill:#1baf7a}
@media (prefers-color-scheme:dark){.bg{fill:#1a1a19;stroke:#383835}.t,.l{fill:#f0efec}.s,.v{fill:#c3c2b7}.grid{stroke:#383835}.gap{stroke:#1a1a19}
.c1{fill:#3987e5}.c2{fill:#d95926}.c3{fill:#199e70}}
</style>`;

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

interface Series { key: string; label: string; cls: string }

/** Horizontal stacked bar chart. Rounded 4px data end, 2px surface gaps between segments. */
function stackedBars(opts: {
  title: string; subtitle: string; rows: { label: string; values: number[] }[]; series: Series[]; unit: (v: number) => string; file: string;
}) {
  const W = 760, labelW = 250, rowH = 28, top = opts.series.length > 1 ? 86 : 64, plotW = W - labelW - 90;
  const H = top + opts.rows.length * rowH + 36;
  const max = Math.max(...opts.rows.map((r) => r.values.reduce((a, b) => a + b, 0)));
  const niceMax = niceCeil(max);
  const x = (v: number) => labelW + (v / niceMax) * plotW;
  const parts: string[] = [];
  parts.push(`<rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10"/>`);
  parts.push(`<text class="t" x="20" y="30">${esc(opts.title)}</text><text class="s" x="20" y="50">${esc(opts.subtitle)}</text>`);
  if (opts.series.length > 1) {
    let lx = 20;
    for (const s of opts.series) {
      parts.push(`<rect class="${s.cls}" x="${lx}" y="63" width="12" height="12" rx="3"/><text class="l" x="${lx + 18}" y="73">${esc(s.label)}</text>`);
      lx += 30 + s.label.length * 7;
    }
  }
  for (const t of ticks(niceMax)) {
    parts.push(`<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${top + opts.rows.length * rowH}"/>`);
    parts.push(`<text class="v" x="${x(t)}" y="${top + opts.rows.length * rowH + 16}" text-anchor="middle">${esc(opts.unit(t))}</text>`);
  }
  opts.rows.forEach((row, i) => {
    const y = top + i * rowH + 6;
    const h = rowH - 12;
    const total = row.values.reduce((a, b) => a + b, 0);
    parts.push(`<text class="l" x="${labelW - 10}" y="${y + h - 3}" text-anchor="end">${esc(row.label)}</text>`);
    const clipId = `${opts.file.replace(/\W/g, '')}-${i}`;
    parts.push(`<clipPath id="${clipId}"><rect x="${labelW - 4}" y="${y}" width="${Math.max(x(total) - labelW + 4, 0)}" height="${h}" rx="4"/></clipPath>`);
    let acc = 0;
    const segs: string[] = [];
    row.values.forEach((v, si) => {
      if (v <= 0) return;
      const s = opts.series[si];
      segs.push(`<rect class="${s.cls}" x="${x(acc)}" y="${y}" width="${x(acc + v) - x(acc)}" height="${h}"><title>${esc(`${row.label} · ${s.label}: ${opts.unit(v)}`)}</title></rect>`);
      if (acc > 0) segs.push(`<line class="gap" x1="${x(acc)}" x2="${x(acc)}" y1="${y}" y2="${y + h}"/>`);
      acc += v;
    });
    parts.push(`<g clip-path="url(#${clipId})">${segs.join('')}</g>`);
    parts.push(`<text class="v" x="${x(total) + 6}" y="${y + h - 3}">${esc(opts.unit(total))}</text>`);
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title)}">${STYLE}${parts.join('')}</svg>\n`;
  writeFileSync(join(OUT, opts.file), svg);
}

function niceCeil(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v || 1));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function ticks(max: number): number[] {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => +(f * max).toPrecision(6));
}

// 1. Model calls per scenario, by outcome
const outcomes = (r: (typeof runs)[number], o: string) => r.state.usage.filter((u) => u.outcome === o).length;
stackedBars({
  title: 'Model calls per scenario, by outcome',
  subtitle: 'Every attempt is recorded, including rejected output and provider errors (mock provider)',
  series: [
    { key: 'ok', label: 'Accepted', cls: 'c1' },
    { key: 'invalid_output', label: 'Rejected output (repaired)', cls: 'c2' },
    { key: 'provider_error', label: 'Provider error (retried / failed over)', cls: 'c3' },
  ],
  rows: runs.map((r) => ({ label: r.id, values: [outcomes(r, 'ok'), outcomes(r, 'invalid_output'), outcomes(r, 'provider_error')] })),
  unit: (v) => `${Math.round(v)}`,
  file: 'calls-by-scenario.svg',
});

// 2. Cost by agent, happy path
const happy = runs.find((r) => r.id === '01-happy-path')!;
const agentOrder = ['analyst', 'architect', 'qa', 'developer', 'security', 'release'];
stackedBars({
  title: 'Estimated cost by agent: minimum demo (01-happy-path)',
  subtitle: 'USD, simulated: mock token counts priced at Claude Opus 5.5 rates ($4 in / $20 out per MTok)',
  series: [{ key: 'cost', label: 'Cost', cls: 'c1' }],
  rows: agentOrder.filter((a) => happy.metrics.byAgent[a]).map((a) => ({ label: a, values: [happy.metrics.byAgent[a].costUsd] })),
  unit: (v) => `$${v.toFixed(3)}`,
  file: 'cost-by-agent.svg',
});

// 3. Tokens by agent across all scenarios
const tok: Record<string, { in: number; out: number }> = {};
for (const r of runs) for (const [a, m] of Object.entries(r.metrics.byAgent)) {
  tok[a] ??= { in: 0, out: 0 };
  tok[a].in += m.inputTokens;
  tok[a].out += m.outputTokens;
}
stackedBars({
  title: `Tokens by agent across all ${runs.length} scenarios`,
  subtitle: 'Input vs output tokens (estimated at 4 characters per token by the mock provider)',
  series: [
    { key: 'in', label: 'Input tokens', cls: 'c1' },
    { key: 'out', label: 'Output tokens', cls: 'c2' },
  ],
  rows: agentOrder.filter((a) => tok[a]).map((a) => ({ label: a, values: [tok[a].in, tok[a].out] })),
  unit: (v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${Math.round(v)}`),
  file: 'tokens-by-agent.svg',
});

// Data tables for the README (the accessible view of each chart)
const lines: string[] = [];
lines.push('| Scenario | Final status | Iterations | Accepted | Rejected output | Provider errors | Est. cost (USD) | Rubric |', '|---|---|---|---|---|---|---|---|');
for (const r of runs) lines.push(`| ${r.id} | ${r.state.status} | ${r.metrics.iterations} | ${outcomes(r, 'ok')} | ${outcomes(r, 'invalid_output')} | ${outcomes(r, 'provider_error')} | ${r.metrics.costUsd.toFixed(4)} | ${r.metrics.score ?? '-'} |`);
lines.push('', '| Agent | Calls (01) | Cost USD (01) | Input tokens (all) | Output tokens (all) |', '|---|---|---|---|---|');
for (const a of agentOrder) {
  const m = happy.metrics.byAgent[a];
  if (m) lines.push(`| ${a} | ${m.calls} | ${m.costUsd.toFixed(4)} | ${tok[a].in.toLocaleString('en-US')} | ${tok[a].out.toLocaleString('en-US')} |`);
}
writeFileSync(join(OUT, 'chart-data.md'), lines.join('\n') + '\n');
console.log(`Wrote ${OUT}/calls-by-scenario.svg, cost-by-agent.svg, tokens-by-agent.svg, chart-data.md`);
