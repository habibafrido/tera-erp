import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tera ERP",
  description:
    "Stok dan pembukuan bergerak bersama. ERP distributor dengan buku besar " +
    "stok append-only dan jurnal berpasangan.",
};

/**
 * Menerapkan tema tersimpan sebelum cat pertama, supaya halaman tidak
 * berkedip terang lalu berubah gelap.
 *
 * Yang disentuh hanya data-theme pada <html>. Atribut itu tidak pernah
 * dirender React, jadi tidak ada prop yang dibandingkan saat hydration —
 * bukan karena <html> berada di luar pohon React (di App Router justru
 * React yang merendernya), melainkan karena React hanya merekonsiliasi
 * atribut yang ia tulis sendiri.
 *
 * Skrip ini sengaja TIDAK menentukan teks tombol tema. Kalau ikut, server
 * dan klien akan merender label berbeda dan itu hydration mismatch
 * sungguhan. Pembacaan tema oleh komponen tetap terjadi di useEffect.
 */
const TEMA_AWAL = `
try {
  var t = localStorage.getItem("tera-theme");
  if (t === "light" || t === "dark") {
    document.documentElement.dataset.theme = t;
  }
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <head>
        <script dangerouslySetInnerHTML={{ __html: TEMA_AWAL }} />
      </head>
      {/*
        Kerangka aplikasi (sidebar, menu) tidak ada di sini melainkan di
        app/(terlindungi)/layout.tsx. Halaman masuk memakai layout akar
        ini apa adanya, jadi ia tidak menampilkan menu untuk aplikasi
        yang belum boleh dimasuki.
      */}
      <body>{children}</body>
    </html>
  );
}
