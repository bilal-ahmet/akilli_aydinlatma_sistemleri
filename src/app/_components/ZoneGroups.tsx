"use client";

import { useState } from "react";
import type { DeviceView, Zone, ZoneGroupView } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel, useTechnical } from "@/app/_lib/panel";
import { planTargets, type Selection } from "@/app/_lib/selection";
import { Modal } from "./Modal";

/**
 * Alt gruplar: bölgenin cihazlarından oluşan gruplar (slug `<bölge>-<ad>`).
 * Grup komutu sunucuda her üyenin `Meven:<MAC>/cmd`'sine ayrı gider
 * (lib/mqtt.ts publishCommand "group"); cihaz grup topic'ini dinlemez.
 * Üyelik ayrıca cihazın NVS listesine zone_add / zone_remove ile yazılır
 * (dinamik bölge aboneliği, lib/zoneSync) ve cihaz satırında "Bölge bilgisi
 * gönderiliyor" görünür; komutun ulaşması buna bağlı değildir.
 */

const btnSm =
  "inline-flex h-8 cursor-pointer items-center justify-center rounded-[9px] border border-border px-2.5 text-[12.5px] font-medium text-text transition-colors hover:border-border-strong hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50";

function syncText(g: ZoneGroupView, technical: boolean): { text: string; warn: boolean } {
  const total = g.members.length;
  if (total === 0) return { text: "Cihaz yok", warn: false };
  if (g.synced === total) {
    return { text: technical ? "Tüm üyelerde senkron" : "Tüm cihazlarda uygulandı", warn: false };
  }
  return {
    text: technical ? `${g.synced}/${total} üyede senkron` : `${g.synced}/${total} cihazda uygulandı`,
    warn: true,
  };
}

