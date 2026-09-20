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

export default async function PaymentsPage() {
  // Tanggal bawaan pembalik diambil dari DATABASE, bukan jam browser:
  // tanggal yang salah di sini masuk ke jurnal pembalik.
  const [hari] = await query<{ d: string }>(
    `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`
  );

  const payments = await query(`
    SELECT p.id, p.doc_no,
           to_char(p.doc_date, 'YYYY-MM-DD') AS doc_date,
           p.method, p.reference, p.status,
           p.amount, p.allocated, p.unallocated,
           c.code AS customer_code, c.name AS customer,
           COUNT(a.id) AS jumlah_faktur
      FROM payment_receipt p
      JOIN partner c ON c.id = p.customer_id
      LEFT JOIN payment_allocation a ON a.payment_id = p.id
     GROUP BY p.id, c.code, c.name
     ORDER BY p.doc_date DESC, p.created_at DESC
     LIMIT 50
  `);

  /*
   * Ringkasan piutang diambil dari v_invoice_outstanding, bukan dari
   * menjumlahkan sales_invoice.total. Tidak ada kolom sisa tagihan yang
   * disimpan di mana pun — itu keputusan yang sama dengan tidak
   * menyimpan saldo stok.
   */
  const [ringkas] = await query<{
    piutang: string;
    faktur_terbuka: string;
    jatuh_tempo: string;
    diterima: string;
    titipan: string;
  }>(`
    SELECT COALESCE(SUM(o.sisa), 0)                                   AS piutang,
           COUNT(*) FILTER (WHERE o.sisa > 0)                         AS faktur_terbuka,
           COALESCE(SUM(o.sisa) FILTER (WHERE o.hari_lewat > 0), 0)   AS jatuh_tempo,
           (SELECT COALESCE(SUM(amount), 0) FROM payment_receipt
             WHERE status = 'POSTED')                                 AS diterima,
           (SELECT COALESCE(SUM(unallocated), 0) FROM payment_receipt
             WHERE status = 'POSTED')                                 AS titipan
      FROM v_invoice_outstanding o
     WHERE o.sisa > 0
  `);

  const terbuka = await query(`
    SELECT o.doc_no,
           to_char(o.doc_date, 'YYYY-MM-DD') AS doc_date,
           to_char(o.due_date, 'YYYY-MM-DD') AS due_date,
           o.total, o.dibayar, o.sisa, o.hari_lewat,
           c.code AS customer_code, c.name AS customer
      FROM v_invoice_outstanding o
      JOIN partner c ON c.id = o.customer_id
     WHERE o.sisa > 0
     ORDER BY o.hari_lewat DESC, o.sisa DESC
     LIMIT 25
  `);

  return (
    <>
      <PageHeader
        title="Penerimaan pembayaran"
        desc="Sisa tagihan setiap faktur dihitung dari nilai faktur dikurangi alokasi pembayaran yang sudah diposting. Tidak ada kolom saldo yang disimpan, jadi tidak ada yang bisa menyimpang."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <TombolEkspor laporan="pelunasan" filter={{ periode: "tahun_ini" }} />
            <Link href="/payments/new" className="btn">
              Catat pembayaran
            </Link>
          </div>
        }
      />

      <StatBand
        items={[
          {
            label: "Sisa piutang",
            value: rupiah(ringkas?.piutang ?? 0),
            hint: `${ringkas?.faktur_terbuka ?? 0} faktur terbuka`,
          },
          { label: "Sudah lewat jatuh tempo", value: rupiah(ringkas?.jatuh_tempo ?? 0) },
          { label: "Uang diterima", value: rupiah(ringkas?.diterima ?? 0) },
          {
            label: "Titipan pelanggan",
            value: rupiah(ringkas?.titipan ?? 0),
            hint: "kewajiban, bukan pendapatan",
          },
        ]}
      />

      <Panel
        className="mb-8"
        title="Faktur yang belum lunas"
        meta="25 teratas menurut keterlambatan"
      >
        {terbuka.length === 0 ? (
          <Empty text="Semua faktur sudah lunas." />
        ) : (
          <TableWrap min={760}>
            <thead>
              <tr>
                <th className="th">Faktur</th>
                <th className="th">Pelanggan</th>
                <th className="th">Jatuh tempo</th>
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
                  </td>
                  <NameCell name={r.customer} sub={r.customer_code} />
                  <td className="td text-muted">
                    {tanggal(r.due_date ?? r.doc_date)}
                    {Number(r.hari_lewat) > 0 && (
                      <span className="ml-2">
                        <Badge tone={Number(r.hari_lewat) > 90 ? "danger" : "warning"}>
                          lewat {r.hari_lewat} hari
                        </Badge>
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
            text="Belum ada pembayaran yang dicatat."
            action={
              <Link href="/payments/new" className="btn">
                Catat pembayaran
              </Link>
            }
          />
        </Panel>
      ) : (
        <Panel>
          <TableWrap min={820}>
            <thead>
              <tr>
                <th className="th">Nomor</th>
                <th className="th">Tanggal</th>
                <th className="th">Pelanggan</th>
                <th className="th">Cara</th>
                <th className="th text-right">Diterima</th>
                <th className="th text-right">Dialokasikan</th>
                <th className="th text-right">Titipan</th>
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
                  <NameCell name={p.customer} sub={p.customer_code} />
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
                        jenis="PAYMENT_RECEIPT"
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
