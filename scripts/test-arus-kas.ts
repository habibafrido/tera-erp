/**
 * Tes prasyarat laporan arus kas.
 *
 * Laporannya sendiri BELUM dibangun. Yang diuji di sini adalah tiga hal
 * yang tanpanya laporan itu hanya bisa ditebak-tebak:
 *
 *   - akun kas dikenali dari KOLOM, bukan dari namanya;
 *   - golongan arus kas dibaca dari akun LAWAN di jurnal yang sama,
 *     bukan dari akun kasnya;
 *   - kas KELUAR benar-benar ada, lewat pembayaran ke pemasok.
 *
 * Ditambah PPN Masukan, yang selama ini tidak pernah terisi.
 *
 * Jalankan: npm run test:arus-kas
 */
process.env.TERA_SKRIP = "1";

import { Client } from "pg";
import { loadEnv } from "./env";
import { start } from "./pgctl";
import { applyMigrations, applySeed } from "./schema";

const env = loadEnv();
const TEMP_DB = "tera_kas_" + Date.now();

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

async function tolak(label: string, fn: () => Promise<unknown>, cocok: RegExp) {
  try {
    await fn();
    ok(label, false, "berhasil, seharusnya ditolak");
  } catch (e) {
    const pesan = e instanceof Error ? e.message : String(e);
    ok(label, cocok.test(pesan), "pesan: " + pesan.replace(/\s+/g, " ").slice(0, 140));
  }
}

function urlFor(d: string) {
  const u = new URL(env.url);
  u.pathname = "/" + d;
  return u.toString();
}

