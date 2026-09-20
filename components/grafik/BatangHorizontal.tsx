import { Kerangka, batasAtas, skala } from "./Kerangka";
import { Num, TableWrap } from "@/components/ui";
import { rupiah } from "@/lib/format";
import type { BarisBatang } from "@/lib/charts";

/** Tinggi satu baris di dalam viewBox. Label di atas, batang di bawahnya. */
const TINGGI_BARIS = 46;
const LEBAR = 600;
const TINGGI_BATANG = 16;

/**
 * Batang horizontal, bukan pai.
 *
 * Nama gudang dan nama barang di Indonesia panjang, dan pai jadi sulit
 * dibandingkan begitu potongannya lebih dari tiga. Batang horizontal
 * memberi ruang label sepanjang apa pun dan perbandingan panjangnya
 * langsung terbaca.
 *
 * Labelnya ditaruh DI ATAS batang, bukan di kolom kiri: kolom label
 * berlebar tetap akan memotong nama panjang, sedangkan label di atas
 * bebas memakai seluruh lebar dan tetap terbaca di 375px.
 */
export function BatangHorizontal({
  judul,
  meta,
  data,
  kosong,
  ringkasan,
  className,
}: {
  judul: string;
  meta?: string;
  data: BarisBatang[];
  kosong: string;
  ringkasan: (d: BarisBatang[]) => string;
  className?: string;
}) {
  const maks = batasAtas(data.map((d) => d.nilai));
  const tinggi = Math.max(TINGGI_BARIS, data.length * TINGGI_BARIS);
  const total = data.reduce((a, d) => a + d.nilai, 0);

  return (
    <Kerangka
      judul={judul}
      meta={meta}
      adaData={data.length > 0}
      kosong={kosong}
      ringkasan={data.length ? ringkasan(data) : kosong}
      className={className}
      tabel={
        <TableWrap min={420}>
          <thead>
            <tr>
              <th className="th">Nama</th>
              <th className="th">Kode</th>
              <th className="th text-right">Nilai</th>
              <th className="th text-right">Porsi</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.label + d.sub}>
                <td className="td font-medium">{d.label}</td>
                <td className="td text-muted">{d.sub ?? "—"}</td>
                <Num>{rupiah(d.nilai)}</Num>
                <Num muted>
                  {total > 0
                    ? (d.nilai * 100 / total).toLocaleString("id-ID", {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      }) + "%"
                    : "—"}
                </Num>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      }
    >
      <svg
        viewBox={`0 0 ${LEBAR} ${tinggi}`}
        width="100%"
        height={tinggi}
        preserveAspectRatio="xMinYMin meet"
        className="max-w-full"
      >
        {data.map((d, i) => {
          const y = i * TINGGI_BARIS;
          const lebar = skala(d.nilai, maks, LEBAR);
          return (
            <g key={d.label + d.sub}>
              {/* Label dan nilai sebaris, di atas batangnya. */}
              <text x={0} y={y + 14} className="fill-ink" fontSize={14}>
                {d.label.length > 46 ? d.label.slice(0, 45) + "…" : d.label}
              </text>
              <text
                x={LEBAR}
                y={y + 14}
                textAnchor="end"
                fontSize={14}
                className="fill-muted"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {rupiah(d.nilai)}
              </text>

              {/* Alur batang, supaya panjang relatifnya terbaca walau kecil. */}
              <rect x={0} y={y + 22} width={LEBAR} height={TINGGI_BATANG} rx={3}
                    className="fill-raised" />
              <rect x={0} y={y + 22} width={lebar} height={TINGGI_BATANG} rx={3}
                    className="fill-action">
                <title>{`${d.label}: ${rupiah(d.nilai)}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </Kerangka>
  );
}
