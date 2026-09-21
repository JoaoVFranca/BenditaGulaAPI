import { z } from "zod";
import { idSchema, priceSchema, quantitySchema } from "../validation.js";
export const positiveQuantity = quantitySchema.refine(
  (v) => Number(v) > 0,
  "A quantidade deve ser positiva.",
);
export const positivePrice = priceSchema.refine(
  (v) => Number(v) > 0,
  "O valor deve ser positivo.",
);
export const paymentMethod = z.enum([
  "DINHEIRO",
  "PIX",
  "DEBITO",
  "CREDITO",
  "TRANSFERENCIA",
  "OUTRO",
]);
const dueDate = z.iso
  .date()
  .refine(
    (v) => v >= "2000-01-01" && v <= "2100-12-31",
    "Use uma data entre 2000 e 2100.",
  );
const description = z.string().trim().min(3).max(250);
const payment = {
  situacao_pagamento: z.enum(["PAGO", "PENDENTE"]),
  vencimento: dueDate.nullable(),
  forma_pagamento: paymentMethod.nullable(),
};
const purchase = z.strictObject({
  tipo: z.literal("COMPRA"),
  chave_idempotencia: idSchema,
  fornecedor_nome: z.string().trim().max(120).nullable(),
  observacoes: z.string().trim().max(1000).optional(),
  ...payment,
  itens: z
    .array(
      z
        .strictObject({
          insumo_id: idSchema,
          quantidade: positiveQuantity,
          valor_unitario: positivePrice.optional(),
          valor_total: positivePrice.optional(),
        })
        .refine(
          (v) =>
            (v.valor_unitario !== undefined) !== (v.valor_total !== undefined),
          "Informe exatamente um valor: unitário ou total.",
        ),
    )
    .min(1)
    .max(100),
});
const sale = z.strictObject({
  tipo: z.literal("VENDA"),
  chave_idempotencia: idSchema,
  forma_pagamento: paymentMethod,
  observacoes: z.string().trim().max(1000).optional(),
  itens: z
    .array(
      z.strictObject({
        produto_id: idSchema,
        quantidade: positiveQuantity.refine(
          (v) => Number.isInteger(Number(v)),
          "Produtos são vendidos em unidades inteiras.",
        ),
        preco_esperado: positivePrice,
        valor_unitario: positivePrice.optional(),
      }),
    )
    .min(1)
    .max(100),
});
export const operationSchema = z
  .discriminatedUnion("tipo", [purchase, sale])
  .superRefine((v, ctx) => {
    const ids =
      v.tipo === "COMPRA"
        ? v.itens.map((i) => i.insumo_id)
        : v.itens.map((i) => i.produto_id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["itens"],
        message: "Agrupe as quantidades; não repita o mesmo item.",
      });
    if (v.tipo === "COMPRA") validatePayment(v, ctx);
  });
function validatePayment(
  v: {
    situacao_pagamento: string;
    vencimento: string | null;
    forma_pagamento: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (v.situacao_pagamento === "PENDENTE" && !v.vencimento)
    ctx.addIssue({
      code: "custom",
      path: ["vencimento"],
      message: "Informe o vencimento da despesa pendente.",
    });
  if (v.situacao_pagamento === "PAGO" && !v.forma_pagamento)
    ctx.addIssue({
      code: "custom",
      path: ["forma_pagamento"],
      message: "Informe a forma de pagamento.",
    });
}
export const expenseFields = z.strictObject({
  descricao: description,
  valor: positivePrice,
  ...payment,
});
export const expenseSchema = expenseFields
  .extend({ chave_idempotencia: idSchema })
  .superRefine(validatePayment);
export const expenseEditSchema = z.strictObject({
  descricao: description,
  valor: positivePrice,
  vencimento: dueDate,
});
export const incomeSchema = z.strictObject({
  chave_idempotencia: idSchema,
  descricao: description,
  valor: positivePrice,
  forma_pagamento: paymentMethod,
});
export const paySchema = z.strictObject({ forma_pagamento: paymentMethod });
export const cancelSchema = z.strictObject({ motivo: description });
export const movementSchema = z
  .strictObject({
    chave_idempotencia: idSchema,
    insumo_id: idSchema,
    natureza: z.enum(["ENTRADA", "SAIDA"]),
    motivo: z.enum(["AJUSTE", "PERDA"]),
    descricao: description,
    quantidade: positiveQuantity,
  })
  .refine((v) => v.motivo !== "PERDA" || v.natureza === "SAIDA", {
    path: ["natureza"],
    message: "Uma perda deve ser uma saída de estoque.",
  });
const pagination = {
  pagina: z.coerce.number().int().min(1).max(100000).default(1),
};
const dateRange = { inicio: dueDate.optional(), fim: dueDate.optional() };
function validRange(v: { inicio?: string; fim?: string }) {
  return !v.inicio || !v.fim || v.inicio <= v.fim;
}
export const operationListSchema = z
  .strictObject({
    ...pagination,
    ...dateRange,
    tipo: z.enum(["COMPRA", "VENDA"]).optional(),
    status: z.enum(["CONFIRMADA", "CANCELADA"]).optional(),
  })
  .refine(validRange, "A data inicial deve ser anterior à final.");
export const stockListSchema = z.strictObject({
  ...pagination,
  busca: z.string().trim().max(120).default(""),
  alerta: z.enum(["MINIMO", "VALIDADE"]).optional(),
});
export const historySchema = z
  .strictObject({ ...pagination, ...dateRange, insumo_id: idSchema.optional() })
  .refine(validRange, "Período inválido.");
export const financeListSchema = z
  .strictObject({
    ...pagination,
    ...dateRange,
    status: z.enum(["PAGO", "PENDENTE", "CANCELADO"]).optional(),
  })
  .refine(validRange, "Período inválido.");
export const reportSchema = z
  .strictObject({ inicio: dueDate, fim: dueDate })
  .refine(validRange, "A data inicial deve ser anterior à final.");
export const cashEventSchema = z
  .strictObject({ ...pagination, ...dateRange })
  .refine(validRange, "Período inválido.");
export type OperationInput = z.infer<typeof operationSchema>;
