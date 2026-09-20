import { Kerangka, batasAtas, skala } from "./Kerangka";
import { Num, TableWrap } from "@/components/ui";
import { rupiah } from "@/lib/format";
import type { TitikTren } from "@/lib/charts";

const LEBAR = 720;
const TINGGI = 240;
const ATAS = 16;
const BAWAH = 34;
const KIRI = 8;
const KANAN = 8;

const tinggiPlot = TINGGI - ATAS - BAWAH;
const lebarPlot = LEBAR - KIRI - KANAN;

const persen = (n: number) =>
  n.toLocaleString("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";

/**
 * Tren penjualan dan margin, 12 bulan.
 *
 * Dua pertanyaan sekaligus: apakah bisnisnya tumbuh, dan apakah
 * marginnya tergerus? Karena itu ada dua skala — rupiah untuk batang,
 * persen untuk garis. Menempelkan persentase ke sumbu rupiah akan
 * membuat garisnya rata di dasar dan tidak memberi tahu apa pun.
 *
 * Warna bukan satu-satunya pembeda: batang penjualan dan margin punya
 * label legenda sendiri, dan garis margin diberi titik bulat sehingga
 * tetap terbedakan saat dicetak hitam-putih.
 */
export function TrenPenjualan({ data }: { data: TitikTren[] }) {
  const adaTransaksi = data.some((d) => d.subtotal !== 0 || d.margin !== 0);
  const maksRupiah = batasAtas(data.map((d) => d.subtotal));

  const lebarKelompok = lebarPlot / Math.max(1, data.length);
  const lebarBatang = Math.min(18, lebarKelompok / 3);

  const titikGaris = data
    .map((d, i) => {
      if (d.margin_persen === null) return null;
      const x = KIRI + lebarKelompok * (i + 0.5);
      const y = ATAS + tinggiPlot - skala(d.margin_persen, 100, tinggiPlot);
      return { x, y, d };
    })
    .filter((t): t is { x: number; y: number; d: TitikTren } => t !== null);

  const garis = titikGaris.map((t) => `${t.x},${t.y}`).join(" ");

  const totalJual = data.reduce((a, d) => a + d.subtotal, 0);
  const totalMargin = data.reduce((a, d) => a + d.margin, 0);
  const marginRata = totalJual > 0 ? (totalMargin * 100) / totalJual : 0;

  return (
    <Kerangka
      judul="Tren penjualan dan margin"
      meta="12 bulan terakhir"
      adaData={adaTransaksi}
      kosong="Belum ada penjualan terposting dalam 12 bulan terakhir."
      ringkasan={
        `Tren penjualan 12 bulan: total ${rupiah(totalJual)}, ` +
        `margin ${rupiah(totalMargin)} atau ${persen(marginRata)} dari penjualan. ` +
        `Bulan tertinggi ${
          data.reduce((a, b) => (b.subtotal > a.subtotal ? b : a), data[0])?.label ?? "-"
        }.`
      }
      tabel={
        <TableWrap min={520}>
          <thead>
            <tr>
              <th className="th">Bulan</th>
              <th className="th text-right">Penjualan</th>
              <th className="th text-right">HPP</th>
              <th className="th text-right">Margin</th>
              <th className="th text-right">Margin %</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.bulan}>
                <td className="td">{d.bulan}</td>
                <Num>{rupiah(d.subtotal)}</Num>
                <Num muted>{rupiah(d.hpp)}</Num>
                <Num>{rupiah(d.margin)}</Num>
                <Num>{d.margin_persen === null ? "—" : persen(d.margin_persen)}</Num>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      }
    >
      {/* Legenda: teks, bukan hanya warna. */}
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-action" />
          Penjualan
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-positive" />
          Margin
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-warning" />
          Margin % (skala kanan, 0–100%)
        </span>
      </div>

      <svg
        viewBox={`0 0 ${LEBAR} ${TINGGI}`}
        width="100%"
        height={TINGGI}
        preserveAspectRatio="xMinYMin meet"
        className="max-w-full"
      >
        {/* Garis dasar */}
        <line
          x1={KIRI} y1={ATAS + tinggiPlot} x2={LEBAR - KANAN} y2={ATAS + tinggiPlot}
          className="stroke-line" strokeWidth={1}
        />

        {data.map((d, i) => {
          const xTengah = KIRI + lebarKelompok * (i + 0.5);
          const tJual = skala(d.subtotal, maksRupiah, tinggiPlot);
          const tMargin = skala(d.margin, maksRupiah, tinggiPlot);
          const dasar = ATAS + tinggiPlot;

          return (
            <g key={d.bulan}>
              <rect
                x={xTengah - lebarBatang - 1} y={dasar - tJual}
                width={lebarBatang} height={tJual}
                className="fill-action" rx={2}
              >
                <title>{`${d.bulan} penjualan: ${rupiah(d.subtotal)}`}</title>
              </rect>
              <rect
                x={xTengah + 1} y={dasar - tMargin}
                width={lebarBatang} height={tMargin}
                className="fill-positive" rx={2}
              >
                <title>{`${d.bulan} margin: ${rupiah(d.margin)}`}</title>
              </rect>

              {/* Semua bulan di layar lebar; tiap tiga bulan di layar sempit. */}
              <text
                x={xTengah} y={TINGGI - 14} textAnchor="middle" fontSize={13}
                className="hidden fill-muted sm:inline"
              >
                {d.label}
              </text>
              {i % 3 === 0 && (
                <text
                  x={xTengah} y={TINGGI - 14} textAnchor="middle" fontSize={13}
                  className="fill-muted sm:hidden"
                >
                  {d.label}
                </text>
              )}
            </g>
          );
        })}

        {/* Garis margin persen, pada skala 0–100% yang terpisah. */}
        {titikGaris.length > 1 && (
          <polyline
            points={garis}
            fill="none"
            className="stroke-warning"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        )}
        {titikGaris.map((t) => (
          <circle key={t.d.bulan} cx={t.x} cy={t.y} r={3} className="fill-warning">
            <title>{`${t.d.bulan} margin: ${persen(t.d.margin_persen ?? 0)}`}</title>
          </circle>
        ))}
      </svg>
    </Kerangka>
  );
}
