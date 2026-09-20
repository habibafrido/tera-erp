import { aiQuery } from "./db";
import { PERIODE, PERIODE_SAH, type Periode } from "../periode";

/**
 * ============================================================
 * REGISTRY ALAT
 * ============================================================
 * Model bahasa tidak menulis SQL dan tidak menghitung. Setiap alat di
 * sini membungkus SATU kueri yang sudah ditulis dan diuji lebih dulu,
 * berparameter penuh, dan selalu ber-LIMIT.
 *
 * Aturan yang dipegang seluruh berkas ini:
 *
 *  1. Semua agregasi — jumlah, rata-rata, margin, ember umur piutang —
 *     dihitung Postgres, bukan di JavaScript dan apalagi oleh model.
 *     Kalau sebuah pertanyaan butuh angka yang belum ada alatnya,
 *     tambahkan alat baru; jangan biarkan model menjumlahkan sendiri.
 *  2. Hasil selalu data terstruktur, tidak pernah kalimat jadi.
 *  3. `meta` membawa satuan, periode, dan batas baris, supaya model tidak
 *     perlu menyimpulkan konteks yang bisa ia salah tebak.
 *  4. Parameter tidak sah mengembalikan { ok: false, error }, bukan
 *     exception — model harus bisa membaca dan memperbaiki panggilannya.
 */

const LIMIT_BAWAAN = 20;
const LIMIT_MAKS = 50;

export type ToolOk = {
  ok: true;
  meta: Record<string, unknown>;
  rows: Record<string, unknown>[];
};
export type ToolErr = { ok: false; error: string };
export type ToolResult = ToolOk | ToolErr;

export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

// ------------------------------------------------------------------
// Validasi parameter
// ------------------------------------------------------------------

class Invalid extends Error {}

function teks(v: unknown, nama: string, opts: { wajib?: boolean; maks?: number } = {}) {
  if (v === undefined || v === null || v === "") {
    if (opts.wajib) throw new Invalid(`Parameter "${nama}" wajib diisi.`);
    return null;
  }
  if (typeof v !== "string") throw new Invalid(`Parameter "${nama}" harus berupa teks.`);
  const s = v.trim().slice(0, opts.maks ?? 100);
  return s === "" ? null : s;
}

function bulat(v: unknown, nama: string, min: number, maks: number, bawaan: number) {
  if (v === undefined || v === null || v === "") return bawaan;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Invalid(`Parameter "${nama}" harus berupa angka.`);
  const i = Math.trunc(n);
  if (i < min || i > maks) {
    throw new Invalid(`Parameter "${nama}" harus antara ${min} dan ${maks}. Diterima ${i}.`);
  }
  return i;
}

/** Tanggal ISO. Format lain ditolak supaya tidak ada tebakan zona waktu. */
function tanggal(v: unknown, nama: string, wajib = true) {
  const s = teks(v, nama, { wajib, maks: 10 });
  if (s === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Invalid(`Parameter "${nama}" harus berformat YYYY-MM-DD. Diterima "${s}".`);
  }
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) throw new Invalid(`Tanggal "${s}" tidak sah.`);
  return s;
}

function pilihan<T extends string>(v: unknown, nama: string, sah: readonly T[], bawaan: T): T {
  const s = teks(v, nama, { maks: 30 });
  if (s === null) return bawaan;
  if (!(sah as readonly string[]).includes(s)) {
    throw new Invalid(`Parameter "${nama}" harus salah satu dari: ${sah.join(", ")}. Diterima "${s}".`);
  }
  return s as T;
}

function batas(v: unknown) {
  return bulat(v, "limit", 1, LIMIT_MAKS, LIMIT_BAWAAN);
}

/**
 * Peta periode dipakai bersama dengan registry laporan ekspor; lihat
 * lib/periode.ts. Disatukan supaya "bulan ini" di chat dan "bulan ini"
 * di berkas Excel tidak pernah berbeda rentangnya.
 */

const PERIODE_DESKRIPSI =
  "Periode relatif. Salah satu dari: " + PERIODE_SAH.join(", ") + ". " +
  'Pakai ini untuk ungkapan relatif seperti "bulan ini", "bulan lalu", ' +
  'atau "90 hari terakhir". Jangan diisi bersamaan dengan dari/sampai.';

const DARI_DESKRIPSI =
  "Tanggal mulai YYYY-MM-DD. Isi HANYA kalau pengguna menyebut tanggal " +
  "eksplisit; untuk ungkapan relatif pakai periode.";
const SAMPAI_DESKRIPSI =
  "Tanggal akhir YYYY-MM-DD. Isi HANYA kalau pengguna menyebut tanggal " +
  "eksplisit; untuk ungkapan relatif pakai periode.";

/**
 * Menentukan rentang dari `periode` ATAU dari `dari`+`sampai`.
 *
 * Keduanya saling eksklusif. Hasilnya dua ekspresi SQL plus dua parameter
 * terikat; kueri memakai COALESCE($1::date, <ekspresi>) sehingga kedua
 * jalur memakai bentuk SQL yang sama dan nomor parameter tidak bergeser.
 */
function rentang(a: Record<string, unknown>) {
  const p = teks(a.periode, "periode", { maks: 30 });
  const dari = tanggal(a.dari, "dari", false);
  const sampai = tanggal(a.sampai, "sampai", false);

  if (p && (dari || sampai)) {
    throw new Invalid(
      'Isi "periode" ATAU pasangan "dari"+"sampai", jangan keduanya. ' +
        `Diterima periode="${p}" bersama dari/sampai.`
    );
  }

  if (p) {
    if (!(PERIODE_SAH as string[]).includes(p)) {
      throw new Invalid(
        `Parameter "periode" harus salah satu dari: ${PERIODE_SAH.join(", ")}. ` +
          `Diterima "${p}".`
      );
    }
    const e = PERIODE[p as Periode];
    return { dariSql: e.dari, sampaiSql: e.sampai, params: [null, null] as (string | null)[], periode: p };
  }

  if (!dari || !sampai) {
    throw new Invalid(
      'Rentang waktu belum ditentukan. Isi "periode" (misalnya bulan_ini), ' +
        'atau isi "dari" dan "sampai" sekaligus.'
    );
  }
  if (dari > sampai) {
    throw new Invalid(`"dari" (${dari}) tidak boleh setelah "sampai" (${sampai}).`);
  }
  return {
    dariSql: "CURRENT_DATE",
    sampaiSql: "CURRENT_DATE",
    params: [dari, sampai] as (string | null)[],
    periode: null,
  };
}

/**
 * Memisahkan kolom bantu dari baris hasil.
 *
 * Kueri selalu mengembalikan tanggal rentang yang benar-benar dipakai,
 * bahkan saat tidak ada satu pun baris data — itulah yang membedakan
 * "tidak ada transaksi bulan ini" dari "periodenya salah". Kolom bantu
 * diawali garis bawah dan tidak pernah sampai ke model.
 */
