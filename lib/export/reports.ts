import { LABEL_PERIODE, PERIODE, adalahPeriode, type Periode } from "../periode";

/**
 * ============================================================
 * REGISTRY LAPORAN
 * ============================================================
 * Semua laporan berbentuk sama: satu kueri berparameter, satu tabel.
 * Yang membedakan hanya filter, kolom, dan SQL-nya.
 *
 * Karena itu jalur ekspornya ditulis SEKALI (lib/export/xlsx.ts dan
 * app/api/export/[laporan]/route.ts) dan laporan baru cukup didaftarkan
 * di sini. Tidak ada kode ekspor per halaman.
 *
 * Aturan yang dipegang berkas ini:
 *  1. Agregasi dihitung Postgres, tidak pernah di JavaScript.
 *  2. Tanggal keluar sebagai TEKS lewat to_char. Objek Date dari driver
 *     pg pernah menggeser tanggal sehari di zona waktu positif; jangan
 *     dibuka lagi jalannya.
 *  3. Filter divalidasi terhadap skemanya. Nilai yang tidak dikenal
 *     ditolak, bukan dibersihkan diam-diam.
 */

export type TipeKolom = "teks" | "uang" | "qty" | "persen" | "tanggal" | "integer";

export type Kolom = {
  kunci: string;
  judul: string;
  tipe: TipeKolom;
};

/** Bentuk filter yang bisa diminta sebuah laporan. */
export type JenisFilter = "periode" | "teks" | "hari" | "tanggal" | "pilihan";

export type SkemaFilter = {
  nama: string;
  jenis: JenisFilter;
  /** Dipakai untuk jenis "hari". */
  min?: number;
  maks?: number;
  /** Dipakai untuk jenis "pilihan": daftar nilai yang diterima. */
  pilihan?: string[];
  /**
   * Nilai bawaan. Untuk jenis "tanggal" boleh berupa fungsi, karena
   * bawaannya ("hari ini") baru diketahui saat permintaan datang — dan
   * diambil dari DATABASE, bukan dari jam Node.
   */
  bawaan?: string | number;
  label: string;
};

export type NilaiFilter = Record<string, string | number | null>;

export type Kueri = { text: string; values: unknown[] };

/**
 * Penanda jenis baris untuk laporan berjenjang (Neraca, Laba Rugi).
 * Lihat `barisFormula` di bawah.
 */
export const JENIS_BARIS = {
  /** Baris data biasa: angkanya berdiri sendiri. */
  akun: "akun",
  /** Akun yang punya turunan; nilainya subtotal turunannya. */
  header: "header",
  /** Jumlah satu bagian laporan. */
  subtotal: "subtotal",
  /** Selisih antar subtotal, mis. uji keseimbangan atau laba bersih. */
  selisih: "selisih",
} as const;

export type Laporan = {
  nama: string;
  judul: string;
  filter: SkemaFilter[];
  kolom: Kolom[];
  /** Kueri TANPA LIMIT tampilan; batas keras dipasang oleh route handler. */
  sql: (f: NilaiFilter) => Kueri;
  /**
   * Laporan berjenjang: nama kolom yang memuat penanda jenis baris.
   *
   * Bila diisi, penulis XLSX tidak menambahkan baris TOTAL otomatis
   * (menjumlahkan baris akun bersama subtotalnya akan menghitung ganda).
   * Sebagai gantinya:
   *   - baris "header" (akun yang punya turunan) ditulis sebagai
   *     SUBTOTAL(109; ...) atas seluruh baris turunannya;
   *   - baris "subtotal" ditulis sebagai SUBTOTAL(109; ...) atas baris
   *     akun yang berurutan tepat di atasnya. Baris header yang ikut
   *     masuk rentang TIDAK menghitung ganda: Excel dan LibreOffice
   *     mengabaikan SUBTOTAL bersarang di dalam rentang SUBTOTAL;
   *   - baris "selisih" ditulis sebagai subtotal PERTAMA dikurangi semua
   *     subtotal sesudahnya — persis identitas Aset − (Liabilitas +
   *     Ekuitas) pada Neraca dan Pendapatan − Beban pada Laba Rugi.
   * Semuanya formula hidup, bukan angka mati.
   */
  barisFormula?: {
    /** Nama kolom hasil SQL yang memuat penanda jenis baris. */
    kolom: string;
    /**
     * Nama kolom berisi kedalaman akun. Dipakai untuk menentukan rentang
     * turunan sebuah baris "header"; null pada baris yang bukan akun.
     */
    kolomKedalaman?: string;
    /**
     * Kolom persen pada baris formula dihitung ulang dari dua kolom ini
     * pada baris yang sama. Rasio tidak bisa dijumlahkan, jadi SUBTOTAL
     * atasnya akan menghasilkan angka yang terlihat wajar tapi salah.
     */
    persenDari?: { nilai: string; dasar: string };
  };
};

// ------------------------------------------------------------------
// Validasi filter
// ------------------------------------------------------------------

export class FilterTidakSah extends Error {}

const HARI_BULAN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Validasi tanggal tanpa menyentuh objek Date sama sekali.
 *
 * `new Date("2026-02-30")` tidak melempar, ia diam-diam menjadi 2 Maret —
 * tanggal yang salah lolos validasi dan baru terlihat sebagai angka
 * laporan yang aneh berminggu-minggu kemudian.
 */
function tanggalSah(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const th = Number(m[1]);
  const bl = Number(m[2]);
  const hr = Number(m[3]);
  if (th < 1 || bl < 1 || bl > 12 || hr < 1) return false;
  const kabisat = (th % 4 === 0 && th % 100 !== 0) || th % 400 === 0;
  const maks = bl === 2 && kabisat ? 29 : HARI_BULAN[bl - 1];
  return hr <= maks;
}

export function validasiFilter(l: Laporan, mentah: URLSearchParams): NilaiFilter {
  const out: NilaiFilter = {};

  for (const f of l.filter) {
    const v = mentah.get(f.nama);

    if (v === null || v.trim() === "") {
      out[f.nama] = f.bawaan ?? null;
      continue;
    }

    if (f.jenis === "periode") {
      if (!adalahPeriode(v)) {
        throw new FilterTidakSah(
          `Filter "${f.nama}" harus salah satu dari: ${Object.keys(PERIODE).join(", ")}. ` +
            `Diterima "${v}".`
        );
      }
      out[f.nama] = v;
      continue;
    }

    if (f.jenis === "tanggal") {
      if (!tanggalSah(v)) {
        throw new FilterTidakSah(
          `Filter "${f.nama}" harus tanggal berformat YYYY-MM-DD yang benar-benar ada. ` +
            `Diterima "${v}".`
        );
      }
      // Diteruskan sebagai TEKS. Tidak pernah diurai jadi objek Date:
      // new Date("2026-09-20") adalah tengah malam UTC dan bisa bergeser
      // sehari begitu diformat ulang.
      out[f.nama] = v;
      continue;
    }

    if (f.jenis === "pilihan") {
      const sah = f.pilihan ?? [];
      if (!sah.includes(v)) {
        throw new FilterTidakSah(
          `Filter "${f.nama}" harus salah satu dari: ${sah.join(", ")}. Diterima "${v}".`
        );
      }
      out[f.nama] = v;
      continue;
    }

    if (f.jenis === "hari") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < (f.min ?? 1) || n > (f.maks ?? 3650)) {
        throw new FilterTidakSah(
          `Filter "${f.nama}" harus angka antara ${f.min ?? 1} dan ${f.maks ?? 3650}. ` +
            `Diterima "${v}".`
        );
      }
      out[f.nama] = Math.trunc(n);
      continue;
    }

    // teks: dipotong panjangnya, dipakai sebagai parameter terikat saja.
    out[f.nama] = v.trim().slice(0, 100);
  }

  // Parameter yang tidak dikenal ditolak, bukan diabaikan: kalau seseorang
  // mengetik ?gudang=X pada laporan tanpa filter gudang, ia berhak tahu
  // bahwa berkasnya TIDAK tersaring.
  const dikenal = new Set(l.filter.map((f) => f.nama));
  for (const k of mentah.keys()) {
    if (!dikenal.has(k)) {
      throw new FilterTidakSah(
        `Filter "${k}" tidak dikenal untuk laporan "${l.nama}". ` +
          (dikenal.size
            ? `Yang tersedia: ${[...dikenal].join(", ")}.`
            : "Laporan ini tidak menerima filter.")
      );
    }
  }

  return out;
}

