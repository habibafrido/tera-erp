import { query } from "@/lib/db";
import { createProduct } from "@/app/actions";
import { MasterForm } from "@/components/MasterForm";
import {
  Badge, Empty, NameCell, Num, PageHeader, Panel, StatBand, TableWrap,
} from "@/components/ui";
import { num, rupiah } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const uoms = await query(`SELECT code, name FROM uom ORDER BY code`);

  // Saldo ikut ditampilkan supaya daftar barang langsung berguna,
  // bukan sekadar katalog.
  const products = await query(`
    SELECT p.sku, p.name, p.is_batch_tracked, u.code AS uom,
           COALESCE(b.qty, 0)   AS qty,
           COALESCE(b.nilai, 0) AS nilai
      FROM product p
      JOIN uom u ON u.id = p.base_uom_id
      LEFT JOIN (
        SELECT product_id, SUM(qty_on_hand) AS qty, SUM(stock_value) AS nilai
          FROM v_stock_balance GROUP BY product_id
      ) b ON b.product_id = p.id
     WHERE p.is_active
     ORDER BY p.sku
  `);

  const totalNilai = products.reduce((a, p) => a + Number(p.nilai ?? 0), 0);
  const berbatch = products.filter((p) => p.is_batch_tracked).length;

  return (
    <>
      <PageHeader
        title="Barang"
        desc="Semua kuantitas disimpan dalam satuan dasar. Barang berbatch wajib mengisi nomor batch saat penerimaan."
      />

      <StatBand
        items={[
          { label: "Barang aktif", value: num(products.length) },
          { label: "Dilacak per batch", value: num(berbatch), hint: "FEFO" },
          { label: "Nilai persediaan", value: rupiah(totalNilai) },
        ]}
      />

      <div className="mb-8">
        <MasterForm
          submitLabel="Simpan barang"
          action={createProduct}
          fields={[
            { kind: "text", name: "sku", label: "SKU", placeholder: "SKU-1007", required: true },
            {
              kind: "text", name: "name", label: "Nama barang",
              placeholder: "Teh Celup 25s", required: true,
            },
            {
              kind: "select", name: "uom", label: "Satuan dasar",
              options: uoms.map((u) => ({ value: u.code, label: u.code + " — " + u.name })),
            },
            { kind: "check", name: "is_batch_tracked", label: "Lacak batch & kedaluwarsa" },
          ]}
        />
      </div>

      <Panel title="Daftar barang">
        {products.length === 0 ? (
          <Empty text="Belum ada barang." />
        ) : (
          <TableWrap min={640}>
            <thead>
              <tr>
                <th className="th">Barang</th>
                <th className="th">Satuan</th>
                <th className="th">Batch</th>
                <th className="th text-right">Stok</th>
                <th className="th text-right">Nilai</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.sku}>
                  <NameCell name={p.name} sub={p.sku} />
                  <td className="td text-muted">{p.uom}</td>
                  <td className="td">
                    {p.is_batch_tracked ? (
                      <Badge>FEFO</Badge>
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </td>
                  <Num>{num(p.qty)}</Num>
                  <Num>{rupiah(p.nilai)}</Num>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>
    </>
  );
}
