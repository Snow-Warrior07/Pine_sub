// Express server for TriageBot.
// Routes:
//   GET  /          → serves index.html
//   POST /scan      → starts a scan, streams SSE progress, returns issue URL
import "dotenv/config";
import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { watch } from "node:fs";
import { runScan } from "./pipeline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Issues are posted directly to the scanned repo.

const app = express();
app.use(express.json());

const reloadClients = new Set<express.Response>();
let reloadDebounce: NodeJS.Timeout | null = null;

app.get("/__dev_reload", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  reloadClients.add(res);

  req.on("close", () => {
    reloadClients.delete(res);
  });
});

// Serve static frontend from /public
app.use(express.static(join(__dirname, "../public")));

// POST /scan — triggers the pipeline, streams events via SSE
// Body: { repoUrl: string }
app.post("/scan", async (req, res) => {
  const { repoUrl } = req.body as { repoUrl?: string };

  if (!repoUrl) {
    res.status(400).json({ error: "repoUrl is required" });
    return;
  }

  // SSE headers — client gets a stream of events while agents work
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await runScan({
      repoUrl,
      issueRepo: repoUrl,   // post directly to the scanned repo
      onProgress: (ev) => {
        send({ type: "progress", ...ev });
      },
    });

      send({
        type: "done",
        issueUrl: result.issueUrl,
        issueNumber: result.issueNumber,
        issueTitle: result.issueTitle,
        runId: result.runId,
        selectedFiles: result.selectedFiles,
      });
  } catch (err) {
    send({ type: "error", message: (err as Error).message });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\nZeroDayOS server running at http://localhost:${PORT}`);
  console.log(`Issues will be posted directly to the scanned repository.\n`);
});

const indexPath = join(__dirname, "../public/index.html");
watch(indexPath, () => {
  if (reloadDebounce) {
    clearTimeout(reloadDebounce);
  }

  reloadDebounce = setTimeout(() => {
    const payload = JSON.stringify({ type: "reload" });
    for (const client of reloadClients) {
      client.write(`data: ${payload}\n\n`);
    }
  }, 120);
});
