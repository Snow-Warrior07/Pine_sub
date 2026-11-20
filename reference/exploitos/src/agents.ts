// All 5 agent definitions for ZeroDayOS.
// Chain: Recon -> Analyst -> Validator -> Remediation -> Reporter
import { chat, chatJSON } from "./llm";
import type { Tracer } from "./tracer";
import type { LangfuseTraceClient } from "./langfuse";
import "dotenv/config";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;

// ─── Shared types ────────────────────────────────────────────────────────────

export type ReconOutput = {
  repo: string;
  selected_files: string[];   // files the LLM chose to scan
  file_content: string;       // concatenated content of all selected files
  recon_summary: string;      // 1-3 sentences describing what was found
};

export type AnalystOutput = {
  vulnerability_name: string;
  cwe_id: string;
  severity: "Critical" | "High" | "Medium" | "Low" | "Info";
  cvss_score: number;
  cvss_vector: string;
  cvss_justification: string;
  affected_code: string;
  attack_scenario: string;
  reasoning: string;
};

export type ValidatorOutput = {
  exploit_reachable: boolean;
  confidence: "High" | "Medium" | "Low";
  evidence: string;       // what in the code confirms/denies reachability
  mitigating_factors: string[];
  verdict: string;        // 1-sentence plain-English conclusion
};

export type RemediationOutput = {
  fix_summary: string;
  patched_code: string;
  code_diff: string;
  additional_hardening: string[];
  references: string[];
};

export type ReporterOutput = {
  markdown: string;       // full GitHub Issue body, ready to POST
  issue_title: string;
};

// ─── SYSTEM PROMPTS ──────────────────────────────────────────────────────────

// Phase 1: given the file tree, pick the most security-relevant files (max 2).
const RECON_FILE_PICKER_SYSTEM = `You are the RECON SPECIALIST on an AI AppSec team.
You have been given the full file tree of a GitHub repository.
Your job: identify the 1-2 files most likely to contain high-severity security vulnerabilities.

Priority order (pick from these categories, highest first):
1. Authentication / session / JWT / OAuth files (auth.js, login.js, session.ts, passport.js, etc.)
2. Dependency manifests (package.json, requirements.txt, Gemfile, go.mod, pom.xml)
3. Database query / ORM files (db.js, queries.js, models/)
4. API route handlers (routes/, controllers/, api/)
5. Configuration files with secrets risk (.env.example, config.js, settings.py)

Rules:
- Pick AT MOST 2 files. Quality over quantity.
- Prefer concrete source files over build/test/doc files.
- Never pick: README, .gitignore, lock files, test fixtures, images, fonts.
- If a package.json AND an auth file exist, pick both.

Output contract (STRICT): Return ONLY a single JSON object, no prose, no markdown fences.
Schema:
{ "selected_files": string[] }   // relative paths e.g. ["package.json", "app/routes/login.js"]`;

// Phase 2: summarise the fetched files for the Analyst.
const RECON_SUMMARY_SYSTEM = `You are the RECON SPECIALIST on an AI AppSec team.
You have fetched the files chosen for security review.
Summarise your findings in 2-4 sentences for the Analyst.
Be terse and factual. Name specific packages, functions, or patterns that look dangerous.
Do NOT attempt full vulnerability classification — that is the Analyst's job.
Do NOT echo file content in your response.

Output contract (STRICT): Return ONLY a single JSON object, no prose, no markdown fences.
Schema:
{ "recon_summary": string }`;

const ANALYST_SYSTEM = `You are the ANALYST specialist on an AI AppSec team.
Role: You receive a raw source code or dependency file plus a Recon summary. You identify the
primary vulnerability, map it to CWE, assign a CVSS v3.1 base score with vector, and describe
a realistic attack scenario.

You are rigorous and use standard infosec terminology (OWASP, CWE, CVSS).
Do not hedge. If the code is vulnerable, state it plainly.

Output contract (STRICT): Return ONLY a single JSON object, no prose, no markdown fences.
Schema:
{
  "vulnerability_name": string,
  "cwe_id": string,
  "severity": "Critical"|"High"|"Medium"|"Low"|"Info",
  "cvss_score": number,
  "cvss_vector": string,
  "cvss_justification": string,
  "affected_code": string,
  "attack_scenario": string,
  "reasoning": string
}`;

