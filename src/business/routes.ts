import { Router } from "express";
import { pool, transaction } from "../db.js";
import { HttpError } from "../errors.js";
import { idSchema } from "../validation.js";
import {
  cashEventSchema,
  cancelSchema,
  expenseEditSchema,
  expenseSchema,
  financeListSchema,
  historySchema,
  movementSchema,
  operationListSchema,
  operationSchema,
  paySchema,
  reportSchema,
  stockListSchema,
  incomeSchema,
} from "./schemas.js";
import {
  cancelExpense,
  cancelOperation,
  createExpense,
  createMovement,
  createOperation,
  payExpense,
  previewOperation,
  createIncome,
} from "./service.js";
export const businessRouter = Router();
const pageSize = 50;
const page = (rows: unknown[]) => ({
  items: rows.slice(0, pageSize),
  more: rows.length > pageSize,
});
// Um único fuso para datas comerciais, independente do fuso do servidor/cliente.
const zone = "'America/Sao_Paulo'";
function filters() {
  const values: unknown[] = [];
  const clauses: string[] = [];
  return {
    values,
    clauses,
    add(expression: string, value: unknown) {
      values.push(value);
      clauses.push(expression.replace("?", `$${values.length}`));
    },
    sql() {
      return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    },
    limit(pagina: number) {
      values.push(pageSize + 1, (pagina - 1) * pageSize);
      return `LIMIT $${values.length - 1} OFFSET $${values.length}`;
    },
  };
}
businessRouter.post("/operacoes/prever", async (req, res) =>
  res.json(await previewOperation(operationSchema.parse(req.body))),
);
businessRouter.post("/operacoes", async (req, res) => {
  const result = await createOperation(
    operationSchema.parse(req.body),
    res.locals.user.id,
  );
  res.status(result.repetida ? 200 : 201).json(result);
});
businessRouter.get("/operacoes", async (req, res) => {
  const query = operationListSchema.parse(req.query);
  const f = filters();
  if (query.tipo) f.add("o.tipo=?", query.tipo);
  if (query.status) f.add("o.status=?", query.status);
  if (query.inicio)
    f.add(
      `o.data_hora>=(?::date::timestamp AT TIME ZONE ${zone})`,
      query.inicio,
    );
  if (query.fim)
    f.add(
      `o.data_hora<((?::date+1)::timestamp AT TIME ZONE ${zone})`,
      query.fim,
    );
  const sql = `SELECT o.id,o.tipo,o.status,o.total,o.data_hora,o.fornecedor_nome,o.forma_pagamento,u.nome AS usuario_nome,l.status AS pagamento_status FROM operacao o JOIN usuario u ON u.id=o.usuario_id JOIN lancamento_financeiro l ON l.operacao_id=o.id ${f.sql()} ORDER BY o.data_hora DESC,o.id ${f.limit(query.pagina)}`;
  res.json(page((await pool.query(sql, f.values)).rows));
});
businessRouter.get("/operacoes/:id", async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const { rows } = await pool.query(
    `SELECT o.id,o.tipo,o.status,o.total,o.data_hora,o.fornecedor_nome,o.observacoes,o.forma_pagamento,o.cancelado_em,o.motivo_cancelamento,u.nome AS usuario_nome,
    (SELECT json_agg(json_build_object('id',i.id,'nome',i.nome_snapshot,'unidade',i.unidade_snapshot,'quantidade',i.quantidade::text,'valor_unitario',i.valor_unitario::text,'subtotal',i.subtotal::text,'preco_catalogo',i.preco_catalogo::text,'valor_informado',i.valor_informado) ORDER BY i.nome_snapshot,i.id) FROM item_operacao i WHERE i.operacao_id=o.id) AS itens,
    json_build_object('id',l.id,'status',l.status,'pago_em',l.pago_em,'vencimento',to_char(l.vencimento,'YYYY-MM-DD'),'forma_pagamento',l.forma_pagamento) AS financeiro
    FROM operacao o JOIN usuario u ON u.id=o.usuario_id JOIN lancamento_financeiro l ON l.operacao_id=o.id WHERE o.id=$1`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, "Operação não encontrada.");
  res.json(rows[0]);
});
businessRouter.post("/operacoes/:id/cancelar", async (req, res) =>
  res.json(
    await cancelOperation(
      idSchema.parse(req.params.id),
      cancelSchema.parse(req.body).motivo,
      res.locals.user.id,
    ),
  ),
);

