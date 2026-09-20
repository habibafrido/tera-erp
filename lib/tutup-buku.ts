import { query, tx } from "./db";
import { neraca } from "./laporan-keuangan";

/**
 * ============================================================
 * TUTUP BUKU PERIODE
 * ============================================================
 * Penegakan sesungguhnya ada di trigger basis data (lihat
 * db/010_tutup_buku.sql). Berkas ini mengerjakan dua hal lain:
 *
 *   1. MEMERIKSA sebelum menutup, dan menjelaskan apa yang salah.
 *      Penolakan tanpa daftar masalah memaksa orang menebak, dan orang
 *      yang menebak akan mencari tombol buka kembali.
 *
 *   2. Mencatat penutupan dan pembukaan kembali ke riwayat.
 *
 * Apa yang TIDAK dikerjakan di sini: mencegah posting. Itu pekerjaan
 * trigger, karena pemeriksaan di lapisan ini bisa dilewati oleh skrip,
 * oleh psql, dan oleh jalur kode kedua yang lupa memanggilnya.
 */

export type StatusPeriode = "TERBUKA" | "DITUTUP";

export type Periode = {
  tahun: number;
  bulan: number;
  status: StatusPeriode;
  awal: string;
  akhir: string;
  ditutupPada: string | null;
  ditutupOleh: string | null;
  dibukaPada: string | null;
  dibukaOleh: string | null;
  alasan: string | null;
  jumlahDibukaKembali: number;
  pernahDibuka: boolean;
};

export type Masalah = {
  kode: string;
  judul: string;
  /** Apa yang harus dilakukan, bukan sekadar apa yang salah. */
  tindakan: string;
  rincian: string[];
};

