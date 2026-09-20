import Link from "next/link";
import { query } from "@/lib/db";
import {
  Code, Empty, Num, PageHeader, Panel, StatBand, StatusBadge, TableWrap,
} from "@/components/ui";
import { TombolEkspor } from "@/components/TombolEkspor";
import { TombolBatal } from "@/components/TombolBatal";
import { num, rupiah, tanggal } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ReceiptsPage() {
  // Tanggal bawaan pembalik diambil dari DATABASE, bukan jam browser:
  // tanggal yang salah di sini masuk ke jurnal pembalik.
  const [hari] = await query<{ d: string }>(
    `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`
  );

  const receipts = await query(`
    SELECT g.id, g.doc_no, g.doc_date, g.status, g.total_value, g.supplier_ref,
           p.name AS supplier, w.name AS gudang,
           (SELECT COUNT(*) FROM goods_receipt_line l WHERE l.receipt_id = g.id) AS baris
      FROM goods_receipt g
      JOIN partner p   ON p.id = g.supplier_id
      JOIN warehouse w ON w.id = g.warehouse_id
     ORDER BY g.doc_date DESC, g.created_at DESC
     LIMIT 30
  `);

  const terposting = receipts.filter((r) => r.status === "POSTED");
  const nilai = terposting.reduce((a, r) => a + Number(r.total_value ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Penerimaan barang"
        desc="Posting menambah stok pada harga beli dan menjurnal Dr Persediaan / Cr Barang Diterima Belum Ditagih. Utang usaha baru diakui saat faktur pemasok masuk."
        action={
          <div className="flex items-center gap-2">
            <TombolEkspor laporan="daftar_penerimaan" filter={{ periode: "tahun_ini" }} />
            <Link href="/receipts/new" className="btn">
              Catat penerimaan
            </Link>
          </div>
        }
      />

      <StatBand
        items={[
          { label: "Nilai diterima", value: rupiah(nilai), hint: "30 dokumen terakhir" },
          { label: "Dokumen terposting", value: num(terposting.length) },
          { label: "Total dokumen", value: num(receipts.length) },
        ]}
      />

      <Panel title="Penerimaan terakhir">
        {receipts.length === 0 ? (
          <Empty
            text="Belum ada penerimaan barang."
            action={
              <Link href="/receipts/new" className="btn">
                Catat penerimaan pertama
              </Link>
            }
          />
        ) : (
          <TableWrap min={820}>
            <thead>
              <tr>
                <th className="th">Nomor</th>
                <th className="th">Tanggal</th>
                <th className="th">Pemasok</th>
                <th className="th">Gudang</th>
                <th className="th">Surat jalan</th>
                <th className="th text-right">Baris</th>
                <th className="th text-right">Nilai</th>
                <th className="th">Status</th>
                <th className="th text-right">Koreksi</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r, i) => (
                <tr key={r.doc_no ?? i}>
                  <td className="td">{r.doc_no ? <Code>{r.doc_no}</Code> : "—"}</td>
                  <td className="td text-muted">{tanggal(r.doc_date)}</td>
                  <td className="td font-medium">{r.supplier}</td>
                  <td className="td text-muted">{r.gudang}</td>
                  <td className="td text-muted">{r.supplier_ref ?? "—"}</td>
                  <Num>{num(r.baris)}</Num>
                  <Num strong>{rupiah(r.total_value)}</Num>
                  <td className="td"><StatusBadge status={r.status} /></td>
                  <td className="td td-num">
                    {r.status === "DRAFT" ? (
                      <span className="text-xs text-muted">—</span>
                    ) : (
                      <TombolBatal
                        jenis="GOODS_RECEIPT"
                        dokumenId={r.id}
                        docNo={r.doc_no}
                        hariIni={hari.d}
                        sudahBatal={r.status === "CANCELLED"}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>
    </>
  );
}
