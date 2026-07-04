import Redis from "ioredis";
import { config } from "../lib/config.js";

const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });

let connected = false;

async function ensureConnected() {
  if (!connected) {
    try {
      await redis.connect();
      connected = true;
    } catch {
      console.warn("Redis unavailable, caching disabled");
    }
  }
  return connected;
}

const PREFIX = "openbrain";

function hashKey(data: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

// Cache keys are namespaced by embedding model: without it, swapping models
// silently serves up to 24h of stale vectors from the old model — invisible
// semantic corruption. (Also uses the full sha256 now; the old 64-bit
// truncation made a collision return the wrong vector.)
function embedKey(text: string): string {
  return `${PREFIX}:embed:${hashKey(`${config.embeddingModel}\n${text}`)}`;
}

export async function getCachedEmbedding(text: string): Promise<number[] | null> {
  if (!(await ensureConnected())) return null;
  const cached = await redis.get(embedKey(text));
  return cached ? JSON.parse(cached) : null;
}

export async function setCachedEmbedding(text: string, embedding: number[]): Promise<void> {
  if (!(await ensureConnected())) return;
  await redis.set(embedKey(text), JSON.stringify(embedding), "EX", 86400); // 24h
}

export async function getCachedSearch(queryHash: string): Promise<string | null> {
  if (!(await ensureConnected())) return null;
  const key = `${PREFIX}:search:${queryHash}`;
  return redis.get(key);
}

export async function setCachedSearch(queryHash: string, result: string): Promise<void> {
  if (!(await ensureConnected())) return;
  const key = `${PREFIX}:search:${queryHash}`;
  await redis.set(key, result, "EX", 300); // 5m
}
