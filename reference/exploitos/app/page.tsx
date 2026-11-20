"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import Image from "next/image";
import { useState } from "react";

import { useAuth } from "../lib/AuthContext";
import AuthGuard from "../lib/AuthGuard";
import type { FlowState, TeamStatus } from "./AgentFlowChart";

// Lazy-load the flow chart (it uses browser APIs)
const AgentFlowChart = dynamic(() => import("./AgentFlowChart"), {
  ssr: false,
});

// ─── Types ────────────────────────────────────────────────────────────────────
type Phase = "start" | "thinking" | "done" | "error";
type AgentRow = { agent: string; phase: Phase; message: string };

const AGENT_META: Record<string, { icon: string; order: number }> = {
  Orchestrator: { icon: "O", order: 0 },
  Recon: { icon: "R", order: 1 },
  Analyst: { icon: "A", order: 2 },
  Validator: { icon: "V", order: 3 },
  Remediation: { icon: "M", order: 4 },
  Reporter: { icon: "P", order: 5 },
};

const PIPELINE_ORDER = [
  "Orchestrator",
  "Recon",
  "Analyst",
  "Validator",
  "Remediation",
  "Reporter",
];

// Which "team" each agent belongs to
const AGENT_TO_TEAM: Record<string, keyof FlowState> = {
  Orchestrator: "manager",
  Recon: "securityLead",
  Analyst: "securityLead",
  Validator: "securityLead",
  Remediation: "patchEngineer",
  Reporter: "codeIntegration",
};

function statusClass(phase: Phase) {
  if (phase === "thinking") return "status status-thinking";
  if (phase === "done") return "status status-done";
  if (phase === "error") return "status status-error";
  return "status status-start";
}

function deriveFlowState(rows: AgentRow[]): FlowState {
  const base: FlowState = {
    manager: "idle",
    securityLead: "idle",
    patchEngineer: "idle",
    codeIntegration: "idle",
  };

  // Build per-team aggregated status
  const teamRows: Record<keyof FlowState, AgentRow[]> = {
    manager: [],
    securityLead: [],
    patchEngineer: [],
    codeIntegration: [],
  };

  for (const row of rows) {
    const t = AGENT_TO_TEAM[row.agent];
    if (t) teamRows[t].push(row);
  }

  for (const [team, trows] of Object.entries(teamRows) as [
    keyof FlowState,
    AgentRow[],
  ][]) {
    if (trows.length === 0) {
      base[team] = "idle";
      continue;
    }
    if (trows.some((r) => r.phase === "error")) {
      base[team] = "error";
      continue;
    }
    if (trows.some((r) => r.phase === "thinking" || r.phase === "start")) {
      base[team] = "working";
      continue;
    }
    if (trows.every((r) => r.phase === "done")) {
      base[team] = "done";
      continue;
    }
    base[team] = "working";
  }

  return base;
}

