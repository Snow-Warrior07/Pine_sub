"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useAuth } from "../../lib/AuthContext";
import AuthGuard from "../../lib/AuthGuard";
import type { ObsNode, TraceData, Summary } from "./api/route";

// ─── Re-export types for use below ───────────────────────────────────────────
type ApiResponse = { traces?: TraceData[]; summary?: Summary; error?: string };

// ─── Agent colour palette ─────────────────────────────────────────────────────
const AGENT_COLORS: Record<string, string> = {
  Orchestrator: "#0077cc",
  Recon:        "#7c3aed",
  Analyst:      "#d97706",
  Validator:    "#059669",
  Remediation:  "#db2777",
  Reporter:     "#0891b2",
};
function agentColor(name: string) {
  for (const [k, v] of Object.entries(AGENT_COLORS)) {
    if (name.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return "#6a8fa8";
}

// ─── Formatters ───────────────────────────────────────────────────────────────
const fmt$ = (n: number) =>
  n === 0 ? "$0.0000" : n < 0.0001 ? `$${n.toExponential(2)}` : `$${n.toFixed(4)}`;

const fmtK = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K`
  : String(n);

const fmtMs = (ms: number | null) =>
  ms === null ? "—"
  : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m`
  : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s`
  : `${Math.round(ms)}ms`;

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

const severityColor = (s: string | null) =>
  ({ critical: "#c0152a", high: "#d95f02", medium: "#b8860b", low: "#008949" }[
    s?.toLowerCase() ?? ""
  ] ?? "#6a8fa8");

// ─── TRACE TREE ───────────────────────────────────────────────────────────────
function TreeNode({
  node, depth, isLast, filterAgent,
}: {
  node: ObsNode; depth: number; isLast: boolean; filterAgent: string;
}) {
  const [open, setOpen] = useState(depth < 2);
  const color = agentColor(node.name);
  const isGen = node.type === "GENERATION";

  // Agent filter
  if (filterAgent) {
    const agentMatch = node.name.toLowerCase().includes(filterAgent.toLowerCase());
    const childMatch = node.children.some(c =>
      c.name.toLowerCase().includes(filterAgent.toLowerCase())
    );
    if (!agentMatch && !childMatch && node.children.length === 0) return null;
  }

  const hasChildren = node.children.length > 0;
  const barPct = node.totalTokens > 0
    ? Math.min(100, (node.inputTokens / (node.totalTokens || 1)) * 100)
    : 0;

  return (
    <div className="tree-node-wrap">
      {/* Connector lines */}
      {depth > 0 && (
        <div
          className="tree-connector"
          style={{ left: depth * 20 - 12 }}
        />
      )}

      <div
        className={`tree-node ${isGen ? "tree-node--gen" : "tree-node--span"}`}
        style={{ marginLeft: depth * 20 }}
      >
        <div className="tree-node-row" onClick={() => hasChildren && setOpen(v => !v)}>
          {/* Type indicator */}
          <div
            className="tree-type-dot"
            style={{ background: color, opacity: isGen ? 1 : 0.45 }}
            title={node.type}
          />

          {/* Expand toggle */}
          {hasChildren ? (
            <span className="tree-toggle">{open ? "▾" : "▸"}</span>
          ) : (
            <span className="tree-toggle-spacer" />
          )}

          {/* Name */}
          <span className="tree-name" style={{ color: isGen ? color : "#4a7090" }}>
            {node.name}
          </span>
          <span className={`tree-badge tree-badge--${node.type.toLowerCase()}`}>
            {node.type}
          </span>

          {/* Stats */}
          <div className="tree-stats">
            {isGen && node.totalTokens > 0 && (
              <>
                <span className="tree-stat tree-stat--in" title="Input tokens">
                  ↑{fmtK(node.inputTokens)}
                </span>
                <span className="tree-stat tree-stat--out" title="Output tokens">
                  ↓{fmtK(node.outputTokens)}
                </span>
                {node.cost > 0 && (
                  <span className="tree-stat tree-stat--cost">{fmt$(node.cost)}</span>
                )}
              </>
            )}
            {node.latencyMs !== null && (
              <span className="tree-stat tree-stat--lat">{fmtMs(node.latencyMs)}</span>
            )}
          </div>
        </div>

        {/* Token bar for generations */}
        {isGen && node.totalTokens > 0 && (
          <div className="tree-token-bar" style={{ marginLeft: 32 }}>
            <div
              className="tree-token-bar-fill"
              style={{ width: `${barPct}%`, background: color + "55" }}
            />
          </div>
        )}

        {/* Model chip */}
        {isGen && node.model && (
          <div className="tree-model" style={{ marginLeft: 32 }}>{node.model}</div>
        )}
      </div>

      {/* Children */}
      {hasChildren && open && (
        <div className="tree-children">
          {node.children.map((child, i) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              isLast={i === node.children.length - 1}
              filterAgent={filterAgent}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TraceTree({ trace, filterAgent }: { trace: TraceData; filterAgent: string }) {
  if (trace.observations.length === 0) {
    return <p className="tree-empty">No span data available for this trace.</p>;
  }
  return (
    <div className="trace-tree">
      {trace.observations.map((root, i) => (
        <TreeNode
          key={root.id}
          node={root}
          depth={0}
          isLast={i === trace.observations.length - 1}
          filterAgent={filterAgent}
        />
      ))}
    </div>
  );
}

// ─── DIFF VIEW ────────────────────────────────────────────────────────────────
function DiffView({ a, b }: { a: TraceData; b: TraceData }) {
  // Build flat generation lists for both runs
  const flatGens = (obs: ObsNode[]): ObsNode[] => {
    const out: ObsNode[] = [];
    const walk = (nodes: ObsNode[]) => {
      for (const n of nodes) {
        if (n.type === "GENERATION") out.push(n);
        walk(n.children);
      }
    };
    walk(obs);
    return out;
  };

  const genA = flatGens(a.observations);
  const genB = flatGens(b.observations);

  // Align by name — gather all unique names in order
  const names = Array.from(new Set([...genA, ...genB].map(g => g.name)));

  const byName = (gens: ObsNode[], name: string) =>
    gens.filter(g => g.name === name);

  const diffClass = (va: number, vb: number) => {
    if (va === 0 && vb === 0) return "";
    const pct = ((vb - va) / (va || 1)) * 100;
    if (Math.abs(pct) < 5) return "";
    return pct > 0 ? "diff-worse" : "diff-better";
  };

  return (
    <div className="diff-view">
      <div className="diff-header">
        <div className="diff-col diff-col--label" />
        <div className="diff-col diff-col--a">
          <div className="diff-run-label">Run A</div>
          <div className="diff-run-sub">{fmtDate(a.timestamp)}</div>
          <div className="diff-run-repo mono">{(a.repoUrl ?? a.id).replace("https://github.com/", "")}</div>
        </div>
        <div className="diff-col diff-col--b">
          <div className="diff-run-label">Run B</div>
          <div className="diff-run-sub">{fmtDate(b.timestamp)}</div>
          <div className="diff-run-repo mono">{(b.repoUrl ?? b.id).replace("https://github.com/", "")}</div>
        </div>
      </div>

      {/* Summary row */}
      <div className="diff-section-label">TOTALS</div>
      {[
        { label: "Total tokens", va: a.totalTokens, vb: b.totalTokens, fmt: fmtK },
        { label: "Total cost", va: a.totalCost, vb: b.totalCost, fmt: fmt$ },
        { label: "Latency", va: a.totalLatencyMs ?? 0, vb: b.totalLatencyMs ?? 0, fmt: fmtMs },
      ].map(({ label, va, vb, fmt }) => (
        <div className="diff-row" key={label}>
          <div className="diff-col diff-col--label">{label}</div>
          <div className="diff-col diff-col--a mono">{(fmt as any)(va)}</div>
          <div className={`diff-col diff-col--b mono ${diffClass(va as number, vb as number)}`}>
            {(fmt as any)(vb)}
          </div>
        </div>
      ))}

      {/* Per-agent rows */}
      {names.length > 0 && (
        <>
          <div className="diff-section-label" style={{ marginTop: 12 }}>PER AGENT CALL</div>
          <div className="diff-header diff-subheader">
            <div className="diff-col diff-col--label">Agent call</div>
            <div className="diff-col diff-col--a">Tok / Cost / Lat</div>
            <div className="diff-col diff-col--b">Tok / Cost / Lat</div>
          </div>
          {names.map(name => {
            const ga = byName(genA, name)[0];
            const gb = byName(genB, name)[0];
            return (
              <div className="diff-row" key={name}>
                <div className="diff-col diff-col--label mono" style={{ color: agentColor(name) }}>
                  {name}
                </div>
                <div className="diff-col diff-col--a mono">
                  {ga ? `${fmtK(ga.totalTokens)} · ${fmt$(ga.cost)} · ${fmtMs(ga.latencyMs)}` : "—"}
                </div>
                <div className={`diff-col diff-col--b mono ${ga && gb ? diffClass(ga.cost, gb.cost) : ""}`}>
                  {gb ? `${fmtK(gb.totalTokens)} · ${fmt$(gb.cost)} · ${fmtMs(gb.latencyMs)}` : "—"}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ─── TRACE CARD ───────────────────────────────────────────────────────────────
function TraceCard({
  trace, filterAgent, onSelectDiff, diffSelected,
}: {
  trace: TraceData;
  filterAgent: string;
  onSelectDiff: (id: string) => void;
  diffSelected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"tree" | "table">("tree");

  // Build flat gen list for table view
  const flatGens = useMemo(() => {
    const out: ObsNode[] = [];
    const walk = (nodes: ObsNode[]) => {
      for (const n of nodes) {
        if (n.type === "GENERATION") out.push(n);
        walk(n.children);
      }
    };
    walk(trace.observations);
    return out;
  }, [trace.observations]);

  return (
    <div className={`trace-card ${open ? "trace-card--open" : ""} ${diffSelected ? "trace-card--diff-selected" : ""}`}>
      {/* Header */}
      <div className="trace-header-wrap">
        <button className="trace-header" onClick={() => setOpen(v => !v)}>
          <div className="trace-header-left">
            <span className="trace-chevron">{open ? "▾" : "▸"}</span>
            <div>
              <div className="trace-repo">
                {trace.repoUrl?.replace("https://github.com/", "") ?? trace.id.slice(0, 20) + "…"}
              </div>
              <div className="trace-ts">{fmtDate(trace.timestamp)}</div>
            </div>
          </div>
          <div className="trace-header-right">
            {trace.severity && (
              <span
                className="trace-severity"
                style={{ color: severityColor(trace.severity), borderColor: severityColor(trace.severity) + "55" }}
              >
                {trace.severity.toUpperCase()}{trace.cvss ? ` ${trace.cvss}` : ""}
              </span>
            )}
            <span className="trace-tokens mono">{fmtK(trace.totalTokens)} tok</span>
            {trace.totalLatencyMs && (
              <span className="trace-tokens mono" style={{ color: "#6a8fa8" }}>{fmtMs(trace.totalLatencyMs)}</span>
            )}
            <span className="trace-cost mono">{fmt$(trace.totalCost)}</span>
            <a href={trace.langfuseUrl} target="_blank" rel="noopener noreferrer"
               className="trace-lf-link" onClick={e => e.stopPropagation()}>
              Langfuse ↗
            </a>
          </div>
        </button>
        <button
          className={`diff-toggle-btn ${diffSelected ? "diff-toggle-btn--on" : ""}`}
          onClick={() => onSelectDiff(trace.id)}
          title="Select for diff comparison"
        >
          {diffSelected ? "✓ Diff" : "+ Diff"}
        </button>
      </div>

      {open && (
        <div className="trace-body">
          {/* Issue + files meta */}
          {trace.issueTitle && (
            <div className="trace-issue">
              <span className="trace-issue-label">Issue</span>
              {trace.issueUrl
                ? <a href={trace.issueUrl} target="_blank" rel="noopener noreferrer" className="result-link trace-issue-link">{trace.issueTitle} ↗</a>
                : <span className="trace-issue-title">{trace.issueTitle}</span>
              }
            </div>
          )}
          {trace.selectedFiles.length > 0 && (
            <div className="trace-files">
              <span className="trace-files-label">Files</span>
              {trace.selectedFiles.map(f => <span key={f} className="file-chip mono">{f}</span>)}
            </div>
          )}

          {/* Agents badge strip */}
          {trace.allAgents.length > 0 && (
            <div className="trace-agent-strip">
              {trace.allAgents.map(a => (
                <span key={a} className="agent-chip" style={{ borderColor: agentColor(a) + "66", color: agentColor(a) }}>
                  {a}
                </span>
              ))}
            </div>
          )}

          {/* Tab switcher */}
          <div className="trace-tabs">
            <button className={`trace-tab ${tab === "tree" ? "trace-tab--active" : ""}`} onClick={() => setTab("tree")}>
              Trace Tree
            </button>
            <button className={`trace-tab ${tab === "table" ? "trace-tab--active" : ""}`} onClick={() => setTab("table")}>
              Generation Table
            </button>
          </div>

          {tab === "tree" && <TraceTree trace={trace} filterAgent={filterAgent} />}

          {tab === "table" && (
            <div className="gen-table">
              <div className="gen-table-header">
                <span>Agent Call</span>
                <span>Model</span>
                <span>In tok</span>
                <span>Out tok</span>
                <span>Latency</span>
                <span>Cost</span>
              </div>
              {flatGens.length === 0
                ? <div style={{ padding: "10px 14px", color: "#6a8fa8", fontSize: 12 }}>No generations.</div>
                : flatGens.map(g => (
                    <div className="gen-row" key={g.id} style={{ gridTemplateColumns: "2fr 1.4fr 1fr 1fr 1fr 1fr" }}>
                      <div className="gen-name" style={{ color: agentColor(g.name) }}>{g.name}</div>
                      <div className="gen-model mono">{g.model ?? "—"}</div>
                      <div className="mono tok-in">{fmtK(g.inputTokens)}</div>
                      <div className="mono tok-out">{fmtK(g.outputTokens)}</div>
                      <div className="gen-latency mono">{fmtMs(g.latencyMs)}</div>
                      <div className="gen-cost mono cost-value">{fmt$(g.cost)}</div>
                    </div>
                  ))
              }
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── STAT CARD ────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
function TracingInner() {
  const { user, logout } = useAuth();
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Search / filter state
  const [search, setSearch] = useState("");
  const [filterAgent, setFilterAgent] = useState("");
  const [filterSeverity, setFilterSeverity] = useState("");

  // Diff selection — max 2 trace IDs
  const [diffIds, setDiffIds] = useState<string[]>([]);
  const [showDiff, setShowDiff] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/tracing/api");
      setData(await res.json());
    } catch (e: any) {
      setData({ error: e.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // All unique agents across all traces
  const allAgents = useMemo(() => {
    if (!data?.traces) return [];
    return Array.from(new Set(data.traces.flatMap(t => t.allAgents))).sort();
  }, [data]);

  // Filtered + searched traces
  const filtered = useMemo(() => {
    if (!data?.traces) return [];
    return data.traces.filter(t => {
      if (filterSeverity && t.severity?.toLowerCase() !== filterSeverity) return false;
      if (filterAgent && !t.allAgents.some(a => a.toLowerCase().includes(filterAgent.toLowerCase()))) return false;
      if (search) {
        const q = search.toLowerCase();
        const inRepo = t.repoUrl?.toLowerCase().includes(q);
        const inIssue = t.issueTitle?.toLowerCase().includes(q);
        const inId = t.id.toLowerCase().includes(q);
        const inAgent = t.allAgents.some(a => a.toLowerCase().includes(q));
        if (!inRepo && !inIssue && !inId && !inAgent) return false;
      }
      return true;
    });
  }, [data, search, filterAgent, filterSeverity]);

  const toggleDiff = (id: string) => {
    setDiffIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  };

  const diffTraces = useMemo(() => {
    if (!data?.traces || diffIds.length < 2) return null;
    const a = data.traces.find(t => t.id === diffIds[0]);
    const b = data.traces.find(t => t.id === diffIds[1]);
    return a && b ? { a, b } : null;
  }, [data, diffIds]);

  return (
    <main className="app">
      {/* ── Nav ── */}
      <nav className="top-nav">
        <Link href="/" className="nav-logo">ZeroDayOS</Link>
        <div className="nav-links">
          <Link href="/" className="nav-link">Scanner</Link>
          <Link href="/tracing" className="nav-link nav-link--active">Tracing</Link>
          <div className="nav-user">
            {user?.photoURL && (
              <Image src={user.photoURL} alt={user.displayName ?? "User"} width={28} height={28} className="nav-avatar" />
            )}
            <button className="nav-logout" onClick={logout}>Sign out</button>
          </div>
        </div>
      </nav>

      {/* ── Hero ── */}
      <header className="masthead" style={{ marginBottom: 28 }}>
        <div className="wordmark hero-wordmark">
          <span className="wordmark-badge hero-badge">Observability</span>
          <h1 className="hero-title" style={{ fontSize: 56 }}>Scan Cost & Trace Insights</h1>
        </div>
        <p className="subtitle hero-subtitle" style={{ fontSize: 18 }}>
          Every LLM call, token, and dollar — live from Langfuse.
        </p>
      </header>

      {/* ── Loading ── */}
      {loading && (
        <div className="tracing-loading">
          <div className="spinner tracing-spinner" />
          <span>Fetching traces from Langfuse…</span>
        </div>
      )}

      {/* ── Error ── */}
      {!loading && data?.error && (
        <div className="card tracing-error">
          <div className="card-title">Error</div>
          <p className="mono" style={{ color: "#8b0010", fontSize: 13 }}>{data.error}</p>
          {data.error.includes("not configured") && (
            <p style={{ marginTop: 10, color: "#4a7090", fontSize: 13 }}>
              Set <code className="mono">LANGFUSE_PUBLIC_KEY</code> and <code className="mono">LANGFUSE_SECRET_KEY</code>.
            </p>
          )}
        </div>
      )}

      {!loading && data?.summary && (
        <>
          {/* ── Summary stats ── */}
          <div className="stat-grid">
            <StatCard label="Total Scans" value={String(data.summary.totalRuns)} sub="last 30 runs" />
            <StatCard label="Total Tokens" value={fmtK(data.summary.totalTokens)} sub="across all runs" />
            <StatCard label="Total Cost" value={fmt$(data.summary.totalCost)} sub="USD" />
            <StatCard label="Avg Cost / Run" value={fmt$(data.summary.avgCostPerRun)} sub="USD per scan" />
            <StatCard label="Avg Latency" value={fmtMs(data.summary.avgLatencyMs)} sub="end-to-end" />
          </div>

          {/* ── Token distribution bar ── */}
          {data.traces && data.traces.length > 0 && (() => {
            const totalIn = data.traces!.reduce((a, t) => a + t.totalInputTokens, 0);
            const totalOut = data.traces!.reduce((a, t) => a + t.totalOutputTokens, 0);
            const total = totalIn + totalOut || 1;
            const inPct = ((totalIn / total) * 100).toFixed(1);
            const outPct = ((totalOut / total) * 100).toFixed(1);
            return (
              <div className="card token-ratio-card">
                <div className="card-title">Token Distribution</div>
                <div className="token-ratio-bar">
                  <div className="token-ratio-in" style={{ width: `${inPct}%` }} title={`Input ${inPct}%`} />
                  <div className="token-ratio-out" style={{ width: `${outPct}%` }} title={`Output ${outPct}%`} />
                </div>
                <div className="token-ratio-legend">
                  <span><span className="legend-dot legend-dot--in" />Input {inPct}% — {fmtK(totalIn)} tokens</span>
                  <span><span className="legend-dot legend-dot--out" />Output {outPct}% — {fmtK(totalOut)} tokens</span>
                </div>
              </div>
            );
          })()}

          {/* ── Diff view ── */}
          {diffIds.length === 2 && (
            <div className="card" style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <div className="card-title" style={{ marginBottom: 0 }}>
                  Run Diff
                  <span className="diff-count-badge">{diffIds.length}/2 selected</span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="refresh-btn" onClick={() => setShowDiff(v => !v)}>
                    {showDiff ? "Hide Diff" : "Show Diff"}
                  </button>
                  <button className="refresh-btn" onClick={() => { setDiffIds([]); setShowDiff(false); }}>
                    Clear
                  </button>
                </div>
              </div>
              {showDiff && diffTraces && <DiffView a={diffTraces.a} b={diffTraces.b} />}
              {showDiff && !diffTraces && (
                <p style={{ color: "#6a8fa8", fontSize: 13 }}>Select 2 runs using the "+ Diff" button.</p>
              )}
            </div>
          )}
          {diffIds.length === 1 && (
            <div className="diff-hint">Select one more run to compare →</div>
          )}

          {/* ── Search + filters ── */}
          <div className="card filter-bar">
            <div className="filter-bar-inner">
              <div className="search-wrap">
                <span className="search-icon">⌕</span>
                <input
                  className="search-input"
                  type="text"
                  placeholder="Search repo, issue title, agent, trace ID…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                {search && (
                  <button className="search-clear" onClick={() => setSearch("")}>✕</button>
                )}
              </div>

              <select
                className="filter-select"
                value={filterAgent}
                onChange={e => setFilterAgent(e.target.value)}
              >
                <option value="">All agents</option>
                {allAgents.map(a => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>

              <select
                className="filter-select"
                value={filterSeverity}
                onChange={e => setFilterSeverity(e.target.value)}
              >
                <option value="">All severities</option>
                {["critical", "high", "medium", "low"].map(s => (
                  <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                ))}
              </select>

              <button className="refresh-btn" onClick={load}>↻ Refresh</button>
            </div>

            {(search || filterAgent || filterSeverity) && (
              <div className="filter-result-count">
                Showing {filtered.length} of {data.traces!.length} runs
              </div>
            )}
          </div>

          {/* ── Run list ── */}
          <div className="card" style={{ padding: "18px 20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div className="card-title" style={{ marginBottom: 0 }}>Run History</div>
              {diffIds.length > 0 && (
                <span className="diff-hint-inline">{diffIds.length}/2 selected for diff</span>
              )}
            </div>

            {filtered.length === 0 ? (
              <p style={{ color: "#6a8fa8", fontSize: 13 }}>
                {data.traces!.length === 0 ? "No traces found. Run a scan first." : "No runs match your filters."}
              </p>
            ) : (
              <div className="trace-list">
                {filtered.map(t => (
                  <TraceCard
                    key={t.id}
                    trace={t}
                    filterAgent={filterAgent}
                    onSelectDiff={toggleDiff}
                    diffSelected={diffIds.includes(t.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </main>
  );
}

export default function TracingPage() {
  return (
    <AuthGuard>
      <TracingInner />
    </AuthGuard>
  );
}
