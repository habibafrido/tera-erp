import Link from "next/link";
import { query } from "@/lib/db";
import {
  Badge, Code, Empty, NameCell, Num, PageHeader, Panel, StatBand, TableWrap,
} from "@/components/ui";
import { TombolEkspor } from "@/components/TombolEkspor";
import { TombolBatal } from "@/components/TombolBatal";
import { num, rupiah, tanggal } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function PurchasesPage() {
  // Tanggal bawaan pembalik diambil dari DATABASE, bukan jam browser:
  // tanggal yang salah di sini masuk ke jurnal pembalik.
  const [hari] = await query<{ d: string }>(
    `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`
  );

  const invoices = await query(`
    SELECT pi.id, pi.doc_no,
           to_char(pi.doc_date, 'YYYY-MM-DD') AS doc_date,
           pi.supplier_ref, pi.status,
           pi.subtotal, pi.tax_amount, pi.total,
           pi.grni_amount, pi.price_variance, pi.qty_variance,
           pi.qty_variance_approved, pi.approved_by,
           s.code AS supplier_code, s.name AS supplier,
           COUNT(l.id) AS jumlah_baris
      FROM purchase_invoice pi
      JOIN partner s ON s.id = pi.supplier_id
      LEFT JOIN purchase_invoice_line l ON l.invoice_id = pi.id
     GROUP BY pi.id, s.code, s.name
     ORDER BY pi.doc_date DESC, pi.created_at DESC
     LIMIT 50
  `);

  /*
   * Saldo GRNI diambil dari BUKU BESAR, sementara "yang belum
   * difakturkan" dihitung dari v_receipt_matching. Keduanya jalur yang
   * berbeda dan harus menghasilkan angka yang sama — kalau berbeda,
   * ada penerimaan yang jurnalnya tidak cocok dengan dokumennya.
   */
  const [ringkas] = await query<{
    grni_buku: string;
    grni_dokumen: string;
    baris_menggantung: string;
    selisih_harga: string;
    selisih_qty: string;
  }>(`
    SELECT COALESCE((SELECT SUM(l.credit - l.debit)
                       FROM journal_line l
                       JOIN journal_entry e ON e.id = l.entry_id AND e.is_posted
                       JOIN account a ON a.id = l.account_id
                      WHERE a.code = '2-1300'), 0)                AS grni_buku,
           COALESCE((SELECT SUM(grni_sisa) FROM v_receipt_matching), 0)
                                                                  AS grni_dokumen,
           (SELECT COUNT(*) FROM v_receipt_matching WHERE qty_sisa > 0)
                                                                  AS baris_menggantung,
           COALESCE((SELECT SUM(price_variance) FROM purchase_invoice
                      WHERE status = 'POSTED'), 0)                AS selisih_harga,
           COALESCE((SELECT SUM(qty_variance) FROM purchase_invoice
                      WHERE status = 'POSTED'), 0)                AS selisih_qty
  `);

  const cocok =
    Math.abs(Number(ringkas?.grni_buku ?? 0) - Number(ringkas?.grni_dokumen ?? 0)) < 0.005;

  const menggantung = await query(`
    SELECT m.receipt_no,
           to_char(m.receipt_date, 'YYYY-MM-DD') AS receipt_date,
           p.sku, p.name AS product,
           m.qty_diterima, m.qty_difakturkan, m.qty_sisa,
           m.biaya_terima, m.grni_sisa,
           s.code AS supplier_code, s.name AS supplier
      FROM v_receipt_matching m
      JOIN product p ON p.id = m.product_id
      JOIN partner s ON s.id = m.supplier_id
     WHERE m.qty_sisa > 0
     ORDER BY m.receipt_date, m.receipt_no
     LIMIT 25
  `);

  return (
    <>
      <PageHeader
        title="Faktur pembelian"
        desc="Dokumen yang mengosongkan akun Barang Diterima Belum Ditagih. Kuantitas dan harga dicocokkan dengan penerimaan; selisihnya tidak pernah diterima diam-diam."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <TombolEkspor laporan="pencocokan_pembelian" />
            <Link href="/purchases/new" className="btn">
              Catat faktur
            </Link>
          </div>
        }
      />

      <StatBand
        items={[
          {
            label: "Belum ditagih (buku besar)",
            value: rupiah(ringkas?.grni_buku ?? 0),
            hint: `${ringkas?.baris_menggantung ?? 0} baris penerimaan`,
          },
          {
            label: "Belum ditagih (dokumen)",
            value: rupiah(ringkas?.grni_dokumen ?? 0),
            hint: cocok ? "cocok dengan buku besar" : "TIDAK cocok",
          },
          { label: "Selisih harga kumulatif", value: rupiah(ringkas?.selisih_harga ?? 0) },
          { label: "Selisih kuantitas kumulatif", value: rupiah(ringkas?.selisih_qty ?? 0) },
        ]}
      />

      {!cocok && (
        <div role="alert" className="card mb-6 p-4 text-sm">
          <strong className="text-danger">
            Saldo Barang Diterima Belum Ditagih tidak cocok dengan dokumennya.
          </strong>{" "}
          Buku besar mencatat {rupiah(ringkas?.grni_buku ?? 0)}, sementara
          penerimaan yang belum difakturkan bernilai{" "}
          {rupiah(ringkas?.grni_dokumen ?? 0)}. Salah satu jalur sedang keliru.
        </div>
      )}

      <Panel
        className="mb-8"
        title="Penerimaan yang belum difakturkan"
        meta="25 terlama"
        action={
          <Badge tone={Number(ringkas?.baris_menggantung ?? 0) === 0 ? "positive" : "muted"}>
            {Number(ringkas?.baris_menggantung ?? 0) === 0
              ? "Semua sudah difakturkan"
              : `${ringkas?.baris_menggantung} menggantung`}
          </Badge>
        }
      >
        {menggantung.length === 0 ? (
          <Empty text="Setiap penerimaan sudah punya fakturnya. Akun Barang Diterima Belum Ditagih kosong — memang begitu seharusnya." />
        ) : (
          <TableWrap min={860}>
            <thead>
              <tr>
                <th className="th">Penerimaan</th>
                <th className="th">Pemasok</th>
                <th className="th">Barang</th>
                <th className="th text-right">Diterima</th>
                <th className="th text-right">Difakturkan</th>
                <th className="th text-right">Sisa</th>
                <th className="th text-right">Nilai menggantung</th>
              </tr>
            </thead>
            <tbody>
              {menggantung.map((r, i) => (
                <tr key={i}>
                  <td className="td">
                    <Code>{r.receipt_no}</Code>
                    <span className="block text-xs text-muted">
                      {tanggal(r.receipt_date)}
                    </span>
                  </td>
                  <NameCell name={r.supplier} sub={r.supplier_code} />
                  <NameCell name={r.sku} sub={r.product} />
                  <Num muted>{num(r.qty_diterima)}</Num>
                  <Num muted>
                    {Number(r.qty_difakturkan) === 0 ? "—" : num(r.qty_difakturkan)}
                  </Num>
                  <Num>{num(r.qty_sisa)}</Num>
                  <Num strong>{rupiah(r.grni_sisa)}</Num>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <h2 className="mb-3 text-sm font-semibold">Faktur terakhir</h2>

      {invoices.length === 0 ? (
        <Panel>
          <Empty
            text="Belum ada faktur pembelian."
            action={
              <Link href="/purchases/new" className="btn">
                Catat faktur
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
                <th className="th">Ref pemasok</th>
                <th className="th text-right">Nilai faktur</th>
                <th className="th text-right">PPN</th>
                <th className="th text-right">Total</th>
                <th className="th text-right">GRNI dilepas</th>
                <th className="th text-right">Selisih</th>
                <th className="th">Status</th>
                <th className="th text-right">Koreksi</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((v) => {
                const selisih = Number(v.price_variance) + Number(v.qty_variance);
                return (
                  <tr key={v.id}>
                    <td className="td">
                      <Code>{v.doc_no ?? "—"}</Code>
                      {Number(v.jumlah_baris) > 1 && (
                        <span className="ml-2 text-xs text-muted">
                          {v.jumlah_baris} baris
                        </span>
                      )}
                    </td>
                    <td className="td text-muted">{tanggal(v.doc_date)}</td>
                    <NameCell name={v.supplier} sub={v.supplier_code} />
                    <td className="td text-muted">{v.supplier_ref ?? "—"}</td>
                    <Num muted>{rupiah(v.subtotal)}</Num>
                    <Num muted>
                      {Number(v.tax_amount) === 0 ? "—" : rupiah(v.tax_amount)}
                    </Num>
                    <Num strong>{rupiah(v.total)}</Num>
                    <Num muted>{rupiah(v.grni_amount)}</Num>
                    <td className="td td-num tnum">
                      {selisih === 0 ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <>
                          <span className="block">{rupiah(selisih)}</span>
                          {Number(v.qty_variance) !== 0 && (
                            <span className="block text-xs text-warning">
                              termasuk kuantitas
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="td">
                      <Badge
                        tone={
                          v.status === "POSTED"
                            ? "positive"
                            : v.status === "CANCELLED"
                              ? "danger"
                              : "warning"
                        }
                      >
                        {v.status === "POSTED"
                          ? "Terposting"
                          : v.status === "CANCELLED"
                            ? "Dibatalkan"
                            : "Draf"}
                      </Badge>
                      {v.qty_variance_approved && (
                        <span className="block text-xs text-muted">
                          disetujui {v.approved_by}
                        </span>
                      )}
                    </td>
                    <td className="td td-num">
                      {v.status === "DRAFT" ? (
                        <span className="text-xs text-muted">—</span>
                      ) : (
                        <TombolBatal
                          jenis="PURCHASE_INVOICE"
                          dokumenId={v.id}
                          docNo={v.doc_no ?? "(tanpa nomor)"}
                          hariIni={hari.d}
                          sudahBatal={v.status === "CANCELLED"}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        </Panel>
      )}
    </>
  );
}
