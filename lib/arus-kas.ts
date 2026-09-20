import { query } from "./db";

/**
 * ============================================================
 * LAPORAN ARUS KAS — METODE LANGSUNG
 * ============================================================
 * Prasyaratnya ada di migrasi 011: account.is_cash_equivalent menandai
 * akun kas, dan account.kategori_arus_kas menggolongkan akun NON-kas.
 *
 * ------------------------------------------------------------
 * BAGAIMANA SEBUAH MUTASI KAS DIGOLONGKAN
 * ------------------------------------------------------------
 * Bukan dari akun kasnya. Kas untuk membeli mesin dan kas untuk membayar
 * pemasok keluar dari akun yang sama; yang membedakan keduanya adalah
 * apa yang dipertukarkan dengan kas itu. Golongannya karena itu dibaca
 * dari baris LAWAN di jurnal yang sama.
 *
 * ------------------------------------------------------------
 * JURNAL DENGAN BANYAK BARIS LAWAN
 * ------------------------------------------------------------
 * Satu pembayaran bisa berhadapan dengan beberapa akun sekaligus —
 * misalnya faktur ber-PPN, atau penerimaan yang sebagian menjadi
 * titipan pelanggan. Pembagiannya memakai NILAI BARIS BERTANDA:
 *
 *     kontribusi baris lawan = -(debit - credit)
 *
 * Ini bukan taksiran proporsional yang menyisakan pembulatan. Karena
 * setiap jurnal seimbang,
 *
 *     Σ semua (debit - credit) = 0
 *     Σ kas (debit - credit) + Σ lawan (debit - credit) = 0
 *     Σ lawan -(debit - credit) = Σ kas (debit - credit)
 *
 * jumlah kontribusi seluruh baris lawan SELALU sama persis dengan
 * pergerakan kas jurnal itu. Tidak ada nilai yang bisa hilang, dan
 * tidak ada sisa yang perlu dilemparkan ke golongan "lain-lain".
 *
 * ------------------------------------------------------------
 * TRANSFER ANTAR REKENING
 * ------------------------------------------------------------
 * Jurnal yang kedua sisinya akun kas tidak punya baris lawan sama
 * sekali, sehingga ia tidak menyumbang apa pun ke golongan mana pun —
 * pengecualiannya terjadi dengan sendirinya, bukan lewat aturan
 * tambahan yang bisa lupa diterapkan. Saldo total kas memang tidak
 * berubah oleh transfer, dan laporan ini mengatakan hal yang sama.
 *
 * Transfer yang MEMBAWA biaya administrasi tetap muncul, sebesar
 * biayanya saja — dan itu memang satu-satunya bagian yang benar-benar
 * meninggalkan kas.
 *
 * Tanggal selalu berupa teks 'YYYY-MM-DD', tidak pernah objek Date.
 */

export type KategoriArusKas = "OPERASI" | "INVESTASI" | "PENDANAAN";

export const LABEL_KATEGORI: Record<KategoriArusKas, string> = {
  OPERASI: "Arus kas dari aktivitas operasi",
  INVESTASI: "Arus kas dari aktivitas investasi",
  PENDANAAN: "Arus kas dari aktivitas pendanaan",
};

export type BarisArus = {
  kode: string;
  nama: string;
  kategori: KategoriArusKas | null;
  /** Positif = kas masuk, negatif = kas keluar. */
  nilai: number;
  pembanding: number;
  selisih: number;
  selisihPersen: number | null;
};

export type ArusKas = {
  dari: string;
  sampai: string;
  bandingDari: string;
  bandingSampai: string;

  saldoAwal: number;
  saldoAkhir: number;
  bandingSaldoAwal: number;
  bandingSaldoAkhir: number;

  operasi: BarisArus[];
  investasi: BarisArus[];
  pendanaan: BarisArus[];
  /**
   * Baris lawan yang belum punya golongan.
   *
   * Constraint di migrasi 011 melarang akun postable non-kas tanpa
   * kategori, jadi daftar ini seharusnya SELALU kosong. Ia tetap
   * ditampilkan alih-alih dibuang diam-diam: kalau suatu saat terisi,
   * angkanya harus terlihat, bukan menghilang dari laporan.
   */
  belumDigolongkan: BarisArus[];

  totalOperasi: number;
  totalInvestasi: number;
  totalPendanaan: number;
  totalBelumDigolongkan: number;
  totalArus: number;

  bandingTotalOperasi: number;
  bandingTotalInvestasi: number;
  bandingTotalPendanaan: number;
  bandingTotalArus: number;

  /** saldoAwal + totalArus - saldoAkhir. Harus TEPAT nol. */
  selisih: number;
  seimbang: boolean;
};