/** Bölge detayındaki "Alt gruplar" kartı. */
export function ZoneGroupsCard({
  zone,
  devices,
  onSelect,
}: {
  zone: Zone;
  devices: DeviceView[];
  /** "Seç": üyeleri cihaz tablosunda seçili yapar (Şiddet/Efekt/Zamanla oradan). */
  onSelect: (sel: Selection) => void;
}) {
  const { groups, zones, createGroup, renameGroup, deleteGroup, setTargetsPower } = useLighting();
  const { canWrite } = usePanel();
  const technical = useTechnical();
  const zoneGroups = groups.filter((g) => g.zoneSlug === zone.id);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ slug: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<ZoneGroupView | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "İşlem başarısız");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function membersSel(g: ZoneGroupView): Selection {
    return new Map(devices.filter((d) => g.members.includes(d.deviceId)).map((d) => [d.deviceId, null]));
  }

  function power(g: ZoneGroupView, on: boolean) {
    // Plan: bütün üyeler grubu uygulamışsa tek grup komutu, değilse cihaz komutları.
    setTargetsPower(planTargets(membersSel(g), devices, zones, undefined, { groups: "any" }), on);
  }

  if (!canWrite && zoneGroups.length === 0) return null;

  return (
    <section aria-label="Alt gruplar" className="flex flex-col overflow-hidden rounded-2xl border border-border bg-panel">
      <div className="flex flex-col gap-0.5 px-[22px] py-[18px]">
        <h2 className="text-base font-semibold text-text">Alt gruplar</h2>
        <p className="text-[12.5px] text-muted">
          {technical
            ? "Bölgenin cihazlarından gruplar. Grup komutu her üyenin Meven:<MAC>/cmd'sine ayrı gider. Üyelik ayrıca cihaz NVS'ine zone_add / zone_remove olarak yazılır (senkron durumu komutun ulaşmasını etkilemez)."
            : "Bölgedeki cihazları hat ya da sokak gibi gruplara ayırın; grup tek komutla yönetilir. Cihaz eklemek için tablodan seçip alttaki “Alt grup” düğmesini kullanın."}
        </p>
      </div>

      {zoneGroups.length > 0 ? (
        <ul className="border-t border-border">
          {zoneGroups.map((g) => {
            const st = syncText(g, technical);
            return (
              <li
                key={g.slug}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-[22px] py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-text">{g.name}</span>
                  <span className="text-[12.5px] text-muted">
                    {g.members.length} cihaz ·{" "}
                    <span className={st.warn ? "text-warn" : undefined}>{st.text}</span>
                    {technical ? <span className="ml-1 font-mono text-[11.5px]">· Meven:{g.slug}/cmd</span> : null}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {canWrite && g.members.length > 0 ? (
                    <>
                      <button type="button" className={btnSm} onClick={() => power(g, true)}>
                        Aç
                      </button>
                      <button type="button" className={btnSm} onClick={() => power(g, false)}>
                        Kapat
                      </button>
                      <button
                        type="button"
                        className={btnSm}
                        title="Üyeleri tabloda seç (şiddet, efekt, zamanlama)"
                        onClick={() => onSelect(membersSel(g))}
                      >
                        Seç
                      </button>
                    </>
                  ) : null}
                  {canWrite ? (
                    <>
                      <button type="button" className={btnSm} onClick={() => setEditing({ slug: g.slug, name: g.name })}>
                        Adı
                      </button>
                      <button
                        type="button"
                        className={`${btnSm} text-danger`}
                        onClick={() => setRemoving(g)}
                      >
                        Sil
                      </button>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {canWrite ? (
        <form
          className="flex flex-wrap items-center gap-2 border-t border-border px-[22px] py-3"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newName.trim();
            if (!name) return;
            void run(() => createGroup(zone.id, name)).then((ok) => ok && setNewName(""));
          }}
        >
          <input
            className="field h-9 min-w-[180px] flex-1"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Yeni alt grup adı (örn. Hat A)"
            maxLength={100}
            aria-label="Yeni alt grup adı"
          />
          <button type="submit" disabled={busy || !newName.trim()} className="btn-line h-9 px-3.5 text-[13px]">
            + Alt grup oluştur
          </button>
        </form>
      ) : null}
      {error ? <p className="px-[22px] pb-3 text-[12.5px] text-danger">{error}</p> : null}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Alt grubun adı"
        onSubmit={(e) => {
          e.preventDefault();
          if (!editing?.name.trim()) return;
          void run(() => renameGroup(zone.id, editing.slug, editing.name.trim())).then((ok) => ok && setEditing(null));
        }}
        footer={
          <>
            <button type="button" onClick={() => setEditing(null)} className="btn-line h-10 px-[18px] text-sm">
              İptal
            </button>
            <button type="submit" disabled={busy || !editing?.name.trim()} className="btn-glow h-10 px-5 text-sm">
              Kaydet
            </button>
          </>
        }
      >
        <input
          className="field"
          value={editing?.name ?? ""}
          onChange={(e) => setEditing((cur) => (cur ? { ...cur, name: e.target.value } : cur))}
          maxLength={100}
          autoFocus
          aria-label="Alt grup adı"
        />
        <p className="mt-2 text-[12.5px] text-muted">
          {technical ? "Slug (topic) değişmez; cihazlar onu kendi belleğinde tutar." : "Ad değişikliği cihazlara gönderilmez."}
        </p>
      </Modal>

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`“${removing?.name ?? ""}” silinsin mi?`}
        footer={
          <>
            <button type="button" onClick={() => setRemoving(null)} className="btn-line h-10 px-[18px] text-sm">
              Vazgeç
            </button>
            <button
              type="button"
              disabled={busy}
              className="btn-glow h-10 px-5 text-sm"
              onClick={() => {
                if (!removing) return;
                void run(() => deleteGroup(zone.id, removing.slug)).then((ok) => ok && setRemoving(null));
              }}
            >
              Sil
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-2">
          {technical
            ? `Üyelere (${removing?.members.length ?? 0}) zone_remove gönderilir; çevrimdışı olanlar bağlandığında alır. Slug emekliye ayrılır, bir daha verilmez.`
            : `Gruptaki ${removing?.members.length ?? 0} cihaz bu gruptan çıkarılır; bağlantısı olmayan cihazlar bağlandığında güncellenir. Cihazlar bölgede kalır.`}
        </p>
      </Modal>
    </section>
  );
}

/**
 * Seçili cihazları bir alt gruba ekle / çıkar (bölge detayındaki seçim
 * çubuğundan açılır). Alt grup cihaz bazındadır: armatür seçimi cihaza yükselir.
 */
export function GroupMembershipDialog({
  open,
  onClose,
  zoneId,
  macs,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  zoneId: string;
  macs: string[];
  onDone: (text: string) => void;
}) {
  const { groups, createGroup, setGroupMembers } = useLighting();
  const technical = useTechnical();
  const zoneGroups = groups.filter((g) => g.zoneSlug === zoneId);
  const [slug, setSlug] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seçili grup bu arada silinmişse (state'te eski slug kalır) ilk gruba düş;
  // yoksa "Gruba ekle" sessizce hiçbir şey yapmazdı.
  const chosen =
    slug === "__new__" || zoneGroups.some((g) => g.slug === slug) ? slug : zoneGroups[0]?.slug || "";
  const creating = chosen === "" || slug === "__new__";
  const group = zoneGroups.find((g) => g.slug === chosen);
  const inGroup = group ? macs.filter((m) => group.members.includes(m)).length : 0;

  async function apply(mode: "add" | "remove") {
    setBusy(true);
    setError(null);
    try {
      let target = group;
      if (creating) {
        const name = newName.trim();
        if (!name) throw new Error("Alt grup adı girin");
        target = await createGroup(zoneId, name);
      }
      if (!target) return;
      await setGroupMembers(zoneId, target.slug, mode === "add" ? { add: macs } : { remove: macs });
      onDone(
        mode === "add"
          ? `${macs.length} cihaz “${target.name}” grubuna eklendi; bilgi cihazlara gönderiliyor.`
          : `${macs.length} cihaz “${target.name}” grubundan çıkarıldı; bilgi cihazlara gönderiliyor.`,
      );
      setNewName("");
      setSlug("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "İşlem başarısız");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Alt grup"
      subtitle={`${macs.length} cihaz seçili`}
      footer={
        <>
          {!creating ? (
            <button
              type="button"
              disabled={busy || inGroup === 0}
              onClick={() => void apply("remove")}
              className="btn-line h-10 px-[18px] text-sm"
            >
              Gruptan çıkar
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={() => void apply("add")} className="btn-glow h-10 px-5 text-sm">
            {creating ? "Oluştur ve ekle" : "Gruba ekle"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Alt grup
          <select className="field" value={creating ? "__new__" : chosen} onChange={(e) => setSlug(e.target.value)}>
            {zoneGroups.map((g) => (
              <option key={g.slug} value={g.slug}>
                {g.name} ({g.members.length} cihaz)
              </option>
            ))}
            <option value="__new__">+ Yeni alt grup…</option>
          </select>
        </label>
        {creating ? (
          <input
            className="field"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Yeni alt grup adı (örn. Hat A)"
            maxLength={100}
            autoFocus
            aria-label="Yeni alt grup adı"
          />
        ) : (
          <p className="text-[12.5px] text-muted">
            Seçili cihazlardan {inGroup} tanesi bu grupta.{" "}
            {technical
              ? "Her cihaza ayrı zone_add / zone_remove gider (Meven:<MAC>/cmd)."
              : "Bilgi her cihaza ayrı gönderilir; bağlantısı olmayanlar bağlandığında alır."}
          </p>
        )}
        {error ? <p className="text-[12.5px] text-danger">{error}</p> : null}
      </div>
    </Modal>
  );
}
