import { query } from "./db";

/**
 * ============================================================
 * LAPORAN KEUANGAN
 * ============================================================
 * Neraca dan Laba Rugi dibangun langsung dari journal_entry dan
 * journal_line. Tidak ada tabel saldo terpisah yang bisa melenceng.
 *
 * Tiga hal yang paling sering salah, dan cara berkas ini menanganinya:
 *
 *  1. KONVENSI TANDA. ASSET dan EXPENSE bersaldo normal debit, sisanya
 *     kredit. Tandanya dibalik di SQL, sekali, supaya tidak ada lapisan
 *     lain yang perlu mengingatnya.
 *
 *  2. PERIODE VS KUMULATIF. Laba Rugi adalah PERGERAKAN dalam rentang;
 *     Neraca adalah AKUMULASI sejak awal sampai satu tanggal. Keduanya
 *     memakai fungsi yang sama dengan rentang berbeda — tertukar sedikit
 *     saja dan neracanya tidak akan seimbang.
 *
 *  3. LABA BERJALAN. Neraca hanya seimbang bila laba periode berjalan
 *     ikut masuk ke sisi ekuitas. Lihat `neraca()`.
 *
 * Tanggal selalu berupa teks 'YYYY-MM-DD', tidak pernah objek Date.
 */

export type TipeAkun = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

export type BarisAkun = {
  kode: string;
  nama: string;
  tipe: TipeAkun;
  kedalaman: number;
  postable: boolean;
  punyaAnak: boolean;
  /** Saldo akun ini saja. */
  saldoSendiri: number;
  /** Saldo akun ini + seluruh turunannya, berapa pun kedalamannya. */
  saldo: number;
  pembanding: number;
  selisih: number;
  selisihPersen: number | null;
  /**
   * True bila saldonya berlawanan arah dari saldo normal jenis akunnya.
   * Ditandai, BUKAN disembunyikan dengan nilai mutlak — persediaan yang
   * bersaldo kredit adalah gejala, bukan hal yang perlu dirapikan.
   */
  berlawanan: boolean;
};

/** Tanggal paling awal yang mungkin; dipakai untuk akumulasi Neraca. */
const AWAL_WAKTU = "0001-01-01";

type BarisMentah = {
  kode: string;
  nama: string;
  tipe: TipeAkun;
  kedalaman: string;
  postable: boolean;
  punya_anak: boolean;
  saldo_sendiri: string;
  saldo: string;
};

/**
 * Saldo setiap akun untuk satu rentang tanggal.
 *
 * Rollup turunan memakai recursive CTE, bukan asumsi dua tingkat: sebuah
 * akun header bisa punya cucu dan cicit, dan bagan akun tumbuh ke bawah
 * seiring waktu.
 */
async function saldoAkun(dari: string, sampai: string): Promise<BarisMentah[]> {
  return query<BarisMentah>(
    `WITH RECURSIVE
     gerak AS (
       SELECT l.account_id,
              COALESCE(SUM(l.debit), 0)  AS d,
              COALESCE(SUM(l.credit), 0) AS k
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
        WHERE e.entry_date >= $1::date AND e.entry_date <= $2::date
        GROUP BY l.account_id
     ),
     sendiri AS (
       SELECT a.id,
              -- Konvensi tanda diterapkan SEKALI, di sini.
              CASE WHEN a.type IN ('ASSET', 'EXPENSE')
                   THEN COALESCE(g.d, 0) - COALESCE(g.k, 0)
                   ELSE COALESCE(g.k, 0) - COALESCE(g.d, 0)
              END AS saldo
         FROM account a
         LEFT JOIN gerak g ON g.account_id = a.id
     ),
     turunan AS (
       SELECT id AS akar, id AS simpul FROM account
       UNION ALL
       SELECT t.akar, a.id
         FROM turunan t
         JOIN account a ON a.parent_id = t.simpul
     ),
     gabungan AS (
       SELECT t.akar AS id, SUM(s.saldo) AS saldo
         FROM turunan t
         JOIN sendiri s ON s.id = t.simpul
        GROUP BY t.akar
     ),
     pohon AS (
       SELECT a.id, a.code, a.name, a.type, a.is_postable,
              0 AS kedalaman, a.code::text AS jalur
         FROM account a
        WHERE a.parent_id IS NULL
       UNION ALL
       SELECT a.id, a.code, a.name, a.type, a.is_postable,
              p.kedalaman + 1, p.jalur || '/' || a.code
         FROM pohon p
         JOIN account a ON a.parent_id = p.id
     )
     SELECT p.code AS kode, p.name AS nama, p.type AS tipe,
            p.kedalaman, p.is_postable AS postable,
            EXISTS (SELECT 1 FROM account c WHERE c.parent_id = p.id) AS punya_anak,
            ROUND(s.saldo, 2)  AS saldo_sendiri,
            ROUND(gb.saldo, 2) AS saldo
       FROM pohon p
       JOIN sendiri s   ON s.id = p.id
       JOIN gabungan gb ON gb.id = p.id
      ORDER BY p.jalur`,
    [dari, sampai]
  );
}

