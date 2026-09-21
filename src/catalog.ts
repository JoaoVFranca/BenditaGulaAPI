import type { PoolClient } from "pg";
import type { z } from "zod";
import { transaction } from "./db.js";
import { HttpError } from "./errors.js";
import { ingredientSchema } from "./validation.js";
export const ingredientFields =
  "id,nome,unidade_medida,estoque_minimo,to_char(validade_referencia,'YYYY-MM-DD') AS validade_referencia,ativo,(SELECT p.id FROM produto p WHERE p.origem_insumo_id=insumo.id) AS produto_vinculado_id";
async function createDirectProduct(
  client: PoolClient,
  id: string,
  data: z.infer<typeof ingredientSchema>,
) {
  if (!data.criar_produto) return;
  const existing = await client.query(
    "SELECT id FROM produto WHERE origem_insumo_id=$1",
    [id],
  );
  if (existing.rowCount) return; // Editar ou repetir a marcação nunca duplica nem sobrescreve o produto.
  const product = (
    await client.query(
      "INSERT INTO produto(nome,preco,ativo,origem_insumo_id) VALUES($1,$2,$3,$4) RETURNING id",
      [data.nome, data.preco_venda, data.ativo, id],
    )
  ).rows[0];
  await client.query(
    "INSERT INTO composicao_produto(produto_id,insumo_id,quantidade) VALUES($1,$2,1)",
    [product.id, id],
  );
}
export async function saveIngredient(
  id: string | null,
  data: z.infer<typeof ingredientSchema>,
) {
  return transaction(async (client) => {
    if (id) {
      const old = (
        await client.query(
          "SELECT unidade_medida FROM insumo WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!old) throw new HttpError(404, "Insumo não encontrado.");
      if (old.unidade_medida !== data.unidade_medida)
        throw new HttpError(
          409,
          "A unidade de medida é fixa. Cadastre outro insumo para usar uma unidade diferente.",
        );
      await client.query(
        "UPDATE insumo SET nome=$2,estoque_minimo=$3,validade_referencia=$4,ativo=$5 WHERE id=$1",
        [
          id,
          data.nome,
          data.estoque_minimo,
          data.validade_referencia,
          data.ativo,
        ],
      );
    } else {
      id = (
        await client.query(
          "INSERT INTO insumo(nome,unidade_medida,estoque_minimo,validade_referencia,ativo) VALUES($1,$2,$3,$4,$5) RETURNING id",
          [
            data.nome,
            data.unidade_medida,
            data.estoque_minimo,
            data.validade_referencia,
            data.ativo,
          ],
        )
      ).rows[0].id as string;
    }
    await createDirectProduct(client, id, data);
    return (
      await client.query(`SELECT ${ingredientFields} FROM insumo WHERE id=$1`, [
        id,
      ])
    ).rows[0];
  });
}
export async function deleteCatalog(kind: "insumo" | "produto", id: string) {
  return transaction(async (client) => {
    if (
      !(
        await client.query(`SELECT id FROM ${kind} WHERE id=$1 FOR UPDATE`, [
          id,
        ])
      ).rowCount
    )
      throw new HttpError(404, "Cadastro não encontrado.");
    const references =
      kind === "insumo"
        ? await client.query(
            "SELECT 1 FROM composicao_produto WHERE insumo_id=$1 UNION ALL SELECT 1 FROM item_operacao WHERE insumo_id=$1 UNION ALL SELECT 1 FROM movimentacao_estoque WHERE insumo_id=$1 UNION ALL SELECT 1 FROM produto WHERE origem_insumo_id=$1 LIMIT 1",
            [id],
          )
        : await client.query(
            "SELECT 1 FROM item_operacao WHERE produto_id=$1 LIMIT 1",
            [id],
          );
    if (references.rowCount)
      throw new HttpError(
        409,
        "Este cadastro possui histórico ou vínculos e não pode ser excluído. Desative-o pela edição para preservar os registros.",
      );
    if (kind === "produto")
      await client.query("DELETE FROM composicao_produto WHERE produto_id=$1", [
        id,
      ]);
    await client.query(`DELETE FROM ${kind} WHERE id=$1`, [id]);
  });
}
