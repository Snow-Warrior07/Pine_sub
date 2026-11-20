// CLI entrypoint. Uses shared pipeline from pipeline.ts.
import { runScan } from "./pipeline";

const TARGET_REPO = "https://github.com/OWASP/NodeGoat";

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║              ZeroDayOS — AI AppSec Team (CLI)               ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  try {
    const result = await runScan({
      repoUrl: TARGET_REPO,
      issueRepo: TARGET_REPO,   // post directly to the scanned repo
    });

    console.log("\n" + "═".repeat(64));
    console.log(`FILES SCANNED  : ${result.selectedFiles.join(", ")}`);
    console.log(`ISSUE TITLE    : ${result.issueTitle}`);
    console.log(`ISSUE URL      : ${result.issueUrl}`);
    console.log(`LOCAL REPORT   : ${result.reportPath}`);
    console.log(`LOCAL TRACE    : traces/${result.runId}.jsonl`);
    console.log(`LANGFUSE TRACE : ${result.langfuseTraceUrl}`);
    console.log("═".repeat(64) + "\n");
  } catch (err) {
    console.error("\nRun failed:", err);
    process.exit(1);
  }
}

main();
