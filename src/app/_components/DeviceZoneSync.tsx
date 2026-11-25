"use client";

import { useCallback, useEffect, useState } from "react";
import type { DeviceView } from "@/app/_lib/types";
import type { LiveEvent } from "@/types/lighting";
import { useLighting } from "@/app/_lib/lighting";
import { useLiveStatus } from "@/app/_lib/useLiveStatus";
import { useApi, usePanel } from "@/app/_lib/panel";
import { describeDeviceError } from "@/lib/deviceErrors";
import type { ZoneSyncStatus, ZoneSyncView } from "@/lib/zoneSync/plan";

/**
 * Cihaz panelinin Bakım sekmesinde "Bölge listesi": cihaza bölge ve alt grup
 * bilgisinin uygulanıp uygulanmadığı (dinamik bölge aboneliği, lib/zoneSync)
 * ve "Şimdi doğrula" (zone_list + fark). Admin cihazın bildirdiği ham topic
 * listesini de görür. Durum SSE `kind:"zone_sync"` ile tazelenir.
 */

const STATUS_TEXT: Record<ZoneSyncStatus, { plain: string; technical: string; tone: string }> = {
  synced: { plain: "Uygulandı", technical: "Senkron", tone: "bg-ok-soft text-ok" },
  pending: { plain: "Gönderiliyor", technical: "Gönderiliyor (pending)", tone: "bg-accent-soft text-accent" },
  no_response: {
    plain: "Cihaz bağlandığında uygulanacak",
    technical: "Yanıtsız — HELLO'da sürecek",
    tone: "bg-accent-soft text-accent",
  },
  error: { plain: "Uygulanamadı", technical: "Hata", tone: "bg-danger/10 text-danger" },
  unsupported: {
    plain: "Cihaz yazılımı desteklemiyor",
    technical: "Firmware zone komutlarını tanımıyor (unsupported)",
    tone: "bg-panel text-muted",
  },
  unknown: { plain: "Henüz doğrulanmadı", technical: "Bilinmiyor (unknown)", tone: "bg-panel text-muted" },
};

export function DeviceZoneSync({ device }: { device: DeviceView }) {
  const api = useApi();
  const { technical } = usePanel();
  const { groups } = useLighting();
  const deviceId = device.deviceId;
  const [view, setView] = useState<ZoneSyncView | null>(device.zoneSync);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(api(`/api/devices/${deviceId}/zone-sync`))
      .then((r) => r.json())
      .then((j) => {
        if (j?.data) setView(j.data as ZoneSyncView);
      })
      .catch(() => {});
  }, [api, deviceId]);

  useEffect(() => {
    load();
  }, [load]);

  useLiveStatus(
    useCallback(
      (e: LiveEvent) => {
        if (e.kind === "zone_sync" && e.deviceId === deviceId) load();
      },
      [deviceId, load],
    ),
  );

  async function verify() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(api(`/api/devices/${deviceId}/zone-sync`), { method: "POST" });
      const j = await res.json().catch(() => null);
      if (!res.ok) setMessage(j?.error ?? "Doğrulama başlatılamadı");
      else {
        if (j?.data) setView(j.data as ZoneSyncView);
        setMessage(technical ? "zone_list gönderildi; sonuç birkaç saniye içinde." : "Cihazdan bilgi isteniyor…");
      }
    } finally {
      setBusy(false);
    }
  }

  const status = view?.status ?? "unknown";
  const label = STATUS_TEXT[status];
  const groupNames = device.groups.map((slug) => groups.find((g) => g.slug === slug)?.name ?? slug);
  const err = status === "error" && view?.error ? describeDeviceError(view.error, { technical }) : null;

  return (
    <section className="rounded-xl border border-border bg-panel-2 p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-text">Bölge bilgisi</h3>
          <p className="mt-1 text-sm text-muted">
            {technical
              ? "Cihazın NVS'indeki bölge + alt grup listesi. Panelden yönetilir; değişiklikler Meven:<MAC>/cmd ile zone_add / zone_remove olarak gider. Doğrula: zone_list. Komutlar bu listeye bağlı değildir (cihaz başına MAC topic'ine gider)."
              : "Cihazın bölge ve alt grup bilgisi panelden gönderilir. Doğrula, cihazdaki kaydı okuyup gerekirse düzeltir."}
          </p>
        </div>
        <button type="button" onClick={verify} disabled={busy} className="btn-line h-10 shrink-0 px-4 text-sm">
          {busy ? "Gönderiliyor…" : "Şimdi doğrula"}
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">Durum</dt>
        <dd>
          <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${label.tone}`}>
            {technical ? label.technical : label.plain}
          </span>
        </dd>

        <dt className="text-muted">Bölge</dt>
        <dd className="text-text">
          {device.zoneName ?? "—"}
          {technical && device.zoneSlug ? <span className="ml-2 font-mono text-xs text-muted">{device.zoneSlug}</span> : null}
        </dd>

        <dt className="text-muted">Alt gruplar</dt>
        <dd className="text-text">{groupNames.length ? groupNames.join(", ") : "—"}</dd>

        {technical ? (
          <>
            <dt className="text-muted">İstenen</dt>
            <dd className="font-mono text-xs text-text">{view?.desired?.join(", ") || "∅"}</dd>
            <dt className="text-muted">Cihazdaki</dt>
            <dd className="font-mono text-xs text-text">
              {view?.reported === undefined || view?.reported === null ? "bilinmiyor" : view.reported.join(", ") || "∅"}
            </dd>
          </>
        ) : null}
      </dl>

      {err ? (
        <div className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          <p className="font-semibold">{err.title}</p>
          <p className="mt-0.5">{err.cause}</p>
        </div>
      ) : null}
      {message ? <p className="mt-3 text-[12.5px] text-muted">{message}</p> : null}
    </section>
  );
}