type BarisMentah = {
  kode: string;
  nama: string;
  kategori: string | null;
  arus: string;
};

/**
 * Rincian arus kas per akun lawan dalam satu rentang.
 *
 * Hanya jurnal yang benar-benar menyentuh akun kas yang dilihat; jurnal
 * lain tidak punya dampak kas dan tidak boleh ikut.
 */
async function rincianArus(dari: string, sampai: string): Promise<BarisMentah[]> {
  return query<BarisMentah>(
    `WITH jurnal_kas AS (
       SELECT DISTINCT e.id
         FROM journal_entry e
         JOIN journal_line l ON l.entry_id = e.id
         JOIN account a      ON a.id = l.account_id
        WHERE e.is_posted
          AND a.is_cash_equivalent
          AND e.entry_date >= $1::date AND e.entry_date <= $2::date
     )
     SELECT a.code AS kode, a.name AS nama,
            a.kategori_arus_kas::text AS kategori,
            -- Nilai baris BERTANDA, bukan taksiran proporsional.
            -- Lihat catatan di kepala berkas ini.
            ROUND(SUM(-(l.debit - l.credit)), 2) AS arus
       FROM jurnal_kas j
       JOIN journal_line l ON l.entry_id = j.id
       JOIN account a      ON a.id = l.account_id
      WHERE NOT a.is_cash_equivalent
      GROUP BY a.code, a.name, a.kategori_arus_kas
     HAVING SUM(-(l.debit - l.credit)) <> 0
      ORDER BY a.code`,
    [dari, sampai]
  );
}

/**
 * Saldo kas pada satu tanggal, dari journal_line langsung.
 *
 * SENGAJA tidak dihitung dari laporannya sendiri. Kalau saldo awal,
 * saldo akhir, dan golongan-golongan semuanya berasal dari kueri yang
 * sama, asersi "awal + arus = akhir" hanya akan membuktikan bahwa
 * penjumlahan bekerja — bukan bahwa laporannya benar.
 */