function bongkar(rows: Record<string, unknown>[], penanda: string) {
  // Nilainya sudah berupa teks YYYY-MM-DD dari to_char(); sengaja TIDAK
  // melewati objek Date, karena konversi ke UTC menggeser tanggal mundur
  // sehari di zona waktu positif seperti WIB.
  const iso = (v: unknown) => (v == null ? null : String(v));

  const dari = iso(rows[0]?._dari);
  const sampai = iso(rows[0]?._sampai);
  const hariIni = iso(rows[0]?._hari_ini);

  const data = rows
    .filter((r) => r[penanda] !== null && r[penanda] !== undefined)
    .map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) if (!k.startsWith("_")) out[k] = v;
      return out;
    });

  // Semua kolom berawalan "_" berasal dari CTE bantu, bukan dari baris data.
  // Diangkat ke satu objek (tanpa awalan) supaya bisa dipasang ke meta.
  const agregat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rows[0] ?? {})) {
    if (k.startsWith("_") && k !== "_urut") agregat[k.slice(1)] = v;
  }

  return { dari, sampai, hariIni, agregat, data };
}

/**
 * Membungkus kueri baris menjadi bentuk baku yang dipakai semua alat.
 *
 * Tiga hal yang selalu ikut, apa pun alatnya:
 *
 *  1. Tanggal hari ini menurut DATABASE — tetap ada walau nol baris,
 *     sehingga "tidak ada data" tetap punya tanggal acuan.
 *  2. AGREGAT, dihitung SEBELUM LIMIT. Model akan menjumlahkan baris
 *     sendiri kalau totalnya tidak disediakan, dan itu aritmetika yang
 *     dilarang. Menghitungnya setelah LIMIT sama buruknya: totalnya akan
 *     benar untuk baris yang tampil tapi salah untuk pertanyaannya.
 *  3. Jumlah baris SEBENARNYA sebelum dipotong, supaya model tahu
 *     daftarnya tidak utuh dan bisa mengatakannya.
 *
 * `inner` ditulis TANPA ORDER BY dan TANPA LIMIT; keduanya dipasang di
 * sini supaya agregat dan pemotongan tidak pernah tertukar urutannya.
 */
function bungkusKueri(opts: {
  inner: string;
  urut: string;
  limit: string;
  total?: [string, string][];
}): string {
  // Awalan "_" membuat kolom agregat dipisahkan oleh aturan yang sama
  // dengan kolom bantu lain. Versi pertama memakai daftar nama, dan itu
  // ikut menyapu kolom DATA yang kebetulan bernama sama — total_nilai
  // milik nilai_persediaan hilang karenanya. Daftar nama memang rapuh.
  const agregat = (opts.total ?? [])
    .map(([nama, ekspresi]) => `${ekspresi} AS _${nama}`)
    .join(",\n           ");

  return `
    WITH semua AS (${opts.inner}),
    hari AS (SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS hari_ini),
    ringkas AS (
      SELECT COUNT(*) AS _baris_seluruhnya${agregat ? ",\n           " + agregat : ""}
        FROM semua
    ),
    hasil AS (
      SELECT ROW_NUMBER() OVER (ORDER BY ${opts.urut}) AS _urut, semua.*
        FROM semua
       ORDER BY ${opts.urut}
       LIMIT ${opts.limit}
    )
    SELECT d.hari_ini AS _hari_ini, g.*, h.*
      FROM hari d
      CROSS JOIN ringkas g
      LEFT JOIN hasil h ON true
     ORDER BY h._urut`;
}

/** Pola ILIKE dirangkai sebagai parameter, bukan disambung ke SQL. */
function pola(s: string) {
  return "%" + s.replace(/([\\%_])/g, "\\$1") + "%";
}

/** Membungkus handler supaya galat validasi jadi hasil terbaca, bukan exception. */
function bungkus(
  fn: (a: Record<string, unknown>) => Promise<ToolOk>
): (a: Record<string, unknown>) => Promise<ToolResult> {
  return async (a) => {
    try {
      return await fn(a ?? {});
    } catch (e) {
      if (e instanceof Invalid) return { ok: false, error: e.message };
      console.error("[tool]", e);
      return {
        ok: false,
        error: "Kueri gagal dijalankan. Data untuk pertanyaan ini tidak bisa diambil.",
      };
    }
  };
}

// ------------------------------------------------------------------
// SQL untuk ringkasan_penjualan
//
// `per` sudah divalidasi menjadi salah satu dari tiga nilai tetap, lalu
// dipakai untuk MEMILIH di antara tiga kueri yang ditulis lengkap di
// bawah. Nilainya tidak pernah disambung ke dalam teks SQL.
// ------------------------------------------------------------------

/**
 * Kueri ringkasan penjualan, dirakit dari potongan yang semuanya ditulis
 * di berkas ini. Yang berasal dari model hanya `dimensi` (sudah divalidasi
 * ke tiga literal) dan dua ekspresi rentang dari peta PERIODE.
 *
 * Bentuk akhirnya sengaja LEFT JOIN dari CTE `rentang`, supaya tanggal
 * yang benar-benar dipakai tetap terbawa walau tidak ada satu pun baris
 * transaksi. Tanpa itu, "bulan ini kosong" tidak bisa dibedakan dari
 * "periodenya salah".
 */
