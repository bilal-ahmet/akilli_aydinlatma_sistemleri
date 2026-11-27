"use client";

import type { DeviceView } from "@/app/_lib/types";
import type { MeshNode } from "@/lib/mesh/build";
import type { MeshSuggestion } from "@/lib/mesh/suggest";
import type { MeshView } from "@/lib/mesh/view";
import { lampOn } from "@/app/_lib/selection";
import {
  LqMeter,
  NodeTag,
  Row,
  STATUS_TEXT,
  SecHead,
  TONE_TEXT,
  Tag,
  fmt,
  linkTone,
  lqText,
  rlocText,
} from "./meshUi";

/**
 * Ağ haritası yan paneli: özet · direk · border router · öneri. Seçim
 * `MeshView`'da; buradaki çipler ve satırlar yalnızca `onSelect` çağırır.
 */

const SUGG_ICON: Record<MeshSuggestion["kind"], string> = { br: "BR", router: "+", check: "!" };

export interface MeshPanelProps {
  mesh: MeshView;
  byId: ReadonlyMap<string, MeshNode>;
  selectedId: string | null;
  devices: ReadonlyMap<string, DeviceView>;
  measures: Record<string, { powerW: number | null }> | undefined;
  onSelect: (id: string | null) => void;
  onOpenDevice: (mac: string) => void;
  onPlaceBr: (gatewayId: string) => void;
  placingBr: string | null;
}

export function MeshPanel(props: MeshPanelProps) {
  const { mesh, byId, selectedId } = props;
  const sugg = selectedId ? mesh.suggestions.find((s) => s.id === selectedId) : undefined;
  if (sugg) return <SuggestionView s={sugg} {...props} />;
  const node = selectedId ? byId.get(selectedId) : undefined;
  if (node?.kind === "device") return <NodeView node={node} {...props} />;
  if (node?.kind === "br") return <BrView node={node} {...props} />;
  if (node?.kind === "unknown") return <UnknownView node={node} {...props} />;
  return <Overview {...props} />;
}

function Chip({ node, me, onSelect }: { node: MeshNode; me?: boolean; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      className={`rounded-md border px-[7px] py-0.5 text-[12px] transition ${
        me
          ? "border-accent bg-accent-soft font-semibold text-accent"
          : "border-border bg-panel-2 text-text hover:border-accent hover:text-accent"
      }`}
    >
      {node.kind === "br" ? "BR" : node.label}
    </button>
  );
}

