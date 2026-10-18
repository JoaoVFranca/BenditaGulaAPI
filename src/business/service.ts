import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { z } from "zod";
import { transaction } from "../db.js";
import { isWholeUnit } from "../validation.js";
import { HttpError } from "../errors.js";
import { decimal, lineCents, scaled } from "./decimal.js";
import {
  type OperationInput,
  expenseSchema,
  movementSchema,
  incomeSchema,
} from "./schemas.js";

type IngredientRow = {
  id: string;
  nome: string;
  ativo: boolean;
  unidade_medida: string;
};
type PlannedItem = {
  produto_id: string | null;
  insumo_id: string | null;
  nome: string;
  unidade: string;
  quantidade: string;
  valor_unitario: string;
  subtotal: string;
  preco_catalogo: string | null;
  valor_informado: "UNITARIO" | "TOTAL";
  movimentos: { insumo_id: string; quantidade: string }[];
};
const fingerprint = (userId: string, data: unknown) =>
  createHash("sha256").update(JSON.stringify({ userId, data })).digest("hex");
async function idempotency(
  client: PoolClient,
  table: "operacao" | "movimentacao_estoque" | "lancamento_financeiro",
  key: string,
  hash: string,
) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${table}:${key}`,
  ]);
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE chave_idempotencia=$1`,
    [key],
  );
  if (rows[0] && rows[0].requisicao_hash !== hash)
    throw new HttpError(
      409,
      "Esta identificação já foi usada em outra requisição. Reabra o formulário para iniciar um novo registro.",
    );
  return rows[0];
}
async function lockIngredients(
  client: PoolClient,
  ids: string[],
  active: boolean,
) {
  const unique = [...new Set(ids)].sort();
  const { rows } = await client.query<IngredientRow>(
    "SELECT id,nome,ativo,unidade_medida FROM insumo WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [unique],
  );
  if (rows.length !== unique.length)
    throw new HttpError(422, "Um dos insumos não existe.");
  if (active && rows.some((i) => !i.ativo))
    throw new HttpError(422, "A operação contém insumos inativos.");
  return new Map(rows.map((i) => [i.id, i]));
}
function checkUnit(ingredient: IngredientRow, quantity: string) {
  if (
    isWholeUnit(ingredient.unidade_medida) &&
    scaled(quantity, 3) % 1000n !== 0n
  )
    throw new HttpError(
      422,
      `${ingredient.nome}: informe uma quantidade inteira em ${ingredient.unidade_medida}.`,
    );
}
async function requireStock(
  client: PoolClient,
  needed: Map<string, bigint>,
  ingredients: Map<string, IngredientRow>,
) {
  for (const [id, amount] of needed) {
    const { rows } = await client.query(
      "SELECT COALESCE(sum(CASE WHEN natureza='ENTRADA' THEN quantidade ELSE -quantidade END),0)::text AS saldo FROM movimentacao_estoque WHERE insumo_id=$1",
      [id],
    );
    if (scaled(rows[0].saldo, 3) < amount)
      throw new HttpError(
        409,
        `Estoque insuficiente de ${ingredients.get(id)!.nome}. Disponível: ${rows[0].saldo} ${ingredients.get(id)!.unidade_medida}.`,
      );
  }
}
function aggregate(items: { insumo_id: string; quantidade: string }[]) {
  const amounts = new Map<string, bigint>();
  for (const item of items)
    amounts.set(
      item.insumo_id,
      (amounts.get(item.insumo_id) ?? 0n) + scaled(item.quantidade, 3),
    );
  return amounts;
}
async function prepare(client: PoolClient, data: OperationInput) {
  const items: PlannedItem[] = [];
  if (data.tipo === "COMPRA") {
    const ingredients = await lockIngredients(
      client,
      data.itens.map((i) => i.insumo_id),
      true,
    );
    for (const item of data.itens) {
      const ingredient = ingredients.get(item.insumo_id)!;
      checkUnit(ingredient, item.quantidade);
      const subtotal =
        item.valor_total !== undefined
          ? scaled(item.valor_total, 2)
          : lineCents(item.quantidade, item.valor_unitario!);
      const unitPrice =
        item.valor_total !== undefined
          ? decimal(
              (subtotal * 1000000000n + scaled(item.quantidade, 3) / 2n) /
                scaled(item.quantidade, 3),
              8,
            )
          : item.valor_unitario!;
      if (subtotal === 0n)
        throw new HttpError(
          422,
          "O valor total de cada item deve ser de pelo menos R$ 0,01.",
        );
      items.push({
        ...item,
        valor_unitario: unitPrice,
        preco_catalogo: null,
        valor_informado: item.valor_total !== undefined ? "TOTAL" : "UNITARIO",
        produto_id: null,
        nome: ingredient.nome,
        unidade: ingredient.unidade_medida,
        subtotal: decimal(subtotal, 2),
        movimentos: [
          { insumo_id: item.insumo_id, quantidade: item.quantidade },
        ],
      });
    }
  } else {
    const ids = data.itens.map((i) => i.produto_id).sort();
    const { rows: products } = await client.query(
      "SELECT id,nome,preco,ativo FROM produto WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
      [ids],
    );
    if (products.length !== ids.length || products.some((p) => !p.ativo))
      throw new HttpError(
        422,
        "A venda contém produtos inexistentes ou inativos.",
      );
    const { rows: components } = await client.query(
      "SELECT produto_id,insumo_id,quantidade FROM composicao_produto WHERE produto_id=ANY($1::uuid[]) ORDER BY produto_id,insumo_id",
      [ids],
    );
    const ingredients = await lockIngredients(
      client,
      components.map((c) => c.insumo_id),
      true,
    );
    for (const item of data.itens) {
      const product = products.find((p) => p.id === item.produto_id)!;
      if (scaled(product.preco, 2) !== scaled(item.preco_esperado, 2))
        throw new HttpError(
          409,
          `O preço de ${product.nome} foi atualizado. Remova e adicione o produto novamente para revisar o novo preço.`,
        );
      const count = scaled(item.quantidade, 3) / 1000n;
      const movements = components
        .filter((c) => c.produto_id === item.produto_id)
        .map((c) => ({
          insumo_id: c.insumo_id,
          quantidade: decimal(scaled(c.quantidade, 3) * count, 3),
        }));
      for (const movement of movements)
        checkUnit(ingredients.get(movement.insumo_id)!, movement.quantidade);
      items.push({
        produto_id: item.produto_id,
        insumo_id: null,
        nome: product.nome,
        unidade: "un",
        quantidade: item.quantidade,
        valor_unitario: item.valor_unitario ?? product.preco,
        preco_catalogo: product.preco,
        valor_informado: "UNITARIO",
        subtotal: decimal(
          lineCents(item.quantidade, item.valor_unitario ?? product.preco),
          2,
        ),
        movimentos: movements,
      });
    }
    await requireStock(
      client,
      aggregate(items.flatMap((i) => i.movimentos)),
      ingredients,
    );
  }
  return {
    itens: items,
    total: decimal(
      items.reduce((sum, i) => sum + scaled(i.subtotal, 2), 0n),
      2,
    ),
  };
}
export async function previewOperation(data: OperationInput) {
  return transaction((client) => prepare(client, data));
}
export async function createOperation(data: OperationInput, userId: string) {
  return transaction(async (client) => {
    const hash = fingerprint(userId, data);
    const existing = await idempotency(
      client,
      "operacao",
      data.chave_idempotencia,
      hash,
    );
    if (existing) return { id: existing.id, repetida: true };
    const plan = await prepare(client, data);
    const paid = data.tipo === "VENDA" || data.situacao_pagamento === "PAGO";
    const method = paid ? data.forma_pagamento : null;
    const operation = (
      await client.query(
        `INSERT INTO operacao(tipo,usuario_id,fornecedor_nome,forma_pagamento,total,chave_idempotencia,requisicao_hash,observacoes,data_hora)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()) RETURNING id,data_hora`,
        [
          data.tipo,
          userId,
          data.tipo === "COMPRA" ? data.fornecedor_nome : null,
          method,
          plan.total,
          data.chave_idempotencia,
          hash,
          data.observacoes || null,
        ],
      )
    ).rows[0];
    for (const item of plan.itens) {
      const saved = (
        await client.query(
          "INSERT INTO item_operacao(operacao_id,produto_id,insumo_id,quantidade,valor_unitario,nome_snapshot,unidade_snapshot,subtotal,preco_catalogo,valor_informado) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
          [
            operation.id,
            item.produto_id,
            item.insumo_id,
            item.quantidade,
            item.valor_unitario,
            item.nome,
            item.unidade,
            item.subtotal,
            item.preco_catalogo,
            item.valor_informado,
          ],
        )
      ).rows[0];
      for (const movement of item.movimentos)
        await client.query(
          `INSERT INTO movimentacao_estoque(insumo_id,item_operacao_id,usuario_id,natureza,motivo,descricao,quantidade,data_hora) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            movement.insumo_id,
            saved.id,
            userId,
            data.tipo === "COMPRA" ? "ENTRADA" : "SAIDA",
            data.tipo,
            `${data.tipo === "COMPRA" ? "Recebimento" : "Venda"}: ${item.nome}`,
            movement.quantidade,
            operation.data_hora,
          ],
        );
    }
    await client.query(
      `INSERT INTO lancamento_financeiro(operacao_id,usuario_id,tipo,descricao,valor,vencimento,pago_em,status,forma_pagamento,criado_em) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        operation.id,
        userId,
        data.tipo === "COMPRA" ? "DESPESA" : "RECEITA",
        `${data.tipo === "COMPRA" ? "Compra" : "Venda"} ${operation.id.slice(0, 8)}`,
        plan.total,
        data.tipo === "COMPRA" ? data.vencimento : null,
        paid ? operation.data_hora : null,
        paid ? "PAGO" : "PENDENTE",
        method,
        operation.data_hora,
      ],
    );
    return { id: operation.id, repetida: false };
  });
}
export async function cancelOperation(
  id: string,
  reason: string,
  userId: string,
) {
  return transaction(async (client) => {
    const operation = (
      await client.query("SELECT * FROM operacao WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!operation) throw new HttpError(404, "Operação não encontrada.");
    if (operation.status === "CANCELADA") return { id, repetida: true };
    const finance = (
      await client.query(
        "SELECT id FROM lancamento_financeiro WHERE operacao_id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!finance)
      throw new HttpError(409, "A operação não possui lançamento financeiro.");
    const { rows: movements } = await client.query(
      `SELECT m.* FROM movimentacao_estoque m JOIN item_operacao i ON i.id=m.item_operacao_id WHERE i.operacao_id=$1 AND m.estorno_de IS NULL ORDER BY m.insumo_id,m.id`,
      [id],
    );
    const ingredients = await lockIngredients(
      client,
      movements.map((m) => m.insumo_id),
      false,
    );
    await requireStock(
      client,
      aggregate(movements.filter((m) => m.natureza === "ENTRADA")),
      ingredients,
    );
    const when = (await client.query("SELECT clock_timestamp() AS instante"))
      .rows[0].instante;
    for (const movement of movements)
      await client.query(
        `INSERT INTO movimentacao_estoque(insumo_id,item_operacao_id,usuario_id,natureza,motivo,descricao,quantidade,estorno_de,data_hora) VALUES($1,$2,$3,$4,'ESTORNO',$5,$6,$7,$8)`,
        [
          movement.insumo_id,
          movement.item_operacao_id,
          userId,
          movement.natureza === "ENTRADA" ? "SAIDA" : "ENTRADA",
          reason,
          movement.quantidade,
          movement.id,
          when,
        ],
      );
    await client.query(
      "UPDATE operacao SET status='CANCELADA',cancelado_em=$2,cancelado_por=$3,motivo_cancelamento=$4 WHERE id=$1",
      [id, when, userId, reason],
    );
    await client.query(
      "UPDATE lancamento_financeiro SET status='CANCELADO',cancelado_em=$2,cancelado_por=$3,motivo_cancelamento=$4 WHERE id=$1",
      [finance.id, when, userId, reason],
    );
    return { id, repetida: false };
  });
}
export async function createMovement(
  data: z.infer<typeof movementSchema>,
  userId: string,
) {
  return transaction(async (client) => {
    const hash = fingerprint(userId, data);
    const existing = await idempotency(
      client,
      "movimentacao_estoque",
      data.chave_idempotencia,
      hash,
    );
    if (existing) return { id: existing.id, repetida: true };
    const ingredients = await lockIngredients(client, [data.insumo_id], false);
    checkUnit(ingredients.get(data.insumo_id)!, data.quantidade);
    if (data.natureza === "SAIDA")
      await requireStock(client, aggregate([data]), ingredients);
    const { rows } = await client.query(
      `INSERT INTO movimentacao_estoque(insumo_id,usuario_id,natureza,motivo,descricao,quantidade,chave_idempotencia,requisicao_hash,data_hora) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()) RETURNING id`,
      [
        data.insumo_id,
        userId,
        data.natureza,
        data.motivo,
        data.descricao,
        data.quantidade,
        data.chave_idempotencia,
        hash,
      ],
    );
    return { id: rows[0].id, repetida: false };
  });
}
export async function createExpense(
  data: z.infer<typeof expenseSchema>,
  userId: string,
) {
  return transaction(async (client) => {
    const hash = fingerprint(userId, data);
    const existing = await idempotency(
      client,
      "lancamento_financeiro",
      data.chave_idempotencia,
      hash,
    );
    if (existing) return { id: existing.id, repetida: true };
    const { rows } = await client.query(
      `INSERT INTO lancamento_financeiro(usuario_id,tipo,descricao,valor,vencimento,pago_em,status,forma_pagamento,chave_idempotencia,requisicao_hash) VALUES($1,'DESPESA',$2,$3,$4,CASE WHEN $5='PAGO' THEN clock_timestamp() ELSE NULL END,$5,$6,$7,$8) RETURNING id`,
      [
        userId,
        data.descricao,
        data.valor,
        data.vencimento,
        data.situacao_pagamento,
        data.situacao_pagamento === "PAGO" ? data.forma_pagamento : null,
        data.chave_idempotencia,
        hash,
      ],
    );
    return { id: rows[0].id, repetida: false };
  });
}
export async function payExpense(id: string, method: string) {
  return transaction(async (client) => {
    const entry = (
      await client.query(
        "SELECT * FROM lancamento_financeiro WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!entry) throw new HttpError(404, "Lançamento não encontrado.");
    if (entry.tipo !== "DESPESA" || entry.status === "CANCELADO")
      throw new HttpError(409, "Este lançamento não pode ser pago.");
    if (entry.status === "PAGO") {
      if (entry.forma_pagamento !== method)
        throw new HttpError(
          409,
          "O lançamento já foi pago com outra forma de pagamento.",
        );
      return { id, repetida: true };
    }
    await client.query(
      "UPDATE lancamento_financeiro SET status='PAGO',pago_em=clock_timestamp(),forma_pagamento=$2 WHERE id=$1",
      [id, method],
    );
    return { id, repetida: false };
  });
}
export async function createIncome(
  data: z.infer<typeof incomeSchema>,
  userId: string,
) {
  return transaction(async (client) => {
    const hash = fingerprint(userId, { ...data, tipo: "RECEITA" });
    const existing = await idempotency(
      client,
      "lancamento_financeiro",
      data.chave_idempotencia,
      hash,
    );
    if (existing) return { id: existing.id, repetida: true };
    const { rows } = await client.query(
      "INSERT INTO lancamento_financeiro(usuario_id,tipo,descricao,valor,pago_em,status,forma_pagamento,chave_idempotencia,requisicao_hash) VALUES($1,'RECEITA',$2,$3,clock_timestamp(),'PAGO',$4,$5,$6) RETURNING id",
      [
        userId,
        data.descricao,
        data.valor,
        data.forma_pagamento,
        data.chave_idempotencia,
        hash,
      ],
    );
    return { id: rows[0].id, repetida: false };
  });
}
export async function cancelExpense(
  id: string,
  reason: string,
  userId: string,
) {
  return transaction(async (client) => {
    const entry = (
      await client.query(
        "SELECT * FROM lancamento_financeiro WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!entry) throw new HttpError(404, "Lançamento não encontrado.");
    if (entry.operacao_id)
      throw new HttpError(
        409,
        "Cancele pela compra ou venda de origem para estornar o estoque junto com o financeiro.",
      );
    if (entry.status === "CANCELADO") return { id, repetida: true };
    await client.query(
      "UPDATE lancamento_financeiro SET status='CANCELADO',cancelado_em=clock_timestamp(),cancelado_por=$2,motivo_cancelamento=$3 WHERE id=$1",
      [id, userId, reason],
    );
    return { id, repetida: false };
  });
}
