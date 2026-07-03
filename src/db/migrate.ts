/**
 * Migration runner. Applies every drizzle/*.sql file in name order, tracking
 * what has run in a `schema_migrations` table so re-runs are no-ops.
 *
 * Migrations here are hand-authored SQL (drizzle-kit generate is not the flow —
 * there is no drizzle/meta journal). Each migration runs inside a transaction
 * together with its tracker insert.
 *
 * Pre-tracking installs (the original live box had 0000–0009 applied by hand
 * via scripts/apply-migration.ts): run once with
 *   bun run src/db/migrate.ts --baseline <last-applied-name>
 * to record everything up to and including <last-applied-name> as applied
 * without executing it, then run normally.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL ?? "postgres://localhost:5432/openbrain", {
  max: 1,
  onnotice: () => {},
});

const migrationsDir = join(import.meta.dir, "../../drizzle");
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

await sql`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

const applied = new Set(
  (await sql`SELECT name FROM schema_migrations`).map((r) => r.name as string),
);

const baselineIdx = process.argv.indexOf("--baseline");
if (baselineIdx !== -1) {
  const upTo = process.argv[baselineIdx + 1];
  if (!upTo || !files.some((f) => f.startsWith(upTo))) {
    console.error(`--baseline requires a migration name; known: ${files.join(", ")}`);
    process.exit(1);
  }
  for (const file of files) {
    const name = file.replace(/\.sql$/, "");
    if (applied.has(name)) continue;
    await sql`INSERT INTO schema_migrations (name) VALUES (${name})`;
    console.log(`baselined ${name} (marked applied, not executed)`);
    if (file.startsWith(upTo)) break;
  }
  await sql.end();
  process.exit(0);
}

// Safety: an existing database with an empty tracker is a pre-tracking install.
// Refuse to blindly re-run 0000+ over it — the operator must baseline first.
if (applied.size === 0) {
  const [{ exists }] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'memories'
    ) AS exists
  `;
  if (exists) {
    console.error(
      "Database already has a memories table but no migration history.\n" +
        "This is a pre-tracking install. Mark already-applied migrations first:\n" +
        "  bun run src/db/migrate.ts --baseline <last-applied-migration-name>",
    );
    await sql.end();
    process.exit(1);
  }
}

let ran = 0;
for (const file of files) {
  const name = file.replace(/\.sql$/, "");
  if (applied.has(name)) continue;
  const body = readFileSync(join(migrationsDir, file), "utf-8");
  await sql.begin(async (tx) => {
    await tx.unsafe(body);
    await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
  });
  console.log(`applied ${name}`);
  ran++;
}

console.log(ran === 0 ? "up to date" : `applied ${ran} migration(s)`);
await sql.end();
