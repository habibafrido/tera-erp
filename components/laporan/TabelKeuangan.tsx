import type { ReactNode } from "react";
import type { BarisAkun } from "@/lib/laporan-keuangan";
import { rupiah } from "@/lib/format";
import { Badge, Code } from "@/components/ui";

/**
 * Tabel satu bagian laporan keuangan (Aset, Liabilitas, Pendapatan, ...)
 * lengkap dengan kolom pembanding dan baris jumlah.
 *
 * Indentasi mengikuti `kedalaman` apa adanya, jadi bagan akun sedalam apa
 * pun tampil benar tanpa perubahan di sini. Akun yang punya turunan diberi
 * latar berbeda dan menampilkan subtotal seluruh turunannya.
 */

/** Selisih persen. null berarti tidak bisa dibandingkan, bukan nol persen. */
function Persen({ nilai }: { nilai: number | null }) {
  if (nilai === null) {
    return (
      <span className="text-muted" title="Periode pembanding bernilai nol">
        —
      </span>
    );
  }

  const nol = Math.abs(nilai) < 0.05;
  const naik = nilai > 0;

  return (
    <span className={nol ? "text-muted" : naik ? "text-positive" : "text-danger"}>
      {/* Panah ikut ditulis supaya warna bukan satu-satunya pembawa makna. */}
      {nol ? "" : naik ? "▲ " : "▼ "}
      {new Intl.NumberFormat("id-ID", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(nilai)}
      %
    </span>
  );
}

function persenDari(nilai: number, pembanding: number): number | null {
  return pembanding === 0 ? null : ((nilai - pembanding) / Math.abs(pembanding)) * 100;
}

/** Baris jumlah / subtotal manual, dipakai juga untuk laba berjalan. */
export function BarisJumlah({
  label,
  nilai,
  pembanding,
  tebal = true,
}: {
  label: ReactNode;
  nilai: number;
  pembanding: number;
  tebal?: boolean;
}) {
  return (
    <tr className="border-t border-line">
      <td className={"td " + (tebal ? "font-semibold" : "font-medium")} colSpan={2}>
        {label}
      </td>
      <td className={"td td-num tnum " + (tebal ? "font-semibold" : "")}>
        {rupiah(nilai)}
      </td>
      <td className="td td-num tnum text-muted">{rupiah(pembanding)}</td>
      <td className="td td-num tnum">{rupiah(nilai - pembanding)}</td>
      <td className="td td-num tnum">
        <Persen nilai={persenDari(nilai, pembanding)} />
      </td>
    </tr>
  );
}

export function TabelKeuangan({
  baris,
  labelPeriode,
  labelPembanding,
  jumlah,
  tambahan,
}: {
  baris: BarisAkun[];
  labelPeriode: string;
  labelPembanding: string;
  jumlah: { label: string; nilai: number; pembanding: number };
  /** Baris ekstra sebelum jumlah — mis. laba periode berjalan di ekuitas. */
  tambahan?: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr>
            <th className="th w-28">Kode</th>
            <th className="th">Akun</th>
            <th className="th text-right">{labelPeriode}</th>
            <th className="th text-right">{labelPembanding}</th>
            <th className="th text-right">Selisih</th>
            <th className="th text-right">%</th>
          </tr>
        </thead>
        <tbody>
          {baris.map((b) => (
            <tr key={b.kode} className={b.punyaAnak ? "bg-raised" : undefined}>
              <td className="td">
                <Code>{b.kode}</Code>
              </td>
              <td className={"td " + (b.punyaAnak ? "font-semibold" : "")}>
                <span style={{ paddingLeft: `${b.kedalaman * 1.25}rem` }}>{b.nama}</span>
                {b.berlawanan && (
                  // Saldo berlawanan arah DITANDAI, bukan disembunyikan dengan
                  // nilai mutlak. Persediaan bersaldo kredit adalah gejala yang
                  // perlu dilihat orang, bukan angka yang perlu dirapikan.
                  <span className="ml-2 inline-block align-middle">
                    <Badge tone="warning">saldo terbalik</Badge>
                  </span>
                )}
                {b.punyaAnak && (
                  <span className="ml-2 text-xs font-normal text-muted">
                    subtotal termasuk turunan
                  </span>
                )}
              </td>
              <td className={"td td-num tnum " + (b.punyaAnak ? "font-semibold" : "")}>
                {rupiah(b.saldo)}
              </td>
              <td className="td td-num tnum text-muted">{rupiah(b.pembanding)}</td>
              <td className="td td-num tnum">{rupiah(b.selisih)}</td>
              <td className="td td-num tnum">
                <Persen nilai={b.selisihPersen} />
              </td>
            </tr>
          ))}

          {tambahan}

          <BarisJumlah
            label={jumlah.label}
            nilai={jumlah.nilai}
            pembanding={jumlah.pembanding}
          />
        </tbody>
      </table>
    </div>
  );
}