const VALIDATOR_SYSTEM = `You are the EXPLOIT VALIDATOR on an AI AppSec team.
Role: You receive the Analyst's vulnerability report and the original source file.
Your job is to logically verify whether the vulnerable code path is actually reachable
and exploitable in a real deployment — based solely on what you can read in the code.

Ask: Is there any input sanitization, auth guard, WAF hint, or framework protection that
would prevent exploitation? Or is the path wide open?

Output contract (STRICT): Return ONLY a single JSON object, no prose, no markdown fences.
Schema:
{
  "exploit_reachable": boolean,
  "confidence": "High"|"Medium"|"Low",
  "evidence": string,
  "mitigating_factors": string[],
  "verdict": string
}`;

const REMEDIATION_SYSTEM = `You are the REMEDIATION specialist on an AI AppSec team.
Role: You receive the Analyst's vulnerability report plus the original code.
Produce a minimal, correct fix that a senior engineer would ship.

Principles:
- Prefer parameterized queries, safe APIs, standard library primitives.
- Do not introduce new dependencies unless strictly required.
- Preserve existing function signatures and behaviour for non-vulnerable paths.
- code_diff must be a valid unified diff hunk (---, +++, @@) that applies cleanly.
- additional_hardening: MAXIMUM 3 items, each under 20 words. Be extremely concise.
- references: MAXIMUM 3 URLs, no descriptions.

Output contract (STRICT): Return ONLY a single JSON object, no prose, no markdown fences.
Schema:
{
  "fix_summary": string,
  "patched_code": string,
  "code_diff": string,
  "additional_hardening": string[],
  "references": string[]
}`;

const REPORTER_SYSTEM = `You are the REPORTER on an AI AppSec team.
Role: You receive all prior agent outputs and produce a GitHub Issue body.
The issue must be indistinguishable from a report written by a senior security engineer.

Formatting rules:
- Use standard GitHub Markdown.
- Start with a severity badge line: e.g. "**Severity:** 🔴 Critical (CVSS 9.8)"
- Include a Markdown table for metadata (CWE, CVSS vector, affected file).
- Use a fenced diff block (triple backtick diff) for the code fix.
- Use bold section headers: ## Summary, ## Vulnerability Details, ## Proof of Concept, ## Validation, ## Remediation, ## Additional Hardening, ## References.
- End with a "Hours saved" line: estimate time a human engineer would have spent on this triage.

Output contract (STRICT): Return ONLY a single JSON object, no prose, no markdown fences.
Schema:
{
  "issue_title": string,   // e.g. "[Security] Critical SQLi in src/routes/login.js (CWE-89, CVSS 9.8)"
  "markdown": string       // full GitHub Issue body
}`;

// ─── GITHUB HELPERS ──────────────────────────────────────────────────────────

function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "ZeroDayOS/1.0",
  };
}

async function fetchFileContent(owner: string, repo: string, path: string): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    { headers: ghHeaders() }
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status} fetching ${path}`);
  const data: any = await res.json();
  // contents API returns base64-encoded content with possible line breaks
  return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
}

async function fetchFileTree(owner: string, repo: string): Promise<string[]> {
  // Use the git trees API with recursive=1 to get the flat file list efficiently
  // First get the default branch SHA via repo metadata
  const repoRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}`,
    { headers: ghHeaders() }
  );
  if (!repoRes.ok) throw new Error(`GitHub API ${repoRes.status} fetching repo metadata`);
  const repoData: any = await repoRes.json();
  const defaultBranch = repoData.default_branch || "master";

  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
    { headers: ghHeaders() }
  );
  if (!treeRes.ok) throw new Error(`GitHub API ${treeRes.status} fetching file tree`);
  const treeData: any = await treeRes.json();

  // Filter to blobs only (files, not directories), drop binaries by extension
  const SKIP_EXT = /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz|lock|map)$/i;
  const SKIP_DIR = /^(node_modules|\.git|dist|build|coverage|\.nyc_output)\//;
  return (treeData.tree as any[])
    .filter((item) => item.type === "blob" && !SKIP_EXT.test(item.path) && !SKIP_DIR.test(item.path))
    .map((item) => item.path);
}

