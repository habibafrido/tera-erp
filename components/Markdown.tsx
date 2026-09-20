"use client";

import { useState, type ReactNode } from "react";

/**
 * ============================================================
 * MARKDOWN → ELEMEN REACT
 * ============================================================
 * Keluaran model TIDAK PERNAH dirangkai menjadi string HTML, dan
 * `dangerouslySetInnerHTML` tidak dipakai di berkas ini maupun di
 * pemanggilnya. Parser menghasilkan elemen React langsung, sehingga
 * setiap potongan teks lolos lewat pelolosan bawaan React.
 *
 * Artinya keamanannya struktural, bukan bergantung pada daftar tag yang
 * disaring belakangan: tidak ada jalur untuk menyuntikkan <script> atau
 * atribut on*, karena tidak ada HTML yang diurai sama sekali.
 *
 * Subset yang didukung sengaja sempit — tabel, daftar, tebal, miring,
 * kode inline, dan paragraf. Itu yang benar-benar dihasilkan asisten.
 */

/** Panjang isi sel sebelum dipotong. Nama PT di Indonesia memang panjang. */
const MAKS_SEL = 28;

function inline(teks: string, kunci: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\n]+)\*/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(teks)) !== null) {
    if (m.index > last) out.push(teks.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(<strong key={`${kunci}-b${i++}`}>{m[1]}</strong>);
    } else if (m[2] !== undefined) {
      out.push(
        <code key={`${kunci}-c${i++}`} className="rounded bg-raised px-1 font-mono text-xs">
          {m[2]}
        </code>
      );
    } else if (m[3] !== undefined) {
      out.push(<em key={`${kunci}-i${i++}`}>{m[3]}</em>);
    }
    last = re.lastIndex;
  }
  if (last < teks.length) out.push(teks.slice(last));
  return out;
}

/** Sel tabel berisi teks panjang: dipotong, nilai penuh di title, klik membuka. */
export function SelPanjang({
  isi,
  kelas,
}: {
  isi: string;
  kelas: string;
}) {
  const [buka, setBuka] = useState(false);
  const panjang = isi.length > MAKS_SEL;

  if (!panjang) return <td className={kelas}>{isi}</td>;

  return (
    <td className={kelas} title={isi}>
      <button
        type="button"
        onClick={() => setBuka((v) => !v)}
        aria-expanded={buka}
        aria-label={buka ? "Perpendek" : `Tampilkan penuh: ${isi}`}
        className={
          // text-inherit eksplisit: <button> adalah satu-satunya elemen di
          // dalam sel yang bisa merender warna berbeda dari sekitarnya,
          // dan angka yang berubah warna tanpa alasan terbaca sebagai
          // penanda yang sebenarnya tidak ada.
          "cursor-pointer text-left text-inherit " +
          (buka ? "whitespace-normal" : "block max-w-[24ch] truncate")
        }
      >
        {isi}
      </button>
    </td>
  );
}

/** Sel angka dikenali dari isinya supaya rata kanan dan lebar digit tetap. */
function selAngka(s: string): boolean {
  const t = s.trim();
  if (t === "" || t === "—") return false;
  return /^-?(rp\s*)?[\d.,]+\s*%?$/i.test(t);
}

function Tabel({ baris, kunci }: { baris: string[][]; kunci: string }) {
  const [kepala, ...isi] = baris;
  return (
    <div className="card my-3 overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            {kepala.map((h, i) => (
              <th key={i} className={selAngka(isi[0]?.[i] ?? "") ? "th text-right" : "th"}>
                {inline(h, `${kunci}-h${i}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isi.map((r, ri) => (
            <tr key={ri}>
              {kepala.map((_, ci) => {
                const v = r[ci] ?? "";
                const kelas = selAngka(v) ? "td-num" : "td";
                // Sel angka tidak pernah dipotong: memotong angka justru
                // menyembunyikan informasi yang paling dicari.
                return selAngka(v) ? (
                  <td key={ci} className={kelas}>{v}</td>
                ) : (
                  <SelPanjang key={ci} isi={v} kelas={kelas} />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PEMISAH = (l: string) =>
  l.includes("|") && l.includes("-") && /^[\s|:-]+$/.test(l);

const baris = (l: string) =>
  l
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());

export function Markdown({ teks }: { teks: string }) {
  const lines = teks.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;

  while (i < lines.length) {
    const l = lines[i];

    // --- baris kosong -------------------------------------------------
    if (l.trim() === "") {
      i++;
      continue;
    }

    // --- tabel --------------------------------------------------------
    if (l.includes("|") && i + 1 < lines.length && PEMISAH(lines[i + 1])) {
      const rows: string[][] = [baris(l)];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(baris(lines[i]));
        i++;
      }
      out.push(<Tabel key={`t${n++}`} baris={rows} kunci={`t${n}`} />);
      continue;
    }

    // --- judul --------------------------------------------------------
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      out.push(
        <p key={`h${n++}`} className="mt-3 mb-1 text-sm font-semibold">
          {inline(h[2], `h${n}`)}
        </p>
      );
      i++;
      continue;
    }

    // --- daftar -------------------------------------------------------
    const takBerurut = /^\s*[-*+]\s+/;
    const berurut = /^\s*\d+[.)]\s+/;
    if (takBerurut.test(l) || berurut.test(l)) {
      const urut = berurut.test(l);
      const item: string[] = [];
      while (
        i < lines.length &&
        (takBerurut.test(lines[i]) || berurut.test(lines[i]))
      ) {
        item.push(lines[i].replace(takBerurut, "").replace(berurut, ""));
        i++;
      }
      const Tag = urut ? "ol" : "ul";
      out.push(
        <Tag
          key={`l${n++}`}
          className={
            "my-2 space-y-1 pl-5 text-sm " + (urut ? "list-decimal" : "list-disc")
          }
        >
          {item.map((t, k) => (
            <li key={k}>{inline(t, `l${n}-${k}`)}</li>
          ))}
        </Tag>
      );
      continue;
    }

    // --- paragraf -----------------------------------------------------
    const par: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].includes("|") &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !takBerurut.test(lines[i]) &&
      !berurut.test(lines[i])
    ) {
      par.push(lines[i]);
      i++;
    }
    if (par.length === 0) {
      // Baris tunggal yang tidak cocok pola mana pun (misalnya sisa pipa).
      par.push(lines[i]);
      i++;
    }
    out.push(
      <p key={`p${n++}`} className="my-2 text-sm">
        {inline(par.join(" "), `p${n}`)}
      </p>
    );
  }

  return <>{out}</>;
}
