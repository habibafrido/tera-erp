/**
 * Tes sumber data grafik.
 *
 * Grafik dan tabel pendampingnya memakai data yang sama persis, jadi yang
 * perlu dibuktikan adalah data itu sendiri sama dengan hasil SQL langsung.
 * Ditambah keadaan kosong: grafik pada database tanpa transaksi harus
 * menghasilkan deret kosong, bukan sumbu hampa berisi NaN.
 *
 * Jalankan: npm run test:grafik
 */
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { loadEnv } from "./env";
import { start } from "./pgctl";
import { applyMigrations, applySeed } from "./schema";

const env = loadEnv();
const TEMP_DB = "tera_grafik_" + Date.now();

let gagal = 0;

function ok(label: string, benar: boolean, detail = "") {
  console.log(`${benar ? "✓" : "✗"} ${label}${detail ? "\n    " + detail : ""}`);
  if (!benar) gagal++;
}

function eq(label: string, a: unknown, b: unknown) {
  const sama = Math.abs(Number(a) - Number(b)) < 0.01 || String(a) === String(b);
  ok(label, sama, `dapat ${a}, harap ${b}`);
}

function urlFor(d: string) {
  const u = new URL(env.url);
  u.pathname = "/" + d;
  return u.toString();
}

const q = (i: string) => '"' + i.replace(/"/g, '""') + '"';

async function tesAngka(db: Client) {
  console.log("\n--- Angka grafik == SQL langsung ---");

  const { trenPenjualan, nilaiPerGudang, stokMengendapTeratas, umurPiutangEmber } =
    await import("../lib/charts");

  const satu = async (sql: string) => Object.values((await db.query(sql)).rows[0])[0];

  // --- 1. Tren penjualan ---
  const tren = await trenPenjualan();
  eq("tren berisi tepat 12 bulan", tren.length, 12);

  const totalTren = tren.reduce((a, t) => a + t.subtotal, 0);
  eq(
    "total penjualan 12 bulan == SQL",
    totalTren,
    await satu(`SELECT ROUND(COALESCE(SUM(l.qty*l.unit_price),0),2) AS x
                  FROM sales_invoice s JOIN sales_invoice_line l ON l.invoice_id=s.id
                 WHERE s.status='POSTED'
                   AND s.doc_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '11 months'`)
  );

  const bulanIni = tren[tren.length - 1];
  eq(
    "bulan terakhir pada sumbu == bulan berjalan",
    bulanIni.bulan,
    await satu(`SELECT to_char(CURRENT_DATE,'YYYY-MM') AS x`)
  );

  // --- 2. Nilai per gudang ---
  const gudang = await nilaiPerGudang();
  eq(
    "total nilai per gudang == total v_stock_balance",
    gudang.reduce((a, g) => a + g.nilai, 0),
    await satu(`SELECT ROUND(COALESCE(SUM(stock_value),0),2) AS x FROM v_stock_balance`)
  );
  ok(
    "gudang terurut menurun",
    gudang.every((g, i) => i === 0 || gudang[i - 1].nilai >= g.nilai),
    gudang.map((g) => `${g.sub}=${g.nilai}`).join(" ")
  );

  // --- 3. Umur piutang ---
  const ember = await umurPiutangEmber();
  eq("ada empat ember", ember.length, 4);
  eq(
    "total ember == total piutang terposting",
    ember.reduce((a, e) => a + e.nilai, 0),
    await satu(`SELECT ROUND(COALESCE(SUM(total),0),2) AS x
                  FROM sales_invoice WHERE status='POSTED'`)
  );
  eq(
    "ember di atas 90 hari == SQL",
    ember[3].nilai,
    await satu(`SELECT ROUND(COALESCE(SUM(total),0),2) AS x FROM sales_invoice
                 WHERE status='POSTED'
                   AND GREATEST(CURRENT_DATE - COALESCE(due_date, doc_date),0) > 90`)
  );
  ok("hanya ember 90+ ditandai berisiko", ember.filter((e) => e.berisiko).length === 1);

  // --- 4. Stok mengendap ---
  const mengendap = await stokMengendapTeratas(60);
  ok("paling banyak 10 baris", mengendap.length <= 10, `${mengendap.length} baris`);
  ok(
    "terurut menurun menurut nilai",
    mengendap.every((m, i) => i === 0 || mengendap[i - 1].nilai >= m.nilai)
  );
  if (mengendap.length > 0) {
    eq(
      "baris teratas == nilai terbesar menurut SQL",
      mengendap[0].nilai,
      await satu(`SELECT ROUND(MAX(b.stock_value),2) AS x
                    FROM (SELECT product_id, SUM(qty_on_hand) qty_on_hand,
                                 SUM(stock_value) stock_value
                            FROM v_stock_balance GROUP BY product_id) b
                    LEFT JOIN (SELECT product_id, MAX(posted_at) keluar
                                 FROM stock_ledger WHERE qty<0 GROUP BY product_id) k
                      ON k.product_id=b.product_id
                   WHERE b.qty_on_hand > 0
                     AND COALESCE(k.keluar,'1900-01-01'::timestamptz)
                         < now() - INTERVAL '60 days'`)
    );
  }
}

/**
 * Keadaan kosong diuji di PROSES TERPISAH.
 *
 * lib/db menyimpan poolnya di globalThis dan membuatnya sekali dari
 * process.env, jadi satu proses tidak bisa diarahkan ke dua database.
 * Menyalin kuerinya ke sini akan menguji salinan, bukan kode yang
 * sebenarnya berjalan — karena itu skrip ini memanggil dirinya sendiri
 * dengan DATABASE_URL yang berbeda.
 */
async function tesKosong() {
  console.log("\n--- Keadaan kosong (database tanpa transaksi) ---");

  const admin = new Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  let dibuat = false;

  try {
    await admin.query(`CREATE DATABASE ${q(TEMP_DB)}`);
    dibuat = true;
    const tempUrl = urlFor(TEMP_DB);

    const setup = new Client({ connectionString: tempUrl });
    await setup.connect();
    try {
      await applyMigrations(setup, { root: env.root, log: false });
      await applySeed(setup);
    } finally {
      await setup.end();
    }

    // Loader tsx harus ikut dimuat: proses anak menjalankan berkas
    // TypeScript ini sendiri, bukan hasil kompilasinya.
    const anak = spawnSync(
      process.execPath,
      ["--import", "tsx", process.argv[1]],
      {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: tempUrl, GRAFIK_KOSONG: "1" },
        stdio: "pipe",
      }
    );

    process.stdout.write(anak.stdout ?? "");
    if (anak.status !== 0) {
      process.stdout.write(anak.stderr ?? "");
      gagal++;
    }
  } finally {
    if (dibuat) {
      await admin
        .query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname=$1 AND pid <> pg_backend_pid()`,
          [TEMP_DB]
        )
        .catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${q(TEMP_DB)}`).catch(() => {});
    }
    await admin.end().catch(() => {});
  }
}

