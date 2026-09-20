/**
 * Tes penerimaan pembayaran pelanggan.
 *
 * Yang diuji di sini bukan "apakah jurnalnya muncul" — itu bagian yang
 * mudah. Yang diuji adalah hal-hal yang diam-diam salah:
 *
 *   - sisa tagihan dihitung, bukan dibaca dari kolom yang bisa menyimpang;
 *   - alokasi melebihi sisa ditolak di POSTING, bukan cuma di formulir;
 *   - dua pembayaran bersamaan ke faktur yang sama tidak saling menimpa;
 *   - kelebihan bayar masuk ke titipan pelanggan, bukan jadi pendapatan.
 *
 * Semuanya di database sementara: stock_ledger append-only dan data uji
 * tidak bisa dibersihkan sebagian dari database kerja.
 *
 * Jalankan: npm run test:pelunasan
 */
import { Client } from "pg";
import { loadEnv } from "./env";
import { start } from "./pgctl";
import { applyMigrations, applySeed } from "./schema";

const env = loadEnv();
const TEMP_DB = "tera_bayar_" + Date.now();

let gagal = 0;

function ok(label: string, benar: boolean, detail = "") {
  console.log(`${benar ? "✓" : "✗"} ${label}${detail ? "\n    " + detail : ""}`);
  if (!benar) gagal++;
}

function eq(label: string, a: unknown, b: unknown) {
  ok(label, Math.abs(Number(a) - Number(b)) < 0.005, `dapat ${a}, harap ${b}`);
}

function urlFor(d: string) {
  const u = new URL(env.url);
  u.pathname = "/" + d;
  return u.toString();
}

