import { query } from "./db";

/**
 * ============================================================
 * SUMBER DATA GRAFIK
 * ============================================================
 * Semua agregasi dikerjakan Postgres, tidak ada yang dihitung ulang di
 * klien. Tanggal keluar sebagai TEKS lewat to_char — objek Date dari
 * driver pg pernah menggeser tanggal sehari di zona waktu positif.
 *
 * Kueri di sini terpisah dari registry alat AI dan tidak menyentuhnya.
 */

export type TitikTren = {
  bulan: string;
  /** "01".."12" — nama bulannya dibentuk komponen, bukan database. */
  bulan_ke: string;
  label: string;
  subtotal: number;
  hpp: number;
  margin: number;
  margin_persen: number | null;
};

/**
 * Tren 12 bulan terakhir. Bulan tanpa transaksi tetap muncul sebagai nol
 * lewat generate_series — kalau bulan kosong hilang dari sumbu, garisnya
 * akan terlihat naik mulus padahal sebenarnya ada bulan tanpa penjualan.
 */
export async function trenPenjualan(): Promise<TitikTren[]> {
  const rows = await query<Record<string, string>>(`
    WITH bulan AS (
      SELECT d::date AS awal
        FROM generate_series(
               date_trunc('month', CURRENT_DATE) - INTERVAL '11 months',
               date_trunc('month', CURRENT_DATE),
               INTERVAL '1 month') d
    ),
    inv AS (
      SELECT id, doc_date FROM sales_invoice
       WHERE status = 'POSTED'
         AND doc_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '11 months'
    ),
    baris AS (
      SELECT i.id AS invoice_id, i.doc_date, l.product_id,
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
    SELECT to_char(m.awal, 'YYYY-MM') AS bulan,
           -- Nomor bulan, BUKAN nama. to_char(...,'Mon') mengikuti lc_time
           -- database; cluster ini di-initdb dengan locale C sehingga
           -- hasilnya berbahasa Inggris. Namanya dibentuk di lapisan
           -- tampilan, tempat bahasa memang ditentukan.
           to_char(m.awal, 'MM')      AS bulan_ke,
           COALESCE(ROUND(SUM(g.pendapatan), 2), 0) AS subtotal,
           COALESCE(ROUND(SUM(g.hpp), 2), 0)        AS hpp,
           COALESCE(ROUND(SUM(g.pendapatan) - SUM(g.hpp), 2), 0) AS margin,
           CASE WHEN SUM(g.pendapatan) > 0
                THEN ROUND((SUM(g.pendapatan) - SUM(g.hpp)) * 100 / SUM(g.pendapatan), 2)
           END AS margin_persen
      FROM bulan m
      LEFT JOIN g ON date_trunc('month', g.doc_date) = m.awal
     GROUP BY m.awal
     ORDER BY m.awal
  `);

  const NAMA = ["", "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
                "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

  return rows.map((r) => ({
    bulan: r.bulan,
    bulan_ke: r.bulan_ke,
    label: NAMA[Number(r.bulan_ke)] ?? r.bulan_ke,
    subtotal: Number(r.subtotal),
    hpp: Number(r.hpp),
    margin: Number(r.margin),
    margin_persen: r.margin_persen === null ? null : Number(r.margin_persen),
  }));
}

export type BarisBatang = { label: string; sub?: string; nilai: number };

/** Nilai persediaan per gudang. */
export async function nilaiPerGudang(): Promise<BarisBatang[]> {
  const rows = await query<Record<string, string>>(`
    SELECT w.name AS label, w.code AS sub,
           COALESCE(SUM(b.stock_value), 0) AS nilai
      FROM warehouse w
      LEFT JOIN v_stock_balance b ON b.warehouse_id = w.id
     WHERE w.is_active
     GROUP BY w.id, w.name, w.code
    HAVING COALESCE(SUM(b.stock_value), 0) > 0
     ORDER BY nilai DESC
  `);
  return rows.map((r) => ({ label: r.label, sub: r.sub, nilai: Number(r.nilai) }));
}

/** Sepuluh barang mengendap dengan nilai terbesar. */
export async function stokMengendapTeratas(hari = 60): Promise<BarisBatang[]> {
  const rows = await query<Record<string, string>>(
    `SELECT p.name AS label, p.sku AS sub, b.stock_value AS nilai
       FROM (SELECT product_id, SUM(qty_on_hand) AS qty_on_hand,
                    SUM(stock_value) AS stock_value
               FROM v_stock_balance GROUP BY product_id) b
       JOIN product p ON p.id = b.product_id
       LEFT JOIN (SELECT product_id, MAX(posted_at) AS keluar
                    FROM stock_ledger WHERE qty < 0 GROUP BY product_id) k
         ON k.product_id = p.id
      WHERE b.qty_on_hand > 0
        AND COALESCE(k.keluar, '1900-01-01'::timestamptz)
            < now() - ($1 || ' days')::interval
      ORDER BY b.stock_value DESC
      LIMIT 10`,
    [hari]
  );
  return rows.map((r) => ({ label: r.label, sub: r.sub, nilai: Number(r.nilai) }));
}

export type EmberPiutang = { ember: string; nilai: number; berisiko: boolean };

/**
 * Umur SISA piutang per ember, dihitung dari tanggal jatuh tempo.
 *
 * Memakai v_invoice_outstanding, sumber yang sama dengan alat AI dan
 * laporan ekspor. Kalau grafik ini memakai nilai faktur bruto sementara
 * yang lain memakai sisa, dua angka berbeda untuk hal yang sama akan
 * tampil di layar yang sama.
 */
export async function umurPiutangEmber(): Promise<EmberPiutang[]> {
  const [r] = await query<Record<string, string>>(`
    WITH umur AS (
      SELECT o.sisa AS total, o.hari_lewat AS hari
        FROM v_invoice_outstanding o
       WHERE o.sisa > 0
    )
    SELECT ROUND(COALESCE(SUM(CASE WHEN hari <= 30 THEN total END), 0), 2) AS e0,
           ROUND(COALESCE(SUM(CASE WHEN hari BETWEEN 31 AND 60 THEN total END), 0), 2) AS e31,
           ROUND(COALESCE(SUM(CASE WHEN hari BETWEEN 61 AND 90 THEN total END), 0), 2) AS e61,
           ROUND(COALESCE(SUM(CASE WHEN hari > 90 THEN total END), 0), 2) AS e90
      FROM umur
  `);

  return [
    { ember: "0–30 hari", nilai: Number(r?.e0 ?? 0), berisiko: false },
    { ember: "31–60 hari", nilai: Number(r?.e31 ?? 0), berisiko: false },
    { ember: "61–90 hari", nilai: Number(r?.e61 ?? 0), berisiko: false },
    { ember: "di atas 90 hari", nilai: Number(r?.e90 ?? 0), berisiko: true },
  ];
}
