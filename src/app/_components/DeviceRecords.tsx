"use client";

import { Fragment, useEffect, useState } from "react";
import { formatDateTime } from "@/app/_lib/format";

/**
 * Cihaz modalinin "Kayıtlar" sekmesi — YALNIZCA ADMIN (modal sekmeyi admin'e
 * gösterir, API `authorizeAdmin` ister). Cihazın son kayıtları:
 *  - Veri:   d4i_periodic raporları (lamba başına, ham paket)
 *  - Health: /health mesajları (7 gün saklanır)
 *  - RF:     health'teki Thread radyo bloğu (parent RSSI/LQ, komşular…)
 * Her görünüm CSV / JSON olarak indirilebilir.
 */

type Kind = "data" | "health" | "rf";

interface DeviceRecord {
  id: number;
  recordedAt: string | null;
  channel?: number;
  payload: Record<string, unknown> | null;
}

const KINDS: Array<{ id: Kind; label: string }> = [
  { id: "data", label: "Veri" },
  { id: "health", label: "Health" },
  { id: "rf", label: "RF (Thread)" },
];

const VIEW_LIMIT = 50;
const DOWNLOAD_LIMITS = [
  { value: 50, label: "Son 50" },
  { value: 500, label: "Son 500" },
  { value: 5000, label: "Tümü (en fazla 5000)" },
];

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
const at = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((cur, k) => obj(cur)?.[k], o);

/** Hücre metni: yok → "—". */
function show(v: unknown, unit = ""): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "evet" : "hayır";
  if (typeof v === "number") return `${Number.isInteger(v) ? v : v.toFixed(2)}${unit}`;
  return String(v);
}
const hex = (v: unknown, digits = 4) =>
  typeof v === "number" ? `0x${v.toString(16).toUpperCase().padStart(digits, "0")}` : "—";
function uptime(v: unknown): string {
  if (typeof v !== "number") return "—";
  const d = Math.floor(v / 86400);
  const h = Math.floor((v % 86400) / 3600);
  const m = Math.floor((v % 3600) / 60);
  return d > 0 ? `${d}g ${h}s` : h > 0 ? `${h}s ${m}dk` : `${m}dk`;
}
const when = (r: DeviceRecord) =>
  r.recordedAt ? formatDateTime(r.recordedAt, { seconds: true }) : "—";

function recordsUrl(deviceId: string, kind: Kind, limit: number, format?: "csv" | "json") {
  const q = new URLSearchParams({ kind, limit: String(limit) });
  if (format === "csv") q.set("format", "csv");
  if (format === "json") q.set("download", "1");
  return `/api/admin/devices/${encodeURIComponent(deviceId)}/records?${q}`;
}