function pathOf(byId: ReadonlyMap<string, MeshNode>, node: MeshNode): MeshNode[] {
  const out: MeshNode[] = [];
  const seen = new Set<string>();
  for (let c: MeshNode | undefined = node; c && !seen.has(c.id); c = c.parentId ? byId.get(c.parentId) : undefined) {
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

function SuggestionRow({ s, onSelect }: { s: MeshSuggestion; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(s.id)}
      className="grid w-full grid-cols-[26px_1fr_auto] items-center gap-2.5 rounded-[9px] border border-border bg-panel-2 px-2.5 py-2 text-left text-[12.5px] transition hover:border-[#6d4ae0]"
    >
      <span className="grid h-[26px] w-[26px] place-items-center rounded-[7px] bg-[#efeafe] text-[11px] font-bold text-[#6d4ae0] dark:bg-[#251e3d] dark:text-[#a88bff]">
        {SUGG_ICON[s.kind]}
      </span>
      <span className="min-w-0">
        <b className="block font-semibold text-text">{s.title}</b>
        <span className="text-[11.5px] text-muted">{s.short}</span>
      </span>
      <span className="text-[16px] text-muted">›</span>
    </button>
  );
}

function Sec({ children }: { children: React.ReactNode }) {
  return <div className="border-t border-border px-4 py-3">{children}</div>;
}

// ── Özet ──────────────────────────────────────────────────────

function Overview({ mesh, onSelect, onPlaceBr, placingBr }: MeshPanelProps) {
  const routers = mesh.nodes
    .filter((n) => n.kind === "device" && n.load > 0)
    .sort((a, b) => b.upPpm - a.upPpm)
    .slice(0, 12);
  const maxUp = Math.max(1, ...routers.map((n) => n.upPpm));
  const brs = mesh.nodes.filter((n) => n.kind === "br");
  const devs = mesh.nodes.filter((n) => n.kind === "device");
  const unlocated = devs.filter((n) => n.lat === null || n.lng === null);
  const unknown = mesh.nodes.filter((n) => n.kind === "unknown");
  const byStatus = (s: string) => devs.filter((n) => n.status === s);
  const problems: Array<[string, MeshNode[]]> = [
    ["Eski firmware (0xCE/0xCF yok)", byStatus("legacy")],
    ["Rota yok", byStatus("no_route")],
    ["Rota döngüsü", byStatus("loop")],
    ["Bağlantısız", byStatus("offline")],
  ];

  return (
    <>
      <div className="px-4 pb-3.5 pt-4">
        <h3 className="text-[19px] font-semibold tracking-[-0.01em] text-text">Ağ özeti</h3>
        <p className="mt-1 text-[12.5px] text-muted">
          Bir direğe tıklayın: haritada BR&apos;ye giden yolu, panelde taşıdığı yükü gösterir.
        </p>
      </div>

      <Sec>
        <SecHead note={mesh.suggestions.length}>Öneriler</SecHead>
        {mesh.suggestions.length ? (
          <div className="flex flex-col gap-[7px]">
            {mesh.suggestions.map((s) => (
              <SuggestionRow key={s.id} s={s} onSelect={onSelect} />
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] text-muted">Şu an öneri yok.</p>
        )}
      </Sec>

      {routers.length ? (
        <Sec>
          <SecHead note="paket/dk">En çok yük taşıyan router&apos;lar</SecHead>
          <div className="grid gap-1">
            {routers.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => onSelect(n.id)}
                className="grid grid-cols-[76px_1fr_44px] items-center gap-2.5 rounded-md p-1 text-left text-[12.5px] hover:bg-panel-2"
              >
                <b className="truncate font-semibold text-text">{n.label}</b>
                <span className="h-1.5 overflow-hidden rounded-[3px] bg-track">
                  <span
                    className={`block h-full rounded-[3px] ${n.hot ? "bg-[#d26e00]" : "bg-muted/70"}`}
                    style={{ width: `${(n.upPpm / maxUp) * 100}%` }}
                  />
                </span>
                <span className="text-right text-[12px] tabular-nums text-muted">{fmt(n.upPpm)}</span>
              </button>
            ))}
          </div>
        </Sec>
      ) : null}

      <Sec>
        <SecHead note={brs.length}>Border router&apos;lar</SecHead>
        {brs.length === 0 ? (
          <p className="text-[12.5px] text-muted">
            Kayıtlı Thread border router yok. Ağ geçitleri sayfasından eklenince rotaların son halkası çizilir.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {brs.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-2 text-[12.5px]">
                <button type="button" onClick={() => onSelect(b.id)} className="min-w-0 text-left hover:text-accent">
                  <b className="font-semibold">{b.label}</b>{" "}
                  <span className="font-mono text-[11px] text-muted">{rlocText(b.rloc16)}</span>
                  <span className="block text-[11.5px] text-muted">
                    {b.online ? "çevrimiçi" : "bağlantısız"} · {b.load} direk
                  </span>
                </button>
                {b.lat === null ? (
                  <button
                    type="button"
                    onClick={() => onPlaceBr(b.gatewayId!)}
                    className="btn-line h-8 shrink-0 px-3 text-[12px]"
                  >
                    {placingBr === b.gatewayId ? "Haritaya tıklayın…" : "Haritada yerleştir"}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Sec>

      {unlocated.length || unknown.length || problems.some(([, l]) => l.length) ? (
        <Sec>
          <SecHead>Haritada çizilemeyenler</SecHead>
          <div className="flex flex-col gap-3 text-[12.5px]">
            {unlocated.length ? (
              <ChipGroup title="Konumu olmayan direk / cihaz" nodes={unlocated} onSelect={onSelect} />
            ) : null}
            {unknown.length ? (
              <ChipGroup title="Tanınmayan next hop (RLOC16)" nodes={unknown} onSelect={onSelect} />
            ) : null}
            {problems.map(([title, list]) =>
              list.length ? <ChipGroup key={title} title={title} nodes={list} onSelect={onSelect} /> : null,
            )}
          </div>
        </Sec>
      ) : null}

      <Sec>
        <p className="text-[11.5px] leading-relaxed text-muted">
          Rota ve maliyet doğrudan health paketinden gelir (<code className="font-mono">0xCE</code> next hop,{" "}
          <code className="font-mono">0xCF</code> yol maliyeti). Yük, mesafe, olaylar ve öneriler backend&apos;de
          hesaplanır; trafik değerleri rapor aralıklarından tahmindir.
        </p>
      </Sec>
    </>
  );
}

function ChipGroup({ title, nodes, onSelect }: { title: string; nodes: MeshNode[]; onSelect: (id: string) => void }) {
  return (
    <div>
      <div className="mb-1.5 text-muted">
        {title} <span className="tabular-nums">({nodes.length})</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {nodes.slice(0, 40).map((n) => (
          <Chip key={n.id} node={n} onSelect={onSelect} />
        ))}
        {nodes.length > 40 ? <span className="self-center text-muted">+{nodes.length - 40}</span> : null}
      </div>
    </div>
  );
}

// ── Direk ─────────────────────────────────────────────────────

function NodeView({ node: n, mesh, byId, devices, measures, onSelect, onOpenDevice }: MeshPanelProps & { node: MeshNode }) {
  const path = pathOf(byId, n);
  const parent = n.parentId ? byId.get(n.parentId) : undefined;
  const dev = n.mac ? devices.get(n.mac) : undefined;
  const lamps = dev?.lamps ?? [];
  const litLamps = lamps.filter(lampOn);
  const level = litLamps.length ? Math.round(litLamps.reduce((s, l) => s + l.brightness, 0) / litLamps.length) : 0;
  const power = n.mac ? measures?.[n.mac]?.powerW : null;
  const ownPct = n.upPpm > 0 ? (n.ownPpm / n.upPpm) * 100 : 100;
  const link = n.link;
  const related = mesh.suggestions.filter((s) => s.focus.includes(n.id));
  const tone = linkTone(n.linkCost);

  return (
    <>
      <div className="px-4 pb-3.5 pt-4">
        <button type="button" onClick={() => onSelect(null)} className="mb-2.5 text-[12.5px] font-semibold text-accent">
          ← Ağ özeti
        </button>
        <h3 className="flex flex-wrap items-center gap-2 text-[19px] font-semibold tracking-[-0.01em] text-text">
          {n.label}
          {n.role ? <Tag tone="muted">{n.role === "router" ? "Router" : "Child"}</Tag> : null}
          <NodeTag node={n} />
        </h3>
        <div className="mt-1 text-[12.5px] text-muted">
          {dev?.zoneName ?? n.zoneSlug ?? ""} · <code className="font-mono text-[11.5px]">{rlocText(n.rloc16)}</code>
          {dev ? (
            <>
              {" "}
              · armatür {litLamps.length ? `açık · %${level}` : lamps.length ? "kapalı" : "yok"}
              {power != null ? ` · ${fmt(power, 0)} W` : ""}
            </>
          ) : null}
        </div>
        {dev ? (
          <button type="button" onClick={() => onOpenDevice(dev.deviceId)} className="btn-glow mt-3 h-9 w-full text-[13px]">
            Cihaza git →
          </button>
        ) : null}
        {n.status && n.status !== "routed" ? (
          <p className="mt-3 rounded-lg bg-panel-2 px-2.5 py-2 text-[12px] text-muted">Durum: {STATUS_TEXT[n.status]}</p>
        ) : null}
        {path.length > 1 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1 text-[12px] text-muted">
            BR&apos;ye yol
            {path.map((m, i) => (
              <span key={m.id} className="flex items-center gap-1">
                {i ? <span>→</span> : null}
                <Chip node={m} me={i === 0} onSelect={onSelect} />
              </span>
            ))}
          </div>
        ) : null}
        <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-border bg-border">
          <Kv label="Next hop" src="0xCE">
            {parent ? (parent.kind === "br" ? "BR" : parent.label) : rlocText(n.nextHop)}
          </Kv>
          <Kv label="Yol maliyeti" src="0xCF">
            {n.pathCost ?? "—"} {n.hops !== null ? <small className="text-[12px] font-medium text-muted">· {n.hops} hop</small> : null}
          </Kv>
          <Kv label="Üzerinden geçen">
            {n.load} <small className="text-[12px] font-medium text-muted">direk</small>
          </Kv>
          <Kv label="Next hop'a mesafe">
            {n.distanceM ?? "—"} {n.distanceM !== null ? <small className="text-[12px] font-medium text-muted">m</small> : null}
          </Kv>
        </div>
      </div>

      {n.status !== "offline" ? (
        <Sec>
          <SecHead note="tahmini">Taşıdığı yük</SecHead>
          <div className="grid grid-cols-[30px_1fr_auto] items-center gap-2.5">
            <span className="grid h-[30px] w-[30px] place-items-center rounded-lg bg-accent-soft text-accent">
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-[2.2]" aria-hidden>
                <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <div className="text-[12px] text-muted">BR&apos;ye giden</div>
              <div className="text-[19px] font-semibold tabular-nums">
                {fmt(n.upPpm)} <small className="text-[12px] font-medium text-muted">paket/dk</small>
              </div>
            </div>
            <div className="text-right text-[12px] tabular-nums text-muted">≈ {fmt(n.upBytesPerMin / 1024, 2)} kB/dk</div>
          </div>
          <div className="my-2 flex h-2 overflow-hidden rounded bg-track">
            <div className="bg-[#2563eb] dark:bg-[#6e9cff]" style={{ width: `${ownPct}%` }} />
            <div className="bg-[#d26e00]" style={{ width: `${100 - ownPct}%` }} />
          </div>
          <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-muted">
            <span>
              <i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-[#2563eb] dark:bg-[#6e9cff]" />
              kendi {fmt(n.ownPpm)}
            </span>
            <span>
              <i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-[#d26e00]" />
              aktardığı {fmt(n.fwdPpm)} · {n.load} direk
            </span>
          </div>
          {n.load ? (
            <p className="mt-2 text-[11.5px] text-muted">BR&apos;den gelen komutlar bu direkten {n.load} direğe aktarılır.</p>
          ) : null}
        </Sec>
      ) : null}

      {link && n.status !== "legacy" ? (
        <Sec>
          <SecHead note="health alanları">{parent ? `${parent.kind === "br" ? "BR" : parent.label} ile link` : "Parent link"}</SecHead>
          <div className="grid gap-[7px]">
            <Row label="Link maliyeti">
              <span className={TONE_TEXT[tone]}>{n.linkCost !== null ? `+${n.linkCost}` : "—"}</span>
            </Row>
            <Row label="RSSI ort." src="0xC2" warn={link.rssiAvg !== null && link.rssiAvg < -75}>
              {link.rssiAvg !== null ? `${link.rssiAvg} dBm` : "—"}
            </Row>
            {link.rssiAvg24h !== null ? (
              <Row label="RSSI ort. · 24 sa">{`${Math.round(link.rssiAvg24h)} dBm`}</Row>
            ) : null}
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
        </Sec>
      ) : null}

      {n.load ? (
        <Sec>
          <SecHead note={n.load}>Trafiği buradan geçenler</SecHead>
          <div className="flex flex-wrap gap-1.5">
            {n.descendants.map((id) => {
              const d = byId.get(id);
              return d ? <Chip key={id} node={d} onSelect={onSelect} /> : null;
            })}
          </div>
        </Sec>
      ) : null}

      {related.length ? (
        <Sec>
          <SecHead>İlgili öneri</SecHead>
          <div className="flex flex-col gap-[7px]">
            {related.map((s) => (
              <SuggestionRow key={s.id} s={s} onSelect={onSelect} />
            ))}
          </div>
        </Sec>
      ) : null}
    </>
  );
}

function Kv({ label, src, children }: { label: string; src?: string; children: React.ReactNode }) {
  return (
    <div className="bg-panel px-[11px] py-[9px]">
      <div className="flex justify-between gap-1.5 text-[11.5px] text-muted">
        {label}
        {src ? <span className="font-mono text-[10px] text-muted/70">{src}</span> : null}
      </div>
      <div className="mt-px truncate text-[17px] font-semibold tabular-nums text-text">{children}</div>
    </div>
  );
}

// ── Border router ─────────────────────────────────────────────

function BrView({ node: b, byId, onSelect, onPlaceBr, placingBr }: MeshPanelProps & { node: MeshNode }) {
  const direct = b.children.map((id) => byId.get(id)).filter((x): x is MeshNode => !!x && x.kind === "device");
  return (
    <>
      <div className="px-4 pb-3.5 pt-4">
        <button type="button" onClick={() => onSelect(null)} className="mb-2.5 text-[12.5px] font-semibold text-accent">
          ← Ağ özeti
        </button>
        <h3 className="flex flex-wrap items-center gap-2 text-[19px] font-semibold text-text">
          {b.label}
          <Tag tone="muted">Border Router</Tag>
          <Tag tone={b.online ? "good" : "bad"}>{b.online ? "çevrimiçi" : "bağlantısız"}</Tag>
        </h3>
        <div className="mt-1 text-[12.5px] text-muted">
          GW_ID <code className="font-mono">{b.gatewayId}</code> · RLOC16{" "}
          <code className="font-mono">{rlocText(b.rloc16)}</code>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-border bg-border">
          <Kv label="Bağlı direk">{b.load}</Kv>
          <Kv label="Doğrudan">{direct.length}</Kv>
          <Kv label="Gelen trafik">
            {fmt(b.fwdPpm)} <small className="text-[12px] font-medium text-muted">paket/dk</small>
          </Kv>
          <Kv label="Partition">{b.partitionId ?? "—"}</Kv>
        </div>
        <button type="button" onClick={() => onPlaceBr(b.gatewayId!)} className="btn-line mt-3 h-9 w-full text-[13px]">
          {placingBr === b.gatewayId ? "Haritada yerine tıklayın…" : b.lat === null ? "Haritada yerleştir" : "Konumu değiştir"}
        </button>
      </div>
      {direct.length ? (
        <Sec>
          <SecHead note={direct.length}>Doğrudan bağlı direkler</SecHead>
          <div className="flex flex-wrap gap-1.5">
            {direct.map((d) => (
              <Chip key={d.id} node={d} onSelect={onSelect} />
            ))}
          </div>
        </Sec>
      ) : null}
    </>
  );
}

function UnknownView({ node: u, byId, onSelect }: MeshPanelProps & { node: MeshNode }) {
  const kids = u.children.map((id) => byId.get(id)).filter((x): x is MeshNode => !!x);
  return (
    <>
      <div className="px-4 pb-3.5 pt-4">
        <button type="button" onClick={() => onSelect(null)} className="mb-2.5 text-[12.5px] font-semibold text-accent">
          ← Ağ özeti
        </button>
        <h3 className="flex flex-wrap items-center gap-2 text-[19px] font-semibold text-text">
          <span className="font-mono">{rlocText(u.rloc16)}</span>
          <Tag tone="mid">tanınmayan</Tag>
        </h3>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
          Bu RLOC16 bu müşterinin kayıtlı bir cihazına ya da border router&apos;ına (partition {u.partitionId ?? "?"})
          eşleşmedi. Kayıtsız bir router, health&apos;i henüz gelmemiş bir cihaz ya da RLOC16&apos;sı değişmiş bir
          düğüm olabilir.
        </p>
      </div>
      {kids.length ? (
        <Sec>
          <SecHead note={kids.length}>Buraya yönlenenler</SecHead>
          <div className="flex flex-wrap gap-1.5">
            {kids.map((d) => (
              <Chip key={d.id} node={d} onSelect={onSelect} />
            ))}
          </div>
        </Sec>
      ) : null}
    </>
  );
}

// ── Öneri ─────────────────────────────────────────────────────

function SuggestionView({ s, byId, onSelect }: MeshPanelProps & { s: MeshSuggestion }) {
  return (
    <>
      <div className="px-4 pb-3.5 pt-4">
        <button type="button" onClick={() => onSelect(null)} className="mb-2.5 text-[12.5px] font-semibold text-accent">
          ← Ağ özeti
        </button>
        <h3 className="flex flex-wrap items-center gap-2 text-[19px] font-semibold text-text">
          {s.title} <Tag tone="sug">öneri</Tag>
        </h3>
        <div className="mt-1 text-[12.5px] text-muted">{s.short}</div>
        {s.point === null ? (
          <p className="mt-2 text-[12px] text-muted">İlgili direklerin konumu olmadığı için haritada işaretlenmedi.</p>
        ) : null}
      </div>
      <Sec>
        <SecHead>Neden</SecHead>
        <p className="text-[13px] leading-relaxed">{s.why}</p>
      </Sec>
      <Sec>
        <SecHead>Ne yapılmalı</SecHead>
        <ol className="list-decimal pl-[18px] text-[13px] leading-relaxed">
          {s.steps.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ol>
      </Sec>
      <Sec>
        <SecHead note="tahmini">Beklenen etki</SecHead>
        <div className="flex flex-col gap-1.5">
          {s.compare.map(([k, before, after]) => (
            <div key={k} className="grid grid-cols-[1fr_20px_1fr] items-center gap-1.5">
              <div className="rounded-lg bg-panel-2 px-2.5 py-[7px]">
                <div className="text-[11px] text-muted">{k} · şimdi</div>
                <div className="text-[16px] font-semibold tabular-nums">{before}</div>
              </div>
              <div className="text-center text-muted">→</div>
              <div className="rounded-lg bg-[#efeafe] px-2.5 py-[7px] dark:bg-[#251e3d]">
                <div className="text-[11px] text-muted">sonra</div>
                <div className="text-[16px] font-semibold tabular-nums text-[#6d4ae0] dark:text-[#a88bff]">{after}</div>
              </div>
            </div>
          ))}
        </div>
      </Sec>
      <Sec>
        <SecHead>Backend kuralı</SecHead>
        <div className="rounded-lg bg-panel-2 px-2.5 py-2 font-mono text-[11.5px] leading-normal">{s.rule}</div>
      </Sec>
      <Sec>
        <SecHead>İlgili direkler</SecHead>
        <div className="flex flex-wrap gap-1.5">
          {s.focus.map((id) => {
            const n = byId.get(id);
            return n ? <Chip key={id} node={n} onSelect={onSelect} /> : null;
          })}
        </div>
      </Sec>
    </>
  );
}