function gabungPembanding(
  utama: BarisMentah[],
  banding: BarisMentah[]
): BarisAkun[] {
  const petaBanding = new Map(banding.map((b) => [b.kode, Number(b.saldo)]));

  return utama.map((r) => {
    const saldo = Number(r.saldo);
    const pembanding = petaBanding.get(r.kode) ?? 0;
    const selisih = saldo - pembanding;

    return {
      kode: r.kode,
      nama: r.nama,
      tipe: r.tipe,
      kedalaman: Number(r.kedalaman),
      postable: r.postable,
      punyaAnak: r.punya_anak,
      saldoSendiri: Number(r.saldo_sendiri),
      saldo,
      pembanding,
      selisih,
      // Pembagian dengan nol tidak menghasilkan "naik tak hingga", melainkan
      // "tidak bisa dibandingkan". Dibedakan dengan null.
      selisihPersen: pembanding === 0 ? null : (selisih / Math.abs(pembanding)) * 100,
      berlawanan: saldo < 0,
    };
  });
}

/** Menyaring akun yang tidak relevan: saldo nol di kedua periode. */
function buangKosong(baris: BarisAkun[]): BarisAkun[] {
  return baris.filter((b) => b.saldo !== 0 || b.pembanding !== 0);
}

export type LabaRugi = {
  dari: string;
  sampai: string;
  bandingDari: string;
  bandingSampai: string;
  pendapatan: BarisAkun[];
  beban: BarisAkun[];
  totalPendapatan: number;
  totalBeban: number;
  laba: number;
  bandingPendapatan: number;
  bandingBeban: number;
  bandingLaba: number;
};

/**
 * Laba Rugi = PERGERAKAN dalam rentang periode.
 */
export async function labaRugi(
  dari: string,
  sampai: string,
  bandingDari: string,
  bandingSampai: string
): Promise<LabaRugi> {
  const [utama, banding] = await Promise.all([
    saldoAkun(dari, sampai),
    saldoAkun(bandingDari, bandingSampai),
  ]);

  const semua = gabungPembanding(utama, banding);
  const ambil = (t: TipeAkun) => buangKosong(semua.filter((b) => b.tipe === t));

  const pendapatan = ambil("REVENUE");
  const beban = ambil("EXPENSE");

  // Hanya akun akar yang dijumlahkan; akun turunan sudah termasuk di
  // dalamnya dan menjumlahkan keduanya akan menghitung ganda.
  const akar = (b: BarisAkun[]) => b.filter((x) => x.kedalaman === 0);
  const jumlah = (b: BarisAkun[], f: (x: BarisAkun) => number) =>
    akar(b).reduce((a, x) => a + f(x), 0);

  const totalPendapatan = jumlah(pendapatan, (x) => x.saldo);
  const totalBeban = jumlah(beban, (x) => x.saldo);
  const bandingPendapatan = jumlah(pendapatan, (x) => x.pembanding);
  const bandingBeban = jumlah(beban, (x) => x.pembanding);

  return {
    dari, sampai, bandingDari, bandingSampai,
    pendapatan, beban,
    totalPendapatan, totalBeban,
    laba: totalPendapatan - totalBeban,
    bandingPendapatan, bandingBeban,
    bandingLaba: bandingPendapatan - bandingBeban,
  };
}

