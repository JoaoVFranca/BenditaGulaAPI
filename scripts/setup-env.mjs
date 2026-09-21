import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const password = randomBytes(24).toString("hex");
const contents = `NODE_ENV=development\nPORT=3000\nAPP_ORIGIN=http://localhost:5173\nPOSTGRES_USER=tcc\nPOSTGRES_DB=tcc\nPOSTGRES_PASSWORD=${password}\nDATABASE_URL=postgresql://tcc:${password}@localhost:5433/tcc\nSESSION_SECRET=${randomBytes(48).toString("hex")}\n`;
try {
  await writeFile(".env", contents, { flag: "wx", mode: 0o600 });
  console.log(
    ".env criado com segredos aleatórios. Não envie este arquivo ao Git.",
  );
} catch (error) {
  if (error.code === "EEXIST")
    console.log(".env já existe; configuração preservada.");
  else throw error;
}
