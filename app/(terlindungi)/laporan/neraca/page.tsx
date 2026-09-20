import { neraca, tanggalAcuan } from "@/lib/laporan-keuangan";
import { Badge, Empty, PageHeader, Panel, StatBand } from "@/components/ui";
import { BarisJumlah, TabelKeuangan } from "@/components/laporan/TabelKeuangan";
import { TombolEkspor } from "@/components/TombolEkspor";
import { rupiah, tanggal } from "@/lib/format";

export const dynamic = "force-dynamic";

const TGL = /^\d{4}-\d{2}-\d{2}$/;

export default async function NeracaPage({
  searchParams,
}: {
  searchParams: Promise<{ per?: string; banding?: string }>;
}) {
  const sp = await searchParams;
  const acuan = await tanggalAcuan();

  // Tanggal dari URL divalidasi sebagai TEKS dan diteruskan sebagai teks.
  // Tidak pernah melewati objek Date: new Date("2026-09-20") diurai sebagai
  // tengah malam UTC dan bisa mundur sehari saat diformat ulang.
  const perTanggal = TGL.test(sp.per ?? "") ? sp.per! : acuan.hariIni;
  const bandingTanggal = TGL.test(sp.banding ?? "") ? sp.banding! : acuan.akhirBulanLalu;

  const n = await neraca(perTanggal, bandingTanggal);

  const seimbang = n.seimbang;
  const labelPeriode = tanggal(perTanggal);
  const labelPembanding = tanggal(bandingTanggal);
  const awalTahun = perTanggal.slice(0, 4) + "-01-01";

  return (
    <>
      <PageHeader
        title="Neraca"
        desc="Posisi keuangan pada satu tanggal, diakumulasi sejak jurnal pertama. Laba periode berjalan tampil sebagai barisnya sendiri di sisi ekuitas — tanpa baris itu neraca tidak akan pernah seimbang."
        action={
          <TombolEkspor
            laporan="neraca"
            filter={{ per: perTanggal, banding: bandingTanggal }}
          />
        }
      />

      <form method="get" className="card mb-6 flex flex-wrap items-end gap-4 p-4">
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Per tanggal</span>
          <input className="field" type="date" name="per" defaultValue={perTanggal} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Dibandingkan dengan</span>
          <input
            className="field"
            type="date"
            name="banding"
            defaultValue={bandingTanggal}
          />
        </label>
        <button type="submit" className="btn">Tampilkan</button>
      </form>

      <StatBand
        items={[
          { label: "Total aset", value: rupiah(n.totalAset), hint: labelPeriode },
          { label: "Total liabilitas", value: rupiah(n.totalLiabilitas) },
          { label: "Ekuitas + laba berjalan", value: rupiah(n.totalEkuitasDanLaba) },
          {
            label: "Selisih",
            value: rupiah(n.selisih),
            hint: seimbang ? "seimbang" : "TIDAK seimbang",
          },
        ]}
      />

      {!seimbang && (
        <div role="alert" className="card mb-6 p-4 text-sm">
          <strong className="text-danger">Neraca tidak seimbang.</strong> Aset
          dikurangi (liabilitas + ekuitas + laba berjalan) menghasilkan{" "}
          {rupiah(n.selisih)}, seharusnya tepat nol. Ini bukan selisih pembulatan;
          periksa jurnal pada atau sebelum {labelPeriode}.
        </div>
      )}

      <Panel
        className="mb-6"
        title="Aset"
        meta={`per ${labelPeriode}`}
        action={
          <Badge tone={seimbang ? "positive" : "danger"}>
            {seimbang ? "Seimbang" : "Tidak seimbang"}
          </Badge>
        }
      >
        {n.aset.length === 0 ? (
          <Empty text="Belum ada akun aset bersaldo pada tanggal ini." />
        ) : (
          <TabelKeuangan
            baris={n.aset}
            labelPeriode={labelPeriode}
            labelPembanding={labelPembanding}
            jumlah={{
              label: "Total aset",
              nilai: n.totalAset,
              pembanding: n.bandingTotalAset,
            }}
          />
        )}
      </Panel>

      <Panel className="mb-6" title="Liabilitas" meta={`per ${labelPeriode}`}>
        {n.liabilitas.length === 0 ? (
          <Empty text="Belum ada akun liabilitas bersaldo pada tanggal ini." />
        ) : (
          <TabelKeuangan
            baris={n.liabilitas}
            labelPeriode={labelPeriode}
            labelPembanding={labelPembanding}
            jumlah={{
              label: "Total liabilitas",
              nilai: n.totalLiabilitas,
              pembanding: n.bandingTotalLiabilitas,
            }}
          />
        )}
      </Panel>

      <Panel title="Ekuitas" meta={`per ${labelPeriode}`}>
        <TabelKeuangan
          baris={n.ekuitas}
          labelPeriode={labelPeriode}
          labelPembanding={labelPembanding}
          tambahan={
            <>
              {/*
                Laba tahun-tahun sebelumnya yang belum ditutup ke ekuitas.
                Barisnya hanya muncul bila ada — selama semua jurnal masih
                dalam satu tahun buku, nilainya nol dan menampilkannya hanya
                menambah baris kosong.
              */}
              {(n.labaDitahan !== 0 || n.bandingLabaDitahan !== 0) && (
                <BarisJumlah
                  tebal={false}
                  label={
                    <>
                      Laba ditahan
                      <span className="ml-2 text-xs font-normal text-muted">
                        hasil periode sebelum {tanggal(awalTahun)}, belum ditutup
                        ke akun ekuitas
                      </span>
                    </>
                  }
                  nilai={n.labaDitahan}
                  pembanding={n.bandingLabaDitahan}
                />
              )}
              <BarisJumlah
                tebal={false}
                label={
                  <>
                    Laba periode berjalan
                    <span className="ml-2 text-xs font-normal text-muted">
                      pendapatan − beban, {tanggal(awalTahun)} s.d. {labelPeriode}
                    </span>
                  </>
                }
                nilai={n.labaBerjalan}
                pembanding={n.bandingLabaBerjalan}
              />
            </>
          }
          jumlah={{
            label: "Total ekuitas termasuk laba berjalan",
            nilai: n.totalEkuitasDanLaba,
            pembanding:
              n.bandingTotalEkuitas + n.bandingLabaBerjalan + n.bandingLabaDitahan,
          }}
        />
      </Panel>

    </>
  );
}
