export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 300s for Vercel Pro / Railway — LLM pipeline takes ~90s
export const maxDuration = 300;

// ─── If NEXT_PUBLIC_API_URL is set, proxy straight to the external Express
//     backend and stream its SSE response back to the browser.
//     Otherwise run the pipeline in-process (local dev / self-hosted).
export async function POST(req: Request) {
  const body = await req.json() as { repoUrl?: string };

  if (!body.repoUrl) {
    return Response.json({ error: "repoUrl is required" }, { status: 400 });
  }

  const externalUrl = process.env.NEXT_PUBLIC_API_URL;

  // ── PROXY MODE ────────────────────────────────────────────────────────────
  if (externalUrl) {
    const upstream = await fetch(`${externalUrl}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // Stream the upstream SSE directly back to the browser
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // ── IN-PROCESS MODE (local dev / self-hosted) ─────────────────────────────
  // Dynamic import so Vercel doesn't bundle heavy deps when proxy mode is used
  const { runScan } = await import("../../src/pipeline");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      (async () => {
        try {
          const result = await runScan({
            repoUrl: body.repoUrl!,
            issueRepo: body.repoUrl!,   // post directly to the scanned repo
            onProgress: (ev) => send({ type: "progress", ...ev }),
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
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
