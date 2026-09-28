"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DeviceView, LiveSummary, OpenFault, Zone, ZoneStatus } from "./types";
import type { Action, LiveEvent } from "@/types/lighting";
import { useLiveStatus } from "./useLiveStatus";
import { useReconcile } from "./useReconcile";
import { useApi } from "./panel";

/**
 * Müşteri panelinin ortak canlı durumu: bölgeler, cihazlar, ölçülmüş özet,
 * süren arızalar ve bunları değiştiren komutlar. `/c/[customer]/layout.tsx`
 * bir kez kurar; sayfalar (Genel Bakış, Bölgeler, Cihazlar…) arasında
 * gezinirken state, SSE aboneliği ve uçuştaki komut korumaları kaybolmaz.
 */

/** Slider sürüklenirken publish selini önler; bırakılınca komut bu kadar sonra gider. */
const DIM_DEBOUNCE_MS = 150;

/** Cihaz raporu gelince ölçüm özetinin tazelenmesi bu kadar geciktirilir. */
const LIVE_REFRESH_MS = 1500;

/** "Tüm Sistem" slider'ının debounce anahtarı (bölge slug'larıyla çakışmaz). */
const ALL_KEY = "__all__";

type ApiFn = (path: string) => string;

type CommandBody = { action: Action; value?: number; number?: number; text?: string };

