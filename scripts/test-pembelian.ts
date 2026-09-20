/**
 * Tes faktur pembelian dan pencocokan tiga arah.
 *
 * Pertanyaan pokok yang dijawab skrip ini: apakah akun Barang Diterima
 * Belum Ditagih benar-benar KOSONG setelah semua penerimaan difakturkan.
 * Selama ini akun itu hanya bisa bertambah, dan angka yang menumpuk di
 * sana membuat liabilitas di neraca jauh lebih besar dari utang yang
 * sebenarnya.
 *
 * Yang juga diuji, karena semuanya gagal tanpa suara:
 *   - faktur bertahap tidak melepas GRNI dua kali untuk barang yang sama;
 *   - selisih harga masuk akun tersendiri dan TIDAK menyentuh nilai
 *     persediaan maupun rata-rata bergerak;
 *   - selisih kuantitas menahan posting sampai disetujui;
 *   - dua faktur bersamaan atas penerimaan yang sama tidak saling menimpa.
 *
 * Jalankan: npm run test:pembelian
 */
import { Client } from "pg";
import { loadEnv } from "./env";
import { start } from "./pgctl";
import { applyMigrations, applySeed } from "./schema";

const env = loadEnv();
const TEMP_DB = "tera_beli_" + Date.now();

let gagal = 0;

function ok(label: string, benar: boolean, detail = "") {
  console.log(`${benar ? "✓" : "✗"} ${label}${detail ? "\n    " + detail : ""}`);
  if (!benar) gagal++;
}

function eq(label: string, a: unknown, b: unknown) {
  ok(label, Math.abs(Number(a) - Number(b)) < 0.005, `dapat ${a}, harap ${b}`);
}

/** Tanpa toleransi: untuk angka yang harus TEPAT nol. */
function nol(label: string, nilai: unknown, konteks = "") {
  const s = String(nilai);
  ok(label, /^-?0(\.0+)?$/.test(s), `nilai ${s}${konteks ? " — " + konteks : ""}`);
}

function urlFor(d: string) {
  const u = new URL(env.url);
  u.pathname = "/" + d;
  return u.toString();
}

