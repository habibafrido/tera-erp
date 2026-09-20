import { Kerangka, batasAtas, skala } from "./Kerangka";
import { Badge, Num, TableWrap } from "@/components/ui";
import { rupiah } from "@/lib/format";
import type { EmberPiutang } from "@/lib/charts";

const LEBAR = 560;
const TINGGI = 210;
const ATAS = 14;
const BAWAH = 46;

const tinggiPlot = TINGGI - ATAS - BAWAH;

/**
 * Umur piutang per ember.
 *
 * Ember 90+ memakai warna danger, TAPI warnanya bukan satu-satunya
 * pembawa makna: embernya juga diberi label "berisiko" di gambar dan
 * lencana di tabel. Pengguna dengan buta warna, atau siapa pun yang
 * mencetaknya hitam-putih, tetap mendapat informasi yang sama.
 */
export function UmurPiutang({ data }: { data: EmberPiutang[] }) {
  const total = data.reduce((a, d) => a + d.nilai, 0);
  const maks = batasAtas(data.map((d) => d.nilai));
  const lebarKelompok = LEBAR / data.length;
  const lebarBatang = Math.min(64, lebarKelompok * 0.55);
  const lewat90 = data.find((d) => d.berisiko)?.nilai ?? 0;

  return (
    <Kerangka
      judul="Umur piutang"
      meta="dihitung dari tanggal jatuh tempo"
      adaData={total > 0}
      kosong="Belum ada piutang terposting."
      ringkasan={
        `Umur piutang: total ${rupiah(total)}, ` +
        (lewat90 > 0
          ? `${rupiah(lewat90)} di antaranya sudah lewat 90 hari.`
          : "tidak ada yang lewat 90 hari.")
      }
      tabel={
        <TableWrap min={380}>
          <thead>
            <tr>
              <th className="th">Ember umur</th>
              <th className="th text-right">Nilai</th>
              <th className="th text-right">Porsi</th>
              <th className="th">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.ember}>
                <td className="td font-medium">{d.ember}</td>
                <Num>{rupiah(d.nilai)}</Num>
                <Num muted>
                  {total > 0
                    ? (d.nilai * 100 / total).toLocaleString("id-ID", {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      }) + "%"
                    : "—"}
                </Num>
                <td className="td">
                  {d.berisiko ? <Badge tone="danger">Berisiko</Badge> : <Badge>Lancar</Badge>}
                </td>
              </tr>
            ))}
            <tr>
              <td className="td font-semibold">Total</td>
              <Num strong>{rupiah(total)}</Num>
              <Num muted>100,0%</Num>
              <td className="td" />
            </tr>
          </tbody>
        </TableWrap>
      }
    >
      <svg
        viewBox={`0 0 ${LEBAR} ${TINGGI}`}
        width="100%"
        height={TINGGI}
        preserveAspectRatio="xMinYMin meet"
        className="max-w-full"
      >
        <line
          x1={0} y1={ATAS + tinggiPlot} x2={LEBAR} y2={ATAS + tinggiPlot}
          className="stroke-line" strokeWidth={1}
        />

        {data.map((d, i) => {
          const xTengah = lebarKelompok * (i + 0.5);
          const t = skala(d.nilai, maks, tinggiPlot);
          const dasar = ATAS + tinggiPlot;

          return (
            <g key={d.ember}>
              <rect
                x={xTengah - lebarBatang / 2}
                y={dasar - t}
                width={lebarBatang}
                height={t}
                rx={3}
                className={d.berisiko ? "fill-danger" : "fill-action"}
              >
                <title>{`${d.ember}: ${rupiah(d.nilai)}`}</title>
              </rect>

              {/* Nilai di atas batang, selalu terbaca tanpa perlu hover. */}
              <text
                x={xTengah} y={dasar - t - 5} textAnchor="middle" fontSize={12}
                className="fill-ink"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {rupiah(d.nilai)}
              </text>

              <text
                x={xTengah} y={dasar + 18} textAnchor="middle" fontSize={13}
                className="fill-muted"
              >
                {d.ember}
              </text>

              {/* Makna tidak dititipkan pada warna saja. */}
              {d.berisiko && (
                <text
                  x={xTengah} y={dasar + 34} textAnchor="middle" fontSize={12}
                  className="fill-danger"
                >
                  berisiko
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </Kerangka>
  );
}
