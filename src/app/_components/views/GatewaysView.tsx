"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { GatewayView } from "@/app/_lib/types";
import type { LiveEvent } from "@/types/lighting";
import { useLighting } from "@/app/_lib/lighting";
import { useApi, usePanel } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { useReconcile } from "@/app/_lib/useReconcile";
import { useLiveStatus } from "@/app/_lib/useLiveStatus";
import { formatAgo, type HealthTone } from "@/app/_lib/deviceHealth";
import { deviceName, formatDateTime } from "@/app/_lib/format";
import { gatewayState, type GatewayState } from "@/lib/gateways";
import { formatMac } from "@/lib/mac";
import { ConfirmDelete } from "../PanelDialogs";
import { GatewayDialog } from "../GatewayForm";
import { EmptyBox, PageHeader, PlusIcon, StatusLabel } from "../PanelUi";

const STATE_LABEL: Record<GatewayState, { label: string; tone: HealthTone }> = {
  online: { label: "Çalışıyor", tone: "ok" },
  offline: { label: "Bağlantı yok", tone: "bad" },
  never: { label: "Hiç bağlanmadı", tone: "idle" },
};

/** Gateway görünen adı: girilmiş isim, yoksa kimliğin son 4 hanesi. */
function gatewayLabel(g: GatewayView): string {
  return g.name?.trim() || `…${g.gatewayId.slice(-4)}`;
}

/** Canlı olaydan sonra alanları (türe özgü bilgi, bağlı cihaz) tazelemek için bekleme. */
const RELOAD_DELAY_MS = 2_000;

type Dialog = { kind: "form"; gateway?: GatewayView } | { kind: "delete"; gateway: GatewayView };

/**
 * Ağ geçitleri sayfası. Liste bu sayfaya özeldir (LightingProvider'a girmez):
 * gateway durumu SSE `kind:"gateway"` olaylarıyla anında, türe özgü alanlar
 * kısa bir gecikmeyle DB'den yeniden okunarak güncellenir.
 */
