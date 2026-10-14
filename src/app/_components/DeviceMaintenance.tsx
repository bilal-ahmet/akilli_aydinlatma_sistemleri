"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceView } from "@/app/_lib/types";
import type { LiveEvent, MaintenanceAction, OtaStatus } from "@/types/lighting";
import { useLiveStatus } from "@/app/_lib/useLiveStatus";
import { useApi, usePanel } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { formatDuration } from "@/app/_lib/format";
import { describeDeviceError, type DeviceErrorInfo } from "@/lib/deviceErrors";
import { Modal } from "./Modal";

/**
 * Cihaz bakım komutları (firmware 1.0.9+) — cihaz panelinin "Bakım" sekmesi.
 *
 *  - Lambaları tara (`commission`): admin + manager. DALI hattını tarar,
 *    adressiz yeni lambalara kanal verir; ışık seviyesi değişmez. Bulunan
 *    lambalar ~30 sn içinde d4i_periodic raporlarıyla listeye düşer.
 *  - Güncellemeyi kontrol et (`ota_check`): yalnızca admin. Yeni sürüm varsa
 *    cihaz indirip yeniden başlar. İlerleme `/health` mesajından okunur.
 *
 * Cihazın `"ok"` yanıtı işin bittiği değil, isteğin KABUL edildiği anlamına
 * gelir. Yanıt, komutla gönderilen `id` (requestId) ile bu butona bağlanır.
 */

/** Cihazdan bu kadar sürede yanıt gelmezse "yanıt vermedi" denir. */
const ACK_TIMEOUT_MS = 20_000;

type Phase =
  | { kind: "idle" }
  | { kind: "waiting"; requestId?: string }
  | { kind: "accepted" }
  | { kind: "rejected"; info: DeviceErrorInfo }
  | { kind: "failed"; message: string };

const OTA_STATE_LABEL: Record<string, string> = {
  idle: "Beklemede",
  waiting_network: "Ağ bekleniyor",
  checking: "Kontrol ediliyor",
  downloading: "İndiriliyor",
  verifying: "Doğrulanıyor",
  updated: "Güncellendi, yeniden başlıyor",
  failed: "Başarısız",
};

const OTA_RESULT_LABEL: Record<string, string> = {
  up_to_date: "Sürüm güncel",
  updated: "Güncellendi",
  blocked: "Engellendi",
  failed: "Başarısız",
};

function stateTone(state: string | null | undefined): string {
  if (state === "updated" || state === "up_to_date") return "bg-ok-soft text-ok";
  if (state === "failed" || state === "blocked") return "bg-danger-soft text-danger";
  if (state === "checking" || state === "downloading" || state === "verifying") {
    return "bg-accent-soft text-accent";
  }
  return "bg-panel text-muted";
}

type HealthState = {
  firmwareVersion: string | null;
  resetReason: string | null;
  ota: OtaStatus | null;
  healthAt: string | null;
};

