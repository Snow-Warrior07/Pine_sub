// Server-side route — fetches traces + full observation trees from Langfuse REST API.
// Builds parent-child span trees so the UI can render a proper trace timeline.

export const dynamic = "force-dynamic";

const LANGFUSE_HOST = process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";

function basicAuth() {
  const pub = process.env.LANGFUSE_PUBLIC_KEY ?? "";
  const sec = process.env.LANGFUSE_SECRET_KEY ?? "";
  return "Basic " + Buffer.from(`${pub}:${sec}`).toString("base64");
}

async function lfGet(path: string) {
  const res = await fetch(`${LANGFUSE_HOST}/api/public${path}`, {
    headers: { Authorization: basicAuth(), "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Langfuse API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ─── Types ────────────────────────────────────────────────────────────────────
export type ObsNode = {
  id: string;
  parentId: string | null;
  type: "SPAN" | "GENERATION" | "EVENT";
  name: string;
  startTime: string | null;
  endTime: string | null;
  latencyMs: number | null;
  // generation-only
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  input: unknown;
  output: unknown;
  metadata: Record<string, unknown>;
  // tree
  children: ObsNode[];
};

export type TraceData = {
  id: string;
  name: string;
  timestamp: string;
  repoUrl: string | null;
  issueUrl: string | null;
  issueTitle: string | null;
  severity: string | null;
  cvss: number | null;
  selectedFiles: string[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCost: number;
  totalLatencyMs: number | null;
  observations: ObsNode[];   // root-level spans/generations (tree already built)
  allAgents: string[];        // unique agent names from generation names
  langfuseUrl: string;
};

export type Summary = {
  totalRuns: number;
  totalTokens: number;
  totalCost: number;
  avgCostPerRun: number;
  avgLatencyMs: number;
};

// ─── Build parent-child tree ──────────────────────────────────────────────────
function buildTree(obs: any[]): ObsNode[] {
  const map = new Map<string, ObsNode>();

  // First pass: build all nodes
  for (const o of obs) {
    const inp = o.usage?.input ?? 0;
    const out = o.usage?.output ?? 0;
    const cost = typeof o.calculatedTotalCost === "number" ? o.calculatedTotalCost : 0;
    const latMs = typeof o.latency === "number" ? o.latency : null;

    map.set(o.id, {
      id: o.id,
      parentId: o.parentObservationId ?? null,
      type: o.type ?? "SPAN",
      name: o.name ?? "(unnamed)",
      startTime: o.startTime ?? null,
      endTime: o.endTime ?? null,
      latencyMs: latMs,
      model: o.model ?? null,
      inputTokens: inp,
      outputTokens: out,
      totalTokens: inp + out,
      cost,
      input: o.input ?? null,
      output: o.output ?? null,
      metadata: o.metadata ?? {},
      children: [],
    });
  }

  // Second pass: wire children
  const roots: ObsNode[] = [];
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by startTime
  const sortLevel = (nodes: ObsNode[]) => {
    nodes.sort((a, b) =>
      (a.startTime ?? "").localeCompare(b.startTime ?? "")
    );
    for (const n of nodes) sortLevel(n.children);
  };
  sortLevel(roots);

  return roots;
}

function collectAgents(roots: ObsNode[]): string[] {
  const names = new Set<string>();
  const walk = (nodes: ObsNode[]) => {
    for (const n of nodes) {
      if (n.type === "GENERATION") {
        // Name is like "Recon LLM call" — extract agent prefix
        const agent = n.name.replace(/\s*(LLM\s*call|generation|gen)\s*$/i, "").trim();
        if (agent) names.add(agent);
      }
      walk(n.children);
    }
  };
  walk(roots);
  return Array.from(names).sort();
}

// ─── GET handler ──────────────────────────────────────────────────────────────
export async function GET() {
  const missing = !process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY;
  if (missing) {
    return Response.json(
      { error: "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not configured" },
      { status: 503 }
    );
  }

  try {
    // 1. Latest 30 traces tagged zerodayos
    const tracesRes: any = await lfGet("/traces?limit=30&tags=zerodayos");
    const traces: any[] = tracesRes?.data ?? [];

    // 2. Enrich each trace — fetch ALL observation types (spans + generations + events)
    const enriched: TraceData[] = await Promise.all(
      traces.map(async (trace: any): Promise<TraceData> => {
        try {
          const obsRes: any = await lfGet(
            `/observations?traceId=${trace.id}&limit=100`
          );
          const rawObs: any[] = obsRes?.data ?? [];

          const tree = buildTree(rawObs);

          // Aggregate from raw obs directly (no double-count from tree walk)
          let totalInputTokens = 0;
          let totalOutputTokens = 0;
          let totalCost = 0;

          for (const o of rawObs) {
            if (o.type === "GENERATION") {
              totalInputTokens += o.usage?.input ?? 0;
              totalOutputTokens += o.usage?.output ?? 0;
              totalCost += typeof o.calculatedTotalCost === "number" ? o.calculatedTotalCost : 0;
            }
          }

          // Total latency from trace-level timestamps
          let totalLatencyMs: number | null = null;
          if (trace.createdAt && trace.updatedAt) {
            totalLatencyMs = new Date(trace.updatedAt).getTime() - new Date(trace.createdAt).getTime();
            if (totalLatencyMs < 0) totalLatencyMs = null;
          }

          return {
            id: trace.id,
            name: trace.name ?? "scan",
            timestamp: trace.timestamp,
            repoUrl: trace.input?.repoUrl ?? null,
            issueUrl: trace.output?.issueUrl ?? null,
            issueTitle: trace.output?.issueTitle ?? null,
            severity: trace.output?.severity ?? null,
            cvss: trace.output?.cvss ?? null,
            selectedFiles: trace.output?.selectedFiles ?? [],
            totalInputTokens,
            totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
            totalCost,
            totalLatencyMs,
            observations: tree,
            allAgents: collectAgents(tree),
            langfuseUrl: `${LANGFUSE_HOST}/trace/${trace.id}`,
          };
        } catch {
          return {
            id: trace.id,
            name: trace.name ?? "scan",
            timestamp: trace.timestamp,
            repoUrl: trace.input?.repoUrl ?? null,
            issueUrl: null, issueTitle: null, severity: null, cvss: null,
            selectedFiles: [],
            totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, totalCost: 0,
            totalLatencyMs: null,
            observations: [],
            allAgents: [],
            langfuseUrl: `${LANGFUSE_HOST}/trace/${trace.id}`,
          };
        }
      })
    );

    // 3. Summary
    const validLatencies = enriched.filter(t => t.totalLatencyMs !== null);
    const summary: Summary = {
      totalRuns: enriched.length,
      totalTokens: enriched.reduce((a, t) => a + t.totalTokens, 0),
      totalCost: enriched.reduce((a, t) => a + t.totalCost, 0),
      avgCostPerRun: enriched.length
        ? enriched.reduce((a, t) => a + t.totalCost, 0) / enriched.length
        : 0,
      avgLatencyMs: validLatencies.length
        ? validLatencies.reduce((a, t) => a + t.totalLatencyMs!, 0) / validLatencies.length
        : 0,
    };

    return Response.json({ traces: enriched, summary });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
