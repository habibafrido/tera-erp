"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { Jejak, namaTampilan } from "./JejakAlat";

const CONTOH = [
  "Berapa nilai persediaan sekarang?",
  "Barang apa yang mau kedaluwarsa dalam 90 hari?",
  "Ringkasan penjualan bulan ini per pelanggan",
  "Stok apa yang mengendap 60 hari terakhir?",
  "Bagaimana umur piutang saat ini?",
];

/** Batas tinggi textarea sebelum ia menggulung sendiri. */
const TINGGI_MAKS = 160;

import type { PanggilanAlat } from "./JejakAlat";

/**
 * Satu giliran asisten terdiri dari potongan-potongan berurutan waktu.
 * Urutannya dipertahankan supaya indikator kemajuan bisa menyebut alat
 * yang sedang dipanggil, dan supaya jawaban bisa dipisahkan dari notanya.
 */
type Bagian =
  | { jenis: "teks"; teks: string }
  | { jenis: "alat"; alat: PanggilanAlat };

type Pesan = {
  peran: "user" | "assistant";
  bagian: Bagian[];
  galat?: string;
  /** Panjang rantai pikir yang sudah mengalir; isinya tidak pernah ditampilkan. */
  berpikir?: number;
};

const teksDari = (p: Pesan) =>
  p.bagian
    .filter((b): b is { jenis: "teks"; teks: string } => b.jenis === "teks")
    .map((b) => b.teks)
    .join("");

const alatDari = (p: Pesan) =>
  p.bagian
    .filter((b): b is { jenis: "alat"; alat: PanggilanAlat } => b.jenis === "alat")
    .map((b) => b.alat);

