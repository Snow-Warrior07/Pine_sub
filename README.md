# ZeroDayOS — AI AppSec Team

**One click. Five AI specialists. A production-quality GitHub security issue, automatically.**

ZeroDayOS replaces the human workflow of vulnerability triage and reporting. A Security Lead points it at any GitHub repository. Five specialized AI agents autonomously discover the codebase, identify the highest-severity vulnerability, validate exploitability, draft a patch, and open a senior-engineer-quality GitHub Issue — without any human intervention at any step.

**Live demo:** [exploitos.up.railway.app](https://exploitos.up.railway.app)
**Example output:** [github.com/OWASP/NodeGoat/issues/395](https://github.com/OWASP/NodeGoat/issues/395)

---

## The Magic Moment

The Security Lead watches five AI agents debate a vulnerability in real-time — each agent's reasoning streamed live to the UI — and then a pristine, actionable GitHub Issue appears automatically on the target repository. The issue is indistinguishable from a report written by a senior security engineer.

**Human function replaced:** Vulnerability triage and reporting cycle. A typical security team spends 2–4 hours per Dependabot/SAST alert: reproducing, validating, writing the report, assigning severity, drafting remediation. ZeroDayOS does it in under 2 minutes for under $0.20.

---

## Working Product — Real Output on Real Surfaces (L5)

ZeroDayOS does not produce canned responses or staged output. Every scan:

1. **Fetches real code** from the target GitHub repository via the GitHub API (no mocking, no fixtures in production)
2. **Runs 5 LLM agents sequentially**, each reasoning about the previous agent's output
3. **Opens a real GitHub Issue** on the scanned repository — not a demo repo, not a dashboard — the actual target repo
4. **Completes end-to-end autonomously** — no human approval required at any step

**Verified live output on public repos:**
- [OWASP/NodeGoat #394](https://github.com/OWASP/NodeGoat/issues/394) — Critical: Plaintext Password Storage + NoSQL Injection (CVSS 9.1)
- [OWASP/NodeGoat #395](https://github.com/OWASP/NodeGoat/issues/395) — Critical: Plaintext Password Storage + NoSQL Injection (CVSS 9.1)

The output includes: severity badge, CVSS v3.1 vector with justification, CWE mapping, attack scenario walkthrough, Proof of Concept, Validator confirmation with evidence, copy-pasteable unified diff patch, additional hardening recommendations, OWASP/CWE references, and an estimated "hours saved" calculation.

---

## Agent Org Structure — Dynamic Delegation (L4)

ZeroDayOS implements a **managed, multi-specialist agent team** with a clear organizational hierarchy. The Orchestrator acts as the manager, dynamically routing the task through specialists based on what each agent discovers.

```
┌─────────────────────────────────────────────────────┐
│                    ORCHESTRATOR                      │
│              (Manager / Task Router)                 │
└─────────┬────────────────────────────────────────────┘
          │ dispatches full pipeline, monitors for errors
          ▼
┌─────────────────────┐
│   RECON SPECIALIST  │  Phase 1: Fetch full file tree (GitHub Trees API)
│                     │  Phase 2: LLM selects 1-2 highest-value targets
│                     │  Phase 3: Fetch files, write intelligence brief
└─────────┬───────────┘
          │ passes: selected_files + file_content + recon_summary
          ▼
┌─────────────────────┐
│   ANALYST           │  Maps vuln to CWE, scores CVSS v3.1, describes attack
└─────────┬───────────┘
          │ passes: vulnerability_name, cwe_id, severity, cvss_score, vector
          ▼
┌─────────────────────┐
│   EXPLOIT VALIDATOR │  Independently verifies exploit path reachability
└─────────┬───────────┘
          │ passes: exploit_reachable, confidence, evidence, verdict
          ▼
┌─────────────────────┐
│   REMEDIATION ENG.  │  Produces minimal patch + valid unified diff
└─────────┬───────────┘
          │ passes: patched_code, code_diff, additional_hardening
          ▼
┌─────────────────────┐
│   REPORTER          │  Assembles production-quality GitHub Issue markdown
└─────────────────────┘
          │ final output → GitHub Issues API → live issue on target repo
```

**Key architectural decisions:**
- Each agent receives only the structured output of the previous agent — no monolithic prompt, no context bleed
- The Recon agent **dynamically selects which files to scan** based on a priority rubric (auth files > dependency manifests > DB queries > API routes > config). This means the system self-adapts to each repository's structure — it does not require a hardcoded file path
- Agents are typed: each agent's output is a strict TypeScript interface; downstream agents receive only what they need
- The Validator acts as an **independent check** on the Analyst — it can disagree and flag low-confidence findings

---

## Observability — Production-Grade Trace Tree (L5)

Every scan is fully instrumented from day one. Observability is not bolted on — it was wired in at Iteration 0.

### What is captured per LLM call

Every call to the model records a **Langfuse generation** containing:

| Field | Detail |
|---|---|
| Agent name | e.g. `"Analyst LLM call"`, `"Recon-FilePicker LLM call"` |
| Model | `claude-sonnet-4-6` |
| Input tokens | exact count from API response |
| Output tokens | exact count from API response |
| Total tokens | sum |
| Latency | milliseconds, wall-clock |
| Full prompt | system prompt + message array |
| Full response | raw model output |
| Stop reason | e.g. `end_turn`, `max_tokens` |
| Cost per call | from Zen API response |
| Cache tokens | read and write cache token counts |

### What the Tracing Dashboard shows (`/tracing`)

- **Summary cards:** Total scans, total tokens, total cost (USD), avg cost per run, avg latency
- **Token distribution bar:** visual input vs. output split across all runs
- **Per-trace detail:** repo, timestamp, severity badge + CVSS score, total tokens, latency, cost, direct Langfuse link
- **Trace Tree view:** hierarchical nested tree of every agent span with connector lines, token proportion bars, model chip, per-node cost and latency
- **Generation Table view:** flat table of all LLM calls with columns for agent, model, input tokens, output tokens, latency, cost
- **Run Diff:** select any 2 traces for side-by-side comparison of tokens, cost, latency, with color-coded better/worse indicators per agent call
- **Filters:** full-text search (repo URL, issue title, agent name, trace ID), agent dropdown, severity dropdown

### Langfuse Dataset & Scores

All eval runs push scores to the `zerodayos-eval` Langfuse dataset. Per fixture: 5 named dimension scores (`analyst_accuracy`, `validator_quality`, `patch_correctness`, `report_quality`, `overall_usefulness`) plus an aggregate `total_score`. This enables trend analysis across prompt versions.

### Local JSONL tracer

Every agent step also writes to `traces/<runId>.jsonl` — a structured log with timestamp, agent name, phase (`start`/`thinking`/`done`/`error`), message, and data payload. Useful for debugging without a Langfuse account.

---

## Evaluation and Iteration — Automated CI Quality Gate (L4/L5)

ZeroDayOS ships with a **closed-loop eval pipeline** that runs on every push to `main` and blocks deployment if output quality drops.

### Eval architecture

```
npm run eval
     │
     ├── 4 golden fixtures (known-vulnerable code snippets)
     │     sqli-001          — SQL Injection (CWE-89, CVSS ≥ 8.0)
     │     hardcoded-secret-002 — Hardcoded Credentials (CWE-798, CVSS ≥ 7.0)
     │     path-traversal-003 — Path Traversal (CWE-22, CVSS ≥ 7.0)
     │     xss-004           — Stored XSS (CWE-79, CVSS ≥ 6.0)
     │
     ├── Per fixture: run Analyst → Validator → Remediation → Reporter
     │   (Recon is bypassed — fixture snippet injected directly)
     │
     ├── Rule-based checks (deterministic, instant)
     │     CWE match, CVSS floor, severity floor, exploit reachability,
     │     patch content, required strings in issue body
     │
     ├── LLM-as-judge scoring (5 dimensions × 2 pts = 10 max)
     │     analyst_accuracy, validator_quality, patch_correctness,
     │     report_quality, overall_usefulness
     │
     ├── Threshold: 6/10 per fixture
     │
     └── Exit 0 (pass) or Exit 1 (fail → CI blocks release)
```

### CI integration (GitHub Actions)

- Triggers: every push to `main`, every PR targeting `main`, manual dispatch
- Runner: `ubuntu-latest`, Node 22, 20-minute timeout
- Secrets injected: LLM API key, GitHub token, Langfuse keys
- On failure: JSONL traces uploaded as artifact (7-day retention) for debugging
- All runs push scores to the **Langfuse `zerodayos-eval` dataset** — trend visible over time

**Current score: 4/4 fixtures passing, 40/40 points, avg 10.0/10.**

### Prompt versioning and iteration

Prompts are version-controlled in `src/agents.ts`. To iterate:
1. Edit a system prompt
2. Push to `main`
3. GitHub Actions runs the eval in ~6 minutes
4. Langfuse dataset shows the score delta per dimension
5. If any fixture drops below 6/10 → CI gate fails → Railway does not deploy

---

## Agent Handoffs and Memory

Each agent receives the **full structured output** of all upstream agents — not just a summary, not just a string. This means:

- The **Validator** receives the complete `AnalystOutput` JSON, including CVSS vector, affected code, and attack scenario — it can reason about the specific claims
- The **Remediation** agent receives the complete `AnalystOutput` to understand exactly what it is patching
- The **Reporter** receives all four upstream outputs simultaneously and cross-references them to produce a coherent, non-contradictory report

This is **short-term memory within a single task** — every agent in the chain has access to the accumulated intelligence of all previous agents via structured typed handoffs.

The handoff format is strict TypeScript interfaces, ensuring agents cannot hallucinate missing fields and downstream agents always receive well-formed input.

---

## Cost and Latency

| Metric | Value |
|---|---|
| End-to-end latency | ~90 seconds |
| Cost per scan | ~$0.15–$0.20 |
| Model | claude-sonnet-4-6 via OpenCode Zen |
| LLM calls per scan | 6 (FilePicker, Summary, Analyst, Validator, Remediation, Reporter) |
| Most expensive call | Reporter (~$0.07, highest output tokens) |
| Cheapest call | Recon-FilePicker (~$0.005, 200 token output cap) |

Token breakdown from a representative run (OWASP/NodeGoat):

| Agent | Input tokens | Output tokens | Cost |
|---|---|---|---|
| Recon-FilePicker | 1,412 | 29 | $0.0047 |
| Recon-Summary | 1,767 | 138 | $0.0074 |
| Analyst | 2,036 | 975 | $0.0207 |
| Validator | 2,793 | 584 | $0.0171 |
| Remediation | 2,842 | 1,933 | $0.0375 |
| Reporter | 5,845 | 3,647 | $0.0722 |
| **Total** | **16,695** | **7,306** | **~$0.16** |

---

## Management UI

The ZeroDayOS UI is a Next.js 15 application accessible to non-technical users.

**Scanner page (`/`):**
- Single input: GitHub repository URL (pre-filled with `https://github.com/OWASP/NodeGoat`)
- "INITIATE SCAN" button — no other configuration required
- Live agent activity panel: each of the 5 agents appears as they start, show a pulsing indicator while thinking, and lock in with a checkmark when done
- React Flow org chart showing the team hierarchy (Manager → Security Lead + Patch Engineer → Code Integration) with nodes animating in real-time as agents activate
- Result card: GitHub Issue URL, direct link, files scanned as pill tags

**Tracing page (`/tracing`):**
- Full observability dashboard — cost, tokens, latency per run
- Run diff for comparing prompt versions
- Filter by agent, severity, repo

**Authentication:** Google Sign-In via Firebase Auth. The app is not publicly open — users sign in before accessing the scanner.

**Deployment:** Railway (Dockerized, Next.js production build). Auto-deploys on push to `main`.

---

## Architecture

```
app/                    Next.js 15 frontend (App Router)
├── page.tsx            Scanner UI with SSE stream + React Flow
├── AgentFlowChart.tsx  Live org chart (React Flow)
├── tracing/            Observability dashboard
│   ├── page.tsx        Trace tree, run diff, cost breakdown
│   └── api/route.ts    Fetches Langfuse REST API
└── scan/route.ts       POST /scan → SSE stream → pipeline

src/                    Agent backend (TypeScript, Node.js)
├── agents.ts           5 agent definitions + system prompts
├── pipeline.ts         Orchestrator — runs full chain
├── llm.ts              Zen API wrapper + Langfuse generation recording
├── langfuse.ts         Singleton Langfuse client
├── github.ts           GitHub Issues API + file tree fetcher
├── tracer.ts           Local JSONL tracer (traces/*.jsonl)
└── run.ts              CLI entrypoint

eval/                   Quality gate
├── fixtures.ts         4 golden test cases
├── scorer.ts           Rule checks + LLM-as-judge (5 dimensions)
└── run.ts              CI orchestrator, exits 1 on regression

.github/workflows/
└── eval.yml            Runs on push to main, blocks release on failure
```

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15, React 19, React Flow, Lottie, Tailwind CSS 4 |
| Backend | Node.js 22, TypeScript, Express 5 |
| LLM | Claude Sonnet 4.6 via OpenCode Zen (`/v1/messages`) |
| Observability | Langfuse (traces, generations, datasets, scores) |
| Auth | Firebase Auth (Google Sign-In) |
| GitHub Integration | GitHub REST API (Issues, Trees, Contents) |
| CI | GitHub Actions (eval quality gate) |
| Deployment | Railway (Dockerized Next.js) |

---

## Running Locally

```bash
# Clone
git clone https://github.com/HemantKumar01/ExploitOS
cd ExploitOS

# Install
npm install

# Configure — copy and fill in your keys
cp .env.example .env
# Required: ZEN_API_KEY, GITHUB_TOKEN, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY

# CLI scan (no UI needed)
npm run scan

# Full web UI
npm run dev   # → http://localhost:3000

# Run eval quality gate
npm run eval

# Run a single fixture
npm run eval -- --fixture sqli-001
```

### Environment Variables

| Variable | Description |
|---|---|
| `ZEN_API_KEY` | OpenCode Zen API key |
| `ZEN_BASE_URL` | Default: `https://opencode.ai/zen/v1` |
| `MODEL` | Default: `claude-sonnet-4-6` |
| `GITHUB_TOKEN` | GitHub PAT (needs repo Issues write + Contents read) |
| `LANGFUSE_PUBLIC_KEY` | Langfuse project public key |
| `LANGFUSE_SECRET_KEY` | Langfuse project secret key |
| `LANGFUSE_HOST` | Default: `https://cloud.langfuse.com` |

---

## What ZeroDayOS Does NOT Do

- No deep SAST scanning of entire codebases (scans 1–2 files per run, selected autonomously)
- No auto-opening Pull Requests (Issues only — safer, no git conflict risk)
- No user authentication management (single-provider Google Sign-In only)
- No historical vulnerability dashboards with charts
- No mobile UI (desktop only)

---

## Repository

**GitHub:** [github.com/HemantKumar01/ExploitOS](https://github.com/HemantKumar01/ExploitOS)
**Live:** [exploitos.railway.app](https://exploitos.railway.app)
**Langfuse Dataset:** [cloud.langfuse.com/datasets/zerodayos-eval](https://cloud.langfuse.com/datasets/zerodayos-eval)
