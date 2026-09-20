import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** .env.local menang atas .env.example, sama seperti yang dibaca Next.js. */
export function loadEnv() {
  const root = resolve(process.cwd());
  for (const f of [".env.local", ".env"]) {
    const p = resolve(root, f);
    if (existsSync(p)) config({ path: p });
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL belum diatur. Salin .env.example menjadi .env.local.");
  }
  return {
    root,
    url: process.env.DATABASE_URL,
    embedded: process.env.PG_EMBEDDED !== "0",
    port: Number(process.env.PG_PORT || 54329),
    dataDir: resolve(root, ".pgdata"),
  };
}
