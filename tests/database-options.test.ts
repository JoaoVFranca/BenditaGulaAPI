import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseOptions } from "../src/database-options.js";

test("Certificado explícito impede que parâmetros da URL desativem a verificação TLS", () => {
  const dir = mkdtempSync(join(tmpdir(), "database-tls-"));
  try {
    const path = join(dir, "ca.crt");
    writeFileSync(path, "certificado de teste");
    const config = databaseOptions(
      "postgresql://user:password@localhost/db?sslmode=disable&ssl=false&sslrootcert=outra-ca&application_name=teste",
      path,
    );
    const url = new URL(config.connectionString!);
    assert.equal(url.searchParams.has("sslmode"), false);
    assert.equal(url.searchParams.has("ssl"), false);
    assert.equal(url.searchParams.has("sslrootcert"), false);
    assert.equal(url.searchParams.get("application_name"), "teste");
    assert.deepEqual(config.ssl, {
      ca: "certificado de teste",
      rejectUnauthorized: true,
    });
    assert.throws(
      () =>
        databaseOptions("postgresql://localhost/db", join(dir, "ausente.crt")),
      { code: "ENOENT" },
    );
  } finally {
    rmSync(join(dir, "ca.crt"));
    rmdirSync(dir);
  }
});

test("Banco local sem certificado mantém a configuração de conexão existente", () => {
  const url = "postgresql://localhost/db";
  assert.deepEqual(databaseOptions(url), { connectionString: url });
});