export function Asisten() {
  const [pesan, setPesan] = useState<Pesan[]>([]);
  const [teks, setTeks] = useState("");
  const [sibuk, setSibuk] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bawahRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    bawahRef.current?.scrollIntoView({ block: "end" });
  }, [pesan, sibuk]);

  /** Textarea tumbuh mengikuti isi, sampai batas lalu menggulung sendiri. */
  const aturTinggi = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, TINGGI_MAKS) + "px";
  }, []);

  useEffect(aturTinggi, [teks, aturTinggi]);

  const batal = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSibuk(false);
  }, []);

  const kirim = async (isi: string) => {
    const q = isi.trim();
    if (!q || sibuk) return;

    const riwayat: Pesan[] = [
      ...pesan,
      { peran: "user", bagian: [{ jenis: "teks", teks: q }] },
    ];
    setPesan([...riwayat, { peran: "assistant", bagian: [] }]);
    setTeks("");
    setSibuk(true);

    const ac = new AbortController();
    abortRef.current = ac;

    const ubah = (f: (p: Pesan) => Pesan) =>
      setPesan((list) => {
        const out = [...list];
        out[out.length - 1] = f(out[out.length - 1]);
        return out;
      });

    /** Teks yang datang berurutan digabung ke potongan teks terakhir. */
    const tambahTeks = (t: string) =>
      ubah((m) => {
        const b = [...m.bagian];
        const akhir = b[b.length - 1];
        if (akhir && akhir.jenis === "teks") {
          b[b.length - 1] = { jenis: "teks", teks: akhir.teks + t };
        } else {
          b.push({ jenis: "teks", teks: t });
        }
        return { ...m, bagian: b };
      });

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          messages: riwayat.map((m) => ({ role: m.peran, content: teksDari(m) })),
        }),
      });

      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        ubah((p) => ({ ...p, galat: j?.error ?? `Permintaan gagal (HTTP ${res.status}).` }));
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let sisa = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sisa += dec.decode(value, { stream: true });
        const potongan = sisa.split("\n");
        sisa = potongan.pop() ?? "";

        for (const p of potongan) {
          if (!p.trim()) continue;
          let k: Record<string, unknown>;
          try {
            k = JSON.parse(p);
          } catch {
            continue;
          }

          if (k.t === "delta") {
            tambahTeks(String(k.teks));
          } else if (k.t === "tool_call") {
            ubah((m) => ({
              ...m,
              bagian: [
                ...m.bagian,
                {
                  jenis: "alat",
                  alat: {
                    id: String(k.id),
                    nama: String(k.nama),
                    args: (k.args ?? {}) as Record<string, unknown>,
                  },
                },
              ],
            }));
          } else if (k.t === "tool_result") {
            ubah((m) => ({
              ...m,
              bagian: m.bagian.map((b) =>
                b.jenis === "alat" && b.alat.id === k.id
                  ? {
                      jenis: "alat",
                      alat: {
                        ...b.alat,
                        ok: Boolean(k.ok),
                        cache: Boolean(k.cache),
                        meta: k.meta as Record<string, unknown> | undefined,
                        rows: k.rows as Record<string, unknown>[] | undefined,
                        error: k.error as string | undefined,
                      },
                    }
                  : b
              ),
            }));
          } else if (k.t === "berpikir") {
            ubah((m) => ({ ...m, berpikir: Number(k.n) }));
          } else if (k.t === "galat") {
            ubah((m) => ({ ...m, galat: String(k.pesan) }));
          }
        }
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") {
        ubah((p) => ({ ...p, galat: "Koneksi ke server terputus." }));
      }
    } finally {
      setSibuk(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-10rem)] flex-col">
      {/*
        Teks dibatasi lebar bacanya, tapi jejak alat dan tabel boleh selebar
        wadahnya dan menggeser sendiri — angka tidak terbaca kalau dipaksa
        masuk kolom selebar paragraf.
      */}
      <div
        aria-live="polite"
        aria-label="Percakapan dengan asisten"
        className="min-h-0 flex-1"
      >
        {pesan.length === 0 ? (
          <div className="max-w-[72ch]">
            <p className="text-sm text-muted">
              Setiap angka dijawab dari hasil pemanggilan alat ke database, dan alat
              yang dipakai selalu ditampilkan supaya bisa ditelusuri. Asisten ini
              hanya bisa membaca.
            </p>
            <ul className="mt-4 space-y-2">
              {CONTOH.map((c) => (
                <li key={c}>
                  <button
                    type="button"
                    onClick={() => kirim(c)}
                    className="btn-ghost w-full justify-start text-left"
                  >
                    {c}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="space-y-6">
            {pesan.map((m, i) => {
              const teksJawab = teksDari(m);
              const alat = alatDari(m);
              const berjalan = sibuk && i === pesan.length - 1;

              return (
                <article key={i}>
                  <div className="mb-1 text-xs font-semibold text-muted">
                    {m.peran === "user" ? "Anda" : "Asisten"}
                  </div>

                  {m.peran === "user" ? (
                    <p className="max-w-[72ch] text-sm whitespace-pre-wrap">{teksJawab}</p>
                  ) : (
                    <>
                      {/*
                        Selama menunggu, langkah ditampilkan sebagai kemajuan
                        supaya pengguna tahu sistem sedang bekerja. Setelah
                        jawaban selesai, langkah-langkah itu mengkerut jadi
                        nota di bawah — jawabannya yang jadi produk.
                      */}
                      {berjalan && (
                        <div className="mb-2 space-y-0.5">
                          {alat.length === 0 ? (
                            <p className="text-sm text-muted">
                              {m.berpikir ? "Sedang berpikir…" : "Menghubungi model…"}
                            </p>
                          ) : (
                            alat.map((a) => (
                              <p key={a.id} className="text-sm text-muted">
                                {a.rows || a.ok === false ? "Selesai" : "Memeriksa data"}
                                {": " + namaTampilan(a.nama)}
                                {a.rows ? ` · ${a.rows.length} baris` : "…"}
                              </p>
                            ))
                          )}
                        </div>
                      )}

                      {teksJawab.trim() !== "" && (
                        <div className="max-w-[72ch]">
                          <Markdown teks={teksJawab} />
                        </div>
                      )}

                      {m.galat && (
                        <p role="alert" className="mt-2 max-w-[72ch] text-sm text-danger">
                          {m.galat}
                        </p>
                      )}

                      {!berjalan && alat.length > 0 && (
                        <div className="mt-3 max-w-[72ch] border-t border-line pt-2">
                          {alat.map((a) => (
                            <Jejak key={a.id} a={a} />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </article>
              );
            })}
          </div>
        )}
        <div ref={bawahRef} />
      </div>

      <div className="sticky bottom-0 mt-6 border-t border-line bg-paper pt-3 pb-4">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={teks}
            onChange={(e) => setTeks(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                kirim(teks);
              }
            }}
            placeholder="Tanya soal stok, penjualan, piutang…"
            aria-label="Pertanyaan"
            className="field resize-none"
            style={{ maxHeight: TINGGI_MAKS }}
          />
          {sibuk ? (
            <button type="button" onClick={batal} className="btn-ghost shrink-0">
              Batal
            </button>
          ) : (
            <button
              type="button"
              onClick={() => kirim(teks)}
              disabled={!teks.trim()}
              className="btn shrink-0"
            >
              Kirim
            </button>
          )}
        </div>
        <p className="mt-1.5 text-xs text-muted">
          Enter mengirim, Shift+Enter baris baru. Riwayat hanya disimpan selama
          halaman ini terbuka.
        </p>
      </div>
    </div>
  );
}
