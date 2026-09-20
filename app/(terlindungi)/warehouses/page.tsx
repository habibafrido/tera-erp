import { query } from "@/lib/db";
import { createWarehouse } from "@/app/actions";
import { MasterForm } from "@/components/MasterForm";
import {
  Empty, NameCell, Num, PageHeader, Panel, StatBand, TableWrap,
} from "@/components/ui";
import { num, rupiah } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function WarehousesPage() {
  const rows = await query(`
    SELECT w.code, w.name,
           COALESCE(b.sku, 0)   AS sku_count,
           COALESCE(b.nilai, 0) AS nilai
      FROM warehouse w
      LEFT JOIN (
        SELECT warehouse_id, COUNT(DISTINCT product_id) AS sku, SUM(stock_value) AS nilai
          FROM v_stock_balance GROUP BY warehouse_id
      ) b ON b.warehouse_id = w.id
     WHERE w.is_active
     ORDER BY w.code
  `);

  const totalNilai = rows.reduce((a, w) => a + Number(w.nilai ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Gudang"
        desc="Biaya rata-rata bergerak dihitung per kombinasi barang dan gudang, jadi tiap gudang punya nilai persediaannya sendiri."
      />

      <StatBand
        items={[
          { label: "Gudang aktif", value: num(rows.length) },
          { label: "Nilai persediaan", value: rupiah(totalNilai) },
        ]}
      />

      <div className="mb-8">
        <MasterForm
          submitLabel="Simpan gudang"
          action={createWarehouse}
          fields={[
            { kind: "text", name: "code", label: "Kode", placeholder: "WH-SLT", required: true },
            {
              kind: "text", name: "name", label: "Nama gudang",
              placeholder: "Gudang Selatan", required: true,
            },
          ]}
        />
      </div>

      <Panel title="Daftar gudang">
        {rows.length === 0 ? (
          <Empty text="Belum ada gudang." />
        ) : (
          <TableWrap min={520}>
            <thead>
              <tr>
                <th className="th">Gudang</th>
                <th className="th text-right">SKU bersaldo</th>
                <th className="th text-right">Nilai persediaan</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.code}>
                  <NameCell name={w.name} sub={w.code} />
                  <Num>{num(w.sku_count)}</Num>
                  <Num strong>{rupiah(w.nilai)}</Num>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>
    </>
  );
}