/** Dijalankan di proses anak, dengan DATABASE_URL menunjuk database kosong. */
async function jalankanKosong() {
  const { trenPenjualan, nilaiPerGudang, stokMengendapTeratas, umurPiutangEmber } =
    await import("../lib/charts");
  const { pool } = await import("../lib/db");

  try {
    const tren = await trenPenjualan();
    eq("tren tetap 12 bulan walau kosong", tren.length, 12);
    ok(
      "semua bulan bernilai nol, bukan NaN",
      tren.every((t) => t.subtotal === 0 && t.margin === 0 && Number.isFinite(t.subtotal))
    );
    ok(
      "margin persen null saat tidak ada penjualan",
      tren.every((t) => t.margin_persen === null)
    );

    eq("tidak ada gudang bersaldo", (await nilaiPerGudang()).length, 0);
    eq("tidak ada stok mengendap", (await stokMengendapTeratas(60)).length, 0);

    const ember = await umurPiutangEmber();
    eq("ember tetap empat", ember.length, 4);
    ok("semua ember nol", ember.every((e) => e.nilai === 0));
  } finally {
    await pool().end().catch(() => {});
  }
}

async function main() {
  // Cabang proses anak: hanya menjalankan asersi keadaan kosong.
  if (process.env.GRAFIK_KOSONG === "1") {
    await jalankanKosong();
    process.exit(gagal === 0 ? 0 : 1);
  }

  await start();

  const db = new Client({ connectionString: env.url });
  await db.connect();
  try {
    await tesAngka(db);
  } finally {
    await db.end();
    const { pool } = await import("../lib/db");
    await pool().end().catch(() => {});
  }

  await tesKosong();

  console.log(gagal === 0 ? "\n✓ Semua tes lolos." : `\n✗ ${gagal} tes gagal.`);
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n✗ " + (e instanceof Error ? e.stack : String(e)));
  process.exit(1);
});
