import type { BarisArus } from "@/lib/arus-kas";
import { rupiah } from "@/lib/format";
import { Code } from "@/components/ui";

/**
 * Satu golongan arus kas beserta rinciannya per akun lawan.
 *
 * Rinciannya ditampilkan, bukan hanya subtotalnya: angka golongan yang
 * berdiri sendiri tidak bisa ditelusuri ke dokumen mana pun, dan yang
 * pertama ditanyakan orang begitu melihat "operasi −12 juta" adalah
 * "dari mana".
 */

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

/** Kas masuk positif, kas keluar dalam kurung — kebiasaan laporan keuangan. */
function Arus({ nilai, tebal }: { nilai: number; tebal?: boolean }) {
  const keluar = nilai < 0;
  return (
    <span className={tebal ? "font-semibold" : undefined}>
      {keluar ? `(${rupiah(-nilai)})` : rupiah(nilai)}
    </span>
  );
}

export function TabelArusKas({
  judul,
  baris,
  total,
  bandingTotal,
  labelPeriode,
  labelPembanding,
  kosong,
}: {
  judul: string;
  baris: BarisArus[];
  total: number;
  bandingTotal: number;
  labelPeriode: string;
  labelPembanding: string;
  kosong: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr>
            <th className="th w-28">Kode</th>
            <th className="th">{judul}</th>
            <th className="th text-right">{labelPeriode}</th>
            <th className="th text-right">{labelPembanding}</th>
            <th className="th text-right">Selisih</th>
            <th className="th text-right">%</th>
          </tr>
        </thead>
        <tbody>
          {baris.length === 0 ? (
            <tr>
              <td className="td text-muted" colSpan={6}>
                {kosong}
              </td>
            </tr>
          ) : (
            baris.map((b) => (
              <tr key={b.kode}>
                <td className="td">
                  <Code>{b.kode}</Code>
                </td>
                <td className="td">{b.nama}</td>
                <td className="td td-num tnum">
                  <Arus nilai={b.nilai} />
                </td>
                <td className="td td-num tnum text-muted">
                  <Arus nilai={b.pembanding} />
                </td>
                <td className="td td-num tnum">
                  <Arus nilai={b.selisih} />
                </td>
                <td className="td td-num tnum">
                  <Persen nilai={b.selisihPersen} />
                </td>
              </tr>
            ))
          )}

          <tr className="border-t border-line">
            <td className="td font-semibold" colSpan={2}>
              Jumlah {judul.toLowerCase()}
            </td>
            <td className="td td-num tnum">
              <Arus nilai={total} tebal />
            </td>
            <td className="td td-num tnum text-muted">
              <Arus nilai={bandingTotal} />
            </td>
            <td className="td td-num tnum">
              <Arus nilai={total - bandingTotal} />
            </td>
            <td className="td td-num tnum">
              <Persen
                nilai={
                  bandingTotal === 0
                    ? null
                    : ((total - bandingTotal) / Math.abs(bandingTotal)) * 100
                }
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
