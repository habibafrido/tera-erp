import { redirect } from "next/navigation";
import { penggunaSaatIni } from "@/lib/auth/sesi";
import { FormMasuk } from "@/components/FormMasuk";

export const dynamic = "force-dynamic";

export default async function HalamanMasuk() {
  // Sudah masuk? Tidak perlu melihat formulir lagi.
  if (await penggunaSaatIni()) redirect("/");

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-8">
        <h1 className="text-lg font-semibold tracking-tight">Tera</h1>
        <p className="text-sm text-muted">Stok dan pembukuan bergerak bersama</p>
      </div>

      <FormMasuk />

      <p className="mt-8 text-xs text-muted">
        Setiap dokumen mencatat siapa yang membuatnya, dan setiap upaya masuk —
        berhasil maupun ditolak — tercatat di jejak audit yang tidak bisa diubah.
      </p>
    </div>
  );
}
