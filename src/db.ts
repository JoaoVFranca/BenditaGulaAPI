import pg from "pg";
import { config } from "./config.js";
import { databaseOptions } from "./database-options.js";
export const pool = new pg.Pool({
  ...databaseOptions(config.DATABASE_URL, config.DATABASE_SSL_CA_PATH),
  max: 10,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
pool.on("error", () => console.error("Conexão com o banco interrompida."));
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
