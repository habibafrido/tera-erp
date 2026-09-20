/**
 * Audit jalur tanggal NON-AI: halaman, pemformat, dan formulir.
 *
 * Bug yang melatarbelakangi audit ini adalah `toISOString()` yang menggeser
 * tanggal mundur sehari di zona waktu positif. Perbaikan semacam itu bisa
 * "kebetulan benar" di satu sisi UTC dan tetap salah di sisi lain, jadi
 * skrip ini dirancang untuk dijalankan di dua zona waktu:
 *
 *   TZ=Asia/Jakarta    npm run audit:tanggal     (UTC+7)
 *   TZ=America/New_York npm run audit:tanggal    (UTC-4/-5)
 *
 * Semua tulisan terjadi di database sementara yang dibuat dan dihapus di
 * sini, karena stock_ledger append-only dan data uji tidak bisa dibersihkan
 * sebagian dari database kerja.
 */
/*
 * Skrip ini memanggil server action langsung dari Node, di luar
 * permintaan HTTP. Penanda di bawah mengaktifkan jalur pengguna sistem
 * di lib/auth/sistem.ts — yang TIDAK bisa dicapai dari HTTP, karena
 * syaratnya justru tidak adanya konteks permintaan. Disetel sebelum
 * modul apa pun diimpor.
 */
process.env.TERA_SKRIP = "1";

import { Client } from "pg";
import { loadEnv } from "./env";
import { start } from "./pgctl";
import { applyMigrations, applySeed } from "./schema";

const env = loadEnv();
const TEMP_DB = "tera_tz_" + Date.now();

function urlFor(database: string): string {
  const u = new URL(env.url);
  u.pathname = "/" + database;
  return u.toString();
}

