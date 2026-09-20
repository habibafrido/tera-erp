"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { CommandPalette } from "./CommandPalette";
import { keluar } from "@/app/auth-actions";
import { HALAMAN_PERAN, LABEL_PERAN, type Peran } from "@/lib/auth/izin";

const STORAGE_KEY = "tera-theme";

const GROUPS: { title: string; items: { href: string; label: string }[] }[] = [
  {
    title: "Ringkasan",
    items: [
      { href: "/", label: "Beranda" },
      { href: "/stock", label: "Saldo stok" },
      { href: "/journal", label: "Jurnal" },
      { href: "/asisten", label: "Asisten" },
    ],
  },
  {
    title: "Laporan keuangan",
    items: [
      { href: "/laporan/neraca", label: "Neraca" },
      { href: "/laporan/laba-rugi", label: "Laba Rugi" },
      { href: "/laporan/arus-kas", label: "Arus Kas" },
      { href: "/tutup-buku", label: "Tutup buku" },
    ],
  },
  {
    title: "Transaksi",
    items: [
      { href: "/receipts", label: "Penerimaan barang" },
      { href: "/purchases", label: "Faktur pembelian" },
      { href: "/sales", label: "Penjualan" },
      { href: "/payments", label: "Penerimaan pembayaran" },
      { href: "/supplier-payments", label: "Bayar pemasok" },
    ],
  },
  {
    title: "Data induk",
    items: [
      { href: "/products", label: "Barang" },
      { href: "/partners", label: "Mitra" },
      { href: "/warehouses", label: "Gudang" },
    ],
  },
];

type Theme = "light" | "dark";

function ThemeToggle() {
  // null = belum mount. Tema TIDAK ditebak saat render: server tidak tahu
  // preferensi klien, jadi menebaknya di sini akan membuat label tombol
  // berbeda antara server dan klien — itu hydration mismatch yang sebenarnya.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    let tersimpan: string | null = null;
    try {
      tersimpan = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Mode privat bisa menolak akses penyimpanan. Jatuh ke preferensi sistem.
    }

    if (tersimpan === "light" || tersimpan === "dark") {
      document.documentElement.setAttribute("data-theme", tersimpan);
      setTheme(tersimpan);
      return;
    }

    const gelap = window.matchMedia("(prefers-color-scheme: dark)").matches;
    setTheme(gelap ? "dark" : "light");
  }, []);

  const ganti = () => {
    const berikut: Theme = theme === "dark" ? "light" : "dark";
    setTheme(berikut);
    document.documentElement.setAttribute("data-theme", berikut);
    try {
      localStorage.setItem(STORAGE_KEY, berikut);
    } catch {
      // Pilihan tetap berlaku untuk sesi ini walau tidak bisa disimpan.
    }
  };

  // Label netral sampai mount selesai, supaya markup server dan klien sama.
  const label = theme === null ? "Tema" : theme === "dark" ? "Mode terang" : "Mode gelap";

  return (
    <button
      type="button"
      onClick={ganti}
      disabled={theme === null}
      aria-label={label}
      className="btn-ghost w-full justify-center"
    >
      {label}
    </button>
  );
}

