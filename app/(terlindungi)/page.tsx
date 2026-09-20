import Link from "next/link";
import { query } from "@/lib/db";
import { rupiah, num, tanggal } from "@/lib/format";
import {
  Badge, Code, Empty, NameCell, Num, PageHeader, Panel, StatBand, TableWrap,
} from "@/components/ui";
import { TombolEkspor } from "@/components/TombolEkspor";
import { TrenPenjualan } from "@/components/grafik/TrenPenjualan";
import { BatangHorizontal } from "@/components/grafik/BatangHorizontal";
import { nilaiPerGudang, trenPenjualan } from "@/lib/charts";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const [totals] = await query(`
    SELECT COALESCE(SUM(stock_value),0) AS stock_value,
           COUNT(DISTINCT product_id)    AS sku_count
      FROM v_stock_balance
  `);

  const [ar] = await query(`
    SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS saldo
      FROM journal_line jl
      JOIN account_mapping m ON m.account_id = jl.account_id AND m.key='AR'
  `);

  // Batch yang mendekati kedaluwarsa. Ini alasan utama distributor FMCG
  // kehilangan uang tanpa sadar.
  const expiring = await query(`
    SELECT p.sku, p.name, w.name AS warehouse, f.batch_no,
           f.expiry_date, f.qty_on_hand, f.days_to_expiry
      FROM v_stock_fefo f
      JOIN product p   ON p.id = f.product_id
      JOIN warehouse w ON w.id = f.warehouse_id
     WHERE f.expiry_date IS NOT NULL AND f.days_to_expiry <= 90
     ORDER BY f.days_to_expiry
     LIMIT 8
  `);

  // Barang tanpa pergerakan keluar 60 hari terakhir tapi masih ada stok.
  const stale = await query(`
    SELECT p.sku, p.name, b.qty_on_hand, b.stock_value,
           (SELECT MAX(posted_at) FROM stock_ledger s
             WHERE s.product_id = p.id AND s.qty < 0) AS last_out
      FROM (SELECT product_id, SUM(qty_on_hand) qty_on_hand,
                   SUM(stock_value) stock_value
              FROM v_stock_balance GROUP BY product_id) b
      JOIN product p ON p.id = b.product_id
     WHERE b.qty_on_hand > 0
       AND COALESCE((SELECT MAX(posted_at) FROM stock_ledger s
                      WHERE s.product_id = p.id AND s.qty < 0),
                    '1900-01-01') < now() - interval '60 days'
     ORDER BY b.stock_value DESC
     LIMIT 8
  `);

  const [tren, perGudang] = await Promise.all([trenPenjualan(), nilaiPerGudang()]);

  const recent = await query(`
    SELECT doc_no, doc_date, 'Penerimaan' AS jenis, total_value AS nilai
      FROM goods_receipt WHERE status='POSTED'
    UNION ALL
    SELECT doc_no, doc_date, 'Penjualan', total FROM sales_invoice WHERE status='POSTED'
    ORDER BY doc_date DESC, doc_no DESC LIMIT 8
  `);

  return (
    <>
      <PageHeader
        title="Beranda"
        desc="Nilai persediaan dihitung dari buku besar stok, bukan dari kolom saldo yang bisa berubah diam-diam."
      />

      <StatBand
        items={[
          { label: "Nilai persediaan", value: rupiah(totals?.stock_value) },
          { label: "Piutang usaha", value: rupiah(ar?.saldo) },
          { label: "SKU bersaldo", value: num(totals?.sku_count) },
        ]}
      />

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <TrenPenjualan data={tren} />

        <BatangHorizontal
          judul="Nilai persediaan per gudang"
          meta="modal menumpuk di mana"
          data={perGudang}
          kosong="Belum ada stok bersaldo di gudang mana pun."
          ringkasan={(d) =>
            `Nilai persediaan per gudang: ${d
              .map((x) => `${x.label} ${rupiah(x.nilai)}`)
              .join(", ")}.`
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Mendekati kedaluwarsa" meta="90 hari ke depan">
          {expiring.length === 0 ? (
            <Empty text="Tidak ada batch yang mendekati kedaluwarsa." />
          ) : (
            <TableWrap>
              <tbody>
                {expiring.map((r, i) => (
                  <tr key={i}>
                    <NameCell
                      name={r.name}
                      sub={`${r.sku} · batch ${r.batch_no} · ${r.warehouse}`}
                    />
                    <Num>
                      <div>{num(r.qty_on_hand)}</div>
                      <div className="mt-0.5">
                        <Badge tone={Number(r.days_to_expiry) <= 30 ? "danger" : "warning"}>
                          {num(r.days_to_expiry)} hari
                        </Badge>
                      </div>
                    </Num>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Panel>

        <Panel
          title="Stok mengendap"
          meta="tanpa penjualan 60 hari"
          action={<TombolEkspor laporan="stok_mengendap" filter={{ hari: 60 }} />}
        >
          {stale.length === 0 ? (
            <Empty text="Semua barang bersaldo masih bergerak." />
          ) : (
            <TableWrap>
              <tbody>
                {stale.map((r, i) => (
                  <tr key={i}>
                    <NameCell
                      name={r.name}
                      sub={`${r.sku} · keluar terakhir ${tanggal(r.last_out)}`}
                    />
                    <Num>{rupiah(r.stock_value)}</Num>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Panel>
      </div>

      <Panel
        className="mt-6"
        title="Dokumen terakhir"
        action={
          <Link href="/journal" className="rounded text-xs text-action hover:underline">
            Lihat jurnal
          </Link>
        }
      >
        {recent.length === 0 ? (
          <Empty text="Belum ada transaksi. Mulai dari penerimaan barang." />
        ) : (
          <TableWrap min={480}>
            <tbody>
              {recent.map((r, i) => (
                <tr key={i}>
                  <td className="td"><Code>{r.doc_no}</Code></td>
                  <td className="td">{r.jenis}</td>
                  <td className="td text-muted">{tanggal(r.doc_date)}</td>
                  <Num>{rupiah(r.nilai)}</Num>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>
    </>
  );
}