/** Ringkasan filter dalam bahasa manusia, untuk header berkas. */
export function ringkasFilter(l: Laporan, f: NilaiFilter): string {
  const bagian: string[] = [];

  for (const s of l.filter) {
    const v = f[s.nama];
    if (v === null || v === undefined || v === "") {
      if (s.jenis === "teks") bagian.push(`semua ${s.label}`);
      continue;
    }
    if (s.jenis === "periode") {
      bagian.push(`Periode ${LABEL_PERIODE[v as Periode]}`);
    } else if (s.jenis === "tanggal" || s.jenis === "pilihan") {
      bagian.push(`${s.label} ${v}`);
    } else if (s.jenis === "hari") {
      bagian.push(`${s.label} ${v} hari`);
    } else {
      bagian.push(`${s.label}: ${v}`);
    }
  }

  return bagian.length ? bagian.join(", ") : "Tanpa filter";
}

/** Ekspresi rentang dari periode. Nilainya sudah divalidasi lebih dulu. */
function rentang(f: NilaiFilter, nama = "periode") {
  const p = f[nama];
  const e = adalahPeriode(p) ? PERIODE[p] : PERIODE.tahun_ini;
  return e;
}

// ------------------------------------------------------------------
// Laporan
// ------------------------------------------------------------------

const F_PERIODE: SkemaFilter = {
  nama: "periode",
  jenis: "periode",
  bawaan: "tahun_ini",
  label: "periode",
};
const F_GUDANG: SkemaFilter = { nama: "gudang", jenis: "teks", label: "gudang" };
const F_SKU: SkemaFilter = { nama: "sku", jenis: "teks", label: "barang" };
const F_PEMASOK: SkemaFilter = { nama: "pemasok", jenis: "teks", label: "pemasok" };
const F_PELANGGAN: SkemaFilter = {
  nama: "pelanggan",
  jenis: "teks",
  label: "pelanggan",
};

const pola = (v: unknown) =>
  v === null || v === undefined || v === ""
    ? null
    : "%" + String(v).replace(/([\\%_])/g, "\\$1") + "%";

/**
 * Filter tanggal untuk laporan keuangan.
 *
 * Bawaannya sengaja KOSONG, bukan tanggal hari ini yang dihitung di sini:
 * "hari ini" milik database, bukan milik jam proses Node. Route handler
 * yang mengisinya dari CURRENT_DATE saat permintaan datang.
 */
const F_PER_TANGGAL: SkemaFilter = {
  nama: "per",
  jenis: "tanggal",
  label: "Per tanggal",
};
const F_BANDING_TANGGAL: SkemaFilter = {
  nama: "banding",
  jenis: "tanggal",
  label: "Dibandingkan dengan",
};
const F_DARI: SkemaFilter = { nama: "dari", jenis: "tanggal", label: "Dari" };
const F_SAMPAI: SkemaFilter = { nama: "sampai", jenis: "tanggal", label: "Sampai" };
const F_BANDING_SATUAN: SkemaFilter = {
  nama: "banding",
  jenis: "pilihan",
  pilihan: ["bulan", "tahun"],
  bawaan: "bulan",
  label: "Dibandingkan dengan periode yang sama",
};

/** Indentasi nama akun mengikuti kedalamannya di pohon. */
const INDEN = "repeat('    ', a.kedalaman) || a.name";

/**
 * Total satu jenis akun: dijumlahkan dari akun AKAR saja.
 *
 * Akun turunan sudah ikut terhitung di dalam saldo akarnya (lihat CTE
 * `gabungan`), jadi menjumlahkan seluruh baris akan menghitung ganda
 * begitu bagan akunnya bertingkat.
 */
const TOTAL_AKAR = (tipe: string, kol: string) =>
  `COALESCE((SELECT ${kol} FROM akar WHERE type = '${tipe}'), 0)`;

/**
 * Penanda jenis baris untuk sebuah akun.
 *
 * Akun yang punya turunan adalah SUBTOTAL, bukan data: nilainya sudah
 * memuat seluruh anaknya. Kalau ia ditandai 'akun', rentang SUBTOTAL di
 * atasnya akan menjumlahkan header BERSAMA anak-anaknya dan setiap angka
 * di laporan menjadi dua kali lipat.
 */
const JENIS_AKUN = "CASE WHEN a.punya_anak THEN 'header' ELSE 'akun' END";

/**
 * CTE bersama untuk laporan keuangan: saldo setiap akun pada dua periode
 * sekaligus, lengkap dengan rollup turunan dan jalur pohonnya.
 *
 * `p1` dan `p2` adalah predikat tanggal untuk periode utama dan periode
 * pembanding. Rollup memakai recursive CTE, BUKAN asumsi dua tingkat:
 * akun header boleh punya cucu dan cicit.
 */
function cteSaldo(p1: string, p2: string): string {
  return `
    gerak AS (
      SELECT l.account_id,
             SUM(CASE WHEN ${p1} THEN l.debit  ELSE 0 END) AS d1,
             SUM(CASE WHEN ${p1} THEN l.credit ELSE 0 END) AS k1,
             SUM(CASE WHEN ${p2} THEN l.debit  ELSE 0 END) AS d2,
             SUM(CASE WHEN ${p2} THEN l.credit ELSE 0 END) AS k2
        FROM journal_line l
        JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
       WHERE (${p1}) OR (${p2})
       GROUP BY l.account_id
    ),
    sendiri AS (
      SELECT a.id, a.type,
             -- Konvensi tanda diterapkan SEKALI, di sini. ASSET dan EXPENSE
             -- bersaldo normal debit; LIABILITY, EQUITY dan REVENUE kredit.
             CASE WHEN a.type IN ('ASSET', 'EXPENSE')
                  THEN COALESCE(g.d1, 0) - COALESCE(g.k1, 0)
                  ELSE COALESCE(g.k1, 0) - COALESCE(g.d1, 0) END AS s1,
             CASE WHEN a.type IN ('ASSET', 'EXPENSE')
                  THEN COALESCE(g.d2, 0) - COALESCE(g.k2, 0)
                  ELSE COALESCE(g.k2, 0) - COALESCE(g.d2, 0) END AS s2
        FROM account a
        LEFT JOIN gerak g ON g.account_id = a.id
    ),
    turunan AS (
      SELECT id AS akar, id AS simpul FROM account
      UNION ALL
      SELECT t.akar, a.id
        FROM turunan t JOIN account a ON a.parent_id = t.simpul
    ),
    gabungan AS (
      SELECT t.akar AS id, SUM(s.s1) AS s1, SUM(s.s2) AS s2
        FROM turunan t JOIN sendiri s ON s.id = t.simpul
       GROUP BY t.akar
    ),
    pohon AS (
      SELECT a.id, a.code, a.name, a.type, 0 AS kedalaman, a.code::text AS jalur
        FROM account a WHERE a.parent_id IS NULL
      UNION ALL
      SELECT a.id, a.code, a.name, a.type, p.kedalaman + 1, p.jalur || '/' || a.code
        FROM pohon p JOIN account a ON a.parent_id = p.id
    ),
    akar AS (
      SELECT a.type, ROUND(SUM(gb.s1), 2) AS s1, ROUND(SUM(gb.s2), 2) AS s2
        FROM account a JOIN gabungan gb ON gb.id = a.id
       WHERE a.parent_id IS NULL
       GROUP BY a.type
    ),
    akun AS (
      SELECT p.type, p.code, p.name, p.kedalaman, p.jalur,
             EXISTS (SELECT 1 FROM account c WHERE c.parent_id = p.id) AS punya_anak,
             ROUND(gb.s1, 2) AS s1, ROUND(gb.s2, 2) AS s2
        FROM pohon p JOIN gabungan gb ON gb.id = p.id
       -- Akun yang nol di KEDUA periode tidak ditampilkan; akun yang nol di
       -- salah satunya tetap muncul supaya perubahannya terlihat.
       WHERE gb.s1 <> 0 OR gb.s2 <> 0
    )`;
}

