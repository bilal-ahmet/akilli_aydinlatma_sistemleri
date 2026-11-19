"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GatewayView } from "@/app/_lib/types";
import type { LiveEvent } from "@/types/lighting";
import type { BrCommandAction } from "@/lib/binproto/brFields";
import { useLiveStatus } from "@/app/_lib/useLiveStatus";
import { useApi, usePanel } from "@/app/_lib/panel";
import { GATEWAY_COMMAND_LABELS, gatewayCommandErrorText } from "@/lib/gateways";
import { Modal } from "./Modal";

/**
 * Ağ geçidi komutları (Border Router, binary 0x03) — ağ geçidi detayındaki
 * "Bakım" satırı.
 *
 *  - Şimdi raporla (`report_now`): admin + yönetici. Ağ geçidi beklemeden
 *    durum (health) ve Thread topolojisini gönderir.
 *  - Güncelleme kontrolü (`ota_check`): yalnızca admin. Yeni sürüm varsa ağ
 *    geçidi indirip yeniden başlar; bu sırada bağlı armatürlere komut gitmez.
 *
 * `"ok"` yanıtı isteğin KABUL edildiği anlamına gelir. Yanıt, komutun kısa
 * id'siyle sunucuda komuta bağlanır ve SSE'de `gatewayCommand.requestId`
 * olarak gelir.
 */

/** Ağ geçidinden bu kadar sürede yanıt gelmezse "yanıt vermedi" denir. */
const ACK_TIMEOUT_MS = 20_000;

type Phase =
  | { kind: "idle" }
  | { kind: "waiting"; requestId?: string }
  | { kind: "accepted" }
  | { kind: "failed"; message: string };

const IDLE: Record<BrCommandAction, Phase> = {
  report_now: { kind: "idle" },
  ota_check: { kind: "idle" },
};

export function GatewayMaintenance({ gateway }: { gateway: GatewayView }) {
  const gatewayId = gateway.gatewayId;
  const api = useApi();
  const { role, technical } = usePanel();
  const canOta = role === "admin";

  const [phases, setPhases] = useState<Record<BrCommandAction, Phase>>(IDLE);
  const [confirmOta, setConfirmOta] = useState(false);
  const timers = useRef<Map<BrCommandAction, ReturnType<typeof setTimeout>>>(new Map());
  // POST yanıtı dönmeden gelen yanıtlar (MQTT, HTTP'den hızlı olabilir).
  const early = useRef<Map<string, LiveEvent>>(new Map());

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  const setPhase = useCallback((action: BrCommandAction, phase: Phase) => {
    setPhases((p) => ({ ...p, [action]: phase }));
    if (phase.kind !== "waiting") {
      clearTimeout(timers.current.get(action));
      timers.current.delete(action);
    }
  }, []);

  const applyAck = useCallback(
    (action: BrCommandAction, e: LiveEvent) => {
      const c = e.gatewayCommand;
      if (!c) return;
      if (c.status === "ok") setPhase(action, { kind: "accepted" });
      else setPhase(action, { kind: "failed", message: gatewayCommandErrorText(c.result, c.error, technical) });
    },
    [setPhase, technical],
  );

  const onLive = useCallback(
    (e: LiveEvent) => {
      if (e.kind !== "gateway" || e.gatewayId !== gatewayId || !e.gatewayCommand) return;
      const c = e.gatewayCommand;
      const action = (c.action === "ota_check" || c.action === "report_now" ? c.action : null) as
        | BrCommandAction
        | null;
      const candidates: BrCommandAction[] = action ? [action] : ["report_now", "ota_check"];
      for (const a of candidates) {
        const phase = phases[a];
        if (phase.kind !== "waiting") continue;
        if (!phase.requestId) {
          if (c.requestId) early.current.set(c.requestId, e);
          return;
        }
        if (c.requestId && c.requestId !== phase.requestId) continue;
        applyAck(a, e);
        return;
      }
    },
    [gatewayId, phases, applyAck],
  );
  useLiveStatus(onLive);

  async function send(action: BrCommandAction) {
    setPhase(action, { kind: "waiting" });
    try {
      const res = await fetch(api(`/api/gateways/${gatewayId}/command`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setPhase(action, {
          kind: "failed",
          message: j?.error ?? (technical ? `Hata (${res.status})` : "İstek gönderilemedi; yeniden deneyin."),
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
              ? "Gateway 20 sn içinde COMMAND_ACK göndermedi (çevrimdışı ya da /cmd aboneliği yok)."
              : "Ağ geçidinden yanıt alınamadı. Ağ geçidi kapalı ya da internet bağlantısı kopuk olabilir.",
          });
        }, ACK_TIMEOUT_MS),
      );
    } catch {
      setPhase(action, { kind: "failed", message: "İstek gönderilemedi; internet bağlantınızı kontrol edin." });
    }
  }

  const label = (a: BrCommandAction) => GATEWAY_COMMAND_LABELS[a][technical ? "technical" : "plain"];

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">Bakım</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => send("report_now")}
          disabled={phases.report_now.kind === "waiting"}
          className="btn-line h-9 px-4 text-sm"
        >
          {phases.report_now.kind === "waiting" ? "Gönderiliyor…" : label("report_now")}
        </button>
        {canOta ? (
          <button
            type="button"
            onClick={() => setConfirmOta(true)}
            disabled={phases.ota_check.kind === "waiting"}
            className="btn-line h-9 px-4 text-sm"
          >
            {phases.ota_check.kind === "waiting" ? "Gönderiliyor…" : label("ota_check")}
          </button>
        ) : null}
      </div>
      <Result
        phase={phases.report_now}
        accepted={
          technical
            ? "Kabul edildi. Gateway BR_HEALTH + BR_NEIGHBORS/BR_ROUTES gönderiyor; bilgiler birkaç saniye içinde yenilenir."
            : "Ağ geçidi raporunu gönderiyor; bilgiler birkaç saniye içinde yenilenecek."
        }
      />
      <Result
        phase={phases.ota_check}
        accepted="Kontrol başlatıldı. Yeni sürüm varsa ağ geçidi indirip yeniden başlar; firmware sürümü sonraki durum raporunda güncellenir."
      />

      <Modal
        open={confirmOta}
        onClose={() => setConfirmOta(false)}
        title="Ağ geçidi güncelleme kontrolü"
        footer={
          <>
            <button type="button" onClick={() => setConfirmOta(false)} className="btn-line h-10 px-[18px] text-sm">
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
            Yeni sürüm varsa ağ geçidi indirip <strong className="text-text">yeniden başlar</strong>. Bu sırada
            ağ geçidine bağlı armatürlere komut gitmez ve armatürlerden veri gelmez.
          </p>
          <p className="text-muted">Mümkünse armatürlerin yanmadığı saatlerde yapın.</p>
        </div>
      </Modal>
    </div>
  );
}

function Result({ phase, accepted }: { phase: Phase; accepted: string }) {
  if (phase.kind === "accepted") {
    return <p className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">{accepted}</p>;
  }
  if (phase.kind === "failed") {
    return (
      <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
        {phase.message}
      </p>
    );
  }
  return null;
}