const q = (ident: string) => '"' + ident.replace(/"/g, '""') + '"';

let gagal = 0;

function ok(label: string, benar: boolean, detail = "") {
  console.log(`${benar ? "✓" : "✗"} ${label}${detail ? "\n    " + detail : ""}`);
  if (!benar) gagal++;
}

function eq(label: string, a: unknown, b: unknown) {
  ok(label, String(a) === String(b), `dapat ${a}, harap ${b}`);
}

async function audit(c: Client, tempUrl: string) {
  const { tanggal } = await import("../lib/format");

  const satu = async (sql: string, p: unknown[] = []) =>
    (await c.query(sql, p as never[])).rows[0];

  const hari = (await satu("SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS d")).d as string;
  console.log(`\nTZ proses Node   : ${process.env.TZ ?? "(bawaan sistem)"}`);
  console.log(`Offset Node      : UTC${-new Date().getTimezoneOffset() / 60 >= 0 ? "+" : ""}${-new Date().getTimezoneOffset() / 60}`);
  console.log(
    `TimeZone Postgres: ${(await satu("SHOW TimeZone")).TimeZone}`
  );
  console.log(`CURRENT_DATE     : ${hari}`);

  // ------------------------------------------------------------------
  // Titik 1 — expiry_date dan days_to_expiry lewat v_stock_fefo
  // ------------------------------------------------------------------
  console.log("\n--- 1. expiry_date / days_to_expiry (panel beranda) ---");

  const wh = await satu(`SELECT id FROM warehouse WHERE code='WH-PST'`);
  const sup = await satu(`SELECT id FROM partner WHERE code='SUP-001'`);
  const prod = await satu(
    `INSERT INTO product (sku, name, base_uom_id, is_batch_tracked)
     VALUES ('TZ-001','Barang uji zona waktu',(SELECT id FROM uom WHERE code='PCS'),true)
     RETURNING id`
  );

  // Kedaluwarsa tepat 30 hari dari CURRENT_DATE menurut database.
  const expiry = (
    await satu(
      "SELECT to_char(CURRENT_DATE + INTERVAL '30 days','YYYY-MM-DD') AS d"
    )
  ).d as string;

  const { postGoodsReceipt } = await import("../lib/posting");
  const gr = await satu(
    `INSERT INTO goods_receipt (doc_date, supplier_id, warehouse_id)
     VALUES ($1,$2,$3) RETURNING id`,
    [hari, sup.id, wh.id]
  );
  await c.query(
    `INSERT INTO goods_receipt_line
       (receipt_id,line_no,product_id,batch_no,expiry_date,qty,unit_cost)
     VALUES ($1,1,$2,'TZ-BATCH',$3,10,1000)`,
    [gr.id, prod.id, expiry]
  );
  await postGoodsReceipt(gr.id);

  const fefo = await satu(
    `SELECT expiry_date, days_to_expiry FROM v_stock_fefo
      WHERE product_id=$1`,
    [prod.id]
  );

  console.log(`    expiry_date dari pg  : ${JSON.stringify(fefo.expiry_date)}`);
  console.log(`    tipe JavaScript      : ${fefo.expiry_date instanceof Date ? "objek Date" : typeof fefo.expiry_date}`);
  console.log(`    days_to_expiry       : ${fefo.days_to_expiry} (tipe ${typeof fefo.days_to_expiry})`);

  eq("expiry_date dirender tanggal yang benar", tanggal(fefo.expiry_date), tanggal(new Date(expiry + "T12:00:00")));
  eq("days_to_expiry = 30 (dihitung SQL, tidak tersentuh TZ Node)", fefo.days_to_expiry, 30);

  // Yang diuji di sini bukan teksnya, melainkan HARI-nya: pemformat harus
  // menghasilkan tanggal kalender yang sama dengan yang tersimpan.
  const hariDariFormat = new Intl.DateTimeFormat("en-CA").format(
    fefo.expiry_date instanceof Date ? fefo.expiry_date : new Date(String(fefo.expiry_date))
  );
  eq("expiry_date tidak bergeser saat diformat", hariDariFormat, expiry);

  // ------------------------------------------------------------------
  // Titik 2 — doc_date / due_date dan fungsi tanggal()
  // ------------------------------------------------------------------
  console.log("\n--- 2. doc_date / due_date dan lib/format.tanggal() ---");

  const dok = await satu(
    `SELECT doc_date FROM goods_receipt WHERE id=$1`, [gr.id]
  );
  console.log(`    doc_date dari pg     : ${JSON.stringify(dok.doc_date)}`);
  console.log(`    tipe JavaScript      : ${dok.doc_date instanceof Date ? "objek Date" : typeof dok.doc_date}`);

  const hariDariDoc = new Intl.DateTimeFormat("en-CA").format(
    dok.doc_date instanceof Date ? dok.doc_date : new Date(String(dok.doc_date))
  );
  eq("doc_date (objek Date dari pg) tidak bergeser saat diformat", hariDariDoc, hari);

  // Jalur kedua fungsi tanggal(): masukan berupa TEKS, bukan objek Date.
  const dariTeks = tanggal(hari);
  const dariDate = tanggal(dok.doc_date);
  eq("tanggal(teks) == tanggal(Date) untuk hari yang sama", dariTeks, dariDate);
  console.log(`    tanggal("${hari}") = ${dariTeks}`);
  console.log(`    tanggal(Date)      = ${dariDate}`);

  // ------------------------------------------------------------------
  // Titik 3 — nilai <input type="date"> sampai tersimpan di database
  // ------------------------------------------------------------------
  console.log("\n--- 3. Formulir: hariIni() → server action → database ---");

  /**
   * Ini persis yang dilakukan app/receipts/new/page.tsx: nilai bawaan
   * <input type="date"> diambil dari CURRENT_DATE milik database, bukan
   * dari jam proses Node. Uji dua zona waktu membuktikan kenapa — dengan
   * Node di New York dan Postgres di Bangkok, jam server mundur sehari.
   */
  const { query } = await import("../lib/db");
  const [tanggalDb] = await query<{ hari_ini: string }>(
    "SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS hari_ini"
  );
  const bawaanForm = tanggalDb.hari_ini;
  console.log(`    nilai awal <input type="date"> : ${bawaanForm}`);
  eq("nilai bawaan formulir == CURRENT_DATE database", bawaanForm, hari);

  // Pembanding: jam proses Node, yang DULU menjadi sumber nilai ini.
  const jamNode = (() => {
    const d = new Date();
    const z = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  })();
  console.log(`    tanggal menurut jam Node      : ${jamNode}` +
    (jamNode === hari ? "  (kebetulan sama)" : "  ← BERBEDA dari database"));

  // Inilah yang dilakukan formulir: nilai <input type="date"> selalu berupa
  // teks "YYYY-MM-DD" menurut spesifikasi HTML, dioper apa adanya ke server
  // action, lalu masuk sebagai parameter terikat.
  const { saveAndPostReceipt } = await import("../app/actions");
  const hasil = await saveAndPostReceipt({
    doc_date: bawaanForm,
    supplier_id: sup.id,
    warehouse_id: wh.id,
    supplier_ref: "TZ-TEST",
    lines: [{ product_id: prod.id, qty: "5", unit_cost: "1000" }],
  });
  /**
   * revalidatePath() hanya hidup di dalam request Next. Dipanggil dari
   * skrip biasa ia melempar "static generation store missing" SETELAH
   * posting berhasil, sehingga action melaporkan gagal padahal datanya
   * sudah masuk. Yang sedang diuji di sini adalah jalur tanggalnya, dan
   * buktinya ada pada pembacaan ulang dari database di bawah.
   */
  const artefakRevalidate = /revalidatePath|static generation store/i.test(hasil.message);
  ok(
    "server action menjalankan posting",
    hasil.ok || artefakRevalidate,
    hasil.ok
      ? hasil.message
      : artefakRevalidate
        ? "posting berhasil; revalidatePath dilewati karena di luar request Next"
        : hasil.message
  );

  const tersimpan = await satu(
    `SELECT to_char(doc_date,'YYYY-MM-DD') AS teks, doc_date
       FROM goods_receipt WHERE supplier_ref='TZ-TEST'`
  );
  console.log(`    doc_date tersimpan   : ${tersimpan?.teks}`);
  eq("doc_date tersimpan == CURRENT_DATE", tersimpan?.teks, hari);
  eq("doc_date tersimpan == nilai yang dikirim formulir", tersimpan?.teks, bawaanForm);

  const { pool } = await import("../lib/db");
  await pool().end().catch(() => {});
}

async function main(): Promise<number> {
  await start();

  const admin = new Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  let dibuat = false;
  let c: Client | null = null;

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

    // Harus disetel sebelum lib/db diimpor lewat app/actions.
    process.env.DATABASE_URL = tempUrl;

    c = new Client({ connectionString: tempUrl });
    await c.connect();
    await audit(c, tempUrl);
  } finally {
    if (c) await c.end().catch(() => {});
    if (dibuat) {
      await admin
        .query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [TEMP_DB]
        )
        .catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${q(TEMP_DB)}`).catch(() => {});
    }
    await admin.end().catch(() => {});
  }
  return gagal;
}

main()
  .then((n) => {
    console.log(
      n === 0
        ? `\n✓ Semua jalur tanggal aman di TZ=${process.env.TZ ?? "(bawaan)"}.`
        : `\n✗ ${n} pemeriksaan gagal di TZ=${process.env.TZ ?? "(bawaan)"}.`
    );
    process.exit(n === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("\n✗ " + (e instanceof Error ? e.stack : String(e)));
    process.exit(1);
  });