export type Neraca = {
  perTanggal: string;
  bandingTanggal: string;
  aset: BarisAkun[];
  liabilitas: BarisAkun[];
  ekuitas: BarisAkun[];
  totalAset: number;
  totalLiabilitas: number;
  totalEkuitas: number;
  /** REVENUE - EXPENSE sejak awal tahun buku sampai tanggal neraca. */
  labaBerjalan: number;
  /**
   * REVENUE - EXPENSE dari SELURUH periode sebelum tahun buku berjalan.
   *
   * Tanpa jurnal penutup, laba tahun-tahun lalu tidak pernah pindah ke akun
   * ekuitas. Kalau barisnya dihilangkan, neraca akan tampak timpang persis
   * sebesar laba tahun lalu dan orang akan mencari kesalahan di tempat yang
   * salah. Bernilai nol selama semua jurnal masih dalam satu tahun buku.
   */
  labaDitahan: number;
  totalEkuitasDanLaba: number;
  /**
   * Aset - (Liabilitas + Ekuitas + Laba ditahan + Laba berjalan).
   *
   * DIHITUNG POSTGRES sebagai numeric, bukan dijumlahkan di JavaScript.
   * Penjumlahan float atas nilai dua desimal bisa menyisakan residu sebesar
   * 1e-10, dan "hampir nol" bukan jawaban yang boleh diberikan sebuah
   * neraca — jadi nilainya harus benar-benar eksak sebelum dibandingkan.
   */
  selisih: number;
  seimbang: boolean;
  bandingTotalAset: number;
  bandingTotalLiabilitas: number;
  bandingTotalEkuitas: number;
  bandingLabaBerjalan: number;
  bandingLabaDitahan: number;
};

type RingkasNeraca = {
  aset: string;
  liabilitas: string;
  ekuitas: string;
  laba_berjalan: string;
  laba_ditahan: string;
  selisih: string;
};

/**
 * Total per jenis akun dan uji keseimbangannya, seluruhnya dalam numeric
 * Postgres.
 *
 * Menjumlahkan baris jurnal per `type` memberi hasil yang sama persis
 * dengan rollup pohon di `saldoAkun`, karena hanya akun postable yang
 * punya baris jurnal dan setiap akun punya tepat satu akar. Kesamaan itu
 * diperiksa oleh test:laporan — kalau suatu saat berbeda, salah satu dari
 * keduanya sedang rusak.
 */
async function ringkasNeraca(perTanggal: string): Promise<RingkasNeraca> {
  const [r] = await query<RingkasNeraca>(
    `WITH tot AS (
       SELECT a.type,
              SUM(CASE WHEN a.type IN ('ASSET', 'EXPENSE')
                       THEN l.debit - l.credit
                       ELSE l.credit - l.debit END) AS saldo,
              -- Untuk REVENUE dan EXPENSE, (credit - debit) SUDAH berarti
              -- "pendapatan dikurangi beban": pendapatan bersaldo normal
              -- kredit sehingga positif, beban bersaldo normal debit
              -- sehingga otomatis negatif.
              SUM(CASE WHEN e.entry_date >= date_trunc('year', $1::date)
                       THEN l.credit - l.debit ELSE 0 END) AS tahun_ini,
              SUM(CASE WHEN e.entry_date <  date_trunc('year', $1::date)
                       THEN l.credit - l.debit ELSE 0 END) AS sebelumnya
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
         JOIN account a       ON a.id = l.account_id
        WHERE e.entry_date <= $1::date
        GROUP BY a.type
     ),
     n AS (
       SELECT ROUND(COALESCE((SELECT saldo FROM tot WHERE type = 'ASSET'), 0), 2) AS aset,
              ROUND(COALESCE((SELECT saldo FROM tot WHERE type = 'LIABILITY'), 0), 2) AS liabilitas,
              ROUND(COALESCE((SELECT saldo FROM tot WHERE type = 'EQUITY'), 0), 2) AS ekuitas,
              ROUND(COALESCE((SELECT SUM(tahun_ini) FROM tot
                               WHERE type IN ('REVENUE', 'EXPENSE')), 0), 2) AS laba_berjalan,
              ROUND(COALESCE((SELECT SUM(sebelumnya) FROM tot
                               WHERE type IN ('REVENUE', 'EXPENSE')), 0), 2) AS laba_ditahan
     )
     SELECT aset, liabilitas, ekuitas, laba_berjalan, laba_ditahan,
            (aset - liabilitas - ekuitas - laba_berjalan - laba_ditahan) AS selisih
       FROM n`,
    [perTanggal]
  );
  return r;
}

/**
 * Neraca = AKUMULASI sejak awal sampai satu tanggal.
 *
 * Laba dihitung terpisah dan ditambahkan ke sisi ekuitas dalam dua baris:
 * laba periode berjalan dan laba yang belum ditutup dari periode sebelumnya.
 * Tanpa keduanya Aset tidak akan pernah sama dengan Liabilitas + Ekuitas,
 * dan yang membaca akan mengira datanya rusak — padahal yang kurang justru
 * laporannya.
 */
