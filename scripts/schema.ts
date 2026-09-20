/**
 * Pembuatan skema dan data contoh, dipakai bersama oleh db:migrate, db:seed,
 * dan db:verify.
 *
 * Fungsi di sini menerima Client yang sudah terhubung, bukan membuat koneksi
 * sendiri, supaya verify bisa mengarahkannya ke database sementara tanpa
 * menyentuh DATABASE_URL milik aplikasi.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Client } from "pg";

const WAREHOUSES: [string, string][] = [
  ["WH-PST", "Gudang Pusat"],
  ["WH-TMR", "Gudang Timur"],
];

const PARTNERS: [string, string, boolean, boolean, number, boolean][] = [
  // code, name, is_customer, is_supplier, payment_term_days, is_pkp
  //
  // is_pkp menentukan apakah faktur dari pemasok itu membawa PPN yang
  // bisa dikreditkan. SUP-002 sengaja BUKAN PKP supaya kedua jalur —
  // dengan PPN dan tanpa PPN — sama-sama ada di data contoh.
  ["SUP-001", "PT Sinar Niaga Sejahtera", false, true, 30, true],
  ["SUP-002", "CV Berkah Pangan", false, true, 14, false],
  ["CUS-001", "Toko Makmur Jaya", true, false, 14, false],
  ["CUS-002", "Minimarket Amanah", true, false, 7, false],
  ["CUS-003", "Grosir Sentosa", true, false, 30, false],
  ["MIX-001", "PT Karya Dagang Nusantara", true, true, 21, true],
];

const PRODUCTS: [string, string, string, boolean][] = [
  // sku, name, base_uom, is_batch_tracked
  ["SKU-1001", "Minyak Goreng Sawit 1L", "PCS", true],
  ["SKU-1002", "Gula Pasir Premium 1kg", "PCS", true],
  ["SKU-1003", "Kopi Bubuk Robusta 200g", "PCS", true],
  ["SKU-1004", "Sabun Mandi Batang 85g", "PCS", false],
  ["SKU-1005", "Detergen Bubuk 800g", "PCS", false],
  ["SKU-1006", "Susu UHT Cokelat 1L", "PCS", true],
];

// 1 CTN = 24 PCS untuk semua barang contoh. Tabelnya sudah ada,
// UI konversinya memang belum — lihat "Yang sengaja belum ada" di README.
const CTN_FACTOR = 24;

/**
 * Menerjemahkan kegagalan yang pesan aslinya tidak bisa ditindaklanjuti.
 *
 * pg_trgm adalah trusted extension sejak PostgreSQL 13, jadi superuser
 * tidak selalu diperlukan: pemilik database pun boleh memasangnya. Yang
 * ditolak adalah role yang bukan pemilik — situasi lazim dengan
 * PG_EMBEDDED=0 memakai database terkelola. Mode embedded selalu lolos
 * karena memakai role pemilik cluster.
 *
 * Tanpa terjemahan ini, migrasi berhenti di baris pertama dengan
 * "permission denied to create extension" yang tidak memberi tahu
 * pengguna harus berbuat apa.
 *
 * Deteksi memakai SQLSTATE 42501 (insufficient_privilege), bukan
 * pencocokan teks pesan — teks berubah antar versi dan antar locale.
 */
function jelaskan(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  const pesan = e instanceof Error ? e.message : String(e);

  if (err?.code === "42501") {
    return (
      pesan +
      "\n\n" +
      "  Role database yang dipakai tidak punya hak memasang extension.\n" +
      "  Minta admin database menjalankan ini sekali saja pada database ini:\n\n" +
      "      CREATE EXTENSION pg_trgm;\n\n" +
      "  Extension cukup dipasang satu kali per database, bukan per\n" +
      "  pengguna. Menjadikan role ini pemilik database juga cukup —\n" +
      "  pg_trgm trusted sejak PostgreSQL 13 dan tidak butuh superuser.\n" +
      "  Setelah itu jalankan `npm run db:migrate` lagi."
    );
  }
  return pesan;
}

/**
 * Menjalankan berkas db/*.sql berurutan, sekali masing-masing.
 * Riwayat dicatat di schema_migration, dan tiap berkas dijalankan dalam satu
 * transaksi sendiri supaya migrasi yang gagal tidak meninggalkan skema
 * setengah jadi.
 */
export async function applyMigrations(
  c: Client,
  opts: { root: string; log?: boolean } = { root: process.cwd() }
): Promise<number> {
  const log = opts.log !== false;
  const dir = resolve(opts.root, "db");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  await c.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const done = new Set(
    (await c.query("SELECT filename FROM schema_migration")).rows.map((r) => r.filename)
  );

  let applied = 0;
  for (const f of files) {
    if (done.has(f)) {
      if (log) console.log(`· ${f} (sudah)`);
      continue;
    }
    const sql = readFileSync(resolve(dir, f), "utf8");
    await c.query("BEGIN");
    try {
      await c.query(sql);
      await c.query("INSERT INTO schema_migration (filename) VALUES ($1)", [f]);
      await c.query("COMMIT");
      applied++;
      if (log) console.log(`✓ ${f}`);
    } catch (e) {
      await c.query("ROLLBACK");
      throw new Error(`Migrasi ${f} gagal:\n${jelaskan(e)}`);
    }
  }
  return applied;
}

/**
 * Data contoh: gudang, mitra, barang, konversi satuan.
 *
 * Sengaja TIDAK membuat transaksi apa pun. Alur mencoba di README dimulai
 * dari penerimaan barang yang dicatat sendiri lewat UI, supaya moving average
 * terlihat terbentuk dari nol.
 *
 * Idempoten: aman dijalankan berulang.
 */
