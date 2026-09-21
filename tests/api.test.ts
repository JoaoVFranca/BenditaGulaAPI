import "dotenv/config";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import request from "supertest";

// Cada execução usa um schema exclusivo; nenhum cadastro real é alterado.
test("Autenticação e catálogo no PostgreSQL real", async (t) => {
  const originalUrl = process.env.DATABASE_URL!;
  assert.ok(originalUrl, "Execute npm run setup:env primeiro.");
  const admin = new pg.Pool({ connectionString: originalUrl });
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(originalUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.NODE_ENV = "test";
  const { pool } = await import("../src/db.js");
  const { app, sessionStore } = await import("../src/app.js");
  const { hashPassword, verifyPassword } = await import("../src/password.js");
  const origin = process.env.APP_ORIGIN!;
  const agent = request.agent(app);
  let token = "";
  let ingredientId = "";
  let productId = "";
  const email = "teste@example.com";
  const senha = "uma senha longa de teste";
  const ingredient = {
    nome: "Pão",
    unidade_medida: "un",
    estoque_minimo: "2",
    validade_referencia: null,
    ativo: true,
  };
  const post = (path: string, body: unknown) =>
    agent
      .post(path)
      .set("Origin", origin)
      .set("X-CSRF-Token", token)
      .send(body);
  const put = (path: string, body: unknown) =>
    agent.put(path).set("Origin", origin).set("X-CSRF-Token", token).send(body);
  try {
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await pool.query(await readFile(`migrations/${file}`, "utf8"));
    const hash = await hashPassword(senha);
    await pool.query(
      "INSERT INTO usuario(nome,email,senha_hash) VALUES ($1,$2,$3)",
      ["Pessoa de teste", email, hash],
    );
    await t.test(
      "Senha possui salt e hash; senha errada é recusada",
      async () => {
        assert.notEqual(hash, await hashPassword(senha));
        assert.equal(await verifyPassword(senha, hash), true);
        assert.equal(await verifyPassword("incorreta", hash), false);
      },
    );
    await t.test(
      "Sem sessão, não permite ler nem gravar cadastros",
      async () => {
        await agent.get("/api/insumos").expect(401);
        token = (await agent.get("/api/auth/csrf").expect(200)).body.token;
        await post("/api/insumos", ingredient).expect(401);
      },
    );
    await t.test(
      "Login recusa origem externa, CSRF ausente, token Unicode e JSON inválido",
      async () => {
        await agent
          .post("/api/auth/login")
          .set("Origin", "https://externo.invalid")
          .set("X-CSRF-Token", token)
          .send({ email, senha })
          .expect(403);
        await agent
          .post("/api/auth/login")
          .set("Origin", origin)
          .send({ email, senha })
          .expect(403);
        await agent
          .post("/api/auth/login")
          .set("Origin", origin)
          .set("X-CSRF-Token", "é".repeat(64))
          .send({ email, senha })
          .expect(403);
        await agent
          .post("/api/auth/login")
          .set("Origin", origin)
          .set("X-CSRF-Token", token)
          .set("Content-Type", "application/json")
          .send("{")
          .expect(400);
        await agent
          .post("/api/auth/login")
          .set("Origin", origin)
          .set("X-CSRF-Token", token)
          .set("Content-Type", "text/plain")
          .send("hello")
          .expect(415);
      },
    );
    await t.test(
      "Login não revela se o e-mail existe, troca sessão e protege cookie",
      async () => {
        const wrong = await post("/api/auth/login", {
          email,
          senha: "errada",
        }).expect(401);
        const missing = await post("/api/auth/login", {
          email: "outro@example.com",
          senha: "errada",
        }).expect(401);
        assert.equal(wrong.body.message, missing.body.message);
        const before = token;
        const logged = await post("/api/auth/login", { email, senha }).expect(
          200,
        );
        token = logged.body.token;
        assert.notEqual(before, token);
        assert.equal(logged.body.usuario.senha_hash, undefined);
        assert.match(logged.headers["set-cookie"][0], /HttpOnly/);
        assert.match(logged.headers["set-cookie"][0], /SameSite=Lax/);
        await agent.get("/api/auth/me").expect(200);
        await agent
          .post("/api/insumos")
          .set("Origin", origin)
          .set("X-CSRF-Token", before)
          .send(ingredient)
          .expect(403);
      },
    );
    await t.test(
      "Valida corpo, UUID, query, limites e datas reais",
      async () => {
        await post("/api/insumos", { ...ingredient, saldo: 100 }).expect(422);
        await post("/api/insumos", {
          ...ingredient,
          estoque_minimo: "0.5",
        }).expect(422);
        await post("/api/insumos", {
          ...ingredient,
          estoque_minimo: "-1",
        }).expect(422);
        await post("/api/insumos", {
          ...ingredient,
          validade_referencia: "2026-02-30",
        }).expect(422);
        await put("/api/insumos/abc", ingredient).expect(422);
        await agent.get("/api/insumos?pagina=-1").expect(422);
        await agent.get("/api/insumos?campo=arbitrario").expect(422);
        await post("/api/insumos", {
          ...ingredient,
          nome: "x".repeat(40000),
        }).expect(413);
      },
    );
    await t.test("Cadastra, edita e mantém unidade fixa", async () => {
      ingredientId = (await post("/api/insumos", ingredient).expect(201)).body
        .id;
      await put(`/api/insumos/${ingredientId}`, {
        ...ingredient,
        unidade_medida: "kg",
      }).expect(409);
      const updated = await put(`/api/insumos/${ingredientId}`, {
        ...ingredient,
        nome: "Pão francês",
        validade_referencia: "2026-09-30",
      }).expect(200);
      assert.equal(updated.body.validade_referencia, "2026-09-30");
      await put(`/api/insumos/${randomUUID()}`, ingredient).expect(404);
    });
    await t.test(
      "Composição valida referências, repetição e precisão sem gravação parcial",
      async () => {
        const product = {
          nome: "Sanduíche",
          preco: "12.50",
          ativo: true,
          composicao: [{ insumo_id: ingredientId, quantidade: "1" }],
        };
        await post("/api/produtos", {
          ...product,
          composicao: [{ insumo_id: randomUUID(), quantidade: "1" }],
        }).expect(422);
        await post("/api/produtos", {
          ...product,
          composicao: [...product.composicao, ...product.composicao],
        }).expect(422);
        await post("/api/produtos", {
          ...product,
          composicao: [{ insumo_id: ingredientId, quantidade: "0.5" }],
        }).expect(422);
        await post("/api/produtos", { ...product, preco: "12.555" }).expect(
          422,
        );
        assert.equal((await agent.get("/api/produtos")).body.items.length, 0);
        productId = (await post("/api/produtos", product).expect(201)).body.id;
        await put(`/api/produtos/${productId}`, {
          ...product,
          nome: "Não salvar",
          composicao: [{ insumo_id: randomUUID(), quantidade: "1" }],
        }).expect(422);
        const saved = (await agent.get("/api/produtos").expect(200)).body
          .items[0];
        assert.equal(saved.nome, product.nome);
        assert.equal(saved.composicao.length, 1);
        assert.equal(saved.composicao[0].quantidade, "1.000");
        const kg = (
          await post("/api/insumos", {
            ...ingredient,
            nome: "Queijo",
            unidade_medida: "kg",
            estoque_minimo: "0.125",
          }).expect(201)
        ).body;
        await put(`/api/produtos/${productId}`, {
          ...product,
          composicao: [
            ...product.composicao,
            { insumo_id: kg.id, quantidade: "0.025" },
          ],
        }).expect(200);
        await put(`/api/insumos/${ingredientId}`, {
          ...ingredient,
          ativo: false,
        }).expect(200);
        await post("/api/produtos", product).expect(422);
        await put(`/api/produtos/${productId}`, {
          ...product,
          ativo: false,
        }).expect(200);
      },
    );
    await t.test(
      "Consultas parametrizadas e cadastro de usuário autenticado",
      async () => {
        const list = await agent
          .get("/api/insumos")
          .query({ busca: "' OR 1=1 --" })
          .expect(200);
        assert.equal(list.body.items.length, 0);
        await post("/api/usuarios", {
          nome: "Outra pessoa",
          email: "nova@example.com",
          senha,
        }).expect(201);
        await post("/api/usuarios", {
          nome: "Outra pessoa",
          email: "NOVA@example.com",
          senha,
        }).expect(409);
        await post("/api/usuarios", {
          nome: "Outra pessoa",
          email: "mais@example.com",
          senha: "curta",
        }).expect(422);
        const users = await agent.get("/api/usuarios").expect(200);
        assert.equal(users.body.items.length, 2);
        assert.equal(users.body.items[0].senha_hash, undefined);
      },
    );
    await t.test(
      "Logout invalida sessão e usuário inativo não entra",
      async () => {
        await post("/api/auth/logout", {}).expect(204);
        await agent.get("/api/produtos").expect(401);
        token = (await agent.get("/api/auth/csrf")).body.token;
        await pool.query("UPDATE usuario SET ativo=false WHERE email=$1", [
          email,
        ]);
        await post("/api/auth/login", { email, senha }).expect(401);
      },
    );
    await t.test("Tentativas excessivas de login são limitadas", async () => {
      let limited = false;
      for (let i = 0; i < 11; i++) {
        const result = await post("/api/auth/login", {
          email,
          senha: "errada",
        });
        if (result.status === 429) {
          limited = true;
          break;
        }
      }
      assert.equal(limited, true);
    });
  } finally {
    sessionStore.close();
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
