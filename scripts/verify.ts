/**
 * Menjalankan alur "Alur mencoba" di README langsung lewat mesin posting,
 * lalu memeriksa hasilnya. Dipakai untuk memastikan klaim di README benar:
 * moving average, HPP bukan harga beli terakhir, dan penolakan oversell
 * yang tidak menyisakan jejak.
 *
 * Seluruh skenario berjalan di database sementara sendiri
 * (tera_verify_<timestamp>) yang dibuat di awal dan dihapus di akhir.
 * Database kerja tidak pernah disentuh — itu penting karena stock_ledger
 * append-only, jadi data uji tidak bisa dibersihkan secara selektif.
 */
import { Client } from "pg";
import { loadEnv } from "./env";
import { start } from "./pgctl";
import { applyMigrations, applySeed } from "./schema";

const env = loadEnv();

const TEMP_DB = "tera_verify_" + Date.now();

/**
 * URL koneksi dibentuk ulang dari DATABASE_URL, bukan dari kredensial mati
 * di pgctl, supaya verify tetap bekerja saat PG_EMBEDDED=0 dan pengguna
 * memakai PostgreSQL sendiri.
 */
function urlFor(database: string): string {
  const u = new URL(env.url);
  u.pathname = "/" + database;
  return u.toString();
}

