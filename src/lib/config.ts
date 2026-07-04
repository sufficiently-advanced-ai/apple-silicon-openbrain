export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/openbrain",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  embeddingUrl: process.env.EMBEDDING_URL ?? "http://localhost:6278",
  // Must match the model served by embed-service (it namespaces the Redis
  // embedding cache — swapping models without changing this serves stale
  // vectors from the old model for up to 24h).
  embeddingModel:
    process.env.EMBEDDING_MODEL ?? "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ",
  llmUrl: process.env.LLM_URL ?? "http://localhost:8000",
  // Must match the model the mlx-lm server has loaded (see the boot check in
  // index.ts) — a mismatch makes mlx-lm hot-swap per request and thrash the GPU.
  llmModel: process.env.LLM_MODEL ?? "mlx-community/Qwen3.6-27B-4bit",
  mcpPort: Number(process.env.MCP_PORT ?? 6277),
  mcpHost: process.env.MCP_HOST ?? "0.0.0.0",
  authToken: process.env.AUTH_TOKEN ?? "",
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY ?? "",
  // Base URL used to build citation links in the OB1-compatible search/fetch
  // tools. Points at the local UI by default.
  citationBaseUrl: process.env.OPEN_BRAIN_CITATION_BASE_URL ?? "http://localhost:6279/memory",
} as const;
