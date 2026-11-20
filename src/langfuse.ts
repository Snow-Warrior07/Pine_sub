// Langfuse singleton. Import this anywhere you need the client.
// One client for the whole process — SDK batches + flushes automatically.
import "dotenv/config";
import Langfuse from "langfuse";

const PUBLIC_KEY  = process.env.LANGFUSE_PUBLIC_KEY!;
const SECRET_KEY  = process.env.LANGFUSE_SECRET_KEY!;
const HOST        = process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";

if (!PUBLIC_KEY || !SECRET_KEY) {
  throw new Error("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing from .env");
}

export const langfuse = new Langfuse({
  publicKey: PUBLIC_KEY,
  secretKey: SECRET_KEY,
  baseUrl: HOST,
  // Flush every 30 s or 20 events — whichever comes first.
  // For CLI runs we call langfuse.shutdownAsync() at the end.
  flushAt: 20,
  flushInterval: 30_000,
});

// Re-export the type so callers can type-hint trace/span objects
export type { LangfuseTraceClient, LangfuseSpanClient } from "langfuse";
