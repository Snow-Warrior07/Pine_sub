// Core scan pipeline. Shared between CLI runner and server.
import { Tracer, newRunId } from "./tracer";
import {
  runRecon,
  runAnalyst,
  runValidator,
  runRemediation,
  runReporter,
} from "./agents";
import { postIssue, parseGitHubRepo } from "./github";
import { langfuse } from "./langfuse";

export type ScanOptions = {
  repoUrl: string;
  issueRepo: string;
  onProgress?: (event: { agent: string; phase: string; message: string }) => void;
};

export type ScanResult = {
  runId: string;
  issueUrl: string;
  issueNumber: number;
  issueTitle: string;
  reportPath: string;
  selectedFiles: string[];
  langfuseTraceUrl?: string;
};

export async function runScan(opts: ScanOptions): Promise<ScanResult> {
  const runId = newRunId();
  const tracer = new Tracer(runId);

  // ── Langfuse: one trace per scan ─────────────────────────────────────────
  const lfTrace = langfuse.trace({
    id: runId,
    name: "zerodayos-scan",
    input: { repoUrl: opts.repoUrl },
    metadata: { issueRepo: opts.issueRepo },
    tags: ["zerodayos", "appsec"],
  });

  if (opts.onProgress) {
    const origEmit = tracer.emit.bind(tracer);
    tracer.emit = (ev) => {
      origEmit(ev);
      opts.onProgress!({ agent: ev.agent, phase: ev.phase, message: ev.message });
    };
  }

  tracer.emit({
    agent: "Orchestrator",
    phase: "start",
    message: `Run started | id=${runId} | repo=${opts.repoUrl}`,
  });

  // Step 1: Recon
  const recon = await runRecon(tracer, opts.repoUrl, lfTrace);

  // Step 2: Analyst
  const context = `Files scanned: ${recon.selected_files.join(", ")} from ${recon.repo}. Recon notes: ${recon.recon_summary}`;
  const analyst = await runAnalyst(tracer, recon.file_content, context, lfTrace);

  // Step 3: Validator
  const validator = await runValidator(tracer, recon.file_content, analyst, lfTrace);

  // Step 4: Remediation
  const remediation = await runRemediation(tracer, recon.file_content, analyst, lfTrace);

  // Step 5: Reporter
  const reporter = await runReporter(tracer, recon, analyst, validator, remediation, lfTrace);

  // Save local report (skip on serverless / read-only filesystems)
  const reportPath = `report-${runId}.md`;
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(reportPath, reporter.markdown, "utf-8");
  } catch {
    // no-op on read-only environments (Vercel, etc.)
  }

  tracer.emit({
    agent: "Orchestrator",
    phase: "thinking",
    message: `Posting GitHub Issue to ${opts.issueRepo}...`,
  });

  const { owner, repo } = parseGitHubRepo(opts.issueRepo);
  const issue = await postIssue({
    owner,
    repo,
    title: reporter.issue_title,
    body: reporter.markdown,
  });

  tracer.emit({
    agent: "Orchestrator",
    phase: "done",
    message: `Issue #${issue.number} live: ${issue.html_url}`,
  });

  // ── Langfuse: close trace with final output ───────────────────────────────
  lfTrace.update({
    output: {
      issueUrl: issue.html_url,
      issueTitle: issue.title,
      selectedFiles: recon.selected_files,
      severity: analyst.severity,
      cvss: analyst.cvss_score,
    },
  });

  // Flush so CLI exits cleanly without losing events
  await langfuse.flushAsync();

  const langfuseTraceUrl = `${process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com"}/trace/${runId}`;

  return {
    runId,
    issueUrl: issue.html_url,
    issueNumber: issue.number,
    issueTitle: issue.title,
    reportPath,
    selectedFiles: recon.selected_files,
    langfuseTraceUrl,
  };
}
