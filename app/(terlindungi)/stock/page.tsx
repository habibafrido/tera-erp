import { query } from "@/lib/db";
import {
  Badge, Code, Empty, NameCell, Num, PageHeader, Panel, StatBand, TableWrap,
} from "@/components/ui";
import { TombolEkspor } from "@/components/TombolEkspor";
import { BatangHorizontal } from "@/components/grafik/BatangHorizontal";
import { stokMengendapTeratas } from "@/lib/charts";
import { num, rupiah, tanggal } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function StockPage() {
  // Biaya rata-rata tidak disimpan sebagai kolom. Angkanya diturunkan dari
  // nilai dibagi kuantitas pada baris ledger terakhir — itulah definisinya.
  const balances = await query(`
    SELECT p.sku, p.name, p.is_batch_tracked, w.code AS wh_code, w.name AS gudang,
           b.qty_on_hand, b.stock_value,
           CASE WHEN b.qty_on_hand <> 0
                THEN b.stock_value / b.qty_on_hand END AS avg_cost
      FROM v_stock_balance b
      JOIN product   p ON p.id = b.product_id
      JOIN warehouse w ON w.id = b.warehouse_id
     ORDER BY p.sku, w.code
  `);

  const fefo = await query(`
    SELECT p.sku, p.name, w.name AS gudang,
           f.batch_no, f.expiry_date, f.qty_on_hand, f.days_to_expiry
      FROM v_stock_fefo f
      JOIN product   p ON p.id = f.product_id
      JOIN warehouse w ON w.id = f.warehouse_id
     ORDER BY f.expiry_date ASC NULLS LAST, p.sku
     LIMIT 50
  `);

  // 20 pergerakan terakhir. Kolom running_* adalah snapshot rata-rata bergerak
  // SETELAH baris itu, jadi pembentukan biaya bisa dibaca langsung dari sini.
  const moves = await query(`
    SELECT s.posted_at, s.movement_type, s.qty, s.unit_cost,
           s.running_qty, s.running_value,
           p.sku, w.code AS gudang, j.entry_no
      FROM stock_ledger s
      JOIN product   p ON p.id = s.product_id
      JOIN warehouse w ON w.id = s.warehouse_id
      LEFT JOIN journal_entry j ON j.id = s.journal_entry_id
     ORDER BY s.id DESC
     LIMIT 20
  `);

  const mengendap = await stokMengendapTeratas(60);

  const totalNilai = balances.reduce((a, r) => a + Number(r.stock_value ?? 0), 0);
  const totalBatch = fefo.length;

  return (
    <>
      <PageHeader
        title="Saldo stok"
        desc="Semua angka di halaman ini diturunkan dari buku besar stok yang append-only. Tidak ada kolom saldo yang bisa diubah langsung."
        action={<TombolEkspor laporan="saldo_stok" />}
      />

      <StatBand
        items={[
          { label: "Total nilai persediaan", value: rupiah(totalNilai) },
          { label: "Baris saldo", value: num(balances.length), hint: "barang × gudang" },
          { label: "Batch bersaldo", value: num(totalBatch) },
        ]}
      />

      <BatangHorizontal
        className="mb-6"
        judul="Stok mengendap dengan nilai terbesar"
        meta="10 teratas, tanpa pergerakan keluar 60 hari"
        data={mengendap}
        kosong="Tidak ada stok yang mengendap lebih dari 60 hari."
        ringkasan={(d) =>
          `Sepuluh barang mengendap dengan nilai terbesar. Teratas: ` +
          `${d[0].label} ${rupiah(d[0].nilai)}. ` +
          `Total sepuluh barang ini ${rupiah(d.reduce((a, x) => a + x.nilai, 0))}.`
        }
      />

      <Panel className="mb-6" title="Saldo per barang & gudang">
        {balances.length === 0 ? (
          <Empty text="Belum ada stok. Mulai dari penerimaan barang." />
        ) : (
          <TableWrap min={680}>
            <thead>
              <tr>
                <th className="th">Barang</th>
                <th className="th">Gudang</th>
                <th className="th text-right">Kuantitas</th>
                <th className="th text-right">Biaya rata-rata</th>
                <th className="th text-right">Nilai</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b, i) => (
                <tr key={i}>
                  <NameCell name={b.name} sub={b.sku} />
                  <td className="td text-muted">{b.wh_code}</td>
                  <Num>{num(b.qty_on_hand)}</Num>
                  <Num>{rupiah(b.avg_cost)}</Num>
                  <Num strong>{rupiah(b.stock_value)}</Num>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <Panel
        className="mb-6"
        title="Batch (urutan FEFO)"
        meta="paling dekat kedaluwarsa keluar duluan"
        action={<TombolEkspor laporan="batch_kedaluwarsa" filter={{ hari: 3650 }} />}
      >
        {fefo.length === 0 ? (
          <Empty text="Tidak ada batch bersaldo." />
        ) : (
          <TableWrap min={680}>
            <thead>
              <tr>
                <th className="th">Barang</th>
                <th className="th">Gudang</th>
                <th className="th">Batch</th>
                <th className="th">Kedaluwarsa</th>
                <th className="th text-right">Kuantitas</th>
                <th className="th text-right">Sisa umur</th>
              </tr>
            </thead>
            <tbody>
              {fefo.map((f, i) => {
                const d = f.days_to_expiry === null ? null : Number(f.days_to_expiry);
                return (
                  <tr key={i}>
                    <NameCell name={f.name} sub={f.sku} />
                    <td className="td text-muted">{f.gudang}</td>
                    <td className="td"><Code>{f.batch_no}</Code></td>
                    <td className="td text-muted">{tanggal(f.expiry_date)}</td>
                    <Num>{num(f.qty_on_hand)}</Num>
                    <Num>
                      {d === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <Badge tone={d <= 30 ? "danger" : d <= 90 ? "warning" : "muted"}>
                          {num(d)} hari
                        </Badge>
                      )}
                    </Num>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <Panel title="Pergerakan terakhir" meta="saldo berjalan setelah tiap baris">
        {moves.length === 0 ? (
          <Empty text="Buku besar stok masih kosong." />
        ) : (
          <TableWrap min={860}>
            <thead>
              <tr>
                <th className="th">Waktu</th>
                <th className="th">Jenis</th>
                <th className="th">SKU</th>
                <th className="th">Gudang</th>
                <th className="th text-right">Kuantitas</th>
                <th className="th text-right">Biaya satuan</th>
                <th className="th text-right">Saldo qty</th>
                <th className="th text-right">Saldo nilai</th>
                <th className="th">Jurnal</th>
              </tr>
            </thead>
            <tbody>
              {moves.map((m, i) => {
                const masuk = Number(m.qty) > 0;
                return (
                  <tr key={i}>
                    <td className="td text-muted">{tanggal(m.posted_at)}</td>
                    <td className="td">
                      <Badge tone={masuk ? "positive" : "warning"}>{m.movement_type}</Badge>
                    </td>
                    <td className="td"><Code>{m.sku}</Code></td>
                    <td className="td text-muted">{m.gudang}</td>
                    <Num>{num(m.qty)}</Num>
                    <Num>{rupiah(m.unit_cost)}</Num>
                    <Num>{num(m.running_qty)}</Num>
                    <Num>{rupiah(m.running_value)}</Num>
                    <td className="td text-muted">
                      {m.entry_no ? <Code>{m.entry_no}</Code> : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Panel>
    </>
  );
}