const NAMA_BULAN = [
  "", "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

export const labelPeriode = (tahun: number, bulan: number) =>
  `${NAMA_BULAN[bulan] ?? bulan} ${tahun}`;

// ------------------------------------------------------------
// Membaca periode
// ------------------------------------------------------------

// pg mengembalikan boolean sebagai boolean, sisanya sebagai teks.
type BarisPeriode = Record<string, string | boolean | null>;

function bentuk(r: BarisPeriode): Periode {
  return {
    tahun: Number(r.tahun),
    bulan: Number(r.bulan),
    status: r.status as StatusPeriode,
    awal: r.awal as string,
    akhir: r.akhir as string,
    ditutupPada: (r.ditutup_pada as string | null) ?? null,
    ditutupOleh: (r.ditutup_oleh_nama as string | null) ?? null,
    dibukaPada: (r.dibuka_kembali_pada as string | null) ?? null,
    dibukaOleh: (r.dibuka_oleh_nama as string | null) ?? null,
    alasan: (r.alasan as string | null) ?? null,
    jumlahDibukaKembali: Number(r.jumlah_dibuka_kembali ?? 0),
    pernahDibuka: Number(r.jumlah_dibuka_kembali ?? 0) > 0,
  };
}

/**
 * Daftar periode yang punya data, dari yang terbaru.
 *
 * Periode dibentuk dari rentang tanggal jurnal yang benar-benar ada,
 * bukan dari kalender: menampilkan dua belas bulan kosong di depan
 * membuat orang mengira ia harus menutupnya satu per satu.
 */
export async function daftarPeriode(): Promise<Periode[]> {
  const rows = await query<BarisPeriode>(`
    WITH rentang AS (
      SELECT date_trunc('month', MIN(entry_date))::date AS dari,
             GREATEST(date_trunc('month', MAX(entry_date)),
                      date_trunc('month', CURRENT_DATE))::date AS sampai
        FROM journal_entry WHERE is_posted
    ),
    bulan AS (
      SELECT d::date AS awal
        FROM rentang,
             generate_series(COALESCE(rentang.dari, date_trunc('month', CURRENT_DATE)::date),
                             COALESCE(rentang.sampai, date_trunc('month', CURRENT_DATE)::date),
                             INTERVAL '1 month') d
    )
    SELECT EXTRACT(YEAR FROM b.awal)::int  AS tahun,
           EXTRACT(MONTH FROM b.awal)::int AS bulan,
           COALESCE(p.status, 'TERBUKA')   AS status,
           to_char(b.awal, 'YYYY-MM-DD')   AS awal,
           to_char((b.awal + INTERVAL '1 month - 1 day')::date, 'YYYY-MM-DD') AS akhir,
           to_char(p.ditutup_pada, 'YYYY-MM-DD HH24:MI')        AS ditutup_pada,
           to_char(p.dibuka_kembali_pada, 'YYYY-MM-DD HH24:MI') AS dibuka_kembali_pada,
           p.alasan,
           COALESCE(p.jumlah_dibuka_kembali, 0) AS jumlah_dibuka_kembali,
           (COALESCE(p.jumlah_dibuka_kembali, 0) > 0) AS pernah_dibuka,
           u.name AS ditutup_oleh_nama,
           r.name AS dibuka_oleh_nama
      FROM bulan b
      LEFT JOIN accounting_period p
             ON p.tahun = EXTRACT(YEAR FROM b.awal)::int
            AND p.bulan = EXTRACT(MONTH FROM b.awal)::int
      LEFT JOIN app_user u ON u.id = p.ditutup_oleh
      LEFT JOIN app_user r ON r.id = p.dibuka_kembali_oleh
     ORDER BY b.awal DESC
  `);
  return rows.map(bentuk);
}

export async function statusPeriode(
  tahun: number,
  bulan: number
): Promise<StatusPeriode> {
  const rows = await query<{ status: string }>(
    `SELECT status FROM accounting_period WHERE tahun=$1 AND bulan=$2`,
    [tahun, bulan]
  );
  return (rows[0]?.status as StatusPeriode) ?? "TERBUKA";
}

// ------------------------------------------------------------
// Syarat sebelum menutup
// ------------------------------------------------------------

/**
 * Empat pemeriksaan, plus satu yang tidak diminta tapi sama pentingnya.
 *
 * Yang kelima: periode sebelumnya harus sudah ditutup. Menutup Maret
 * sementara Februari masih terbuka tidak berarti apa-apa — angka Maret
 * masih bisa berubah lewat postingan bertanggal Februari yang mengubah
 * saldo awalnya.
 *
 * Setiap masalah membawa TINDAKAN, bukan hanya keluhan. Daftar yang
 * hanya menyebutkan apa yang salah akan mengirim orang mencari tombol
 * buka kembali.
 */
export async function periksaPenutupan(
  tahun: number,
  bulan: number
): Promise<Masalah[]> {
  const masalah: Masalah[] = [];
  const [batas] = await query<{ awal: string; akhir: string }>(
    `SELECT to_char(make_date($1,$2,1), 'YYYY-MM-DD') AS awal,
            to_char((make_date($1,$2,1) + INTERVAL '1 month - 1 day')::date,
                    'YYYY-MM-DD') AS akhir`,
    [tahun, bulan]
  );

  // --- 0. Periode sebelumnya masih terbuka? ---
  const sebelum = await query<{ tahun: string; bulan: string }>(
    `WITH sebelumnya AS (
       SELECT DISTINCT EXTRACT(YEAR FROM entry_date)::int  AS tahun,
                       EXTRACT(MONTH FROM entry_date)::int AS bulan
         FROM journal_entry
        WHERE is_posted AND entry_date < $1::date
     )
     SELECT s.tahun, s.bulan FROM sebelumnya s
       LEFT JOIN accounting_period p
              ON p.tahun = s.tahun AND p.bulan = s.bulan
      WHERE COALESCE(p.status, 'TERBUKA') = 'TERBUKA'
      ORDER BY s.tahun, s.bulan`,
    [batas.awal]
  );
  if (sebelum.length > 0) {
    masalah.push({
      kode: "periode_sebelumnya",
      judul: `${sebelum.length} periode sebelumnya masih terbuka`,
      tindakan:
        "Tutup periode terlama lebih dulu. Selama periode sebelumnya " +
        "terbuka, saldo awal periode ini masih bisa berubah.",
      rincian: sebelum.map((s) => labelPeriode(Number(s.tahun), Number(s.bulan))),
    });
  }

  // --- 1. Rekonsiliasi persediaan ---
  /*
   * Nilai buku besar STOK dibandingkan dengan saldo akun Persediaan di
   * buku besar UMUM, keduanya per akhir periode.
   *
   * Keduanya seharusnya bergerak bersama-sama: setiap baris ledger
   * lahir dari jurnal yang sama. Kalau berbeda, ada pergerakan stok
   * tanpa jurnal atau jurnal persediaan tanpa pergerakan stok — dan
   * menutup periode dalam keadaan itu membekukan selisihnya selamanya.
   *
   * KENAPA MEMAKAI SUM(qty * unit_cost) DAN BUKAN running_value
   *
   * running_value adalah snapshot saldo SETELAH sebuah baris, dan
   * urutannya adalah urutan PENYISIPAN (id), bukan urutan tanggal
   * akuntansi. Untuk buku besar yang hanya bertambah maju keduanya
   * sama — tetapi jurnal pembalik bertanggal hari ini atas dokumen
   * bulan lalu membuat keduanya berpisah: baris yang disisipkan
   * belakangan punya id lebih besar meski tanggal akuntansinya lebih
   * awal, sehingga snapshot "terakhir sebelum akhir periode" sudah
   * memuat pergerakan dari periode LAIN.
   *
   * Penjumlahan qty * unit_cost tidak punya masalah itu: setiap baris
   * menyumbang nilainya sendiri, dan urutan tidak berpengaruh. Angka
   * itu juga persis yang diposting ke akun Persediaan — penerimaan
   * mendebit sejumlah qty x harga beli, penjualan mengkredit sejumlah
   * qty x rata-rata bergerak saat itu, dan keduanya tersimpan di
   * kolom unit_cost baris yang bersangkutan.
   */
  const [rekon] = await query<{
    stok: string;
    akun: string;
    selisih: string;
  }>(
    `WITH stok AS (
       SELECT COALESCE(SUM(s.qty * s.unit_cost), 0) AS nilai
         FROM stock_ledger s
         LEFT JOIN journal_entry e ON e.id = s.journal_entry_id
        WHERE COALESCE(e.entry_date, s.posted_at::date) <= $1::date
     ),
     buku AS (
       SELECT COALESCE(SUM(l.debit - l.credit), 0) AS saldo
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
         JOIN account a ON a.id = l.account_id
        WHERE a.code = '1-1300' AND e.entry_date <= $1::date
     )
     SELECT ROUND((SELECT nilai FROM stok), 2)::text AS stok,
            ROUND((SELECT saldo FROM buku), 2)::text AS akun,
            ROUND((SELECT nilai FROM stok) - (SELECT saldo FROM buku), 2)::text
              AS selisih`,
    [batas.akhir]
  );

  if (!/^-?0(\.0+)?$/.test(rekon.selisih)) {
    masalah.push({
      kode: "rekonsiliasi_persediaan",
      judul: "Rekonsiliasi persediaan tidak seimbang",
      tindakan:
        "Cari pergerakan stok yang tidak punya jurnal, atau jurnal " +
        "persediaan yang tidak punya pergerakan stok, lalu koreksi " +
        "dengan dokumen pembalik sebelum menutup.",
      rincian: [
        `Nilai buku besar stok  : ${rekon.stok}`,
        `Saldo akun 1-1300      : ${rekon.akun}`,
        `Selisih                : ${rekon.selisih}`,
      ],
    });
  }

  // --- 2. Jurnal tidak seimbang ---
  const timpang = await query<{ entry_no: string; selisih: string }>(
    `SELECT e.entry_no, ROUND(SUM(l.debit) - SUM(l.credit), 2)::text AS selisih
       FROM journal_entry e
       JOIN journal_line l ON l.entry_id = e.id
      WHERE e.is_posted
        AND e.entry_date BETWEEN $1::date AND $2::date
      GROUP BY e.id, e.entry_no
     HAVING SUM(l.debit) <> SUM(l.credit)
      ORDER BY e.entry_no
      LIMIT 20`,
    [batas.awal, batas.akhir]
  );
  if (timpang.length > 0) {
    masalah.push({
      kode: "jurnal_timpang",
      judul: `${timpang.length} jurnal tidak seimbang`,
      tindakan:
        "Jurnal ini seharusnya tidak mungkin ada — constraint trigger " +
        "menolaknya saat COMMIT. Kemunculannya berarti ada yang menulis " +
        "ke database di luar aplikasi. Periksa sebelum menutup.",
      rincian: timpang.map((t) => `${t.entry_no}: selisih ${t.selisih}`),
    });
  }

  // --- 3. Neraca tidak seimbang di akhir periode ---
  const n = await neraca(batas.akhir, batas.akhir);
  if (!n.seimbang) {
    masalah.push({
      kode: "neraca_timpang",
      judul: "Neraca tidak seimbang pada akhir periode",
      tindakan:
        "Periksa halaman Neraca per " + batas.akhir + ". Menutup periode " +
        "dengan neraca yang timpang akan membekukan selisihnya.",
      rincian: [
        `Aset                 : ${n.totalAset}`,
        `Liabilitas           : ${n.totalLiabilitas}`,
        `Ekuitas              : ${n.totalEkuitas}`,
        `Laba ditahan         : ${n.labaDitahan}`,
        `Laba berjalan        : ${n.labaBerjalan}`,
        `Selisih              : ${n.selisih}`,
      ],
    });
  }

  // --- 4. Dokumen masih draf ---
  const draf = await query<{ jenis: string; doc_no: string; tanggal: string }>(
    `SELECT 'Penerimaan barang' AS jenis, COALESCE(doc_no, '(tanpa nomor)') AS doc_no,
            to_char(doc_date, 'YYYY-MM-DD') AS tanggal
       FROM goods_receipt
      WHERE status = 'DRAFT' AND doc_date BETWEEN $1::date AND $2::date
     UNION ALL
     SELECT 'Faktur penjualan', COALESCE(doc_no, '(tanpa nomor)'),
            to_char(doc_date, 'YYYY-MM-DD')
       FROM sales_invoice
      WHERE status = 'DRAFT' AND doc_date BETWEEN $1::date AND $2::date
     UNION ALL
     SELECT 'Penerimaan pembayaran', COALESCE(doc_no, '(tanpa nomor)'),
            to_char(doc_date, 'YYYY-MM-DD')
       FROM payment_receipt
      WHERE status = 'DRAFT' AND doc_date BETWEEN $1::date AND $2::date
     UNION ALL
     SELECT 'Faktur pembelian', COALESCE(doc_no, '(tanpa nomor)'),
            to_char(doc_date, 'YYYY-MM-DD')
       FROM purchase_invoice
      WHERE status = 'DRAFT' AND doc_date BETWEEN $1::date AND $2::date
      ORDER BY tanggal, jenis
      LIMIT 50`,
    [batas.awal, batas.akhir]
  );
  if (draf.length > 0) {
    masalah.push({
      kode: "dokumen_draf",
      judul: `${draf.length} dokumen masih berstatus draf`,
      tindakan:
        "Posting atau hapus dokumen ini dulu. Setelah periode ditutup, " +
        "draf yang tertinggal tidak akan pernah bisa diposting pada " +
        "tanggalnya sendiri.",
      rincian: draf.map((d) => `${d.tanggal} — ${d.jenis} ${d.doc_no}`),
    });
  }

  return masalah;
}

// ------------------------------------------------------------
// Menutup dan membuka kembali
// ------------------------------------------------------------

export async function tutupPeriode(opts: {
  tahun: number;
  bulan: number;
  penggunaId: string;
  email: string;
}): Promise<{ masalah: Masalah[]; ditutup: boolean }> {
  const { tahun, bulan, penggunaId, email } = opts;

  const sekarang = await statusPeriode(tahun, bulan);
  if (sekarang === "DITUTUP") {
    return {
      ditutup: false,
      masalah: [
        {
          kode: "sudah_ditutup",
          judul: `${labelPeriode(tahun, bulan)} sudah ditutup`,
          tindakan: "Tidak ada yang perlu dilakukan.",
          rincian: [],
        },
      ],
    };
  }

  const masalah = await periksaPenutupan(tahun, bulan);
  if (masalah.length > 0) return { masalah, ditutup: false };

  await tx(async (c) => {
    await c.query(
      `INSERT INTO accounting_period (tahun, bulan, status, ditutup_oleh, ditutup_pada)
       VALUES ($1, $2, 'DITUTUP', $3, now())
       ON CONFLICT (tahun, bulan) DO UPDATE
          SET status = 'DITUTUP', ditutup_oleh = $3, ditutup_pada = now()`,
      [tahun, bulan, penggunaId]
    );
    await c.query(
      `INSERT INTO accounting_period_log (tahun, bulan, aksi, oleh, email)
       VALUES ($1, $2, 'DITUTUP', $3, $4)`,
      [tahun, bulan, penggunaId, email]
    );
  });

  return { masalah: [], ditutup: true };
}

export async function bukaKembaliPeriode(opts: {
  tahun: number;
  bulan: number;
  alasan: string;
  penggunaId: string;
  email: string;
}): Promise<void> {
  const { tahun, bulan, alasan, penggunaId, email } = opts;

  if (!alasan || alasan.trim().length < 10) {
    throw new Error(
      "Alasan membuka kembali wajib diisi, minimal sepuluh huruf. " +
        "Pembukaan kembali adalah jalan terakhir dan harus bisa dijelaskan " +
        "kepada auditor."
    );
  }

  const sekarang = await statusPeriode(tahun, bulan);
  if (sekarang !== "DITUTUP") {
    throw new Error(`${labelPeriode(tahun, bulan)} tidak sedang tertutup.`);
  }

  await tx(async (c) => {
    /*
     * jumlah_dibuka_kembali hanya NAIK. Kolom dibuka_kembali_* akan
     * tertimpa kalau periodenya ditutup lalu dibuka lagi, tetapi
     * penghitung ini tidak pernah turun — sehingga "periode ini pernah
     * dibuka kembali" tetap terbaca selamanya.
     */
    await c.query(
      `UPDATE accounting_period
          SET status = 'TERBUKA',
              dibuka_kembali_oleh = $3,
              dibuka_kembali_pada = now(),
              alasan = $4,
              jumlah_dibuka_kembali = jumlah_dibuka_kembali + 1
        WHERE tahun = $1 AND bulan = $2`,
      [tahun, bulan, penggunaId, alasan.trim()]
    );
    await c.query(
      `INSERT INTO accounting_period_log (tahun, bulan, aksi, oleh, email, alasan)
       VALUES ($1, $2, 'DIBUKA_KEMBALI', $3, $4, $5)`,
      [tahun, bulan, penggunaId, email, alasan.trim()]
    );
  });
}

export type BarisRiwayat = {
  tahun: number;
  bulan: number;
  aksi: string;
  email: string | null;
  nama: string | null;
  alasan: string | null;
  pada: string;
};

export async function riwayatPeriode(
  tahun?: number,
  bulan?: number
): Promise<BarisRiwayat[]> {
  const rows = await query<Record<string, string | null>>(
    `SELECT l.tahun, l.bulan, l.aksi, l.email, u.name AS nama, l.alasan,
            to_char(l.pada, 'YYYY-MM-DD HH24:MI') AS pada
       FROM accounting_period_log l
       LEFT JOIN app_user u ON u.id = l.oleh
      WHERE ($1::int IS NULL OR l.tahun = $1)
        AND ($2::int IS NULL OR l.bulan = $2)
      ORDER BY l.pada DESC
      LIMIT 100`,
    [tahun ?? null, bulan ?? null]
  );
  return rows.map((r) => ({
    tahun: Number(r.tahun),
    bulan: Number(r.bulan),
    aksi: r.aksi as string,
    email: r.email,
    nama: r.nama,
    alasan: r.alasan,
    pada: r.pada as string,
  }));
}

/** Tanggal terawal yang masih boleh dipakai memposting. */
export async function tanggalTerbukaTerawal(): Promise<string | null> {
  const rows = await query<{ d: string }>(
    `SELECT to_char(MIN(make_date(tahun, bulan, 1)), 'YYYY-MM-DD') AS d
       FROM accounting_period WHERE status = 'DITUTUP'`
  );
  if (!rows[0]?.d) return null;
  const [r] = await query<{ d: string }>(
    `SELECT to_char((MAX(make_date(tahun, bulan, 1)) + INTERVAL '1 month')::date,
                    'YYYY-MM-DD') AS d
       FROM accounting_period WHERE status = 'DITUTUP'`
  );
  return r?.d ?? null;
}
