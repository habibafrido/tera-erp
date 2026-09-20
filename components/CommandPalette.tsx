"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { HasilKelompok } from "@/app/api/search/route";
import { createLatest } from "@/lib/latest";

const DEBOUNCE_MS = 150;
const MIN_PANJANG = 2;
const MAKS_PANJANG = 100;

/** Navigasi statis. Disaring di klien, tidak pernah memanggil server. */
const HALAMAN = [
  { label: "Beranda", sub: "Ringkasan stok dan piutang", href: "/" },
  { label: "Saldo stok", sub: "Saldo, batch FEFO, pergerakan", href: "/stock" },
  { label: "Jurnal", sub: "Neraca percobaan dan jurnal", href: "/journal" },
  { label: "Penerimaan barang", sub: "Daftar penerimaan", href: "/receipts" },
  { label: "Catat penerimaan", sub: "Form penerimaan baru", href: "/receipts/new" },
  { label: "Penjualan", sub: "Daftar faktur", href: "/sales" },
  { label: "Buat faktur", sub: "Form faktur baru", href: "/sales/new" },
  { label: "Barang", sub: "Data induk barang", href: "/products" },
  { label: "Mitra", sub: "Pelanggan dan pemasok", href: "/partners" },
  { label: "Gudang", sub: "Data induk gudang", href: "/warehouses" },
];

type Item = { label: string; sub: string; href: string };

