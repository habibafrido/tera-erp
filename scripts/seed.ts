import { Client } from "pg";
import { loadEnv } from "./env";
import { start } from "./pgctl";
import { applySeed } from "./schema";

async function main() {
  await start();

  const env = loadEnv();
  const c = new Client({ connectionString: env.url });
  await c.connect();
  try {
    const r = await applySeed(c);
    console.log(
      `\n✓ Seed selesai — ${r.gudang} gudang, ${r.mitra} mitra, ${r.barang} barang.\n` +
        "  Belum ada transaksi. Mulai dari menu Penerimaan."
    );
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error("\n✗ " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