const q = (i: string) => '"' + i.replace(/"/g, '""') + '"';

/** Menangkap pesan galat, bukan membiarkannya menggagalkan skrip. */
async function tolak(label: string, fn: () => Promise<unknown>, cocok: RegExp) {
  try {
    await fn();
    ok(label, false, "berhasil, seharusnya ditolak");
  } catch (e) {
    const pesan = e instanceof Error ? e.message : String(e);
    ok(label, cocok.test(pesan), "pesan: " + pesan);
  }
}

/**
 * Menjalankan kueri dokumen MILIK ROUTE PENCARIAN, bukan salinannya.
 *
 * Database kerja belum punya dokumen jenis baru sama sekali, jadi
 * memanggil /api/search di sana selalu mengembalikan kosong dan tidak
 * membuktikan apa pun. Kueri aslinya diambil dari berkas route lalu
 * dijalankan di database sementara ini, yang memang berisi dokumennya.
 */
async function cariDokumen(c: Client, kata: string) {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("app/api/search/route.ts", "utf8").replace(/\r/g, "");
  const m = /`(SELECT \* FROM \(\s*\n[\s\S]*?LIMIT \$4)`/.exec(src);
  if (!m) throw new Error("kueri dokumen di route pencarian tidak ketemu");
  const r = await c.query(m[1], [kata, "%" + kata + "%", 0.2, 20]);
  return r.rows as { nomor: string; jenis: string }[];
}

async function tes(c: Client) {
  const { postGoodsReceipt, postSalesInvoice, postPaymentReceipt } =
    await import("../lib/posting");

  const satu = async (sql: string, p: unknown[] = []) =>
    (await c.query(sql, p as never[])).rows[0];

  const hariIni = (await satu("SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS d")).d;

  const wh = (await satu(`SELECT id FROM warehouse WHERE code='WH-PST'`)).id;
  const sup = (await satu(`SELECT id FROM partner WHERE code='SUP-001'`)).id;
  const cus = (await satu(`SELECT id FROM partner WHERE code='CUS-001'`)).id;
  const cus2 = (await satu(`SELECT id FROM partner WHERE code='CUS-002'`)).id;

  const prod = (
    await satu(
      `INSERT INTO product (sku,name,base_uom_id,is_batch_tracked)
       VALUES ('BAYAR-001','Barang uji pelunasan',
               (SELECT id FROM uom WHERE code='PCS'), false)
       RETURNING id`
    )
  ).id;

  // --- Stok masuk supaya ada yang bisa dijual ---
  const gr = (
    await satu(
      `INSERT INTO goods_receipt (doc_date,supplier_id,warehouse_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [hariIni, sup, wh]
    )
  ).id;
  await c.query(
    `INSERT INTO goods_receipt_line (receipt_id,line_no,product_id,qty,unit_cost)
     VALUES ($1,1,$2,1000,10000)`,
    [gr, prod]
  );
  await postGoodsReceipt(gr);

  /** Membuat faktur penjualan terposting senilai qty x harga + PPN 11%. */
  async function faktur(qty: number, harga: number, pelanggan = cus) {
    const id = (
      await satu(
        `INSERT INTO sales_invoice (doc_date,customer_id,warehouse_id)
         VALUES ($1,$2,$3) RETURNING id`,
        [hariIni, pelanggan, wh]
      )
    ).id;
    await c.query(
      `INSERT INTO sales_invoice_line (invoice_id,line_no,product_id,qty,unit_price)
       VALUES ($1,1,$2,$3,$4)`,
      [id, prod, qty, harga]
    );
    const r = await postSalesInvoice(id);
    return { id, total: r.total as string, docNo: r.docNo as string };
  }

  /** Membuat pembayaran draf beserta alokasinya. */
  async function bayar(
    jumlah: number | string,
    alokasi: [string, number | string][],
    pelanggan = cus
  ) {
    const id = (
      await satu(
        `INSERT INTO payment_receipt (doc_date,customer_id,amount,method)
         VALUES ($1,$2,$3,'TRANSFER') RETURNING id`,
        [hariIni, pelanggan, jumlah]
      )
    ).id;
    for (const [inv, amt] of alokasi) {
      await c.query(
        `INSERT INTO payment_allocation (payment_id,invoice_id,amount)
         VALUES ($1,$2,$3)`,
        [id, inv, amt]
      );
    }
    return id;
  }

  const sisaDari = async (invoiceId: string) =>
    (await satu(`SELECT sisa FROM v_invoice_outstanding WHERE invoice_id=$1`, [invoiceId]))
      ?.sisa;

  // ================================================================
  console.log("\n--- 1. Pelunasan penuh ---");
  // ================================================================

  const f1 = await faktur(10, 100_000); // 1.000.000 + PPN = 1.110.000
  eq("sisa awal == total faktur", await sisaDari(f1.id), f1.total);

  const p1 = await bayar(f1.total, [[f1.id, f1.total]]);
  const r1 = await postPaymentReceipt(p1);
  eq("sisa jadi nol setelah lunas", await sisaDari(f1.id), 0);
  eq("tidak ada titipan", r1.titipan, 0);
  ok("nomor dokumen berpola PAY/tahun/bulan/urut", /^PAY\/\d{4}\/\d{2}\/\d{4}$/.test(r1.docNo));

  const j1 = await satu(
    `SELECT a.code, l.debit, l.credit, l.partner_id
       FROM journal_entry e JOIN journal_line l ON l.entry_id=e.id
       JOIN account a ON a.id=l.account_id
      WHERE e.source_type='PAYMENT_RECEIPT' AND e.source_id=$1 AND l.debit > 0`,
    [p1]
  );
  eq("kas didebit sebesar uang diterima", j1.debit, f1.total);
  ok("akun debit adalah Kas & Bank", j1.code === "1-1100", `akun ${j1.code}`);

  const j1k = await satu(
    `SELECT a.code, l.credit, l.partner_id
       FROM journal_entry e JOIN journal_line l ON l.entry_id=e.id
       JOIN account a ON a.id=l.account_id
      WHERE e.source_type='PAYMENT_RECEIPT' AND e.source_id=$1 AND l.credit > 0`,
    [p1]
  );
  ok("piutang dikredit", j1k.code === "1-1200", `akun ${j1k.code}`);
  ok(
    "partner_id terisi di baris piutang",
    j1k.partner_id === cus,
    `partner ${j1k.partner_id}`
  );

  // ================================================================
  console.log("\n--- 2. Satu faktur, beberapa kali bayar ---");
  // ================================================================

  const f2 = await faktur(10, 200_000); // 2.220.000
  await postPaymentReceipt(await bayar(800_000, [[f2.id, 800_000]]));
  eq("sisa setelah cicilan pertama", await sisaDari(f2.id), Number(f2.total) - 800_000);

  await postPaymentReceipt(await bayar(1_000_000, [[f2.id, 1_000_000]]));
  eq("sisa setelah cicilan kedua", await sisaDari(f2.id), Number(f2.total) - 1_800_000);

  const sisa2 = Number(f2.total) - 1_800_000;
  await postPaymentReceipt(await bayar(sisa2, [[f2.id, sisa2]]));
  eq("lunas setelah cicilan ketiga", await sisaDari(f2.id), 0);

  // ================================================================
  console.log("\n--- 3. Satu pembayaran, beberapa faktur ---");
  // ================================================================

  const f3 = await faktur(5, 100_000); // 555.000
  const f4 = await faktur(5, 100_000); // 555.000
  const p3 = await bayar(1_110_000, [
    [f3.id, 555_000],
    [f4.id, 555_000],
  ]);
  const r3 = await postPaymentReceipt(p3);
  eq("kedua faktur lunas: yang pertama", await sisaDari(f3.id), 0);
  eq("kedua faktur lunas: yang kedua", await sisaDari(f4.id), 0);
  eq("seluruh uang teralokasi", r3.allocated, 1_110_000);

  const barisAR = await c.query(
    `SELECT COUNT(*) AS n, SUM(l.credit) AS total
       FROM journal_entry e JOIN journal_line l ON l.entry_id=e.id
       JOIN account a ON a.id=l.account_id
      WHERE e.source_id=$1 AND a.code='1-1200'`,
    [p3]
  );
  eq(
    "piutang dikredit satu baris sebesar total alokasi",
    barisAR.rows[0].total,
    1_110_000
  );

  // ================================================================
  console.log("\n--- 4. Alokasi melebihi sisa DITOLAK saat posting ---");
  // ================================================================

  const f5 = await faktur(10, 100_000); // 1.110.000
  await tolak(
    "alokasi melebihi sisa ditolak",
    async () => postPaymentReceipt(await bayar(2_000_000, [[f5.id, 2_000_000]])),
    /melebihi sisa tagihannya/
  );
  eq("faktur tidak tersentuh setelah penolakan", await sisaDari(f5.id), f5.total);

  // Cicilan dulu, lalu coba lunasi lebih dari sisanya.
  await postPaymentReceipt(await bayar(600_000, [[f5.id, 600_000]]));
  await tolak(
    "alokasi melebihi SISA (bukan total) ditolak",
    async () => postPaymentReceipt(await bayar(600_000, [[f5.id, 600_000]])),
    /melebihi sisa tagihannya/
  );
  eq("sisa tetap setelah penolakan kedua", await sisaDari(f5.id), 510_000);

  await tolak(
    "alokasi melebihi uang yang diterima ditolak",
    async () => postPaymentReceipt(await bayar(100_000, [[f5.id, 500_000]])),
    /melebihi uang yang diterima/
  );

  await tolak(
    "faktur milik pelanggan lain ditolak",
    async () => postPaymentReceipt(await bayar(100_000, [[f5.id, 100_000]], cus2)),
    /milik pelanggan lain/
  );

  // ================================================================
  console.log("\n--- 5. Kelebihan bayar masuk titipan pelanggan ---");
  // ================================================================

  const f6 = await faktur(5, 100_000); // 555.000
  const p6 = await bayar(700_000, [[f6.id, 555_000]]);
  const r6 = await postPaymentReceipt(p6);
  eq("alokasi sebesar tagihan", r6.allocated, 555_000);
  eq("kelebihan jadi titipan", r6.titipan, 145_000);

  const titipan = await satu(
    `SELECT a.code, a.type, l.credit, l.partner_id
       FROM journal_entry e JOIN journal_line l ON l.entry_id=e.id
       JOIN account a ON a.id=l.account_id
      WHERE e.source_id=$1 AND a.code='2-1400'`,
    [p6]
  );
  ok("titipan masuk akun 2-1400", titipan !== undefined);
  ok(
    "titipan berjenis LIABILITY, bukan REVENUE",
    titipan?.type === "LIABILITY",
    `type ${titipan?.type}`
  );
  eq("nilai titipan di jurnal", titipan?.credit, 145_000);
  ok("partner_id terisi di baris titipan", titipan?.partner_id === cus);

  const pendapatan = await satu(
    `SELECT COALESCE(SUM(l.credit),0) AS x
       FROM journal_entry e JOIN journal_line l ON l.entry_id=e.id
       JOIN account a ON a.id=l.account_id
      WHERE e.source_id=$1 AND a.type='REVENUE'`,
    [p6]
  );
  eq("tidak ada sepeser pun masuk pendapatan", pendapatan.x, 0);

  // Pembayaran tanpa alokasi sama sekali: seluruhnya titipan.
  const p7 = await bayar(250_000, []);
  const r7 = await postPaymentReceipt(p7);
  eq("uang muka tanpa faktur seluruhnya jadi titipan", r7.titipan, 250_000);

  // ================================================================
  console.log("\n--- 6. Dua pembayaran bersamaan ke faktur yang sama ---");
  // ================================================================

  /*
   * Tanpa pg_advisory_xact_lock keduanya membaca sisa yang sama lalu
   * sama-sama lolos, dan faktur berakhir terbayar melebihi nilainya
   * tanpa satu pun pesan galat. Yang diuji: tepat SATU yang berhasil.
   */
  const f8 = await faktur(10, 100_000); // 1.110.000
  const pa = await bayar(700_000, [[f8.id, 700_000]]);
  const pb = await bayar(700_000, [[f8.id, 700_000]]);

  const hasil = await Promise.allSettled([
    postPaymentReceipt(pa),
    postPaymentReceipt(pb),
  ]);
  const sukses = hasil.filter((h) => h.status === "fulfilled").length;
  const ditolak = hasil.filter((h) => h.status === "rejected");

  eq("tepat satu pembayaran berhasil", sukses, 1);
  ok(
    "yang gagal ditolak karena melebihi sisa, bukan galat lain",
    ditolak.length === 1 &&
      /melebihi sisa tagihannya/.test(String((ditolak[0] as PromiseRejectedResult).reason)),
    ditolak.length ? String((ditolak[0] as PromiseRejectedResult).reason) : "(tidak ada)"
  );
  eq("faktur terbayar 700.000, bukan 1.400.000", await sisaDari(f8.id), 410_000);

  // ================================================================
  console.log("\n--- 7. Lapisan kedua di database ---");
  // ================================================================

  /*
   * Menulis alokasi langsung, melewati lib/posting sepenuhnya.
   *
   * Urutannya mengikuti jalur yang benar-benar mungkin terjadi: dokumen
   * dibuat sebagai draf, alokasi disisipkan, lalu statusnya diubah jadi
   * POSTED. Menyisipkan alokasi ke dokumen yang SUDAH terposting akan
   * berhenti lebih dulu di block_posted_payment, sehingga tidak menguji
   * apa pun tentang batas nilainya (diuji terpisah di bawah).
   */
  const f9 = await faktur(5, 100_000); // 555.000
  await tolak(
    "alokasi berlebih ditolak trigger meski melewati lib/posting",
    async () => {
      const id = (
        await satu(
          `INSERT INTO payment_receipt (doc_date,customer_id,amount)
           VALUES ($1,$2,999999) RETURNING id`,
          [hariIni, cus]
        )
      ).id;
      await c.query(
        `INSERT INTO payment_allocation (payment_id,invoice_id,amount)
         VALUES ($1,$2,999999)`,
        [id, f9.id]
      );
      // Perubahan status inilah yang membuat alokasinya "terhitung".
      await c.query(`UPDATE payment_receipt SET status='POSTED' WHERE id=$1`, [id]);
    },
    /melebihi nilainya/
  );
  eq("faktur tidak tersentuh setelah trigger menolak", await sisaDari(f9.id), 555_000);

  await tolak(
    "alokasi tidak bisa ditambahkan ke pembayaran terposting",
    async () => {
      await c.query(
        `INSERT INTO payment_allocation (payment_id,invoice_id,amount)
         VALUES ($1,$2,1)`,
        [p1, f9.id]
      );
    },
    /sudah diposting/
  );

  await tolak(
    "posting ulang ditolak",
    async () => postPaymentReceipt(p1),
    /sudah diposting/
  );

  // ================================================================
  console.log("\n--- 8. Buku besar tetap konsisten ---");
  // ================================================================

  const seimbang = await satu(`
    SELECT (COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0))::text AS selisih
      FROM journal_line l JOIN journal_entry e ON e.id=l.entry_id AND e.is_posted
  `);
  ok("debit == kredit di seluruh jurnal", /^-?0(\.0+)?$/.test(seimbang.selisih),
     `selisih ${seimbang.selisih}`);

  /*
   * Saldo akun Piutang Usaha di buku besar harus sama dengan jumlah sisa
   * tagihan menurut v_invoice_outstanding. Kalau berbeda, berarti jurnal
   * dan alokasi sudah bercerita dua hal yang berbeda — dan angka di
   * neraca tidak lagi bisa ditelusuri ke faktur mana pun.
   */
  const bukuBesar = await satu(
    `SELECT COALESCE(SUM(l.debit - l.credit),0) AS saldo
       FROM journal_line l
       JOIN journal_entry e ON e.id=l.entry_id AND e.is_posted
       JOIN account a ON a.id=l.account_id
      WHERE a.code='1-1200'`
  );
  const menurutFaktur = await satu(
    `SELECT COALESCE(SUM(sisa),0) AS saldo FROM v_invoice_outstanding`
  );
  eq(
    "saldo Piutang Usaha di buku besar == jumlah sisa tagihan",
    bukuBesar.saldo,
    menurutFaktur.saldo
  );

  const lebihBayar = await satu(
    `SELECT COUNT(*) AS n FROM v_invoice_outstanding WHERE sisa < 0`
  );
  eq("tidak ada faktur bersaldo negatif", lebihBayar.n, 0);

  // ================================================================
  console.log("\n--- 9. Pembayaran bisa dicari di palet ---");
  // ================================================================

  const hasilCari = await cariDokumen(c, r1.docNo);
  const ketemu = hasilCari.find((x) => x.nomor === r1.docNo);
  ok(
    "nomor pembayaran ditemukan palet pencarian",
    ketemu !== undefined,
    hasilCari.map((x) => x.nomor).join(", ") || "(kosong)"
  );
  ok(
    "hasilnya bertanda jenis Pembayaran",
    ketemu?.jenis === "Pembayaran",
    `jenis ${ketemu?.jenis}`
  );

  // ================================================================
  console.log("\n--- 10. Alat umur_piutang memperhitungkan pelunasan ---");
  // ================================================================

  const { runTool } = await import("../lib/ai/tools");
  const hasilAlat = await runTool("umur_piutang", {});
  if (!hasilAlat.ok) {
    ok("alat umur_piutang berjalan", false, hasilAlat.error);
  } else {
    const total = Number(hasilAlat.meta.total_piutang ?? 0);
    eq("total umur piutang == sisa tagihan, bukan nilai faktur", total, menurutFaktur.saldo);

    const semuaFaktur = await satu(
      `SELECT COALESCE(SUM(total),0) AS x FROM sales_invoice WHERE status='POSTED'`
    );
    ok(
      "angkanya memang berbeda dari total faktur (pelunasan benar-benar terhitung)",
      Math.abs(Number(semuaFaktur.x) - total) > 0.005,
      `faktur ${semuaFaktur.x}, piutang ${total}`
    );
    // Pelanggan yang seluruh fakturnya lunas tidak boleh muncul sama
    // sekali; angkanya nol dan barisnya hanya akan mengaburkan daftar.
    const cus2Muncul = hasilAlat.rows.some(
      (r: Record<string, unknown>) => r.kode === "CUS-002"
    );
    ok("pelanggan tanpa sisa tagihan tidak muncul", !cus2Muncul);

    const jumlahEmber = hasilAlat.rows.reduce(
      (a: number, r: Record<string, unknown>) =>
        a +
        Number(r.umur_0_30) + Number(r.umur_31_60) +
        Number(r.umur_61_90) + Number(r.umur_di_atas_90),
      0
    );
    eq("jumlah keempat ember == total piutang", jumlahEmber, total);
  }
}

async function main() {
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

    // Harus disetel SEBELUM lib/posting (dan lewat itu lib/db) diimpor.
    process.env.DATABASE_URL = tempUrl;

    const ro = new URL(tempUrl);
    const asal = process.env.READONLY_DATABASE_URL;
    if (asal) {
      const a = new URL(asal);
      ro.username = a.username;
      ro.password = a.password;
    }
    process.env.READONLY_DATABASE_URL = ro.toString();

    c = new Client({ connectionString: tempUrl });
    await c.connect();
    await tes(c);
  } finally {
    if (c) await c.end().catch(() => {});
    const { pool } = await import("../lib/db");
    await pool().end().catch(() => {});
    const { aiPool } = await import("../lib/ai/db");
    await aiPool().end().catch(() => {});

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

  console.log(gagal === 0 ? "\n✓ Semua tes lolos." : `\n✗ ${gagal} tes gagal.`);
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n✗ " + (e instanceof Error ? e.stack : String(e)));
  process.exit(1);
});