function sqlPenjualan(
  dimensi: "pelanggan" | "barang" | "bulan",
  dariSql: string,
  sampaiSql: string
): string {
  const agg =
    dimensi === "pelanggan"
      ? `SELECT p.code AS kode_pelanggan, p.name AS pelanggan,
                ROUND(SUM(g.pendapatan), 2) AS subtotal,
                ROUND(SUM(g.hpp), 2)        AS hpp,
                ROUND(SUM(g.pendapatan) - SUM(g.hpp), 2) AS margin,
                CASE WHEN SUM(g.pendapatan) > 0
                     THEN ROUND((SUM(g.pendapatan) - SUM(g.hpp)) * 100 / SUM(g.pendapatan), 2)
                END AS margin_persen
           FROM gabung g
           JOIN partner p ON p.id = g.customer_id
          GROUP BY p.id, p.code, p.name`
      : dimensi === "barang"
        ? `SELECT pr.sku, pr.name AS barang,
                  ROUND(SUM(g.qty), 6)        AS qty_terjual,
                  ROUND(SUM(g.pendapatan), 2) AS subtotal,
                  ROUND(SUM(g.hpp), 2)        AS hpp,
                  ROUND(SUM(g.pendapatan) - SUM(g.hpp), 2) AS margin,
                  CASE WHEN SUM(g.pendapatan) > 0
                       THEN ROUND((SUM(g.pendapatan) - SUM(g.hpp)) * 100 / SUM(g.pendapatan), 2)
                  END AS margin_persen
             FROM gabung g
             JOIN product pr ON pr.id = g.product_id
            GROUP BY pr.id, pr.sku, pr.name`
        : `SELECT to_char(date_trunc('month', g.doc_date), 'YYYY-MM') AS bulan,
                  ROUND(SUM(g.pendapatan), 2) AS subtotal,
                  ROUND(SUM(g.hpp), 2)        AS hpp,
                  ROUND(SUM(g.pendapatan) - SUM(g.hpp), 2) AS margin,
                  CASE WHEN SUM(g.pendapatan) > 0
                       THEN ROUND((SUM(g.pendapatan) - SUM(g.hpp)) * 100 / SUM(g.pendapatan), 2)
                  END AS margin_persen
             FROM gabung g
            GROUP BY 1`;

  const urut = dimensi === "bulan" ? "bulan" : "subtotal DESC";

  return `
  WITH rentang AS (
    SELECT COALESCE($1::date, ${dariSql})::date   AS dari,
           COALESCE($2::date, ${sampaiSql})::date AS sampai
  ),
  inv AS (
    SELECT s.id, s.customer_id, s.doc_date
      FROM sales_invoice s, rentang r
     WHERE s.status = 'POSTED' AND s.doc_date BETWEEN r.dari AND r.sampai
  ),
  baris AS (
    SELECT i.id AS invoice_id, i.doc_date, i.customer_id, l.product_id,
           l.qty, (l.qty * l.unit_price) AS pendapatan
      FROM inv i
      JOIN sales_invoice_line l ON l.invoice_id = i.id
  ),
  hpp AS (
    SELECT s.source_id AS invoice_id, s.product_id,
           SUM(-s.qty * s.unit_cost) AS hpp
      FROM stock_ledger s
     WHERE s.source_type = 'SALES_INVOICE'
       AND s.source_id IN (SELECT id FROM inv)
     GROUP BY s.source_id, s.product_id
  ),
  gabung AS (
    SELECT b.*, COALESCE(h.hpp, 0) AS hpp
      FROM baris b
      LEFT JOIN hpp h ON h.invoice_id = b.invoice_id AND h.product_id = b.product_id
  ),
  agg AS (${agg}),
  /*
   * Total keseluruhan dihitung SEBELUM LIMIT, jadi tetap benar walau
   * hanya sebagian baris yang ditampilkan.
   *
   * Tanpa ini model menjumlahkan baris sendiri untuk menjawab "berapa
   * totalnya" — aritmetika yang justru dilarang di seluruh proyek ini.
   */
  ringkas AS (
    SELECT ROUND(SUM(subtotal), 2)                AS t_subtotal,
           ROUND(SUM(hpp), 2)                     AS t_hpp,
           ROUND(SUM(subtotal) - SUM(hpp), 2)     AS t_margin,
           CASE WHEN SUM(subtotal) > 0
                THEN ROUND((SUM(subtotal) - SUM(hpp)) * 100 / SUM(subtotal), 2)
           END                                    AS t_margin_persen,
           COUNT(*)                               AS t_kelompok
      FROM agg
  ),
  hasil AS (
    SELECT ROW_NUMBER() OVER (ORDER BY ${urut}) AS _urut, agg.*
      FROM agg ORDER BY ${urut} LIMIT $3
  )
  SELECT to_char(r.dari, 'YYYY-MM-DD')   AS _dari,
         to_char(r.sampai, 'YYYY-MM-DD') AS _sampai,
         g.t_subtotal      AS _t_subtotal,
         g.t_hpp           AS _t_hpp,
         g.t_margin        AS _t_margin,
         g.t_margin_persen AS _t_margin_persen,
         g.t_kelompok      AS _t_kelompok,
         h.*
    FROM rentang r
    CROSS JOIN ringkas g
    LEFT JOIN hasil h ON true
   ORDER BY h._urut`;
}

