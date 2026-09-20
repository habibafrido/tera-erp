import { PageHeader, Panel, Empty, TableWrap, Badge } from "@/components/ui";
import { TutupBuku } from "@/components/TutupBuku";
import { daftarPeriode, riwayatPeriode } from "@/lib/tutup-buku";
import { penggunaSaatIni } from "@/lib/auth/sesi";

export const dynamic = "force-dynamic";

export default async function TutupBukuPage() {
  const [periode, riwayat, pengguna] = await Promise.all([
    daftarPeriode(),
    riwayatPeriode(),
    penggunaSaatIni(),
  ]);

  const tertutup = periode.filter((p) => p.status === "DITUTUP").length;
  const pernahDibuka = periode.filter((p) => p.pernahDibuka).length;

  return (
    <>
      <PageHeader
        title="Tutup buku"
        desc="Periode yang ditutup menolak posting bertanggal di dalamnya — ditegakkan trigger basis data, bukan oleh aplikasi. Laporan yang sudah dicetak dan dikirim tidak bisa berubah diam-diam lagi."
      />

      <div className="card mb-6 p-4 text-sm">
        <h2 className="mb-2 font-semibold">
          Cara memperbaiki kesalahan di periode yang sudah ditutup
        </h2>
        <p className="text-muted">
          Bukan dengan membuka kembali. Buka dokumennya, tekan{" "}
          <strong className="text-ink">Batalkan</strong>, lalu beri tanggal
          pembalik di bulan yang masih terbuka. Sistem membuat jurnal pembalik —
          debit dan kredit ditukar — dan mengembalikan pergerakan stoknya, semua
          bertanggal di periode berjalan.
        </p>
        <p className="mt-2 text-muted">
          Hasilnya: laporan periode lama tetap persis seperti saat dicetak, dan
          koreksinya muncul di bulan tempat kesalahan itu benar-benar diketahui.
          Itulah yang diharapkan auditor, bank, dan kantor pajak. Membuka kembali
          periode adalah jalan terakhir, dan meninggalkan tanda permanen.
        </p>
      </div>

      <Panel
        className="mb-8"
        title="Periode"
        meta={`${tertutup} ditutup${pernahDibuka ? `, ${pernahDibuka} pernah dibuka kembali` : ""}`}
      >
        {periode.length === 0 ? (
          <Empty text="Belum ada jurnal, jadi belum ada periode untuk ditutup." />
        ) : (
          <TutupBuku
            periode={periode}
            bolehKelola={pengguna?.peran === "pengawas"}
          />
        )}
      </Panel>

      <Panel title="Riwayat" meta="append-only, tidak bisa dihapus">
        {riwayat.length === 0 ? (
          <Empty text="Belum ada periode yang pernah ditutup." />
        ) : (
          <TableWrap min={640}>
            <thead>
              <tr>
                <th className="th">Waktu</th>
                <th className="th">Periode</th>
                <th className="th">Aksi</th>
                <th className="th">Oleh</th>
                <th className="th">Alasan</th>
              </tr>
            </thead>
            <tbody>
              {riwayat.map((r, i) => (
                <tr key={i}>
                  <td className="td tnum text-muted">{r.pada}</td>
                  <td className="td tnum">
                    {r.tahun}-{String(r.bulan).padStart(2, "0")}
                  </td>
                  <td className="td">
                    <Badge tone={r.aksi === "DITUTUP" ? "muted" : "warning"}>
                      {r.aksi === "DITUTUP" ? "Ditutup" : "Dibuka kembali"}
                    </Badge>
                  </td>
                  <td className="td">
                    <span className="block">{r.nama ?? "—"}</span>
                    <span className="block text-xs text-muted">{r.email ?? ""}</span>
                  </td>
                  <td className="td text-muted">{r.alasan ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>
    </>
  );
}