// ─── AGENT RUNNERS ───────────────────────────────────────────────────────────

// Recon: 3-phase auto-discovery.
// Phase 1 — fetch file tree from GitHub API
// Phase 2 — LLM picks the 1-2 highest-value files to scan
// Phase 3 — fetch those files, summarise for Analyst
export async function runRecon(
  tracer: Tracer,
  repoUrl: string,
  trace?: LangfuseTraceClient
): Promise<ReconOutput> {
  tracer.emit({ agent: "Recon", phase: "start", message: `Targeting ${repoUrl}` });

  const match = repoUrl.replace(/\/$/, "").match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error(`Cannot parse GitHub URL: ${repoUrl}`);
  const [, owner, repo] = match;

  // ── Phase 1: fetch file tree ──────────────────────────────────────────────
  tracer.emit({ agent: "Recon", phase: "thinking", message: "Fetching repository file tree..." });
  const allFiles = await fetchFileTree(owner, repo);
  tracer.emit({ agent: "Recon", phase: "thinking", message: `Found ${allFiles.length} files. Selecting highest-value targets...` });

  // ── Phase 2: LLM picks files ──────────────────────────────────────────────
  const pickerUser = `Repository: ${repoUrl}

File tree (${allFiles.length} files):
${allFiles.join("\n")}

Select the 1-2 files most likely to contain high-severity security vulnerabilities.`;

  const picked = await chatJSON<{ selected_files: string[] }>({
    system: RECON_FILE_PICKER_SYSTEM,
    messages: [{ role: "user", content: pickerUser }],
    maxTokens: 200,
    trace,
    agentName: "Recon-FilePicker",
  });

  const selectedFiles = (picked.selected_files ?? []).slice(0, 2);
  if (selectedFiles.length === 0) throw new Error("Recon file picker returned no files");

  tracer.emit({
    agent: "Recon",
    phase: "thinking",
    message: `Selected: ${selectedFiles.join(", ")}. Fetching contents...`,
  });

  // ── Phase 3: fetch file contents + summarise ──────────────────────────────
  const fetchedParts: string[] = [];
  for (const filePath of selectedFiles) {
    const content = await fetchFileContent(owner, repo, filePath);
    const truncated = content.length > 3000 ? content.slice(0, 3000) + "\n\n[...truncated]" : content;
    fetchedParts.push(`### ${filePath}\n\`\`\`\n${truncated}\n\`\`\``);
  }
  const combinedContent = fetchedParts.join("\n\n");

  const summaryUser = `Repository: ${repoUrl}
Selected files and their contents:

${combinedContent}

Produce your recon summary.`;

  const { recon_summary } = await chatJSON<{ recon_summary: string }>({
    system: RECON_SUMMARY_SYSTEM,
    messages: [{ role: "user", content: summaryUser }],
    maxTokens: 400,
    trace,
    agentName: "Recon-Summary",
  });

  const rawCombined = selectedFiles
    .map((f, i) => `// FILE: ${f}\n${fetchedParts[i].replace(/^### .+\n```\n/, "").replace(/\n```$/, "")}`)
    .join("\n\n// ─────────────────────────────────────────\n\n");

  const out: ReconOutput = {
    repo: repoUrl,
    selected_files: selectedFiles,
    file_content: rawCombined,
    recon_summary,
  };

  tracer.emit({
    agent: "Recon",
    phase: "done",
    message: `Scanned [${selectedFiles.join(", ")}] — ${recon_summary}`,
    data: { selected_files: selectedFiles, recon_summary },
  });
  return out;
}

