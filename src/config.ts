import "dotenv/config";
import { z } from "zod";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.url().refine(v => new URL(v).origin === v, "Informe apenas a origem, sem caminho ou barra final."),
  HOST: z.enum(["127.0.0.1", "0.0.0.0"]).optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(1).default(0),
  STATIC_DIR: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL_CA_PATH: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(64),
});
export const config = schema.parse({...process.env, APP_ORIGIN: process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL});
if (
  config.NODE_ENV === "production" &&
  !config.APP_ORIGIN.startsWith("https://")
) {
  throw new Error("Produção exige APP_ORIGIN com HTTPS.");
}
