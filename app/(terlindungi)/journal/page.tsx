import { query } from "@/lib/db";
import {
  Badge, Code, Empty, Num, PageHeader, Panel, StatBand, TableWrap,
} from "@/components/ui";
import { TombolEkspor } from "@/components/TombolEkspor";
import { rupiah, tanggal } from "@/lib/format";

export const dynamic = "force-dynamic";

type Line = {
  entry_id: string;
  code: string;
  account: string;
  partner: string | null;
  debit: string;
  credit: string;
};

export default async function JournalPage() {
  const entries = await query(`
    SELECT e.id, e.entry_no, e.entry_date, e.description, e.source_type, e.is_posted,
           COALESCE(SUM(l.debit), 0)  AS total_debit,
           COALESCE(SUM(l.credit), 0) AS total_credit
      FROM journal_entry e
      LEFT JOIN journal_line l ON l.entry_id = e.id
     GROUP BY e.id
     ORDER BY e.entry_date DESC, e.created_at DESC
     LIMIT 25
  `);

  // Baris diambil sekali untuk semua entri yang tampil, lalu dikelompokkan
  // di memori — menghindari satu query per entri.
  const ids = entries.map((e) => e.id);
  const lines = ids.length
    ? await query<Line>(
        `SELECT l.entry_id, a.code, a.name AS account, p.name AS partner,
                l.debit, l.credit
           FROM journal_line l
           JOIN account a ON a.id = l.account_id
           LEFT JOIN partner p ON p.id = l.partner_id
          WHERE l.entry_id = ANY($1::uuid[])
          ORDER BY l.debit DESC, a.code`,
        [ids]
      )
    : [];

  const byEntry = new Map<string, Line[]>();
  for (const l of lines) {
    const arr = byEntry.get(l.entry_id);
    if (arr) arr.push(l);
    else byEntry.set(l.entry_id, [l]);
  }

  // Neraca percobaan ringkas. Kalau kolom ini pernah tidak seimbang, berarti
  // constraint trigger DEFERRABLE di database sudah bocor.
  const trial = await query(`
    SELECT a.code, a.name, a.type,
           COALESCE(SUM(l.debit), 0)  AS debit,
           COALESCE(SUM(l.credit), 0) AS credit
      FROM account a
      JOIN journal_line l   ON l.account_id = a.id
      JOIN journal_entry e  ON e.id = l.entry_id AND e.is_posted
     GROUP BY a.id
     HAVING COALESCE(SUM(l.debit), 0) <> 0 OR COALESCE(SUM(l.credit), 0) <> 0
     ORDER BY a.code
  `);

  const sumDebit = trial.reduce((a, r) => a + Number(r.debit), 0);
  const sumCredit = trial.reduce((a, r) => a + Number(r.credit), 0);
  const seimbang = Math.abs(sumDebit - sumCredit) < 0.005;

  return (
    <>
      <PageHeader
        title="Jurnal"
        desc="Setiap jurnal di sini lahir dari dokumen, bukan diketik manual. Debit dan kredit dipaksa seimbang oleh constraint trigger saat COMMIT."
        action={<TombolEkspor laporan="jurnal" filter={{ periode: "tahun_ini" }} />}
      />

      <StatBand
        items={[
          { label: "Total debit", value: rupiah(sumDebit) },
          { label: "Total kredit", value: rupiah(sumCredit) },
          {
            label: "Selisih",
            value: rupiah(sumDebit - sumCredit),
            hint: seimbang ? "seimbang" : "TIDAK seimbang",
          },
        ]}
      />

      <Panel
        className="mb-8"
        title="Neraca percobaan"
        action={
          <Badge tone={seimbang ? "positive" : "danger"}>
            {seimbang ? "Seimbang" : "Tidak seimbang"}
          </Badge>
        }
      >
        {trial.length === 0 ? (
          <Empty text="Belum ada jurnal terposting." />
        ) : (
          <TableWrap min={560}>
            <thead>
              <tr>
                <th className="th">Kode</th>
                <th className="th">Akun</th>
                <th className="th">Tipe</th>
                <th className="th text-right">Debit</th>
                <th className="th text-right">Kredit</th>
              </tr>
            </thead>
            <tbody>
              {trial.map((r) => (
                <tr key={r.code}>
                  <td className="td"><Code>{r.code}</Code></td>
                  <td className="td font-medium">{r.name}</td>
                  <td className="td text-xs text-muted">{r.type}</td>
                  <Num>
                    {Number(r.debit) === 0 ? <span className="text-muted">—</span> : rupiah(r.debit)}
                  </Num>
                  <Num credit>
                    {Number(r.credit) === 0 ? "—" : rupiah(r.credit)}
                  </Num>
                </tr>
              ))}
              <tr>
                <td className="td" colSpan={3}>
                  <span className="text-sm font-semibold">Jumlah</span>
                </td>
                <Num strong>{rupiah(sumDebit)}</Num>
                <Num credit strong>{rupiah(sumCredit)}</Num>
              </tr>
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <h2 className="mb-3 text-sm font-semibold">Jurnal terakhir</h2>

      {entries.length === 0 ? (
        <Panel>
          <Empty text="Belum ada jurnal. Jurnal muncul otomatis begitu dokumen diposting." />
        </Panel>
      ) : (
        <div className="space-y-4">
          {entries.map((e) => (
            <Panel
              key={e.id}
              title={e.description ?? "Jurnal"}
              meta={tanggal(e.entry_date)}
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <Code>{e.entry_no}</Code>
                  <Badge>{e.source_type ?? "MANUAL"}</Badge>
                  <Badge tone={e.is_posted ? "positive" : "warning"}>
                    {e.is_posted ? "Terposting" : "Draf"}
                  </Badge>
                </div>
              }
            >
              <TableWrap min={560}>
                <thead>
                  <tr>
                    <th className="th">Akun</th>
                    <th className="th">Mitra</th>
                    <th className="th text-right">Debit</th>
                    <th className="th text-right">Kredit</th>
                  </tr>
                </thead>
                <tbody>
                  {(byEntry.get(e.id) ?? []).map((l, i) => (
                    <tr key={i}>
                      <td className="td">
                        <Code>{l.code}</Code>
                        <span className="ml-2">{l.account}</span>
                      </td>
                      <td className="td text-muted">{l.partner ?? "—"}</td>
                      <Num>
                        {Number(l.debit) === 0 ? <span className="text-muted">—</span> : rupiah(l.debit)}
                      </Num>
                      <Num credit>{Number(l.credit) === 0 ? "—" : rupiah(l.credit)}</Num>
                    </tr>
                  ))}
                  <tr>
                    <td className="td" colSpan={2}>
                      <span className="text-xs text-muted">Jumlah</span>
                    </td>
                    <Num strong>{rupiah(e.total_debit)}</Num>
                    <Num credit strong>{rupiah(e.total_credit)}</Num>
                  </tr>
                </tbody>
              </TableWrap>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
