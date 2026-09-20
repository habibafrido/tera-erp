import type { ReactNode } from "react";
import { Empty, Panel } from "@/components/ui";

/**
 * ============================================================
 * KERANGKA GRAFIK
 * ============================================================
 * Semua grafik memakai bentuk yang sama: kartu berjudul, gambar, lalu
 * tabel angka yang terlipat.
 *
 * Tabelnya BUKAN formalitas aksesibilitas. Grafik tanpa angkanya tidak
 * bisa dipakai mengambil keputusan, dan orang akan tetap menanyakan
 * angka pastinya. <details> dipilih karena native — tidak ada JavaScript
 * klien sama sekali di seluruh direktori ini.
 *
 * SVG-nya diberi role="img" dengan aria-label yang meringkas TEMUANNYA,
 * bukan sekadar menyebut jenis grafiknya: pembaca layar tidak terbantu
 * oleh "diagram batang".
 */
export function Kerangka({
  judul,
  meta,
  ringkasan,
  kosong,
  adaData,
  children,
  tabel,
  className = "",
}: {
  judul: string;
  meta?: string;
  /** Dipakai sebagai aria-label SVG: satu kalimat berisi temuannya. */
  ringkasan: string;
  kosong: string;
  adaData: boolean;
  children: ReactNode;
  tabel: ReactNode;
  className?: string;
}) {
  return (
    <Panel title={judul} meta={meta} className={className}>
      {!adaData ? (
        <Empty text={kosong} />
      ) : (
        <>
          <div className="px-4 pt-3" role="img" aria-label={ringkasan}>
            {children}
          </div>

          <details className="border-t border-line">
            <summary className="cursor-pointer px-4 py-2 text-xs text-muted">
              Lihat angkanya
            </summary>
            <div className="border-t border-line">{tabel}</div>
          </details>
        </>
      )}
    </Panel>
  );
}

/**
 * Skala linier ke lebar/tinggi gambar. Nol dan nilai negatif ditangani
 * di sini supaya tiap grafik tidak mengulang penjagaannya.
 */
export function skala(nilai: number, maks: number, panjang: number): number {
  if (!Number.isFinite(nilai) || !Number.isFinite(maks) || maks <= 0) return 0;
  return Math.max(0, Math.min(1, nilai / maks)) * panjang;
}

/** Sumbu "bagus": dibulatkan ke atas supaya batang tertinggi tidak mepet. */
export function batasAtas(nilai: number[]): number {
  const maks = Math.max(0, ...nilai.filter((n) => Number.isFinite(n)));
  if (maks <= 0) return 1;
  const pangkat = Math.pow(10, Math.floor(Math.log10(maks)));
  return Math.ceil(maks / pangkat) * pangkat;
}