export async function runAnalyst(
  tracer: Tracer,
  snippet: string,
  context: string,
  trace?: LangfuseTraceClient
): Promise<AnalystOutput> {
  tracer.emit({ agent: "Analyst", phase: "start", message: "Receiving file for vulnerability analysis" });
  tracer.emit({ agent: "Analyst", phase: "thinking", message: "Classifying vulnerability, mapping CWE, scoring CVSS" });

  const user = `Context: ${context}\n\nCode/file to analyze:\n\`\`\`\n${snippet}\n\`\`\``;
  const out = await chatJSON<AnalystOutput>({
    system: ANALYST_SYSTEM,
    messages: [{ role: "user", content: user }],
    maxTokens: 1500,
    trace,
    agentName: "Analyst",
  });

  tracer.emit({
    agent: "Analyst",
    phase: "done",
    message: `${out.vulnerability_name} (${out.cwe_id}, ${out.severity}, CVSS ${out.cvss_score})`,
    data: out,
  });
  return out;
}

export async function runValidator(
  tracer: Tracer,
  snippet: string,
  analyst: AnalystOutput,
  trace?: LangfuseTraceClient
): Promise<ValidatorOutput> {
  tracer.emit({ agent: "Validator", phase: "start", message: "Checking exploit reachability" });
  tracer.emit({ agent: "Validator", phase: "thinking", message: "Scanning for guards, sanitizers, auth checks that may block exploitation" });

  const user = `Original file:
\`\`\`
${snippet}
\`\`\`

Analyst report:
${JSON.stringify(analyst, null, 2)}

Validate whether the exploit path is reachable.`;

  const out = await chatJSON<ValidatorOutput>({
    system: VALIDATOR_SYSTEM,
    messages: [{ role: "user", content: user }],
    maxTokens: 800,
    trace,
    agentName: "Validator",
  });

  tracer.emit({
    agent: "Validator",
    phase: "done",
    message: `Reachable: ${out.exploit_reachable} (confidence: ${out.confidence}) — ${out.verdict}`,
    data: out,
  });
  return out;
}

export async function runRemediation(
  tracer: Tracer,
  snippet: string,
  analyst: AnalystOutput,
  trace?: LangfuseTraceClient
): Promise<RemediationOutput> {
  tracer.emit({ agent: "Remediation", phase: "start", message: "Drafting patch" });
  tracer.emit({ agent: "Remediation", phase: "thinking", message: "Producing minimal fix and unified diff" });

  const user = `Original vulnerable code:
\`\`\`
${snippet}
\`\`\`

Analyst report:
${JSON.stringify(analyst, null, 2)}

Produce the remediation.`;

  const out = await chatJSON<RemediationOutput>({
    system: REMEDIATION_SYSTEM,
    messages: [{ role: "user", content: user }],
    maxTokens: 3500,
    trace,
    agentName: "Remediation",
  });

  tracer.emit({
    agent: "Remediation",
    phase: "done",
    message: `Patch ready: ${out.fix_summary}`,
    data: { fix_summary: out.fix_summary, additional_hardening: out.additional_hardening },
  });
  return out;
}

export async function runReporter(
  tracer: Tracer,
  recon: ReconOutput,
  analyst: AnalystOutput,
  validator: ValidatorOutput,
  remediation: RemediationOutput,
  trace?: LangfuseTraceClient
): Promise<ReporterOutput> {
  tracer.emit({ agent: "Reporter", phase: "start", message: "Assembling final GitHub Issue report" });
  tracer.emit({ agent: "Reporter", phase: "thinking", message: "Formatting Markdown with tables, diff blocks, severity badges" });

  const user = `All agent outputs:

RECON:
${JSON.stringify(recon, null, 2)}

ANALYST:
${JSON.stringify(analyst, null, 2)}

VALIDATOR:
${JSON.stringify(validator, null, 2)}

REMEDIATION:
${JSON.stringify(remediation, null, 2)}

Produce the GitHub Issue body and title.`;

  const out = await chatJSON<ReporterOutput>({
    system: REPORTER_SYSTEM,
    messages: [{ role: "user", content: user }],
    maxTokens: 4000,
    trace,
    agentName: "Reporter",
  });

  tracer.emit({
    agent: "Reporter",
    phase: "done",
    message: `Issue titled: "${out.issue_title}"`,
    data: { issue_title: out.issue_title },
  });
  return out;
}
