import { config } from "../lib/config.js";

// Cap embedding input length. Mean-pooled embeddings over very long documents add
// little semantic value but a huge payload (e.g. a 180-page PDF scraped to
// markdown) can OOM the Metal GPU in the embedding service — which made the store
// throw, leaving no row, so the source was re-scraped every cycle. Truncating
// keeps stores reliable; the full content is still persisted in the row.
const MAX_EMBED_CHARS = 8000;

// Matches the vector(1024) column and the HNSW index. A wrong-dim vector is
// rejected by the DB on insert, but on the *search* path it would only surface
// as an opaque pgvector operator error — validate here instead.
export const EMBEDDING_DIM = 1024;

// A wedged MLX service (Metal OOM is a known failure mode) used to hang every
// Store/Search call indefinitely — this fetch had no timeout. Embeddings
// normally return in well under a second; 15s is generous.
const EMBED_TIMEOUT_MS = 15_000;

export async function getEmbedding(text: string): Promise<number[]> {
  const input = text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
  if (input.length < text.length) {
    console.log(`[embedding] truncated input ${text.length} -> ${MAX_EMBED_CHARS} chars`);
  }

  const res = await fetch(`${config.embeddingUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Embedding service error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    data?: { embedding?: unknown }[];
  };
  const embedding = data.data?.[0]?.embedding;
  if (
    !Array.isArray(embedding) ||
    embedding.length !== EMBEDDING_DIM ||
    !embedding.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    throw new Error(
      `Embedding service returned an invalid vector (expected ${EMBEDDING_DIM} finite numbers, ` +
        `got ${Array.isArray(embedding) ? `length ${embedding.length}` : typeof embedding})`,
    );
  }
  return embedding;
}
