import { NextResponse, type NextRequest } from "next/server";

/**
 * Pengalihan cepat untuk permintaan tanpa cookie sesi.
 *
 * YANG INI TIDAK MENGAMANKAN APA PUN, dan penting untuk menyadarinya.
 * Middleware berjalan di runtime Edge yang tidak punya akses ke
 * PostgreSQL, jadi yang bisa diperiksa hanya ADA atau TIDAKNYA cookie —
 * bukan apakah isinya sesi yang sah, belum kedaluwarsa, milik akun yang
 * masih aktif, dan berperan sesuai.
 *
 * Cookie palsu berisi teks apa pun akan lolos dari sini. Yang
 * menghentikannya:
 *   - app/(terlindungi)/layout.tsx, yang memverifikasi sesi ke database
 *     sebelum halaman apa pun dirender;
 *   - denganPeran() di setiap server action;
 *   - penggunaUntukApi() di setiap route handler.
 *
 * Gunanya berkas ini hanya satu: pengunjung yang belum masuk langsung
 * melihat halaman masuk alih-alih menunggu render halaman yang akan
 * dialihkan juga.
 */

/*
 * /api/masuk-uji ikut publik karena ia MEMBUAT sesi; menuntut sesi untuk
 * memintanya akan menjadi lingkaran. Endpoint itu sendiri menolak
 * berjalan di produksi.
 */
const PUBLIK = ["/masuk", "/api/masuk-uji"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIK.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  if (req.cookies.has("tera_sesi")) return NextResponse.next();

  /*
   * Route handler API menjawab 401 dalam JSON, bukan dialihkan.
   * Mengalihkan permintaan fetch ke halaman HTML akan membuat klien
   * menerima HTML tempat ia mengharap JSON, dan pesan galatnya menjadi
   * tidak masuk akal.
   */
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Sesi tidak ditemukan. Masuk lebih dulu." },
      { status: 401 }
    );
  }

  const tujuan = req.nextUrl.clone();
  tujuan.pathname = "/masuk";
  tujuan.search = "";
  return NextResponse.redirect(tujuan);
}

export const config = {
  /*
   * Aset statis dan berkas build dilewati. _next/static dan _next/image
   * tidak pernah berisi data, dan memeriksanya hanya menambah latensi
   * pada setiap gambar dan setiap potongan JavaScript.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