async function postCommand(api: ApiFn, path: string, body: CommandBody): Promise<number | undefined> {
  const res = await fetch(api(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Komut başarısız (${res.status})`);
  const json = await res.json().catch(() => null);
  return json?.data?.seq;
}

/** Tek bölge → `Meven:<slug>/cmd` (tek publish, Kural #3). */
function sendZone(api: ApiFn, zoneId: string, body: CommandBody) {
  return postCommand(api, `/api/zones/${zoneId}/command`, body);
}

/**
 * Müşterinin "Tüm Sistem"i → müşterinin her bölge topic'ine publish (sunucu
 * tarafında fanout; Meven:all/cmd diğer müşterileri de sürerdi).
 */
function sendAll(api: ApiFn, body: CommandBody) {
  return postCommand(api, `/api/command/all`, body);
}

/** JSON yanıtı okuyup hata metnini `Error`'a çevirir. */
async function readJson<T>(res: Response, fallback: string): Promise<T> {
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error ?? `${fallback} (${res.status})`);
  return j.data as T;
}

/** Master slider başlangıcı: zone'ların ortalama parlaklığından türetilir. */
function deriveMaster(zones: Zone[]): number {
  if (zones.length === 0) return 50;
  const sum = zones.reduce((a, z) => a + z.brightness, 0);
  return Math.round(sum / zones.length);
}

function groupBy<T>(items: T[], key: (item: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (k === null) continue;
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export interface ZoneValues {
  name: string;
  district: string;
  poleCount: number;
  /** Yalnızca admin + düzenleme: bölgeyi başka müşteriye taşı. */
  customerSlug?: string;
}

export interface DeviceValues {
  mac: string;
  zoneSlug: string;
  name?: string;
}

/** Efekt hedefi: müşterinin tüm sistemi ya da seçili bölgeler (slug). */
export type EffectTarget = "all" | string[];

interface LightingValue {
  zones: Zone[];
  devices: DeviceView[];
  devicesLoading: boolean;
  /** Cihazlardan ölçülmüş özet; yüklenene kadar null (tahmine düşülür). */
  live: LiveSummary | null;
  /** O an süren lamba arızaları (cihaz + bölge bilgisiyle). */
  faults: OpenFault[];
  faultsByZone: Map<string, OpenFault[]>;
  faultsByDevice: Map<string, OpenFault[]>;
  /** "Tüm Sistem" aç/kapa ve şiddeti — bölgelerden TÜRETİLMEZ (bkz. provider). */
  masterOn: boolean;
  masterBrightness: number;

  toggleZone: (id: string, on: boolean) => void;
  setZoneBrightness: (id: string, value: number) => void;
  setAll: (on: boolean) => void;
  setAllBrightness: (value: number) => void;
  applyEffect: (target: EffectTarget, number: number, text?: string) => void;
  stopEffect: (target: EffectTarget) => void;

  createZone: (values: ZoneValues) => Promise<Zone>;
  updateZone: (id: string, values: ZoneValues) => Promise<void>;
  deleteZone: (id: string) => Promise<void>;
  createDevice: (values: DeviceValues) => Promise<DeviceView>;
  updateDevice: (mac: string, values: { zoneSlug: string; name: string }) => Promise<void>;
  deleteDevice: (mac: string) => Promise<void>;
}

const LightingContext = createContext<LightingValue | null>(null);

export function LightingProvider({
  initialZones,
  children,
}: {
  initialZones: Zone[];
  children: React.ReactNode;
}) {
  const api = useApi();
  const [zones, setZones] = useState<Zone[]>(initialZones);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [live, setLive] = useState<LiveSummary | null>(null);
  const [faults, setFaults] = useState<OpenFault[]>([]);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Master (Tüm Sistem) slider'ı BAĞIMSIZ state'tir — bölge ortalamasından
  // TÜRETİLMEZ. Tek bir bölgenin parlaklığını değiştirmek master'ı oynatmamalı.
  // Cross-client senkron için yalnızca "Tüm Sistem" komutunun SSE'deki
  // scope:"all" olayıyla güncellenir (bkz. onLive).
  const [masterBrightness, setMasterBrightness] = useState(() => deriveMaster(initialZones));
  // Master switch de BAĞIMSIZ — bölgelerden türetilmez ("zones.some(isOn)").
  // Tek bir bölgeyi açıp kapamak master switch'i oynatmamalı; master yalnızca
  // "Tüm Sistem" komutuyla (yerel + scope:"all" echo) değişir.
  const [masterOn, setMasterOn] = useState(() => initialZones.some((z) => z.isOn));
  // scope:"all" olaylarının eski/yeni ayrımı + yerel all-komutu uçuşta guard'ı.
  const masterSeqRef = useRef(0);
  const masterPendingRef = useRef(0);

  const dimTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Son bilinen komut seq'i (zone bazlı) — SSE echo'sundan ve bu client'ın
  // kendi komutunun POST cevabından güncellenir; sırası bozulmuş eski
  // echo'ları eler (bkz. lib/mqtt.ts recordCommand).
  const lastSeqRef = useRef<Map<string, number>>(new Map());

  // Bir zone için yanıtı henüz dönmemiş (in-flight) komut sayısı. Bu > 0 iken
  // gelen HİÇBİR SSE echo'su uygulanmaz: kullanıcı zaten daha yeni bir komut
  // gönderdi ama o komutun kendi seq'i henüz bilinmiyor, dolayısıyla seq
  // karşılaştırması tek başına yetersiz — az önce gönderilmiş ama seq'i henüz
  // dönmemiş bir düzenlemenin üzerine, seq'i "eski değil" görünen ama aslında
  // bayat bir echo'nun yazmasını bununla engelliyoruz.
  const pendingRef = useRef<Map<string, number>>(new Map());

  // Son komutun gönderilme anı — mutabakat (useReconcile) bunun hemen ardından
  // çalışırsa optimistic durumu bayat DB verisiyle ezebilir: `recordCommand`
  // arka planda (`after()`) yazdığı için publish ile DB arasında kısa bir
  // pencere var (bkz. Kural #10).
  const lastCommandAtRef = useRef(0);

  function applySeq(target: string, seq: number | undefined) {
    if (typeof seq !== "number") return;
    const cur = lastSeqRef.current.get(target);
    if (cur === undefined || seq > cur) lastSeqRef.current.set(target, seq);
  }
  function beginPending(target: string) {
    lastCommandAtRef.current = Date.now();
    pendingRef.current.set(target, (pendingRef.current.get(target) ?? 0) + 1);
  }
  function endPending(target: string) {
    const n = (pendingRef.current.get(target) ?? 1) - 1;
    if (n <= 0) pendingRef.current.delete(target);
    else pendingRef.current.set(target, n);
  }

  const faultsByZone = useMemo(() => groupBy(faults, (f) => f.zoneSlug), [faults]);
  const faultsByDevice = useMemo(() => groupBy(faults, (f) => f.deviceId), [faults]);

  // ── Okuma ──────────────────────────────────────────────────
  /** Cihazlardan ölçülmüş özet (güç, gerilim, arızalı lamba; cihaz kırılımı). */
  const loadLive = useCallback(() => {
    fetch(api("/api/summary"))
      .then((r) => r.json())
      .then((j) => {
        if (j.data) setLive(j.data as LiveSummary);
      })
      .catch(() => {});
  }, [api]);

  /** O an süren arızalar (bölge detayı + cihaz rozeti + arızalar sayfası). */
  const loadFaults = useCallback(() => {
    fetch(api("/api/faults"))
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.data)) setFaults(j.data as OpenFault[]);
      })
      .catch(() => {});
  }, [api]);

  const loadDevices = useCallback(() => {
    fetch(api("/api/devices"))
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.data)) setDevices(j.data as DeviceView[]);
      })
      .catch(() => {})
      .finally(() => setDevicesLoading(false));
  }, [api]);

  useEffect(() => {
    loadLive();
    loadFaults();
    loadDevices();
  }, [loadLive, loadFaults, loadDevices]);

  /**
   * SSE kaçarsa ekran bayat kalmasın.
   *
   * Ölçüm özeti, arızalar ve cihaz listesi HER ZAMAN tazelenir (cihazdan gelen
   * gerçek veri, optimistic durumla çakışmaz). Bölgeler ise uçuşta komut
   * varken ya da az önce komut gönderildiyse atlanır — yoksa henüz DB'ye
   * yazılmamış optimistic durumun üstüne eski değer biner.
   */
  const reconcile = useCallback(() => {
    loadLive();
    loadFaults();
    loadDevices();
    if (pendingRef.current.size > 0) return;
    if (Date.now() - lastCommandAtRef.current < 5_000) return;
    fetch(api("/api/zones"))
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.data)) setZones(j.data as Zone[]);
      })
      .catch(() => {});
  }, [api, loadLive, loadFaults, loadDevices]);
  useReconcile(reconcile);

  /**
   * Cihaz raporu gelince özeti tazele. Her lamba ayrı mesaj yayınladığından
   * art arda gelen raporlar tek fetch'te birleşsin diye kısa bir pencere beklenir.
   */
  const scheduleLiveRefresh = useCallback(() => {
    if (liveTimer.current) return;
    liveTimer.current = setTimeout(() => {
      liveTimer.current = null;
      loadLive();
      loadFaults();
    }, LIVE_REFRESH_MS);
  }, [loadLive, loadFaults]);

  useEffect(() => {
    const timer = liveTimer;
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // ── Canlı durum (SSE) ──────────────────────────────────────
  const onLive = useCallback(
    (e: LiveEvent) => {
      // Ölçüm özeti (güç/gerilim/arıza) cihaz raporundan sonra DB'den okunur;
      // olayın kendisi bu değerleri taşımaz. Bölge filtresinden ÖNCE ele alınır.
      if (e.kind === "telemetry" || e.kind === "ack") scheduleLiveRefresh();

      // Cihaz satırı: `ack` → hata rozeti (başarılı yanıtta temizlenir) + son
      // görülme; cihaz-seviyesi `telemetry` → son görülme ve cihaz agregatı.
      // Kanal bazlı telemetri atlanır (agregatı backend ayrıca gönderir).
      if (
        e.deviceId &&
        (e.kind === "ack" || (e.kind === "telemetry" && typeof e.channel !== "number"))
      ) {
        setDevices((ds) =>
          ds.map((d) => {
            if (d.deviceId !== e.deviceId) return d;
            const next = { ...d, lastSeen: e.at };
            if (e.kind === "ack") {
              next.lastError = e.error ?? null;
              next.lastErrorAt = e.error ? e.at : null;
              return next;
            }
            if (typeof e.isOn === "boolean") next.relayStatus = e.isOn ? "on" : "off";
            if (typeof e.brightness === "number") next.brightness = e.brightness;
            return next;
          }),
        );
      }

      // "Tüm Sistem" kapsam olayı: yalnızca master'ı senkronlar (bölge
      // durumları kendi zoneSlug'lı olaylarıyla ayrıca güncellenir). Tek bölge
      // değişimi bu olayı üretmez, dolayısıyla master oynamaz.
      if (e.scope === "all") {
        if (masterPendingRef.current > 0) return; // yerel all-komutu uçuşta
        if (typeof e.seq === "number") {
          if (e.seq < masterSeqRef.current) return; // eski echo
          masterSeqRef.current = e.seq;
        }
        if (typeof e.isOn === "boolean") setMasterOn(e.isOn);
        if (typeof e.brightness === "number") setMasterBrightness(e.brightness);
        return; // scope:"all" olayının zoneSlug'ı yok
      }

      if (!e.zoneSlug) return;
      if ((pendingRef.current.get(e.zoneSlug) ?? 0) > 0) return; // daha yeni komut uçuşta
      if (typeof e.seq === "number") {
        const lastSeq = lastSeqRef.current.get(e.zoneSlug);
        if (lastSeq !== undefined && e.seq < lastSeq) return; // eski komut-echo
        lastSeqRef.current.set(e.zoneSlug, e.seq);
      }
      setZones((prev) =>
        prev.map((z) => {
          if (z.id !== e.zoneSlug) return z;
          const next: Zone = { ...z };
          // Parlaklık/açık-kapalı/efekt YALNIZCA komut olaylarından güncellenir
          // (üstten alta). Cihaz telemetrisi bölge değerlerini ALTTAN ÜSTE
          // değiştirmez — yalnızca arıza (status) bubble eder.
          if (e.kind === "command") {
            if (typeof e.isOn === "boolean") next.isOn = e.isOn;
            if (typeof e.brightness === "number") next.brightness = e.brightness;
            if (typeof e.activeFx !== "undefined") next.activeFx = e.activeFx;
          }
          if (e.deviceId) next.status = (e.status === "error" ? "fault" : "ok") as ZoneStatus;
          return next;
        }),
      );
    },
    [scheduleLiveRefresh],
  );
  useLiveStatus(onLive);

  // ── Komutlar (optimistic + API) ────────────────────────────
  /** Tek bölgeye komut; seq/pending korumasıyla. Hata olursa `rollback`. */
  function commandZone(id: string, body: CommandBody, rollback?: () => void) {
    beginPending(id);
    sendZone(api, id, body)
      .then((seq) => applySeq(id, seq))
      .catch(() => rollback?.())
      .finally(() => endPending(id));
  }

  /** "Tüm Sistem" komutu; tüm bölgeler + master için pending tutulur. */
  function commandAll(body: CommandBody, rollback?: () => void) {
    const ids = zones.map((z) => z.id);
    ids.forEach(beginPending);
    masterPendingRef.current += 1;
    sendAll(api, body)
      .then((seq) => {
        ids.forEach((id) => applySeq(id, seq));
        if (typeof seq === "number" && seq > masterSeqRef.current) masterSeqRef.current = seq;
      })
      .catch(() => rollback?.())
      .finally(() => {
        ids.forEach(endPending);
        masterPendingRef.current -= 1;
      });
  }

  // on/off/dim efekti durdurur → activeFx optimistic olarak null'lanır.
  function toggleZone(id: string, on: boolean) {
    const prev = zones;
    setZones((zs) => zs.map((z) => (z.id === id ? { ...z, isOn: on, activeFx: null } : z)));
    commandZone(id, { action: on ? "on" : "off" }, () => setZones(prev));
  }

  function setZoneBrightness(id: string, value: number) {
    // dim = aynı zamanda "aç": kapalı bölgede bar sürüklenince optimistic açılır
    // (backend patchFor("dim") de isOn=true yazar). Yoksa bar 0'da kilitli kalır.
    setZones((zs) =>
      zs.map((z) => (z.id === id ? { ...z, brightness: value, isOn: true, activeFx: null } : z)),
    );
    const timers = dimTimers.current;
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        commandZone(id, { action: "dim", value });
      }, DIM_DEBOUNCE_MS),
    );
  }

  function setAll(on: boolean) {
    setMasterOn(on);
    setZones((zs) => zs.map((z) => ({ ...z, isOn: on, activeFx: null })));
    commandAll({ action: on ? "on" : "off" });
  }

  function setAllBrightness(value: number) {
    setMasterBrightness(value); // optimistic — echo (scope:"all") guard ile korunur
    setMasterOn(true); // dim = aç
    setZones((zs) => zs.map((z) => ({ ...z, brightness: value, isOn: true, activeFx: null })));
    const timers = dimTimers.current;
    clearTimeout(timers.get(ALL_KEY));
    timers.set(
      ALL_KEY,
      setTimeout(() => {
        timers.delete(ALL_KEY);
        commandAll({ action: "dim", value });
      }, DIM_DEBOUNCE_MS),
    );
  }

  /**
   * Efekt başlat. Tüm bölgeler seçiliyse tek "Tüm Sistem" isteği (sunucu
   * fanout'u), değilse her seçili bölgeye ayrı bölge komutu.
   */
  function applyEffect(target: EffectTarget, number: number, text?: string) {
    const body: CommandBody = { action: "efekt", number, text };
    if (target === "all") {
      setMasterOn(true);
      setZones((zs) => zs.map((z) => ({ ...z, isOn: true, activeFx: number })));
      commandAll(body);
      return;
    }
    const set = new Set(target);
    setZones((zs) => zs.map((z) => (set.has(z.id) ? { ...z, isOn: true, activeFx: number } : z)));
    for (const id of target) commandZone(id, body);
  }

  /** Efekti durdur: on/off/dim efekti keser → son şiddete dim gönderilir. */
  function stopEffect(target: EffectTarget) {
    if (target === "all") {
      setMasterOn(true);
      setZones((zs) => zs.map((z) => ({ ...z, activeFx: null })));
      commandAll({ action: "dim", value: masterBrightness });
      return;
    }
    const set = new Set(target);
    setZones((zs) => zs.map((z) => (set.has(z.id) ? { ...z, activeFx: null } : z)));
    for (const z of zones) {
      if (set.has(z.id)) commandZone(z.id, { action: "dim", value: z.brightness });
    }
  }

  // ── Bölge CRUD ─────────────────────────────────────────────
  async function createZone(values: ZoneValues): Promise<Zone> {
    const res = await fetch(api(`/api/zones`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const zone = await readJson<Zone>(res, "Oluşturma başarısız");
    setZones((zs) => [...zs, zone].sort((a, b) => a.name.localeCompare(b.name, "tr")));
    return zone;
  }

  async function updateZone(id: string, values: ZoneValues) {
    const res = await fetch(api(`/api/zones/${id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const data = await readJson<Zone & { movedTo: { slug: string; name: string } | null }>(
      res,
      "Güncelleme başarısız",
    );
    // Başka müşteriye taşınan bölge (cihazlarıyla) bu panelden çıkar.
    if (data.movedTo) {
      setZones((zs) => zs.filter((z) => z.id !== data.id));
      setDevices((ds) => ds.filter((d) => d.zoneSlug !== data.id));
      return;
    }
    setZones((zs) => zs.map((z) => (z.id === data.id ? data : z)));
    setDevices((ds) => ds.map((d) => (d.zoneSlug === data.id ? { ...d, zoneName: data.name } : d)));
  }

  async function deleteZone(id: string) {
    const res = await fetch(api(`/api/zones/${id}`), { method: "DELETE" });
    if (!res.ok) throw new Error("Bölge silinemedi");
    setZones((zs) => zs.filter((z) => z.id !== id));
    setDevices((ds) => ds.filter((d) => d.zoneSlug !== id));
    setFaults((fs) => fs.filter((f) => f.zoneSlug !== id));
  }

  // ── Cihaz CRUD ─────────────────────────────────────────────
  async function createDevice(values: DeviceValues): Promise<DeviceView> {
    const res = await fetch(api("/api/devices"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, name: values.name?.trim() || undefined }),
    });
    const device = await readJson<DeviceView>(res, "Hata");
    setDevices((ds) => [...ds, device].sort((a, b) => a.deviceId.localeCompare(b.deviceId)));
    return device;
  }

  async function updateDevice(mac: string, values: { zoneSlug: string; name: string }) {
    const res = await fetch(api(`/api/devices/${mac}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zoneSlug: values.zoneSlug, name: values.name.trim() }),
    });
    // Yanıt yalnızca kayıt alanlarını taşır; telemetri alanlarını korumak için
    // mevcut satırın üzerine yalnızca değişenleri yaz.
    const patch = await readJson<DeviceView>(res, "Hata");
    setDevices((ds) =>
      ds.map((d) =>
        d.deviceId === mac
          ? { ...d, name: patch.name, zoneSlug: patch.zoneSlug, zoneName: patch.zoneName }
          : d,
      ),
    );
  }

  async function deleteDevice(mac: string) {
    const res = await fetch(api(`/api/devices/${mac}`), { method: "DELETE" });
    if (!res.ok) throw new Error("Cihaz silinemedi");
    setDevices((ds) => ds.filter((d) => d.deviceId !== mac));
    setFaults((fs) => fs.filter((f) => f.deviceId !== mac));
  }

  const value: LightingValue = {
    zones,
    devices,
    devicesLoading,
    live,
    faults,
    faultsByZone,
    faultsByDevice,
    masterOn,
    masterBrightness,
    toggleZone,
    setZoneBrightness,
    setAll,
    setAllBrightness,
    applyEffect,
    stopEffect,
    createZone,
    updateZone,
    deleteZone,
    createDevice,
    updateDevice,
    deleteDevice,
  };

  return <LightingContext.Provider value={value}>{children}</LightingContext.Provider>;
}

export function useLighting(): LightingValue {
  const ctx = useContext(LightingContext);
  if (!ctx) throw new Error("useLighting yalnızca müşteri paneli içinde kullanılabilir");
  return ctx;
}
