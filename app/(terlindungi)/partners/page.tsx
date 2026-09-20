import { query } from "@/lib/db";
import { createPartner } from "@/app/actions";
import { MasterForm } from "@/components/MasterForm";
import {
  Badge, Empty, NameCell, Num, PageHeader, Panel, StatBand, TableWrap,
} from "@/components/ui";
import { TombolEkspor } from "@/components/TombolEkspor";
import { UmurPiutang } from "@/components/grafik/UmurPiutang";
import { umurPiutangEmber } from "@/lib/charts";
import { num, rupiah } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function PartnersPage() {
  // Saldo piutang per mitra dihitung dari buku besar pembantu di journal_line,
  // bukan dari kolom saldo tersendiri yang bisa melenceng diam-diam.
  const partners = await query(`
    SELECT p.code, p.name, p.is_customer, p.is_supplier, p.payment_term_days,
           COALESCE((
             SELECT SUM(jl.debit - jl.credit)
               FROM journal_line jl
               JOIN account_mapping m ON m.account_id = jl.account_id AND m.key = 'AR'
              WHERE jl.partner_id = p.id
           ), 0) AS piutang
      FROM partner p
     ORDER BY p.code
  `);

  const ember = await umurPiutangEmber();

  const totalPiutang = partners.reduce((a, p) => a + Number(p.piutang ?? 0), 0);
  const pelanggan = partners.filter((p) => p.is_customer).length;
  const pemasok = partners.filter((p) => p.is_supplier).length;

  return (
    <>
      <PageHeader
        title="Mitra"
        desc="Satu perusahaan bisa menjadi pelanggan sekaligus pemasok. Tempo pembayaran dipakai untuk menghitung jatuh tempo faktur."
        action={<TombolEkspor laporan="umur_piutang" label="Unduh umur piutang" />}
      />

      <StatBand
        items={[
          { label: "Total piutang", value: rupiah(totalPiutang) },
          { label: "Pelanggan", value: num(pelanggan) },
          { label: "Pemasok", value: num(pemasok) },
        ]}
      />

      <div className="mb-6">
        <UmurPiutang data={ember} />
      </div>

      <div className="mb-8">
        <MasterForm
          submitLabel="Simpan mitra"
          action={createPartner}
          fields={[
            { kind: "text", name: "code", label: "Kode", placeholder: "CUS-004", required: true },
            {
              kind: "text", name: "name", label: "Nama",
              placeholder: "Toko Sumber Rejeki", required: true,
            },
            { kind: "number", name: "payment_term_days", label: "Tempo (hari)", defaultValue: 0 },
            { kind: "check", name: "is_customer", label: "Pelanggan" },
            { kind: "check", name: "is_supplier", label: "Pemasok" },
          ]}
        />
      </div>

      <Panel title="Daftar mitra">
        {partners.length === 0 ? (
          <Empty text="Belum ada mitra." />
        ) : (
          <TableWrap min={640}>
            <thead>
              <tr>
                <th className="th">Mitra</th>
                <th className="th">Peran</th>
                <th className="th text-right">Tempo</th>
                <th className="th text-right">Piutang</th>
              </tr>
            </thead>
            <tbody>
              {partners.map((p) => (
                <tr key={p.code}>
                  <NameCell name={p.name} sub={p.code} />
                  <td className="td">
                    <div className="flex flex-wrap gap-1">
                      {p.is_customer && <Badge>Pelanggan</Badge>}
                      {p.is_supplier && <Badge tone="warning">Pemasok</Badge>}
                    </div>
                  </td>
                  <Num muted>{p.payment_term_days} hari</Num>
                  <Num>
                    {Number(p.piutang) === 0 ? (
                      <span className="text-muted">—</span>
                    ) : (
                      rupiah(p.piutang)
                    )}
                  </Num>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>
    </>
  );
}
