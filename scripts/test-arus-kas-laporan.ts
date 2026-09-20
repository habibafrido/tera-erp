/**
 * Tes laporan arus kas.
 *
 * Tiga hal yang paling mudah salah, dan semuanya diuji dengan data yang
 * dibuat khusus karena database kerja belum punya kasusnya:
 *
 *   - TRANSFER ANTAR REKENING KAS. Kedua sisinya akun kas, jadi bukan
 *     arus masuk maupun keluar. Kalau ikut terhitung, laporan akan
 *     menunjukkan uang mengalir padahal saldo total tidak bergerak.
 *
 *   - JURNAL MULTI-LAWAN. Satu mutasi kas bisa berhadapan dengan
 *     beberapa akun berkategori berbeda. Kalau pembagiannya salah,
 *     sebagian nilai hilang dari laporan tanpa tanda apa pun.
 *
 *   - PERIODE TANPA MUTASI KAS SAMA SEKALI. Laporan harus tetap
 *     menutup, bukan menghasilkan NaN atau selisih semu.
 *
 * Jalankan: npm run test:arus-kas-laporan
 */
process.env.TERA_SKRIP = "1";

import { Client } from "pg";
import { loadEnv } from "./env";
import { start } from "./pgctl";
import { applyMigrations, applySeed } from "./schema";

const env = loadEnv();
const TEMP_DB = "tera_akl_" + Date.now();

let gagal = 0;

function ok(label: string, benar: boolean, detail = "") {
  console.log(`${benar ? "✓" : "✗"} ${label}${detail ? "\n    " + detail : ""}`);
  if (!benar) gagal++;
}

function eq(label: string, a: unknown, b: unknown) {
  ok(label, Math.abs(Number(a) - Number(b)) < 0.005, `dapat ${a}, harap ${b}`);
}

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