// ─── Main page ────────────────────────────────────────────────────────────────
function HomeInner() {
  const { user, logout } = useAuth();
  const [repoUrl, setRepoUrl] = useState("https://github.com/OWASP/NodeGoat");
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [showActivity, setShowActivity] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [showError, setShowError] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [issueTitle, setIssueTitle] = useState(
    "Pristine GitHub Issue is Ready",
  );
  const [issueUrl, setIssueUrl] = useState("#");
  const [scanning, setScanning] = useState(false);
  const [lastEvent, setLastEvent] = useState<{
    agent: string;
    phase: Phase;
  } | null>(null);

  const flowState = deriveFlowState(rows);

  const appendAgent = (agent: string, phase: Phase, message: string) => {
    setRows((prev) => {
      const index = prev.findIndex((item) => item.agent === agent);
      if (index === -1) return [...prev, { agent, phase, message }];
      const next = [...prev];
      next[index] = { ...next[index], phase, message };
      return next;
    });
    setLastEvent({ agent, phase });
  };

  const pipelineClass = (agent: string) => {
    let className = "pipeline-step";
    if (!lastEvent) return className;
    const current = AGENT_META[lastEvent.agent];
    if (!current) return className;
    const order = AGENT_META[agent]?.order ?? 99;
    if (order < current.order) className += " done";
    if (agent === lastEvent.agent)
      className += lastEvent.phase === "done" ? " done" : " active";
    return className;
  };

  const startScan = async () => {
    const cleanRepo = repoUrl.trim();
    if (!cleanRepo) {
      alert("Enter a GitHub repo URL");
      return;
    }

    setScanning(true);
    setRows([]);
    setLastEvent(null);
    setShowActivity(true);
    setShowResult(false);
    setShowError(false);
    setErrorMsg("");

    try {
      const resp = await fetch("/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: cleanRepo,
          targetFile: "package.json",
        }),
      });

      const reader = resp.body?.getReader();
      if (!reader) throw new Error("Unable to read scan stream");
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          const line = part.replace(/^data: /, "").trim();
          if (!line) continue;
          let ev: any;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }

          if (ev.type === "progress") {
            appendAgent(ev.agent, ev.phase, ev.message);
          } else if (ev.type === "done") {
            appendAgent(
              "Orchestrator",
              "done",
              `Issue #${ev.issueNumber} created`,
            );
            setIssueTitle(ev.issueTitle || "Pristine GitHub Issue is Ready");
            setIssueUrl(ev.issueUrl);
            setShowResult(true);
            setScanning(false);
          } else if (ev.type === "error") {
            appendAgent("Orchestrator", "error", ev.message || "Scan failed");
            setErrorMsg(`ERROR: ${ev.message}`);
            setShowError(true);
            setScanning(false);
          }
        }
      }
    } catch (err: any) {
      setErrorMsg(`ERROR: ${err.message}`);
      setShowError(true);
      setScanning(false);
    }
  };

  return (
    <main className="app">
      {/* ── Nav ─────────────────────────────────────────────── */}
      <nav className="top-nav">
        <Link href="/" className="nav-logo">
          ZeroDayOS
        </Link>
        <div className="nav-links">
          <Link href="/" className="nav-link nav-link--active">
            Scanner
          </Link>
          <Link href="/tracing" className="nav-link">
            Tracing
          </Link>
          <div className="nav-user">
            {user?.photoURL && (
              <Image
                src={user.photoURL}
                alt={user.displayName ?? "User"}
                width={28}
                height={28}
                className="nav-avatar"
              />
            )}
            <button className="nav-logout" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      </nav>

      {/* ── Hero masthead ─────────────────────────────────── */}
      <header className="masthead">
        <div className="wordmark hero-wordmark">
          <span className="wordmark-badge hero-badge">ZeroDayOS</span>
          <h1 className="hero-title">Find. Exploit. Fix. Automatically</h1>
        </div>
        <p className="subtitle hero-subtitle">
          Bold, confident vulnerability testing with AI Security Engineers
          driving one decisive GitHub issue.
        </p>
      </header>

      {/* ── Input / result card ───────────────────────────── */}
      {!showResult && (
        <section className="card" id="scanPanel">
          <div className="card-title">Scan Input</div>
          <label className="label" htmlFor="repoUrl">
            Repository URL
          </label>
          <input
            className="field"
            type="text"
            id="repoUrl"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/OWASP/NodeGoat"
            style={{ color: "#003d80" }}
          />
          <button id="scanBtn" onClick={startScan} disabled={scanning}>
            {scanning ? "SCANNING..." : "INITIATE SCAN"}
          </button>
        </section>
      )}

      {showResult && (
        <section className="card visible" id="resultBox">
          <div className="result-title">Issue Generated</div>
          <div className="result-heading">{issueTitle}</div>
          <a
            id="issueLink"
            className="result-link"
            href={issueUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            View on GitHub → {issueUrl}
          </a>
        </section>
      )}

      {/* ── Two-column workspace ──────────────────────────── */}
      {showActivity && (
        <div className="workspace">
          {/* LEFT — React Flow org chart */}
          <div className="workspace-flow card">
            <div className="card-title">Team Overview</div>
            <div className="flow-canvas">
              <AgentFlowChart flowState={flowState} />
            </div>
          </div>

          {/* RIGHT — pipeline + log */}
          <div className="workspace-logs">
            <section className="card visible" id="activityPanel">
              <div className="card-title">Live Agent Activity</div>
              <div className="pipeline" id="pipeline">
                {PIPELINE_ORDER.map((agent) => (
                  <div
                    className={pipelineClass(agent)}
                    id={`pipe-${agent}`}
                    key={agent}
                  >
                    {agent}
                  </div>
                ))}
              </div>

              <div id="agentLog">
                {rows.map((row) => (
                  <div
                    className={`agent-row ${row.phase}`}
                    data-agent={row.agent}
                    key={row.agent}
                  >
                    <div className="agent-icon">
                      {AGENT_META[row.agent]?.icon ?? "?"}
                    </div>
                    <div className="agent-main">
                      <div className="agent-meta">
                        <span className="agent-name">{row.agent}</span>
                        <span className="phase-chip">{row.phase}</span>
                      </div>
                      <div className="agent-message">{row.message}</div>
                    </div>
                    <div className={statusClass(row.phase)}>
                      {row.phase === "thinking" ? (
                        <div className="spinner" />
                      ) : row.phase === "done" ? (
                        "✓"
                      ) : row.phase === "error" ? (
                        "!"
                      ) : (
                        "•"
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {showError && (
              <section className="card visible" id="errorBox">
                {errorMsg}
              </section>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

export default function Home() {
  return (
    <AuthGuard>
      <HomeInner />
    </AuthGuard>
  );
}