export function CommandPalette() {
  const router = useRouter();

  const [buka, setBuka] = useState(false);
  const [teks, setTeks] = useState("");
  const [kelompokServer, setKelompokServer] = useState<HasilKelompok[]>([]);
  const [memuat, setMemuat] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);
  const [sorot, setSorot] = useState(0);

  // Platform hanya diketahui di klien. Sampai mount selesai labelnya netral,
  // supaya markup server dan klien tidak berbeda.
  const [mac, setMac] = useState<boolean | null>(null);

  const pemicuRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Balasan yang bukan dari permintaan terbaru dibuang; tanpa ini mengetik
  // cepat membuat hasil lama menimpa hasil baru. Logikanya ada di
  // lib/latest.ts supaya bisa diuji tanpa browser.
  const latestRef = useRef(createLatest());
  const abortRef = useRef<AbortController | null>(null);

  const dialogId = useId();
  const listId = dialogId + "-list";
  const opsiId = (i: number) => `${dialogId}-opt-${i}`;

  useEffect(() => {
    setMac(/mac|iphone|ipad|ipod/i.test(navigator.userAgent));
  }, []);

  const tutup = useCallback(() => {
    setBuka(false);
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // --- Pintasan global -----------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // metaKey untuk macOS, ctrlKey untuk Windows/Linux. Keduanya diterima
      // supaya papan ketik eksternal lintas platform tetap bekerja.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setBuka((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- Fokus masuk saat buka, kembali ke pemicu saat tutup -----------------
  useEffect(() => {
    if (buka) {
      inputRef.current?.focus();
      return;
    }
    setTeks("");
    setKelompokServer([]);
    setGalat(null);
    setSorot(0);
    pemicuRef.current?.focus();
  }, [buka]);

  // --- Ambil hasil dari server, ter-debounce --------------------------------
  useEffect(() => {
    if (!buka) return;

    const q = teks.trim();
    if (q.length < MIN_PANJANG) {
      abortRef.current?.abort();
      abortRef.current = null;
      // Balasan yang masih di jalan ikut dibuang.
      latestRef.current.invalidate();
      setKelompokServer([]);
      setMemuat(false);
      setGalat(null);
      return;
    }

    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      const urut = latestRef.current.next();
      setMemuat(true);
      setGalat(null);

      fetch("/api/search?q=" + encodeURIComponent(q), { signal: ac.signal })
        .then((r) => r.json())
        .then((d: { groups?: HasilKelompok[]; error?: string }) => {
          if (!latestRef.current.isCurrent(urut)) return; // balasan basi
          setKelompokServer(d.groups ?? []);
          setGalat(d.error ?? null);
          setMemuat(false);
        })
        .catch((e) => {
          if (e?.name === "AbortError") return;
          if (!latestRef.current.isCurrent(urut)) return;
          setGalat("Pencarian tidak bisa dijangkau.");
          setMemuat(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [teks, buka]);

  // --- Susun kelompok ------------------------------------------------------
  const kelompok = useMemo<HasilKelompok[]>(() => {
    const q = teks.trim().toLowerCase();
    const halaman = q
      ? HALAMAN.filter(
          (h) =>
            h.label.toLowerCase().includes(q) || h.sub.toLowerCase().includes(q)
        )
      : HALAMAN;

    const out: HasilKelompok[] = [];
    if (halaman.length) out.push({ title: "Halaman", items: halaman });
    return out.concat(kelompokServer);
  }, [teks, kelompokServer]);

  const datar = useMemo<Item[]>(() => kelompok.flatMap((g) => g.items), [kelompok]);

  // Sorotan dijaga tetap di dalam rentang saat daftar berubah panjang.
  useEffect(() => {
    setSorot((s) => (datar.length === 0 ? 0 : Math.min(s, datar.length - 1)));
  }, [datar.length]);

  // Sorotan ikut tergulung ke dalam pandangan.
  useEffect(() => {
    if (!buka) return;
    document.getElementById(opsiId(sorot))?.scrollIntoView({ block: "nearest" });
    // opsiId stabil selama dialogId stabil
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorot, buka, datar.length]);

  const bukaItem = (it: Item | undefined) => {
    if (!it) return;
    tutup();
    router.push(it.href);
  };

  // --- Papan ketik di dalam dialog ----------------------------------------
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      tutup();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSorot((s) => (datar.length ? (s + 1) % datar.length : 0));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSorot((s) => (datar.length ? (s - 1 + datar.length) % datar.length : 0));
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      bukaItem(datar[sorot]);
      return;
    }

    // Fokus dikurung di dalam dialog selama terbuka.
    if (e.key === "Tab") {
      const fokusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!fokusable || fokusable.length === 0) return;
      const pertama = fokusable[0];
      const terakhir = fokusable[fokusable.length - 1];
      if (e.shiftKey && document.activeElement === pertama) {
        e.preventDefault();
        terakhir.focus();
      } else if (!e.shiftKey && document.activeElement === terakhir) {
        e.preventDefault();
        pertama.focus();
      }
    }
  };

  const pintasan = mac === null ? "Cari" : mac ? "⌘K" : "Ctrl K";

  return (
    <>
      <button
        ref={pemicuRef}
        type="button"
        onClick={() => setBuka(true)}
        className="btn-ghost mb-5 w-full justify-between"
        aria-haspopup="dialog"
        aria-expanded={buka}
      >
        <span className="text-muted">Cari…</span>
        <span className="tnum font-mono text-xs text-muted">{pintasan}</span>
      </button>

      {buka && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]"
          onKeyDown={onKeyDown}
        >
          {/* Latar peredup. Klik di luar dialog menutup palet. */}
          <div
            className="absolute inset-0 bg-ink/30"
            onClick={tutup}
            aria-hidden="true"
          />

          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Pencarian"
            className="card relative z-10 flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden"
          >
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <input
                ref={inputRef}
                value={teks}
                maxLength={MAKS_PANJANG}
                onChange={(e) => {
                  setTeks(e.target.value);
                  setSorot(0);
                }}
                placeholder="Cari barang, mitra, atau nomor dokumen…"
                className="field border-0 focus-visible:outline-0"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={datar.length ? opsiId(sorot) : undefined}
              />
              <button type="button" onClick={tutup} className="btn-ghost shrink-0">
                Esc
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {galat && (
                <p className="px-4 py-3 text-sm text-danger" role="alert">
                  {galat}
                </p>
              )}

              <ul id={listId} role="listbox" aria-label="Hasil pencarian">
                {kelompok.map((g) => (
                  <li key={g.title}>
                    <div className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">
                      {g.title}
                    </div>
                    <ul>
                      {g.items.map((it) => {
                        const i = datar.indexOf(it);
                        const aktif = i === sorot;
                        return (
                          <li
                            key={g.title + it.href + it.label}
                            id={opsiId(i)}
                            role="option"
                            aria-selected={aktif}
                            onMouseEnter={() => setSorot(i)}
                            onClick={() => bukaItem(it)}
                            className={
                              "cursor-pointer px-4 py-2 " + (aktif ? "bg-raised" : "")
                            }
                          >
                            <div className="text-sm font-medium">{it.label}</div>
                            <div className="tnum font-mono text-xs text-muted">
                              {it.sub}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>

              {memuat && (
                <p className="px-4 py-3 text-sm text-muted">Mencari…</p>
              )}

              {!memuat && !galat && datar.length === 0 && (
                <p className="px-4 py-8 text-center text-sm text-muted">
                  {teks.trim().length < MIN_PANJANG
                    ? "Ketik minimal dua huruf untuk mencari barang, mitra, dan dokumen."
                    : `Tidak ada yang cocok dengan “${teks.trim()}”.`}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-3 border-t border-line px-4 py-2 text-xs text-muted">
              <span>↑↓ pindah</span>
              <span>↵ buka</span>
              <span>Esc tutup</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
