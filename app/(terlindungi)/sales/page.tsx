import Link from "next/link";
import { query } from "@/lib/db";
import {
  Badge, Code, Empty, Num, PageHeader, Panel, StatBand, StatusBadge, TableWrap,
} from "@/components/ui";
import { TombolEkspor } from "@/components/TombolEkspor";
import { TombolBatal } from "@/components/TombolBatal";
import { num, rupiah, tanggal } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Margin kotor dihitung dari subtotal sebelum PPN, bukan dari total. */
function marginPersen(subtotal: unknown, cogs: unknown): number | null {
  const s = Number(subtotal);
  const c = Number(cogs);
  if (!Number.isFinite(s) || !Number.isFinite(c) || s <= 0) return null;
  return ((s - c) / s) * 100;
}

export default async function SalesPage() {
  // Tanggal bawaan pembalik diambil dari DATABASE, bukan jam browser:
  // tanggal yang salah di sini masuk ke jurnal pembalik.
  const [hari] = await query<{ d: string }>(
    `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`
  );

  const invoices = await query(`
    SELECT s.id, s.doc_no, s.doc_date, s.due_date, s.status,
           s.subtotal, s.tax_amount, s.total, s.cogs_amount,
           p.name AS pelanggan, w.name AS gudang
      FROM sales_invoice s
      JOIN partner p   ON p.id = s.customer_id
      JOIN warehouse w ON w.id = s.warehouse_id
     ORDER BY s.doc_date DESC, s.created_at DESC
     LIMIT 30
  `);

  const terposting = invoices.filter((s) => s.status === "POSTED");
  const omzet = terposting.reduce((a, s) => a + Number(s.subtotal ?? 0), 0);
  const hpp = terposting.reduce((a, s) => a + Number(s.cogs_amount ?? 0), 0);
  const marginTotal = marginPersen(omzet, hpp);

  return (
    <>
      <PageHeader
        title="Penjualan"
        desc="Satu posting menghasilkan dua peristiwa: pengakuan pendapatan dan pengakuan harga pokok. HPP memakai rata-rata bergerak saat itu, bukan harga beli terakhir."
        action={
          <div className="flex items-center gap-2">
            <TombolEkspor laporan="daftar_faktur" filter={{ periode: "tahun_ini" }} />
            <Link href="/sales/new" className="btn">
              Buat faktur
            </Link>
          </div>
        }
      />

      <StatBand
        items={[
          { label: "Omzet sebelum PPN", value: rupiah(omzet), hint: "30 faktur terakhir" },
          { label: "Harga pokok", value: rupiah(hpp) },
          {
            label: "Margin kotor",
            value: marginTotal === null ? "—" : marginTotal.toFixed(1) + "%",
          },
        ]}
      />

      <Panel
        title="Faktur terakhir"
        action={<TombolEkspor laporan="ringkasan_penjualan" filter={{ periode: "tahun_ini" }} label="Unduh ringkasan" />}
      >
        {invoices.length === 0 ? (
          <Empty
            text="Belum ada faktur penjualan."
            action={
              <Link href="/sales/new" className="btn">
                Buat faktur pertama
              </Link>
            }
          />
        ) : (
          <TableWrap min={980}>
            <thead>
              <tr>
                <th className="th">Nomor</th>
                <th className="th">Tanggal</th>
                <th className="th">Pelanggan</th>
                <th className="th">Jatuh tempo</th>
                <th className="th text-right">Subtotal</th>
                <th className="th text-right">PPN</th>
                <th className="th text-right">Total</th>
                <th className="th text-right">HPP</th>
                <th className="th text-right">Margin</th>
                <th className="th">Status</th>
                <th className="th text-right">Koreksi</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((s, i) => {
                const m = marginPersen(s.subtotal, s.cogs_amount);
                return (
                  <tr key={s.doc_no ?? i}>
                    <td className="td">{s.doc_no ? <Code>{s.doc_no}</Code> : "—"}</td>
                    <td className="td text-muted">{tanggal(s.doc_date)}</td>
                    <td className="td font-medium">{s.pelanggan}</td>
                    <td className="td text-muted">{tanggal(s.due_date)}</td>
                    <Num>{rupiah(s.subtotal)}</Num>
                    <Num muted>{rupiah(s.tax_amount)}</Num>
                    <Num strong>{rupiah(s.total)}</Num>
                    <Num muted>{rupiah(s.cogs_amount)}</Num>
                    <Num>
                      {m === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <Badge tone={m < 0 ? "danger" : m < 10 ? "warning" : "positive"}>
                          {m.toFixed(1)}%
                        </Badge>
                      )}
                    </Num>
                    <td className="td"><StatusBadge status={s.status} /></td>
                    <td className="td td-num">
                      {s.status === "DRAFT" ? (
                        <span className="text-xs text-muted">—</span>
                      ) : (
                        <TombolBatal
                          jenis="SALES_INVOICE"
                          dokumenId={s.id}
                          docNo={s.doc_no}
                          hariIni={hari.d}
                          sudahBatal={s.status === "CANCELLED"}
                        />
                      )}
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
