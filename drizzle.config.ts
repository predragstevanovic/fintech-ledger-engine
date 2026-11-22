import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local", quiet: true });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  // Migrations run over the session/direct connection, never the transaction pooler.
  dbCredentials: { url: process.env.DIRECT_URL ?? "" },
  strict: true,
  verbose: true,
});
