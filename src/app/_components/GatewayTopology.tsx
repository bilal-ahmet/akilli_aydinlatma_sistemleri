"use client";

import type { GatewayTopology as Topology, TopologyDevice } from "@/app/_lib/types";
import { formatDateTime } from "@/app/_lib/format";
import { formatMac } from "@/lib/mac";

/**
 * Border Router'ın son Thread topolojisi (yalnızca admin): doğrudan komşular
 * (BR_NEIGHBORS) ve router tablosu (BR_ROUTES). RLOC16 aynı müşterinin, aynı
 * Thread bölümündeki lambasıyla eşleşirse lamba adı/kodu gösterilir.
 */
export function GatewayTopology({ topology }: { topology: Topology }) {
  const { neighbors, routes } = topology;
  if (!neighbors && !routes) return null;
  const th = "px-2 py-1.5 text-left font-semibold whitespace-nowrap";
  const td = "px-2 py-1.5 whitespace-nowrap";

  return (
    <details className="rounded-[10px] border border-border bg-panel px-3 py-2">
      <summary className="cursor-pointer text-[13px] font-medium text-ink-2">
        Thread topolojisi
        {neighbors ? ` · ${neighbors.items.length} komşu` : ""}
        {routes ? ` · ${routes.items.length} router` : ""}
      </summary>

      {neighbors ? (
        <div className="mt-3">
          <p className="text-xs text-muted">
            Komşular{neighbors.at ? ` · ${formatDateTime(neighbors.at)}` : ""}
          </p>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[12px] text-ink-2">
              <thead className="text-muted">
                <tr>
                  <th className={th}>RLOC16</th>
                  <th className={th}>Lamba</th>
                  <th className={th}>Ext adres</th>
                  <th className={th}>Rol</th>
                  <th className={th}>RSSI ort/son</th>
                  <th className={th}>Link margin</th>
                  <th className={th}>LQ in/out</th>
                  <th className={th}>Yaş</th>
                  <th className={th}>Çerçeve/mesaj hata</th>
                  <th className={th}>Thread</th>
                </tr>
              </thead>
              <tbody>
                {neighbors.items.map((n) => (
                  <tr key={`${n.rloc16}-${n.ext_addr}`} className="border-t border-border">
                    <td className={td}>{rloc(n.rloc16)}</td>
                    <td className={`${td} font-sans`}>{deviceCell(n.device)}</td>
                    <td className={td}>{n.ext_addr ?? "—"}</td>
                    <td className={td}>{n.role ?? "—"}</td>
                    <td className={td}>
                      {dash(n.rssi_avg_dbm)} / {dash(n.rssi_last_dbm)} dBm
                    </td>
                    <td className={td}>{n.link_margin_db === null ? "—" : `${n.link_margin_db} dB`}</td>
                    <td className={td}>
                      {dash(n.lq_in)} / {dash(n.lq_out)}
                    </td>
                    <td className={td}>{n.age_s === null ? "—" : `${n.age_s} sn`}</td>
                    <td className={td}>
                      {pct(n.frame_error_pct)} / {pct(n.message_error_pct)}
                    </td>
                    <td className={td}>{dash(n.thread_version)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {routes ? (
        <div className="mt-4">
          <p className="text-xs text-muted">
            Router tablosu{routes.at ? ` · ${formatDateTime(routes.at)}` : ""}
          </p>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[12px] text-ink-2">
              <thead className="text-muted">
                <tr>
                  <th className={th}>Router ID</th>
                  <th className={th}>RLOC16</th>
                  <th className={th}>Lamba</th>
                  <th className={th}>Next hop</th>
                  <th className={th}>Path cost</th>
                  <th className={th}>LQ in/out</th>
                  <th className={th}>Yaş</th>
                  <th className={th}>Doğrudan bağ</th>
                </tr>
              </thead>
              <tbody>
                {routes.items.map((r) => (
                  <tr key={r.router_id} className="border-t border-border">
                    <td className={td}>{r.router_id}</td>
                    <td className={td}>{r.rloc16 === null ? "—" : rloc(r.rloc16)}</td>
                    <td className={`${td} font-sans`}>
                      {r.self ? <span className="text-muted">Bu ağ geçidi</span> : deviceCell(r.device)}
                    </td>
                    <td className={td}>{r.next_hop === null ? "—" : r.next_hop}</td>
                    <td className={td}>{dash(r.path_cost)}</td>
                    <td className={td}>
                      {dash(r.lq_in)} / {dash(r.lq_out)}
                    </td>
                    <td className={td}>{r.age_s === null ? "—" : `${r.age_s} sn`}</td>
                    <td className={td}>{r.link_established === null ? "—" : r.link_established ? "evet" : "hayır"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </details>
  );
}

const rloc = (v: number) => `0x${v.toString(16).toUpperCase().padStart(4, "0")}`;
const dash = (v: number | null) => (v === null ? "—" : String(v));
const pct = (v: number | null) => (v === null ? "—" : `%${v}`);

function deviceCell(d: TopologyDevice) {
  if (!d) return <span className="text-muted">—</span>;
  return (
    <span className="text-text">
      {d.name ? `${d.name} ` : ""}
      <span className="font-mono text-[11.5px] text-muted">{formatMac(d.mac)}</span>
    </span>
  );
}