const q = (i: string) => '"' + i.replace(/"/g, '""') + '"';

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
  const { postGoodsReceipt, postSalesInvoice, postPurchaseInvoice } =
    await import("../lib/posting");

  const satu = async (sql: string, p: unknown[] = []) =>
    (await c.query(sql, p as never[])).rows[0];

  const hariIni = (await satu("SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS d")).d;
  const wh = (await satu(`SELECT id FROM warehouse WHERE code='WH-PST'`)).id;
  const sup = (await satu(`SELECT id FROM partner WHERE code='SUP-001'`)).id;
  const sup2 = (await satu(`SELECT id FROM partner WHERE code='SUP-002'`)).id;
  const cus = (await satu(`SELECT id FROM partner WHERE code='CUS-001'`)).id;

  const prod = (
    await satu(
      `INSERT INTO product (sku,name,base_uom_id,is_batch_tracked)
       VALUES ('BELI-001','Barang uji pembelian',
               (SELECT id FROM uom WHERE code='PCS'), false)
       RETURNING id`
    )
  ).id;

  /** Penerimaan barang terposting. Mengembalikan id baris penerimaannya. */
  async function terima(qty: number, biaya: number, pemasok = sup) {
    const id = (
      await satu(
        `INSERT INTO goods_receipt (doc_date,supplier_id,warehouse_id)
         VALUES ($1,$2,$3) RETURNING id`,
        [hariIni, pemasok, wh]
      )
    ).id;
    const line = (
      await satu(
        `INSERT INTO goods_receipt_line (receipt_id,line_no,product_id,qty,unit_cost)
         VALUES ($1,1,$2,$3,$4) RETURNING id`,
        [id, prod, qty, biaya]
      )
    ).id;
    const r = await postGoodsReceipt(id);
    return { id, line, docNo: r.docNo as string };
  }

  /** Faktur pembelian draf. */
  async function faktur(
    baris: [string, number, number][],
    opts: { pemasok?: string; ref?: string } = {}
  ) {
    const id = (
      await satu(
        `INSERT INTO purchase_invoice (doc_date,supplier_id,supplier_ref)
         VALUES ($1,$2,$3) RETURNING id`,
        [hariIni, opts.pemasok ?? sup, opts.ref ?? null]
      )
    ).id;
    let n = 1;
    for (const [rl, qty, harga] of baris) {
      await c.query(
        `INSERT INTO purchase_invoice_line
           (invoice_id,line_no,receipt_line_id,qty,unit_cost)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, n++, rl, qty, harga]
      );
    }
    return id;
  }

  const saldo = async (kode: string) =>
    (
      await satu(
        `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS x
           FROM journal_line l
           JOIN journal_entry e ON e.id=l.entry_id AND e.is_posted
           JOIN account a ON a.id=l.account_id
          WHERE a.code=$1`,
        [kode]
      )
    ).x;

  // ================================================================
  console.log("\n--- 1. Faktur yang cocok sempurna ---");
  // ================================================================

  const g1 = await terima(100, 10_000); // GRNI +1.000.000
  eq("GRNI bertambah saat barang diterima", await saldo("2-1300"), 1_000_000);

  const f1 = await faktur([[g1.line, 100, 10_000]], { ref: "FB-001" });
  const r1 = await postPurchaseInvoice(f1);

  eq("GRNI kembali nol setelah difakturkan", await saldo("2-1300"), 0);
  eq("utang usaha sebesar nilai faktur", await saldo("2-1100"), 1_000_000);
  nol("tidak ada selisih harga", r1.selisihHarga);
  nol("tidak ada selisih kuantitas", r1.selisihQty);
  ok("nomor dokumen berpola PI/tahun/bulan/urut", /^PI\/\d{4}\/\d{2}\/\d{4}$/.test(r1.docNo));

  const barisSelisih = await satu(
    `SELECT COUNT(*) AS n
       FROM journal_entry e JOIN journal_line l ON l.entry_id=e.id
       JOIN account a ON a.id=l.account_id
      WHERE e.source_id=$1 AND a.code='5-3100'`,
    [f1]
  );
  eq("faktur yang cocok tidak menghasilkan baris selisih sama sekali", barisSelisih.n, 0);

  // ================================================================
  console.log("\n--- 2. Selisih harga tidak menyentuh persediaan ---");
  // ================================================================

  const g2 = await terima(100, 10_000);

  // Sebagian dijual DULU, supaya rata-rata bergerak sudah terpakai untuk
  // HPP sebelum faktur pemasok datang. Ini justru keadaan yang membuat
  // revaluasi persediaan tidak bisa dipertanggungjawabkan.
  const inv = (
    await satu(
      `INSERT INTO sales_invoice (doc_date,customer_id,warehouse_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [hariIni, cus, wh]
    )
  ).id;
  await c.query(
    `INSERT INTO sales_invoice_line (invoice_id,line_no,product_id,qty,unit_price)
     VALUES ($1,1,$2,60,25000)`,
    [inv, prod]
  );
  await postSalesInvoice(inv);

  const sebelum = await satu(
    `SELECT ROUND(SUM(stock_value), 2) AS nilai, SUM(qty_on_hand) AS qty
       FROM v_stock_balance WHERE product_id=$1`,
    [prod]
  );
  const rataSebelum = Number(sebelum.nilai) / Number(sebelum.qty);

  // Faktur datang dengan harga 11.000, bukan 10.000.
  const f2 = await faktur([[g2.line, 100, 11_000]], { ref: "FB-002" });
  const r2 = await postPurchaseInvoice(f2);

  eq("selisih harga = 100 x 1.000", r2.selisihHarga, 100_000);
  eq("GRNI dilepas pada harga PENERIMAAN, bukan harga faktur", r2.grni, 1_000_000);
  eq("utang diakui pada harga FAKTUR", r2.subtotal, 1_100_000);

  const sesudah = await satu(
    `SELECT ROUND(SUM(stock_value), 2) AS nilai, SUM(qty_on_hand) AS qty
       FROM v_stock_balance WHERE product_id=$1`,
    [prod]
  );
  eq("nilai persediaan TIDAK berubah karena faktur", sesudah.nilai, sebelum.nilai);
  eq("kuantitas persediaan tidak berubah", sesudah.qty, sebelum.qty);
  eq(
    "rata-rata bergerak tidak bergeser",
    Number(sesudah.nilai) / Number(sesudah.qty),
    rataSebelum
  );

  const ledgerBaru = await satu(
    `SELECT COUNT(*) AS n FROM stock_ledger WHERE source_type='PURCHASE_INVOICE'`
  );
  eq("faktur pembelian tidak menulis satu baris pun ke buku besar stok", ledgerBaru.n, 0);

  eq("selisih masuk akun 5-3100 sebagai beban", Number(await saldo("5-3100")), -100_000);

  // Harga faktur LEBIH MURAH: selisihnya harus berbalik arah.
  const g3 = await terima(50, 20_000); // GRNI +1.000.000
  const f3 = await faktur([[g3.line, 50, 18_000]], { ref: "FB-003" });
  const r3 = await postPurchaseInvoice(f3);
  eq("harga lebih murah menghasilkan selisih negatif", r3.selisihHarga, -100_000);
  eq("akun selisih kembali nol setelah saling meniadakan", await saldo("5-3100"), 0);

  // ================================================================
  console.log("\n--- 3. Faktur bertahap atas satu penerimaan ---");
  // ================================================================

  const g4 = await terima(100, 5_000); // GRNI +500.000
  const grniAwal = await saldo("2-1300");

  const f4a = await faktur([[g4.line, 40, 5_000]], { ref: "FB-004a" });
  await postPurchaseInvoice(f4a);
  eq("GRNI turun sebagian saja", await saldo("2-1300"), Number(grniAwal) - 200_000);

  const m = await satu(
    `SELECT qty_difakturkan, qty_sisa, grni_sisa
       FROM v_receipt_matching WHERE receipt_line_id=$1`,
    [g4.line]
  );
  eq("pencocokan mencatat 40 sudah difakturkan", m.qty_difakturkan, 40);
  eq("sisa 60 belum difakturkan", m.qty_sisa, 60);
  eq("GRNI sisa untuk baris ini = 60 x 5.000", m.grni_sisa, 300_000);

  const f4b = await faktur([[g4.line, 60, 5_000]], { ref: "FB-004b" });
  await postPurchaseInvoice(f4b);
  eq("GRNI baris ini habis setelah tahap kedua", await saldo("2-1300"), Number(grniAwal) - 500_000);

  /*
   * Yang paling mudah salah: faktur tahap kedua melepas GRNI seolah-olah
   * tahap pertama tidak pernah ada. Kalau itu terjadi, GRNI akan
   * menjadi negatif 200.000 di sini, bukan nol.
   */
  const m2 = await satu(
    `SELECT qty_sisa, grni_sisa FROM v_receipt_matching WHERE receipt_line_id=$1`,
    [g4.line]
  );
  nol("tidak ada sisa setelah difakturkan penuh", m2.qty_sisa);
  nol("GRNI baris ini tepat nol, tidak negatif", m2.grni_sisa);

  await tolak(
    "faktur ketiga atas baris yang sudah habis ditolak",
    async () => postPurchaseInvoice(await faktur([[g4.line, 1, 5_000]], { ref: "FB-004c" })),
    /selisih kuantitas/
  );

  // ================================================================
  console.log("\n--- 4. Selisih kuantitas menahan posting ---");
  // ================================================================

  const g5 = await terima(100, 8_000);
  const f5 = await faktur([[g5.line, 120, 8_000]], { ref: "FB-005" });

  await tolak(
    "menagih lebih banyak dari yang diterima ditahan",
    async () => postPurchaseInvoice(f5),
    /Posting ditahan karena selisih kuantitas/
  );

  const masihDraf = await satu(`SELECT status FROM purchase_invoice WHERE id=$1`, [f5]);
  ok("faktur tetap draf setelah ditahan", masihDraf.status === "DRAFT", masihDraf.status);
  eq("GRNI belum tersentuh", await saldo("2-1300"), 800_000);

  const jurnalTertahan = await satu(
    `SELECT COUNT(*) AS n FROM journal_entry WHERE source_id=$1`, [f5]
  );
  eq("tidak ada jurnal yang tertinggal dari posting yang ditahan", jurnalTertahan.n, 0);

  // --- Setelah disetujui, posting boleh jalan ---
  await c.query(
    `UPDATE purchase_invoice
        SET qty_variance_approved=true, approved_at=now(), approved_by='uji'
      WHERE id=$1`,
    [f5]
  );
  const r5 = await postPurchaseInvoice(f5);

  eq("GRNI dilepas hanya sebesar yang benar-benar diterima", r5.grni, 800_000);
  eq("kelebihan 20 unit jadi selisih kuantitas", r5.selisihQty, 160_000);
  eq("utang diakui sebesar seluruh tagihan", r5.subtotal, 960_000);
  eq("GRNI baris ini habis, tidak negatif", await saldo("2-1300"), 0);

  const persetujuan = await satu(
    `SELECT approved_by, approved_at IS NOT NULL AS ada FROM purchase_invoice WHERE id=$1`,
    [f5]
  );
  ok("persetujuan membawa jejak siapa dan kapan",
     persetujuan.approved_by === "uji" && persetujuan.ada === true);

  await tolak(
    "persetujuan tanpa jejak ditolak database",
    async () => {
      await c.query(
        `INSERT INTO purchase_invoice (doc_date,supplier_id,qty_variance_approved)
         VALUES ($1,$2,true)`,
        [hariIni, sup]
      );
    },
    /purchase_invoice_check|violates check constraint/
  );

  // ================================================================
  console.log("\n--- 5. Penolakan lain ---");
  // ================================================================

  const g6 = await terima(10, 1_000, sup2);
  await tolak(
    "penerimaan dari pemasok lain ditolak",
    async () => postPurchaseInvoice(await faktur([[g6.line, 10, 1_000]], { ref: "FB-006" })),
    /pemasok lain/
  );

  await tolak(
    "nomor faktur pemasok yang sama ditolak database",
    async () => {
      await c.query(
        `INSERT INTO purchase_invoice (doc_date,supplier_id,supplier_ref)
         VALUES ($1,$2,'FB-001')`,
        [hariIni, sup]
      );
    },
    /idx_pi_supplier_ref|duplicate key/
  );

  await tolak(
    "posting ulang ditolak",
    async () => postPurchaseInvoice(f1),
    /sudah diposting/
  );

  await tolak(
    "baris tidak bisa ditambahkan ke faktur terposting",
    async () => {
      await c.query(
        `INSERT INTO purchase_invoice_line
           (invoice_id,line_no,receipt_line_id,qty,unit_cost)
         VALUES ($1,99,$2,1,1)`,
        [f1, g1.line]
      );
    },
    /sudah diposting/
  );

  // ================================================================
  console.log("\n--- 6. Dua faktur bersamaan atas penerimaan yang sama ---");
  // ================================================================

  const g7 = await terima(100, 3_000); // GRNI +300.000
  const fa = await faktur([[g7.line, 70, 3_000]], { ref: "FB-007a" });
  const fb = await faktur([[g7.line, 70, 3_000]], { ref: "FB-007b" });

  const hasil = await Promise.allSettled([
    postPurchaseInvoice(fa),
    postPurchaseInvoice(fb),
  ]);
  const sukses = hasil.filter((h) => h.status === "fulfilled").length;
  eq("tepat satu faktur berhasil", sukses, 1);

  const ditolak = hasil.find((h) => h.status === "rejected") as
    | PromiseRejectedResult
    | undefined;
  ok(
    "yang gagal ditahan karena selisih kuantitas, bukan galat lain",
    /selisih kuantitas/.test(String(ditolak?.reason)),
    String(ditolak?.reason)
  );

  const m7 = await satu(
    `SELECT qty_difakturkan, grni_sisa FROM v_receipt_matching WHERE receipt_line_id=$1`,
    [g7.line]
  );
  eq("hanya 70 unit yang difakturkan, bukan 140", m7.qty_difakturkan, 70);
  eq("GRNI sisa 30 x 3.000, bukan negatif", m7.grni_sisa, 90_000);

  // ================================================================
  console.log("\n--- 7. GRNI nol setelah SEMUA penerimaan difakturkan ---");
  // ================================================================

  // Sisa yang belum difakturkan dihabiskan pada harga penerimaannya,
  // supaya yang diuji murni keseimbangan GRNI-nya.
  const belum = await c.query(
    `SELECT receipt_line_id, qty_sisa, biaya_terima, supplier_id
       FROM v_receipt_matching WHERE qty_sisa > 0 ORDER BY receipt_line_id`
  );
  console.log(`    ${belum.rows.length} baris penerimaan masih menggantung`);

  let ref = 900;
  for (const b of belum.rows) {
    const id = await faktur(
      [[b.receipt_line_id, Number(b.qty_sisa), Number(b.biaya_terima)]],
      { pemasok: b.supplier_id, ref: "FB-" + ref++ }
    );
    await postPurchaseInvoice(id);
  }

  const grniAkhir = await satu(
    `SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS saldo
       FROM journal_line l
       JOIN journal_entry e ON e.id=l.entry_id AND e.is_posted
       JOIN account a ON a.id=l.account_id
      WHERE a.code='2-1300'`
  );
  nol(
    "saldo Barang Diterima Belum Ditagih TEPAT nol",
    grniAkhir.saldo,
    "inilah alasan faktur pembelian dibangun"
  );

  const menggantung = await satu(
    `SELECT COALESCE(SUM(grni_sisa), 0)::text AS x FROM v_receipt_matching`
  );
  nol("tidak ada baris penerimaan yang masih menggantung", menggantung.x);

  /*
   * qty_sisa boleh negatif — itu justru penanda kelebihan tagih yang
   * sudah disetujui, dan orang perlu melihatnya. grni_sisa TIDAK boleh:
   * GRNI hanya pernah dikreditkan sebesar barang yang benar-benar
   * diterima, jadi kelebihan tagih tidak membuatnya berutang balik.
   */
  const negatif = await satu(
    `SELECT COUNT(*) FILTER (WHERE qty_sisa < 0)  AS qty_negatif,
            COUNT(*) FILTER (WHERE grni_sisa < 0) AS grni_negatif
       FROM v_receipt_matching`
  );
  ok(
    "ada baris kelebihan tagih untuk diuji",
    Number(negatif.qty_negatif) > 0,
    `${negatif.qty_negatif} baris`
  );
  eq("grni_sisa tidak pernah negatif", negatif.grni_negatif, 0);

  const cocokBB = await satu(
    `SELECT (COALESCE((SELECT SUM(grni_sisa) FROM v_receipt_matching), 0)
             - COALESCE((SELECT SUM(l.credit - l.debit)
                           FROM journal_line l
                           JOIN journal_entry e ON e.id=l.entry_id AND e.is_posted
                           JOIN account a ON a.id=l.account_id
                          WHERE a.code='2-1300'), 0))::text AS selisih`
  );
  nol(
    "jumlah grni_sisa == saldo GRNI di buku besar",
    cocokBB.selisih,
    "view dan jurnal harus bercerita hal yang sama"
  );

  // ================================================================
  console.log("\n--- 8. Faktur pembelian bisa dicari di palet ---");
  // ================================================================

  const cariNomor = await cariDokumen(c, r1.docNo);
  ok(
    "nomor faktur internal ditemukan",
    cariNomor.some((x) => x.nomor === r1.docNo && x.jenis === "Faktur pembelian"),
    cariNomor.map((x) => `${x.nomor} (${x.jenis})`).join(", ") || "(kosong)"
  );

  // Nomor faktur PEMASOK adalah yang tercetak di kertas yang dipegang
  // orang, dan itulah yang mereka ketik lebih dulu.
  const cariRef = await cariDokumen(c, "FB-001");
  ok(
    "nomor faktur pemasok juga ditemukan",
    cariRef.some((x) => x.nomor === r1.docNo),
    cariRef.map((x) => `${x.nomor} (${x.jenis})`).join(", ") || "(kosong)"
  );

  // ================================================================
  console.log("\n--- 9. Buku besar tetap konsisten ---");
  // ================================================================

  const seimbang = await satu(`
    SELECT (COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0))::text AS selisih
      FROM journal_line l JOIN journal_entry e ON e.id=l.entry_id AND e.is_posted
  `);
  nol("debit == kredit di seluruh jurnal", seimbang.selisih);

  const { neraca } = await import("../lib/laporan-keuangan");
  const n = await neraca(hariIni, hariIni);
  ok("neraca tetap seimbang tepat nol", n.seimbang === true, `selisih ${n.selisih}`);

  const utangBB = await satu(
    `SELECT COALESCE(SUM(l.credit - l.debit),0) AS x
       FROM journal_line l JOIN journal_entry e ON e.id=l.entry_id AND e.is_posted
       JOIN account a ON a.id=l.account_id WHERE a.code='2-1100'`
  );
  const utangDok = await satu(
    `SELECT COALESCE(SUM(subtotal),0) AS x FROM purchase_invoice WHERE status='POSTED'`
  );
  eq("saldo Utang Usaha == jumlah faktur pembelian terposting", utangBB.x, utangDok.x);
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

    process.env.DATABASE_URL = tempUrl;

    c = new Client({ connectionString: tempUrl });
    await c.connect();
    await tes(c);
  } finally {
    if (c) await c.end().catch(() => {});
    const { pool } = await import("../lib/db");
    await pool().end().catch(() => {});

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
