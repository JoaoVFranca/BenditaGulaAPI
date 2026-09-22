import { pool } from "./db.js";

try {
  await pool.query("SELECT 1");
  console.log("Conexão com o banco confirmada.");
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error("Não foi possível conectar ao banco.", {
    code: code && /^[A-Z0-9_]+$/.test(code) ? code : "CONNECTION_ERROR",
  });
  process.exitCode = 1;
} finally {
  await pool.end();
}
