import { Client } from "pg";
import { loadEnv } from "./env";
import { start } from "./pgctl";
import { applyMigrations } from "./schema";

async function main() {
  await start();

  const env = loadEnv();
  const c = new Client({ connectionString: env.url });
  await c.connect();
  try {
    const applied = await applyMigrations(c, { root: env.root });
    console.log(
      applied === 0 ? "\nSkema sudah paling baru." : `\n✓ ${applied} migrasi diterapkan.`
    );
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error("\n✗ " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
