import { z } from "zod";
export const isWholeUnit = (unit: string) => unit === "un" || unit === "fatia";
export const idSchema = z.uuid();
const name = z.string().trim().min(2).max(120);
export const emailSchema = z.email().trim().toLowerCase().max(254);
export const passwordSchema = z
  .string()
  .min(12, "A senha deve ter pelo menos 12 caracteres.")
  .max(128);
export const userSchema = z.strictObject({
  nome: name,
  email: emailSchema,
  senha: passwordSchema,
});
export const loginSchema = z.strictObject({
  email: emailSchema,
  senha: z.string().min(1).max(128),
});
// Valores decimais atravessam a API como texto para evitar arredondamento binário silencioso.
export const quantitySchema = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,5})(\.\d{1,3})?$/,
    "Use um número positivo com até três casas decimais.",
  );
export const priceSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,5})(\.\d{1,2})?$/,
    "Use um valor com até duas casas decimais.",
  );
export const ingredientSchema = z
  .strictObject({
    nome: name,
    unidade_medida: z.enum(["un", "kg", "L", "fatia"]),
    estoque_minimo: quantitySchema,
    validade_referencia: z.iso.date().nullable(),
    ativo: z.boolean(),
    criar_produto: z.boolean().optional(),
    preco_venda: priceSchema
      .refine((v) => Number(v) > 0, "Informe um preço de venda positivo.")
      .optional(),
  })
  .refine(
    (v) =>
      !isWholeUnit(v.unidade_medida) ||
      Number.isInteger(Number(v.estoque_minimo)),
    {
      path: ["estoque_minimo"],
      message: "Unidades e fatias exigem quantidade inteira.",
    },
  )
  .superRefine((v, ctx) => {
    if (v.criar_produto && (!isWholeUnit(v.unidade_medida) || !v.preco_venda))
      ctx.addIssue({
        code: "custom",
        path: ["criar_produto"],
        message: "A venda direta exige unidade un ou fatia e preço de venda.",
      });
    if (!v.criar_produto && v.preco_venda !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["preco_venda"],
        message: "Informe preço de venda somente ao criar um produto.",
      });
  });
export const productSchema = z
  .strictObject({
    nome: name,
    preco: priceSchema.refine(
      (v) => Number(v) > 0,
      "O preço deve ser maior que zero.",
    ),
    ativo: z.boolean(),
    composicao: z
      .array(
        z.strictObject({
          insumo_id: idSchema,
          quantidade: quantitySchema.refine(
            (v) => Number(v) > 0,
            "A quantidade deve ser maior que zero.",
          ),
        }),
      )
      .max(100),
  })
  .refine(
    (v) =>
      new Set(v.composicao.map((i) => i.insumo_id)).size ===
      v.composicao.length,
    {
      path: ["composicao"],
      message: "Não repita o mesmo insumo na composição.",
    },
  );
export const listSchema = z.strictObject({
  situacao: z.enum(["TODOS", "ATIVOS", "INATIVOS"]).default("TODOS"),
  busca: z.string().trim().max(120).default(""),
  pagina: z.coerce.number().int().min(1).max(100000).default(1),
});