/** Nama identifier tidak bisa dioper sebagai parameter terikat. */
const q = (ident: string) => '"' + ident.replace(/"/g, '""') + '"';

let failed = 0;

/**
 * numeric(18,6) dan numeric(18,2) mengembalikan jumlah desimal yang berbeda
 * untuk nilai yang sama ("750000.000000" vs "750000.00"), jadi angka
 * dibandingkan sebagai angka. Sisanya dibandingkan sebagai teks.
 */
function check(label: string, actual: unknown, expected: unknown) {
  const a = Number(actual);
  const b = Number(expected);
  const numerik =
    actual !== null &&
    actual !== "" &&
    expected !== null &&
    expected !== "" &&
    Number.isFinite(a) &&
    Number.isFinite(b);

  const ok = numerik
    ? Math.abs(a - b) < 0.005
    : String(actual) === String(expected);
  console.log(
    `${ok ? "✓" : "✗"} ${label}\n    dapat ${actual}, harap ${expected}`,
  );
  if (!ok) failed++;
}

/**
 * Pembanding TANPA toleransi, untuk angka yang harus tepat nol.
 *
 * Nilainya dibandingkan sebagai teks numeric dari Postgres, bukan lewat
 * Number(): penjumlahan float atas nilai dua desimal bisa menyisakan
 * residu 1e-10, dan residu itulah yang harus terlihat, bukan ditelan.
 */
function tepat(label: string, selisih: unknown, konteks = "") {
  const s = String(selisih);
  const nol = /^-?0(\.0+)?$/.test(s);
  console.log(
    `${nol ? "✓" : "✗"} ${label}\n    selisih ${s}${konteks ? " — " + konteks : ""}`,
  );
  if (!nol) failed++;
}

/** Skenario uji. Semua kueri di sini mengenai database sementara. */
async function jalankanSkenario(c: Client) {
  // Impor ditunda sampai DATABASE_URL menunjuk ke database sementara, karena
  // lib/db membuat Pool dari process.env saat modul pertama kali dipakai.
  // Kalau diimpor di atas berkas, pool sudah terlanjur menunjuk database kerja.
  const { postGoodsReceipt, postSalesInvoice } = await import("../lib/posting");
  const { pool } = await import("../lib/db");

  const one = async (sql: string, p: any[] = []) =>
    (await c.query(sql, p)).rows[0];

  const wh = await one(`SELECT id FROM warehouse WHERE code='WH-PST'`);
  const sup = await one(`SELECT id FROM partner WHERE code='SUP-001'`);
  const cus = await one(`SELECT id FROM partner WHERE code='CUS-001'`);
  if (!wh || !sup || !cus)
    throw new Error("Seed database sementara tidak lengkap.");

  // Tanpa batch supaya alokasi FEFO tidak ikut campur dengan uji moving average.
  const prod = await one(
    `INSERT INTO product (sku, name, base_uom_id, is_batch_tracked)
     VALUES ('VRF-001','Barang uji',(SELECT id FROM uom WHERE code='PCS'),false)
     RETURNING id`,
  );

  // Tanggal dokumen diambil dari database, bukan dari jam proses Node:
  // toISOString() menggeser tanggal mundur sehari di zona waktu positif,
  // sehingga fixture-nya sendiri akan bertanggal kemarin.
  const today = (
    await c.query("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d")
  ).rows[0].d as string;

  const receipt = async (qty: number, cost: number) => {
    const gr = await one(
      `INSERT INTO goods_receipt (doc_date, supplier_id, warehouse_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [today, sup.id, wh.id],
    );
    await c.query(
      `INSERT INTO goods_receipt_line (receipt_id,line_no,product_id,qty,unit_cost)
       VALUES ($1,1,$2,$3,$4)`,
      [gr.id, prod.id, qty, cost],
    );
    return postGoodsReceipt(gr.id);
  };

  const invoice = async (qty: number, price: number) => {
    const si = await one(
      `INSERT INTO sales_invoice (doc_date, customer_id, warehouse_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [today, cus.id, wh.id],
    );
    await c.query(
      `INSERT INTO sales_invoice_line (invoice_id,line_no,product_id,qty,unit_price)
       VALUES ($1,1,$2,$3,$4)`,
      [si.id, prod.id, qty, price],
    );
    return { id: si.id, res: await postSalesInvoice(si.id) };
  };

  const saldo = () =>
    one(
      `SELECT running_qty AS qty, running_value AS nilai,
              running_value / NULLIF(running_qty,0) AS avg
         FROM stock_ledger
        WHERE product_id=$1 AND warehouse_id=$2
        ORDER BY id DESC LIMIT 1`,
      [prod.id, wh.id],
    );

  try {
    console.log("\n--- Langkah 2: terima 100 @ 14.000 ---");
    await receipt(100, 14000);
    let s = await saldo();
    check("stok 100", s.qty, "100.000000");
    check("nilai 1.400.000", s.nilai, "1400000.00");

    console.log(
      "\n--- Langkah 3: terima 100 @ 16.000, rata-rata harus 15.000 ---",
    );
    await receipt(100, 16000);
    s = await saldo();
    check("stok 200", s.qty, "200.000000");
    check("nilai 3.000.000", s.nilai, "3000000.00");
    check("rata-rata 15.000 (bukan 16.000)", Number(s.avg), 15000);

    console.log(
      "\n--- Langkah 4: jual 50 @ 25.000, HPP harus pakai rata-rata ---",
    );
    const sale = await invoice(50, 25000);
    check("HPP 750.000 (50 x 15.000)", sale.res.cogs, "750000.00");
    check("subtotal 1.250.000", sale.res.subtotal, "1250000.00");
    check("PPN 11% = 137.500", sale.res.tax, "137500.00");
    check("total 1.387.500", sale.res.total, "1387500.00");

    s = await saldo();
    check("sisa stok 150", s.qty, "150.000000");
    check("sisa nilai 2.250.000", s.nilai, "2250000.00");
    check("rata-rata tetap 15.000", Number(s.avg), 15000);

    const jrnl = await one(
      `SELECT SUM(l.debit) AS d, SUM(l.credit) AS k
         FROM journal_line l
         JOIN journal_entry e ON e.id=l.entry_id
        WHERE e.source_type='SALES_INVOICE' AND e.source_id=$1`,
      [sale.id],
    );
    check("jurnal penjualan seimbang", jrnl.d, jrnl.k);

    console.log("\n--- Langkah 5: jual 500 dari sisa 150, harus ditolak ---");
    const before = await one(
      `SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=$1`,
      [prod.id],
    );
    let ditolak = false;
    let pesan = "";
    try {
      await invoice(500, 25000);
    } catch (e) {
      ditolak = true;
      pesan = e instanceof Error ? e.message : String(e);
    }
    check("posting ditolak", ditolak, true);
    console.log("    pesan: " + pesan);

    const after = await one(
      `SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=$1`,
      [prod.id],
    );
    check("tidak ada baris ledger tersisa", after.n, before.n);
    s = await saldo();
    check("saldo tidak berubah", s.qty, "150.000000");

    console.log("\n--- Aturan basis data ---");
    const rule = async (label: string, sql: string, p: any[] = []) => {
      try {
        await c.query(sql, p);
        console.log(
          `✗ ${label}\n    perubahan LOLOS, padahal seharusnya ditolak`,
        );
        failed++;
      } catch (e) {
        console.log(
          `✓ ${label}\n    ditolak: ${(e as Error).message.split("\n")[0]}`,
        );
      }
    };

    await rule(
      "stock_ledger tidak bisa di-UPDATE",
      `UPDATE stock_ledger SET qty = qty + 1 WHERE product_id=$1`,
      [prod.id],
    );
    await rule(
      "jurnal terposting tidak bisa diubah",
      `INSERT INTO journal_line (entry_id, account_id, debit, credit)
       SELECT e.id, (SELECT account_id FROM account_mapping WHERE key='SALES'), 1, 0
         FROM journal_entry e WHERE e.source_id=$1 LIMIT 1`,
      [sale.id],
    );
  } finally {
    // Pool lib/db harus ditutup di sini juga; kalau tidak, koneksinya masih
    // menempel ke database sementara dan DROP akan ditolak.
    await pool()
      .end()
      .catch(() => {});
  }
}

/**
 * Audit tanggal pada SELURUH alat AI.
 *
 * Bug yang melatarbelakangi tes ini: `new Date().toISOString()` di sisi
 * Node menggeser tanggal mundur sehari di zona waktu positif seperti WIB,
 * sehingga alat melaporkan "per 19 September" pada tanggal 20 September.
 * Kesalahan semacam ini tidak memunculkan error apa pun — hanya angka dan
 * tanggal yang salah sedikit, yang justru paling sulit ketahuan.
 *
 * Karena itu SETIAP tanggal yang keluar dari alat diadu dengan
 * CURRENT_DATE milik database, bukan dengan jam proses Node. Alat yang
 * tidak punya parameter periode pun ikut diperiksa.
 */
async function auditTanggalAlat(c: Client, tempUrl: string) {
  console.log("\n--- Tanggal yang dikembalikan alat AI ---");

  // Role baca-saja sudah diberi SELECT pada database sementara oleh
  // migrasi 004, jadi alat bisa dijalankan apa adanya di sini.
  const ro = new URL(tempUrl);
  const asal = process.env.READONLY_DATABASE_URL;
  if (asal) {
    const a = new URL(asal);
    ro.username = a.username;
    ro.password = a.password;
  }
  process.env.READONLY_DATABASE_URL = ro.toString();

  const { runTool } = await import("../lib/ai/tools");
  const { aiPool } = await import("../lib/ai/db");

  try {
    const hariIni = (
      await c.query("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d")
    ).rows[0].d as string;
    console.log("    CURRENT_DATE menurut database: " + hariIni);

    const isoHarian = /^\d{4}-\d{2}-\d{2}$/;

    /** Setiap alat + field meta bertanggal yang wajib sama dengan hari ini. */
    const metaHariIni: [string, Record<string, unknown>, string][] = [
      ["nilai_persediaan", {}, "dihitung_pada"],
      ["saldo_stok", {}, "posisi_per"],
      ["batch_kedaluwarsa", { hari: 90 }, "dihitung_pada"],
      ["stok_mengendap", { hari: 60 }, "dihitung_pada"],
      ["umur_piutang", {}, "dihitung_pada"],
    ];

    for (const [nama, args, field] of metaHariIni) {
      const r = await runTool(nama, args);
      if (!r.ok) {
        check(`${nama}.${field}`, "GAGAL: " + r.error.slice(0, 60), hariIni);
        continue;
      }
      check(`${nama}.meta.${field} == CURRENT_DATE`, r.meta[field], hariIni);
    }

    // Alat berperiode: tanggal_akhir hari_ini harus tepat hari ini.
    for (const nama of ["ringkasan_penjualan", "kartu_stok"]) {
      const args: Record<string, unknown> =
        nama === "kartu_stok"
          ? { sku: "VRF-001", gudang: "WH-PST", periode: "hari_ini" }
          : { periode: "hari_ini" };
      const r = await runTool(nama, args);
      if (!r.ok) {
        check(
          `${nama} periode hari_ini`,
          "GAGAL: " + r.error.slice(0, 60),
          hariIni,
        );
        continue;
      }
      check(
        `${nama}.meta.tanggal_mulai == CURRENT_DATE`,
        r.meta.tanggal_mulai,
        hariIni,
      );
      check(
        `${nama}.meta.tanggal_akhir == CURRENT_DATE`,
        r.meta.tanggal_akhir,
        hariIni,
      );
    }

    // Tanggal di dalam BARIS hasil harus berbentuk teks YYYY-MM-DD, bukan
    // objek Date yang akan tergeser saat diserialisasi ke JSON.
    // Nomor faktur nyata dari skenario, supaya jurnal_dokumen benar-benar
    // mengembalikan baris dan jalur j.entry_date ikut teruji.
    const noFaktur = (
      await c.query(
        "SELECT doc_no FROM sales_invoice WHERE status='POSTED' LIMIT 1",
      )
    ).rows[0]?.doc_no as string | undefined;

    const barisTanggal: [string, Record<string, unknown>, string][] = [
      ["cari_dokumen", { teks: "/" }, "tanggal"],
      ...(noFaktur
        ? ([["jurnal_dokumen", { nomor_dokumen: noFaktur }, "tanggal"]] as [
            string,
            Record<string, unknown>,
            string,
          ][])
        : []),
    ];

    for (const [nama, args, kolom] of barisTanggal) {
      const r = await runTool(nama, args);
      if (!r.ok || r.rows.length === 0) {
        console.log(`· ${nama}.${kolom} dilewati (tidak ada baris)`);
        continue;
      }
      const nilai = r.rows[0][kolom];
      check(
        `${nama}.rows[0].${kolom} berupa teks YYYY-MM-DD`,
        typeof nilai === "string" && isoHarian.test(nilai),
        true,
      );
      console.log("    nilai: " + String(nilai));
    }

    // Tidak boleh ada objek Date yang lolos ke hasil alat mana pun.
    const semua: [string, Record<string, unknown>][] = [
      ["nilai_persediaan", {}],
      ["saldo_stok", {}],
      ["batch_kedaluwarsa", { hari: 3650 }],
      ["stok_mengendap", { hari: 1 }],
      ["umur_piutang", {}],
      ["cari_dokumen", { teks: "/" }],
      ["jurnal_dokumen", { nomor_dokumen: "TIDAK-ADA" }],
      ["ringkasan_penjualan", { periode: "tahun_ini" }],
      [
        "kartu_stok",
        { sku: "VRF-001", gudang: "WH-PST", periode: "tahun_ini" },
      ],
      ["cari_barang", { teks: "a" }],
    ];

    let objekDate = 0;
    for (const [nama, args] of semua) {
      const r = await runTool(nama, args);
      if (!r.ok) continue;
      for (const baris of r.rows) {
        for (const [k, v] of Object.entries(baris)) {
          if (v instanceof Date) {
            objekDate++;
            console.log(`    ✗ ${nama}.${k} masih berupa objek Date`);
          }
        }
      }
      for (const [k, v] of Object.entries(r.meta)) {
        if (v instanceof Date) {
          objekDate++;
          console.log(`    ✗ ${nama}.meta.${k} masih berupa objek Date`);
        }
      }
    }
    check("tidak ada objek Date di hasil alat mana pun", objekDate, 0);
  } finally {
    await aiPool()
      .end()
      .catch(() => {});
    if (asal) process.env.READONLY_DATABASE_URL = asal;
  }
}

/**
 * ============================================================
 * PELUNASAN PIUTANG
 * ============================================================
 * Dua hal yang harus benar pada data apa pun, bukan hanya pada skenario
 * yang kebetulan diuji:
 *
 *   1. Total alokasi pembayaran per faktur TIDAK PERNAH melebihi nilai
 *      fakturnya. Kalau pernah, artinya piutang bersaldo negatif dan
 *      neraca memuat aset yang tidak ada.
 *
 *   2. Saldo akun Piutang Usaha di buku besar sama dengan jumlah sisa
 *      tagihan menurut faktur. Kedua angka itu dihasilkan jalur yang
 *      berbeda — jurnal dan alokasi — dan hanya akan sama kalau
 *      keduanya bercerita hal yang sama.
 */
async function ujiPelunasan(c: Client) {
  console.log("\n--- Pelunasan piutang ---");

  // jalankanSkenario menutup pool lib/db; cachenya dikosongkan supaya
  // pool baru dibentuk. lib/db sendiri tidak disentuh.
  (globalThis as { __pool?: unknown }).__pool = undefined;
  const { postPaymentReceipt } = await import("../lib/posting");
  const { pool } = await import("../lib/db");

  try {
    const satu = async (sql: string, p: unknown[] = []) =>
      (await c.query(sql, p as never[])).rows[0];

    const inv = await satu(
      `SELECT id, doc_no, total, customer_id FROM sales_invoice
        WHERE status='POSTED' ORDER BY created_at LIMIT 1`
    );
    if (!inv) {
      console.log("    (tidak ada faktur terposting; uji pelunasan dilewati)");
      failed++;
      return;
    }

    const hariIni = (await satu(`SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS d`)).d;

    const sisaAwal = await satu(
      `SELECT sisa FROM v_invoice_outstanding WHERE invoice_id=$1`, [inv.id]
    );
    check("sisa tagihan awal == nilai faktur", sisaAwal.sisa, inv.total);

    // --- Bayar sebagian ---
    const separuh = (await satu(`SELECT ROUND($1::numeric / 2, 2) AS x`, [inv.total])).x;
    const pay = await satu(
      `INSERT INTO payment_receipt (doc_date, customer_id, amount, method)
       VALUES ($1,$2,$3,'TRANSFER') RETURNING id`,
      [hariIni, inv.customer_id, separuh]
    );
    await c.query(
      `INSERT INTO payment_allocation (payment_id, invoice_id, amount)
       VALUES ($1,$2,$3)`,
      [pay.id, inv.id, separuh]
    );
    const hasil = await postPaymentReceipt(pay.id);
    check("pembayaran terposting dengan nomor PAY", /^PAY\//.test(hasil.docNo), true);

    const sisaKini = await satu(
      `SELECT sisa FROM v_invoice_outstanding WHERE invoice_id=$1`, [inv.id]
    );
    const harusnya = await satu(
      `SELECT ($1::numeric - $2::numeric) AS x`, [inv.total, separuh]
    );
    check("sisa berkurang persis sebesar pembayaran", sisaKini.sisa, harusnya.x);

    // --- Alokasi berlebih ditolak DI POSTING, bukan cuma di formulir ---
    const pay2 = await satu(
      `INSERT INTO payment_receipt (doc_date, customer_id, amount, method)
       VALUES ($1,$2,$3,'TRANSFER') RETURNING id`,
      [hariIni, inv.customer_id, inv.total]
    );
    await c.query(
      `INSERT INTO payment_allocation (payment_id, invoice_id, amount)
       VALUES ($1,$2,$3)`,
      [pay2.id, inv.id, inv.total]
    );
    let ditolak = false;
    let pesan = "";
    try {
      await postPaymentReceipt(pay2.id);
    } catch (e) {
      ditolak = true;
      pesan = e instanceof Error ? e.message : String(e);
    }
    check("alokasi melebihi sisa ditolak saat posting", ditolak, true);
    if (ditolak) console.log("    pesan: " + pesan);

    const sisaSetelah = await satu(
      `SELECT sisa FROM v_invoice_outstanding WHERE invoice_id=$1`, [inv.id]
    );
    check("faktur tidak berubah setelah penolakan", sisaSetelah.sisa, sisaKini.sisa);

    // --- Kelebihan bayar tidak menjadi pendapatan ---
    const pay3 = await satu(
      `INSERT INTO payment_receipt (doc_date, customer_id, amount, method)
       VALUES ($1,$2,$3,'CASH') RETURNING id`,
      [hariIni, inv.customer_id, 500000]
    );
    const r3 = await postPaymentReceipt(pay3.id);
    check("uang tanpa faktur seluruhnya jadi titipan", r3.titipan, 500000);

    const kePendapatan = await satu(
      `SELECT COALESCE(SUM(l.credit),0) AS x
         FROM journal_entry e JOIN journal_line l ON l.entry_id=e.id
         JOIN account a ON a.id=l.account_id
        WHERE e.source_type='PAYMENT_RECEIPT' AND a.type='REVENUE'`
    );
    check("tidak ada pembayaran yang masuk pendapatan", kePendapatan.x, 0);

    // ================================================================
    // Asersi yang mengikat, berlaku untuk SELURUH data
    // ================================================================

    /*
     * Hanya alokasi milik pembayaran TERPOSTING yang dihitung. Draf
     * belum menyentuh buku besar — termasuk draf yang posting-nya baru
     * saja ditolak dan barisnya masih tertinggal — jadi memasukkannya
     * akan melaporkan pelanggaran yang tidak ada.
     */
    const lebihAlokasi = await satu(`
      SELECT COUNT(*) AS n,
             COALESCE(MAX(x.kelebihan), 0)::text AS terbesar,
             COALESCE(MAX(x.doc_no), '-') AS faktur
        FROM (
          SELECT i.doc_no, SUM(a.amount) - i.total AS kelebihan
            FROM sales_invoice i
            JOIN payment_allocation a ON a.invoice_id = i.id
            JOIN payment_receipt p ON p.id = a.payment_id AND p.status = 'POSTED'
           WHERE i.status = 'POSTED'
           GROUP BY i.id, i.doc_no, i.total
          HAVING SUM(a.amount) > i.total
        ) x
    `);
    check(
      "tidak ada faktur yang alokasi pembayarannya melebihi nilainya",
      lebihAlokasi.n,
      0
    );
    if (Number(lebihAlokasi.n) > 0) {
      console.log(
        `    terparah: ${lebihAlokasi.faktur}, kelebihan ${lebihAlokasi.terbesar}`
      );
    }

    const negatif = await satu(
      `SELECT COUNT(*) AS n FROM v_invoice_outstanding WHERE sisa < 0`
    );
    check("tidak ada faktur bersisa negatif", negatif.n, 0);

    const bukuBesar = await satu(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS saldo
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
         JOIN account a ON a.id = l.account_id
        WHERE a.code = '1-1200'`
    );
    const menurutFaktur = await satu(
      `SELECT COALESCE(SUM(sisa), 0) AS saldo FROM v_invoice_outstanding`
    );
    check(
      "saldo Piutang Usaha di buku besar == jumlah sisa tagihan",
      bukuBesar.saldo,
      menurutFaktur.saldo
    );

    const titipanBB = await satu(
      `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS saldo
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
         JOIN account a ON a.id = l.account_id
        WHERE a.code = '2-1400'`
    );
    const titipanDok = await satu(
      `SELECT COALESCE(SUM(unallocated), 0) AS saldo
         FROM payment_receipt WHERE status='POSTED'`
    );
    check(
      "saldo Titipan Pelanggan di buku besar == kelebihan bayar di dokumen",
      titipanBB.saldo,
      titipanDok.saldo
    );
  } finally {
    await pool().end().catch(() => {});
  }
}

/**
 * ============================================================
 * FAKTUR PEMBELIAN — GRNI HARUS BISA KOSONG
 * ============================================================
 * Akun Barang Diterima Belum Ditagih adalah akun PERANTARA: ia menampung
 * kewajiban antara saat barang masuk gudang dan saat fakturnya datang.
 * Akun perantara yang benar harus bisa kembali ke nol.
 *
 * Asersi yang mengikat di sini: setelah SELURUH penerimaan difakturkan,
 * saldonya TEPAT nol — bukan mendekati nol. Saldo yang tersisa berarti
 * ada penerimaan yang jurnalnya tidak pernah dilepas, dan liabilitas di
 * neraca memuat utang yang sebenarnya sudah diakui dua kali.
 */
async function ujiFakturPembelian(c: Client) {
  console.log("\n--- Faktur pembelian dan pencocokan tiga arah ---");

  (globalThis as { __pool?: unknown }).__pool = undefined;
  const { postPurchaseInvoice } = await import("../lib/posting");
  const { pool } = await import("../lib/db");

  try {
    const satu = async (sql: string, p: unknown[] = []) =>
      (await c.query(sql, p as never[])).rows[0];

    const hariIni = (await satu(`SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS d`)).d;

    const saldoGrni = async () =>
      (
        await satu(
          `SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS x
             FROM journal_line l
             JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
             JOIN account a ON a.id = l.account_id
            WHERE a.code = '2-1300'`
        )
      ).x as string;

    const awal = await saldoGrni();
    console.log("    GRNI sebelum difakturkan: " + awal);
    check("penerimaan memang menumpuk di GRNI", Number(awal) > 0, true);

    /*
     * Setiap baris penerimaan yang masih menggantung difakturkan pada
     * harga PENERIMAANNYA, supaya yang diuji murni keseimbangan GRNI-nya
     * dan bukan tercampur selisih harga.
     */
    const menggantung = await c.query(
      `SELECT receipt_line_id, qty_sisa, biaya_terima, supplier_id
         FROM v_receipt_matching WHERE qty_sisa > 0
        ORDER BY supplier_id, receipt_line_id`
    );
    console.log(`    ${menggantung.rows.length} baris penerimaan menggantung`);

    // Satu faktur per pemasok: faktur hanya boleh mencocokkan penerimaan
    // dari pemasok yang sama.
    const perPemasok = new Map<string, typeof menggantung.rows>();
    for (const b of menggantung.rows) {
      const arr = perPemasok.get(b.supplier_id);
      if (arr) arr.push(b);
      else perPemasok.set(b.supplier_id, [b]);
    }

    let nomorRef = 1;
    for (const [supplierId, baris] of perPemasok) {
      const inv = await satu(
        `INSERT INTO purchase_invoice (doc_date, supplier_id, supplier_ref)
         VALUES ($1,$2,$3) RETURNING id`,
        [hariIni, supplierId, "VERIFY-" + nomorRef++]
      );
      let n = 1;
      for (const b of baris) {
        await c.query(
          `INSERT INTO purchase_invoice_line
             (invoice_id, line_no, receipt_line_id, qty, unit_cost)
           VALUES ($1,$2,$3,$4,$5)`,
          [inv.id, n++, b.receipt_line_id, b.qty_sisa, b.biaya_terima]
        );
      }
      const r = await postPurchaseInvoice(inv.id);
      check(`faktur ${r.docNo} tidak menghasilkan selisih`, r.selisihHarga, 0);
    }

    // --- Asersi utama ---
    const akhir = await saldoGrni();
    tepat(
      "saldo Barang Diterima Belum Ditagih nol setelah semua penerimaan difakturkan",
      akhir,
      "inilah alasan faktur pembelian dibangun"
    );

    const sisaDokumen = await satu(
      `SELECT COALESCE(SUM(grni_sisa), 0)::text AS x FROM v_receipt_matching`
    );
    tepat("tidak ada baris penerimaan yang masih menggantung", sisaDokumen.x);

    const beda = await satu(
      `SELECT (COALESCE((SELECT SUM(grni_sisa) FROM v_receipt_matching), 0)
               - COALESCE((SELECT SUM(l.credit - l.debit)
                             FROM journal_line l
                             JOIN journal_entry e ON e.id=l.entry_id AND e.is_posted
                             JOIN account a ON a.id=l.account_id
                            WHERE a.code='2-1300'), 0))::text AS selisih`
    );
    tepat(
      "dokumen dan buku besar sepakat soal GRNI",
      beda.selisih,
      "dua jalur perhitungan yang berbeda harus bercerita sama"
    );

    const negatif = await satu(
      `SELECT COUNT(*) AS n FROM v_receipt_matching WHERE grni_sisa < 0`
    );
    check("tidak ada baris dengan GRNI negatif", negatif.n, 0);

    // --- Persediaan tidak tersentuh faktur pembelian ---
    const ledger = await satu(
      `SELECT COUNT(*) AS n FROM stock_ledger WHERE source_type='PURCHASE_INVOICE'`
    );
    check(
      "faktur pembelian tidak menulis apa pun ke buku besar stok",
      ledger.n,
      0
    );

    const utangBB = await satu(
      `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS x
         FROM journal_line l
         JOIN journal_entry e ON e.id=l.entry_id AND e.is_posted
         JOIN account a ON a.id=l.account_id
        WHERE a.code='2-1100'`
    );
    const utangDok = await satu(
      `SELECT COALESCE(SUM(subtotal), 0) AS x
         FROM purchase_invoice WHERE status='POSTED'`
    );
    check(
      "saldo Utang Usaha == jumlah faktur pembelian terposting",
      utangBB.x,
      utangDok.x
    );
  } finally {
    await pool().end().catch(() => {});
  }
}

/**
 * ============================================================
 * ARUS KAS HARUS MENUTUP
 * ============================================================
 * Satu asersi yang membuat laporan arus kas bisa dipercaya:
 *
 *     saldo kas awal + seluruh golongan = saldo kas akhir
 *
 * TEPAT nol, tanpa toleransi. Selisih satu rupiah di sini berarti ada
 * mutasi kas yang tidak tertangkap laporan — dan laporan arus kas yang
 * kehilangan satu transaksi persis sama berbahayanya dengan yang
 * kehilangan seribu.
 *
 * Yang menentukan keabsahannya: saldo awal dan akhir diambil dari
 * journal_line pada akun ber-is_cash_equivalent, LANGSUNG, bukan dari
 * penjumlahan laporannya sendiri. Kalau keduanya berasal dari kueri
 * yang sama, asersi ini hanya akan membuktikan bahwa penjumlahan
 * bekerja.
 */
async function ujiArusKas(c: Client) {
  console.log("\n--- Laporan arus kas ---");

  (globalThis as { __pool?: unknown }).__pool = undefined;
  const { arusKas } = await import("../lib/arus-kas");
  const { pool } = await import("../lib/db");

  try {
    const satu = async (sql: string, p: unknown[] = []) =>
      (await c.query(sql, p as never[])).rows[0];

    /** Saldo kas dari journal_line langsung — sumber yang TERPISAH. */
    const saldoLangsung = async (sampai: string) =>
      (
        await satu(
          `SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS x
             FROM journal_line l
             JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
             JOIN account a       ON a.id = l.account_id
            WHERE a.is_cash_equivalent AND e.entry_date <= $1::date`,
          [sampai]
        )
      ).x as string;

    const t = await satu(`
      SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD')                        AS hari_ini,
             to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD')   AS awal_bulan,
             to_char(MIN(entry_date) - INTERVAL '1 day', 'YYYY-MM-DD')  AS sebelum,
             to_char(MIN(entry_date), 'YYYY-MM-DD')                     AS pertama,
             to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '6 months',
                     'YYYY-MM-DD')                                      AS jauh_awal,
             to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '5 months - 1 day',
                     'YYYY-MM-DD')                                      AS jauh_akhir
        FROM journal_entry WHERE is_posted
    `);

    /*
     * Lima rentang, masing-masing menguji cara yang berbeda untuk gagal:
     * periode tanpa mutasi kas sama sekali, periode sebelum transaksi
     * pertama, satu hari, bulan berjalan, dan seluruh riwayat.
     */
    const rentang: [string, string, string][] = [
      ["periode tanpa mutasi kas", t.jauh_awal, t.jauh_akhir],
      ["sebelum transaksi pertama", t.sebelum, t.sebelum],
      ["hari ini saja", t.hari_ini, t.hari_ini],
      ["bulan berjalan", t.awal_bulan, t.hari_ini],
      ["seluruh riwayat", "2000-01-01", t.hari_ini],
    ];

    for (const [label, dari, sampai] of rentang) {
      const a = await arusKas(dari, sampai, dari, sampai);

      tepat(
        `arus kas menutup pada ${label}`,
        a.selisih,
        `awal ${a.saldoAwal} + arus ${a.totalArus} vs akhir ${a.saldoAkhir}`
      );
      check(`flag menutup ikut benar pada ${label}`, a.seimbang, true);

      // Saldo akhir diadu dengan buku besar, BUKAN dengan laporannya.
      check(
        `saldo kas akhir == buku besar akun kas (${label})`,
        a.saldoAkhir,
        await saldoLangsung(sampai)
      );

      // Rincian yang ditampilkan harus menjumlah ke totalnya.
      const jumlahRincian =
        a.operasi.reduce((x, r) => x + r.nilai, 0) +
        a.investasi.reduce((x, r) => x + r.nilai, 0) +
        a.pendanaan.reduce((x, r) => x + r.nilai, 0) +
        a.belumDigolongkan.reduce((x, r) => x + r.nilai, 0);
      check(`jumlah rincian == total arus (${label})`, jumlahRincian, a.totalArus);

      check(
        `tidak ada akun lawan tanpa golongan (${label})`,
        a.belumDigolongkan.length,
        0
      );
    }

    // --- Transfer antar rekening kas ---
    /*
     * Belum ada akun kas kedua di data manapun, jadi kasusnya dibuat di
     * sini: transfer harus menghilang dari laporan tanpa merusak asersi
     * di atas.
     */
    const kasKedua = await satu(
      `INSERT INTO account (code, name, type, is_cash_equivalent)
       VALUES ('1-1190', 'Rekening uji verifikasi', 'ASSET', true)
       RETURNING id`
    );

    const sebelumTransfer = await arusKas("2000-01-01", t.hari_ini, "2000-01-01", t.hari_ini);

    const je = await satu(
      `INSERT INTO journal_entry (entry_no, entry_date, description, is_posted)
       VALUES ('VERIFY/TRANSFER/1', $1::date, 'Transfer antar rekening kas', false)
       RETURNING id`,
      [t.hari_ini]
    );
    await c.query(
      `INSERT INTO journal_line (entry_id, account_id, debit, credit)
       VALUES ($1, $2, 750000, 0),
              ($1, (SELECT id FROM account WHERE code='1-1100'), 0, 750000)`,
      [je.id, kasKedua.id]
    );
    await c.query(`UPDATE journal_entry SET is_posted = true WHERE id = $1`, [je.id]);

    const sesudahTransfer = await arusKas("2000-01-01", t.hari_ini, "2000-01-01", t.hari_ini);

    check(
      "transfer antar kas tidak mengubah arus operasi",
      sesudahTransfer.totalOperasi,
      sebelumTransfer.totalOperasi
    );
    check(
      "transfer antar kas tidak mengubah total arus",
      sesudahTransfer.totalArus,
      sebelumTransfer.totalArus
    );
    tepat(
      "arus kas TETAP menutup saat ada transfer antar rekening",
      sesudahTransfer.selisih,
      `awal ${sesudahTransfer.saldoAwal}, arus ${sesudahTransfer.totalArus}, ` +
        `akhir ${sesudahTransfer.saldoAkhir}`
    );
    check(
      "rekening kas kedua tidak muncul sebagai akun lawan",
      [...sesudahTransfer.operasi, ...sesudahTransfer.investasi,
       ...sesudahTransfer.pendanaan].filter((b) => b.kode === "1-1190").length,
      0
    );

    // --- Jurnal dengan banyak akun lawan berkategori berbeda ---
    const je2 = await satu(
      `INSERT INTO journal_entry (entry_no, entry_date, description, is_posted)
       VALUES ('VERIFY/CAMPUR/1', $1::date, 'Kas masuk dua golongan', false)
       RETURNING id`,
      [t.hari_ini]
    );
    await c.query(
      `INSERT INTO journal_line (entry_id, account_id, debit, credit)
       VALUES ($1, (SELECT id FROM account WHERE code='1-1100'), 400000, 0),
              ($1, (SELECT id FROM account WHERE code='4-1100'), 0, 250000),
              ($1, (SELECT id FROM account WHERE code='3-1100'), 0, 150000)`,
      [je2.id]
    );
    await c.query(`UPDATE journal_entry SET is_posted = true WHERE id = $1`, [je2.id]);

    const campur = await arusKas("2000-01-01", t.hari_ini, "2000-01-01", t.hari_ini);
    check(
      "bagian operasi dari jurnal campuran masuk seluruhnya",
      campur.totalOperasi - sesudahTransfer.totalOperasi,
      250000
    );
    check(
      "bagian pendanaan dari jurnal campuran masuk seluruhnya",
      campur.totalPendanaan - sesudahTransfer.totalPendanaan,
      150000
    );
    tepat(
      "arus kas TETAP menutup saat satu mutasi punya banyak akun lawan",
      campur.selisih
    );
  } finally {
    await pool().end().catch(() => {});
  }
}

/**
 * ============================================================
 * UJI KESEIMBANGAN NERACA
 * ============================================================
 * Satu-satunya pemeriksaan yang benar-benar mengikat untuk laporan
 * keuangan: pada tanggal mana pun,
 *
 *     Aset - (Liabilitas + Ekuitas + Laba ditahan + Laba berjalan) = 0
 *
 * TEPAT nol, bukan mendekati nol. Karena itu pembandingnya BUKAN `check()`
 * yang bertoleransi 0,005 — selisih satu rupiah pada neraca adalah cacat,
 * bukan pembulatan, dan toleransi hanya akan menyembunyikannya sampai
 * jumlahnya cukup besar untuk diperhatikan.
 *
 * Diuji pada tiga tanggal berbeda karena tiga cara berbeda untuk gagal:
 * sebelum transaksi pertama menguji keadaan kosong, tanggal di tengah
 * menguji batas rentang, dan hari ini menguji keadaan sebenarnya.
 */
async function ujiLaporanKeuangan(c: Client) {
  console.log("\n--- Laporan keuangan: keseimbangan neraca ---");

  /*
   * jalankanSkenario menutup pool lib/db supaya DROP DATABASE tidak
   * tertahan koneksi. Referensinya masih tersimpan di globalThis, jadi
   * pool() akan mengembalikan pool yang sudah mati. Cachenya dikosongkan
   * di sini agar pool baru dibentuk; lib/db sendiri tidak disentuh.
   */
  (globalThis as { __pool?: unknown }).__pool = undefined;

  const { neraca, labaRugi } = await import("../lib/laporan-keuangan");
  const { pool } = await import("../lib/db");

  try {
    const satu = async (sql: string, p: unknown[] = []) =>
      (await c.query(sql, p as never[])).rows[0];

    // --- Debit total == kredit total, untuk SELURUH jurnal ---
    const j = await satu(`
    SELECT COALESCE(SUM(l.debit), 0)::text  AS debit,
           COALESCE(SUM(l.credit), 0)::text AS kredit,
           (COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0))::text AS selisih
      FROM journal_line l
      JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
  `);
    tepat(
      "total debit seluruh jurnal == total kredit",
      j.selisih,
      `debit ${j.debit} vs kredit ${j.kredit}`,
    );

    // --- Tanggal uji, semuanya berasal dari database ---
    const t = await satu(`
    SELECT to_char(MIN(entry_date) - INTERVAL '1 day', 'YYYY-MM-DD') AS sebelum,
           to_char(MIN(entry_date)
                   + ((MAX(entry_date) - MIN(entry_date)) / 2), 'YYYY-MM-DD') AS tengah,
           to_char(CURRENT_DATE, 'YYYY-MM-DD') AS hari_ini,
           to_char(MIN(entry_date), 'YYYY-MM-DD') AS pertama,
           to_char(MAX(entry_date), 'YYYY-MM-DD') AS terakhir
      FROM journal_entry WHERE is_posted
  `);

    if (!t.pertama) {
      console.log(
        "    (tidak ada jurnal terposting; uji keseimbangan dilewati)",
      );
      failed++;
      return;
    }

    const tanggalUji: [string, string][] = [
      ["sebelum transaksi pertama", t.sebelum],
      ["tanggal di tengah rentang", t.tengah],
      ["hari ini", t.hari_ini],
    ];

    for (const [label, tgl] of tanggalUji) {
      // Pembandingnya sengaja tanggal yang sama: yang diuji di sini adalah
      // keseimbangan, bukan kolom perbandingannya.
      const n = await neraca(tgl, tgl);

      tepat(
        `neraca seimbang pada ${label} (${tgl})`,
        String(n.selisih),
        `aset ${n.totalAset} - liabilitas ${n.totalLiabilitas}` +
          ` - ekuitas ${n.totalEkuitas} - ditahan ${n.labaDitahan}` +
          ` - berjalan ${n.labaBerjalan}`,
      );

      check(`flag seimbang ikut benar pada ${tgl}`, n.seimbang, true);

      /*
       * Rollup pohon (recursive CTE per akun) harus sama dengan total per
       * jenis akun (pengelompokan datar). Keduanya jalur perhitungan yang
       * berbeda; kalau suatu saat berbeda hasilnya, salah satunya rusak —
       * kemungkinan besar karena akun turunan ikut terjumlah dua kali.
       */
      const akarSaja = (b: { kedalaman: number; saldo: number }[]) =>
        b.filter((x) => x.kedalaman === 0).reduce((a, x) => a + x.saldo, 0);

      check(
        `rollup pohon aset == total per jenis (${tgl})`,
        akarSaja(n.aset),
        n.totalAset,
      );
      check(
        `rollup pohon liabilitas == total per jenis (${tgl})`,
        akarSaja(n.liabilitas),
        n.totalLiabilitas,
      );
      check(
        `rollup pohon ekuitas == total per jenis (${tgl})`,
        akarSaja(n.ekuitas),
        n.totalEkuitas,
      );
    }

    // --- Sebelum transaksi pertama semuanya harus nol, bukan sekadar seimbang ---
    const kosong = await neraca(t.sebelum, t.sebelum);
    check("aset nol sebelum transaksi pertama", kosong.totalAset, 0);
    check(
      "laba berjalan nol sebelum transaksi pertama",
      kosong.labaBerjalan,
      0,
    );
    check(
      "tidak ada baris akun sebelum transaksi pertama",
      kosong.aset.length,
      0,
    );

    // --- Konvensi tanda ---
    console.log("\n--- Laporan keuangan: konvensi tanda ---");

    const nHariIni = await neraca(t.hari_ini, t.hari_ini);
    const cariAkun = (b: { kode: string; saldo: number }[], kode: string) =>
      b.find((x) => x.kode === kode);

    const persediaan = cariAkun(nHariIni.aset, "1-1300");
    const langsung = await satu(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS saldo
       FROM journal_line l
       JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
       JOIN account a       ON a.id = l.account_id
      WHERE a.code = '1-1300' AND e.entry_date <= $1::date`,
      [t.hari_ini],
    );
    check(
      "ASSET memakai debit - kredit (persediaan)",
      persediaan?.saldo ?? 0,
      langsung.saldo,
    );

    const grni = cariAkun(nHariIni.liabilitas, "2-1300");
    const langsungK = await satu(
      `SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS saldo
       FROM journal_line l
       JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
       JOIN account a       ON a.id = l.account_id
      WHERE a.code = '2-1300' AND e.entry_date <= $1::date`,
      [t.hari_ini],
    );
    check(
      "LIABILITY memakai kredit - debit (barang diterima belum ditagih)",
      grni?.saldo ?? 0,
      langsungK.saldo,
    );

    // --- Periode vs kumulatif ---
    console.log("\n--- Laporan keuangan: periode vs kumulatif ---");

    /*
     * Laba Rugi atas rentang PENUH harus sama dengan laba berjalan pada
     * neraca per tanggal terakhir — tetapi hanya bila rentangnya dimulai di
     * awal tahun buku. Kalau `neraca` diam-diam memakai rentang alih-alih
     * akumulasi (atau sebaliknya), kedua angka ini akan berbeda.
     */
    const awalTahun = t.terakhir.slice(0, 4) + "-01-01";
    const lrTahun = await labaRugi(
      awalTahun,
      t.terakhir,
      awalTahun,
      t.terakhir,
    );
    const nTerakhir = await neraca(t.terakhir, t.terakhir);
    check(
      "laba rugi awal tahun s.d. tanggal terakhir == laba berjalan di neraca",
      lrTahun.laba,
      nTerakhir.labaBerjalan,
    );

    // Rentang satu hari sebelum jurnal pertama: pergerakan harus nol,
    // sementara neraca pada tanggal terakhir jelas tidak nol. Ini yang
    // membedakan "pergerakan" dari "akumulasi".
    const lrKosong = await labaRugi(t.sebelum, t.sebelum, t.sebelum, t.sebelum);
    check("laba rugi nol pada hari tanpa transaksi", lrKosong.laba, 0);

    // --- Kolom pembanding ---
    console.log("\n--- Laporan keuangan: kolom pembanding ---");

    const nDua = await neraca(t.hari_ini, t.sebelum);
    check(
      "pembanding neraca == total pada tanggal pembanding",
      nDua.bandingTotalAset,
      kosong.totalAset,
    );
    const asetIni = nDua.aset.find((x) => x.saldo !== 0);
    if (asetIni) {
      check(
        "pembanding per akun nol pada tanggal kosong",
        asetIni.pembanding,
        0,
      );
      check("selisih == saldo - pembanding", asetIni.selisih, asetIni.saldo);
      check(
        "selisih persen null saat pembanding nol",
        asetIni.selisihPersen === null,
        true,
      );
    } else {
      console.log(
        "✗ tidak ada akun aset bersaldo untuk menguji kolom pembanding",
      );
      failed++;
    }
  } finally {
    await pool()
      .end()
      .catch(() => {});
  }
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
    console.log(`→ Database sementara ${TEMP_DB} dibuat.`);

    const tempUrl = urlFor(TEMP_DB);

    // Migrasi dan seed lewat koneksi terpisah, bukan lewat lib/db, supaya
    // tidak ada pool yang terbentuk sebelum DATABASE_URL disetel.
    const setup = new Client({ connectionString: tempUrl });
    await setup.connect();
    try {
      await applyMigrations(setup, { root: env.root, log: false });
      await applySeed(setup);
      console.log("→ Skema dan data contoh disiapkan.");
    } finally {
      await setup.end();
    }

    // Harus disetel SEBELUM lib/posting (dan lewat itu lib/db) diimpor.
    process.env.DATABASE_URL = tempUrl;

    c = new Client({ connectionString: tempUrl });
    await c.connect();
    await jalankanSkenario(c);
    await auditTanggalAlat(c, tempUrl);
    await ujiPelunasan(c);
    await ujiFakturPembelian(c);
    await ujiArusKas(c);
    await ujiLaporanKeuangan(c);
  } finally {
    if (c) await c.end().catch(() => {});

    if (dibuat) {
      // Sisa koneksi apa pun — termasuk milik proses lain yang sempat masuk —
      // diputus dulu, karena DROP DATABASE ditolak selama masih ada yang
      // terhubung.
      await admin
        .query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [TEMP_DB],
        )
        .catch(() => {});
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${q(TEMP_DB)}`);
        console.log(`\n→ Database sementara ${TEMP_DB} dihapus.`);
      } catch (e) {
        console.error(
          `\n! Gagal menghapus database sementara ${TEMP_DB}: ` +
            (e instanceof Error ? e.message : String(e)) +
            "\n  Hapus manual dengan: DROP DATABASE " +
            q(TEMP_DB) +
            ";",
        );
      }
    }

    await admin.end().catch(() => {});
  }

  return failed;
}

main()
  .then((n) => {
    console.log(
      n === 0 ? "\n✓ Semua pemeriksaan lolos." : `\n✗ ${n} pemeriksaan gagal.`,
    );
    process.exit(n === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("\n✗ " + (e instanceof Error ? e.stack : String(e)));
    process.exit(1);
  });