async function tes(c: Client) {
  const { arusKas } = await import("../lib/arus-kas");
  const { postGoodsReceipt, postSalesInvoice, postPurchaseInvoice,
          postPaymentReceipt, postSupplierPayment } = await import("../lib/posting");

  const satu = async (sql: string, p: unknown[] = []) =>
    (await c.query(sql, p as never[])).rows[0];

  const t = await satu(`
    SELECT to_char(CURRENT_DATE,'YYYY-MM-DD')                       AS hari_ini,
           to_char(date_trunc('month', CURRENT_DATE),'YYYY-MM-DD')  AS awal_bulan,
           to_char((date_trunc('month', CURRENT_DATE)
                    + INTERVAL '1 month - 1 day')::date,'YYYY-MM-DD') AS akhir_bulan,
           to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '1 month',
                   'YYYY-MM-DD')                                    AS awal_lalu,
           to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '1 day',
                   'YYYY-MM-DD')                                    AS akhir_lalu,
           to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '6 months',
                   'YYYY-MM-DD')                                    AS jauh_awal,
           to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '5 months - 1 day',
                   'YYYY-MM-DD')                                    AS jauh_akhir
  `);

  const wh = (await satu(`SELECT id FROM warehouse WHERE code='WH-PST'`)).id;
  const supPkp = (await satu(`SELECT id FROM partner WHERE code='SUP-001'`)).id;
  const cus = (await satu(`SELECT id FROM partner WHERE code='CUS-001'`)).id;
  const pengawas = (
    await satu(`SELECT id FROM app_user WHERE email='pengawas@tera.local'`)
  ).id;

  const prod = (
    await satu(
      `INSERT INTO product (sku,name,base_uom_id,is_batch_tracked)
       VALUES ('AKL-001','Barang uji arus kas',
               (SELECT id FROM uom WHERE code='PCS'), false) RETURNING id`
    )
  ).id;

  /** Saldo kas langsung dari journal_line — sumber terpisah dari laporan. */
  const saldoKasLangsung = async (sampai: string) =>
    (
      await satu(
        `SELECT COALESCE(SUM(l.debit - l.credit),0)::text AS x
           FROM journal_line l
           JOIN journal_entry e ON e.id=l.entry_id AND e.is_posted
           JOIN account a ON a.id=l.account_id
          WHERE a.is_cash_equivalent AND e.entry_date <= $1::date`,
        [sampai]
      )
    ).x;

  /** Jurnal manual seimbang. baris: [kode akun, debit, kredit]. */
  async function jurnal(
    no: string,
    tanggal: string,
    ket: string,
    baris: [string, number, number][]
  ) {
    await c.query("BEGIN");
    try {
      const id = (
        await satu(
          `INSERT INTO journal_entry (entry_no, entry_date, description, is_posted, created_by)
           VALUES ($1,$2::date,$3,false,$4) RETURNING id`,
          [no, tanggal, ket, pengawas]
        )
      ).id;
      for (const [kode, d, k] of baris) {
        await c.query(
          `INSERT INTO journal_line (entry_id, account_id, debit, credit)
           VALUES ($1,(SELECT id FROM account WHERE code=$2),$3,$4)`,
          [id, kode, d, k]
        );
      }
      await c.query(`UPDATE journal_entry SET is_posted=true WHERE id=$1`, [id]);
      await c.query("COMMIT");
      return id;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    }
  }

  // ================================================================
  console.log("\n--- 1. Periode tanpa mutasi kas sama sekali ---");
  // ================================================================

  const kosong = await arusKas(t.jauh_awal, t.jauh_akhir, t.jauh_awal, t.jauh_akhir);
  eq("saldo awal nol", kosong.saldoAwal, 0);
  eq("saldo akhir nol", kosong.saldoAkhir, 0);
  eq("total arus nol", kosong.totalArus, 0);
  nol("selisih tepat nol", kosong.selisih);
  ok("ditandai menutup", kosong.seimbang === true);
  eq("tidak ada rincian operasi", kosong.operasi.length, 0);
  ok(
    "angkanya angka, bukan NaN",
    [kosong.saldoAwal, kosong.saldoAkhir, kosong.totalArus].every(Number.isFinite)
  );

  // ================================================================
  console.log("\n--- 2. Arus kas dari dokumen sungguhan ---");
  // ================================================================

  // Penerimaan barang + faktur ber-PPN + pembayaran ke pemasok.
  const gr = (
    await satu(
      `INSERT INTO goods_receipt (doc_date,supplier_id,warehouse_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [t.awal_bulan, supPkp, wh]
    )
  ).id;
  const grLine = (
    await satu(
      `INSERT INTO goods_receipt_line (receipt_id,line_no,product_id,qty,unit_cost)
       VALUES ($1,1,$2,100,10000) RETURNING id`,
      [gr, prod]
    )
  ).id;
  await postGoodsReceipt(gr);

  const pi = (
    await satu(
      `INSERT INTO purchase_invoice (doc_date,supplier_id,supplier_ref,tax_rate)
       VALUES ($1,$2,'FB-AKL-1',0.11) RETURNING id`,
      [t.awal_bulan, supPkp]
    )
  ).id;
  await c.query(
    `INSERT INTO purchase_invoice_line (invoice_id,line_no,receipt_line_id,qty,unit_cost)
     VALUES ($1,1,$2,100,10000)`,
    [pi, grLine]
  );
  const rPi = await postPurchaseInvoice(pi);
  eq("faktur pembelian ber-PPN", rPi.total, 1_110_000);

  const sp = (
    await satu(
      `INSERT INTO supplier_payment (doc_date,supplier_id,amount,method)
       VALUES ($1,$2,1110000,'TRANSFER') RETURNING id`,
      [t.awal_bulan, supPkp]
    )
  ).id;
  await c.query(
    `INSERT INTO supplier_payment_allocation (payment_id,invoice_id,amount)
     VALUES ($1,$2,1110000)`,
    [sp, pi]
  );
  await postSupplierPayment(sp);

  // Penjualan + penerimaan pembayaran, sebagian jadi titipan pelanggan.
  const inv = (
    await satu(
      `INSERT INTO sales_invoice (doc_date,customer_id,warehouse_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [t.awal_bulan, cus, wh]
    )
  ).id;
  await c.query(
    `INSERT INTO sales_invoice_line (invoice_id,line_no,product_id,qty,unit_price)
     VALUES ($1,1,$2,60,20000)`,
    [inv, prod]
  );
  const rInv = await postSalesInvoice(inv);

  const pr = (
    await satu(
      `INSERT INTO payment_receipt (doc_date,customer_id,amount,method)
       VALUES ($1,$2,$3,'TRANSFER') RETURNING id`,
      [t.awal_bulan, cus, Number(rInv.total) + 200_000]
    )
  ).id;
  await c.query(
    `INSERT INTO payment_allocation (payment_id,invoice_id,amount)
     VALUES ($1,$2,$3)`,
    [pr, inv, rInv.total]
  );
  await postPaymentReceipt(pr);

  // Setoran modal: satu-satunya golongan PENDANAAN yang ada akunnya.
  await jurnal("UJI/MODAL/1", t.awal_bulan, "Setoran modal pemilik", [
    ["1-1100", 5_000_000, 0],
    ["3-1100", 0, 5_000_000],
  ]);

  const a = await arusKas(t.awal_bulan, t.akhir_bulan, t.awal_lalu, t.akhir_lalu);

  console.log(
    `    operasi ${a.totalOperasi}, investasi ${a.totalInvestasi}, ` +
      `pendanaan ${a.totalPendanaan}`
  );
  ok("ada rincian operasi", a.operasi.length > 0,
     a.operasi.map((b) => `${b.kode}=${b.nilai}`).join(" "));
  eq("setoran modal tergolong PENDANAAN", a.totalPendanaan, 5_000_000);
  eq("investasi masih nol (akun aset tetap belum ada)", a.totalInvestasi, 0);
  eq("tidak ada yang belum digolongkan", a.belumDigolongkan.length, 0);

  nol("laporan menutup: awal + arus == akhir", a.selisih);
  ok("ditandai menutup", a.seimbang === true);
  eq(
    "saldo akhir == saldo kas menurut journal_line langsung",
    a.saldoAkhir,
    await saldoKasLangsung(t.akhir_bulan)
  );

  // ================================================================
  console.log("\n--- 3. Jurnal multi-lawan berkategori berbeda ---");
  // ================================================================

  /*
   * Satu mutasi kas berhadapan dengan DUA akun lawan sekaligus, dan
   * golongannya berbeda: sebagian operasi, sebagian pendanaan. Kalau
   * pembagiannya salah, salah satu golongan akan kehilangan nilainya.
   */
  const opSebelum = a.totalOperasi;
  const pdSebelum = a.totalPendanaan;

  await jurnal("UJI/CAMPUR/1", t.hari_ini, "Kas masuk campuran", [
    ["1-1100", 1_000_000, 0],
    ["4-1100", 0, 700_000], // OPERASI
    ["3-1100", 0, 300_000], // PENDANAAN
  ]);

  const b = await arusKas(t.awal_bulan, t.akhir_bulan, t.awal_lalu, t.akhir_lalu);
  eq("bagian operasi bertambah 700.000", b.totalOperasi - opSebelum, 700_000);
  eq("bagian pendanaan bertambah 300.000", b.totalPendanaan - pdSebelum, 300_000);
  eq(
    "jumlah keduanya == mutasi kasnya, tidak ada yang hilang",
    b.totalOperasi - opSebelum + (b.totalPendanaan - pdSebelum),
    1_000_000
  );
  nol("laporan tetap menutup", b.selisih);

  // Kasus lebih keras: PPN + pokok + titipan dalam satu pembayaran.
  await jurnal("UJI/CAMPUR/2", t.hari_ini, "Kas keluar tiga lawan", [
    ["1-1100", 0, 555_000],
    ["2-1100", 300_000, 0], // OPERASI
    ["1-1400", 55_000, 0],  // OPERASI
    ["3-1100", 200_000, 0], // PENDANAAN
  ]);

  const b2 = await arusKas(t.awal_bulan, t.akhir_bulan, t.awal_lalu, t.akhir_lalu);
  eq(
    "operasi turun 355.000",
    b2.totalOperasi - b.totalOperasi,
    -355_000
  );
  eq(
    "pendanaan turun 200.000",
    b2.totalPendanaan - b.totalPendanaan,
    -200_000
  );
  nol("laporan tetap menutup", b2.selisih);

  // ================================================================
  console.log("\n--- 4. Transfer antar rekening kas ---");
  // ================================================================

  await c.query(
    `INSERT INTO account (code, name, type, is_cash_equivalent)
     VALUES ('1-1110','BCA Operasional 123456','ASSET',true)`
  );

  const sebelum = await arusKas(t.awal_bulan, t.akhir_bulan, t.awal_lalu, t.akhir_lalu);
  const saldoSebelum = await saldoKasLangsung(t.akhir_bulan);

  await jurnal("UJI/TRANSFER/1", t.hari_ini, "Pindah dana ke BCA", [
    ["1-1110", 2_000_000, 0],
    ["1-1100", 0, 2_000_000],
  ]);

  const sesudah = await arusKas(t.awal_bulan, t.akhir_bulan, t.awal_lalu, t.akhir_lalu);

  eq("saldo total kas tidak berubah", await saldoKasLangsung(t.akhir_bulan), saldoSebelum);
  eq("operasi tidak tersentuh", sesudah.totalOperasi, sebelum.totalOperasi);
  eq("investasi tidak tersentuh", sesudah.totalInvestasi, sebelum.totalInvestasi);
  eq("pendanaan tidak tersentuh", sesudah.totalPendanaan, sebelum.totalPendanaan);
  eq("total arus tidak berubah", sesudah.totalArus, sebelum.totalArus);
  nol("laporan TETAP menutup saat ada transfer antar kas", sesudah.selisih);

  /*
   * Transfer YANG MEMBAWA BIAYA tetap harus muncul — tapi hanya sebesar
   * biayanya, karena hanya itu yang benar-benar meninggalkan kas.
   */
  const opSebelumBiaya = sesudah.totalOperasi;
  await jurnal("UJI/TRANSFER/2", t.hari_ini, "Pindah dana dengan biaya admin", [
    ["1-1100", 990_000, 0],
    ["5-2100", 10_000, 0], // OPERASI: biaya admin
    ["1-1110", 0, 1_000_000],
  ]);

  const dgnBiaya = await arusKas(t.awal_bulan, t.akhir_bulan, t.awal_lalu, t.akhir_lalu);
  eq(
    "hanya biayanya yang tercatat sebagai arus keluar",
    dgnBiaya.totalOperasi - opSebelumBiaya,
    -10_000
  );
  nol("laporan tetap menutup", dgnBiaya.selisih);

  // ================================================================
  console.log("\n--- 5. Asersi mengikat pada beberapa tanggal ---");
  // ================================================================

  const rentang: [string, string, string][] = [
    ["periode tanpa mutasi kas", t.jauh_awal, t.jauh_akhir],
    ["bulan lalu", t.awal_lalu, t.akhir_lalu],
    ["bulan berjalan", t.awal_bulan, t.akhir_bulan],
    ["sejak awal sampai hari ini", "2000-01-01", t.hari_ini],
    ["satu hari saja", t.hari_ini, t.hari_ini],
  ];

  for (const [label, dari, sampai] of rentang) {
    const x = await arusKas(dari, sampai, dari, sampai);

    nol(`${label}: awal + arus == akhir`, x.selisih,
        `awal ${x.saldoAwal}, arus ${x.totalArus}, akhir ${x.saldoAkhir}`);

    /*
     * Saldo akhir dibandingkan dengan journal_line LANGSUNG, bukan
     * dengan penjumlahan laporannya sendiri. Kalau keduanya berasal
     * dari kueri yang sama, asersinya tidak membuktikan apa pun.
     */
    eq(
      `${label}: saldo akhir == buku besar akun kas`,
      x.saldoAkhir,
      await saldoKasLangsung(sampai)
    );

    // Rincian yang ditampilkan harus menjumlah ke total yang dipakai.
    const jumlahRincian =
      x.operasi.reduce((a, r) => a + r.nilai, 0) +
      x.investasi.reduce((a, r) => a + r.nilai, 0) +
      x.pendanaan.reduce((a, r) => a + r.nilai, 0) +
      x.belumDigolongkan.reduce((a, r) => a + r.nilai, 0);
    eq(`${label}: jumlah rincian == total arus`, jumlahRincian, x.totalArus);

    eq(`${label}: tidak ada akun tanpa golongan`, x.belumDigolongkan.length, 0);
  }

  // ================================================================
  console.log("\n--- 6. Kolom pembanding ---");
  // ================================================================

  const dua = await arusKas(t.awal_bulan, t.akhir_bulan, t.awal_lalu, t.akhir_lalu);
  const sendiri = await arusKas(t.awal_lalu, t.akhir_lalu, t.awal_lalu, t.akhir_lalu);
  eq(
    "kolom pembanding == laporan periode pembanding",
    dua.bandingTotalOperasi,
    sendiri.totalOperasi
  );
  eq("saldo awal pembanding cocok", dua.bandingSaldoAwal, sendiri.saldoAwal);

  const adaPembandingNol = dua.operasi.find((b) => b.pembanding === 0);
  if (adaPembandingNol) {
    ok(
      "selisih persen null saat pembanding nol, bukan tak hingga",
      adaPembandingNol.selisihPersen === null,
      String(adaPembandingNol.selisihPersen)
    );
  }

  // ================================================================
  console.log("\n--- 7. SQL ekspor sepakat dengan halaman ---");
  // ================================================================

  const { cariLaporan, validasiFilter } = await import("../lib/export/reports");
  const lap = cariLaporan("arus_kas")!;
  const f = validasiFilter(
    lap,
    new URLSearchParams({ dari: t.awal_bulan, sampai: t.akhir_bulan, banding: "bulan" })
  );
  const k = lap.sql(f);
  const rows = (await c.query(k.text, k.values as never[])).rows as Record<
    string,
    unknown
  >[];

  const cari = (nama: string) => rows.find((r) => r.akun === nama);
  eq(
    "saldo kas awal di ekspor == halaman",
    cari("Saldo kas awal periode")?.periode,
    dua.saldoAwal
  );
  eq(
    "saldo kas akhir di ekspor == halaman",
    cari("Saldo kas akhir periode")?.periode,
    dua.saldoAkhir
  );
  eq(
    "jumlah operasi di ekspor == halaman",
    cari("Jumlah operasi")?.periode,
    dua.totalOperasi
  );
  eq(
    "jumlah pendanaan di ekspor == halaman",
    cari("Jumlah pendanaan")?.periode,
    dua.totalPendanaan
  );

  const adaTransfer = rows.some((r) =>
    String(r.akun).includes("BCA Operasional")
  );
  ok("rekening kas kedua TIDAK muncul sebagai akun lawan", !adaTransfer);

  ok(
    "setiap baris ekspor punya penanda jenis",
    rows.every((r) => ["akun", "saldo", "subtotal"].includes(String(r.jenis))),
    [...new Set(rows.map((r) => String(r.jenis)))].join(", ")
  );

  /*
   * Baris saldo TIDAK boleh bertanda 'akun'.
   *
   * Penulis XLSX menjumlahkan baris 'akun' berurutan tepat di atas
   * sebuah subtotal. Kalau saldo kas awal ikut bertanda 'akun', ia
   * tertelan ke dalam "Jumlah operasi" — laporan tetap tercetak, tetap
   * terlihat wajar, dan salah.
   */
  ok(
    "baris saldo kas tidak bertanda 'akun'",
    rows
      .filter((r) => String(r.akun).startsWith("Saldo kas"))
      .every((r) => r.jenis === "saldo"),
    rows
      .filter((r) => String(r.akun).startsWith("Saldo kas"))
      .map((r) => `${r.akun}=${r.jenis}`)
      .join(", ")
  );

  // Dan dibuktikan lewat berkas Excel yang sebenarnya.
  const { tulisWorkbook } = await import("../lib/export/xlsx");
  const ExcelJS = (await import("exceljs")).default;
  const buf = await tulisWorkbook({
    laporan: lap,
    filter: f,
    ringkasan: "uji",
    dicetakPada: "21 Sep 2026 00:00",
    baris: rows,
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];

  let barisSaldoAwal = 0;
  let rumusOperasi = "";
  ws.eachRow((row, n) => {
    const nama = String(row.getCell(3).value ?? "").trim();
    if (nama === "Saldo kas awal periode") barisSaldoAwal = n;
    if (nama === "Jumlah operasi") {
      const v = row.getCell(4).value as { formula?: string } | number | null;
      rumusOperasi =
        v && typeof v === "object" && "formula" in v ? String(v.formula) : "";
    }
  });

  ok(
    "rumus Jumlah operasi TIDAK memuat baris saldo kas awal",
    rumusOperasi === "" ||
      !new RegExp(`D${barisSaldoAwal}\b`).test(rumusOperasi),
    `saldo awal di baris ${barisSaldoAwal}, rumus: ${rumusOperasi || "(angka biasa)"}`
  );

  // ================================================================
  console.log("\n--- 8. Buku besar tetap konsisten ---");
  // ================================================================

  const seimbang = await satu(`
    SELECT (COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0))::text AS selisih
      FROM journal_line l JOIN journal_entry e ON e.id=l.entry_id AND e.is_posted
  `);
  nol("debit == kredit di seluruh jurnal", seimbang.selisih);

  const { neraca } = await import("../lib/laporan-keuangan");
  const n = await neraca(t.hari_ini, t.hari_ini);
  ok("neraca seimbang tepat nol", n.seimbang === true, `selisih ${n.selisih}`);
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
