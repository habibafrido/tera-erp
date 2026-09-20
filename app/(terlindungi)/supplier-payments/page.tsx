import Link from "next/link";
import { query } from "@/lib/db";
import {
  Badge, Code, Empty, NameCell, Num, PageHeader, Panel, StatBand, TableWrap,
} from "@/components/ui";
import { TombolEkspor } from "@/components/TombolEkspor";
import { TombolBatal } from "@/components/TombolBatal";
import { rupiah, tanggal } from "@/lib/format";

export const dynamic = "force-dynamic";

const CARA: Record<string, string> = {
  TRANSFER: "Transfer",
  CASH: "Tunai",
  GIRO: "Giro",
};

export default async function SupplierPaymentsPage() {
  // Tanggal bawaan pembalik diambil dari DATABASE, bukan jam browser.
  const [hari] = await query<{ d: string }>(
    `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`
  );

  const payments = await query(`
    SELECT p.id, p.doc_no,
           to_char(p.doc_date, 'YYYY-MM-DD') AS doc_date,
           p.method, p.reference, p.status,
           p.amount, p.allocated, p.unallocated,
           s.code AS supplier_code, s.name AS supplier,
           COUNT(a.id) AS jumlah_faktur
      FROM supplier_payment p
      JOIN partner s ON s.id = p.supplier_id
      LEFT JOIN supplier_payment_allocation a ON a.payment_id = p.id
     GROUP BY p.id, s.code, s.name
     ORDER BY p.doc_date DESC, p.created_at DESC
     LIMIT 50
  `);

  /*
   * Sisa utang diambil dari v_purchase_outstanding, bukan dari kolom
   * tersimpan. Tidak ada kolom saldo utang di mana pun — keputusan yang
   * sama dengan sisa tagihan piutang dan saldo stok.
   */
  const [ringkas] = await query<{
    utang: string;
    faktur_terbuka: string;
    dibayar: string;
    uang_muka: string;
  }>(`
    SELECT COALESCE(SUM(o.sisa), 0)                         AS utang,
           COUNT(*) FILTER (WHERE o.sisa > 0)               AS faktur_terbuka,
           (SELECT COALESCE(SUM(amount), 0) FROM supplier_payment
             WHERE status = 'POSTED')                       AS dibayar,
           (SELECT COALESCE(SUM(unallocated), 0) FROM supplier_payment
             WHERE status = 'POSTED')                       AS uang_muka
      FROM v_purchase_outstanding o
     WHERE o.sisa > 0
  `);

  const terbuka = await query(`
    SELECT o.doc_no, o.supplier_ref,
           to_char(o.doc_date, 'YYYY-MM-DD') AS doc_date,
           o.total, o.dibayar, o.sisa, o.hari_sejak_faktur,
           s.code AS supplier_code, s.name AS supplier
      FROM v_purchase_outstanding o
      JOIN partner s ON s.id = o.supplier_id
     WHERE o.sisa > 0
     ORDER BY o.doc_date, o.doc_no
     LIMIT 25
  `);

  return (
    <>
      <PageHeader
        title="Bayar pemasok"
        desc="Sisi yang melengkapi utang usaha. Tanpa dokumen ini, Utang Usaha hanya bisa bertambah dan laporan arus kas hanya akan berisi kas masuk."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <TombolEkspor laporan="pembayaran_pemasok" filter={{ periode: "tahun_ini" }} />
            <Link href="/supplier-payments/new" className="btn">
              Catat pembayaran
            </Link>
          </div>
        }
      />

      <StatBand
        items={[
          {
            label: "Sisa utang",
            value: rupiah(ringkas?.utang ?? 0),
            hint: `${ringkas?.faktur_terbuka ?? 0} faktur terbuka`,
          },
          { label: "Uang dibayarkan", value: rupiah(ringkas?.dibayar ?? 0) },
          {
            label: "Uang muka pembelian",
            value: rupiah(ringkas?.uang_muka ?? 0),
            hint: "aset, bukan beban",
          },
        ]}
      />

      <Panel className="mb-8" title="Faktur pembelian yang belum lunas" meta="25 terlama">
        {terbuka.length === 0 ? (
          <Empty text="Semua faktur pembelian sudah lunas." />
        ) : (
          <TableWrap min={800}>
            <thead>
              <tr>
                <th className="th">Faktur</th>
                <th className="th">Pemasok</th>
                <th className="th">Tanggal</th>
                <th className="th text-right">Nilai</th>
                <th className="th text-right">Dibayar</th>
                <th className="th text-right">Sisa</th>
              </tr>
            </thead>
            <tbody>
              {terbuka.map((r) => (
                <tr key={r.doc_no}>
                  <td className="td">
                    <Code>{r.doc_no}</Code>
                    {r.supplier_ref && (
                      <span className="block text-xs text-muted">
                        ref {r.supplier_ref}
                      </span>
                    )}
                  </td>
                  <NameCell name={r.supplier} sub={r.supplier_code} />
                  <td className="td text-muted">
                    {tanggal(r.doc_date)}
                    {Number(r.hari_sejak_faktur) > 60 && (
                      <span className="ml-2">
                        <Badge tone="warning">{r.hari_sejak_faktur} hari</Badge>
                      </span>
                    )}
                  </td>
                  <Num muted>{rupiah(r.total)}</Num>
                  <Num muted>
                    {Number(r.dibayar) === 0 ? "—" : rupiah(r.dibayar)}
                  </Num>
                  <Num strong>{rupiah(r.sisa)}</Num>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <h2 className="mb-3 text-sm font-semibold">Pembayaran terakhir</h2>

      {payments.length === 0 ? (
        <Panel>
          <Empty
            text="Belum ada pembayaran ke pemasok."
            action={
              <Link href="/supplier-payments/new" className="btn">
                Catat pembayaran
              </Link>
            }
          />
        </Panel>
      ) : (
        <Panel>
          <TableWrap min={900}>
            <thead>
              <tr>
                <th className="th">Nomor</th>
                <th className="th">Tanggal</th>
                <th className="th">Pemasok</th>
                <th className="th">Cara</th>
                <th className="th text-right">Dibayar</th>
                <th className="th text-right">Dialokasikan</th>
                <th className="th text-right">Uang muka</th>
                <th className="th">Status</th>
                <th className="th text-right">Koreksi</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="td">
                    <Code>{p.doc_no ?? "—"}</Code>
                    {Number(p.jumlah_faktur) > 1 && (
                      <span className="ml-2 text-xs text-muted">
                        {p.jumlah_faktur} faktur
                      </span>
                    )}
                  </td>
                  <td className="td text-muted">{tanggal(p.doc_date)}</td>
                  <NameCell name={p.supplier} sub={p.supplier_code} />
                  <td className="td text-muted">
                    {CARA[p.method] ?? p.method}
                    {p.reference && (
                      <span className="block text-xs text-muted">{p.reference}</span>
                    )}
                  </td>
                  <Num strong>{rupiah(p.amount)}</Num>
                  <Num>{rupiah(p.allocated)}</Num>
                  <Num muted>
                    {Number(p.unallocated) === 0 ? "—" : rupiah(p.unallocated)}
                  </Num>
                  <td className="td">
                    <Badge
                      tone={
                        p.status === "POSTED"
                          ? "positive"
                          : p.status === "CANCELLED"
                            ? "danger"
                            : "warning"
                      }
                    >
                      {p.status === "POSTED"
                        ? "Terposting"
                        : p.status === "CANCELLED"
                          ? "Dibatalkan"
                          : "Draf"}
                    </Badge>
                  </td>
                  <td className="td td-num">
                    {p.status === "DRAFT" ? (
                      <span className="text-xs text-muted">—</span>
                    ) : (
                      <TombolBatal
                        jenis="SUPPLIER_PAYMENT"
                        dokumenId={p.id}
                        docNo={p.doc_no ?? "(tanpa nomor)"}
                        hariIni={hari.d}
                        sudahBatal={p.status === "CANCELLED"}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Panel>
      )}
    </>
  );
}
