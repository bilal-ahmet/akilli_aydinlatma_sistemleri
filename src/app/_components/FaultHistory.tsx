"use client";

import { useEffect, useState } from "react";
import type { FaultEvent } from "@/app/_lib/types";
import { formatDateTime, formatDuration } from "@/app/_lib/format";
import { faultLabel } from "@/lib/faults";
import { describeDeviceError } from "@/lib/deviceErrors";

/**
 * Cihazın arıza geçmişi — `GET /api/devices/:id/faults`. Satırlar epizot
 * bazlıdır (bkz. db/schema.ts fault_events): `resolvedAt` null ise arıza
 * sürüyor, doluysa ne kadar sürdüğü hesaplanır.
 */

/** Komut hataları için başlık + sebep, ham metin yerine katalogdan okunur. */
function describe(e: FaultEvent): { title: string; cause: string | null } {
  if (e.code.startsWith("command") && e.detail) {
    const info = describeDeviceError(e.detail);
    return { title: info.title, cause: info.cause };
  }
  return { title: faultLabel(e.code), cause: e.detail };
}

function Item({ e, name, now }: { e: FaultEvent; name: string; now: number | null }) {
  const ongoing = e.resolvedAt === null;
  const { title, cause } = describe(e);
  const started = new Date(e.startedAt).getTime();
  const ended = e.resolvedAt ? new Date(e.resolvedAt).getTime() : now;

  return (
    <li
      className={`rounded-xl border p-3 ${
        ongoing ? "border-danger/50 bg-danger/5" : "border-border bg-panel-2"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${ongoing ? "bg-danger" : "bg-muted"}`}
          aria-hidden
        />
        <span className="text-sm font-semibold text-text">{title}</span>
        <span className="rounded-md bg-panel px-2 py-0.5 text-xs text-muted">{name}</span>
        {ongoing ? (
          <span className="rounded-md bg-danger/15 px-2 py-0.5 text-xs font-semibold text-danger">
            sürüyor
          </span>
        ) : null}
        {ended !== null ? (
          <span className="ml-auto font-mono text-xs text-muted">
            {formatDuration(ended - started)}
          </span>
        ) : null}
      </div>

      {cause ? <p className="mt-1 text-xs text-muted">{cause}</p> : null}

      <p className="mt-1.5 font-mono text-xs text-muted">
        {formatDateTime(e.startedAt)}
        {e.resolvedAt ? ` → ${formatDateTime(e.resolvedAt)}` : " → …"}
      </p>
    </li>
  );
}

export function FaultHistory({
  rows,
  names,
  loading,
  onRefresh,
}: {
  rows: FaultEvent[];
  /** Kanal → dashboard'da girilen lamba adı. */
  names: Map<number, string | null>;
  loading: boolean;
  onRefresh: () => void;
}) {
  // Süren arızanın "ne kadardır sürdüğü" için saat. Render sırasında Date.now()
  // çağırmak saf değil (react-hooks/purity), bu yüzden mount'tan sonra state'e
  // yazılır ve dakikada bir tazelenir.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(tick);
    };
  }, []);

  const ongoing = rows.filter((e) => e.resolvedAt === null);
  const past = rows.filter((e) => e.resolvedAt !== null);

  const nameOf = (ch: number | null) =>
    ch === null ? "Cihaz" : names.get(ch) || `Lamba ${ch}`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-text">
          Arıza geçmişi{" "}
          <span className="text-sm font-normal text-muted">({rows.length} kayıt)</span>
          {ongoing.length > 0 ? (
            <span className="rounded-md bg-danger/15 px-2 py-0.5 text-xs font-semibold text-danger">
              {ongoing.length} süren arıza
            </span>
          ) : null}
        </h3>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-text disabled:opacity-50"
        >
          {loading ? "Yükleniyor…" : "Yenile"}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">
          {loading
            ? "Yükleniyor…"
            : "Bu cihazda kayıtlı arıza yok. Cihazdan arıza bildirimi geldiğinde (lamba arızası, sürücü/LED bayrağı ya da komut hatası) buraya başlangıç ve bitiş zamanıyla yazılır."}
        </p>
      ) : (
        <div className="space-y-4">
          {ongoing.length > 0 ? (
            <section>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-danger">
                Süren arızalar
              </p>
              <ul className="space-y-2">
                {ongoing.map((e) => (
                  <Item key={e.id} e={e} name={nameOf(e.channel)} now={now} />
                ))}
              </ul>
            </section>
          ) : null}

          {past.length > 0 ? (
            <section>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                Geçmiş ({past.length})
              </p>
              <ul className="space-y-2">
                {past.map((e) => (
                  <Item key={e.id} e={e} name={nameOf(e.channel)} now={now} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