/**
 * Pengguna contoh, satu per peran.
 *
 * Kata sandinya adalah nilai bawaan untuk PENGEMBANGAN di komputer
 * sendiri, sama sifatnya dengan kata sandi cluster embedded dan role
 * tera_readonly. Untuk pemasangan yang bisa dijangkau jaringan, ganti
 * lewat halaman kelola pengguna atau setel TERA_SEED_PASSWORD sebelum
 * menjalankan seed.
 *
 * Akun sistem TIDAK ada di sini: ia dibuat migrasi 008 tanpa kata sandi
 * sama sekali, sehingga tidak ada kata sandi yang bisa cocok dengannya.
 */
const USERS: [string, string, string][] = [
  // email, nama, peran
  ["gudang@tera.local", "Rina Operator Gudang", "operator_gudang"],
  ["keuangan@tera.local", "Bagas Staf Keuangan", "staf_keuangan"],
  ["pengawas@tera.local", "Sari Pengawas", "pengawas"],
];

const SANDI_BAWAAN = "tera12345";

export const SEED_PASSWORD = process.env.TERA_SEED_PASSWORD ?? SANDI_BAWAAN;

/**
 * Menolak menanam kata sandi bawaan ke database yang BUKAN di komputer ini.
 *
 * Kode ini publik, jadi "tera12345" bisa dibaca siapa saja. Selama
 * databasenya localhost itu tidak apa-apa — tidak ada yang bisa
 * menjangkaunya. Begitu database-nya terkelola dan aplikasinya hidup di
 * internet, kata sandi yang sama berubah menjadi pintu terbuka.
 *
 * Pemeriksaannya memakai HOST database, bukan NODE_ENV: seed dijalankan
 * dari komputer pengembang meski sasarannya produksi, sehingga NODE_ENV
 * di sana tetap "development" dan tidak bisa membedakan apa pun.
 */
function tolakSandiBawaanDiLuarLokal(url: string) {
  if (SEED_PASSWORD !== SANDI_BAWAAN) return;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return; // Bentuk URL tidak dikenali; biarkan lapisan lain yang mengeluh.
  }

  const lokal =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "";
  if (lokal) return;

  throw new Error(
    [
      `Menolak menanam kata sandi bawaan ke database di ${host}.`,
      "",
      "Kata sandi bawaan tertulis di repositori yang bisa dibaca publik.",
      "Setel TERA_SEED_PASSWORD ke nilai lain sebelum menjalankan seed:",
      "",
      "  PowerShell : $env:TERA_SEED_PASSWORD='...'; npm run db:seed",
      "  bash       : TERA_SEED_PASSWORD='...' npm run db:seed",
    ].join("\n")
  );
}

export async function applySeed(c: Client) {
  const check = await c.query("SELECT to_regclass('public.product') IS NOT NULL AS ada");
  if (!check.rows[0].ada) {
    throw new Error("Skema belum ada. Jalankan `npm run db:migrate` lebih dulu.");
  }

  tolakSandiBawaanDiLuarLokal(process.env.DATABASE_URL ?? "");

  await c.query("BEGIN");
  try {
    /*
     * Di-hash per akun, bukan sekali lalu disalin.
     *
     * argon2 membangkitkan salt sendiri, jadi menghitung ulang membuat
     * ketiga baris punya hash yang BERBEDA meski kata sandinya sama —
     * dan itu yang seharusnya terlihat di dump database. Ongkosnya
     * beberapa puluh milidetik per akun, sekali per pembuatan database.
     */
    const { hashKataSandi } = await import("../lib/auth/sesi");
    for (const [email, nama, peran] of USERS) {
      await c.query(
        `INSERT INTO app_user (email, name, role, password_hash)
         VALUES ($1, $2, $3::app_role, $4)
         ON CONFLICT (email) DO NOTHING`,
        [email, nama, peran, await hashKataSandi(SEED_PASSWORD)]
      );
    }

    for (const [code, name] of WAREHOUSES) {
      await c.query(
        `INSERT INTO warehouse (code, name) VALUES ($1,$2)
         ON CONFLICT (code) DO NOTHING`,
        [code, name]
      );
    }

    for (const [code, name, cust, supp, term, pkp] of PARTNERS) {
      await c.query(
        `INSERT INTO partner
           (code, name, is_customer, is_supplier, payment_term_days, is_pkp)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (code) DO NOTHING`,
        [code, name, cust, supp, term, pkp]
      );
    }

    for (const [sku, name, uom, batch] of PRODUCTS) {
      await c.query(
        `INSERT INTO product (sku, name, base_uom_id, is_batch_tracked)
         VALUES ($1,$2,(SELECT id FROM uom WHERE code=$3),$4)
         ON CONFLICT (sku) DO NOTHING`,
        [sku, name, uom, batch]
      );
      await c.query(
        `INSERT INTO product_uom_conversion (product_id, uom_id, factor)
         SELECT p.id, u.id, $3::numeric
           FROM product p, uom u
          WHERE p.sku = $1 AND u.code = $2
         ON CONFLICT (product_id, uom_id) DO NOTHING`,
        [sku, "CTN", CTN_FACTOR]
      );
    }

    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }

  const n = await c.query(`
    SELECT (SELECT count(*) FROM warehouse) AS gudang,
           (SELECT count(*) FROM partner)   AS mitra,
           (SELECT count(*) FROM product)   AS barang
  `);
  return n.rows[0] as { gudang: string; mitra: string; barang: string };
}
