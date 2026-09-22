import { app, sessionStore } from "./app.js";
import { pool } from "./db.js";
import { config } from "./config.js";
await pool.query("SELECT 1");
const host = config.HOST ?? (config.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const server = app.listen(config.PORT, host, () =>
  console.log(`Servidor iniciado na porta ${config.PORT}.`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close(() => {
      sessionStore.close();
      void pool.end();
    });
  });
