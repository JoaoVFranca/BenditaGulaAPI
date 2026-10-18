import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { ingredientFields, saveIngredient, deleteCatalog } from "./catalog.js";
import { HttpError } from "./errors.js";
import { businessRouter } from "./business/routes.js";
import { config } from "./config.js";
import { pool, transaction } from "./db.js";
import { serveFrontend } from "./static-site.js";
import { dummyHash, hashPassword, verifyPassword } from "./password.js";
import {
  idSchema,
  isWholeUnit,
  ingredientSchema,
  listSchema,
  loginSchema,
  productSchema,
  userSchema,
} from "./validation.js";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    csrf?: string;
  }
}
const publicUser = "id,nome,email,ativo";
const cookie = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.NODE_ENV === "production",
  path: "/",
};
const pageSize = 50;
export const app = express();
app.disable("x-powered-by");
// No Render o serviço recebe tráfego do proxy da plataforma (um salto).
// Desenvolvimento não confia em cabeçalhos de proxy por padrão.
if (config.TRUST_PROXY_HOPS) app.set("trust proxy", config.TRUST_PROXY_HOPS);
app.use(helmet());
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use(
  "/api",
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { message: "Muitas requisições. Aguarde um minuto." },
  }),
);
app.use(express.json({ limit: "32kb" }));
export const sessionStore = new (connectPgSimple(session))({
  pool,
  tableName: "sessao",
  createTableIfMissing: false,
});
app.use(
  session({
    name: "tcc.sid",
    secret: config.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { ...cookie, maxAge: 8 * 60 * 60 * 1000 },
  }),
);
app.use("/api", (req, _res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.get("origin") !== config.APP_ORIGIN)
      return next(new HttpError(403, "Origem da requisição não permitida."));
    if (!req.is("application/json"))
      return next(
        new HttpError(415, "Envie o conteúdo como application/json."),
      );
    const supplied = req.get("x-csrf-token") ?? "";
    const expected = req.session.csrf ?? "";
    if (
      !expected ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      return next(
        new HttpError(403, "Sessão de segurança inválida. Atualize a página."),
      );
    }
  }
  next();
});
app.get("/api/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok" });
});
app.get("/api/auth/csrf", (req, res) => {
  req.session.csrf ??= randomBytes(32).toString("hex");
  res.json({ token: req.session.csrf });
});
app.post(
  "/api/auth/login",
  rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      message:
        "Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.",
    },
  }),
  async (req, res) => {
    const data = loginSchema.parse(req.body);
    const { rows } = await pool.query(
      `SELECT ${publicUser},senha_hash FROM usuario WHERE email=$1`,
      [data.email],
    );
    const user = rows[0];
    const valid = await verifyPassword(
      data.senha,
      user?.senha_hash ?? dummyHash,
    );
    if (!user?.ativo || !valid)
      throw new HttpError(401, "E-mail ou senha inválidos.");
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((e) => (e ? reject(e) : resolve())),
    );
    req.session.userId = user.id;
    req.session.csrf = randomBytes(32).toString("hex");
    await new Promise<void>((resolve, reject) =>
      req.session.save((e) => (e ? reject(e) : resolve())),
    );
    res.json({
      usuario: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        ativo: user.ativo,
      },
      token: req.session.csrf,
    });
  },
);
app.use("/api", async (req, res, next) => {
  if (!req.session.userId)
    throw new HttpError(401, "Entre na aplicação para continuar.");
  const { rows } = await pool.query(
    `SELECT ${publicUser} FROM usuario WHERE id=$1 AND ativo=true`,
    [req.session.userId],
  );
  if (!rows[0]) throw new HttpError(401, "Sessão encerrada. Entre novamente.");
  res.locals.user = rows[0];
  next();
});
app.get("/api/auth/me", (_req, res) => res.json(res.locals.user));
app.post("/api/auth/logout", async (req, res) => {
  await new Promise<void>((resolve, reject) =>
    req.session.destroy((e) => (e ? reject(e) : resolve())),
  );
  res.clearCookie("tcc.sid", cookie).status(204).end();
});
app.get("/api/usuarios", async (req, res) => {
  const { busca, pagina } = listSchema.parse(req.query);
  const { rows } = await pool.query(
    `SELECT ${publicUser} FROM usuario WHERE nome ILIKE $1 OR email ILIKE $1 ORDER BY nome,id LIMIT $2 OFFSET $3`,
    [`%${busca}%`, pageSize + 1, (pagina - 1) * pageSize],
  );
  res.json({ items: rows.slice(0, pageSize), more: rows.length > pageSize });
});
app.post("/api/usuarios", async (req, res) => {
  const data = userSchema.parse(req.body);
  const hash = await hashPassword(data.senha);
  const { rows } = await pool.query(
    `INSERT INTO usuario(nome,email,senha_hash) VALUES ($1,$2,$3) RETURNING ${publicUser}`,
    [data.nome, data.email, hash],
  );
  res.status(201).json(rows[0]);
});
app.get("/api/insumos", async (req, res) => {
  const { busca, pagina, situacao } = listSchema.parse(req.query);
  const { rows } = await pool.query(
    `SELECT ${ingredientFields} FROM insumo WHERE nome ILIKE $1 AND ($4='TODOS' OR ativo=($4='ATIVOS')) ORDER BY nome,id LIMIT $2 OFFSET $3`,
    [`%${busca}%`, pageSize + 1, (pagina - 1) * pageSize, situacao],
  );
  res.json({ items: rows.slice(0, pageSize), more: rows.length > pageSize });
});
app.post("/api/insumos", async (req, res) => {
  res
    .status(201)
    .json(await saveIngredient(null, ingredientSchema.parse(req.body)));
});
app.put("/api/insumos/:id", async (req, res) => {
  res.json(
    await saveIngredient(
      idSchema.parse(req.params.id),
      ingredientSchema.parse(req.body),
    ),
  );
});
app.get("/api/insumos/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${ingredientFields} FROM insumo WHERE id=$1`,
    [idSchema.parse(req.params.id)],
  );
  if (!rows[0]) throw new HttpError(404, "Insumo não encontrado.");
  res.json(rows[0]);
});
app.delete("/api/insumos/:id", async (req, res) => {
  await deleteCatalog("insumo", idSchema.parse(req.params.id));
  res.status(204).end();
});
app.delete("/api/produtos/:id", async (req, res) => {
  await deleteCatalog("produto", idSchema.parse(req.params.id));
  res.status(204).end();
});
app.get("/api/produtos", async (req, res) => {
  const { busca, pagina, situacao } = listSchema.parse(req.query);
  const { rows } = await pool.query(
    `SELECT p.*,
    COALESCE((SELECT json_agg(json_build_object('insumo_id',c.insumo_id,'quantidade',c.quantidade::text,'nome',i.nome,'unidade_medida',i.unidade_medida,'ativo',i.ativo) ORDER BY i.nome)
    FROM composicao_produto c JOIN insumo i ON i.id=c.insumo_id WHERE c.produto_id=p.id),'[]'::json) AS composicao
    FROM produto p WHERE p.nome ILIKE $1 AND ($4='TODOS' OR p.ativo=($4='ATIVOS')) ORDER BY p.nome,p.id LIMIT $2 OFFSET $3`,
    [`%${busca}%`, pageSize + 1, (pagina - 1) * pageSize, situacao],
  );
  res.json({ items: rows.slice(0, pageSize), more: rows.length > pageSize });
});
async function saveProduct(req: Request, res: Response) {
  const id = req.params.id ? idSchema.parse(req.params.id) : null;
  const d = productSchema.parse(req.body);
  const product = await transaction(async (client) => {
    if (
      id &&
      !(
        await client.query("SELECT id FROM produto WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rowCount
    )
      throw new HttpError(404, "Produto não encontrado.");
    const ids = d.composicao.map((c) => c.insumo_id).sort();
    if (id) {
      const origin = (
        await client.query("SELECT origem_insumo_id FROM produto WHERE id=$1", [
          id,
        ])
      ).rows[0].origem_insumo_id;
      if (
        origin &&
        (d.composicao.length !== 1 ||
          d.composicao[0].insumo_id !== origin ||
          Number(d.composicao[0].quantidade) !== 1)
      )
        throw new HttpError(
          422,
          "O produto de venda direta deve consumir uma unidade do insumo vinculado. Nome e preço podem ser editados livremente.",
        );
    }
    const { rows } = await client.query(
      "SELECT id,ativo,unidade_medida FROM insumo WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
      [ids],
    );
    const ingredients = new Map(rows.map((i) => [i.id, i]));
    for (const item of d.composicao) {
      const ingredient = ingredients.get(item.insumo_id);
      if (!ingredient)
        throw new HttpError(422, "Um dos insumos informados não existe.");
      if (d.ativo && !ingredient.ativo)
        throw new HttpError(
          422,
          "Produtos ativos devem usar apenas insumos ativos.",
        );
      if (
        isWholeUnit(ingredient.unidade_medida) &&
        !Number.isInteger(Number(item.quantidade))
      )
        throw new HttpError(
          422,
          "Insumos medidos em un ou fatia exigem quantidades inteiras.",
        );
    }
    const saved = id
      ? (
          await client.query(
            "UPDATE produto SET nome=$2,preco=$3,ativo=$4 WHERE id=$1 RETURNING *",
            [id, d.nome, d.preco, d.ativo],
          )
        ).rows[0]
      : (
          await client.query(
            "INSERT INTO produto(nome,preco,ativo) VALUES ($1,$2,$3) RETURNING *",
            [d.nome, d.preco, d.ativo],
          )
        ).rows[0];
    await client.query("DELETE FROM composicao_produto WHERE produto_id=$1", [
      saved.id,
    ]);
    for (const item of d.composicao)
      await client.query(
        "INSERT INTO composicao_produto(produto_id,insumo_id,quantidade) VALUES ($1,$2,$3)",
        [saved.id, item.insumo_id, item.quantidade],
      );
    return saved;
  });
  res.status(id ? 200 : 201).json(product);
}
app.post("/api/produtos", saveProduct);
app.put("/api/produtos/:id", saveProduct);
app.use("/api", businessRouter);
app.use("/api", (_req, _res, next) =>
  next(new HttpError(404, "Recurso não encontrado.")),
);
if (config.STATIC_DIR) serveFrontend(app, config.STATIC_DIR);
app.use((_req, _res, next) =>
  next(new HttpError(404, "Recurso não encontrado.")),
);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    res.status(422).json({
      message: "Revise os dados informados.",
      fields: error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ message: error.message });
    return;
  }
  const e = error as { code?: string; type?: string };
  if (e.code === "40001" || e.code === "40P01" || e.code === "55P03") {
    res.status(409).json({
      message: "Outro usuário atualizou estes dados. Tente novamente.",
    });
    return;
  }
  if (e.code === "23505") {
    res.status(409).json({ message: "Já existe um registro com estes dados." });
    return;
  }
  if (e.code === "23503") {
    res.status(409).json({
      message:
        "Este cadastro possui vínculos. Atualize a listagem ou desative-o pela edição.",
    });
    return;
  }
  if (e.type === "entity.parse.failed") {
    res.status(400).json({ message: "O JSON enviado é inválido." });
    return;
  }
  if (e.type === "entity.too.large") {
    res
      .status(413)
      .json({ message: "A requisição excede o tamanho permitido." });
    return;
  }
  console.error("Falha interna na API.", { code: e.code ?? "unknown" });
  res.status(500).json({
    message: "Não foi possível concluir. Tente novamente em instantes.",
  });
});
