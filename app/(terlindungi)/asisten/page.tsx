import type { Metadata } from "next";
import { Asisten } from "@/components/Asisten";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = {
  title: "Asisten — Tera ERP",
  description:
    "Asisten baca-saja yang menjawab dari hasil pemanggilan alat ke database.",
};

export default function AsistenPage() {
  return (
    <>
      <PageHeader
        title="Asisten"
        desc="Setiap angka berasal dari pemanggilan alat ke database, dan alat yang dipakai selalu bisa dibuka untuk ditelusuri. Asisten hanya bisa membaca — ia tidak bisa memposting atau mengubah dokumen."
      />
      <Asisten />
    </>
  );
}