export function DeviceRecords({ deviceId }: { deviceId: string }) {
  const [kind, setKind] = useState<Kind>("data");
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    rows: DeviceRecord[];
    error: string | null;
  } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [dlLimit, setDlLimit] = useState(VIEW_LIMIT);

  const key = `${kind}:${reload}`;
  const loading = result?.key !== key;

  useEffect(() => {
    let alive = true;
    fetch(recordsUrl(deviceId, kind, VIEW_LIMIT))
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j?.ok) setResult({ key, rows: j.data.rows as DeviceRecord[], error: null });
        else setResult({ key, rows: [], error: j?.error ?? "Kayıtlar okunamadı" });
      })
      .catch((e) => alive && setResult({ key, rows: [], error: String(e) }));
    return () => {
      alive = false;
    };
  }, [deviceId, kind, key]);

  const rows = loading ? [] : (result?.rows ?? []);
  const error = loading ? null : (result?.error ?? null);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Kayıt türü" className="flex gap-1 rounded-lg border border-border bg-panel-2 p-0.5">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              role="tab"
              aria-selected={kind === k.id}
              onClick={() => {
                setKind(k.id);
                setOpen(null);
              }}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                kind === k.id ? "bg-glow/20 text-text" : "text-muted hover:text-text"
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setReload((n) => n + 1)}
          disabled={loading}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-text disabled:opacity-50"
        >
          {loading ? "Yükleniyor…" : "Yenile"}
        </button>
      </div>

      {/* İndirme: düz bağlantı (çerezli GET, dosya sunucuda üretilir) */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-panel-2 px-3 py-2 text-sm">
        <span className="text-muted">İndir:</span>
        <select
          value={dlLimit}
          onChange={(e) => setDlLimit(Number(e.target.value))}
          aria-label="İndirilecek kayıt sayısı"
          className="rounded-md border border-border bg-panel px-2 py-1 text-sm text-text"
        >
          {DOWNLOAD_LIMITS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <a
          href={recordsUrl(deviceId, kind, dlLimit, "csv")}
          download
          className="rounded-md border border-border px-3 py-1 font-medium text-text transition-colors hover:bg-glow/15"
        >
          CSV
        </a>
        <a
          href={recordsUrl(deviceId, kind, dlLimit, "json")}
          download
          className="rounded-md border border-border px-3 py-1 font-medium text-text transition-colors hover:bg-glow/15"
        >
          JSON
        </a>
        <span className="text-xs text-muted">
          {kind === "data" ? "Lamba başına D4i raporu" : "Health geçmişi 7 gün saklanır"}
        </span>
      </div>

      {error ? (
        <p className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">
          {loading
            ? "Yükleniyor…"
            : kind === "data"
              ? "Bu cihazdan kayıtlı D4i raporu yok."
              : "Bu cihazdan henüz health mesajı alınmadı."}
        </p>
      ) : (
        <>
          {kind === "rf" ? <RfSummary latest={rows[0]} /> : null}
          <p className="mb-1.5 text-xs text-muted">
            Son {rows.length} kayıt · ayrıntı için satıra tıklayın
          </p>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className="bg-panel-2 text-muted">
                <tr>{headers(kind).map((h) => <th key={h} className="px-2.5 py-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="font-mono">
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr
                      onClick={() => setOpen(open === r.id ? null : r.id)}
                      className={`cursor-pointer border-t border-border transition-colors hover:bg-glow/10 ${
                        open === r.id ? "bg-glow/10" : ""
                      }`}
                    >
                      {cells(kind, r).map((c, i) => (
                        <td key={i} className="whitespace-nowrap px-2.5 py-1.5 text-text">{c}</td>
                      ))}
                    </tr>
                    {open === r.id ? (
                      <tr className="border-t border-border bg-panel/50">
                        <td colSpan={headers(kind).length} className="p-2.5">
                          {kind === "rf" ? <Neighbors thread={r.payload} /> : null}
                          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-panel p-2.5 text-[11px] leading-snug text-ink-2">
                            {JSON.stringify(r.payload, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function headers(kind: Kind): string[] {
  if (kind === "data")
    return ["Zaman", "Kanal", "Online", "Arc", "Güç (W)", "Yük (W)", "Enerji (Wh)", "Sürücü °C"];
  if (kind === "health")
    return ["Zaman", "Firmware", "Uptime", "Boş heap", "MQTT", "Reset", "Düşen komut", "OTA"];
  return ["Zaman", "Rol", "Bağlı", "Parent RSSI ort/son", "LQ in/out", "RLOC16", "Kanal", "Komşu"];
}

function cells(kind: Kind, r: DeviceRecord): string[] {
  const p = r.payload;
  if (kind === "data") {
    return [
      when(r),
      show(r.channel),
      show(at(p, "online")),
      show(at(p, "status", "actual_level")),
      show(at(p, "d4i", "power", "value")),
      show(at(p, "d4i", "load_power", "value")),
      show(at(p, "d4i", "energy", "value")),
      show(at(p, "d4i", "driver", "temperature_c")),
    ];
  }
  if (kind === "health") {
    const heap = at(p, "free_heap_bytes");
    return [
      when(r),
      show(at(p, "firmware_version")),
      uptime(at(p, "uptime_s")),
      typeof heap === "number" ? `${Math.round(heap / 1024)} KB` : "—",
      show(at(p, "mqtt_connected")),
      show(at(p, "reset_reason")),
      show(at(p, "dropped_commands")),
      show(at(p, "ota", "state")),
    ];
  }
  const n = at(p, "neighbors");
  return [
    when(r),
    show(at(p, "role")),
    show(at(p, "attached")),
    `${show(at(p, "parent_rssi_avg_dbm"))} / ${show(at(p, "parent_rssi_last_dbm"))} dBm`,
    `${show(at(p, "parent_link_quality_in"))} / ${show(at(p, "parent_link_quality_out"))}`,
    hex(at(p, "rloc16")),
    show(at(p, "channel")),
    Array.isArray(n) ? String(n.length) : "—",
  ];
}

/** RF: en son health'teki Thread durumu. */
function RfSummary({ latest }: { latest: DeviceRecord }) {
  const t = latest.payload;
  const items: Array<[string, string]> = [
    ["Rol", show(at(t, "role"))],
    ["Ağa bağlı", show(at(t, "attached"))],
    ["Parent RSSI (ort)", show(at(t, "parent_rssi_avg_dbm"), " dBm")],
    ["Parent RSSI (son)", show(at(t, "parent_rssi_last_dbm"), " dBm")],
    ["Parent LQ in / out", `${show(at(t, "parent_link_quality_in"))} / ${show(at(t, "parent_link_quality_out"))}`],
    ["RLOC16", hex(at(t, "rloc16"))],
    ["Kanal", show(at(t, "channel"))],
    ["PAN ID", hex(at(t, "pan_id"))],
    ["Ağ adı", show(at(t, "network_name"))],
    ["Partition ID", hex(at(t, "partition_id"), 8)],
    ["Parent değişimi", show(at(t, "parent_changes"))],
    ["Partition değişimi", show(at(t, "partition_id_changes"))],
    ["Attach denemesi", show(at(t, "attach_attempts"))],
  ];
  return (
    <div className="mb-3 rounded-xl border border-border bg-panel-2 p-3">
      <p className="mb-2 text-sm font-semibold text-text">
        Son Thread durumu <span className="font-normal text-muted">· {when(latest)}</span>
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {items.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="truncate font-mono text-sm text-text">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3">
        <Neighbors thread={t} />
      </div>
    </div>
  );
}

function Neighbors({ thread }: { thread: Obj | null }) {
  const list = at(thread, "neighbors");
  if (!Array.isArray(list) || list.length === 0)
    return <p className="mb-2 text-xs text-muted">Komşu bildirilmemiş.</p>;
  return (
    <div className="mb-2 overflow-x-auto">
      <p className="mb-1 text-xs font-semibold text-muted">Komşular ({list.length})</p>
      <table className="w-full min-w-[420px] text-left font-mono text-xs">
        <thead className="text-muted">
          <tr>
            {["RLOC16", "Rol", "RSSI ort", "RSSI son", "Link margin", "LQ in"].map((h) => (
              <th key={h} className="px-2 py-1 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((n, i) => (
            <tr key={i} className="border-t border-border text-text">
              <td className="px-2 py-1">{hex(at(n, "rloc16"))}</td>
              <td className="px-2 py-1">{show(at(n, "role"))}</td>
              <td className="px-2 py-1">{show(at(n, "rssi_avg_dbm"), " dBm")}</td>
              <td className="px-2 py-1">{show(at(n, "rssi_last_dbm"), " dBm")}</td>
              <td className="px-2 py-1">{show(at(n, "link_margin"))}</td>
              <td className="px-2 py-1">{show(at(n, "link_quality_in"))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
