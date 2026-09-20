/**
 * Tes laporan keuangan: Neraca dan Laba Rugi.
 *
 * db:verify sudah menguji keseimbangan neraca pada data skenario README,
 * tetapi data itu punya dua keterbatasan yang justru menyembunyikan bug
 * paling mahal di laporan keuangan:
 *
 *   - bagan akunnya DATAR, jadi rollup hierarki tidak pernah benar-benar
 *     dijalankan. Laporan yang diam-diam mengasumsikan dua tingkat akan
 *     lolos di sana dan rusak pada bagan akun sungguhan;
 *   - seluruh jurnalnya jatuh pada SATU hari di SATU tahun buku, jadi
 *     "laba ditahan" selalu nol dan pemisahan periode berjalan vs periode
 *     sebelumnya tidak pernah teruji.
 *
 * Skrip ini membangun database sementaranya sendiri berisi bagan akun
 * empat tingkat yang sengaja tidak seragam kedalamannya, ditambah jurnal
 * yang tersebar di dua tahun buku dan satu akun yang saldonya berlawanan
 * arah dari saldo normalnya.
 *
 * Jalankan: npm run test:laporan
 */
import { Client } from "pg";
import { loadEnv } from "./env";
import { start } from "./pgctl";
import { applyMigrations, applySeed } from "./schema";

const env = loadEnv();
const TEMP_DB = "tera_laporan_" + Date.now();

let gagal = 0;

function ok(label: string, benar: boolean, detail = "") {
  console.log(`${benar ? "✓" : "✗"} ${label}${detail ? "\n    " + detail : ""}`);
  if (!benar) gagal++;
}

function eq(label: string, a: unknown, b: unknown) {
  ok(label, Math.abs(Number(a) - Number(b)) < 0.005, `dapat ${a}, harap ${b}`);
}

/** Pembanding teks. eq() mengubah argumennya jadi angka, dan tanggal
 *  "2026-02-28" menjadi NaN di sana — perbandingannya selalu gagal. */
function eqs(label: string, a: unknown, b: unknown) {
  ok(label, String(a) === String(b), `dapat ${a}, harap ${b}`);
}

/** Tanpa toleransi: untuk angka yang harus TEPAT nol. */
function nol(label: string, selisih: unknown, konteks = "") {
  const s = String(selisih);
  ok(label, /^-?0(\.0+)?$/.test(s), `selisih ${s}${konteks ? " — " + konteks : ""}`);
}

function urlFor(d: string) {
  const u = new URL(env.url);
  u.pathname = "/" + d;
  return u.toString();
}

