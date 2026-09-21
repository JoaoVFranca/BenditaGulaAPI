// Fixture temporária para QA local. Não é seed de produção nem usuário padrão.
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { pool, transaction } from "../src/db.js";
import { hashPassword } from "../src/password.js";
const path = ".qa-fixture.json";
try {
  if (process.argv[2] === "create") {
    const ids = {
      user: randomUUID(),
      ingredient: randomUUID(),
      product: randomUUID(),
    };
    await writeFile(path, JSON.stringify(ids), { flag: "wx" });
    const hash = await hashPassword("somente teste visual local");
    await transaction(async (client) => {
      await client.query(
        "INSERT INTO usuario(id,nome,email,senha_hash) VALUES ($1,$2,$3,$4)",
        [ids.user, "Pessoa de teste", "visual-qa@example.invalid", hash],
      );
      await client.query(
        "INSERT INTO insumo(id,nome,unidade_medida,estoque_minimo) VALUES ($1,$2,$3,$4)",
        [ids.ingredient, "Farinha (teste visual)", "kg", "2.500"],
      );
      await client.query(
        "INSERT INTO produto(id,nome,preco) VALUES ($1,$2,$3)",
        [ids.product, "Pão caseiro (teste visual)", "5.50"],
      );
      await client.query(
        "INSERT INTO composicao_produto(produto_id,insumo_id,quantidade) VALUES ($1,$2,$3)",
        [ids.product, ids.ingredient, "0.125"],
      );
    });
    console.log(
      "Fixture visual criada. Remova após o QA com este script e argumento clean.",
    );
  } else if (process.argv[2] === "clean") {
    const ids = JSON.parse(await readFile(path, "utf8"));
    await transaction(async (client) => {
      await client.query("DELETE FROM composicao_produto WHERE produto_id=$1", [
        ids.product,
      ]);
      await client.query("DELETE FROM produto WHERE id=$1", [ids.product]);
      await client.query("DELETE FROM insumo WHERE id=$1", [ids.ingredient]);
      await client.query("DELETE FROM sessao WHERE sess->>'userId'=$1", [
        ids.user,
      ]);
      await client.query("DELETE FROM usuario WHERE id=$1", [ids.user]);
    });
    await unlink(path);
    console.log("Fixture removida. Cadastros reais preservados.");
  } else throw new Error("Use create ou clean.");
} finally {
  await pool.end();
}
