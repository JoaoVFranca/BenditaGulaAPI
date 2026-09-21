import { app, sessionStore } from "./app.js";
import { pool } from "./db.js";
import { config } from "./config.js";
await pool.query("SELECT 1");
const server = app.listen(config.PORT, "127.0.0.1", () =>
  console.log(`API disponível em http://localhost:${config.PORT}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close(() => {
      sessionStore.close();
      void pool.end();
    });
  });
