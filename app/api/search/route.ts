import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { penggunaUntukApi } from "@/lib/auth/penjaga";

export const dynamic = "force-dynamic";

/** Kecocokan di bawah ini dianggap kebetulan dan tidak ditampilkan. */
const AMBANG = 0.15;

const MIN_PANJANG = 2;
const MAKS_PANJANG = 100;
const PER_KELOMPOK = 5;

export type HasilItem = {
  label: string;
  sub: string;
  href: string;
};

export type HasilKelompok = {
  title: string;
  items: HasilItem[];
};

/**
 * Meloloskan karakter khusus LIKE dari masukan pengguna.
 *
 * Tanpa ini, mengetik "%" menghasilkan pola yang cocok dengan segalanya
 * dan mengetik "_" cocok dengan sembarang satu karakter. Itu bukan celah
 * injeksi — polanya tetap dikirim sebagai parameter terikat — tapi
 * hasilnya membingungkan dan memaksa pemindaian tabel penuh.
 */
function polaLike(q: string): string {
  return "%" + q.replace(/([\\%_])/g, "\\$1") + "%";
}

const rupiah = (v: unknown) =>
  v === null || v === undefined
    ? null
    : new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0,
      }).format(Number(v));

const tanggal = (v: unknown) =>
  v
    ? new Intl.DateTimeFormat("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(v instanceof Date ? v : new Date(String(v)))
    : "";

/** Jenis dokumen -> halaman daftarnya. */
const HALAMAN: Record<string, string> = {
  Penerimaan: "/receipts",
  Penjualan: "/sales",
  Pembayaran: "/payments",
  "Faktur pembelian": "/purchases",
  "Bayar pemasok": "/supplier-payments",
};

/**
 * Route handler diperiksa TERPISAH dari middleware.
 *
 * Middleware hanya tahu ada-tidaknya cookie; ia tidak bisa menyentuh
 * database dari runtime Edge. Cookie palsu berisi teks apa pun lolos
 * dari sana dan berhenti di sini.
 */
export async function GET(req: Request) {
  if (!(await penggunaUntukApi("pencarian.cari"))) {
    return NextResponse.json(
      { error: "Sesi tidak ditemukan atau peran tidak berwenang." },
      { status: 401 }
    );
  }

  const mentah = new URL(req.url).searchParams.get("q") ?? "";
  const q = mentah.trim().slice(0, MAKS_PANJANG);

  // Di bawah dua karakter, database tidak disentuh sama sekali.
  if (q.length < MIN_PANJANG) {
    return NextResponse.json({ groups: [] as HasilKelompok[] });
  }

  const pola = polaLike(q);

  try {
    // Ketiga kueri berjalan bersamaan; tidak ada yang bergantung pada hasil
    // yang lain. Semuanya SELECT, semuanya berparameter, semuanya ber-LIMIT.
    const [barang, mitra, dokumen] = await Promise.all([
      query(
        `SELECT p.sku, p.name,
                COALESCE(b.qty, 0)   AS qty,
                COALESCE(b.nilai, 0) AS nilai,
                GREATEST(similarity(p.name, $1), similarity(p.sku, $1)) AS skor
           FROM product p
           LEFT JOIN (
             SELECT product_id, SUM(qty_on_hand) AS qty, SUM(stock_value) AS nilai
               FROM v_stock_balance GROUP BY product_id
           ) b ON b.product_id = p.id
          WHERE p.is_active
            AND (p.name ILIKE $2 OR p.sku ILIKE $2
                 OR similarity(p.name, $1) > $3
                 OR similarity(p.sku,  $1) > $3)
          ORDER BY skor DESC, p.sku
          LIMIT $4`,
        [q, pola, AMBANG, PER_KELOMPOK]
      ),

      query(
        `SELECT p.code, p.name, p.is_customer, p.is_supplier,
                GREATEST(similarity(p.name, $1), similarity(p.code, $1)) AS skor
           FROM partner p
          WHERE p.name ILIKE $2 OR p.code ILIKE $2
             OR similarity(p.name, $1) > $3
             OR similarity(p.code, $1) > $3
          ORDER BY skor DESC, p.code
          LIMIT $4`,
        [q, pola, AMBANG, PER_KELOMPOK]
      ),

      query(
        `SELECT * FROM (
           SELECT g.doc_no AS nomor, 'Penerimaan' AS jenis, g.doc_date AS tanggal,
                  g.total_value AS nilai, similarity(g.doc_no, $1) AS skor
             FROM goods_receipt g
            WHERE g.doc_no IS NOT NULL
              AND (g.doc_no ILIKE $2 OR similarity(g.doc_no, $1) > $3)
           UNION ALL
           SELECT s.doc_no, 'Penjualan', s.doc_date,
                  s.total, similarity(s.doc_no, $1)
             FROM sales_invoice s
            WHERE s.doc_no IS NOT NULL
              AND (s.doc_no ILIKE $2 OR similarity(s.doc_no, $1) > $3)
           UNION ALL
           SELECT p.doc_no, 'Pembayaran', p.doc_date,
                  p.amount, similarity(p.doc_no, $1)
             FROM payment_receipt p
            WHERE p.doc_no IS NOT NULL
              AND (p.doc_no ILIKE $2 OR similarity(p.doc_no, $1) > $3)
           UNION ALL
           SELECT sp.doc_no, 'Bayar pemasok', sp.doc_date,
                  sp.amount, similarity(sp.doc_no, $1)
             FROM supplier_payment sp
            WHERE sp.doc_no IS NOT NULL
              AND (sp.doc_no ILIKE $2 OR similarity(sp.doc_no, $1) > $3)
           UNION ALL
           -- Nomor faktur PEMASOK ikut dicari, bukan hanya nomor internal:
           -- itulah nomor yang tercetak di kertas yang dipegang orang.
           SELECT pi.doc_no, 'Faktur pembelian', pi.doc_date,
                  pi.subtotal,
                  GREATEST(similarity(pi.doc_no, $1),
                           similarity(COALESCE(pi.supplier_ref, ''), $1))
             FROM purchase_invoice pi
            WHERE pi.doc_no IS NOT NULL
              AND (pi.doc_no ILIKE $2
                   OR pi.supplier_ref ILIKE $2
                   OR similarity(pi.doc_no, $1) > $3
                   OR similarity(COALESCE(pi.supplier_ref, ''), $1) > $3)
         ) d
         ORDER BY skor DESC, tanggal DESC
         LIMIT $4`,
        [q, pola, AMBANG, PER_KELOMPOK]
      ),
    ]);

    const groups: HasilKelompok[] = [];

    if (barang.length) {
      groups.push({
        title: "Barang",
        items: barang.map((r) => ({
          label: r.name,
          // Saldo hanya ditampilkan kalau barangnya memang bersaldo.
          sub:
            Number(r.qty) !== 0
              ? `${r.sku} · ${Number(r.qty).toLocaleString("id-ID")} · ${rupiah(r.nilai)}`
              : `${r.sku} · tanpa saldo`,
          href: "/products",
        })),
      });
    }

    if (mitra.length) {
      groups.push({
        title: "Mitra",
        items: mitra.map((r) => {
          const peran = [
            r.is_customer ? "pelanggan" : null,
            r.is_supplier ? "pemasok" : null,
          ].filter(Boolean);
          return {
            label: r.name,
            sub: `${r.code} · ${peran.join(" & ")}`,
            href: "/partners",
          };
        }),
      });
    }

    if (dokumen.length) {
      groups.push({
        title: "Dokumen",
        items: dokumen.map((r) => ({
          label: r.nomor,
          sub: `${r.jenis} · ${tanggal(r.tanggal)} · ${rupiah(r.nilai)}`,
          href: HALAMAN[r.jenis] ?? "/journal",
        })),
      });
    }

    return NextResponse.json({ groups });
  } catch (e) {
    // Penyebab paling mungkin: migrasi 003 belum dijalankan sehingga
    // fungsi similarity() belum ada.
    const kode = (e as { code?: string })?.code;
    const pesan =
      kode === "42883"
        ? "Pencarian belum siap. Jalankan `npm run db:migrate` untuk memasang pg_trgm."
        : "Pencarian gagal. Coba lagi sebentar lagi.";
    console.error("[api/search]", e);
    return NextResponse.json({ groups: [], error: pesan }, { status: 500 });
  }
}