const q = (i: string) => '"' + i.replace(/"/g, '""') + '"';

async function tes(c: Client) {
  const {
    postGoodsReceipt,
    postSalesInvoice,
    postPurchaseInvoice,
    postPaymentReceipt,
    postSupplierPayment,
    batalkanDokumen,
  } = await import("../lib/posting");
  const { neraca } = await import("../lib/laporan-keuangan");

  const satu = async (sql: string, p: unknown[] = []) =>
    (await c.query(sql, p as never[])).rows[0];

  const hariIni = (await satu(`SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS d`)).d;
  const wh = (await satu(`SELECT id FROM warehouse WHERE code='WH-PST'`)).id;
  const supPkp = await satu(`SELECT id, is_pkp FROM partner WHERE code='SUP-001'`);
  const supNonPkp = await satu(`SELECT id, is_pkp FROM partner WHERE code='SUP-002'`);
  const cus = (await satu(`SELECT id FROM partner WHERE code='CUS-001'`)).id;
  const pengawas = await satu(
    `SELECT id, email FROM app_user WHERE email='pengawas@tera.local'`
  );

  const prod = (
    await satu(
      `INSERT INTO product (sku,name,base_uom_id,is_batch_tracked)
       VALUES ('KAS-001','Barang uji arus kas',
               (SELECT id FROM uom WHERE code='PCS'), false) RETURNING id`
    )
  ).id;

  const saldo = async (kode: string) =>
    (
      await satu(
        `SELECT COALESCE(SUM(l.debit - l.credit),0)::text AS x
           FROM journal_line l
           JOIN journal_entry e ON e.id=l.entry_id AND e.is_posted
           JOIN account a ON a.id=l.account_id WHERE a.code=$1`,
        [kode]
      )
    ).x;

  async function terima(pemasok: string, qty: number, biaya: number) {
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
    await postGoodsReceipt(id);
    return { id, line };
  }

  async function fakturBeli(
    pemasok: string,
    baris: [string, number, number][],
    opts: { ref?: string; tarif?: number } = {}
  ) {
    const id = (
      await satu(
        `INSERT INTO purchase_invoice
           (doc_date, supplier_id, supplier_ref, tax_rate)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [hariIni, pemasok, opts.ref ?? null, opts.tarif ?? 0]
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
    const r = await postPurchaseInvoice(id);
    return { id, ...r };
  }

  async function bayarPemasok(
    pemasok: string,
    jumlah: number,
    alokasi: [string, number][]
  ) {
    const id = (
      await satu(
        `INSERT INTO supplier_payment (doc_date, supplier_id, amount, method)
         VALUES ($1,$2,$3,'TRANSFER') RETURNING id`,
        [hariIni, pemasok, jumlah]
      )
    ).id;
    for (const [inv, amt] of alokasi) {
      await c.query(
        `INSERT INTO supplier_payment_allocation (payment_id, invoice_id, amount)
         VALUES ($1,$2,$3)`,
        [id, inv, amt]
      );
    }
    return id;
  }

  // ================================================================
  console.log("\n--- 1. Penanda akun kas ---");
  // ================================================================

  const kas = await c.query(
    `SELECT code, name FROM account WHERE is_cash_equivalent ORDER BY code`
  );
  eq("tepat satu akun bertanda kas", kas.rows.length, 1);
  ok("akun kasnya 1-1100", kas.rows[0]?.code === "1-1100", String(kas.rows[0]?.code));

  /*
   * Rekening bank kedua: inilah yang membuat pencocokan nama gagal.
   * Namanya tidak memuat kata "Kas" sama sekali, tetapi ia tetap
   * terbaca sebagai kas karena kolomnya yang menentukan.
   */
  await c.query(
    `INSERT INTO account (code, name, type, is_cash_equivalent)
     VALUES ('1-1110', 'BCA Operasional 123456', 'ASSET', true)`
  );
  const kas2 = await c.query(`SELECT code FROM account WHERE is_cash_equivalent`);
  eq("rekening kedua ikut terbaca sebagai kas", kas2.rows.length, 2);
  ok(
    "namanya tidak memuat kata 'Kas' sama sekali",
    !/kas/i.test("BCA Operasional 123456")
  );

  // ================================================================
  console.log("\n--- 2. Klasifikasi ada di akun lawan ---");
  // ================================================================

  const tanpaKategori = await c.query(
    `SELECT code, name FROM account
      WHERE is_postable AND NOT is_cash_equivalent AND kategori_arus_kas IS NULL`
  );
  eq(
    "tidak ada akun postable non-kas tanpa kategori",
    tanpaKategori.rows.length,
    0
  );
  if (tanpaKategori.rows.length) {
    console.log("    " + tanpaKategori.rows.map((r) => r.code).join(", "));
  }

  const kasBerkategori = await c.query(
    `SELECT code FROM account WHERE is_cash_equivalent AND kategori_arus_kas IS NOT NULL`
  );
  eq("akun kas TIDAK punya kategori sendiri", kasBerkategori.rows.length, 0);

  await tolak(
    "akun postable non-kas tanpa kategori ditolak database",
    async () =>
      c.query(
        `INSERT INTO account (code, name, type) VALUES ('6-9999','Beban Lupa','EXPENSE')`
      ),
    /chk_kategori_arus_kas|violates check constraint/
  );

  await tolak(
    "akun kas yang diberi kategori ditolak database",
    async () =>
      c.query(
        `INSERT INTO account (code, name, type, is_cash_equivalent, kategori_arus_kas)
         VALUES ('1-1120','Kas Kecil','ASSET',true,'OPERASI')`
      ),
    /chk_kas_tanpa_kategori|violates check constraint/
  );

  ok(
    "akun header boleh tanpa kategori (tidak pernah dijurnal)",
    Boolean(
      await satu(
        `INSERT INTO account (code, name, type, is_postable)
         VALUES ('1-0000','Aset (header)','ASSET',false) RETURNING code`
      )
    )
  );

  const golongan = await c.query(
    `SELECT kategori_arus_kas::text AS k, COUNT(*)::int AS n
       FROM account WHERE kategori_arus_kas IS NOT NULL
      GROUP BY 1 ORDER BY 1`
  );
  console.log(
    "    " + golongan.rows.map((r) => `${r.k}=${r.n}`).join(", ")
  );
  ok(
    "OPERASI dan PENDANAAN sama-sama terisi",
    golongan.rows.some((r) => r.k === "OPERASI") &&
      golongan.rows.some((r) => r.k === "PENDANAAN")
  );
  ok(
    "INVESTASI memang masih kosong (akun aset tetap belum ada)",
    !golongan.rows.some((r) => r.k === "INVESTASI")
  );

  // ================================================================
  console.log("\n--- 3. PPN Masukan pada faktur pembelian ---");
  // ================================================================

  const gPkp = await terima(supPkp.id, 100, 10_000);
  const fPkp = await fakturBeli(supPkp.id, [[gPkp.line, 100, 10_000]], {
    ref: "FB-PKP-1",
    tarif: 0.11,
  });

  eq("nilai faktur sebelum pajak", fPkp.subtotal, 1_000_000);
  eq("PPN Masukan 11%", fPkp.ppn, 110_000);
  eq("total tagihan termasuk PPN", fPkp.total, 1_110_000);
  eq("akun PPN Masukan 1-1400 terisi", await saldo("1-1400"), 110_000);
  eq("Utang Usaha sebesar TOTAL, bukan subtotal", await saldo("2-1100"), -1_110_000);
  eq("GRNI dilepas pada nilai penerimaan, tanpa PPN", fPkp.grni, 1_000_000);

  const gNon = await terima(supNonPkp.id, 50, 4_000);
  const fNon = await fakturBeli(supNonPkp.id, [[gNon.line, 50, 4_000]], {
    ref: "FB-NON-1",
  });
  nol("pemasok non-PKP tidak menghasilkan PPN", fNon.ppn);
  eq("totalnya sama dengan subtotalnya", fNon.total, fNon.subtotal);

  const barisPpn = await satu(
    `SELECT COUNT(*)::int AS n
       FROM journal_entry e JOIN journal_line l ON l.entry_id=e.id
       JOIN account a ON a.id=l.account_id
      WHERE e.source_id=$1 AND a.code='1-1400'`,
    [fNon.id]
  );
  eq("tidak ada baris PPN sama sekali untuk non-PKP", barisPpn.n, 0);

  // PPN atas faktur yang harganya berbeda dari penerimaan.
  const gBeda = await terima(supPkp.id, 10, 5_000);
  const fBeda = await fakturBeli(supPkp.id, [[gBeda.line, 10, 6_000]], {
    ref: "FB-PKP-2",
    tarif: 0.11,
  });
  eq("PPN dihitung dari nilai FAKTUR, bukan nilai penerimaan", fBeda.ppn, 6_600);
  eq("selisih harga tetap masuk akunnya sendiri", fBeda.selisihHarga, 10_000);
  eq("GRNI dilepas pada harga penerimaan", fBeda.grni, 50_000);

  // ================================================================
  console.log("\n--- 4. Pembayaran ke pemasok ---");
  // ================================================================

  const utangAwal = await saldo("2-1100");
  const kasAwal = await saldo("1-1100");

  const p1 = await bayarPemasok(supPkp.id, 1_110_000, [[fPkp.id, 1_110_000]]);
  const r1 = await postSupplierPayment(p1);

  ok("nomor dokumen berpola PAYS", /^PAYS\/\d{4}\/\d{2}\/\d{4}$/.test(r1.docNo), r1.docNo);
  eq("utang berkurang sebesar pembayaran",
     await saldo("2-1100"), Number(utangAwal) + 1_110_000);
  eq("kas berkurang sebesar pembayaran",
     await saldo("1-1100"), Number(kasAwal) - 1_110_000);
  nol("tidak ada uang muka", r1.uangMuka);

  const sisa1 = await satu(
    `SELECT sisa FROM v_purchase_outstanding WHERE invoice_id=$1`, [fPkp.id]
  );
  nol("faktur lunas", sisa1.sisa);

  const jKas = await satu(
    `SELECT a.code, l.credit, l.partner_id
       FROM journal_entry e JOIN journal_line l ON l.entry_id=e.id
       JOIN account a ON a.id=l.account_id
      WHERE e.source_type='SUPPLIER_PAYMENT' AND e.source_id=$1 AND l.credit > 0`,
    [p1]
  );
  ok("kas dikredit", jKas.code === "1-1100", String(jKas.code));

  const jAp = await satu(
    `SELECT a.code, l.debit, l.partner_id
       FROM journal_entry e JOIN journal_line l ON l.entry_id=e.id
       JOIN account a ON a.id=l.account_id
      WHERE e.source_id=$1 AND l.debit > 0`,
    [p1]
  );
  ok("utang usaha didebit", jAp.code === "2-1100", String(jAp.code));
  ok("partner_id terisi di baris utang", jAp.partner_id === supPkp.id);

  // --- Cicilan ---
  const gCicil = await terima(supNonPkp.id, 100, 3_000);
  const fCicil = await fakturBeli(supNonPkp.id, [[gCicil.line, 100, 3_000]], {
    ref: "FB-CICIL",
  });
  await postSupplierPayment(await bayarPemasok(supNonPkp.id, 100_000, [[fCicil.id, 100_000]]));
  const sisaCicil = await satu(
    `SELECT sisa FROM v_purchase_outstanding WHERE invoice_id=$1`, [fCicil.id]
  );
  eq("sisa setelah cicilan pertama", sisaCicil.sisa, 200_000);

  await tolak(
    "alokasi melebihi sisa ditolak saat posting",
    async () =>
      postSupplierPayment(await bayarPemasok(supNonPkp.id, 300_000, [[fCicil.id, 250_000]])),
    /melebihi sisa utangnya/
  );

  await tolak(
    "alokasi melebihi uang yang dibayarkan ditolak",
    async () =>
      postSupplierPayment(await bayarPemasok(supNonPkp.id, 10_000, [[fCicil.id, 50_000]])),
    /melebihi uang yang dibayarkan/
  );

  await tolak(
    "faktur milik pemasok lain ditolak",
    async () =>
      postSupplierPayment(await bayarPemasok(supPkp.id, 10_000, [[fCicil.id, 10_000]])),
    /milik pemasok lain/
  );

  // --- Uang muka ---
  const p3 = await bayarPemasok(supPkp.id, 500_000, []);
  const r3 = await postSupplierPayment(p3);
  eq("pembayaran tanpa faktur seluruhnya jadi uang muka", r3.uangMuka, 500_000);

  const muka = await satu(
    `SELECT a.code, a.type, l.debit
       FROM journal_entry e JOIN journal_line l ON l.entry_id=e.id
       JOIN account a ON a.id=l.account_id
      WHERE e.source_id=$1 AND a.code='1-1500'`,
    [p3]
  );
  ok("uang muka masuk akun 1-1500", Boolean(muka));
  ok(
    "uang muka berjenis ASSET, bukan EXPENSE",
    muka?.type === "ASSET",
    `type ${muka?.type}`
  );
  eq("nilainya benar", muka?.debit, 500_000);

  const keBeban = await satu(
    `SELECT COALESCE(SUM(l.debit),0) AS x
       FROM journal_entry e JOIN journal_line l ON l.entry_id=e.id
       JOIN account a ON a.id=l.account_id
      WHERE e.source_type='SUPPLIER_PAYMENT' AND a.type='EXPENSE'`
  );
  nol("tidak sepeser pun masuk beban", keBeban.x);

  // --- Dua pembayaran bersamaan ke faktur yang sama ---
  const gRace = await terima(supNonPkp.id, 100, 2_000);
  const fRace = await fakturBeli(supNonPkp.id, [[gRace.line, 100, 2_000]], {
    ref: "FB-RACE",
  });
  const pa = await bayarPemasok(supNonPkp.id, 150_000, [[fRace.id, 150_000]]);
  const pb = await bayarPemasok(supNonPkp.id, 150_000, [[fRace.id, 150_000]]);

  const hasil = await Promise.allSettled([
    postSupplierPayment(pa),
    postSupplierPayment(pb),
  ]);
  eq("tepat satu pembayaran berhasil",
     hasil.filter((h) => h.status === "fulfilled").length, 1);
  const ditolak = hasil.find((h) => h.status === "rejected") as
    | PromiseRejectedResult
    | undefined;
  ok(
    "yang gagal ditolak karena melebihi sisa, bukan galat lain",
    /melebihi sisa utangnya/.test(String(ditolak?.reason)),
    String(ditolak?.reason).slice(0, 120)
  );
  const sisaRace = await satu(
    `SELECT sisa FROM v_purchase_outstanding WHERE invoice_id=$1`, [fRace.id]
  );
  eq("faktur terbayar 150.000, bukan 300.000", sisaRace.sisa, 50_000);

  // --- Lapisan kedua di database ---
  await tolak(
    "alokasi berlebih ditolak trigger meski melewati lib/posting",
    async () => {
      const id = (
        await satu(
          `INSERT INTO supplier_payment (doc_date, supplier_id, amount)
           VALUES ($1,$2,999999) RETURNING id`,
          [hariIni, supNonPkp.id]
        )
      ).id;
      await c.query(
        `INSERT INTO supplier_payment_allocation (payment_id, invoice_id, amount)
         VALUES ($1,$2,999999)`,
        [id, fRace.id]
      );
      await c.query(`UPDATE supplier_payment SET status='POSTED' WHERE id=$1`, [id]);
    },
    /melebihi nilainya/
  );

  // ================================================================
  console.log("\n--- 5. Mutasi kas terklasifikasi dari akun lawan ---");
  // ================================================================

  // Penerimaan pembayaran pelanggan supaya ada kas MASUK juga.
  const gJual = await terima(supNonPkp.id, 100, 6_000);
  const inv = (
    await satu(
      `INSERT INTO sales_invoice (doc_date,customer_id,warehouse_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [hariIni, cus, wh]
    )
  ).id;
  await c.query(
    `INSERT INTO sales_invoice_line (invoice_id,line_no,product_id,qty,unit_price)
     VALUES ($1,1,$2,50,12000)`,
    [inv, prod]
  );
  const rInv = await postSalesInvoice(inv);

  const pTerima = (
    await satu(
      `INSERT INTO payment_receipt (doc_date, customer_id, amount, method)
       VALUES ($1,$2,$3,'TRANSFER') RETURNING id`,
      [hariIni, cus, rInv.total]
    )
  ).id;
  await c.query(
    `INSERT INTO payment_allocation (payment_id, invoice_id, amount)
     VALUES ($1,$2,$3)`,
    [pTerima, inv, rInv.total]
  );
  await postPaymentReceipt(pTerima);

  const mutasi = await c.query(
    `SELECT source_type, kategori_arus_kas::text AS kategori,
            SUM(arus)::text AS arus
       FROM v_mutasi_kas
      GROUP BY source_type, kategori_arus_kas
      ORDER BY source_type`
  );
  console.log(
    "    " +
      mutasi.rows
        .map((r) => `${r.source_type}/${r.kategori}: ${r.arus}`)
        .join("  |  ")
  );

  ok(
    "setiap mutasi kas punya golongan",
    mutasi.rows.every((r) => r.kategori !== null),
    mutasi.rows.filter((r) => r.kategori === null).map((r) => r.source_type).join(", ")
  );
  ok(
    "penerimaan pelanggan tergolong OPERASI",
    mutasi.rows.some(
      (r) => r.source_type === "PAYMENT_RECEIPT" && r.kategori === "OPERASI"
    )
  );
  ok(
    "pembayaran pemasok tergolong OPERASI",
    mutasi.rows.some(
      (r) => r.source_type === "SUPPLIER_PAYMENT" && r.kategori === "OPERASI"
    )
  );

  const arahKas = await satu(
    `SELECT SUM(arus) FILTER (WHERE arus > 0)::text AS masuk,
            SUM(arus) FILTER (WHERE arus < 0)::text AS keluar
       FROM v_mutasi_kas`
  );
  ok("ada kas MASUK", Number(arahKas.masuk) > 0, String(arahKas.masuk));
  ok(
    "ada kas KELUAR — inilah yang hilang sebelum pembayaran pemasok ada",
    Number(arahKas.keluar) < 0,
    String(arahKas.keluar)
  );

  const totalMutasi = await satu(`SELECT COALESCE(SUM(arus),0)::text AS x FROM v_mutasi_kas`);
  eq(
    "jumlah seluruh mutasi kas == saldo akun kas di buku besar",
    totalMutasi.x,
    await saldo("1-1100")
  );

  // ================================================================
  console.log("\n--- 6. Pembatalan pembayaran pemasok ---");
  // ================================================================

  const utangSebelum = await saldo("2-1100");
  const b = await batalkanDokumen({
    jenis: "SUPPLIER_PAYMENT",
    dokumenId: p1,
    tanggalPembalik: hariIni,
    alasan: "transfer gagal di bank, dana kembali",
    penggunaId: pengawas.id,
  });
  ok("pembayaran pemasok bisa dibatalkan", /^JVR\//.test(b.jurnalPembalik), b.jurnalPembalik);
  eq("utang kembali seperti semula",
     await saldo("2-1100"), Number(utangSebelum) - 1_110_000);

  const sisaSetelah = await satu(
    `SELECT sisa FROM v_purchase_outstanding WHERE invoice_id=$1`, [fPkp.id]
  );
  eq("faktur kembali terbuka setelah pembayarannya dibatalkan",
     sisaSetelah.sisa, 1_110_000);

  /*
   * Jurnal MEWARISI pembuat dokumennya, bukan jatuh ke akun sistem
   * karena source_type-nya tidak dikenali trigger.
   *
   * Dibandingkan langsung dengan created_by dokumennya, bukan dengan
   * satu email tertentu: di skrip ini dokumennya memang dibuat akun
   * sistem, sehingga membandingkan dengan "sistem@tera.local" akan
   * lolos bahkan kalau pewarisannya rusak total.
   */
  const jurnalDibuat = await satu(
    `SELECT e.created_by AS jurnal, p.created_by AS dokumen
       FROM journal_entry e
       JOIN supplier_payment p ON p.id = e.source_id
      WHERE e.source_type='SUPPLIER_PAYMENT' AND e.reverses_entry_id IS NULL
      ORDER BY e.created_at LIMIT 1`
  );
  ok(
    "jurnal pembayaran pemasok mewarisi pembuat dokumennya",
    Boolean(jurnalDibuat) && jurnalDibuat.jurnal === jurnalDibuat.dokumen,
    `jurnal ${jurnalDibuat?.jurnal} vs dokumen ${jurnalDibuat?.dokumen}`
  );

  // ================================================================
  console.log("\n--- 7. Buku besar tetap konsisten ---");
  // ================================================================

  const seimbang = await satu(`
    SELECT (COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0))::text AS selisih
      FROM journal_line l JOIN journal_entry e ON e.id=l.entry_id AND e.is_posted
  `);
  nol("debit == kredit di seluruh jurnal", seimbang.selisih);

  const n = await neraca(hariIni, hariIni);
  ok("neraca seimbang tepat nol", n.seimbang === true, `selisih ${n.selisih}`);

  const utangBB = await saldo("2-1100");
  const utangDok = await satu(
    `SELECT COALESCE(SUM(sisa),0)::text AS x FROM v_purchase_outstanding`
  );
  eq(
    "saldo Utang Usaha == jumlah sisa utang menurut faktur",
    Number(utangBB) * -1,
    utangDok.x
  );

  const negatif = await satu(
    `SELECT COUNT(*)::int AS n FROM v_purchase_outstanding WHERE sisa < 0`
  );
  eq("tidak ada faktur bersisa negatif", negatif.n, 0);
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
