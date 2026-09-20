import { redirect } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { penggunaSaatIni } from "@/lib/auth/sesi";

/**
 * Gerbang halaman.
 *
 * Seluruh halaman aplikasi berada di dalam grup rute ini, jadi
 * pemeriksaannya ditulis SEKALI di sini alih-alih diulang di setiap
 * berkas page.tsx — halaman baru ikut terlindungi hanya dengan
 * diletakkan di folder yang benar, bukan dengan mengingat sesuatu.
 *
 * Ini BUKAN satu-satunya penegakan. Server action adalah endpoint HTTP
 * tersendiri yang tidak pernah melewati layout mana pun; masing-masing
 * memeriksa sesinya sendiri lewat denganPeran(). Lihat lib/auth/penjaga.ts.
 *
 * Nama grup diapit tanda kurung, sehingga tidak muncul di URL: halaman
 * tetap berada di /stock, bukan /(terlindungi)/stock.
 */
export default async function LayoutTerlindungi({
  children,
}: {
  children: React.ReactNode;
}) {
  const pengguna = await penggunaSaatIni();
  if (!pengguna) redirect("/masuk");

  return (
    /*
     * TIDAK ADA overflow apa pun di sini, dan itu disengaja.
     *
     * Sidebar memakai position: sticky. Satu saja leluhur yang punya
     * overflow selain visible — termasuk overflow-x-hidden yang sering
     * ditambahkan untuk "merapikan" — akan mengubah elemen ini menjadi
     * scroll container baru, dan sticky di dalamnya akan menempel pada
     * wadah itu alih-alih pada viewport. Gejalanya: sidebar diam saja
     * saat halaman digulung, tanpa satu pun pesan galat.
     *
     * items-start juga penting: bawaan flex adalah stretch, yang
     * memanjangkan <aside> setinggi isi halaman sehingga lg:h-screen
     * tidak berarti apa-apa.
     */
    <div className="mx-auto flex min-h-screen max-w-[1400px] flex-col items-stretch lg:flex-row lg:items-start">
      <Sidebar pengguna={pengguna} />
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-7">{children}</main>
    </div>
  );
}
