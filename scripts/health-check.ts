const services = [
  { name: "MCP Server", url: "http://localhost:6277/health" },
  { name: "Embedding Service", url: "http://localhost:6278/health" },
  { name: "mlx-lm", url: "http://localhost:8000/health" },
];

async function check(name: string, url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const ok = res.ok;
    const body = await res.json().catch(() => null);
    console.log(`${ok ? "✓" : "✗"} ${name}: ${ok ? "ok" : res.status}`, body ?? "");
  } catch (e: any) {
    console.log(`✗ ${name}: ${e.message ?? "unreachable"}`);
  }
}

// Check Redis
async function checkRedis() {
  try {
    const proc = Bun.spawn(["redis-cli", "ping"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    console.log(`${out.trim() === "PONG" ? "✓" : "✗"} Redis: ${out.trim()}`);
  } catch {
    console.log("✗ Redis: unreachable");
  }
}

// Check PostgreSQL
async function checkPg() {
  try {
    const proc = Bun.spawn(["psql", "openbrain", "-c", "SELECT 1"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    console.log(`${proc.exitCode === 0 ? "✓" : "✗"} PostgreSQL: ${proc.exitCode === 0 ? "ok" : "error"}`);
  } catch {
    console.log("✗ PostgreSQL: unreachable (is psql in your PATH?)");
  }
}

console.log("OpenBrain Health Check\n");
await Promise.all([
  ...services.map((s) => check(s.name, s.url)),
  checkRedis(),
  checkPg(),
]);

// Top-level await requires module context under tsc.
export {};