export function GatewaysView() {
  const api = useApi();
  const { canWrite, technical } = usePanel();
  const { devices } = useLighting();
  const now = useNow(15_000);
  const [gateways, setGateways] = useState<GatewayView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<(Dialog & { seq: number }) | null>(null);
  const seq = useRef(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    fetch(api("/api/gateways"))
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j?.data)) {
          setGateways(j.data as GatewayView[]);
          setLoadError(null);
        } else {
          setLoadError(j?.error ?? "Ağ geçitleri okunamadı");
        }
      })
      .catch(() => setLoadError("Ağ geçitleri okunamadı"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);
  useReconcile(load);

  useEffect(() => {
    const timer = reloadTimer;
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const onLive = useCallback(
    (e: LiveEvent) => {
      if (e.kind !== "gateway" || !e.gatewayId) return;
      setGateways((gs) =>
        gs.map((g) =>
          g.gatewayId === e.gatewayId
            ? {
                ...g,
                online: e.online ?? true,
                // LWT son görülmeyi ilerletmez.
                lastSeen: e.online === false ? g.lastSeen : e.at,
                firmwareVersion: e.firmwareVersion ?? g.firmwareVersion,
              }
            : g,
        ),
      );
      if (!reloadTimer.current) {
        reloadTimer.current = setTimeout(() => {
          reloadTimer.current = null;
          load();
        }, RELOAD_DELAY_MS);
      }
    },
    [load],
  );
  useLiveStatus(onLive);

  const open = (d: Dialog) => setDialog({ ...d, seq: ++seq.current });

  const states = gateways.map((g) => gatewayState(g, now));
  const onlineCount = states.filter((s) => s === "online").length;
  const subtitle =
    gateways.length === 0
      ? "Henüz ağ geçidi yok"
      : `${gateways.length} ağ geçidi` + (now === null ? "" : ` · ${onlineCount} çalışıyor`);

  const th = "px-3 py-3 text-left font-semibold first:pl-[22px] last:pr-[22px]";
  const td = "px-3 py-[14px] align-middle first:pl-[22px] last:pr-[22px]";
  const cols = 6;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Ağ geçitleri"
        subtitle={subtitle}
        actions={
          canWrite ? (
            <button
              type="button"
              onClick={() => open({ kind: "form" })}
              className="btn-glow h-[38px] px-4 text-sm"
            >
              <PlusIcon />
              Yeni ağ geçidi
            </button>
          ) : null
        }
      />

      {loadError ? (
        <p className="rounded-[10px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{loadError}</p>
      ) : null}

      {loading ? (
        <EmptyBox>Yükleniyor…</EmptyBox>
      ) : gateways.length === 0 ? (
        <EmptyBox>
          Henüz ağ geçidi yok.
          {canWrite
            ? technical
              ? " Sahadaki gateway'i “Yeni ağ geçidi” ile GW_ID ve türüyle tanımlayın. Yayın yapan kayıtsız gateway'ler yönetim ekranındaki “Keşfedilen ağ geçitleri” listesinde görünür."
              : " Cihazların bağlandığı ağ geçidini “Yeni ağ geçidi” ile kodu ve türüyle tanımlayın."
            : ""}
        </EmptyBox>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-panel">
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead className="table-head">
                <tr>
                  <th className={th}>Ağ geçidi</th>
                  <th className={th}>{technical ? "GW_ID" : "Kod"}</th>
                  <th className={th}>Tür</th>
                  <th className={th}>Durum</th>
                  <th className={th}>Bağlı cihaz</th>
                  <th className={th}>Son haber</th>
                </tr>
              </thead>
              <tbody>
                {gateways.map((g, i) => {
                  const s = states[i];
                  const st = s ? STATE_LABEL[s] : { label: "…", tone: "idle" as const };
                  const expanded = openId === g.id;
                  const place = [g.zoneName, g.location].filter(Boolean).join(" · ");
                  return (
                    <Fragment key={g.id}>
                      <tr
                        onClick={() => setOpenId(expanded ? null : g.id)}
                        aria-expanded={expanded}
                        className="cursor-pointer border-t border-border transition-colors hover:bg-panel-2/60"
                      >
                        <td className={td}>
                          <span className="flex flex-col items-start gap-0.5">
                            <span className="font-semibold text-text">{gatewayLabel(g)}</span>
                            {place ? <span className="text-xs text-muted">{place}</span> : null}
                          </span>
                        </td>
                        <td className={`${td} font-mono text-[13px] text-ink-2`}>
                          {formatMac(g.gatewayId)}
                        </td>
                        <td className={`${td} text-ink-2`}>{g.typeLabel}</td>
                        <td className={td}>
                          <StatusLabel tone={st.tone} label={st.label} />
                        </td>
                        <td className={`${td} font-mono text-[13px] text-ink-2`}>{g.deviceCount}</td>
                        <td className={`${td} text-[13px] text-muted`}>{formatAgo(g.lastSeen, now)}</td>
                      </tr>
                      {expanded ? (
                        <tr className="border-t border-border bg-panel-2/40">
                          <td colSpan={cols} className="px-[22px] py-4">
                            <GatewayDetail
                              gateway={g}
                              devices={devices.filter((d) => d.gatewayId === g.gatewayId)}
                              technical={technical}
                              canWrite={canWrite}
                              onEdit={() => open({ kind: "form", gateway: g })}
                              onDelete={() => open({ kind: "delete", gateway: g })}
                            />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {dialog?.kind === "form" ? (
        <GatewayDialog
          key={dialog.seq}
          gateway={dialog.gateway}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setGateways((gs) =>
              gs.some((g) => g.id === saved.id)
                ? gs.map((g) => (g.id === saved.id ? saved : g))
                : [...gs, saved],
            );
            setOpenId(saved.id);
          }}
        />
      ) : null}

      {dialog?.kind === "delete" ? (
        <ConfirmDelete
          key={dialog.seq}
          title="Ağ geçidini sil"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const res = await fetch(api(`/api/gateways/${dialog.gateway.gatewayId}`), {
              method: "DELETE",
            });
            if (!res.ok) {
              const j = await res.json().catch(() => null);
              throw new Error(j?.error ?? "Ağ geçidi silinemedi");
            }
            setGateways((gs) => gs.filter((g) => g.id !== dialog.gateway.id));
          }}
        >
          <p>
            <span className="font-semibold text-text">{gatewayLabel(dialog.gateway)}</span>{" "}
            ağ geçidinin kaydı silinecek. Cihazlar ve lambalar etkilenmez.
          </p>
          {technical ? (
            <p className="mt-2 text-[13px] text-muted">
              Gateway sahada yayın yapmaya devam ederse yönetim ekranındaki “Keşfedilen ağ
              geçitleri” listesine düşer.
            </p>
          ) : null}
        </ConfirmDelete>
      ) : null}
    </div>
  );
}

function GatewayDetail({
  gateway: g,
  devices,
  technical,
  canWrite,
  onEdit,
  onDelete,
}: {
  gateway: GatewayView;
  devices: { id: string; name: string | null; deviceId: string }[];
  technical: boolean;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {g.fields.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          {g.fields.map((f) => (
            <div key={f.label} className="min-w-0">
              <dt className="text-xs text-muted">{f.label}</dt>
              <dd className="truncate font-mono text-[13px] text-text" title={f.value}>
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-[13px] text-muted">
          {g.lastSeen
            ? "Ağ geçidi henüz ayrıntılı bilgi göndermedi."
            : technical
              ? "Gateway henüz yayın yapmadı. MQTT'de Meven:<GW_ID>/health mesajı bekleniyor."
              : "Ağ geçidinden henüz haber alınmadı."}
        </p>
      )}

      <div>
        <p className="text-xs text-muted">Bağlı cihazlar</p>
        {devices.length > 0 ? (
          <p className="mt-1 text-[13px] text-text">
            {devices.map((d) => deviceName(d, technical)).join(", ")}
          </p>
        ) : (
          <p className="mt-1 text-[13px] text-muted">
            {technical
              ? "Eşleşme yok: gateway `nodes` listesi göndermiyor ya da cihazlar health'te `gateway` bildirmiyor."
              : "Bu ağ geçidine bağlı cihaz bilgisi henüz yok."}
          </p>
        )}
      </div>

      {g.notes ? (
        <div>
          <p className="text-xs text-muted">Not</p>
          <p className="mt-1 whitespace-pre-line text-[13px] text-text">{g.notes}</p>
        </div>
      ) : null}

      {technical && g.raw ? (
        <details className="rounded-[10px] border border-border bg-panel px-3 py-2">
          <summary className="cursor-pointer text-[13px] font-medium text-ink-2">Teknik detay</summary>
          <div className="mt-2 grid gap-3 lg:grid-cols-2">
            <RawBlock title="Son health" at={g.raw.healthAt} value={g.raw.health} />
            <RawBlock title="Son data" at={g.raw.reportAt} value={g.raw.report} />
          </div>
        </details>
      ) : null}

      {canWrite ? (
        <div className="flex gap-2">
          <button type="button" onClick={onEdit} className="btn-line h-9 px-4 text-sm">
            Düzenle
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-9 items-center rounded-[10px] px-4 text-sm font-medium text-danger transition-colors hover:bg-danger-soft"
          >
            Sil
          </button>
        </div>
      ) : null}
    </div>
  );
}

function RawBlock({
  title,
  at,
  value,
}: {
  title: string;
  at: string | null;
  value: Record<string, unknown> | null;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">
        {title}
        {at ? ` · ${formatDateTime(at)}` : ""}
      </p>
      <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-panel-2 p-2 font-mono text-[11.5px] leading-snug text-ink-2">
        {value ? JSON.stringify(value, null, 2) : "—"}
      </pre>
    </div>
  );
}