const stockSql = `SELECT i.id,i.nome,i.unidade_medida,i.estoque_minimo,to_char(i.validade_referencia,'YYYY-MM-DD') AS validade_referencia,i.ativo,
  COALESCE((SELECT sum(CASE WHEN m.natureza='ENTRADA' THEN m.quantidade ELSE -m.quantidade END) FROM movimentacao_estoque m WHERE m.insumo_id=i.id),0) AS saldo,
  i.validade_referencia IS NOT NULL AND i.validade_referencia<(now() AT TIME ZONE ${zone})::date AS vencido,
  i.validade_referencia IS NOT NULL AND i.validade_referencia BETWEEN (now() AT TIME ZONE ${zone})::date AND (now() AT TIME ZONE ${zone})::date+7 AS vence_em_breve FROM insumo i`;
businessRouter.get("/estoque", async (req, res) => {
  const query = stockListSchema.parse(req.query);
  const f = filters();
  f.add("s.nome ILIKE ?", `%${query.busca}%`);
  if (query.alerta === "MINIMO")
    f.clauses.push("s.ativo AND s.saldo<s.estoque_minimo");
  if (query.alerta === "VALIDADE")
    f.clauses.push("s.ativo AND (s.vencido OR s.vence_em_breve)");
  const sql = `SELECT s.*,s.saldo<s.estoque_minimo AS abaixo_minimo FROM (${stockSql}) s ${f.sql()} ORDER BY s.nome,s.id ${f.limit(query.pagina)}`;
  res.json(page((await pool.query(sql, f.values)).rows));
});
businessRouter.get("/estoque/resumo", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS insumos_ativos,count(*) FILTER(WHERE saldo<estoque_minimo)::int AS abaixo_minimo,count(*) FILTER(WHERE vencido)::int AS vencidos,count(*) FILTER(WHERE vence_em_breve)::int AS vence_em_breve FROM (${stockSql}) s WHERE s.ativo`,
  );
  res.json(rows[0]);
});
businessRouter.get("/estoque/movimentos", async (req, res) => {
  const query = historySchema.parse(req.query);
  const f = filters();
  if (query.insumo_id) f.add("m.insumo_id=?", query.insumo_id);
  if (query.inicio)
    f.add(
      `m.data_hora>=(?::date::timestamp AT TIME ZONE ${zone})`,
      query.inicio,
    );
  if (query.fim)
    f.add(
      `m.data_hora<((?::date+1)::timestamp AT TIME ZONE ${zone})`,
      query.fim,
    );
  const sql = `SELECT m.id,m.insumo_id,m.natureza,m.motivo,m.descricao,m.quantidade,m.data_hora,m.estorno_de,i.nome AS insumo_nome,i.unidade_medida,u.nome AS usuario_nome,it.operacao_id FROM movimentacao_estoque m JOIN insumo i ON i.id=m.insumo_id JOIN usuario u ON u.id=m.usuario_id LEFT JOIN item_operacao it ON it.id=m.item_operacao_id ${f.sql()} ORDER BY m.data_hora DESC,m.id ${f.limit(query.pagina)}`;
  res.json(page((await pool.query(sql, f.values)).rows));
});
businessRouter.post("/estoque/movimentos", async (req, res) => {
  const result = await createMovement(
    movementSchema.parse(req.body),
    res.locals.user.id,
  );
  res.status(result.repetida ? 200 : 201).json(result);
});

businessRouter.get("/financeiro", async (req, res) => {
  const query = financeListSchema.parse(req.query);
  const f = filters();
  if (query.status) f.add("l.status=?", query.status);
  const date = `COALESCE((l.pago_em AT TIME ZONE ${zone})::date,l.vencimento,(l.criado_em AT TIME ZONE ${zone})::date)`;
  if (query.inicio) f.add(`${date}>=?::date`, query.inicio);
  if (query.fim) f.add(`${date}<=?::date`, query.fim);
  const sql = `SELECT l.id,l.operacao_id,l.tipo,l.descricao,l.valor,to_char(l.vencimento,'YYYY-MM-DD') AS vencimento,l.pago_em,l.criado_em,l.status,l.forma_pagamento,l.cancelado_em,l.motivo_cancelamento,l.status='PENDENTE' AND l.vencimento<(now() AT TIME ZONE ${zone})::date AS atrasado FROM lancamento_financeiro l ${f.sql()} ORDER BY CASE WHEN l.status='PENDENTE' THEN 0 ELSE 1 END,l.vencimento ASC NULLS LAST,l.criado_em DESC,l.id ${f.limit(query.pagina)}`;
  res.json(page((await pool.query(sql, f.values)).rows));
});
businessRouter.post("/financeiro/despesas", async (req, res) => {
  const result = await createExpense(
    expenseSchema.parse(req.body),
    res.locals.user.id,
  );
  res.status(result.repetida ? 200 : 201).json(result);
});
businessRouter.post("/financeiro/receitas", async (req, res) => {
  const result = await createIncome(
    incomeSchema.parse(req.body),
    res.locals.user.id,
  );
  res.status(result.repetida ? 200 : 201).json(result);
});
businessRouter.put("/financeiro/despesas/:id", async (req, res) => {
  const id = idSchema.parse(req.params.id),
    data = expenseEditSchema.parse(req.body);
  await transaction(async (client) => {
    const entry = (
      await client.query(
        "SELECT status,operacao_id,tipo FROM lancamento_financeiro WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!entry) throw new HttpError(404, "Despesa não encontrada.");
    if (
      entry.tipo !== "DESPESA" ||
      entry.operacao_id ||
      entry.status !== "PENDENTE"
    )
      throw new HttpError(
        409,
        "Somente despesas avulsas pendentes podem ser editadas.",
      );
    await client.query(
      "UPDATE lancamento_financeiro SET descricao=$2,valor=$3,vencimento=$4 WHERE id=$1",
      [id, data.descricao, data.valor, data.vencimento],
    );
  });
  res.json({ id });
});
businessRouter.post("/financeiro/:id/pagar", async (req, res) =>
  res.json(
    await payExpense(
      idSchema.parse(req.params.id),
      paySchema.parse(req.body).forma_pagamento,
    ),
  ),
);
businessRouter.post("/financeiro/:id/cancelar", async (req, res) =>
  res.json(
    await cancelExpense(
      idSchema.parse(req.params.id),
      cancelSchema.parse(req.body).motivo,
      res.locals.user.id,
    ),
  ),
);

// Pagamentos e estornos são eventos em suas datas reais; cancelar não apaga o caixa passado.
export const cashEvents = `SELECT id,operacao_id,descricao,tipo,pago_em AS data_hora,CASE WHEN tipo='RECEITA' THEN valor ELSE -valor END AS valor,false AS estorno FROM lancamento_financeiro WHERE pago_em IS NOT NULL
  UNION ALL SELECT id,operacao_id,descricao,tipo,cancelado_em,CASE WHEN tipo='RECEITA' THEN -valor ELSE valor END,true FROM lancamento_financeiro WHERE pago_em IS NOT NULL AND cancelado_em IS NOT NULL`;
businessRouter.get("/relatorios/caixa", async (req, res) => {
  const { inicio, fim } = reportSchema.parse(req.query);
  if ((Date.parse(fim) - Date.parse(inicio)) / 86400000 > 365)
    throw new HttpError(422, "Selecione um período de até 366 dias.");
  const { rows } = await pool.query(
    `WITH limites AS (SELECT $1::date::timestamp AT TIME ZONE ${zone} AS inicio,($2::date+1)::timestamp AT TIME ZONE ${zone} AS fim),eventos AS (${cashEvents}),periodo AS (SELECT e.* FROM eventos e,limites l WHERE e.data_hora>=l.inicio AND e.data_hora<l.fim),dias AS (
    SELECT (data_hora AT TIME ZONE ${zone})::date AS dia,
    COALESCE(sum(valor) FILTER(WHERE NOT estorno AND tipo='RECEITA'),0) AS receitas,
    COALESCE(sum(-valor) FILTER(WHERE NOT estorno AND tipo='DESPESA'),0) AS despesas,
    COALESCE(sum(-valor) FILTER(WHERE estorno AND tipo='RECEITA'),0) AS estornos_receitas,
    COALESCE(sum(valor) FILTER(WHERE estorno AND tipo='DESPESA'),0) AS estornos_despesas,sum(valor) AS saldo FROM periodo GROUP BY 1)
    SELECT COALESCE((SELECT sum(e.valor) FROM eventos e,limites l WHERE e.data_hora<l.inicio),0)::text AS saldo_anterior,
      COALESCE((SELECT sum(e.valor) FROM eventos e,limites l WHERE e.data_hora<l.fim),0)::text AS saldo_final,
      COALESCE((SELECT sum(valor) FROM periodo),0)::text AS resultado_periodo,
      COALESCE((SELECT sum(valor) FROM periodo WHERE NOT estorno AND tipo='RECEITA'),0)::text AS receitas,
      COALESCE((SELECT sum(-valor) FROM periodo WHERE NOT estorno AND tipo='DESPESA'),0)::text AS despesas,
      COALESCE((SELECT sum(-valor) FROM periodo WHERE tipo='DESPESA'),0)::text AS despesas_liquidas,
      COALESCE((SELECT sum(-valor) FROM periodo WHERE estorno AND tipo='RECEITA'),0)::text AS estornos_receitas,
      COALESCE((SELECT sum(valor) FROM periodo WHERE estorno AND tipo='DESPESA'),0)::text AS estornos_despesas,
      COALESCE((SELECT sum(valor) FROM lancamento_financeiro WHERE status='PENDENTE' AND vencimento BETWEEN $1::date AND $2::date),0)::text AS pendentes_periodo,
      COALESCE((SELECT sum(valor) FROM lancamento_financeiro WHERE status='PENDENTE' AND vencimento<(now() AT TIME ZONE ${zone})::date),0)::text AS atrasadas_hoje,
      COALESCE((SELECT json_agg(json_build_object('dia',to_char(dia,'YYYY-MM-DD'),'receitas',receitas::text,'despesas',despesas::text,'estornos_receitas',estornos_receitas::text,'estornos_despesas',estornos_despesas::text,'saldo',saldo::text) ORDER BY dia) FROM dias),'[]'::json) AS dias`,
    [inicio, fim],
  );
  res.json({ inicio, fim, fuso: "America/Sao_Paulo", ...rows[0] });
});
businessRouter.get("/relatorios/caixa/eventos", async (req, res) => {
  const parsed = cashEventSchema.parse(req.query);
  const f = filters();
  if (parsed.inicio)
    f.add(
      `e.data_hora>=(?::date::timestamp AT TIME ZONE ${zone})`,
      parsed.inicio,
    );
  if (parsed.fim)
    f.add(
      `e.data_hora<((?::date+1)::timestamp AT TIME ZONE ${zone})`,
      parsed.fim,
    );
  const sql = `SELECT e.* FROM (${cashEvents}) e ${f.sql()} ORDER BY e.data_hora DESC,e.id,e.estorno ${f.limit(parsed.pagina)}`;
  res.json(page((await pool.query(sql, f.values)).rows));
});