async function saldoKas(sampai: string, inklusif = true): Promise<string> {
  const rows = await query<{ saldo: string }>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS saldo
       FROM journal_line l
       JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
       JOIN account a       ON a.id = l.account_id
      WHERE a.is_cash_equivalent
        AND e.entry_date ${inklusif ? "<=" : "<"} $1::date`,
    [sampai]
  );
  return rows[0]?.saldo ?? "0";
}

function gabung(utama: BarisMentah[], banding: BarisMentah[]): BarisArus[] {
  const petaBanding = new Map(banding.map((b) => [b.kode, Number(b.arus)]));
  const kode = new Set([...utama.map((u) => u.kode), ...petaBanding.keys()]);
  const info = new Map(utama.map((u) => [u.kode, u]));
  for (const b of banding) if (!info.has(b.kode)) info.set(b.kode, b);

  return [...kode]
    .sort()
    .map((k) => {
      const m = info.get(k)!;
      const nilai = Number(utama.find((u) => u.kode === k)?.arus ?? 0);
      const pembanding = petaBanding.get(k) ?? 0;
      const selisih = nilai - pembanding;
      return {
        kode: k,
        nama: m.nama,
        kategori: (m.kategori as KategoriArusKas | null) ?? null,
        nilai,
        pembanding,
        selisih,
        // Pembagian dengan nol berarti "tidak bisa dibandingkan",
        // bukan "naik tak hingga".
        selisihPersen:
          pembanding === 0 ? null : (selisih / Math.abs(pembanding)) * 100,
      };
    });
}

export async function arusKas(
  dari: string,
  sampai: string,
  bandingDari: string,
  bandingSampai: string
): Promise<ArusKas> {
  const [utama, banding, awal, akhir, bAwal, bAkhir, cek] = await Promise.all([
    rincianArus(dari, sampai),
    rincianArus(bandingDari, bandingSampai),
    saldoKas(dari, false),
    saldoKas(sampai),
    saldoKas(bandingDari, false),
    saldoKas(bandingSampai),
    /*
     * Uji keseimbangan DIHITUNG POSTGRES sebagai numeric.
     *
     * Penjumlahan float atas nilai dua desimal bisa menyisakan residu
     * 1e-10, dan "hampir seimbang" bukan jawaban yang boleh diberikan
     * laporan arus kas. Rincian per akun tetap dijumlahkan di sini
     * untuk ditampilkan, tetapi yang menentukan seimbang atau tidak
     * adalah angka ini.
     */
    query<{ selisih: string; arus: string }>(
      `WITH jurnal_kas AS (
         SELECT DISTINCT e.id
           FROM journal_entry e
           JOIN journal_line l ON l.entry_id = e.id
           JOIN account a      ON a.id = l.account_id
          WHERE e.is_posted AND a.is_cash_equivalent
            AND e.entry_date >= $1::date AND e.entry_date <= $2::date
       ),
       arus AS (
         SELECT ROUND(COALESCE(SUM(-(l.debit - l.credit)), 0), 2) AS nilai
           FROM jurnal_kas j
           JOIN journal_line l ON l.entry_id = j.id
           JOIN account a      ON a.id = l.account_id
          WHERE NOT a.is_cash_equivalent
       ),
       saldo AS (
         SELECT ROUND(COALESCE(SUM(CASE WHEN e.entry_date <  $1::date
                                        THEN l.debit - l.credit END), 0), 2) AS awal,
                ROUND(COALESCE(SUM(CASE WHEN e.entry_date <= $2::date
                                        THEN l.debit - l.credit END), 0), 2) AS akhir
           FROM journal_line l
           JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
           JOIN account a       ON a.id = l.account_id
          WHERE a.is_cash_equivalent
       )
       SELECT (SELECT nilai FROM arus)::text AS arus,
              ((SELECT awal FROM saldo) + (SELECT nilai FROM arus)
               - (SELECT akhir FROM saldo))::text AS selisih`,
      [dari, sampai]
    ),
  ]);

  const semua = gabung(utama, banding);
  const ambil = (k: KategoriArusKas) => semua.filter((b) => b.kategori === k);
  const jml = (b: BarisArus[], f: (x: BarisArus) => number) =>
    b.reduce((a, x) => a + f(x), 0);

  const operasi = ambil("OPERASI");
  const investasi = ambil("INVESTASI");
  const pendanaan = ambil("PENDANAAN");
  const belumDigolongkan = semua.filter((b) => b.kategori === null);

  const totalArus = Number(cek[0]?.arus ?? 0);
  const selisih = Number(cek[0]?.selisih ?? 0);

  return {
    dari,
    sampai,
    bandingDari,
    bandingSampai,

    saldoAwal: Number(awal),
    saldoAkhir: Number(akhir),
    bandingSaldoAwal: Number(bAwal),
    bandingSaldoAkhir: Number(bAkhir),

    operasi,
    investasi,
    pendanaan,
    belumDigolongkan,

    totalOperasi: jml(operasi, (x) => x.nilai),
    totalInvestasi: jml(investasi, (x) => x.nilai),
    totalPendanaan: jml(pendanaan, (x) => x.nilai),
    totalBelumDigolongkan: jml(belumDigolongkan, (x) => x.nilai),
    totalArus,

    bandingTotalOperasi: jml(operasi, (x) => x.pembanding),
    bandingTotalInvestasi: jml(investasi, (x) => x.pembanding),
    bandingTotalPendanaan: jml(pendanaan, (x) => x.pembanding),
    bandingTotalArus: Number(bAkhir) - Number(bAwal),

    selisih,
    // Dibandingkan sebagai teks numeric dari Postgres, jadi "tepat nol"
    // memang berarti tepat nol.
    seimbang: /^-?0(\.0+)?$/.test(String(cek[0]?.selisih ?? "0")),
  };
}