const q = (i: string) => '"' + i.replace(/"/g, '""') + '"';

/**
 * Bagan akun empat tingkat, SENGAJA tidak seragam.
 *
 * 1-1400 berhenti di tingkat 2 sementara 1-1100 turun sampai tingkat 3,
 * jadi kedua cabang di bawah 1-1 tidak sama dalamnya.
 * Bagan yang rapi dan seragam justru akan membuat kode yang mengasumsikan
 * dua tingkat tetap lolos.
 *
 *   1                     Aset                        (tingkat 0, header)
 *     1-1                 Aset Lancar                 (tingkat 1, header)
 *       1-11              Kas dan Setara Kas          (tingkat 2, header)
 *         1-1100          Kas & Bank                  (tingkat 3, postable)
 *       1-12              Piutang dan Persediaan      (tingkat 2, header)
 *         1-1200          Piutang Usaha               (tingkat 3, postable)
 *         1-1300          Persediaan Barang Dagang    (tingkat 3, postable)
 *       1-1400            PPN Masukan                 (tingkat 2, postable)
 */
const HEADER: [string, string, string, string | null][] = [
  // kode, nama, tipe, kode induk
  ["1", "Aset", "ASSET", null],
  ["1-1", "Aset Lancar", "ASSET", "1"],
  ["1-11", "Kas dan Setara Kas", "ASSET", "1-1"],
  ["1-12", "Piutang dan Persediaan", "ASSET", "1-1"],
  ["2", "Liabilitas", "LIABILITY", null],
  ["2-1", "Liabilitas Lancar", "LIABILITY", "2"],
  ["3", "Ekuitas", "EQUITY", null],
  ["4", "Pendapatan", "REVENUE", null],
  ["5", "Beban", "EXPENSE", null],
  ["5-1", "Beban Pokok", "EXPENSE", "5"],
];

/** kode akun postable -> kode induknya yang baru */
const INDUK: [string, string][] = [
  ["1-1100", "1-11"],
  ["1-1200", "1-12"],
  ["1-1300", "1-12"],
  ["1-1400", "1-1"],
  ["2-1100", "2-1"],
  ["2-1200", "2-1"],
  ["2-1300", "2-1"],
  ["3-1100", "3"],
  ["4-1100", "4"],
  ["5-1100", "5-1"],
  ["5-2100", "5"],
];

async function bangunBaganAkun(c: Client) {
  for (const [kode, nama, tipe, induk] of HEADER) {
    await c.query(
      `INSERT INTO account (code, name, type, parent_id, is_postable)
       VALUES ($1, $2, $3::account_type,
               (SELECT id FROM account WHERE code = $4), false)`,
      [kode, nama, tipe, induk]
    );
  }
  for (const [anak, induk] of INDUK) {
    await c.query(
      `UPDATE account SET parent_id = (SELECT id FROM account WHERE code = $2)
        WHERE code = $1`,
      [anak, induk]
    );
  }
}

/**
 * Satu jurnal seimbang. `baris` berisi [kode akun, debit, kredit].
 *
 * Urutannya mengikuti aturan database, bukan sebaliknya: entri dibuat
 * sebagai DRAF, barisnya disisipkan, lalu entrinya di-post. Trigger
 * block_posted_journal menolak penyisipan baris ke entri yang sudah
 * terposting, dan trigger keseimbangan bersifat DEFERRED sehingga
 * pemeriksaannya baru jalan saat COMMIT.
 */
async function jurnal(
  c: Client,
  no: string,
  tanggalSql: string,
  keterangan: string,
  baris: [string, number, number][]
) {
  await c.query("BEGIN");
  try {
    const { rows } = await c.query(
      `INSERT INTO journal_entry (entry_no, entry_date, description, is_posted)
       VALUES ($1, (${tanggalSql})::date, $2, false) RETURNING id`,
      [no, keterangan]
    );
    const id = rows[0].id as string;
    for (const [kode, d, k] of baris) {
      await c.query(
        `INSERT INTO journal_line (entry_id, account_id, debit, credit)
         VALUES ($1, (SELECT id FROM account WHERE code = $2), $3, $4)`,
        [id, kode, d, k]
      );
    }
    await c.query(`UPDATE journal_entry SET is_posted = true WHERE id = $1`, [id]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

const TAHUN_LALU = "date_trunc('year', CURRENT_DATE) - INTERVAL '1 year'";
const TAHUN_INI = "date_trunc('year', CURRENT_DATE)";

async function isiJurnal(c: Client) {
  // --- Tahun buku sebelumnya: laba 200.000 ---
  await jurnal(c, "UJI/TL/1", `${TAHUN_LALU} + INTERVAL '2 months'`, "Beli persediaan", [
    ["1-1300", 1_000_000, 0],
    ["2-1100", 0, 1_000_000],
  ]);
  await jurnal(c, "UJI/TL/2", `${TAHUN_LALU} + INTERVAL '5 months'`, "Jual barang", [
    ["1-1200", 600_000, 0],
    ["4-1100", 0, 600_000],
    ["5-1100", 400_000, 0],
    ["1-1300", 0, 400_000],
  ]);

  // --- Tahun buku berjalan: laba 150.000 ---
  await jurnal(c, "UJI/TI/1", `${TAHUN_INI} + INTERVAL '1 month'`, "Jual barang", [
    ["1-1200", 300_000, 0],
    ["4-1100", 0, 300_000],
    ["5-1100", 150_000, 0],
    ["1-1300", 0, 150_000],
  ]);

  /*
   * Akun ASET yang sengaja dibuat bersaldo KREDIT.
   *
   * PPN Masukan bersaldo normal debit; di sini ia dikreditkan sehingga
   * saldonya berlawanan arah. Laporan harus MENANDAINYA, bukan
   * menyembunyikannya di balik nilai mutlak — aset bersaldo kredit adalah
   * gejala yang perlu dilihat orang.
   */
  await jurnal(c, "UJI/TI/2", `${TAHUN_INI} + INTERVAL '2 months'`, "PPN terbalik", [
    ["1-1100", 50_000, 0],
    ["1-1400", 0, 50_000],
  ]);
}

// ------------------------------------------------------------------

async function tes(c: Client) {
  const { neraca, labaRugi, geserRentang } = await import("../lib/laporan-keuangan");
  const { cariLaporan, validasiFilter } = await import("../lib/export/reports");

  const satu = async (sql: string, p: unknown[] = []) =>
    (await c.query(sql, p as never[])).rows[0];

  const t = await satu(`
    SELECT to_char(${TAHUN_LALU}, 'YYYY-MM-DD')                        AS awal_lalu,
           to_char(${TAHUN_LALU} + INTERVAL '3 months', 'YYYY-MM-DD')  AS tengah_lalu,
           to_char(${TAHUN_INI} - INTERVAL '1 day', 'YYYY-MM-DD')      AS akhir_lalu,
           to_char(${TAHUN_INI}, 'YYYY-MM-DD')                         AS awal_ini,
           to_char(${TAHUN_INI} + INTERVAL '45 days', 'YYYY-MM-DD')    AS tengah_ini,
           to_char(CURRENT_DATE, 'YYYY-MM-DD')                         AS hari_ini
  `);

  // ================================================================
  console.log("\n--- 1. Hierarki: kedalaman sembarang ---");
  // ================================================================

  const n = await neraca(t.hari_ini, t.akhir_lalu);
  const akun = (kode: string) =>
    [...n.aset, ...n.liabilitas, ...n.ekuitas].find((x) => x.kode === kode);

  eq("akun '1' berada di tingkat 0", akun("1")?.kedalaman, 0);
  eq("akun '1-1' berada di tingkat 1", akun("1-1")?.kedalaman, 1);
  eq("akun '1-11' berada di tingkat 2", akun("1-11")?.kedalaman, 2);
  eq("akun '1-1100' berada di tingkat 3", akun("1-1100")?.kedalaman, 3);
  // Cabang yang tidak seragam: 1-1400 berhenti di tingkat 2, sementara
  // saudaranya lewat 1-11 dan 1-12 turun sampai tingkat 3.
  eq("akun '1-1400' berada di tingkat 2", akun("1-1400")?.kedalaman, 2);

  ok("akun header ditandai punya anak", akun("1-11")?.punyaAnak === true);
  ok("akun postable tidak ditandai punya anak", akun("1-1100")?.punyaAnak === false);
  ok("akun header tidak postable", akun("1-11")?.postable === false);

  // Header tidak pernah dijurnal langsung, jadi saldo sendirinya nol
  // sementara saldo gabungannya tidak.
  eq("saldo sendiri akun header nol", akun("1-11")?.saldoSendiri, 0);
  eq("saldo gabungan '1-11' == saldo anaknya", akun("1-11")?.saldo, akun("1-1100")?.saldo);

  /*
   * Yang paling penting: KAKEK harus memuat CUCU. Kode yang mengasumsikan
   * dua tingkat akan lolos semua asersi di atas dan gagal tepat di sini.
   */
  const jumlahCucu =
    (akun("1-1200")?.saldo ?? 0) + (akun("1-1300")?.saldo ?? 0);
  eq("'1-12' == jumlah kedua anaknya", akun("1-12")?.saldo, jumlahCucu);
  eq(
    "'1-1' == 1-11 + 1-12 + 1-1400 (tiga cabang, dua kedalaman berbeda)",
    akun("1-1")?.saldo,
    (akun("1-11")?.saldo ?? 0) + (akun("1-12")?.saldo ?? 0) + (akun("1-1400")?.saldo ?? 0)
  );
  eq("akar '1' == seluruh turunannya", akun("1")?.saldo, akun("1-1")?.saldo);
  eq("total aset == saldo akar '1'", n.totalAset, akun("1")?.saldo);

  // ================================================================
  console.log("\n--- 2. Konvensi tanda dan saldo berlawanan ---");
  // ================================================================

  const ppn = akun("1-1400");
  eq("PPN Masukan bersaldo -50.000, bukan 50.000", ppn?.saldo, -50_000);
  ok("saldo berlawanan arah DITANDAI", ppn?.berlawanan === true, `saldo ${ppn?.saldo}`);
  ok(
    "akun yang searah saldo normalnya tidak ditandai",
    akun("1-1200")?.berlawanan === false
  );

  const utang = akun("2-1100");
  eq("LIABILITY positif saat bersaldo kredit", utang?.saldo, 1_000_000);
  ok("liabilitas normal tidak ditandai berlawanan", utang?.berlawanan === false);

  const lrIni = await labaRugi(t.awal_ini, t.hari_ini, t.awal_ini, t.hari_ini);
  eq("REVENUE positif saat bersaldo kredit", lrIni.totalPendapatan, 300_000);
  eq("EXPENSE positif saat bersaldo debit", lrIni.totalBeban, 150_000);

  // ================================================================
  console.log("\n--- 3. Periode vs kumulatif ---");
  // ================================================================

  // Neraca mengakumulasi: piutang per hari ini mencakup kedua tahun.
  eq("piutang kumulatif per hari ini == 900.000", akun("1-1200")?.saldo, 900_000);
  // Neraca per akhir tahun lalu hanya mencakup tahun lalu.
  eq("piutang per akhir tahun lalu == 600.000", akun("1-1200")?.pembanding, 600_000);

  // Laba Rugi bergerak: rentang tahun ini TIDAK memuat tahun lalu.
  eq("pendapatan tahun ini saja == 300.000", lrIni.totalPendapatan, 300_000);
  const lrLalu = await labaRugi(t.awal_lalu, t.akhir_lalu, t.awal_lalu, t.akhir_lalu);
  eq("pendapatan tahun lalu saja == 600.000", lrLalu.totalPendapatan, 600_000);
  eq("laba tahun lalu == 200.000", lrLalu.laba, 200_000);

  const lrGabung = await labaRugi(t.awal_lalu, t.hari_ini, t.awal_lalu, t.hari_ini);
  eq("rentang dua tahun == jumlah keduanya", lrGabung.laba, 350_000);

  // ================================================================
  console.log("\n--- 4. Laba berjalan dan laba ditahan ---");
  // ================================================================

  eq("laba berjalan per hari ini == laba tahun ini", n.labaBerjalan, 150_000);
  eq("laba ditahan per hari ini == laba tahun lalu", n.labaDitahan, 200_000);
  eq("laba rugi tahun berjalan == laba berjalan di neraca", lrIni.laba, n.labaBerjalan);

  const nAkhirLalu = await neraca(t.akhir_lalu, t.akhir_lalu);
  eq(
    "per akhir tahun lalu, laba tahun itu masuk laba BERJALAN",
    nAkhirLalu.labaBerjalan,
    200_000
  );
  eq("per akhir tahun lalu, laba ditahan masih nol", nAkhirLalu.labaDitahan, 0);

  // ================================================================
  console.log("\n--- 5. Kolom pembanding ---");
  // ================================================================

  const nPembanding = await neraca(t.akhir_lalu, t.akhir_lalu);
  eq(
    "kolom pembanding == laporan pada tanggal pembanding",
    n.bandingTotalAset,
    nPembanding.totalAset
  );
  const piutang = akun("1-1200")!;
  eq("selisih == saldo - pembanding", piutang.selisih, 300_000);
  eq("selisih persen == 50%", piutang.selisihPersen, 50);

  const kas = akun("1-1100")!;
  ok(
    "selisih persen null saat pembanding nol, bukan tak hingga",
    kas.pembanding === 0 && kas.selisihPersen === null,
    `pembanding ${kas.pembanding}, persen ${kas.selisihPersen}`
  );

  const geserBulan = await geserRentang("2026-03-31", "2026-03-31", "bulan");
  eqs(
    "pergeseran bulan menghormati panjang bulan (31 Mar -> 28 Feb)",
    geserBulan.dari,
    "2026-02-28"
  );
  const geserTahun = await geserRentang("2024-02-29", "2024-02-29", "tahun");
  eqs(
    "pergeseran tahun menghormati kabisat (29 Feb 2024 -> 28 Feb 2023)",
    geserTahun.dari,
    "2023-02-28"
  );

  // ================================================================
  console.log("\n--- 6. Keseimbangan pada banyak tanggal (tepat nol) ---");
  // ================================================================

  const tanggalUji: [string, string][] = [
    ["sebelum transaksi pertama", t.awal_lalu],
    ["tengah tahun lalu", t.tengah_lalu],
    ["akhir tahun lalu", t.akhir_lalu],
    ["awal tahun ini", t.awal_ini],
    ["tengah tahun ini", t.tengah_ini],
    ["hari ini", t.hari_ini],
  ];

  for (const [label, tgl] of tanggalUji) {
    const x = await neraca(tgl, tgl);
    nol(
      `neraca seimbang pada ${label} (${tgl})`,
      x.selisih,
      `aset ${x.totalAset}, liabilitas ${x.totalLiabilitas}, ` +
        `ekuitas ${x.totalEkuitas}, ditahan ${x.labaDitahan}, berjalan ${x.labaBerjalan}`
    );
    ok(`flag seimbang benar pada ${tgl}`, x.seimbang === true);
  }

  const jml = await satu(`
    SELECT (COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0))::text AS selisih
      FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
  `);
  nol("total debit seluruh jurnal == total kredit", jml.selisih);

  // ================================================================
  console.log("\n--- 7. SQL ekspor sepakat dengan halaman ---");
  // ================================================================

  const lapNeraca = cariLaporan("neraca")!;
  const fNeraca = validasiFilter(
    lapNeraca,
    new URLSearchParams({ per: t.hari_ini, banding: t.akhir_lalu })
  );
  const kNeraca = lapNeraca.sql(fNeraca);
  const barisNeraca = (await c.query(kNeraca.text, kNeraca.values as never[])).rows;

  const cari = (akunNama: string) =>
    barisNeraca.find((r: Record<string, unknown>) => r.akun === akunNama);

  eq(
    "total aset di ekspor == total aset di halaman",
    cari("Total aset")?.saldo,
    n.totalAset
  );
  eq(
    "laba berjalan di ekspor == laba berjalan di halaman",
    cari("Laba periode berjalan")?.saldo,
    n.labaBerjalan
  );
  eq(
    "laba ditahan di ekspor == laba ditahan di halaman",
    cari("Laba ditahan (belum ditutup ke ekuitas)")?.saldo,
    n.labaDitahan
  );
  const ujiBaris = barisNeraca.find(
    (r: Record<string, unknown>) => r.jenis === "selisih"
  );
  nol("baris uji keseimbangan di ekspor tepat nol", ujiBaris?.saldo);
  nol("baris uji keseimbangan pembanding tepat nol", ujiBaris?.pembanding);

  ok(
    "baris ekspor diberi penanda jenis (termasuk 'header' untuk akun bertingkat)",
    barisNeraca.every((r: Record<string, unknown>) =>
      ["akun", "header", "subtotal", "selisih"].includes(String(r.jenis))
    )
  );
  ok(
    "nama akun di ekspor diindentasi sesuai kedalaman",
    String(cari("            1-1100")?.akun ?? "").length === 0 &&
      barisNeraca.some((r: Record<string, unknown>) =>
        /^ {12}Kas & Bank$/.test(String(r.akun))
      ),
    barisNeraca
      .filter((r: Record<string, unknown>) => r.jenis === "akun")
      .map((r: Record<string, unknown>) => JSON.stringify(r.akun))
      .join(" ")
  );

  const lapLR = cariLaporan("laba_rugi")!;
  const fLR = validasiFilter(
    lapLR,
    new URLSearchParams({ dari: t.awal_ini, sampai: t.hari_ini, banding: "tahun" })
  );
  const kLR = lapLR.sql(fLR);
  const barisLR = (await c.query(kLR.text, kLR.values as never[])).rows;
  const cariLR = (nama: string) =>
    barisLR.find((r: Record<string, unknown>) => r.akun === nama);

  eq("total pendapatan di ekspor", cariLR("Total pendapatan")?.saldo, 300_000);
  eq("total beban di ekspor", cariLR("Total beban")?.saldo, 150_000);
  eq("laba bersih di ekspor", cariLR("Laba bersih")?.saldo, 150_000);
  eq(
    "pembanding tahun lalu di ekspor == laba tahun lalu pada rentang yang sama",
    cariLR("Total pendapatan")?.pembanding,
    600_000
  );

  // ================================================================
  console.log("\n--- 8. Filter ditolak kalau tidak sah ---");
  // ================================================================

  const tolak = (qs: Record<string, string>, alasan: string) => {
    try {
      validasiFilter(lapNeraca, new URLSearchParams(qs));
      ok(alasan, false, "diterima, seharusnya ditolak");
    } catch {
      ok(alasan, true);
    }
  };
  tolak({ per: "2026-13-01" }, "bulan 13 ditolak");
  tolak({ per: "2026-02-30" }, "30 Februari ditolak");
  tolak({ per: "20-09-2026" }, "format DD-MM-YYYY ditolak");
  tolak({ gudang: "WH-PST" }, "filter tak dikenal ditolak");

  // 29 Februari pada tahun kabisat harus DITERIMA.
  try {
    validasiFilter(lapNeraca, new URLSearchParams({ per: "2024-02-29" }));
    ok("29 Februari 2024 (kabisat) diterima", true);
  } catch (e) {
    ok("29 Februari 2024 (kabisat) diterima", false, String(e));
  }

  // ================================================================
  console.log("\n--- 9. Tanggal tidak pernah berupa objek Date ---");
  // ================================================================

  ok(
    "tanggal di hasil neraca berupa teks YYYY-MM-DD",
    typeof n.perTanggal === "string" && /^\d{4}-\d{2}-\d{2}$/.test(n.perTanggal)
  );
  ok(
    "tanggal di hasil laba rugi berupa teks YYYY-MM-DD",
    [lrIni.dari, lrIni.sampai, lrIni.bandingDari, lrIni.bandingSampai].every(
      (x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x)
    )
  );
  const adaDate = barisNeraca.some((r: Record<string, unknown>) =>
    Object.values(r).some((v) => v instanceof Date)
  );
  ok("tidak ada objek Date di baris ekspor neraca", !adaDate);

  // ================================================================
  console.log("\n--- 10. Workbook Excel atas bagan akun bertingkat ---");
  // ================================================================

  /*
   * Bagian 7 menguji SQL-nya; bagian ini menguji berkasnya.
   *
   * Yang paling mudah salah di sini: akun header dan anak-anaknya sama-sama
   * masuk rentang SUBTOTAL, sehingga setiap angka menjadi dua kali lipat.
   * Bagan akun bawaan datar, jadi cacat itu TIDAK akan terlihat di
   * test:export yang memakai database kerja — hanya di sini.
   */
  const { tulisWorkbook } = await import("../lib/export/xlsx");
  const ExcelJS = (await import("exceljs")).default;

  const buf = await tulisWorkbook({
    laporan: lapNeraca,
    filter: fNeraca,
    ringkasan: "uji",
    dicetakPada: "20 Sep 2026 00:00",
    baris: barisNeraca,
  });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];

  type Sel = { rumus: string | null; angka: number | null };
  const kolomD = 4; // Saldo
  const sel: Record<number, Sel> = {};
  ws.eachRow((row, n) => {
    const v = row.getCell(kolomD).value as unknown;
    sel[n] = {
      rumus:
        v && typeof v === "object" && "formula" in (v as object)
          ? String((v as { formula: string }).formula)
          : null,
      angka: typeof v === "number" ? v : null,
    };
  });

  /**
   * Meniru SUBTOTAL(109; rentang) apa adanya: menjumlahkan sel berangka
   * di dalam rentang dan MENGABAIKAN sel yang isinya SUBTOTAL lain.
   * Perilaku itulah yang membuat header dan anaknya tidak terhitung dua
   * kali, jadi ia perlu diuji, bukan diandaikan.
   */
  function hitung(rumus: string): number {
    const sub = /^SUBTOTAL\(109,D(\d+):D(\d+)\)$/.exec(rumus);
    if (sub) {
      let total = 0;
      for (let n = Number(sub[1]); n <= Number(sub[2]); n++) {
        const x = sel[n];
        if (!x) continue;
        if (x.rumus?.startsWith("SUBTOTAL(")) continue; // bersarang: diabaikan
        if (x.rumus) total += hitung(x.rumus);
        else if (x.angka !== null) total += x.angka;
      }
      return total;
    }
    const kurang = /^D(\d+)((?:-D\d+)+)$/.exec(rumus);
    if (kurang) {
      const nilai = (n: number) => {
        const x = sel[n];
        return x?.rumus ? hitung(x.rumus) : (x?.angka ?? 0);
      };
      let total = nilai(Number(kurang[1]));
      for (const m of kurang[2].matchAll(/-D(\d+)/g)) total -= nilai(Number(m[1]));
      return total;
    }
    throw new Error("rumus tak dikenal: " + rumus);
  }

  const barisNo = new Map<string, number>();
  ws.eachRow((row, n) => {
    const nama = String(row.getCell(3).value ?? "").trim();
    if (nama) barisNo.set(nama, n);
  });

  const rumusDi = (nama: string) => sel[barisNo.get(nama)!]?.rumus ?? "";

  // Akun header harus jadi formula, bukan angka mati.
  for (const nama of ["Aset", "Aset Lancar", "Kas dan Setara Kas",
                      "Piutang dan Persediaan", "Liabilitas"]) {
    ok(
      `akun header '${nama}' berupa formula SUBTOTAL`,
      /^SUBTOTAL\(109,D\d+:D\d+\)$/.test(rumusDi(nama)),
      `rumus: ${JSON.stringify(rumusDi(nama))}`
    );
  }

  // Dan nilainya harus sama dengan rollup yang dihitung Postgres.
  eq("nilai header 'Aset' di Excel == saldo akar '1'", hitung(rumusDi("Aset")), akun("1")?.saldo);
  eq(
    "nilai header 'Aset Lancar' di Excel == rollup Postgres",
    hitung(rumusDi("Aset Lancar")),
    akun("1-1")?.saldo
  );
  eq(
    "nilai header 'Piutang dan Persediaan' di Excel == rollup Postgres",
    hitung(rumusDi("Piutang dan Persediaan")),
    akun("1-12")?.saldo
  );

  /*
   * Inti dari seluruh bagian ini: total aset di Excel harus sama dengan
   * total aset sebenarnya. Kalau header ikut terjumlah bersama anaknya,
   * angka ini akan menjadi kelipatan dari yang benar — dan lolos semua
   * asersi lain.
   */
  eq(
    "Total aset di Excel == total aset (tidak terhitung ganda)",
    hitung(rumusDi("Total aset")),
    n.totalAset
  );
  eq(
    "Total liabilitas di Excel == total liabilitas",
    hitung(rumusDi("Total liabilitas")),
    n.totalLiabilitas
  );
  eq(
    "Total ekuitas di Excel == ekuitas + laba ditahan + laba berjalan",
    hitung(rumusDi("Total ekuitas termasuk laba")),
    n.totalEkuitas + n.labaDitahan + n.labaBerjalan
  );

  const rumusUji = rumusDi("Aset dikurangi liabilitas dan ekuitas (harus nol)");
  ok(
    "uji keseimbangan di Excel menghasilkan tepat nol",
    hitung(rumusUji) === 0,
    `rumus ${rumusUji} -> ${hitung(rumusUji)}`
  );

  // Baris akun daun tetap angka, bukan formula: itu datanya.
  // barisNo dibangun dengan .trim(), jadi kuncinya tanpa indentasi.
  const barisDaun = barisNo.get("Kas & Bank");
  ok(
    "akun daun tetap berupa angka, bukan formula",
    barisDaun !== undefined && sel[barisDaun].rumus === null &&
      typeof sel[barisDaun].angka === "number",
    `baris ${barisDaun}, isi ${JSON.stringify(sel[barisDaun!])}`
  );
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

    c = new Client({ connectionString: tempUrl });
    await c.connect();
    await applyMigrations(c, { root: env.root, log: false });
    await applySeed(c);
    await bangunBaganAkun(c);
    await isiJurnal(c);

    // Harus disetel SEBELUM lib/db diimpor lewat lib/laporan-keuangan.
    process.env.DATABASE_URL = tempUrl;

    await tes(c);

    const { pool } = await import("../lib/db");
    await pool().end().catch(() => {});
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

  console.log(gagal === 0 ? "\n✓ Semua tes lolos." : `\n✗ ${gagal} tes gagal.`);
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n✗ " + (e instanceof Error ? e.stack : String(e)));
  process.exit(1);
});