export const LAPORAN: Laporan[] = [
  {
    nama: "saldo_stok",
    judul: "Saldo stok",
    filter: [F_SKU, F_GUDANG],
    kolom: [
      { kunci: "sku", judul: "SKU", tipe: "teks" },
      { kunci: "barang", judul: "Barang", tipe: "teks" },
      { kunci: "kode_gudang", judul: "Kode gudang", tipe: "teks" },
      { kunci: "gudang", judul: "Gudang", tipe: "teks" },
      { kunci: "qty", judul: "Kuantitas", tipe: "qty" },
      { kunci: "satuan", judul: "Satuan", tipe: "teks" },
      { kunci: "biaya_rata_rata", judul: "Biaya rata-rata", tipe: "uang" },
      { kunci: "nilai", judul: "Nilai", tipe: "uang" },
    ],
    sql: (f) => ({
      text: `SELECT p.sku, p.name AS barang, w.code AS kode_gudang, w.name AS gudang,
                    b.qty_on_hand AS qty, u.code AS satuan,
                    CASE WHEN b.qty_on_hand <> 0
                         THEN ROUND(b.stock_value / b.qty_on_hand, 2) END AS biaya_rata_rata,
                    b.stock_value AS nilai
               FROM v_stock_balance b
               JOIN product   p ON p.id = b.product_id
               JOIN uom       u ON u.id = p.base_uom_id
               JOIN warehouse w ON w.id = b.warehouse_id
              WHERE ($1::text IS NULL OR p.sku ILIKE $1 OR p.name ILIKE $1)
                AND ($2::text IS NULL OR w.code ILIKE $2 OR w.name ILIKE $2)
              ORDER BY p.sku, w.code`,
      values: [pola(f.sku), pola(f.gudang)],
    }),
  },

  {
    nama: "umur_piutang",
    judul: "Umur piutang",
    filter: [F_PELANGGAN],
    kolom: [
      { kunci: "kode", judul: "Kode", tipe: "teks" },
      { kunci: "pelanggan", judul: "Pelanggan", tipe: "teks" },
      { kunci: "total_piutang", judul: "Total piutang", tipe: "uang" },
      { kunci: "umur_0_30", judul: "0-30 hari", tipe: "uang" },
      { kunci: "umur_31_60", judul: "31-60 hari", tipe: "uang" },
      { kunci: "umur_61_90", judul: "61-90 hari", tipe: "uang" },
      { kunci: "umur_di_atas_90", judul: "Di atas 90 hari", tipe: "uang" },
    ],
    sql: (f) => ({
      text: `WITH umur AS (
               -- SISA tagihan, bukan nilai faktur: sumber yang sama dengan
               -- alat AI dan grafik umur piutang.
               SELECT o.customer_id, o.sisa AS total, o.hari_lewat AS hari
                 FROM v_invoice_outstanding o
                WHERE o.sisa > 0
             )
             SELECT p.code AS kode, p.name AS pelanggan,
                    ROUND(SUM(u.total), 2) AS total_piutang,
                    ROUND(SUM(CASE WHEN u.hari <= 30 THEN u.total ELSE 0 END), 2) AS umur_0_30,
                    ROUND(SUM(CASE WHEN u.hari BETWEEN 31 AND 60 THEN u.total ELSE 0 END), 2) AS umur_31_60,
                    ROUND(SUM(CASE WHEN u.hari BETWEEN 61 AND 90 THEN u.total ELSE 0 END), 2) AS umur_61_90,
                    ROUND(SUM(CASE WHEN u.hari > 90 THEN u.total ELSE 0 END), 2) AS umur_di_atas_90
               FROM umur u
               JOIN partner p ON p.id = u.customer_id
              WHERE ($1::text IS NULL OR p.code ILIKE $1 OR p.name ILIKE $1)
              GROUP BY p.id, p.code, p.name
             HAVING SUM(u.total) <> 0
              ORDER BY total_piutang DESC`,
      values: [pola(f.pelanggan)],
    }),
  },

  {
    nama: "kartu_stok",
    judul: "Kartu stok",
    filter: [F_SKU, F_GUDANG, F_PERIODE],
    kolom: [
      { kunci: "waktu", judul: "Waktu", tipe: "teks" },
      { kunci: "sku", judul: "SKU", tipe: "teks" },
      { kunci: "gudang", judul: "Gudang", tipe: "teks" },
      { kunci: "jenis", judul: "Jenis", tipe: "teks" },
      { kunci: "qty", judul: "Kuantitas", tipe: "qty" },
      { kunci: "satuan", judul: "Satuan", tipe: "teks" },
      { kunci: "biaya_satuan", judul: "Biaya satuan", tipe: "uang" },
      { kunci: "saldo_qty", judul: "Saldo kuantitas", tipe: "qty" },
      { kunci: "saldo_nilai", judul: "Saldo nilai", tipe: "uang" },
      { kunci: "jurnal", judul: "Jurnal", tipe: "teks" },
    ],
    sql: (f) => {
      const r = rentang(f);
      return {
        text: `SELECT to_char(s.posted_at, 'YYYY-MM-DD HH24:MI') AS waktu,
                      p.sku, w.code AS gudang, s.movement_type AS jenis,
                      s.qty, u.code AS satuan, s.unit_cost AS biaya_satuan,
                      s.running_qty AS saldo_qty, s.running_value AS saldo_nilai,
                      j.entry_no AS jurnal
                 FROM stock_ledger s
                 JOIN product   p ON p.id = s.product_id
                 JOIN uom       u ON u.id = p.base_uom_id
                 JOIN warehouse w ON w.id = s.warehouse_id
                 LEFT JOIN journal_entry j ON j.id = s.journal_entry_id
                WHERE ($1::text IS NULL OR p.sku ILIKE $1)
                  AND ($2::text IS NULL OR w.code ILIKE $2 OR w.name ILIKE $2)
                  AND s.posted_at >= (${r.dari})::date
                  AND s.posted_at <  (${r.sampai})::date + 1
                ORDER BY s.id`,
        values: [pola(f.sku), pola(f.gudang)],
      };
    },
  },

  {
    nama: "ringkasan_penjualan",
    judul: "Ringkasan penjualan per pelanggan",
    filter: [F_PERIODE],
    kolom: [
      { kunci: "kode_pelanggan", judul: "Kode", tipe: "teks" },
      { kunci: "pelanggan", judul: "Pelanggan", tipe: "teks" },
      { kunci: "subtotal", judul: "Subtotal", tipe: "uang" },
      { kunci: "hpp", judul: "HPP", tipe: "uang" },
      { kunci: "margin", judul: "Margin", tipe: "uang" },
      { kunci: "margin_persen", judul: "Margin %", tipe: "persen" },
    ],
    sql: (f) => {
      const r = rentang(f);
      return {
        text: `WITH inv AS (
                 SELECT id, customer_id FROM sales_invoice
                  WHERE status = 'POSTED'
                    AND doc_date BETWEEN (${r.dari})::date AND (${r.sampai})::date
               ),
               baris AS (
                 SELECT i.id AS invoice_id, i.customer_id, l.product_id,
                        (l.qty * l.unit_price) AS pendapatan
                   FROM inv i JOIN sales_invoice_line l ON l.invoice_id = i.id
               ),
               hpp AS (
                 SELECT s.source_id AS invoice_id, s.product_id,
                        SUM(-s.qty * s.unit_cost) AS hpp
                   FROM stock_ledger s
                  WHERE s.source_type = 'SALES_INVOICE'
                    AND s.source_id IN (SELECT id FROM inv)
                  GROUP BY s.source_id, s.product_id
               ),
               g AS (
                 SELECT b.*, COALESCE(h.hpp, 0) AS hpp
                   FROM baris b
                   LEFT JOIN hpp h ON h.invoice_id = b.invoice_id
                                  AND h.product_id = b.product_id
               )
               SELECT p.code AS kode_pelanggan, p.name AS pelanggan,
                      ROUND(SUM(g.pendapatan), 2) AS subtotal,
                      ROUND(SUM(g.hpp), 2)        AS hpp,
                      ROUND(SUM(g.pendapatan) - SUM(g.hpp), 2) AS margin,
                      CASE WHEN SUM(g.pendapatan) > 0
                           THEN ROUND((SUM(g.pendapatan) - SUM(g.hpp)) / SUM(g.pendapatan), 4)
                      END AS margin_persen
                 FROM g JOIN partner p ON p.id = g.customer_id
                GROUP BY p.id, p.code, p.name
                ORDER BY subtotal DESC`,
        values: [],
      };
    },
  },

  {
    nama: "batch_kedaluwarsa",
    judul: "Batch mendekati kedaluwarsa",
    filter: [{ nama: "hari", jenis: "hari", bawaan: 90, min: 1, maks: 3650, label: "Ambang" }],
    kolom: [
      { kunci: "sku", judul: "SKU", tipe: "teks" },
      { kunci: "barang", judul: "Barang", tipe: "teks" },
      { kunci: "gudang", judul: "Gudang", tipe: "teks" },
      { kunci: "batch_no", judul: "Batch", tipe: "teks" },
      { kunci: "kedaluwarsa", judul: "Kedaluwarsa", tipe: "tanggal" },
      { kunci: "sisa_hari", judul: "Sisa hari", tipe: "integer" },
      { kunci: "qty", judul: "Kuantitas", tipe: "qty" },
      { kunci: "satuan", judul: "Satuan", tipe: "teks" },
    ],
    sql: (f) => ({
      text: `SELECT p.sku, p.name AS barang, w.name AS gudang, fe.batch_no,
                    to_char(fe.expiry_date, 'YYYY-MM-DD') AS kedaluwarsa,
                    fe.days_to_expiry AS sisa_hari,
                    fe.qty_on_hand AS qty, u.code AS satuan
               FROM v_stock_fefo fe
               JOIN product   p ON p.id = fe.product_id
               JOIN uom       u ON u.id = p.base_uom_id
               JOIN warehouse w ON w.id = fe.warehouse_id
              WHERE fe.expiry_date IS NOT NULL AND fe.days_to_expiry <= $1
              ORDER BY fe.days_to_expiry`,
      values: [f.hari ?? 90],
    }),
  },

  {
    nama: "stok_mengendap",
    judul: "Stok mengendap",
    filter: [{ nama: "hari", jenis: "hari", bawaan: 60, min: 1, maks: 3650, label: "Tanpa pergerakan" }],
    kolom: [
      { kunci: "sku", judul: "SKU", tipe: "teks" },
      { kunci: "barang", judul: "Barang", tipe: "teks" },
      { kunci: "qty", judul: "Kuantitas", tipe: "qty" },
      { kunci: "nilai", judul: "Nilai", tipe: "uang" },
      { kunci: "keluar_terakhir", judul: "Keluar terakhir", tipe: "tanggal" },
    ],
    sql: (f) => ({
      text: `SELECT p.sku, p.name AS barang,
                    b.qty_on_hand AS qty, b.stock_value AS nilai,
                    to_char(k.keluar_terakhir, 'YYYY-MM-DD') AS keluar_terakhir
               FROM (SELECT product_id, SUM(qty_on_hand) AS qty_on_hand,
                            SUM(stock_value) AS stock_value
                       FROM v_stock_balance GROUP BY product_id) b
               JOIN product p ON p.id = b.product_id
               LEFT JOIN (SELECT product_id, MAX(posted_at) AS keluar_terakhir
                            FROM stock_ledger WHERE qty < 0 GROUP BY product_id) k
                 ON k.product_id = p.id
              WHERE b.qty_on_hand > 0
                AND COALESCE(k.keluar_terakhir, '1900-01-01'::timestamptz)
                    < now() - ($1 || ' days')::interval
              ORDER BY b.stock_value DESC`,
      values: [f.hari ?? 60],
    }),
  },

  {
    nama: "daftar_penerimaan",
    judul: "Daftar penerimaan barang",
    filter: [F_PERIODE],
    kolom: [
      { kunci: "nomor", judul: "Nomor", tipe: "teks" },
      { kunci: "tanggal", judul: "Tanggal", tipe: "tanggal" },
      { kunci: "pemasok", judul: "Pemasok", tipe: "teks" },
      { kunci: "gudang", judul: "Gudang", tipe: "teks" },
      { kunci: "surat_jalan", judul: "Surat jalan", tipe: "teks" },
      { kunci: "status", judul: "Status", tipe: "teks" },
      { kunci: "nilai", judul: "Nilai", tipe: "uang" },
    ],
    sql: (f) => {
      const r = rentang(f);
      return {
        text: `SELECT g.doc_no AS nomor, to_char(g.doc_date, 'YYYY-MM-DD') AS tanggal,
                      p.name AS pemasok, w.name AS gudang,
                      g.supplier_ref AS surat_jalan, g.status::text AS status,
                      g.total_value AS nilai
                 FROM goods_receipt g
                 JOIN partner   p ON p.id = g.supplier_id
                 JOIN warehouse w ON w.id = g.warehouse_id
                WHERE g.doc_date BETWEEN (${r.dari})::date AND (${r.sampai})::date
                ORDER BY g.doc_date DESC, g.doc_no`,
        values: [],
      };
    },
  },

  {
    nama: "daftar_faktur",
    judul: "Daftar faktur penjualan",
    filter: [F_PERIODE],
    kolom: [
      { kunci: "nomor", judul: "Nomor", tipe: "teks" },
      { kunci: "tanggal", judul: "Tanggal", tipe: "tanggal" },
      { kunci: "jatuh_tempo", judul: "Jatuh tempo", tipe: "tanggal" },
      { kunci: "pelanggan", judul: "Pelanggan", tipe: "teks" },
      { kunci: "status", judul: "Status", tipe: "teks" },
      { kunci: "subtotal", judul: "Subtotal", tipe: "uang" },
      { kunci: "ppn", judul: "PPN", tipe: "uang" },
      { kunci: "total", judul: "Total", tipe: "uang" },
      { kunci: "hpp", judul: "HPP", tipe: "uang" },
    ],
    sql: (f) => {
      const r = rentang(f);
      return {
        text: `SELECT s.doc_no AS nomor, to_char(s.doc_date, 'YYYY-MM-DD') AS tanggal,
                      to_char(s.due_date, 'YYYY-MM-DD') AS jatuh_tempo,
                      p.name AS pelanggan, s.status::text AS status,
                      s.subtotal, s.tax_amount AS ppn, s.total,
                      s.cogs_amount AS hpp
                 FROM sales_invoice s
                 JOIN partner p ON p.id = s.customer_id
                WHERE s.doc_date BETWEEN (${r.dari})::date AND (${r.sampai})::date
                ORDER BY s.doc_date DESC, s.doc_no`,
        values: [],
      };
    },
  },

  {
    nama: "jurnal",
    judul: "Jurnal umum",
    filter: [F_PERIODE],
    kolom: [
      { kunci: "jurnal", judul: "Nomor jurnal", tipe: "teks" },
      { kunci: "tanggal", judul: "Tanggal", tipe: "tanggal" },
      { kunci: "keterangan", judul: "Keterangan", tipe: "teks" },
      { kunci: "kode_akun", judul: "Kode akun", tipe: "teks" },
      { kunci: "akun", judul: "Akun", tipe: "teks" },
      { kunci: "mitra", judul: "Mitra", tipe: "teks" },
      { kunci: "debit", judul: "Debit", tipe: "uang" },
      { kunci: "kredit", judul: "Kredit", tipe: "uang" },
    ],
    sql: (f) => {
      const r = rentang(f);
      return {
        text: `SELECT j.entry_no AS jurnal, to_char(j.entry_date, 'YYYY-MM-DD') AS tanggal,
                      j.description AS keterangan,
                      a.code AS kode_akun, a.name AS akun,
                      pt.name AS mitra, l.debit, l.credit AS kredit
                 FROM journal_entry j
                 JOIN journal_line l ON l.entry_id = j.id
                 JOIN account a      ON a.id = l.account_id
                 LEFT JOIN partner pt ON pt.id = l.partner_id
                WHERE j.is_posted
                  AND j.entry_date BETWEEN (${r.dari})::date AND (${r.sampai})::date
                ORDER BY j.entry_date, j.entry_no, l.debit DESC, a.code`,
        values: [],
      };
    },
  },

  // ------------------------------------------------------------------
  // Laporan keuangan berjenjang
  // ------------------------------------------------------------------
  //
  // Kedua laporan di bawah memakai CTE yang sama (cteSaldo) dan hanya
  // berbeda pada dua hal: predikat tanggalnya dan bagian mana yang
  // ditampilkan. Neraca membatasi dengan "<= tanggal" (akumulasi sejak
  // awal), Laba Rugi dengan "BETWEEN dari AND sampai" (pergerakan).
  // Tertukarnya dua predikat inilah yang membuat neraca tidak seimbang,
  // jadi keduanya ditulis berdampingan supaya bedanya terlihat.

  {
    nama: "neraca",
    judul: "Neraca",
    filter: [F_PER_TANGGAL, F_BANDING_TANGGAL],
    barisFormula: {
      kolom: "jenis",
      kolomKedalaman: "kedalaman",
      persenDari: { nilai: "saldo", dasar: "pembanding" },
    },
    kolom: [
      { kunci: "bagian", judul: "Bagian", tipe: "teks" },
      { kunci: "kode", judul: "Kode", tipe: "teks" },
      { kunci: "akun", judul: "Akun", tipe: "teks" },
      { kunci: "saldo", judul: "Saldo", tipe: "uang" },
      { kunci: "pembanding", judul: "Pembanding", tipe: "uang" },
      { kunci: "selisih", judul: "Selisih", tipe: "uang" },
      { kunci: "selisih_persen", judul: "Selisih %", tipe: "persen" },
    ],
    sql: (f) => {
      // Bawaan diisi oleh DATABASE lewat COALESCE, bukan oleh jam Node:
      // per tanggal = hari ini, pembanding = akhir bulan lalu.
      const per = "COALESCE($1::date, CURRENT_DATE)";
      const bnd =
        "COALESCE($2::date, (date_trunc('month', CURRENT_DATE) - INTERVAL '1 day')::date)";
      return {
      text: `WITH RECURSIVE ${cteSaldo(
        `e.entry_date <= ${per}`,
        `e.entry_date <= ${bnd}`
      )},
             /*
              * Laba periode berjalan = SUM(credit - debit) atas REVENUE dan
              * EXPENSE sejak awal tahun buku. Terlihat menyederhanakan, tapi
              * memang begitu: pendapatan bersaldo normal kredit sehingga
              * (credit - debit) positif, dan beban bersaldo normal debit
              * sehingga (credit - debit) otomatis bertanda negatif. Satu
              * ekspresi sudah berarti "pendapatan dikurangi beban".
              */
             laba AS (
               SELECT ROUND(COALESCE(SUM(CASE
                        WHEN e.entry_date >= date_trunc('year', ${per})
                         AND e.entry_date <= ${per}
                        THEN l.credit - l.debit END), 0), 2) AS s1,
                      ROUND(COALESCE(SUM(CASE
                        WHEN e.entry_date >= date_trunc('year', ${bnd})
                         AND e.entry_date <= ${bnd}
                        THEN l.credit - l.debit END), 0), 2) AS s2,
                      -- Hasil periode SEBELUM tahun buku berjalan. Tanpa
                      -- jurnal penutup, laba tahun lalu tidak pernah pindah
                      -- ke akun ekuitas; kalau barisnya dihilangkan, neraca
                      -- tampak timpang persis sebesar laba tahun lalu.
                      ROUND(COALESCE(SUM(CASE
                        WHEN e.entry_date < date_trunc('year', ${per})
                        THEN l.credit - l.debit END), 0), 2) AS d1,
                      ROUND(COALESCE(SUM(CASE
                        WHEN e.entry_date < date_trunc('year', ${bnd})
                        THEN l.credit - l.debit END), 0), 2) AS d2
                 FROM journal_line l
                 JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
                 JOIN account a       ON a.id = l.account_id
                WHERE a.type IN ('REVENUE', 'EXPENSE')
                  AND e.entry_date <= GREATEST(${per}, ${bnd})
             ),
             baris AS (
               SELECT 1 AS g, 1 AS u2, a.jalur AS u3, 'Aset' AS bagian,
                      a.code AS kode, ${INDEN} AS akun,
                      ${JENIS_AKUN} AS jenis, a.kedalaman AS kedalaman,
                      a.s1 AS saldo, a.s2 AS pembanding
                 FROM akun a WHERE a.type = 'ASSET'
               UNION ALL
               SELECT 1, 2, '', 'Aset', NULL, 'Total aset', 'subtotal', NULL,
                      ${TOTAL_AKAR("ASSET", "s1")}, ${TOTAL_AKAR("ASSET", "s2")}

               UNION ALL
               SELECT 2, 1, a.jalur, 'Liabilitas', a.code, ${INDEN},
                      ${JENIS_AKUN}, a.kedalaman, a.s1, a.s2
                 FROM akun a WHERE a.type = 'LIABILITY'
               UNION ALL
               SELECT 2, 2, '', 'Liabilitas', NULL, 'Total liabilitas', 'subtotal', NULL,
                      ${TOTAL_AKAR("LIABILITY", "s1")}, ${TOTAL_AKAR("LIABILITY", "s2")}

               UNION ALL
               SELECT 3, 1, a.jalur, 'Ekuitas', a.code, ${INDEN},
                      ${JENIS_AKUN}, a.kedalaman, a.s1, a.s2
                 FROM akun a WHERE a.type = 'EQUITY'
               UNION ALL
               -- Laba berjalan ditandai 'akun', bukan 'subtotal': ia baris
               -- bernilai sendiri dan HARUS ikut terjumlah ke dalam total
               -- ekuitas. Tanpa baris ini neraca tidak akan pernah nol.
               SELECT 3, 2, '', 'Ekuitas', NULL,
                      'Laba ditahan (belum ditutup ke ekuitas)', 'akun', NULL,
                      (SELECT d1 FROM laba), (SELECT d2 FROM laba)
               UNION ALL
               SELECT 3, 3, '', 'Ekuitas', NULL, 'Laba periode berjalan', 'akun', NULL,
                      (SELECT s1 FROM laba), (SELECT s2 FROM laba)
               UNION ALL
               SELECT 3, 4, '', 'Ekuitas', NULL,
                      'Total ekuitas termasuk laba', 'subtotal', NULL,
                      ${TOTAL_AKAR("EQUITY", "s1")} + (SELECT s1 + d1 FROM laba),
                      ${TOTAL_AKAR("EQUITY", "s2")} + (SELECT s2 + d2 FROM laba)

               UNION ALL
               SELECT 4, 1, '', 'Uji keseimbangan', NULL,
                      'Aset dikurangi liabilitas dan ekuitas (harus nol)', 'selisih', NULL,
                      ${TOTAL_AKAR("ASSET", "s1")} - ${TOTAL_AKAR("LIABILITY", "s1")}
                        - ${TOTAL_AKAR("EQUITY", "s1")} - (SELECT s1 + d1 FROM laba),
                      ${TOTAL_AKAR("ASSET", "s2")} - ${TOTAL_AKAR("LIABILITY", "s2")}
                        - ${TOTAL_AKAR("EQUITY", "s2")} - (SELECT s2 + d2 FROM laba)
             )
             SELECT bagian, kode, akun, jenis, kedalaman, saldo, pembanding,
                    (saldo - pembanding) AS selisih,
                    CASE WHEN pembanding <> 0
                         THEN ROUND((saldo - pembanding) / ABS(pembanding), 4)
                    END AS selisih_persen
               FROM baris
              ORDER BY g, u2, u3`,
      values: [f.per, f.banding],
      };
    },
  },

  {
    nama: "laba_rugi",
    judul: "Laba Rugi",
    filter: [F_DARI, F_SAMPAI, F_BANDING_SATUAN],
    barisFormula: {
      kolom: "jenis",
      kolomKedalaman: "kedalaman",
      persenDari: { nilai: "saldo", dasar: "pembanding" },
    },
    kolom: [
      { kunci: "bagian", judul: "Bagian", tipe: "teks" },
      { kunci: "kode", judul: "Kode", tipe: "teks" },
      { kunci: "akun", judul: "Akun", tipe: "teks" },
      { kunci: "saldo", judul: "Periode", tipe: "uang" },
      { kunci: "pembanding", judul: "Pembanding", tipe: "uang" },
      { kunci: "selisih", judul: "Selisih", tipe: "uang" },
      { kunci: "selisih_persen", judul: "Selisih %", tipe: "persen" },
    ],
    sql: (f) => {
      // Rentang pembanding digeser oleh Postgres, bukan aritmetika tanggal
      // di JavaScript: pergeseran bulan harus menghormati panjang bulan dan
      // tahun kabisat. Satuannya ditempel sebagai literal interval, bukan
      // parameter terikat: Postgres tidak menerima parameter di posisi itu.
      const geser = f.banding === "tahun" ? "1 year" : "1 month";
      const dari = "COALESCE($1::date, date_trunc('month', CURRENT_DATE)::date)";
      const sampai = "COALESCE($2::date, CURRENT_DATE)";
      return {
        text: `WITH RECURSIVE ${cteSaldo(
          `e.entry_date BETWEEN ${dari} AND ${sampai}`,
          `e.entry_date BETWEEN (${dari} - INTERVAL '${geser}')::date
                            AND (${sampai} - INTERVAL '${geser}')::date`
        )},
               baris AS (
                 SELECT 1 AS g, 1 AS u2, a.jalur AS u3, 'Pendapatan' AS bagian,
                        a.code AS kode, ${INDEN} AS akun,
                        ${JENIS_AKUN} AS jenis, a.kedalaman AS kedalaman,
                        a.s1 AS saldo, a.s2 AS pembanding
                   FROM akun a WHERE a.type = 'REVENUE'
                 UNION ALL
                 SELECT 1, 2, '', 'Pendapatan', NULL, 'Total pendapatan', 'subtotal', NULL,
                        ${TOTAL_AKAR("REVENUE", "s1")}, ${TOTAL_AKAR("REVENUE", "s2")}

                 UNION ALL
                 SELECT 2, 1, a.jalur, 'Beban', a.code, ${INDEN},
                        ${JENIS_AKUN}, a.kedalaman, a.s1, a.s2
                   FROM akun a WHERE a.type = 'EXPENSE'
                 UNION ALL
                 SELECT 2, 2, '', 'Beban', NULL, 'Total beban', 'subtotal', NULL,
                        ${TOTAL_AKAR("EXPENSE", "s1")}, ${TOTAL_AKAR("EXPENSE", "s2")}

                 UNION ALL
                 SELECT 3, 1, '', 'Hasil', NULL, 'Laba bersih', 'selisih', NULL,
                        ${TOTAL_AKAR("REVENUE", "s1")} - ${TOTAL_AKAR("EXPENSE", "s1")},
                        ${TOTAL_AKAR("REVENUE", "s2")} - ${TOTAL_AKAR("EXPENSE", "s2")}
               )
               SELECT bagian, kode, akun, jenis, kedalaman, saldo, pembanding,
                      (saldo - pembanding) AS selisih,
                      CASE WHEN pembanding <> 0
                           THEN ROUND((saldo - pembanding) / ABS(pembanding), 4)
                      END AS selisih_persen
                 FROM baris
                ORDER BY g, u2, u3`,
        values: [f.dari, f.sampai],
      };
    },
  },

  {
    nama: "pelunasan",
    judul: "Penerimaan pembayaran",
    filter: [F_PERIODE, F_PELANGGAN],
    kolom: [
      { kunci: "tanggal", judul: "Tanggal", tipe: "tanggal" },
      { kunci: "nomor", judul: "Nomor", tipe: "teks" },
      { kunci: "kode_pelanggan", judul: "Kode", tipe: "teks" },
      { kunci: "pelanggan", judul: "Pelanggan", tipe: "teks" },
      { kunci: "cara", judul: "Cara bayar", tipe: "teks" },
      { kunci: "referensi", judul: "Referensi", tipe: "teks" },
      { kunci: "faktur", judul: "Faktur", tipe: "teks" },
      { kunci: "nilai_faktur", judul: "Nilai faktur", tipe: "uang" },
      { kunci: "dialokasikan", judul: "Dialokasikan", tipe: "uang" },
    ],
    sql: (f) => {
      const r = rentang(f);
      return {
        /*
         * Satu baris per ALOKASI, bukan per pembayaran: itulah bentuk
         * yang bisa dicocokkan dengan buku besar pembantu piutang.
         *
         * Bagian pembayaran yang belum punya faktur tetap muncul, sebagai
         * baris dengan faktur "(titipan pelanggan)" — kalau dihilangkan,
         * jumlah kolom Dialokasikan tidak akan sama dengan uang yang
         * benar-benar diterima, dan orang akan mengira ada yang hilang.
         */
        text: `SELECT to_char(p.doc_date, 'YYYY-MM-DD') AS tanggal,
                      p.doc_no AS nomor, c.code AS kode_pelanggan, c.name AS pelanggan,
                      p.method AS cara, p.reference AS referensi,
                      i.doc_no AS faktur, i.total AS nilai_faktur,
                      a.amount AS dialokasikan
                 FROM payment_allocation a
                 JOIN payment_receipt p ON p.id = a.payment_id
                 JOIN sales_invoice  i ON i.id = a.invoice_id
                 JOIN partner c ON c.id = p.customer_id
                WHERE p.status = 'POSTED'
                  AND p.doc_date BETWEEN (${r.dari})::date AND (${r.sampai})::date
                  AND ($1::text IS NULL OR c.code ILIKE $1 OR c.name ILIKE $1)
               UNION ALL
               SELECT to_char(p.doc_date, 'YYYY-MM-DD'), p.doc_no, c.code, c.name,
                      p.method, p.reference,
                      '(titipan pelanggan)', NULL, p.unallocated
                 FROM payment_receipt p
                 JOIN partner c ON c.id = p.customer_id
                WHERE p.status = 'POSTED' AND p.unallocated > 0
                  AND p.doc_date BETWEEN (${r.dari})::date AND (${r.sampai})::date
                  AND ($1::text IS NULL OR c.code ILIKE $1 OR c.name ILIKE $1)
                ORDER BY tanggal, nomor, faktur`,
        values: [pola(f.pelanggan)],
      };
    },
  },

  {
    nama: "piutang_terbuka",
    judul: "Piutang terbuka",
    filter: [F_PELANGGAN],
    kolom: [
      { kunci: "faktur", judul: "Faktur", tipe: "teks" },
      { kunci: "tanggal", judul: "Tanggal", tipe: "tanggal" },
      { kunci: "jatuh_tempo", judul: "Jatuh tempo", tipe: "tanggal" },
      { kunci: "kode_pelanggan", judul: "Kode", tipe: "teks" },
      { kunci: "pelanggan", judul: "Pelanggan", tipe: "teks" },
      { kunci: "hari_lewat", judul: "Hari lewat", tipe: "integer" },
      { kunci: "nilai", judul: "Nilai faktur", tipe: "uang" },
      { kunci: "dibayar", judul: "Sudah dibayar", tipe: "uang" },
      { kunci: "sisa", judul: "Sisa", tipe: "uang" },
    ],
    sql: (f) => ({
      // Sisa dihitung oleh v_invoice_outstanding, sumber yang sama dengan
      // halaman, grafik, dan alat AI.
      text: `SELECT o.doc_no AS faktur,
                    to_char(o.doc_date, 'YYYY-MM-DD') AS tanggal,
                    to_char(o.due_date, 'YYYY-MM-DD') AS jatuh_tempo,
                    c.code AS kode_pelanggan, c.name AS pelanggan,
                    o.hari_lewat, o.total AS nilai, o.dibayar, o.sisa
               FROM v_invoice_outstanding o
               JOIN partner c ON c.id = o.customer_id
              WHERE o.sisa > 0
                AND ($1::text IS NULL OR c.code ILIKE $1 OR c.name ILIKE $1)
              ORDER BY o.hari_lewat DESC, o.sisa DESC`,
      values: [pola(f.pelanggan)],
    }),
  },

  {
    nama: "pencocokan_pembelian",
    judul: "Pencocokan pembelian",
    filter: [F_PEMASOK],
    kolom: [
      { kunci: "penerimaan", judul: "Penerimaan", tipe: "teks" },
      { kunci: "tanggal", judul: "Tanggal terima", tipe: "tanggal" },
      { kunci: "kode_pemasok", judul: "Kode", tipe: "teks" },
      { kunci: "pemasok", judul: "Pemasok", tipe: "teks" },
      { kunci: "sku", judul: "SKU", tipe: "teks" },
      { kunci: "barang", judul: "Barang", tipe: "teks" },
      { kunci: "satuan", judul: "Satuan", tipe: "teks" },
      { kunci: "qty_diterima", judul: "Diterima", tipe: "qty" },
      { kunci: "qty_difakturkan", judul: "Difakturkan", tipe: "qty" },
      { kunci: "qty_sisa", judul: "Belum difakturkan", tipe: "qty" },
      { kunci: "biaya_terima", judul: "Harga saat terima", tipe: "uang" },
      { kunci: "nilai_terima", judul: "Nilai penerimaan", tipe: "uang" },
      { kunci: "nilai_difakturkan", judul: "Nilai difakturkan", tipe: "uang" },
      { kunci: "grni_sisa", judul: "Belum ditagih", tipe: "uang" },
    ],
    sql: (f) => ({
      /*
       * Seluruh baris penerimaan ditampilkan, bukan hanya yang masih
       * menggantung: laporan pencocokan gunanya justru untuk melihat
       * yang sudah cocok dan yang belum secara berdampingan. Kolom
       * "Belum ditagih" yang dijumlahkan akan sama dengan saldo akun
       * Barang Diterima Belum Ditagih di buku besar.
       */
      text: `SELECT m.receipt_no AS penerimaan,
                    to_char(m.receipt_date, 'YYYY-MM-DD') AS tanggal,
                    s.code AS kode_pemasok, s.name AS pemasok,
                    p.sku, p.name AS barang, u.code AS satuan,
                    m.qty_diterima, m.qty_difakturkan, m.qty_sisa,
                    m.biaya_terima, m.nilai_terima, m.nilai_difakturkan,
                    m.grni_sisa
               FROM v_receipt_matching m
               JOIN product p ON p.id = m.product_id
               JOIN uom     u ON u.id = p.base_uom_id
               JOIN partner s ON s.id = m.supplier_id
              WHERE ($1::text IS NULL OR s.code ILIKE $1 OR s.name ILIKE $1)
              ORDER BY m.receipt_date DESC, m.receipt_no, p.sku`,
      values: [pola(f.pemasok)],
    }),
  },

  {
    nama: "faktur_pembelian",
    judul: "Faktur pembelian",
    filter: [F_PERIODE, F_PEMASOK],
    kolom: [
      { kunci: "tanggal", judul: "Tanggal", tipe: "tanggal" },
      { kunci: "nomor", judul: "Nomor", tipe: "teks" },
      { kunci: "ref_pemasok", judul: "Ref pemasok", tipe: "teks" },
      { kunci: "kode_pemasok", judul: "Kode", tipe: "teks" },
      { kunci: "pemasok", judul: "Pemasok", tipe: "teks" },
      { kunci: "nilai_faktur", judul: "Nilai faktur", tipe: "uang" },
      { kunci: "ppn_masukan", judul: "PPN Masukan", tipe: "uang" },
      { kunci: "total", judul: "Total tagihan", tipe: "uang" },
      { kunci: "grni_dilepas", judul: "GRNI dilepas", tipe: "uang" },
      { kunci: "selisih_harga", judul: "Selisih harga", tipe: "uang" },
      { kunci: "selisih_qty", judul: "Selisih kuantitas", tipe: "uang" },
      { kunci: "disetujui_oleh", judul: "Selisih qty disetujui oleh", tipe: "teks" },
    ],
    sql: (f) => {
      const r = rentang(f);
      return {
        text: `SELECT to_char(pi.doc_date, 'YYYY-MM-DD') AS tanggal,
                      pi.doc_no AS nomor, pi.supplier_ref AS ref_pemasok,
                      s.code AS kode_pemasok, s.name AS pemasok,
                      pi.subtotal AS nilai_faktur,
                      pi.tax_amount AS ppn_masukan, pi.total,
                      pi.grni_amount AS grni_dilepas,
                      pi.price_variance AS selisih_harga,
                      pi.qty_variance AS selisih_qty,
                      pi.approved_by AS disetujui_oleh
                 FROM purchase_invoice pi
                 JOIN partner s ON s.id = pi.supplier_id
                WHERE pi.status = 'POSTED'
                  AND pi.doc_date BETWEEN (${r.dari})::date AND (${r.sampai})::date
                  AND ($1::text IS NULL OR s.code ILIKE $1 OR s.name ILIKE $1)
                ORDER BY pi.doc_date DESC, pi.doc_no`,
        values: [pola(f.pemasok)],
      };
    },
  },

  {
    nama: "pembayaran_pemasok",
    judul: "Pembayaran ke pemasok",
    filter: [F_PERIODE, F_PEMASOK],
    kolom: [
      { kunci: "tanggal", judul: "Tanggal", tipe: "tanggal" },
      { kunci: "nomor", judul: "Nomor", tipe: "teks" },
      { kunci: "kode_pemasok", judul: "Kode", tipe: "teks" },
      { kunci: "pemasok", judul: "Pemasok", tipe: "teks" },
      { kunci: "cara", judul: "Cara bayar", tipe: "teks" },
      { kunci: "referensi", judul: "Referensi", tipe: "teks" },
      { kunci: "faktur", judul: "Faktur", tipe: "teks" },
      { kunci: "nilai_faktur", judul: "Nilai faktur", tipe: "uang" },
      { kunci: "dialokasikan", judul: "Dialokasikan", tipe: "uang" },
    ],
    sql: (f) => {
      const r = rentang(f);
      return {
        /*
         * Satu baris per ALOKASI. Bagian yang belum punya faktur muncul
         * sebagai baris "(uang muka pembelian)" — kalau dihilangkan,
         * jumlah kolom Dialokasikan tidak akan sama dengan uang yang
         * benar-benar keluar.
         */
        text: `SELECT to_char(p.doc_date, 'YYYY-MM-DD') AS tanggal,
                      p.doc_no AS nomor, s.code AS kode_pemasok, s.name AS pemasok,
                      p.method AS cara, p.reference AS referensi,
                      i.doc_no AS faktur, i.total AS nilai_faktur,
                      a.amount AS dialokasikan
                 FROM supplier_payment_allocation a
                 JOIN supplier_payment p ON p.id = a.payment_id
                 JOIN purchase_invoice i ON i.id = a.invoice_id
                 JOIN partner s ON s.id = p.supplier_id
                WHERE p.status = 'POSTED'
                  AND p.doc_date BETWEEN (${r.dari})::date AND (${r.sampai})::date
                  AND ($1::text IS NULL OR s.code ILIKE $1 OR s.name ILIKE $1)
               UNION ALL
               SELECT to_char(p.doc_date, 'YYYY-MM-DD'), p.doc_no, s.code, s.name,
                      p.method, p.reference,
                      '(uang muka pembelian)', NULL, p.unallocated
                 FROM supplier_payment p
                 JOIN partner s ON s.id = p.supplier_id
                WHERE p.status = 'POSTED' AND p.unallocated > 0
                  AND p.doc_date BETWEEN (${r.dari})::date AND (${r.sampai})::date
                  AND ($1::text IS NULL OR s.code ILIKE $1 OR s.name ILIKE $1)
                ORDER BY tanggal, nomor, faktur`,
        values: [pola(f.pemasok)],
      };
    },
  },

  {
    nama: "utang_terbuka",
    judul: "Utang terbuka",
    filter: [F_PEMASOK],
    kolom: [
      { kunci: "faktur", judul: "Faktur", tipe: "teks" },
      { kunci: "ref_pemasok", judul: "Ref pemasok", tipe: "teks" },
      { kunci: "tanggal", judul: "Tanggal", tipe: "tanggal" },
      { kunci: "kode_pemasok", judul: "Kode", tipe: "teks" },
      { kunci: "pemasok", judul: "Pemasok", tipe: "teks" },
      { kunci: "umur_hari", judul: "Umur (hari)", tipe: "integer" },
      { kunci: "nilai", judul: "Nilai faktur", tipe: "uang" },
      { kunci: "dibayar", judul: "Sudah dibayar", tipe: "uang" },
      { kunci: "sisa", judul: "Sisa", tipe: "uang" },
    ],
    sql: (f) => ({
      // Sisa dihitung v_purchase_outstanding, sumber yang sama dengan
      // halaman dan dengan pemeriksaan di lib/posting.ts.
      text: `SELECT o.doc_no AS faktur, o.supplier_ref AS ref_pemasok,
                    to_char(o.doc_date, 'YYYY-MM-DD') AS tanggal,
                    s.code AS kode_pemasok, s.name AS pemasok,
                    o.hari_sejak_faktur AS umur_hari,
                    o.total AS nilai, o.dibayar, o.sisa
               FROM v_purchase_outstanding o
               JOIN partner s ON s.id = o.supplier_id
              WHERE o.sisa > 0
                AND ($1::text IS NULL OR s.code ILIKE $1 OR s.name ILIKE $1)
              ORDER BY o.doc_date, o.doc_no`,
      values: [pola(f.pemasok)],
    }),
  },

  {
    nama: "arus_kas",
    judul: "Arus Kas",
    filter: [F_DARI, F_SAMPAI, F_BANDING_SATUAN],
    barisFormula: {
      kolom: "jenis",
      persenDari: { nilai: "periode", dasar: "pembanding" },
    },
    kolom: [
      { kunci: "bagian", judul: "Bagian", tipe: "teks" },
      { kunci: "kode", judul: "Kode", tipe: "teks" },
      { kunci: "akun", judul: "Akun lawan", tipe: "teks" },
      { kunci: "periode", judul: "Periode", tipe: "uang" },
      { kunci: "pembanding", judul: "Pembanding", tipe: "uang" },
      { kunci: "selisih", judul: "Selisih", tipe: "uang" },
      { kunci: "selisih_persen", judul: "Selisih %", tipe: "persen" },
    ],
    sql: (f) => {
      const geser = f.banding === "tahun" ? "1 year" : "1 month";
      const dari = "COALESCE($1::date, date_trunc('month', CURRENT_DATE)::date)";
      const sampai = "COALESCE($2::date, CURRENT_DATE)";
      const bDari = `(${dari} - INTERVAL '${geser}')::date`;
      const bSampai = `(${sampai} - INTERVAL '${geser}')::date`;

      /**
       * Golongan dibaca dari akun LAWAN, dengan nilai baris BERTANDA.
       *
       * Karena setiap jurnal seimbang, jumlah kontribusi seluruh baris
       * lawan selalu sama persis dengan pergerakan kas jurnal itu — jadi
       * tidak ada nilai yang bisa hilang, dan tidak perlu taksiran
       * proporsional yang menyisakan pembulatan.
       *
       * Transfer antar rekening kas tidak punya baris lawan sama sekali,
       * sehingga ia tersaring dengan sendirinya.
       */
      const rincian = (dr: string, sp: string) => `
        SELECT a.code, a.name, a.kategori_arus_kas,
               ROUND(SUM(-(l.debit - l.credit)), 2) AS arus
          FROM (SELECT DISTINCT e.id
                  FROM journal_entry e
                  JOIN journal_line jl ON jl.entry_id = e.id
                  JOIN account ja      ON ja.id = jl.account_id
                 WHERE e.is_posted AND ja.is_cash_equivalent
                   AND e.entry_date >= ${dr} AND e.entry_date <= ${sp}) j
          JOIN journal_line l ON l.entry_id = j.id
          JOIN account a      ON a.id = l.account_id
         WHERE NOT a.is_cash_equivalent
         GROUP BY a.code, a.name, a.kategori_arus_kas
        HAVING SUM(-(l.debit - l.credit)) <> 0`;

      const saldo = (batas: string, op: string) => `
        COALESCE((SELECT ROUND(SUM(l.debit - l.credit), 2)
                    FROM journal_line l
                    JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
                    JOIN account a       ON a.id = l.account_id
                   WHERE a.is_cash_equivalent AND e.entry_date ${op} ${batas}), 0)`;

      return {
        text: `WITH utama AS (${rincian(dari, sampai)}),
                    banding AS (${rincian(bDari, bSampai)}),
                    gabung AS (
                      SELECT COALESCE(u.code, b.code) AS code,
                             COALESCE(u.name, b.name) AS name,
                             COALESCE(u.kategori_arus_kas, b.kategori_arus_kas)
                               AS kategori,
                             COALESCE(u.arus, 0) AS periode,
                             COALESCE(b.arus, 0) AS pembanding
                        FROM utama u
                        FULL JOIN banding b ON b.code = u.code
                    ),
                    baris AS (
                      SELECT CASE g.kategori::text
                               WHEN 'OPERASI'   THEN 1
                               WHEN 'INVESTASI' THEN 2
                               WHEN 'PENDANAAN' THEN 3
                               ELSE 4 END AS grup,
                             1 AS urut, g.code AS u3,
                             COALESCE(g.kategori::text, 'BELUM DIGOLONGKAN') AS bagian,
                             g.code AS kode, g.name AS akun, 'akun' AS jenis,
                             g.periode, g.pembanding
                        FROM gabung g
                      UNION ALL
                      SELECT CASE k.kategori
                               WHEN 'OPERASI'   THEN 1
                               WHEN 'INVESTASI' THEN 2
                               ELSE 3 END,
                             2, '',
                             k.kategori, NULL, 'Jumlah ' || lower(k.kategori),
                             'subtotal',
                             COALESCE((SELECT SUM(periode) FROM gabung
                                        WHERE kategori::text = k.kategori), 0),
                             COALESCE((SELECT SUM(pembanding) FROM gabung
                                        WHERE kategori::text = k.kategori), 0)
                        FROM (VALUES ('OPERASI'), ('INVESTASI'), ('PENDANAAN')) k(kategori)
                      UNION ALL
                      /*
                       * Baris saldo bertanda 'saldo', BUKAN 'akun'.
                       *
                       * Penulis XLSX menjumlahkan baris 'akun' yang
                       * berurutan tepat di atas sebuah subtotal. Kalau
                       * saldo kas awal ikut bertanda 'akun', ia akan
                       * tertelan ke dalam "Jumlah operasi" — dan
                       * laporannya menjadi salah dengan cara yang tidak
                       * kelihatan sampai seseorang menjumlahkan sendiri.
                       */
                      SELECT 0, 1, '', 'Saldo kas', NULL, 'Saldo kas awal periode',
                             'saldo',
                             ${saldo(dari, "<")}, ${saldo(bDari, "<")}
                      UNION ALL
                      SELECT 5, 1, '', 'Saldo kas', NULL, 'Saldo kas akhir periode',
                             'saldo',
                             ${saldo(sampai, "<=")}, ${saldo(bSampai, "<=")}
                    )
               SELECT bagian, kode, akun, jenis, NULL::int AS kedalaman,
                      periode, pembanding,
                      (periode - pembanding) AS selisih,
                      CASE WHEN pembanding <> 0
                           THEN ROUND((periode - pembanding) / ABS(pembanding), 4)
                      END AS selisih_persen
                 FROM baris
                /*
                 * Baris rincian yang nol di kedua periode disembunyikan,
                 * tetapi baris STRUKTURAL selalu tampil: saldo kas awal
                 * dan akhir, serta jumlah tiap golongan. Saldo awal nol
                 * adalah informasi ("periode ini dimulai tanpa kas"),
                 * bukan baris kosong yang layak dibuang — dan laporan
                 * yang kehilangan barisnya tidak bisa dibaca sebagai
                 * "awal + arus = akhir".
                 */
                WHERE jenis = 'subtotal'
                   OR bagian = 'Saldo kas'
                   OR periode <> 0
                   OR pembanding <> 0
                ORDER BY grup, urut, u3`,
        values: [f.dari, f.sampai],
      };
    },
  },
];

export const cariLaporan = (nama: string) =>
  LAPORAN.find((l) => l.nama === nama) ?? null;
