import "dotenv/config";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import request from "supertest";

test("Operações, estoque e caixa no PostgreSQL real", async (t) => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const schema = `test_business_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.NODE_ENV = "test";
  const { pool } = await import("../src/db.js");
  const { app, sessionStore } = await import("../src/app.js");
  const { hashPassword } = await import("../src/password.js");
  const agent = request.agent(app);
  let token = "";
  const origin = process.env.APP_ORIGIN!;
  let userId = "";
  const post = (path: string, data: unknown) =>
    agent
      .post(`/api${path}`)
      .set("Origin", origin)
      .set("X-CSRF-Token", token)
      .send(data);
  const put = (path: string, data: unknown) =>
    agent
      .put(`/api${path}`)
      .set("Origin", origin)
      .set("X-CSRF-Token", token)
      .send(data);
  const get = (path: string) => agent.get(`/api${path}`);
  async function catalog(unit = "un", consumption = "1", price = "10.00") {
    const ingredient = (
      await pool.query(
        "INSERT INTO insumo(nome,unidade_medida,estoque_minimo) VALUES($1,$2,2) RETURNING id",
        [`Insumo ${randomUUID().slice(0, 8)}`, unit],
      )
    ).rows[0].id;
    const product = (
      await pool.query(
        "INSERT INTO produto(nome,preco) VALUES($1,$2) RETURNING id",
        [`Produto ${randomUUID().slice(0, 8)}`, price],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO composicao_produto(produto_id,insumo_id,quantidade) VALUES($1,$2,$3)",
      [product, ingredient, consumption],
    );
    return { ingredient, product };
  }
  const buy = (ingredient: string, amount = "10", paid = false) => ({
    tipo: "COMPRA",
    chave_idempotencia: randomUUID(),
    fornecedor_nome: "Fornecedor teste",
    situacao_pagamento: paid ? "PAGO" : "PENDENTE",
    vencimento: paid ? null : "2026-10-01",
    forma_pagamento: paid ? "PIX" : null,
    itens: [
      { insumo_id: ingredient, quantidade: amount, valor_unitario: "2.00" },
    ],
  });
  const sell = (product: string, amount = "1", price = "10.00") => ({
    tipo: "VENDA",
    chave_idempotencia: randomUUID(),
    forma_pagamento: "DINHEIRO",
    itens: [{ produto_id: product, quantidade: amount, preco_esperado: price }],
  });
  const expense = (paid = false) => ({
    chave_idempotencia: randomUUID(),
    descricao: "Energia teste",
    valor: "100.00",
    situacao_pagamento: paid ? "PAGO" : "PENDENTE",
    vencimento: paid ? null : "2026-10-10",
    forma_pagamento: paid ? "PIX" : null,
  });
  async function balance(id: string) {
    return (
      await pool.query(
        "SELECT COALESCE(sum(CASE WHEN natureza='ENTRADA' THEN quantidade ELSE -quantidade END),0)::text AS saldo FROM movimentacao_estoque WHERE insumo_id=$1",
        [id],
      )
    ).rows[0].saldo;
  }
  const cancel = (id: string) =>
    post(`/operacoes/${id}/cancelar`, { motivo: "Cancelamento de teste" });
  try {
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await pool.query(await readFile(`migrations/${file}`, "utf8"));
    userId = (
      await pool.query(
        "INSERT INTO usuario(nome,email,senha_hash) VALUES($1,$2,$3) RETURNING id",
        [
          "Teste",
          "business@example.com",
          await hashPassword("senha longa de teste"),
        ],
      )
    ).rows[0].id;
    await t.test("Novas rotas exigem autenticação", async () => {
      for (const path of [
        "/operacoes",
        "/estoque",
        "/financeiro",
        "/relatorios/caixa?inicio=2026-01-01&fim=2026-01-02",
      ])
        await get(path).expect(401);
    });
    token = (await get("/auth/csrf")).body.token;
    token = (
      await post("/auth/login", {
        email: "business@example.com",
        senha: "senha longa de teste",
      }).expect(200)
    ).body.token;
    await t.test(
      "Compra pendente entra no estoque uma única vez, mesmo com confirmações simultâneas",
      async () => {
        const { ingredient } = await catalog();
        const body = buy(ingredient);
        const results = await Promise.all([
          post("/operacoes", body),
          post("/operacoes", body),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
        assert.equal(results[0].body.id, results[1].body.id);
        assert.equal(await balance(ingredient), "10.000");
        const detail = (
          await get(`/operacoes/${results[0].body.id}`).expect(200)
        ).body;
        assert.equal(detail.total, "20.00");
        assert.equal(detail.financeiro.status, "PENDENTE");
        assert.equal(detail.financeiro.pago_em, null);
        await post("/operacoes", {
          ...body,
          fornecedor_nome: "Outro fornecedor",
        }).expect(409);
        await post(`/financeiro/${detail.financeiro.id}/pagar`, {
          forma_pagamento: "PIX",
        }).expect(200);
        await post(`/financeiro/${detail.financeiro.id}/pagar`, {
          forma_pagamento: "PIX",
        }).expect(200);
        assert.equal(await balance(ingredient), "10.000");
        const entry = (
          await pool.query(
            "SELECT * FROM lancamento_financeiro WHERE operacao_id=$1",
            [detail.id],
          )
        ).rows;
        assert.equal(entry.length, 1);
        assert.equal(entry[0].status, "PAGO");
        assert.ok(entry[0].pago_em);
        await post(`/financeiro/${entry[0].id}/pagar`, {
          forma_pagamento: "DINHEIRO",
        }).expect(409);
        await post(`/financeiro/${entry[0].id}/cancelar`, {
          motivo: "Não deve cancelar isolado",
        }).expect(409);
      },
    );
    await t.test(
      "Compra fracionada arredonda cada item em centavos e preview não grava",
      async () => {
        const { ingredient } = await catalog("kg", "0.125");
        const body = buy(ingredient, "0.125", true);
        body.itens[0].valor_unitario = "1.00";
        const preview = (await post("/operacoes/prever", body).expect(200))
          .body;
        assert.equal(preview.total, "0.13");
        assert.equal(await balance(ingredient), "0");
        const result = await post("/operacoes", body).expect(201);
        const detail = (await get(`/operacoes/${result.body.id}`)).body;
        assert.equal(detail.total, "0.13");
        assert.equal(detail.itens[0].subtotal, "0.13");
        assert.equal(detail.financeiro.status, "PAGO");
        assert.equal(await balance(ingredient), "0.125");
      },
    );
    await t.test(
      "Validação rejeita totais enviados, unidades fracionadas, itens duplicados e datas ausentes",
      async () => {
        const { ingredient, product } = await catalog();
        const body = buy(ingredient);
        await post("/operacoes", { ...body, total: "0.01" }).expect(422);
        await post("/operacoes", {
          ...body,
          itens: [...body.itens, ...body.itens],
        }).expect(422);
        await post("/operacoes", { ...body, vencimento: null }).expect(422);
        await post("/operacoes", buy(ingredient, "0.5")).expect(422);
        await post("/operacoes", sell(product, "0.5")).expect(422);
        await post("/operacoes", {
          ...body,
          itens: [
            {
              insumo_id: randomUUID(),
              quantidade: "1",
              valor_unitario: "2.00",
            },
          ],
        }).expect(422);
        await post("/operacoes", { ...body, itens: [] }).expect(422);
        await get("/operacoes/nao-e-uuid").expect(422);
        await get("/financeiro?inicio=2026-10-01&fim=2026-01-01").expect(422);
        assert.equal(await balance(ingredient), "0");
      },
    );
    await t.test(
      "Venda calcula receita e consumo; cancelamento usa movimentos originais após mudar composição",
      async () => {
        const { ingredient, product } = await catalog("kg", "0.125", "7.90");
        await post("/operacoes", buy(ingredient, "2", true)).expect(201);
        const sale = sell(product, "2", "7.90");
        const result = await post("/operacoes", sale).expect(201);
        const detail = (await get(`/operacoes/${result.body.id}`)).body;
        assert.equal(detail.total, "15.80");
        assert.equal(detail.financeiro.status, "PAGO");
        assert.equal(await balance(ingredient), "1.750");
        await pool.query(
          "UPDATE composicao_produto SET quantidade=0.500 WHERE produto_id=$1",
          [product],
        );
        await pool.query(
          "UPDATE produto SET nome='Nome alterado',preco=20 WHERE id=$1",
          [product],
        );
        const historic = (await get(`/operacoes/${result.body.id}`)).body;
        assert.notEqual(historic.itens[0].nome, "Nome alterado");
        assert.equal(historic.itens[0].valor_unitario, "7.90000000");
        await cancel(result.body.id).expect(200);
        await cancel(result.body.id).expect(200);
        assert.equal(await balance(ingredient), "2.000");
        const movements = (
          await pool.query(
            "SELECT m.* FROM movimentacao_estoque m JOIN item_operacao i ON i.id=m.item_operacao_id WHERE i.operacao_id=$1",
            [result.body.id],
          )
        ).rows;
        assert.equal(movements.length, 2);
        assert.equal(movements.filter((m) => m.estorno_de).length, 1);
        const replay = await post("/operacoes", sale).expect(200);
        assert.equal(replay.body.id, result.body.id);
        assert.equal(await balance(ingredient), "2.000");
      },
    );
    await t.test(
      "Agrega o mesmo insumo em produtos distintos e recusa saldo insuficiente sem efeitos parciais",
      async () => {
        const { ingredient, product } = await catalog();
        const second = (
          await pool.query(
            "INSERT INTO produto(nome,preco) VALUES('Segundo produto',10) RETURNING id",
          )
        ).rows[0].id;
        await pool.query(
          "INSERT INTO composicao_produto(produto_id,insumo_id,quantidade) VALUES($1,$2,2)",
          [second, ingredient],
        );
        await post("/operacoes", buy(ingredient, "2")).expect(201);
        const body = sell(product);
        body.itens.push({
          produto_id: second,
          quantidade: "1",
          preco_esperado: "10.00",
        });
        await post("/operacoes", body).expect(409);
        assert.equal(await balance(ingredient), "2.000");
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM operacao WHERE chave_idempotencia=$1",
              [body.chave_idempotencia],
            )
          ).rows[0].n,
          0,
        );
        await post("/operacoes", sell(product, "1", "0.01")).expect(409);
      },
    );
    await t.test(
      "Duas vendas concorrentes disputando uma unidade: somente uma confirma",
      async () => {
        const { ingredient, product } = await catalog();
        await post("/operacoes", buy(ingredient, "1")).expect(201);
        const results = await Promise.all([
          post("/operacoes", sell(product)),
          post("/operacoes", sell(product)),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
        assert.equal(await balance(ingredient), "0.000");
      },
    );
    await t.test(
      "Cancelar compra consumida é bloqueado e cancelamento permitido é idempotente",
      async () => {
        const { ingredient, product } = await catalog();
        const purchase = await post(
          "/operacoes",
          buy(ingredient, "1", true),
        ).expect(201);
        const sale = await post("/operacoes", sell(product)).expect(201);
        await cancel(purchase.body.id).expect(409);
        assert.equal(
          (await get(`/operacoes/${purchase.body.id}`)).body.status,
          "CONFIRMADA",
        );
        assert.equal(
          (await get(`/operacoes/${purchase.body.id}`)).body.financeiro.status,
          "PAGO",
        );
        await cancel(sale.body.id).expect(200);
        const results = await Promise.all([
          cancel(purchase.body.id),
          cancel(purchase.body.id),
        ]);
        assert.deepEqual(
          results.map((r) => r.status),
          [200, 200],
        );
        assert.equal(await balance(ingredient), "0.000");
      },
    );
    await t.test(
      "Ajustes e perdas validam motivo, protegem saldo e não criam financeiro",
      async () => {
        const { ingredient } = await catalog();
        const input = {
          chave_idempotencia: randomUUID(),
          insumo_id: ingredient,
          natureza: "ENTRADA",
          motivo: "AJUSTE",
          descricao: "Contagem inicial",
          quantidade: "3",
        };
        const before = (
          await pool.query(
            "SELECT count(*)::int AS n FROM lancamento_financeiro",
          )
        ).rows[0].n;
        await post("/estoque/movimentos", input).expect(201);
        await post("/estoque/movimentos", input).expect(200);
        await post("/estoque/movimentos", {
          ...input,
          chave_idempotencia: randomUUID(),
          natureza: "SAIDA",
          motivo: "PERDA",
          quantidade: "1",
        }).expect(201);
        await post("/estoque/movimentos", {
          ...input,
          chave_idempotencia: randomUUID(),
          natureza: "SAIDA",
          quantidade: "3",
        }).expect(409);
        await post("/estoque/movimentos", {
          ...input,
          chave_idempotencia: randomUUID(),
          motivo: "PERDA",
        }).expect(422);
        await post("/estoque/movimentos", {
          ...input,
          chave_idempotencia: randomUUID(),
          descricao: "",
        }).expect(422);
        assert.equal(await balance(ingredient), "2.000");
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM lancamento_financeiro",
            )
          ).rows[0].n,
          before,
        );
        const history = (
          await get(`/estoque/movimentos?insumo_id=${ingredient}`)
        ).body;
        assert.equal(history.items.length, 2);
      },
    );
    await t.test(
      "Alertas de mínimo e validade não alteram saldo nem bloqueiam vendas por data",
      async () => {
        const { ingredient, product } = await catalog();
        await pool.query(
          "UPDATE insumo SET validade_referencia='2000-01-01' WHERE id=$1",
          [ingredient],
        );
        await post("/operacoes", buy(ingredient, "1")).expect(201);
        const list = (await get("/estoque?alerta=VALIDADE").expect(200)).body;
        assert.equal(
          list.items.find((i: { id: string }) => i.id === ingredient).vencido,
          true,
        );
        const low = (await get("/estoque?alerta=MINIMO").expect(200)).body;
        assert.ok(low.items.some((i: { id: string }) => i.id === ingredient));
        await post("/operacoes", sell(product)).expect(201);
        const summary = (await get("/estoque/resumo").expect(200)).body;
        assert.ok(summary.vencidos >= 1);
        assert.ok(summary.abaixo_minimo >= 1);
      },
    );
    await t.test(
      "Despesa avulsa pode ser editada enquanto pendente, paga e cancelada sem apagar histórico",
      async () => {
        const data = expense();
        const created = await post("/financeiro/despesas", data).expect(201);
        const id = created.body.id;
        assert.equal(
          (await post("/financeiro/despesas", data).expect(200)).body.id,
          id,
        );
        await put(`/financeiro/despesas/${id}`, {
          descricao: "Energia corrigida",
          valor: "120.00",
          vencimento: "2026-10-11",
        }).expect(200);
        await post(`/financeiro/${id}/pagar`, {
          forma_pagamento: "PIX",
        }).expect(200);
        await put(`/financeiro/despesas/${id}`, {
          descricao: "Não alterar",
          valor: "1.00",
          vencimento: "2026-10-11",
        }).expect(409);
        await post(`/financeiro/${id}/cancelar`, {
          motivo: "Despesa lançada em duplicidade",
        }).expect(200);
        await post(`/financeiro/${id}/cancelar`, {
          motivo: "Despesa lançada em duplicidade",
        }).expect(200);
        const entry = (
          await pool.query("SELECT * FROM lancamento_financeiro WHERE id=$1", [
            id,
          ])
        ).rows[0];
        assert.equal(entry.valor, "120.00");
        assert.ok(entry.pago_em);
        assert.ok(entry.cancelado_em);
        assert.equal(entry.status, "CANCELADO");
        await post(`/financeiro/${id}/pagar`, {
          forma_pagamento: "PIX",
        }).expect(409);
      },
    );
    await t.test(
      "Pagamento e cancelamento concorrentes deixam uma situação financeira consistente",
      async () => {
        const { ingredient } = await catalog();
        const purchase = await post("/operacoes", buy(ingredient, "1")).expect(
          201,
        );
        const finance = (await get(`/operacoes/${purchase.body.id}`)).body
          .financeiro.id;
        const [paid, canceled] = await Promise.all([
          post(`/financeiro/${finance}/pagar`, { forma_pagamento: "PIX" }),
          cancel(purchase.body.id),
        ]);
        assert.ok([200, 409].includes(paid.status));
        assert.equal(canceled.status, 200);
        const entry = (
          await pool.query("SELECT * FROM lancamento_financeiro WHERE id=$1", [
            finance,
          ])
        ).rows[0];
        assert.equal(entry.status, "CANCELADO");
        assert.ok(entry.cancelado_em);
        assert.equal(await balance(ingredient), "0.000");
      },
    );
    await t.test(
      "Relatório preserva pagamento passado e reconhece estorno no dia correto em São Paulo",
      async () => {
        const created = await post(
          "/financeiro/despesas",
          expense(true),
        ).expect(201);
        const id = created.body.id;
        await pool.query(
          "UPDATE lancamento_financeiro SET pago_em='2026-08-02T02:59:59Z' WHERE id=$1",
          [id],
        );
        await post(`/financeiro/${id}/cancelar`, {
          motivo: "Estorno no dia seguinte",
        }).expect(200);
        await pool.query(
          "UPDATE lancamento_financeiro SET cancelado_em='2026-08-02T03:00:00Z' WHERE id=$1",
          [id],
        );
        await post("/financeiro/despesas", {
          ...expense(),
          valor: "30.00",
          vencimento: "2026-08-01",
        }).expect(201);
        const day1 = (
          await get(
            "/relatorios/caixa?inicio=2026-08-01&fim=2026-08-01",
          ).expect(200)
        ).body;
        assert.equal(Number(day1.despesas), 100);
        assert.equal(Number(day1.despesas_liquidas), 100);
        assert.equal(Number(day1.estornos_despesas), 0);
        assert.equal(Number(day1.resultado_periodo), -100);
        assert.equal(Number(day1.pendentes_periodo), 30);
        const day2 = (
          await get(
            "/relatorios/caixa?inicio=2026-08-02&fim=2026-08-02",
          ).expect(200)
        ).body;
        assert.equal(Number(day2.saldo_anterior), -100);
        assert.equal(Number(day2.estornos_despesas), 100);
        assert.equal(Number(day2.despesas_liquidas), -100);
        assert.equal(Number(day2.saldo_final), 0);
        const events = (
          await get(
            "/relatorios/caixa/eventos?inicio=2026-08-01&fim=2026-08-02",
          ).expect(200)
        ).body;
        assert.equal(events.items.length, 2);
        assert.equal(
          events.items.filter((e: { estorno: boolean }) => e.estorno).length,
          1,
        );
        await get("/relatorios/caixa?inicio=2020-01-01&fim=2026-01-01").expect(
          422,
        );
      },
    );
    await t.test(
      "Banco impõe consistência dos itens, saldo não negativo e histórico imutável",
      async () => {
        const { ingredient, product } = await catalog();
        const purchase = await post("/operacoes", buy(ingredient, "1")).expect(
          201,
        );
        await assert.rejects(
          pool.query(
            "INSERT INTO item_operacao(operacao_id,produto_id,quantidade,valor_unitario,nome_snapshot,unidade_snapshot) VALUES($1,$2,1,1,'Inválido','un')",
            [purchase.body.id, product],
          ),
          (error: unknown) => (error as { code: string }).code === "23514",
        );
        await assert.rejects(
          pool.query(
            "INSERT INTO movimentacao_estoque(insumo_id,usuario_id,natureza,motivo,descricao,quantidade) VALUES($1,$2,'SAIDA','PERDA','Inválido',2)",
            [ingredient, userId],
          ),
          (error: unknown) => (error as { code: string }).code === "23514",
        );
        await assert.rejects(
          pool.query("DELETE FROM movimentacao_estoque WHERE insumo_id=$1", [
            ingredient,
          ]),
          (error: unknown) => (error as { code: string }).code === "23514",
        );
      },
    );
    await t.test(
      "Falha no financeiro desfaz também operação, itens e movimentos",
      async () => {
        const { ingredient } = await catalog();
        const body = buy(ingredient, "2");
        await pool.query(`CREATE FUNCTION falhar_financeiro_teste() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Falha simulada'; END $$;
        CREATE TRIGGER financeiro_falha_teste BEFORE INSERT ON lancamento_financeiro FOR EACH ROW EXECUTE FUNCTION falhar_financeiro_teste()`);
        try {
          await post("/operacoes", body).expect(500);
        } finally {
          await pool.query(
            "DROP TRIGGER financeiro_falha_teste ON lancamento_financeiro; DROP FUNCTION falhar_financeiro_teste()",
          );
        }
        assert.equal(await balance(ingredient), "0");
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM operacao WHERE chave_idempotencia=$1",
              [body.chave_idempotencia],
            )
          ).rows[0].n,
          0,
        );
        await post("/operacoes", body).expect(201);
        assert.equal(await balance(ingredient), "2.000");
      },
    );
    await t.test(
      "Produto sem composição é vendido sem movimentos; inativos são recusados",
      async () => {
        const { ingredient, product } = await catalog();
        await pool.query("DELETE FROM composicao_produto WHERE produto_id=$1", [
          product,
        ]);
        const sale = await post("/operacoes", sell(product)).expect(201);
        assert.equal(await balance(ingredient), "0");
        await cancel(sale.body.id).expect(200);
        await pool.query("UPDATE produto SET ativo=false WHERE id=$1", [
          product,
        ]);
        await post("/operacoes", sell(product)).expect(422);
        await pool.query("UPDATE insumo SET ativo=false WHERE id=$1", [
          ingredient,
        ]);
        await post("/operacoes", buy(ingredient)).expect(422);
      },
    );
    await t.test(
      "Preço praticado pode subir ou descer, sem alterar catálogo; observações e preços ficam no histórico",
      async () => {
        const { ingredient, product } = await catalog();
        await post("/operacoes", buy(ingredient, "10")).expect(201);
        for (const price of ["7.50", "12.50"]) {
          const body = {
            ...sell(product, "2"),
            observacoes: "  Entregar na recepção\nSem sacola  ",
            itens: [
              {
                produto_id: product,
                quantidade: "2",
                preco_esperado: "10.00",
                valor_unitario: price,
              },
            ],
          };
          const preview = await post("/operacoes/prever", body).expect(200);
          assert.equal(Number(preview.body.total), Number(price) * 2);
          const result = await post("/operacoes", body).expect(201);
          assert.equal(
            (await post("/operacoes", body).expect(200)).body.id,
            result.body.id,
          );
          const detail = (await get(`/operacoes/${result.body.id}`).expect(200))
            .body;
          assert.equal(detail.observacoes, "Entregar na recepção\nSem sacola");
          assert.equal(Number(detail.itens[0].valor_unitario), Number(price));
          assert.equal(detail.itens[0].preco_catalogo, "10.00");
          assert.equal(detail.total, preview.body.total);
          await post("/operacoes", {
            ...body,
            observacoes: "Outra observação",
          }).expect(409);
        }
        assert.equal(
          (await pool.query("SELECT preco FROM produto WHERE id=$1", [product]))
            .rows[0].preco,
          "10.00",
        );
        assert.equal(await balance(ingredient), "6.000");
        const fallback = await post("/operacoes", sell(product)).expect(201);
        assert.equal(
          (await get(`/operacoes/${fallback.body.id}`)).body.total,
          "10.00",
        );
        for (const price of ["0", "-1", "1.001", "1000000", "NaN"])
          await post("/operacoes", {
            ...sell(product),
            itens: [
              {
                produto_id: product,
                quantidade: "1",
                preco_esperado: "10.00",
                valor_unitario: price,
              },
            ],
          }).expect(422);
        await post("/operacoes", {
          ...sell(product),
          observacoes: "x".repeat(1001),
        }).expect(422);
        assert.equal(await balance(ingredient), "5.000");
      },
    );
    await t.test(
      "Compra por total preserva centavos, calcula valor unitário e exige uma única origem de valor",
      async () => {
        const { ingredient } = await catalog("kg");
        for (const [amount, total, unit] of [
          ["5", "25.00", "5.00000000"],
          ["3", "10.00", "3.33333333"],
          ["0.001", "999999.99", "999999990.00000000"],
        ]) {
          const body = {
            ...buy(ingredient, amount, true),
            observacoes: "Compra por total",
            itens: [
              { insumo_id: ingredient, quantidade: amount, valor_total: total },
            ],
          };
          assert.equal(
            (await post("/operacoes/prever", body).expect(200)).body.total,
            total,
          );
          const created = await post("/operacoes", body).expect(201);
          const detail = (await get(`/operacoes/${created.body.id}`)).body;
          assert.equal(detail.total, total);
          assert.equal(detail.itens[0].subtotal, total);
          assert.equal(detail.itens[0].valor_unitario, unit);
          assert.equal(detail.itens[0].valor_informado, "TOTAL");
          assert.equal(detail.observacoes, "Compra por total");
          assert.equal(
            (
              await pool.query(
                "SELECT valor FROM lancamento_financeiro WHERE operacao_id=$1",
                [created.body.id],
              )
            ).rows[0].valor,
            total,
          );
          await cancel(created.body.id).expect(200);
        }
        const body = buy(ingredient);
        for (const fields of [
          {},
          { valor_total: "0" },
          { valor_total: "-2" },
          { valor_total: "10.00", valor_unitario: "2.00" },
          { valor_total: null },
        ])
          await post("/operacoes", {
            ...body,
            itens: [{ insumo_id: ingredient, quantidade: "5", ...fields }],
          }).expect(422);
        assert.equal(await balance(ingredient), "0.000");
      },
    );
    await t.test(
      "Receita avulsa é recebida uma vez, não movimenta estoque e seu cancelamento estorna o caixa",
      async () => {
        const movements = (
          await pool.query(
            "SELECT count(*)::int AS n FROM movimentacao_estoque",
          )
        ).rows[0].n;
        const data = {
          chave_idempotencia: randomUUID(),
          descricao: "Recebimento avulso teste",
          valor: "40.25",
          forma_pagamento: "PIX",
        };
        const results = await Promise.all([
          post("/financeiro/receitas", data),
          post("/financeiro/receitas", data),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
        assert.equal(results[0].body.id, results[1].body.id);
        const id = results[0].body.id;
        const entry = (
          await pool.query("SELECT * FROM lancamento_financeiro WHERE id=$1", [
            id,
          ])
        ).rows[0];
        assert.equal(entry.tipo, "RECEITA");
        assert.equal(entry.status, "PAGO");
        assert.equal(entry.operacao_id, null);
        assert.ok(entry.pago_em);
        await post("/financeiro/receitas", { ...data, valor: "0" }).expect(422);
        await post("/financeiro/receitas", { ...data, valor: "20.00" }).expect(
          409,
        );
        await post("/financeiro/receitas", {
          ...data,
          status: "PENDENTE",
        }).expect(422);
        await post("/financeiro/despesas", {
          ...expense(true),
          chave_idempotencia: data.chave_idempotencia,
        }).expect(409);
        await put(`/financeiro/despesas/${id}`, {
          descricao: "Alteração indevida",
          valor: "1.00",
          vencimento: "2026-10-01",
        }).expect(409);
        await post(`/financeiro/${id}/cancelar`, {
          motivo: "Cancelamento de teste",
        }).expect(200);
        await post(`/financeiro/${id}/cancelar`, {
          motivo: "Cancelamento de teste",
        }).expect(200);
        const events = (
          await get("/relatorios/caixa/eventos")
        ).body.items.filter((e: { id: string }) => e.id === id);
        assert.equal(events.length, 2);
        assert.equal(
          events.reduce(
            (sum: number, e: { valor: string }) => sum + Number(e.valor),
            0,
          ),
          0,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM movimentacao_estoque",
            )
          ).rows[0].n,
          movements,
        );
      },
    );
    await t.test(
      "Pagamento e estorno de despesa no mesmo dia deixam despesas líquidas zeradas",
      async () => {
        const id = (
          await post("/financeiro/despesas", expense(true)).expect(201)
        ).body.id;
        await post(`/financeiro/${id}/cancelar`, {
          motivo: "Duplicidade no mesmo dia",
        }).expect(200);
        await pool.query(
          "UPDATE lancamento_financeiro SET pago_em='2025-02-10T12:00:00Z',cancelado_em='2025-02-10T13:00:00Z' WHERE id=$1",
          [id],
        );
        const report = (
          await get(
            "/relatorios/caixa?inicio=2025-02-10&fim=2025-02-10",
          ).expect(200)
        ).body;
        assert.equal(Number(report.despesas), 100);
        assert.equal(Number(report.estornos_despesas), 100);
        assert.equal(Number(report.despesas_liquidas), 0);
        assert.equal(Number(report.resultado_periodo), 0);
      },
    );
    await t.test(
      "Venda direta cria produto e composição uma vez, mantendo nome e preço independentes",
      async () => {
        const data = {
          nome: "Água mineral",
          unidade_medida: "un",
          estoque_minimo: "0",
          validade_referencia: null,
          ativo: true,
          criar_produto: true,
          preco_venda: "3.00",
        };
        await post("/insumos", { ...data, unidade_medida: "kg" }).expect(422);
        await post("/insumos", { ...data, preco_venda: undefined }).expect(422);
        const ingredient = (await post("/insumos", data).expect(201)).body;
        assert.ok(ingredient.produto_vinculado_id);
        const productId = ingredient.produto_vinculado_id;
        const product = {
          nome: "Água gelada 500 ml",
          preco: "4.00",
          ativo: true,
          composicao: [{ insumo_id: ingredient.id, quantidade: "1" }],
        };
        await put(`/produtos/${productId}`, product).expect(200);
        await Promise.all([
          put(`/insumos/${ingredient.id}`, {
            ...data,
            nome: "Água estoque",
          }).expect(200),
          put(`/insumos/${ingredient.id}`, {
            ...data,
            nome: "Água estoque",
          }).expect(200),
        ]);
        const linked = (
          await pool.query("SELECT * FROM produto WHERE origem_insumo_id=$1", [
            ingredient.id,
          ])
        ).rows;
        assert.equal(linked.length, 1);
        assert.equal(linked[0].nome, product.nome);
        assert.equal(linked[0].preco, "4.00");
        assert.equal(
          (await get(`/insumos/${ingredient.id}`).expect(200)).body.nome,
          "Água estoque",
        );
        await put(`/produtos/${productId}`, {
          ...product,
          composicao: [],
        }).expect(422);
        await post("/operacoes", buy(ingredient.id, "2")).expect(201);
        await post("/operacoes", sell(productId, "1", "4.00")).expect(201);
        assert.equal(await balance(ingredient.id), "1.000");
      },
    );
    await t.test(
      "Exclusão preserva vínculos e histórico; filtros distinguem ativos e inativos",
      async () => {
        const remove = (path: string) =>
          agent
            .delete(`/api${path}`)
            .set("Origin", origin)
            .set("X-CSRF-Token", token)
            .send({});
        const { ingredient, product } = await catalog();
        await remove(`/insumos/${ingredient}`).expect(409);
        await agent
          .delete(`/api/produtos/${product}`)
          .set("Origin", origin)
          .send({})
          .expect(403);
        await remove(`/produtos/${product}`).expect(204);
        await remove(`/insumos/${ingredient}`).expect(204);
        await get(`/insumos/${ingredient}`).expect(404);
        await remove("/insumos/invalid").expect(422);
        const used = await catalog();
        const purchase = (
          await post("/operacoes", buy(used.ingredient, "1")).expect(201)
        ).body.id;
        const sale = (await post("/operacoes", sell(used.product)).expect(201))
          .body.id;
        await cancel(sale).expect(200);
        await cancel(purchase).expect(200);
        await remove(`/produtos/${used.product}`).expect(409);
        await remove(`/insumos/${used.ingredient}`).expect(409);
        await put(`/insumos/${used.ingredient}`, {
          nome: "Filtro inativo exclusivo",
          unidade_medida: "un",
          estoque_minimo: "0",
          validade_referencia: null,
          ativo: false,
        }).expect(200);
        assert.equal(
          (
            await get(
              "/insumos?busca=Filtro%20inativo%20exclusivo&situacao=ATIVOS",
            )
          ).body.items.length,
          0,
        );
        assert.equal(
          (
            await get(
              "/insumos?busca=Filtro%20inativo%20exclusivo&situacao=INATIVOS",
            )
          ).body.items.length,
          1,
        );
        await get("/insumos?situacao=INVALIDA").expect(422);
      },
    );
    await t.test(
      "Listagens paginam e não expõem hash de idempotência",
      async () => {
        const operation = (await get("/operacoes?pagina=1").expect(200)).body;
        assert.ok(operation.items.length > 0);
        assert.equal(operation.items[0].requisicao_hash, undefined);
        await pool.query(
          "INSERT INTO lancamento_financeiro(usuario_id,tipo,descricao,valor,status,vencimento) SELECT $1,'DESPESA','Item de paginação '||n,1,'PENDENTE','2026-11-01' FROM generate_series(1,51) n",
          [userId],
        );
        const entries = (
          await get(
            "/financeiro?status=PENDENTE&inicio=2026-11-01&fim=2026-11-01",
          ).expect(200)
        ).body;
        assert.equal(entries.items.length, 50);
        assert.equal(entries.more, true);
        const next = (
          await get(
            "/financeiro?status=PENDENTE&inicio=2026-11-01&fim=2026-11-01&pagina=2",
          ).expect(200)
        ).body;
        assert.equal(next.items.length, 1);
        assert.equal(next.more, false);
      },
    );
    await t.test(
      "Fatias inteiras: cadastro, compra, composição, ajuste, venda e estorno",
      async () => {
        const data = {
          nome: "Queijo fatiado",
          unidade_medida: "fatia",
          estoque_minimo: "2",
          validade_referencia: null,
          ativo: true,
          criar_produto: true,
          preco_venda: "10.00",
        };
        await post("/insumos", { ...data, estoque_minimo: "0.5" }).expect(422);
        const ingredient = (await post("/insumos", data).expect(201)).body;
        assert.equal(ingredient.unidade_medida, "fatia");
        assert.ok(ingredient.produto_vinculado_id);
        await post("/operacoes", buy(ingredient.id, "1.5")).expect(422);
        await post("/produtos", {
          nome: "Sanduíche teste",
          preco: "10.00",
          ativo: true,
          composicao: [{ insumo_id: ingredient.id, quantidade: "0.5" }],
        }).expect(422);
        const product = (
          await post("/produtos", {
            nome: "Sanduíche teste",
            preco: "10.00",
            ativo: true,
            composicao: [{ insumo_id: ingredient.id, quantidade: "2" }],
          }).expect(201)
        ).body;
        const purchase = (
          await post("/operacoes", buy(ingredient.id, "10", true)).expect(201)
        ).body.id;
        const detail = (await get(`/operacoes/${purchase}`).expect(200)).body;
        assert.equal(detail.itens[0].unidade, "fatia");
        const adjustment = {
          chave_idempotencia: randomUUID(),
          insumo_id: ingredient.id,
          natureza: "ENTRADA",
          motivo: "AJUSTE",
          descricao: "Conferência fatias",
          quantidade: "0.5",
        };
        await post("/estoque/movimentos", adjustment).expect(422);
        await post("/estoque/movimentos", {
          ...adjustment,
          quantidade: "2",
        }).expect(201);
        assert.equal(await balance(ingredient.id), "12.000");
        const sale = (
          await post("/operacoes", sell(product.id, "2")).expect(201)
        ).body.id;
        assert.equal(await balance(ingredient.id), "8.000");
        await cancel(sale).expect(200);
        assert.equal(await balance(ingredient.id), "12.000");
        const directSale = (
          await post(
            "/operacoes",
            sell(ingredient.produto_vinculado_id, "1"),
          ).expect(201)
        ).body.id;
        assert.equal(await balance(ingredient.id), "11.000");
        await cancel(directSale).expect(200);
        await assert.rejects(
          pool.query("UPDATE insumo SET estoque_minimo=0.5 WHERE id=$1", [
            ingredient.id,
          ]),
          { code: "23514" },
        );
        await assert.rejects(
          pool.query(
            "INSERT INTO movimentacao_estoque(insumo_id,usuario_id,natureza,motivo,descricao,quantidade) VALUES($1,$2,'ENTRADA','AJUSTE','Fração inválida',0.5)",
            [ingredient.id, userId],
          ),
          { code: "23514" },
        );
        await assert.rejects(
          pool.query(
            "INSERT INTO item_operacao(operacao_id,insumo_id,quantidade,valor_unitario,nome_snapshot,unidade_snapshot,subtotal) VALUES($1,$2,0.5,2,'Fração inválida','fatia',1)",
            [purchase, ingredient.id],
          ),
          { code: "23514" },
        );
      },
    );
    await t.test(
      "Eventos do caixa mantêm a origem de compras, vendas e estornos; avulsos não têm origem",
      async () => {
        const { ingredient, product } = await catalog();
        const purchase = (
          await post("/operacoes", buy(ingredient, "2", true)).expect(201)
        ).body.id;
        const sale = (await post("/operacoes", sell(product)).expect(201)).body
          .id;
        await cancel(sale).expect(200);
        await cancel(purchase).expect(200);
        const standalone = (
          await post("/financeiro/despesas", expense(true)).expect(201)
        ).body.id;
        await pool.query(
          "UPDATE lancamento_financeiro SET pago_em='2024-03-10T12:00:00Z',cancelado_em=CASE WHEN cancelado_em IS NOT NULL THEN '2024-03-10T13:00:00Z'::timestamptz END WHERE operacao_id=ANY($1::uuid[]) OR id=$2",
          [[purchase, sale], standalone],
        );
        const events = (
          await get(
            "/relatorios/caixa/eventos?inicio=2024-03-10&fim=2024-03-10",
          ).expect(200)
        ).body.items;
        assert.equal(events.length, 5);
        for (const operationId of [purchase, sale]) {
          const linked = events.filter(
            (event: { operacao_id: string | null }) =>
              event.operacao_id === operationId,
          );
          assert.equal(linked.length, 2);
          assert.deepEqual(
            linked.map((event: { estorno: boolean }) => event.estorno).sort(),
            [false, true],
          );
          await get(`/operacoes/${operationId}`).expect(200);
        }
        assert.equal(
          events.find((event: { id: string }) => event.id === standalone)
            .operacao_id,
          null,
        );
      },
    );
  } finally {
    sessionStore.close();
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
