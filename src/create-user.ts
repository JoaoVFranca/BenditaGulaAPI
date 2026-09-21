import { input, password } from "@inquirer/prompts";
import { ZodError } from "zod";
import { pool, transaction } from "./db.js";
import { userSchema } from "./validation.js";
import { hashPassword } from "./password.js";
try {
  if ((await pool.query("SELECT 1 FROM usuario LIMIT 1")).rowCount)
    throw new Error(
      "O primeiro usuário já existe. Cadastre os próximos pela aplicação.",
    );
  const nome = await input({ message: "Nome:" });
  const email = await input({ message: "E-mail:" });
  const senha = await password({
    message: "Senha (mínimo 12 caracteres):",
    mask: "*",
  });
  const confirmacao = await password({ message: "Repita a senha:", mask: "*" });
  if (senha !== confirmacao) throw new Error("As senhas não coincidem.");
  const data = userSchema.parse({ nome, email, senha });
  const hash = await hashPassword(data.senha);
  await transaction(async (client) => {
    await client.query("LOCK TABLE usuario IN EXCLUSIVE MODE");
    if ((await client.query("SELECT 1 FROM usuario LIMIT 1")).rowCount)
      throw new Error("O primeiro usuário já foi criado.");
    await client.query(
      "INSERT INTO usuario(nome,email,senha_hash) VALUES($1,$2,$3)",
      [data.nome, data.email, hash],
    );
  });
  console.log("Primeiro usuário criado. Você já pode entrar na aplicação.");
} catch (error) {
  console.error(
    error instanceof ZodError
      ? error.issues.map((i) => i.message).join("\n")
      : error instanceof Error && !("code" in error)
        ? error.message
        : "Não foi possível criar o usuário. Verifique o banco e as migrações.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