export function DeviceMaintenance({
  device,
  onScanAccepted,
}: {
  device: DeviceView;
  /** Tarama kabul edildi — üst bileşen lamba listesini tazelemeye hazırlanır. */
  onScanAccepted: () => void;
}) {
  const deviceId = device.deviceId;
  const api = useApi();
  const { role, technical } = usePanel();
  const canScan = role === "admin" || role === "manager";
  const canOta = role === "admin";

  const [phases, setPhases] = useState<Record<MaintenanceAction, Phase>>({
    commission: { kind: "idle" },
    ota_check: { kind: "idle" },
  });
  const [confirmOta, setConfirmOta] = useState(false);

  const [health, setHealth] = useState<HealthState>({
    firmwareVersion: device.firmwareVersion,
    resetReason: device.resetReason,
    ota: device.ota,
    healthAt: device.healthAt,
  });
  // OTA isteği kabul edildiğinde cihazın sürümü — değişirse güncelleme bitti.
  const [otaFrom, setOtaFrom] = useState<string | null>(null);

  const timers = useRef<Map<MaintenanceAction, ReturnType<typeof setTimeout>>>(new Map());
  // POST yanıtı dönmeden gelen cihaz yanıtları (MQTT, HTTP'den hızlı olabilir).
  const early = useRef<Map<string, LiveEvent>>(new Map());

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  const setPhase = useCallback((action: MaintenanceAction, phase: Phase) => {
    setPhases((p) => ({ ...p, [action]: phase }));
    if (phase.kind !== "waiting") {
      clearTimeout(timers.current.get(action));
      timers.current.delete(action);
    }
  }, []);

  const applyAck = useCallback(
    (action: MaintenanceAction, e: LiveEvent) => {
      if (e.status === "ok") {
        setPhase(action, { kind: "accepted" });
        if (action === "commission") onScanAccepted();
        if (action === "ota_check") setOtaFrom(health.firmwareVersion ?? "");
      } else {
        setPhase(action, {
          kind: "rejected",
          info: describeDeviceError(e.error ?? "", { technical }),
        });
      }
    },
    [setPhase, onScanAccepted, technical, health.firmwareVersion],
  );

  const onLive = useCallback(
    (e: LiveEvent) => {
      if (e.deviceId !== deviceId) return;
      if (e.kind === "health") {
        setHealth((h) => ({
          firmwareVersion: e.firmwareVersion ?? h.firmwareVersion,
          resetReason: h.resetReason,
          ota: e.ota ?? null,
          healthAt: e.at,
        }));
        return;
      }
      if (e.kind !== "maintenance" || !e.maintenanceAction) return;
      const action = e.maintenanceAction;
      const phase = phases[action];
      if (phase.kind !== "waiting") return;
      if (!phase.requestId) {
        // POST henüz dönmedi; id'yi öğrenince eşleştirilecek.
        if (e.requestId) early.current.set(e.requestId, e);
        return;
      }
      // id'siz yanıt (eski davranış) bekleyen isteğe sayılır.
      if (e.requestId && e.requestId !== phase.requestId) return;
      applyAck(action, e);
    },
    [deviceId, phases, applyAck],
  );
  useLiveStatus(onLive);

  async function send(action: MaintenanceAction) {
    setPhase(action, { kind: "waiting" });
    try {
      const res = await fetch(api(`/api/devices/${deviceId}/maintenance`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setPhase(action, {
          kind: "failed",
          message: j?.error ?? (technical ? `Hata (${res.status})` : "İstek gönderilemedi, tekrar deneyin."),
        });
        return;
      }
      const requestId: string | undefined = j?.data?.requestId;
      const buffered = requestId ? early.current.get(requestId) : undefined;
      if (buffered && requestId) {
        early.current.delete(requestId);
        applyAck(action, buffered);
        return;
      }
      setPhase(action, { kind: "waiting", requestId });
      timers.current.set(
        action,
        setTimeout(() => {
          setPhase(action, {
            kind: "failed",
            message: technical
              ? "Cihaz 20 sn içinde yanıt vermedi (çevrimdışı ya da Thread ağı yavaş olabilir)."
              : "Cihaz yanıt vermedi. Cihaz kapalı ya da bağlantısı zayıf olabilir.",
          });
        }, ACK_TIMEOUT_MS),
      );
    } catch {
      setPhase(action, { kind: "failed", message: "İstek gönderilemedi, bağlantınızı kontrol edin." });
    }
  }

  const now = useNow(5000);
  const healthAge =
    health.healthAt && now !== null ? Math.max(0, now - Date.parse(health.healthAt)) : null;
  const updatedTo =
    otaFrom !== null && health.firmwareVersion && health.firmwareVersion !== otaFrom
      ? health.firmwareVersion
      : null;

  return (
    <div className="space-y-4">
      {canScan ? (
        <section className="rounded-xl border border-border bg-panel-2 p-3.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-semibold text-text">Lambaları tara</h3>
              <p className="mt-1 text-sm text-muted">
                {technical
                  ? "DALI commissioning: hattaki lambaları bulur, adressiz yeni lambalara boş kanal (0–4) verir. Mevcut kanallar korunur, ışık seviyesi değişmez."
                  : "Yeni lamba taktıktan sonra kullanın. Cihaz bağlı lambaları bulur ve listeye ekler; ışıklar değişmez."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => send("commission")}
              disabled={phases.commission.kind === "waiting"}
              className="btn-glow h-10 shrink-0 px-4 text-sm"
            >
              {phases.commission.kind === "waiting" ? "Gönderiliyor…" : "Lambaları tara"}
            </button>
          </div>
          <Result
            phase={phases.commission}
            accepted={
              technical
                ? "Tarama başladı. Bulunan her lamba ~30 sn içinde d4i_periodic raporuyla listeye düşer."
                : "Tarama başladı. Bulunan lambalar yaklaşık 30 saniye içinde Kontrol sekmesinde görünecek."
            }
          />
        </section>
      ) : null}

      {canOta ? (
        <section className="rounded-xl border border-border bg-panel-2 p-3.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-semibold text-text">Güncellemeyi kontrol et</h3>
              <p className="mt-1 text-sm text-muted">
                OTA kontrolünü hemen başlatır. Yeni sürüm varsa cihaz indirir, SHA256 ile doğrular ve
                yeniden başlar. Cihaz zaten ~5 dakikada bir kendisi kontrol ediyor; buton beklemeyi
                atlamak içindir.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setConfirmOta(true)}
              disabled={phases.ota_check.kind === "waiting"}
              className="btn-line h-10 shrink-0 px-4 text-sm"
            >
              {phases.ota_check.kind === "waiting" ? "Gönderiliyor…" : "Güncellemeyi kontrol et"}
            </button>
          </div>
          <Result
            phase={phases.ota_check}
            accepted="Kontrol başlatıldı. İlerleme aşağıda, cihazın sağlık mesajlarıyla (~30 sn) güncellenir."
          />
          {updatedTo ? (
            <p className="mt-3 rounded-lg bg-ok-soft px-3 py-2 text-sm font-medium text-ok">
              Güncellendi: {otaFrom || "?"} → {updatedTo}
            </p>
          ) : null}

          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Firmware</dt>
            <dd className="font-mono text-text">{health.firmwareVersion ?? "—"}</dd>

            <dt className="text-muted">OTA durumu</dt>
            <dd>
              {health.ota?.state ? (
                <span
                  className={`rounded-md px-2 py-0.5 text-xs font-semibold ${stateTone(health.ota.state)}`}
                >
                  {OTA_STATE_LABEL[health.ota.state] ?? health.ota.state}
                </span>
              ) : (
                <span className="text-muted">—</span>
              )}
              {health.ota?.state ? (
                <span className="ml-2 font-mono text-xs text-muted">{health.ota.state}</span>
              ) : null}
            </dd>

            <dt className="text-muted">Son sonuç</dt>
            <dd>
              {health.ota?.last_result ? (
                <span
                  className={`rounded-md px-2 py-0.5 text-xs font-semibold ${stateTone(health.ota.last_result)}`}
                >
                  {OTA_RESULT_LABEL[health.ota.last_result] ?? health.ota.last_result}
                </span>
              ) : (
                <span className="text-muted">—</span>
              )}
            </dd>

            {health.ota?.last_target_version ? (
              <>
                <dt className="text-muted">Hedef sürüm</dt>
                <dd className="font-mono text-text">{health.ota.last_target_version}</dd>
              </>
            ) : null}

            {health.ota?.last_message ? (
              <>
                <dt className="text-muted">Mesaj</dt>
                <dd className="font-mono text-xs break-words text-ink-2">{health.ota.last_message}</dd>
              </>
            ) : null}

            {health.resetReason ? (
              <>
                <dt className="text-muted">Son yeniden başlama</dt>
                <dd className="font-mono text-xs text-ink-2">{health.resetReason}</dd>
              </>
            ) : null}

            <dt className="text-muted">Sağlık mesajı</dt>
            <dd className="text-ink-2">
              {health.healthAt === null
                ? "Henüz gelmedi (firmware 1.0.9 öncesi olabilir)"
                : healthAge === null
                  ? "—"
                  : `${formatDuration(healthAge)} önce`}
            </dd>
          </dl>
        </section>
      ) : null}

      {/* OTA onayı: cihaz yeniden başlayabilir. */}
      <Modal
        open={confirmOta}
        onClose={() => setConfirmOta(false)}
        title="Güncelleme kontrolü"
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmOta(false)}
              className="btn-line h-10 px-[18px] text-sm"
            >
              İptal
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmOta(false);
                void send("ota_check");
              }}
              className="btn-glow h-10 px-5 text-sm"
            >
              Kontrolü başlat
            </button>
          </>
        }
      >
        <div className="space-y-2 text-sm leading-relaxed text-ink-2">
          <p>
            Yeni sürüm varsa cihaz indirip <strong className="text-text">yeniden başlar</strong>; bu
            sırada birkaç dakika çevrimdışı görünebilir.
          </p>
          <p className="text-muted">
            Aynı bölgede birden çok cihazı güncellerken aralarda birkaç dakika bırakın: aynı anda
            indiren cihazlar Thread ağını tıkıyor.
          </p>
        </div>
      </Modal>
    </div>
  );
}

function Result({ phase, accepted }: { phase: Phase; accepted: string }) {
  if (phase.kind === "accepted") {
    return <p className="mt-3 rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">{accepted}</p>;
  }
  if (phase.kind === "rejected") {
    return (
      <div className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
        <p className="font-semibold">{phase.info.title}</p>
        <p className="mt-0.5">{phase.info.cause}</p>
        {phase.info.hint ? <p className="mt-1 text-muted">{phase.info.hint}</p> : null}
      </div>
    );
  }
  if (phase.kind === "failed") {
    return (
      <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
        {phase.message}
      </p>
    );
  }
  return null;
}
