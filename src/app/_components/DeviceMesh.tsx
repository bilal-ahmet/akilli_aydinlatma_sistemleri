"use client";

import { useEffect, useState } from "react";
import type { DeviceMeshView } from "@/lib/mesh/view";
import { MESH_COLORS } from "@/app/_lib/meshOverlay";
import { useTheme } from "./ThemeProvider";
import { LineChart, LqMeter, NodeTag, Row, SecHead, TONE_TEXT, Tag, fmt, linkTone, lqText, rlocText } from "./mesh/meshUi";

/**
 * Cihaz modalı "Ağ" sekmesi (YALNIZCA ADMIN): Thread rolü, mesh rotası
 * (0xCE next hop, 0xCF yol maliyeti), BR'ye giden yol, parent link alanları,
 * komşular ve son 24 saatin parent RSSI / yol maliyeti grafikleri.
 * Kaynak: `GET /api/devices/:mac/mesh`.
 */
export function DeviceMesh({ deviceId }: { deviceId: string }) {
  const { resolved } = useTheme();
  const palette = resolved === "dark" ? MESH_COLORS.dark : MESH_COLORS.light;
  const [state, setState] = useState<{ key: string; data: DeviceMeshView | null; error: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/devices/${deviceId}/mesh`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j?.ok) setState({ key: deviceId, data: j.data as DeviceMeshView, error: null });
        else setState({ key: deviceId, data: null, error: j?.error ?? "Ağ bilgisi okunamadı" });
      })
      .catch(() => alive && setState({ key: deviceId, data: null, error: "Ağ bilgisi okunamadı" }));
    return () => {
      alive = false;
    };
  }, [deviceId]);

  if (!state || state.key !== deviceId) return <p className="py-6 text-center text-[13px] text-muted">Yükleniyor…</p>;
  if (state.error || !state.data) {
    return <p className="rounded-[10px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>;
  }
  const { node: n, path, neighbors, routeSupported, series } = state.data;
  if (!n) return <p className="py-6 text-center text-[13px] text-muted">Bu cihaz için Thread bilgisi yok.</p>;
  const parent = path[1];
  const link = n.link;

  return (
    <div className="flex flex-col gap-4">
      {!routeSupported ? (
        <p className="rounded-[10px] bg-panel-2 px-3 py-2 text-[12.5px] text-muted">
          Bu firmware sürümü rota bilgisi (0xCE next hop / 0xCF yol maliyeti) göndermiyor; yol ve yük hesaplanamaz.
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-xl border border-border p-3.5">
          <SecHead note="Thread">Ağ</SecHead>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {n.role ? <Tag tone="muted">{n.role === "router" ? "Router" : "Child"}</Tag> : null}
            <NodeTag node={n} />
          </div>
          <div className="grid gap-[7px]">
            <Row label="RLOC16" src="0xC6">
              {rlocText(n.rloc16)}
            </Row>
            <Row label="Next hop" src="0xCE">
              {parent ? `${parent.kind === "br" ? "Border Router" : parent.label} · ${rlocText(parent.rloc16)}` : rlocText(n.nextHop)}
            </Row>
            <Row label="Yol maliyeti" src="0xCF">
              {n.pathCost ?? "—"}
              {n.hops !== null ? ` · ${n.hops} hop` : ""}
            </Row>
            <Row label="Link maliyeti">
              <span className={TONE_TEXT[linkTone(n.linkCost)]}>{n.linkCost !== null ? `+${n.linkCost}` : "—"}</span>
            </Row>
            <Row label="Next hop'a mesafe">{n.distanceM !== null ? `${n.distanceM} m` : "—"}</Row>
            <Row label="Taşıdığı direk">{n.load}</Row>
            <Row label="BR'ye giden (tahmini)">{`${fmt(n.upPpm)} paket/dk`}</Row>
          </div>
          {path.length > 1 ? (
            <div className="mt-3 flex flex-wrap items-center gap-1 text-[12px] text-muted">
              BR&apos;ye yol
              {path.map((p, i) => (
                <span key={p.id} className="flex items-center gap-1">
                  {i ? <span>→</span> : null}
                  <span
                    className={`rounded-md border px-[7px] py-0.5 ${
                      i === 0 ? "border-accent bg-accent-soft font-semibold text-accent" : "border-border bg-panel-2 text-text"
                    }`}
                  >
                    {p.kind === "br" ? "BR" : p.label}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
        </section>

        <section className="rounded-xl border border-border p-3.5">
          <SecHead note="health alanları">Parent link</SecHead>
          {link ? (
            <div className="grid gap-[7px]">
              <Row label="Parent RSSI ort." src="0xC2" warn={link.rssiAvg !== null && link.rssiAvg < -75}>
                {link.rssiAvg !== null ? `${link.rssiAvg} dBm` : "—"}
              </Row>
              <Row label="Parent RSSI son" src="0xC3">
                {link.rssiLast !== null ? `${link.rssiLast} dBm` : "—"}
              </Row>
              <Row label="RSSI ort. · 24 sa">{link.rssiAvg24h !== null ? `${Math.round(link.rssiAvg24h)} dBm` : "—"}</Row>
              <Row label="Link margin" src="0xD4">
                {link.linkMargin !== null ? `${link.linkMargin} dB` : "—"}
              </Row>
              <Row label="Link kalitesi giriş" src="0xC4">
                <LqMeter value={link.lqIn} />
                {lqText(link.lqIn)}
              </Row>
              <Row label="Link kalitesi çıkış" src="0xC5">
                <LqMeter value={link.lqOut} />
                {lqText(link.lqOut)}
              </Row>
              {link.frameErrorPct !== null ? (
                <Row label="Çerçeve hata oranı" src="BR" warn={link.frameErrorPct > 4}>
                  %{fmt(link.frameErrorPct)}
                </Row>
              ) : null}
              <Row label="Parent değişimi · 24 sa" src="0xCB" warn={(link.parentChanges24h ?? 0) >= 3}>
                {link.parentChanges24h ?? "—"}
              </Row>
            </div>
          ) : (
            <p className="text-[12.5px] text-muted">—</p>
          )}
        </section>

        <section className="rounded-xl border border-border p-3.5">
          <SecHead note="dBm · saatlik ort.">Parent RSSI</SecHead>
          <LineChart values={series.rssiAvg} color={n.weak ? palette.bad : palette.accent} label="Parent RSSI" />
        </section>
        <section className="rounded-xl border border-border p-3.5">
          <SecHead note="saatlik ort.">Yol maliyeti</SecHead>
          <LineChart values={series.pathCost} color={palette.hot} label="Yol maliyeti" floor={0} />
        </section>
      </div>

      <section className="rounded-xl border border-border p-3.5">
        <SecHead note="0xD0…">Komşular</SecHead>
        {neighbors.length ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.06em] text-muted">
                  {["Direk", "RLOC16", "Rol", "RSSI", "Link margin", "LQ"].map((h) => (
                    <th key={h} className="whitespace-nowrap border-b border-border px-2 py-1.5 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {neighbors.map((x, i) => (
                  <tr key={`${x.rloc16}:${i}`} className="[&:last-child>td]:border-b-0">
                    <td className="whitespace-nowrap border-b border-border px-2 py-1.5">
                      <b>{x.label ?? "—"}</b> {x.isNextHop ? <Tag tone="muted">next hop</Tag> : null}
                    </td>
                    <td className="whitespace-nowrap border-b border-border px-2 py-1.5 font-mono text-muted">{rlocText(x.rloc16)}</td>
                    <td className="whitespace-nowrap border-b border-border px-2 py-1.5">{x.role ?? "—"}</td>
                    <td className="whitespace-nowrap border-b border-border px-2 py-1.5 tabular-nums">
                      {x.rssiAvg !== null ? `${x.rssiAvg} dBm` : "—"}
                    </td>
                    <td className="whitespace-nowrap border-b border-border px-2 py-1.5 tabular-nums">
                      {x.linkMargin !== null ? `${x.linkMargin} dB` : "—"}
                    </td>
                    <td className="whitespace-nowrap border-b border-border px-2 py-1.5">
                      <LqMeter value={x.lqIn} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[12.5px] text-muted">Son health&apos;te komşu listesi yok.</p>
        )}
      </section>
    </div>
  );
}
