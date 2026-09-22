import { readFileSync } from "node:fs";
import type { PoolConfig } from "pg";

export function databaseOptions(
  connectionString: string,
  caPath?: string,
): PoolConfig {
  if (!caPath) return { connectionString };
  const url = new URL(connectionString);
  // pg substitui o objeto ssl quando encontra estes parâmetros na URL.
  // A configuração explícita do certificado sempre prevalece.
  for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl"])
    url.searchParams.delete(name);
  return {
    connectionString: url.toString(),
    ssl: { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true },
  };
}
