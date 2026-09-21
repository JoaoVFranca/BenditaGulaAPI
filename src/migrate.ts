import { readdir, readFile } from "node:fs/promises";
import { pool, transaction } from "./db.js";
try {
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(2192026)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const files = (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (
        (
          await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [
            file,
          ])
        ).rowCount
      )
        continue;
      await client.query(await readFile(`migrations/${file}`, "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [
        file,
      ]);
      console.log(`Migração aplicada: ${file}`);
    }
  });
} finally {
  await pool.end();
}
