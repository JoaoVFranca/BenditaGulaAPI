import "dotenv/config";
import { z } from "zod";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.url(),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL_CA_PATH: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(64),
});
export const config = schema.parse(process.env);
if (
  config.NODE_ENV === "production" &&
  !config.APP_ORIGIN.startsWith("https://")
) {
  throw new Error("Produção exige APP_ORIGIN com HTTPS.");
}
