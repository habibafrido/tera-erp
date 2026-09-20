/**
 * Tes pembalikan dokumen dan tutup buku periode.
 *
 * Yang paling menentukan di sini adalah bagian 4: posting ke periode
 * tertutup diuji dengan INSERT LANGSUNG ke tabel, bukan lewat aplikasi.
 * Pemeriksaan di lapisan aplikasi bisa dilewati skrip, psql, dan jalur
 * kode kedua yang lupa memanggilnya — kalau triggernya tidak ada, tes
 * yang memanggil aplikasi akan tetap hijau dan tidak membuktikan apa pun.
 *
 * Jalankan: npm run test:tutup-buku
 */
process.env.TERA_SKRIP = "1";

import { Client } from "pg";
import { loadEnv } from "./env";
import { start } from "./pgctl";
import { applyMigrations, applySeed } from "./schema";

const env = loadEnv();
const TEMP_DB = "tera_tutup_" + Date.now();

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
    ok(label, cocok.test(pesan), "pesan: " + pesan.replace(/\s+/g, " ").slice(0, 150));
  }
}

function urlFor(d: string) {
  const u = new URL(env.url);
  u.pathname = "/" + d;
  return u.toString();
}

const q = (i: string) => '"' + i.replace(/"/g, '""') + '"';

async function tes(c: Client) {
  const { postGoodsReceipt, postSalesInvoice, batalkanDokumen } = await import(
    "../lib/posting"
  );
  const { periksaPenutupan, tutupPeriode, bukaKembaliPeriode, statusPeriode } =
    await import("../lib/tutup-buku");
  const { neraca } = await import("../lib/laporan-keuangan");

  const satu = async (sql: string, p: unknown[] = []) =>
    (await c.query(sql, p as never[])).rows[0];

  const t = await satu(`
    SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD')                         AS hari_ini,
           EXTRACT(YEAR FROM CURRENT_DATE)::int                        AS tahun_ini,
           EXTRACT(MONTH FROM CURRENT_DATE)::int                       AS bulan_ini,
           to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '2 months',
                   'YYYY-MM-DD')                                       AS awal_lalu,
           EXTRACT(YEAR FROM date_trunc('month', CURRENT_DATE)
                             - INTERVAL '2 months')::int               AS tahun_lalu,
           EXTRACT(MONTH FROM date_trunc('month', CURRENT_DATE)
                              - INTERVAL '2 months')::int              AS bulan_lalu,
           to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '1 month',
                   'YYYY-MM-DD')                                       AS awal_antara,
           EXTRACT(YEAR FROM date_trunc('month', CURRENT_DATE)
                             - INTERVAL '1 month')::int                AS tahun_antara,
           EXTRACT(MONTH FROM date_trunc('month', CURRENT_DATE)
                              - INTERVAL '1 month')::int               AS bulan_antara
  `);

  const wh = (await satu(`SELECT id FROM warehouse WHERE code='WH-PST'`)).id;
  const sup = (await satu(`SELECT id FROM partner WHERE code='SUP-001'`)).id;
  const cus = (await satu(`SELECT id FROM partner WHERE code='CUS-001'`)).id;
  const pengawas = (
    await satu(`SELECT id, email FROM app_user WHERE email='pengawas@tera.local'`)
  );
  const keuangan = (
    await satu(`SELECT id, email FROM app_user WHERE email='keuangan@tera.local'`)
  );

  const prod = (
    await satu(
      `INSERT INTO product (sku,name,base_uom_id,is_batch_tracked)
       VALUES ('TUTUP-001','Barang uji tutup buku',
               (SELECT id FROM uom WHERE code='PCS'), false) RETURNING id`
    )
  ).id;

  async function terima(tanggal: string, qty: number, biaya: number) {
    const id = (
      await satu(
        `INSERT INTO goods_receipt (doc_date,supplier_id,warehouse_id)
         VALUES ($1,$2,$3) RETURNING id`,
        [tanggal, sup, wh]
      )
    ).id;
    await c.query(
      `INSERT INTO goods_receipt_line (receipt_id,line_no,product_id,qty,unit_cost)
       VALUES ($1,1,$2,$3,$4)`,
      [id, prod, qty, biaya]
    );
    const r = await postGoodsReceipt(id);
    return { id, docNo: r.docNo as string };
  }

  async function jual(tanggal: string, qty: number, harga: number) {
    const id = (
      await satu(
        `INSERT INTO sales_invoice (doc_date,customer_id,warehouse_id)
         VALUES ($1,$2,$3) RETURNING id`,
        [tanggal, cus, wh]
      )
    ).id;
    await c.query(
      `INSERT INTO sales_invoice_line (invoice_id,line_no,product_id,qty,unit_price)
       VALUES ($1,1,$2,$3,$4)`,
      [id, prod, qty, harga]
    );
    const r = await postSalesInvoice(id);
    return { id, docNo: r.docNo as string, total: r.total as string };
  }

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

  // ================================================================
  console.log("\n--- 1. Pembalikan dokumen ---");
  // ================================================================

  const g1 = await terima(t.awal_lalu, 100, 10_000);
  eq("persediaan bertambah saat terima", await saldo("1-1300"), 1_000_000);

  const b1 = await batalkanDokumen({
    jenis: "GOODS_RECEIPT",
    dokumenId: g1.id,
    tanggalPembalik: t.hari_ini,
    alasan: "salah gudang, barang dikembalikan",
    penggunaId: pengawas.id,
  });

  ok("nomor jurnal pembalik berpola JVR", /^JVR\//.test(b1.jurnalPembalik), b1.jurnalPembalik);
  eq("persediaan kembali nol", await saldo("1-1300"), 0);
  eq("GRNI kembali nol", await saldo("2-1300"), 0);

  const st = await satu(`SELECT status, cancelled_at IS NOT NULL AS ada FROM goods_receipt WHERE id=$1`, [g1.id]);
  ok("dokumen bertanda CANCELLED", st.status === "CANCELLED", st.status);
  ok("waktu pembatalan tercatat", st.ada === true);

  const jv = await satu(
    `SELECT b.entry_no, to_char(b.entry_date,'YYYY-MM-DD') AS tgl,
            b.reversal_reason, a.entry_no AS asal
       FROM journal_entry b JOIN journal_entry a ON a.id=b.reverses_entry_id
      WHERE b.source_id=$1`,
    [g1.id]
  );
  ok("jurnal pembalik menunjuk jurnal asalnya", Boolean(jv?.asal), String(jv?.asal));
  ok("tanggal pembalik = tanggal yang diminta, BUKAN tanggal dokumen",
     jv.tgl === t.hari_ini, `${jv.tgl} vs ${t.hari_ini}`);
  ok("alasan tersimpan", String(jv.reversal_reason).includes("salah gudang"));

  const ledger = await satu(
    `SELECT COUNT(*) FILTER (WHERE movement_type::text LIKE 'REVERSAL%')::int AS balik,
            COALESCE(SUM(qty),0)::text AS sisa
       FROM stock_ledger WHERE source_id=$1`,
    [g1.id]
  );
  ok("baris pembalik ditandai REVERSAL_*", Number(ledger.balik) > 0, `${ledger.balik} baris`);
  nol("kuantitas bersih kembali nol", ledger.sisa);

  const ledgerAda = await satu(
    `SELECT COUNT(*)::int AS n FROM stock_ledger WHERE source_id=$1`, [g1.id]
  );
  ok("baris asli TIDAK dihapus", Number(ledgerAda.n) >= 2, `${ledgerAda.n} baris`);

  await tolak(
    "pembatalan ganda ditolak",
    async () =>
      batalkanDokumen({
        jenis: "GOODS_RECEIPT", dokumenId: g1.id, tanggalPembalik: t.hari_ini,
        alasan: "coba dua kali", penggunaId: pengawas.id,
      }),
    /sudah dibatalkan/
  );

  await tolak(
    "alasan terlalu pendek ditolak",
    async () => {
      const g = await terima(t.hari_ini, 1, 1000);
      return batalkanDokumen({
        jenis: "GOODS_RECEIPT", dokumenId: g.id, tanggalPembalik: t.hari_ini,
        alasan: "x", penggunaId: pengawas.id,
      });
    },
    /Alasan pembatalan wajib/
  );

  // Pembalikan penerimaan atas barang yang sudah terjual habis: ditolak.
  const g2 = await terima(t.awal_lalu, 50, 5_000);
  const sLama = await jual(t.awal_lalu, 50, 9_000);
  await tolak(
    "pembalikan yang membuat stok negatif ditolak",
    async () =>
      batalkanDokumen({
        jenis: "GOODS_RECEIPT", dokumenId: g2.id, tanggalPembalik: t.hari_ini,
        alasan: "barang sudah terjual habis", penggunaId: pengawas.id,
      }),
    /stok menjadi negatif/
  );

  await tolak(
    "tanggal pembalik mendahului dokumen ditolak",
    async () => {
      const g = await terima(t.hari_ini, 1, 1000);
      return batalkanDokumen({
        jenis: "GOODS_RECEIPT", dokumenId: g.id, tanggalPembalik: t.awal_lalu,
        alasan: "tanggal mundur seharusnya ditolak", penggunaId: pengawas.id,
      });
    },
    /lebih awal dari dokumen aslinya/
  );

  const nSetelah = await neraca(t.hari_ini, t.hari_ini);
  ok("neraca tetap seimbang setelah pembalikan", nSetelah.seimbang === true,
     `selisih ${nSetelah.selisih}`);

  // ================================================================
  console.log("\n--- 2. Syarat sebelum menutup ---");
  // ================================================================

  // Dokumen draf di periode lama.
  const draf = (
    await satu(
      `INSERT INTO goods_receipt (doc_date,supplier_id,warehouse_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [t.awal_lalu, sup, wh]
    )
  ).id;

  let masalah = await periksaPenutupan(t.tahun_lalu, t.bulan_lalu);
  const kode = masalah.map((m) => m.kode);
  console.log("    masalah: " + (kode.join(", ") || "(tidak ada)"));
  ok("dokumen draf terdeteksi", kode.includes("dokumen_draf"));
  ok("setiap masalah membawa tindakan, bukan sekadar keluhan",
     masalah.every((m) => m.tindakan.length > 20));
  ok("masalah membawa rincian yang bisa ditindaklanjuti",
     masalah.some((m) => m.rincian.length > 0));

  const hasilTolak = await tutupPeriode({
    tahun: t.tahun_lalu, bulan: t.bulan_lalu,
    penggunaId: pengawas.id, email: pengawas.email,
  });
  ok("penutupan ditolak selama masih ada masalah", hasilTolak.ditutup === false);
  eq("periode tetap terbuka", await statusPeriode(t.tahun_lalu, t.bulan_lalu) === "TERBUKA" ? 1 : 0, 1);

  await c.query(`DELETE FROM goods_receipt WHERE id=$1`, [draf]);

  // --- Rekonsiliasi persediaan tidak seimbang ---
  /*
   * Jurnal persediaan TANPA pergerakan stok: persis keadaan yang harus
   * menahan penutupan. Ditulis langsung ke tabel karena aplikasi memang
   * tidak punya jalan untuk membuatnya.
   */
  const jTimpang = (
    await satu(
      `INSERT INTO journal_entry (entry_no, entry_date, description, is_posted, created_by)
       VALUES ('UJI/REKON/1', $1::date, 'Persediaan tanpa gerakan stok', false, $2)
       RETURNING id`,
      [t.awal_lalu, pengawas.id]
    )
  ).id;
  await c.query(
    `INSERT INTO journal_line (entry_id, account_id, debit, credit)
     VALUES ($1, (SELECT id FROM account WHERE code='1-1300'), 250000, 0),
            ($1, (SELECT id FROM account WHERE code='3-1100'), 0, 250000)`,
    [jTimpang]
  );
  await c.query(`UPDATE journal_entry SET is_posted=true WHERE id=$1`, [jTimpang]);

  masalah = await periksaPenutupan(t.tahun_lalu, t.bulan_lalu);
  const rekon = masalah.find((m) => m.kode === "rekonsiliasi_persediaan");
  ok("rekonsiliasi persediaan yang timpang terdeteksi", Boolean(rekon),
     masalah.map((m) => m.kode).join(", "));
  ok("rincian rekonsiliasi menyebut kedua angka dan selisihnya",
     (rekon?.rincian.length ?? 0) >= 3, rekon?.rincian.join(" | "));

  const tolakRekon = await tutupPeriode({
    tahun: t.tahun_lalu, bulan: t.bulan_lalu,
    penggunaId: pengawas.id, email: pengawas.email,
  });
  ok("penutupan ditolak saat rekonsiliasi tidak seimbang",
     tolakRekon.ditutup === false &&
       tolakRekon.masalah.some((m) => m.kode === "rekonsiliasi_persediaan"));

  // Dibalik dengan jurnal lawan supaya rekonsiliasi kembali seimbang.
  const jKoreksi = (
    await satu(
      `INSERT INTO journal_entry (entry_no, entry_date, description, is_posted, created_by)
       VALUES ('UJI/REKON/2', $1::date, 'Koreksi rekonsiliasi', false, $2)
       RETURNING id`,
      [t.awal_lalu, pengawas.id]
    )
  ).id;
  await c.query(
    `INSERT INTO journal_line (entry_id, account_id, debit, credit)
     VALUES ($1, (SELECT id FROM account WHERE code='1-1300'), 0, 250000),
            ($1, (SELECT id FROM account WHERE code='3-1100'), 250000, 0)`,
    [jKoreksi]
  );
  await c.query(`UPDATE journal_entry SET is_posted=true WHERE id=$1`, [jKoreksi]);

  masalah = await periksaPenutupan(t.tahun_lalu, t.bulan_lalu);
  ok("rekonsiliasi kembali seimbang setelah dikoreksi",
     !masalah.some((m) => m.kode === "rekonsiliasi_persediaan"),
     masalah.map((m) => m.kode).join(", "));

  // ================================================================
  console.log("\n--- 3. Menutup periode ---");
  // ================================================================

  masalah = await periksaPenutupan(t.tahun_lalu, t.bulan_lalu);
  ok("tidak ada masalah tersisa", masalah.length === 0,
     masalah.map((m) => `${m.kode}: ${m.judul}`).join("; "));

  const tutup = await tutupPeriode({
    tahun: t.tahun_lalu, bulan: t.bulan_lalu,
    penggunaId: pengawas.id, email: pengawas.email,
  });
  ok("periode ditutup", tutup.ditutup === true,
     tutup.masalah.map((m) => m.judul).join("; "));
  eq("status jadi DITUTUP",
     (await statusPeriode(t.tahun_lalu, t.bulan_lalu)) === "DITUTUP" ? 1 : 0, 1);

  const jejak = await satu(
    `SELECT aksi, email FROM accounting_period_log
      WHERE tahun=$1 AND bulan=$2 ORDER BY pada DESC LIMIT 1`,
    [t.tahun_lalu, t.bulan_lalu]
  );
  ok("penutupan tercatat di riwayat", jejak?.aksi === "DITUTUP", String(jejak?.aksi));
  ok("riwayat menyimpan email pelakunya", jejak?.email === pengawas.email);

  // ================================================================
  console.log("\n--- 4. Penegakan di TINGKAT BASIS DATA ---");
  // ================================================================

  /*
   * INSERT langsung ke tabel, melewati lib/posting dan seluruh lapisan
   * aplikasi. Kalau triggernya tidak ada, keempat asersi di bawah akan
   * lolos tanpa suara — dan tes yang memanggil aplikasi tidak akan
   * pernah menunjukkannya.
   */
  await tolak(
    "INSERT journal_entry ke periode tertutup ditolak database",
    async () =>
      c.query(
        `INSERT INTO journal_entry (entry_no, entry_date, description, is_posted, created_by)
         VALUES ('UJI/TEMBUS/1', $1::date, 'menembus periode tertutup', false, $2)`,
        [t.awal_lalu, pengawas.id]
      ),
    /sudah ditutup/
  );

  await tolak(
    "memindahkan tanggal jurnal ke periode tertutup ditolak database",
    async () => {
      const id = (
        await satu(
          `INSERT INTO journal_entry (entry_no, entry_date, description, is_posted, created_by)
           VALUES ('UJI/TEMBUS/2', $1::date, 'pindah tanggal', false, $2) RETURNING id`,
          [t.hari_ini, pengawas.id]
        )
      ).id;
      return c.query(`UPDATE journal_entry SET entry_date=$2::date WHERE id=$1`, [
        id, t.awal_lalu,
      ]);
    },
    /sudah ditutup/
  );

  await tolak(
    "INSERT stock_ledger ke periode tertutup ditolak database",
    async () => {
      const je = (
        await satu(
          `INSERT INTO journal_entry (entry_no, entry_date, description, is_posted, created_by)
           VALUES ('UJI/TEMBUS/3', $1::date, 'pembawa tanggal lama', false, $2) RETURNING id`,
          [t.hari_ini, pengawas.id]
        )
      ).id;
      // Jurnalnya bertanggal hari ini, lalu tanggalnya dipakai lewat
      // baris ledger yang menunjuk jurnal di periode tertutup.
      const jeLama = (
        await satu(
          `SELECT id FROM journal_entry WHERE entry_date < $1::date
             AND is_posted ORDER BY entry_date LIMIT 1`,
          [t.awal_antara]
        )
      ).id;
      return c.query(
        `INSERT INTO stock_ledger
           (product_id, warehouse_id, movement_type, qty, unit_cost,
            running_qty, running_value, posted_at, source_type, source_id,
            journal_entry_id)
         VALUES ($1,$2,'ADJUSTMENT',1,1000,1,1000, now(), 'UJI', $3, $4)`,
        [prod, wh, je, jeLama]
      );
    },
    /sudah ditutup/
  );

  // Posting lewat aplikasi ke periode tertutup juga gagal, lewat trigger
  // yang sama. Pesannya berbeda karena melewati lapisan posting.
  await tolak(
    "posting dokumen lewat aplikasi ke periode tertutup gagal",
    async () => terima(t.awal_lalu, 5, 1000),
    /sudah ditutup|ditutup/
  );

  // Periode yang MASIH TERBUKA tetap menerima posting.
  const gBaru = await terima(t.hari_ini, 10, 2_000);
  ok("posting ke periode terbuka tetap berhasil", Boolean(gBaru.docNo), gBaru.docNo);

  // ================================================================
  console.log("\n--- 5. Koreksi periode tertutup TANPA membukanya ---");
  // ================================================================

  /*
   * Inti dari seluruh rancangan: dokumen di periode TERTUTUP dibalik
   * dengan jurnal bertanggal di periode TERBUKA, dan itu BERHASIL.
   * Kalau ini gagal, satu-satunya cara memperbaiki kesalahan adalah
   * membuka kembali periode — persis yang ingin dihindari.
   */
  /*
   * Yang dibalik adalah FAKTUR PENJUALAN, bukan penerimaan.
   *
   * Pembalikan penjualan memasukkan barang kembali ke gudang, jadi ia
   * tidak pernah membuat stok negatif. Pembalikan penerimaan atas
   * barang yang sudah terjual memang harus ditolak — itu diuji
   * tersendiri di bagian 1, dan bukan yang sedang dibuktikan di sini.
   */
  const dokLama = await satu(
    `SELECT id, doc_no, status,
            to_char(doc_date, 'YYYY-MM-DD') AS tanggal
       FROM sales_invoice WHERE id = $1`,
    [sLama.id]
  );
  ok(
    "ada dokumen di periode tertutup untuk dikoreksi",
    dokLama?.status === "POSTED" && dokLama.tanggal < t.awal_antara,
    `${dokLama?.doc_no} (${dokLama?.tanggal})`
  );

  if (dokLama) {
    const asetSebelum = await saldo("1-1300");
    const balik = await batalkanDokumen({
      jenis: "SALES_INVOICE",
      dokumenId: dokLama.id,
      tanggalPembalik: t.hari_ini,
      alasan: "koreksi setelah periode ditutup, tanpa membuka periodenya",
      penggunaId: pengawas.id,
    });
    ok("pembalikan atas dokumen di periode TERTUTUP berhasil",
       Boolean(balik.jurnalPembalik), balik.jurnalPembalik);
    eq("tanggal pembaliknya di periode terbuka",
       balik.tanggalPembalik === t.hari_ini ? 1 : 0, 1);

    const asetSesudah = await saldo("1-1300");
    ok("saldo persediaan berubah karena koreksinya",
       asetSebelum !== asetSesudah, `${asetSebelum} -> ${asetSesudah}`);

    // Angka periode tertutup TIDAK berubah.
    const akhirLama = (
      await satu(
        `SELECT to_char((date_trunc('month',$1::date) + INTERVAL '1 month - 1 day')::date,
                        'YYYY-MM-DD') AS d`,
        [t.awal_lalu]
      )
    ).d;
    const nLama = await neraca(akhirLama, akhirLama);
    ok("neraca periode tertutup tetap seimbang", nLama.seimbang === true,
       `selisih ${nLama.selisih}`);
  }

  // ================================================================
  console.log("\n--- 6. Membuka kembali ---");
  // ================================================================

  await tolak(
    "alasan terlalu pendek ditolak",
    async () =>
      bukaKembaliPeriode({
        tahun: t.tahun_lalu, bulan: t.bulan_lalu, alasan: "salah",
        penggunaId: pengawas.id, email: pengawas.email,
      }),
    /wajib diisi, minimal sepuluh huruf/
  );

  await bukaKembaliPeriode({
    tahun: t.tahun_lalu, bulan: t.bulan_lalu,
    alasan: "instruksi auditor untuk mengoreksi kurs bank",
    penggunaId: pengawas.id, email: pengawas.email,
  });

  eq("periode kembali TERBUKA",
     (await statusPeriode(t.tahun_lalu, t.bulan_lalu)) === "TERBUKA" ? 1 : 0, 1);

  const pRow = await satu(
    `SELECT jumlah_dibuka_kembali, alasan, dibuka_kembali_oleh
       FROM accounting_period WHERE tahun=$1 AND bulan=$2`,
    [t.tahun_lalu, t.bulan_lalu]
  );
  eq("penghitung pembukaan naik", pRow.jumlah_dibuka_kembali, 1);
  ok("alasan tersimpan di periode", String(pRow.alasan).includes("auditor"));
  ok("pelaku tercatat", pRow.dibuka_kembali_oleh === pengawas.id);

  const logBuka = await satu(
    `SELECT aksi, alasan, email FROM accounting_period_log
      WHERE tahun=$1 AND bulan=$2 AND aksi='DIBUKA_KEMBALI'
      ORDER BY pada DESC LIMIT 1`,
    [t.tahun_lalu, t.bulan_lalu]
  );
  ok("pembukaan kembali tercatat di riwayat", Boolean(logBuka));
  ok("riwayat menyimpan alasannya", String(logBuka?.alasan).includes("auditor"),
     String(logBuka?.alasan));
  ok("riwayat menyimpan email pelakunya", logBuka?.email === pengawas.email);

  ok("posting ke periode yang dibuka kembali berhasil",
     Boolean((await terima(t.awal_lalu, 1, 1000)).docNo));

  // --- Penanda permanen ---
  const masalahLagi = await periksaPenutupan(t.tahun_lalu, t.bulan_lalu);
  if (masalahLagi.length === 0) {
    await tutupPeriode({
      tahun: t.tahun_lalu, bulan: t.bulan_lalu,
      penggunaId: pengawas.id, email: pengawas.email,
    });
  }
  const pRow2 = await satu(
    `SELECT status, jumlah_dibuka_kembali FROM accounting_period
      WHERE tahun=$1 AND bulan=$2`,
    [t.tahun_lalu, t.bulan_lalu]
  );
  eq("penanda 'pernah dibuka kembali' bertahan setelah ditutup lagi",
     pRow2.jumlah_dibuka_kembali, 1);

  const jumlahLog = await satu(
    `SELECT COUNT(*)::int AS n FROM accounting_period_log WHERE tahun=$1 AND bulan=$2`,
    [t.tahun_lalu, t.bulan_lalu]
  );
  ok("riwayat memuat seluruh perjalanannya", Number(jumlahLog.n) >= 2,
     `${jumlahLog.n} baris`);

  // ================================================================
  console.log("\n--- 7. Riwayat periode append-only ---");
  // ================================================================

  const idLog = (await satu(`SELECT id FROM accounting_period_log ORDER BY id DESC LIMIT 1`)).id;
  for (const [label, sql] of [
    ["UPDATE riwayat ditolak", `UPDATE accounting_period_log SET alasan='palsu' WHERE id=${Number(idLog)}`],
    ["DELETE riwayat ditolak", `DELETE FROM accounting_period_log WHERE id=${Number(idLog)}`],
    ["TRUNCATE riwayat ditolak", `TRUNCATE accounting_period_log`],
  ] as [string, string][]) {
    await tolak(label, async () => c.query(sql), /append-only/);
  }

  // ================================================================
  console.log("\n--- 8. Buku besar tetap konsisten ---");
  // ================================================================

  const seimbang = await satu(`
    SELECT (COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0))::text AS selisih
      FROM journal_line l JOIN journal_entry e ON e.id=l.entry_id AND e.is_posted
  `);
  nol("debit == kredit di seluruh jurnal", seimbang.selisih);

  const nAkhir = await neraca(t.hari_ini, t.hari_ini);
  ok("neraca seimbang tepat nol", nAkhir.seimbang === true, `selisih ${nAkhir.selisih}`);

  const dobel = await satu(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT reverses_entry_id FROM journal_entry
        WHERE reverses_entry_id IS NOT NULL
        GROUP BY reverses_entry_id HAVING COUNT(*) > 1) x`
  );
  eq("tidak ada jurnal yang dibalik lebih dari sekali", dobel.n, 0);
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