// ------------------------------------------------------------------
// Alat
// ------------------------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: "cari_barang",
    description:
      "Mencari barang berdasarkan potongan nama atau SKU. Mengembalikan SKU, nama, " +
      "satuan dasar, serta saldo dan nilai persediaan total barang itu di semua gudang. " +
      "Pakai ini lebih dulu kalau pengguna menyebut barang dengan nama yang tidak persis. " +
      "meta.total_nilai_persediaan berisi total rupiah seluruh barang yang cocok; " +
      "kutip dari sana, JANGAN menjumlahkan kolom antar baris.",
    parameters: {
      type: "object",
      properties: {
        teks: { type: "string", description: "Potongan nama barang atau SKU." },
        limit: { type: "integer", description: "Maksimum baris (1-50, bawaan 20)." },
      },
      required: ["teks"],
    },
    handler: bungkus(async (a) => {
      const q = teks(a.teks, "teks", { wajib: true })!;
      const n = batas(a.limit);
      const rows = await aiQuery(
        bungkusKueri({
          inner: `SELECT p.sku, p.name AS nama, u.code AS satuan,
                         COALESCE(b.qty, 0)   AS saldo_qty,
                         COALESCE(b.nilai, 0) AS nilai_persediaan
                    FROM product p
                    JOIN uom u ON u.id = p.base_uom_id
                    LEFT JOIN (
                      SELECT product_id, SUM(qty_on_hand) AS qty, SUM(stock_value) AS nilai
                        FROM v_stock_balance GROUP BY product_id
                    ) b ON b.product_id = p.id
                   WHERE p.is_active AND (p.name ILIKE $1 OR p.sku ILIKE $1)`,
          urut: "sku",
          limit: "$2",
          total: [
            ["total_nilai", "ROUND(COALESCE(SUM(nilai_persediaan), 0), 2)"],
            ["jumlah_barang", "COUNT(*)"],
          ],
        }),
        [pola(q), n]
      );
      const { hariIni, agregat, data } = bongkar(rows, "sku");
      return {
        ok: true,
        meta: {
          pencarian: q,
          posisi_per: hariIni,
          satuan_nilai: "IDR",
          // Nilai rupiah selalu bisa dijumlahkan; kuantitas TIDAK, karena
          // barang berbeda bisa memakai satuan dasar berbeda.
          total_nilai_persediaan: agregat.total_nilai ?? 0,
          jumlah_barang_cocok: agregat.jumlah_barang ?? 0,
          keterangan:
            "saldo_qty dalam satuan dasar masing-masing barang, gabungan semua " +
            "gudang. Pakai total_nilai_persediaan untuk total rupiah; JANGAN " +
            "menjumlahkan kolom saldo_qty antar barang karena satuannya bisa berbeda.",
          batas_baris: n,
          jumlah_baris: data.length,
          jumlah_baris_seluruhnya: agregat.baris_seluruhnya ?? data.length,
        },
        rows: data,
      };
    }),
  },

  {
    name: "nilai_persediaan",
    description:
      "Total nilai persediaan SAAT INI dalam rupiah, dihitung database. Pakai ini untuk " +
      "pertanyaan seperti 'berapa nilai persediaan sekarang'. Jangan menjumlahkan sendiri " +
      "dari saldo_stok. Bisa dibatasi per gudang.",
    parameters: {
      type: "object",
      properties: {
        gudang: { type: "string", description: "Kode atau nama gudang. Kosong = semua gudang." },
      },
    },
    handler: bungkus(async (a) => {
      const g = teks(a.gudang, "gudang");
      const rows = await aiQuery(
        // Agregat ini selalu menghasilkan tepat satu baris, jadi tanggalnya
        // cukup ikut di SELECT tanpa perlu pembungkus.
        `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD')   AS _hari_ini,
                COALESCE(SUM(b.stock_value), 0)      AS total_nilai,
                COALESCE(SUM(b.qty_on_hand), 0)      AS total_qty,
                COUNT(DISTINCT b.product_id)         AS jumlah_sku,
                COUNT(*)                             AS jumlah_baris_saldo
           FROM v_stock_balance b
           JOIN warehouse w ON w.id = b.warehouse_id
          WHERE ($1::text IS NULL OR w.code ILIKE $1 OR w.name ILIKE $1)`,
        [g ? pola(g) : null]
      );

      // Tanggal dari CURRENT_DATE milik database, bukan dari jam proses
      // Node: toISOString() menggeser tanggal mundur sehari di WIB.
      const { hariIni, data } = bongkar(rows, "total_nilai");
      return {
        ok: true,
        meta: {
          gudang: g ?? "semua gudang",
          satuan_nilai: "IDR",
          dihitung_pada: hariIni,
          sumber: "v_stock_balance (buku besar stok append-only)",
        },
        rows: data,
      };
    }),
  },

  {
    name: "saldo_stok",
    description:
      "Saldo persediaan per kombinasi barang dan gudang: kuantitas, satuan dasar, " +
      "biaya rata-rata bergerak, dan nilai. Setiap baris memuat kolom satuan — " +
      "angka kuantitas HARUS selalu disebut bersama satuannya, karena 200 pcs dan " +
      "200 kg bukan hal yang sama. meta.total_nilai berisi total rupiah seluruh " +
      "baris yang cocok termasuk yang terpotong batas baris. meta.total_qty berisi " +
      "total kuantitas HANYA bila seluruh baris memakai satuan dasar yang sama, " +
      "dan satuannya ada di meta.satuan_qty; kalau bercampur nilainya null dan " +
      "kuantitas tidak boleh dijumlahkan. Kutip dari meta — JANGAN menjumlahkan " +
      "kolom nilai atau qty antar baris, dan jangan merata-ratakan biaya_rata_rata.",
    parameters: {
      type: "object",
      properties: {
        sku: { type: "string", description: "SKU atau potongannya. Kosong = semua barang." },
        gudang: { type: "string", description: "Kode atau nama gudang. Kosong = semua gudang." },
        limit: { type: "integer", description: "Maksimum baris (1-50, bawaan 20)." },
      },
    },
    handler: bungkus(async (a) => {
      const sku = teks(a.sku, "sku");
      const g = teks(a.gudang, "gudang");
      const n = batas(a.limit);
      const rows = await aiQuery(
        bungkusKueri({
          inner: `SELECT p.sku, p.name AS barang, w.code AS kode_gudang, w.name AS gudang,
                         b.qty_on_hand AS qty,
                         u.code AS satuan,
                         CASE WHEN b.qty_on_hand <> 0
                              THEN ROUND(b.stock_value / b.qty_on_hand, 2) END AS biaya_rata_rata,
                         b.stock_value AS nilai
                    FROM v_stock_balance b
                    JOIN product   p ON p.id = b.product_id
                    JOIN uom       u ON u.id = p.base_uom_id
                    JOIN warehouse w ON w.id = b.warehouse_id
                   WHERE ($1::text IS NULL OR p.sku ILIKE $1 OR p.name ILIKE $1)
                     AND ($2::text IS NULL OR w.code ILIKE $2 OR w.name ILIKE $2)`,
          urut: "sku, kode_gudang",
          limit: "$3",
          total: [
            ["total_nilai", "ROUND(COALESCE(SUM(nilai), 0), 2)"],
            ["total_qty", "COALESCE(SUM(qty), 0)"],
            ["jumlah_sku", "COUNT(DISTINCT sku)"],
            ["jumlah_satuan", "COUNT(DISTINCT satuan)"],
            ["satuan_qty", "MIN(satuan)"],
          ],
        }),
        [sku ? pola(sku) : null, g ? pola(g) : null, n]
      );

      const { hariIni, agregat, data } = bongkar(rows, "sku");
      // Yang menentukan boleh-tidaknya kuantitas dijumlahkan adalah SATUAN,
      // bukan jumlah barang: sepuluh barang yang semuanya PCS tetap sah
      // dijumlahkan, sedangkan satu barang PCS dan satu KG tidak.
      const satuSatuan = Number(agregat.jumlah_satuan ?? 0) === 1;
      return {
        ok: true,
        meta: {
          filter_sku: sku ?? "semua",
          filter_gudang: g ?? "semua",
          // Saldo adalah posisi pada satu titik waktu; tanggalnya harus ikut,
          // dan harus berasal dari database.
          posisi_per: hariIni,
          satuan_nilai: "IDR",
          // Total nilai selalu sah. Total kuantitas hanya bermakna kalau
          // seluruh baris memakai SATUAN DASAR yang sama.
          total_nilai: agregat.total_nilai ?? 0,
          total_qty: satuSatuan ? (agregat.total_qty ?? 0) : null,
          satuan_qty: satuSatuan ? (agregat.satuan_qty ?? null) : null,
          jumlah_sku: agregat.jumlah_sku ?? 0,
          jumlah_satuan: agregat.jumlah_satuan ?? 0,
          keterangan:
            "biaya_rata_rata adalah rata-rata bergerak per barang+gudang pada " +
            "baris buku besar terakhir, dan TIDAK boleh dijumlahkan antar baris. " +
            "Pakai total_nilai untuk total rupiah. Setiap baris punya kolom " +
            "satuan; sebutkan angka kuantitas SELALU bersama satuannya. " +
            (satuSatuan
              ? `total_qty sah karena seluruh baris memakai satuan ${agregat.satuan_qty}.`
              : "total_qty sengaja null karena hasilnya mencampur lebih dari satu " +
                "satuan dasar, dan menjumlahkannya tidak berarti apa pun."),
          batas_baris: n,
          jumlah_baris: data.length,
          jumlah_baris_seluruhnya: agregat.baris_seluruhnya ?? data.length,
        },
        rows: data,
      };
    }),
  },

  {
    name: "kartu_stok",
    description:
      "Riwayat pergerakan stok satu barang di satu gudang, langsung dari buku " +
      "besar stok. Menampilkan saldo berjalan setelah tiap baris, beserta kolom " +
      "satuan — angka kuantitas HARUS selalu disebut bersama satuannya. " +
      "meta.total_masuk, meta.total_keluar, dan meta.mutasi_bersih berisi total " +
      "seluruh periode dalam satuan meta.satuan_qty; kutip dari sana, JANGAN " +
      "menjumlahkan kolom qty. " +
      'Untuk ungkapan relatif seperti "30 hari terakhir" isi periode; isi ' +
      "dari/sampai hanya kalau pengguna menyebut tanggal eksplisit.",
    parameters: {
      type: "object",
      properties: {
        sku: { type: "string", description: "SKU barang." },
        gudang: { type: "string", description: "Kode atau nama gudang." },
        periode: { type: "string", enum: PERIODE_SAH, description: PERIODE_DESKRIPSI },
        dari: { type: "string", description: DARI_DESKRIPSI },
        sampai: { type: "string", description: SAMPAI_DESKRIPSI },
        limit: { type: "integer", description: "Maksimum baris (1-50, bawaan 20)." },
      },
      required: ["sku", "gudang"],
    },
    handler: bungkus(async (a) => {
      const sku = teks(a.sku, "sku", { wajib: true })!;
      const g = teks(a.gudang, "gudang", { wajib: true })!;
      const r = rentang(a);
      const n = batas(a.limit);

      const rows = await aiQuery(
        `WITH rentang AS (
           SELECT COALESCE($1::date, ${r.dariSql})::date   AS dari,
                  COALESCE($2::date, ${r.sampaiSql})::date AS sampai
         ),
         agg AS (
           SELECT s.id AS _id,
                  to_char(s.posted_at, 'YYYY-MM-DD HH24:MI') AS posted_at,
                  s.movement_type AS jenis, s.qty,
                  u.code AS satuan,
                  s.unit_cost     AS biaya_satuan,
                  s.running_qty   AS saldo_qty_setelah,
                  s.running_value AS saldo_nilai_setelah,
                  s.source_type   AS dokumen_jenis,
                  j.entry_no      AS jurnal
             FROM stock_ledger s
             JOIN product   p ON p.id = s.product_id
             JOIN uom       u ON u.id = p.base_uom_id
             JOIN warehouse w ON w.id = s.warehouse_id
             LEFT JOIN journal_entry j ON j.id = s.journal_entry_id
             CROSS JOIN rentang r
            WHERE p.sku ILIKE $3
              AND (w.code ILIKE $4 OR w.name ILIKE $4)
              AND s.posted_at >= r.dari
              AND s.posted_at <  (r.sampai + 1)
         ),
         ringkas AS (
           SELECT COUNT(*)                                            AS _baris_seluruhnya,
                  COALESCE(SUM(CASE WHEN qty > 0 THEN qty END), 0)     AS _total_masuk,
                  COALESCE(SUM(CASE WHEN qty < 0 THEN -qty END), 0)    AS _total_keluar,
                  COALESCE(SUM(qty), 0)                               AS _mutasi_bersih,
                  MIN(satuan)                                         AS _satuan_qty
             FROM agg
         ),
         hasil AS (
           SELECT ROW_NUMBER() OVER (ORDER BY _id) AS _urut, agg.*
             FROM agg ORDER BY _id LIMIT $5
         )
         SELECT to_char(r.dari, 'YYYY-MM-DD')   AS _dari,
                to_char(r.sampai, 'YYYY-MM-DD') AS _sampai,
                g.*, h.*
           FROM rentang r
           CROSS JOIN ringkas g
           LEFT JOIN hasil h ON true
          ORDER BY h._urut`,
        [r.params[0], r.params[1], pola(sku), pola(g), n]
      );

      const { dari, sampai, agregat, data } = bongkar(rows, "posted_at");

      return {
        ok: true,
        meta: {
          sku, gudang: g,
          periode: `${dari} s/d ${sampai}`,
          periode_diminta: r.periode ?? "rentang eksplisit",
          tanggal_mulai: dari,
          tanggal_akhir: sampai,
          satuan_nilai: "IDR",
          // Seluruh baris berasal dari satu barang di satu gudang, jadi
          // kuantitasnya satu satuan dan sah dijumlahkan.
          total_masuk: agregat.total_masuk ?? 0,
          total_keluar: agregat.total_keluar ?? 0,
          mutasi_bersih: agregat.mutasi_bersih ?? 0,
          satuan_qty: agregat.satuan_qty ?? null,
          keterangan:
            data.length === 0
              ? "Tidak ada pergerakan pada periode ini."
              : "qty positif = masuk, negatif = keluar. Setiap baris punya kolom " +
                "satuan; sebutkan angka kuantitas SELALU bersama satuannya. " +
                "total_masuk, total_keluar, dan mutasi_bersih semuanya dalam " +
                "satuan yang sama (meta.satuan_qty); JANGAN menjumlahkan kolom qty.",
          batas_baris: n,
          jumlah_baris: data.length,
          jumlah_baris_seluruhnya: agregat.baris_seluruhnya ?? data.length,
        },
        rows: data,
      };
    }),
  },

  {
    name: "batch_kedaluwarsa",
    description:
      "Batch bersaldo yang akan kedaluwarsa dalam N hari ke depan, urut dari yang " +
      "paling dekat. Batch yang sudah lewat tanggal ikut tampil dengan sisa_hari " +
      "negatif. Setiap baris memuat kolom satuan — angka kuantitas HARUS selalu " +
      "disebut bersama satuannya. meta.jumlah_batch berisi cacah keseluruhan, dan " +
      "meta.total_qty berisi total kuantitas HANYA bila satuannya seragam " +
      "(satuannya di meta.satuan_qty); kutip dari sana, JANGAN menjumlahkan kolom " +
      "qty antar baris.",
    parameters: {
      type: "object",
      properties: {
        hari: { type: "integer", description: "Jumlah hari ke depan (1-3650, bawaan 90)." },
        limit: { type: "integer", description: "Maksimum baris (1-50, bawaan 20)." },
      },
    },
    handler: bungkus(async (a) => {
      const hari = bulat(a.hari, "hari", 1, 3650, 90);
      const n = batas(a.limit);
      const rows = await aiQuery(
        bungkusKueri({
          inner: `SELECT p.sku, p.name AS barang, w.name AS gudang,
                         u.code AS satuan,
                         f.batch_no,
                         to_char(f.expiry_date, 'YYYY-MM-DD') AS kedaluwarsa,
                         f.qty_on_hand AS qty, f.days_to_expiry AS sisa_hari
                    FROM v_stock_fefo f
                    JOIN product   p ON p.id = f.product_id
                    JOIN uom       u ON u.id = p.base_uom_id
                    JOIN warehouse w ON w.id = f.warehouse_id
                   WHERE f.expiry_date IS NOT NULL AND f.days_to_expiry <= $1`,
          urut: "sisa_hari",
          limit: "$2",
          total: [
            ["total_qty", "COALESCE(SUM(qty), 0)"],
            ["jumlah_batch", "COUNT(*)"],
            ["jumlah_sku", "COUNT(DISTINCT sku)"],
            ["jumlah_satuan", "COUNT(DISTINCT satuan)"],
            ["satuan_qty", "MIN(satuan)"],
          ],
        }),
        [hari, n]
      );
      const { hariIni, agregat, data } = bongkar(rows, "sku");
      // Yang menentukan boleh-tidaknya kuantitas dijumlahkan adalah SATUAN,
      // bukan cacah barang: sepuluh barang yang semuanya PCS tetap sah
      // dijumlahkan, sedangkan satu barang PCS dan satu KG tidak.
      const satuSatuan = Number(agregat.jumlah_satuan ?? 0) === 1;
      return {
        ok: true,
        meta: {
          ambang_hari: hari,
          dihitung_pada: hariIni,
          total_qty: satuSatuan ? (agregat.total_qty ?? 0) : null,
          satuan_qty: satuSatuan ? (agregat.satuan_qty ?? null) : null,
          jumlah_batch: agregat.jumlah_batch ?? 0,
          jumlah_sku: agregat.jumlah_sku ?? 0,
          jumlah_satuan: agregat.jumlah_satuan ?? 0,
          keterangan:
            "hanya batch dengan saldo di atas nol. Setiap baris punya kolom " +
            "satuan; sebutkan angka kuantitas SELALU bersama satuannya. Pakai " +
            "jumlah_batch dan total_qty; JANGAN menjumlahkan kolom qty sendiri. " +
            (satuSatuan
              ? "total_qty sah karena seluruh batch memakai satuan yang sama."
              : "total_qty null karena hasilnya mencampur lebih dari satu satuan " +
                "dasar, dan menjumlahkannya tidak berarti apa pun."),
          batas_baris: n,
          jumlah_baris: data.length,
          jumlah_baris_seluruhnya: agregat.baris_seluruhnya ?? data.length,
        },
        rows: data,
      };
    }),
  },

  {
    name: "stok_mengendap",
    description:
      "Barang yang masih bersaldo tetapi tidak punya pergerakan keluar selama N hari " +
      "terakhir. Urut dari nilai persediaan terbesar. meta.total_nilai berisi total " +
      "rupiah stok mengendap seluruhnya dan meta.jumlah_barang berisi cacahnya; " +
      "kutip dari sana, JANGAN menjumlahkan kolom nilai antar baris.",
    parameters: {
      type: "object",
      properties: {
        hari: { type: "integer", description: "Ambang hari tanpa pergerakan keluar (1-3650, bawaan 60)." },
        limit: { type: "integer", description: "Maksimum baris (1-50, bawaan 20)." },
      },
    },
    handler: bungkus(async (a) => {
      const hari = bulat(a.hari, "hari", 1, 3650, 60);
      const n = batas(a.limit);
      const rows = await aiQuery(
        bungkusKueri({
          inner: `SELECT p.sku, p.name AS barang,
                b.qty_on_hand AS qty, b.stock_value AS nilai,
                to_char(k.keluar_terakhir, 'YYYY-MM-DD') AS keluar_terakhir
           FROM (
             SELECT product_id, SUM(qty_on_hand) AS qty_on_hand,
                    SUM(stock_value) AS stock_value
               FROM v_stock_balance GROUP BY product_id
           ) b
           JOIN product p ON p.id = b.product_id
           LEFT JOIN (
             SELECT product_id, MAX(posted_at) AS keluar_terakhir
               FROM stock_ledger WHERE qty < 0 GROUP BY product_id
           ) k ON k.product_id = p.id
          WHERE b.qty_on_hand > 0
            AND COALESCE(k.keluar_terakhir, '1900-01-01'::timestamptz)
                < now() - ($1 || ' days')::interval
          `,
          urut: "nilai DESC",
          limit: "$2",
          total: [
            ["total_nilai", "ROUND(COALESCE(SUM(nilai), 0), 2)"],
            ["jumlah_barang", "COUNT(*)"],
          ],
        }),
        [hari, n]
      );
      const { hariIni, agregat, data } = bongkar(rows, "sku");
      return {
        ok: true,
        meta: {
          ambang_hari: hari,
          dihitung_pada: hariIni,
          satuan_nilai: "IDR",
          // Inilah angka yang dicari dari laporan stok mati: berapa rupiah
          // yang mengendap seluruhnya, bukan berapa per barang.
          total_nilai: agregat.total_nilai ?? 0,
          jumlah_barang: agregat.jumlah_barang ?? 0,
          keterangan:
            "keluar_terakhir kosong berarti belum pernah ada pergerakan keluar. " +
            "Pakai total_nilai untuk total rupiah stok mengendap; JANGAN " +
            "menjumlahkan kolom nilai sendiri.",
          batas_baris: n,
          jumlah_baris: data.length,
          jumlah_baris_seluruhnya: agregat.baris_seluruhnya ?? data.length,
        },
        rows: data,
      };
    }),
  },

  {
    name: "ringkasan_penjualan",
    description:
      "Ringkasan penjualan terposting, dikelompokkan per pelanggan, per barang, " +
      "atau per bulan. Subtotal sebelum PPN, harga pokok, margin, dan persentase " +
      "margin semuanya dihitung database. meta.total_subtotal, meta.total_hpp, " +
      "meta.total_margin, dan meta.total_margin_persen berisi total seluruh " +
      "periode; kutip dari sana, JANGAN menjumlahkan kolom antar baris. " +
      'Untuk ungkapan relatif seperti "bulan ini" atau "90 hari terakhir", isi ' +
      "periode. Isi dari/sampai hanya kalau pengguna menyebut tanggal eksplisit. " +
      "JANGAN menebak periode dengan mengambil rentang lebar lalu melihat baris " +
      "terakhir — bulan berjalan bisa saja belum punya transaksi.",
    parameters: {
      type: "object",
      properties: {
        periode: { type: "string", enum: PERIODE_SAH, description: PERIODE_DESKRIPSI },
        dari: { type: "string", description: DARI_DESKRIPSI },
        sampai: { type: "string", description: SAMPAI_DESKRIPSI },
        per: {
          type: "string",
          enum: ["pelanggan", "barang", "bulan"],
          description: "Dimensi pengelompokan. Bawaan pelanggan.",
        },
        limit: { type: "integer", description: "Maksimum baris (1-50, bawaan 20)." },
      },
    },
    handler: bungkus(async (a) => {
      const r = rentang(a);
      const per = pilihan(a.per, "per", ["pelanggan", "barang", "bulan"] as const, "pelanggan");
      const n = batas(a.limit);

      const rows = await aiQuery(sqlPenjualan(per, r.dariSql, r.sampaiSql), [
        r.params[0], r.params[1], n,
      ]);
      const penanda = per === "bulan" ? "bulan" : per === "barang" ? "sku" : "kode_pelanggan";
      const { dari, sampai, data } = bongkar(rows, penanda);
      const t = rows[0] ?? {};

      return {
        ok: true,
        meta: {
          periode: `${dari} s/d ${sampai}`,
          periode_diminta: r.periode ?? "rentang eksplisit",
          tanggal_mulai: dari,
          tanggal_akhir: sampai,
          dikelompokkan_per: per,
          satuan_nilai: "IDR",
          // Total seluruh periode, dihitung database. Pakai angka ini
          // untuk pertanyaan "berapa totalnya" — JANGAN menjumlahkan baris.
          total_subtotal: t._t_subtotal ?? 0,
          total_hpp: t._t_hpp ?? 0,
          total_margin: t._t_margin ?? 0,
          total_margin_persen: t._t_margin_persen ?? null,
          jumlah_kelompok_seluruhnya: t._t_kelompok ?? 0,
          keterangan:
            data.length === 0
              ? "Tidak ada faktur terposting pada periode ini."
              : "subtotal belum termasuk PPN; hpp memakai biaya rata-rata bergerak " +
                "saat faktur diposting; hanya faktur berstatus POSTED. " +
                "total_* mencakup SELURUH periode termasuk baris yang tidak " +
                "ditampilkan karena batas baris.",
          batas_baris: n,
          jumlah_baris: data.length,
        },
        rows: data,
      };
    }),
  },

  {
    name: "umur_piutang",
    description:
      "Umur SISA piutang per pelanggan dalam ember 0-30, 31-60, 61-90, dan di atas " +
      "90 hari, dihitung dari tanggal jatuh tempo. Nilainya sudah dikurangi " +
      "pembayaran yang diterima, dan faktur lunas tidak ikut. Faktur yang belum " +
      "jatuh tempo masuk ember 0-30. meta.total_piutang dan meta.total_0_30 / total_31_60 / " +
      "total_61_90 / total_di_atas_90 berisi total seluruh pelanggan — pertanyaan " +
      "seperti berapa yang lewat 90 hari dijawab dari meta.total_di_atas_90, " +
      "JANGAN menjumlahkan kolom antar baris.",
    parameters: {
      type: "object",
      properties: {
        pelanggan: { type: "string", description: "Kode atau nama pelanggan. Kosong = semua." },
        limit: { type: "integer", description: "Maksimum baris (1-50, bawaan 20)." },
      },
    },
    handler: bungkus(async (a) => {
      const c = teks(a.pelanggan, "pelanggan");
      const n = batas(a.limit);
      const rows = await aiQuery(
        bungkusKueri({
          inner: `WITH umur AS (
             -- SISA tagihan, bukan nilai faktur. v_invoice_outstanding
             -- menghitungnya dari nilai faktur dikurangi alokasi
             -- pembayaran yang sudah terposting; tidak ada kolom saldo
             -- yang disimpan dan bisa menyimpang.
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
           HAVING SUM(u.total) <> 0`,
          urut: "total_piutang DESC",
          limit: "$2",
          total: [
            ["total_piutang", "ROUND(COALESCE(SUM(total_piutang), 0), 2)"],
            ["total_0_30", "ROUND(COALESCE(SUM(umur_0_30), 0), 2)"],
            ["total_31_60", "ROUND(COALESCE(SUM(umur_31_60), 0), 2)"],
            ["total_61_90", "ROUND(COALESCE(SUM(umur_61_90), 0), 2)"],
            ["total_di_atas_90", "ROUND(COALESCE(SUM(umur_di_atas_90), 0), 2)"],
            ["jumlah_pelanggan", "COUNT(*)"],
          ],
        }),
        [c ? pola(c) : null, n]
      );

      // Umur piutang dihitung relatif terhadap CURRENT_DATE di dalam SQL,
      // jadi tanggal acuannya harus datang dari sumber yang sama.
      const { hariIni, agregat, data } = bongkar(rows, "kode");
      return {
        ok: true,
        meta: {
          filter_pelanggan: c ?? "semua",
          satuan_nilai: "IDR",
          dihitung_pada: hariIni,
          // Seluruh ember dijumlahkan database. "Berapa yang lewat 90 hari"
          // dijawab dari total_di_atas_90, bukan dari menjumlahkan kolom.
          total_piutang: agregat.total_piutang ?? 0,
          total_0_30: agregat.total_0_30 ?? 0,
          total_31_60: agregat.total_31_60 ?? 0,
          total_61_90: agregat.total_61_90 ?? 0,
          total_di_atas_90: agregat.total_di_atas_90 ?? 0,
          jumlah_pelanggan: agregat.jumlah_pelanggan ?? 0,
          jumlah_baris_seluruhnya: agregat.baris_seluruhnya ?? data.length,
          keterangan:
            "Angka ini adalah SISA tagihan: nilai faktur dikurangi pembayaran " +
            "yang sudah diposting. Faktur yang sudah lunas tidak muncul. " +
            "Kelebihan bayar tidak mengurangi piutang pelanggan lain — ia " +
            "berdiri sendiri di akun Titipan Pelanggan. Pakai total_* di meta " +
            "untuk angka keseluruhan; JANGAN menjumlahkan kolom antar baris.",
          batas_baris: n,
          jumlah_baris: data.length,
        },
        rows: data,
      };
    }),
  },

  {
    name: "cari_dokumen",
    description:
      "Mencari dokumen penerimaan barang dan faktur penjualan berdasarkan potongan " +
      "nomor dokumen atau nama mitra. meta.total_nilai_penerimaan dan " +
      "meta.total_nilai_faktur dijumlahkan TERPISAH karena artinya berbeda " +
      "(nilai persediaan masuk vs tagihan termasuk PPN); kutip dari sana, jangan " +
      "menggabungkan keduanya, dan JANGAN menjumlahkan kolom nilai sendiri.",
    parameters: {
      type: "object",
      properties: {
        teks: { type: "string", description: "Potongan nomor dokumen atau nama mitra." },
        limit: { type: "integer", description: "Maksimum baris (1-50, bawaan 20)." },
      },
      required: ["teks"],
    },
    handler: bungkus(async (a) => {
      const q = teks(a.teks, "teks", { wajib: true })!;
      const n = batas(a.limit);
      const rows = await aiQuery(
        bungkusKueri({
          inner: `SELECT * FROM (
           SELECT g.doc_no AS nomor, 'Penerimaan' AS jenis,
                  to_char(g.doc_date, 'YYYY-MM-DD') AS tanggal,
                  g.status, g.total_value AS nilai, p.name AS mitra, w.name AS gudang
             FROM goods_receipt g
             JOIN partner p   ON p.id = g.supplier_id
             JOIN warehouse w ON w.id = g.warehouse_id
            WHERE g.doc_no ILIKE $1 OR p.name ILIKE $1
           UNION ALL
           SELECT s.doc_no, 'Faktur penjualan',
                  to_char(s.doc_date, 'YYYY-MM-DD'),
                  s.status, s.total, p.name, w.name
             FROM sales_invoice s
             JOIN partner p   ON p.id = s.customer_id
             JOIN warehouse w ON w.id = s.warehouse_id
            WHERE s.doc_no ILIKE $1 OR p.name ILIKE $1
         ) d`,
          urut: "tanggal DESC, nomor",
          limit: "$2",
          // Nilai penerimaan dan nilai faktur TIDAK dijumlahkan menjadi satu:
          // yang pertama nilai persediaan masuk, yang kedua tagihan termasuk
          // PPN. Menjumlahkannya menghasilkan angka yang tidak berarti apa pun.
          total: [
            ["total_nilai_penerimaan",
             "ROUND(COALESCE(SUM(CASE WHEN jenis = 'Penerimaan' THEN nilai END), 0), 2)"],
            ["total_nilai_faktur",
             "ROUND(COALESCE(SUM(CASE WHEN jenis <> 'Penerimaan' THEN nilai END), 0), 2)"],
            ["jumlah_penerimaan", "COUNT(*) FILTER (WHERE jenis = 'Penerimaan')"],
            ["jumlah_faktur", "COUNT(*) FILTER (WHERE jenis <> 'Penerimaan')"],
          ],
        }),
        [pola(q), n]
      );
      const { hariIni, agregat, data } = bongkar(rows, "nomor");
      return {
        ok: true,
        meta: {
          pencarian: q,
          dihitung_pada: hariIni,
          satuan_nilai: "IDR",
          total_nilai_penerimaan: agregat.total_nilai_penerimaan ?? 0,
          total_nilai_faktur: agregat.total_nilai_faktur ?? 0,
          jumlah_penerimaan: agregat.jumlah_penerimaan ?? 0,
          jumlah_faktur: agregat.jumlah_faktur ?? 0,
          keterangan:
            "nilai penerimaan adalah nilai persediaan masuk; nilai faktur sudah " +
            "termasuk PPN. Keduanya dijumlahkan TERPISAH karena artinya berbeda — " +
            "jangan menggabungkannya, dan jangan menjumlahkan kolom nilai sendiri.",
          batas_baris: n,
          jumlah_baris: data.length,
          jumlah_baris_seluruhnya: agregat.baris_seluruhnya ?? data.length,
        },
        rows: data,
      };
    }),
  },

  {
    name: "jurnal_dokumen",
    description:
      "Baris jurnal yang terbentuk dari satu dokumen, dicari lewat nomor dokumen " +
      "(penerimaan atau faktur) atau nomor jurnalnya sendiri. Pakai ini untuk " +
      "menelusuri asal sebuah angka sampai ke akunnya. meta.total_debit, " +
      "meta.total_kredit, dan meta.seimbang sudah dihitung database; kutip dari " +
      "sana, JANGAN menjumlahkan kolom debit atau credit sendiri.",
    parameters: {
      type: "object",
      properties: {
        nomor_dokumen: { type: "string", description: "Nomor dokumen atau nomor jurnal, persis." },
        limit: { type: "integer", description: "Maksimum baris (1-50, bawaan 20)." },
      },
      required: ["nomor_dokumen"],
    },
    handler: bungkus(async (a) => {
      const no = teks(a.nomor_dokumen, "nomor_dokumen", { wajib: true, maks: 60 })!;
      const n = batas(a.limit);
      const rows = await aiQuery(
        bungkusKueri({
          inner: `SELECT j.entry_no AS jurnal,
                to_char(j.entry_date, 'YYYY-MM-DD') AS tanggal,
                j.description AS keterangan,
                j.source_type AS dokumen_jenis, j.is_posted AS terposting,
                a.code AS kode_akun, a.name AS akun,
                pt.name AS mitra, l.debit, l.credit
           FROM journal_entry j
           JOIN journal_line l ON l.entry_id = j.id
           JOIN account a      ON a.id = l.account_id
           LEFT JOIN partner pt ON pt.id = l.partner_id
          WHERE j.entry_no = $1
             OR j.source_id IN (
                  SELECT id FROM goods_receipt WHERE doc_no = $1
                  UNION ALL
                  SELECT id FROM sales_invoice WHERE doc_no = $1
                )
          `,
          urut: "debit DESC, kode_akun",
          limit: "$2",
          total: [
            ["total_debit", "ROUND(COALESCE(SUM(debit), 0), 2)"],
            ["total_kredit", "ROUND(COALESCE(SUM(credit), 0), 2)"],
          ],
        }),
        [no, n]
      );
      const { hariIni, agregat, data } = bongkar(rows, "jurnal");
      const d = Number(agregat.total_debit ?? 0);
      const k = Number(agregat.total_kredit ?? 0);
      return {
        ok: true,
        meta: {
          nomor_dicari: no,
          dihitung_pada: hariIni,
          satuan_nilai: "IDR",
          total_debit: agregat.total_debit ?? 0,
          total_kredit: agregat.total_kredit ?? 0,
          seimbang: Math.abs(d - k) < 0.005,
          keterangan:
            "debit dan kredit satu jurnal selalu seimbang; dipaksa constraint " +
            "database. Pakai total_debit, total_kredit, dan seimbang dari meta; " +
            "JANGAN menjumlahkan kolom sendiri.",
          batas_baris: n,
          jumlah_baris: data.length,
          jumlah_baris_seluruhnya: agregat.baris_seluruhnya ?? data.length,
        },
        rows: data,
      };
    }),
  },
];

/** Bentuk yang dikirim ke OpenRouter (kompatibel OpenAI). */
export function toolSchemas() {
  return TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export async function runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) {
    return {
      ok: false,
      error: `Alat "${name}" tidak ada. Alat yang tersedia: ${TOOLS.map((x) => x.name).join(", ")}.`,
    };
  }
  return t.handler(args);
}