export function Sidebar({
  pengguna,
}: {
  pengguna: { nama: string; email: string; peran: Peran };
}) {
  const path = usePathname();
  const [buka, setBuka] = useState(false);

  // Menu ponsel ditutup setiap kali rute berganti, kalau tidak ia menutupi
  // halaman yang baru saja dibuka.
  useEffect(() => {
    setBuka(false);
  }, [path]);

  return (
    /*
     * Di layar lebar sidebar MENETAP: sticky top-0, setinggi satu layar,
     * dan menggulung sendiri. Navigasi karena itu tidak ikut hilang saat
     * orang membaca tabel panjang seperti Jurnal.
     *
     * Syarat sticky yang paling mudah terlewat ada di induknya, bukan di
     * sini: satu saja leluhur yang punya overflow selain visible akan
     * mematikan sticky TANPA pesan galat apa pun. Lihat catatan di
     * app/(terlindungi)/layout.tsx.
     *
     * Di layar sempit sticky sengaja TIDAK dipakai. Sidebar di sana
     * adalah batang atas dengan menu buka-tutup; membuatnya menempel
     * akan memakan tinggi layar yang justru paling sedikit tersedia.
     */
    <aside
      className={
        "flex shrink-0 flex-col border-b border-line px-4 " +
        // Bilah sistem ponsel menutupi tepi layar. env() bernilai nol di
        // perangkat tanpa inset, jadi max() membuat baris ini tidak
        // mengubah apa pun di desktop.
        "pt-[max(1rem,env(safe-area-inset-top))] " +
        "pb-[max(1rem,env(safe-area-inset-bottom))] " +
        "lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:border-r lg:border-b-0 " +
        "lg:pt-[max(1.25rem,env(safe-area-inset-top))] " +
        "lg:pb-[max(1.25rem,env(safe-area-inset-bottom))]"
      }
    >
      <div className="flex shrink-0 items-center justify-between gap-3">
        <Link href="/" className="block rounded px-3 py-1">
          <span className="block text-sm font-semibold tracking-tight">Tera</span>
          <span className="block text-xs text-muted">Stok dan pembukuan bergerak bersama</span>
        </Link>

        <button
          type="button"
          onClick={() => setBuka((v) => !v)}
          aria-expanded={buka}
          aria-controls="menu-utama"
          className="btn-ghost lg:hidden"
        >
          Menu
        </button>
      </div>

      {/*
        Wadah menu menjadi kolom lentur di layar lebar: merek di atas,
        navigasi memanjang di tengah, blok pengguna menempel di bawah.
        min-h-0 wajib — tanpa itu anak ber-flex-1 menolak menyusut lebih
        kecil dari isinya dan overflow-y-auto di dalamnya tidak pernah
        aktif, sehingga item terbawah tidak bisa dijangkau di layar pendek.
      */}
      <div
        id="menu-utama"
        className={
          (buka ? "flex" : "hidden") +
          " mt-5 min-h-0 flex-1 flex-col gap-5 lg:mt-6 lg:flex"
        }
      >
        <div className="shrink-0">
          <CommandPalette />
        </div>

        {/*
          Navigasi yang menggulung SENDIRI. Pada viewport pendek — 600px
          dengan seluruh menu terlihat — item terbawah tetap terjangkau
          tanpa menggulung halamannya.
        */}
        <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto">
          {/*
            Menu di luar kewenangan disembunyikan. Ini KENYAMANAN, bukan
            pengamanan — mengetik alamatnya langsung tetap mungkin, dan
            yang menghentikannya adalah pemeriksaan di server action dan
            di layout, bukan daftar ini.
          */}
          {GROUPS.map((g) => ({
            ...g,
            items: g.items.filter((it) => {
              const boleh = HALAMAN_PERAN[it.href];
              return !boleh || boleh.includes(pengguna.peran);
            }),
          }))
            .filter((g) => g.items.length > 0)
            .map((g) => (
            <div key={g.title}>
              <div className="mb-1.5 px-3 text-xs font-semibold tracking-wide text-muted uppercase">
                {g.title}
              </div>
              <ul className="space-y-0.5">
                {g.items.map((it) => {
                  // "/" hanya cocok persis; sisanya juga cocok untuk sub-rute
                  // seperti /receipts/new.
                  const aktif =
                    it.href === "/" ? path === "/" : path.startsWith(it.href);
                  return (
                    <li key={it.href}>
                      <Link
                        href={it.href}
                        aria-current={aktif ? "page" : undefined}
                        className={
                          "block rounded-md px-3 py-1.5 text-sm " +
                          (aktif
                            ? "bg-raised font-medium text-action"
                            : "text-ink hover:bg-raised")
                        }
                      >
                        {it.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/*
          Identitas yang sedang dipakai ditampilkan terus-menerus. Di
          sistem yang setiap dokumennya mencatat pembuatnya, "saya kira
          saya sedang masuk sebagai orang lain" adalah kekeliruan yang
          menghasilkan jejak audit yang salah, bukan sekadar kebingungan.
        */}
        <div className="shrink-0 border-t border-line pt-4">
          <div className="px-3">
            <span className="block truncate text-sm font-medium">{pengguna.nama}</span>
            <span className="block truncate text-xs text-muted">{pengguna.email}</span>
            <span className="mt-1 block text-xs text-action">
              {LABEL_PERAN[pengguna.peran]}
            </span>
          </div>
          <form action={keluar} className="mt-2 px-3">
            <button type="submit" className="btn-ghost w-full">
              Keluar
            </button>
          </form>
        </div>

        <div className="shrink-0 border-t border-line pt-4">
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