export async function neraca(
  perTanggal: string,
  bandingTanggal: string
): Promise<Neraca> {
  const [utama, banding, ring, ringBanding] = await Promise.all([
    saldoAkun(AWAL_WAKTU, perTanggal),
    saldoAkun(AWAL_WAKTU, bandingTanggal),
    ringkasNeraca(perTanggal),
    ringkasNeraca(bandingTanggal),
  ]);

  const semua = gabungPembanding(utama, banding);
  const ambil = (t: TipeAkun) => buangKosong(semua.filter((b) => b.tipe === t));

  const totalAset = Number(ring.aset);
  const totalLiabilitas = Number(ring.liabilitas);
  const totalEkuitas = Number(ring.ekuitas);
  const labaBerjalan = Number(ring.laba_berjalan);
  const labaDitahan = Number(ring.laba_ditahan);

  return {
    perTanggal,
    bandingTanggal,
    aset: ambil("ASSET"),
    liabilitas: ambil("LIABILITY"),
    ekuitas: ambil("EQUITY"),
    totalAset,
    totalLiabilitas,
    totalEkuitas,
    labaBerjalan,
    labaDitahan,
    totalEkuitasDanLaba: totalEkuitas + labaBerjalan + labaDitahan,
    selisih: Number(ring.selisih),
    // Perbandingan dilakukan terhadap teks numeric dari Postgres, jadi
    // "tepat nol" memang berarti tepat nol.
    seimbang: /^-?0(\.0+)?$/.test(ring.selisih),
    bandingTotalAset: Number(ringBanding.aset),
    bandingTotalLiabilitas: Number(ringBanding.liabilitas),
    bandingTotalEkuitas: Number(ringBanding.ekuitas),
    bandingLabaBerjalan: Number(ringBanding.laba_berjalan),
    bandingLabaDitahan: Number(ringBanding.laba_ditahan),
  };
}

/** Tanggal acuan dari database, bukan dari jam Node. */
export async function tanggalAcuan(): Promise<{
  hariIni: string;
  akhirBulanLalu: string;
  awalBulan: string;
  awalTahun: string;
  awalTahunLalu: string;
  akhirTahunLalu: string;
  awalBulanLalu: string;
}> {
  const [r] = await query<Record<string, string>>(
    `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS hari_ini,
            to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '1 day', 'YYYY-MM-DD') AS akhir_bulan_lalu,
            to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD') AS awal_bulan,
            to_char(date_trunc('year', CURRENT_DATE), 'YYYY-MM-DD') AS awal_tahun,
            to_char(date_trunc('year', CURRENT_DATE) - INTERVAL '1 year', 'YYYY-MM-DD') AS awal_tahun_lalu,
            to_char(date_trunc('year', CURRENT_DATE) - INTERVAL '1 day', 'YYYY-MM-DD') AS akhir_tahun_lalu,
            to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '1 month', 'YYYY-MM-DD') AS awal_bulan_lalu`
  );
  return {
    hariIni: r.hari_ini,
    akhirBulanLalu: r.akhir_bulan_lalu,
    awalBulan: r.awal_bulan,
    awalTahun: r.awal_tahun,
    awalTahunLalu: r.awal_tahun_lalu,
    akhirTahunLalu: r.akhir_tahun_lalu,
    awalBulanLalu: r.awal_bulan_lalu,
  };
}

/**
 * Menggeser rentang mundur satu bulan atau satu tahun untuk kolom pembanding.
 * Digeser oleh Postgres, bukan aritmetika tanggal di JavaScript: pergeseran
 * bulan harus menghormati panjang bulan dan tahun kabisat.
 */
export async function geserRentang(
  dari: string,
  sampai: string,
  satuan: "bulan" | "tahun"
): Promise<{ dari: string; sampai: string }> {
  const interval = satuan === "bulan" ? "1 month" : "1 year";
  const [r] = await query<{ d: string; s: string }>(
    `SELECT to_char($1::date - INTERVAL '${interval}', 'YYYY-MM-DD') AS d,
            to_char($2::date - INTERVAL '${interval}', 'YYYY-MM-DD') AS s`,
    [dari, sampai]
  );
  return { dari: r.d, sampai: r.s };
}
