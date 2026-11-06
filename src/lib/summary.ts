import "server-only";
import { and, asc, desc, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { readMeasurement, type D4iBlock } from "@/lib/d4i";
import { DEFAULT_FRESH_MS, freshMs } from "@/lib/deviceWindows";
import type { D4iRaw, DeviceMeasure, LiveSummary } from "@/app/_lib/types";

/**
 * Ölçümün "güncel" sayıldığı pencere — CİHAZ BAŞINA: firmware'in bildirdiği
 * rapor aralığının 2,5 katı, en az 10 dk (lib/deviceWindows.ts → freshMs).
 * Aralık bildirmeyen (eski, ~30 sn'de bir gönderen) cihazda 10 dk: kısa
 * kesintileri tolere ederken susmuş bir lambanın gücünü toplama sokmayacak
 * kadar dar.
 */
export const FRESH_MS = DEFAULT_FRESH_MS;

/** Cihaz başına tazelik penceresi (ms); aralığı bildirilmemiş cihaz listede yok. */
async function freshWindows(macs: string[]): Promise<Map<string, number>> {
  const rows = await db
    .select({ mac: schema.devices.deviceId, reportIntervalS: schema.devices.reportIntervalS })
    .from(schema.devices)
    .where(and(inArray(schema.devices.deviceId, macs), isNotNull(schema.devices.reportIntervalS)));
  return new Map(rows.map((r) => [r.mac, freshMs(r)]));
}

const EMPTY: LiveSummary = {
  powerW: null,
  powerLamps: 0,
  loadPowerW: null,
  ledVoltageV: null,
  ledVoltageLamps: 0,
  ledVoltageEstimated: false,
  faultyLamps: 0,
  devices: {},
};

/**
 * Verilen cihazlar (MAC) için ÖLÇÜLMÜŞ özet: her lambanın (cihaz + DALI
 * adresi) SON D4i raporundan güç/gerilim, açık arızalı lamba sayısı.
 *
 * `DISTINCT ON` ile kanal başına tek satır okunur. Alanların bir kısmı
 * yalnızca ham `raw` bloğunda olduğu için (load_power, voltage_estimated_v)
 * hesap TypeScript tarafında `lib/d4i.ts` yardımcılarıyla yapılır — panelle
 * aynı okuma kuralı (doğrulanmış → tahmini → ham) geçerli olsun diye.
 *
 * Çok kiracılık: yalnızca müşterinin kayıtlı cihazları sayılır; kayıtsız
 * MAC'lerin telemetrisi hiçbir müşterinin özetine girmez.
 */
export async function computeSummary(macs: string[]): Promise<LiveSummary> {
  if (macs.length === 0) return { ...EMPTY, devices: {} };
  // SQL kesimi en geniş pencere; her satır aşağıda kendi cihazının
  // penceresine göre süzülür.
  const windows = await freshWindows(macs);
  const now = Date.now();
  const cutoff = new Date(now - Math.max(FRESH_MS, ...windows.values()));

  const rows = await db
    .selectDistinctOn([schema.d4iTelemetry.deviceId, schema.d4iTelemetry.channel])
    .from(schema.d4iTelemetry)
    .where(
      and(
        gt(schema.d4iTelemetry.recordedAt, cutoff),
        inArray(schema.d4iTelemetry.deviceId, macs),
      ),
    )
    .orderBy(
      asc(schema.d4iTelemetry.deviceId),
      asc(schema.d4iTelemetry.channel),
      desc(schema.d4iTelemetry.recordedAt),
    );

  let powerW = 0;
  let powerSamples = 0;
  let loadPowerW = 0;
  let loadSamples = 0;
  let voltageSum = 0;
  let voltageSamples = 0;
  let voltageEstimated = false;

  // Cihaz (MAC) kırılımı — cihaz tablosu ve bölge detayı bunu kullanır; bölge
  // değerleri istemcide cihazlarından toplanır. Toplamlarla aynı kurallar.
  const perDevice = new Map<string, DeviceMeasure & { voltageSum: number }>();
  const deviceOf = (mac: string) => {
    let d = perDevice.get(mac);
    if (!d) {
      d = {
        powerW: null,
        loadPowerW: null,
        ledVoltageV: null,
        ledVoltageLamps: 0,
        ledVoltageEstimated: false,
        lamps: 0,
        voltageSum: 0,
      };
      perDevice.set(mac, d);
    }
    return d;
  };

  for (const row of rows) {
    const window = windows.get(row.deviceId) ?? FRESH_MS;
    if (!row.recordedAt || now - row.recordedAt.getTime() > window) continue;
    const d4i = (row.raw as D4iRaw | null)?.d4i;
    const dev = deviceOf(row.deviceId);
    dev.lamps += 1;

    const power = row.powerW ?? d4i?.power?.value ?? null;
    if (typeof power === "number") {
      powerW += power;
      powerSamples += 1;
      dev.powerW = (dev.powerW ?? 0) + power;
    }

    const load = d4i?.load_power?.value;
    if (typeof load === "number") {
      loadPowerW += load;
      loadSamples += 1;
      dev.loadPowerW = (dev.loadPowerW ?? 0) + load;
    }

    // Gerilim TOPLANMAZ, ortalanır — lambalar paralel sürülür.
    const voltage = readMeasurement(d4i?.led as D4iBlock | undefined, "voltage", "v");
    if (voltage) {
      voltageSum += voltage.value;
      voltageSamples += 1;
      dev.voltageSum += voltage.value;
      dev.ledVoltageLamps += 1;
      if (voltage.kind !== "exact") {
        voltageEstimated = true;
        dev.ledVoltageEstimated = true;
      }
    }
  }

  const devices: Record<string, DeviceMeasure> = {};
  for (const [mac, { voltageSum: vs, ...d }] of perDevice) {
    devices[mac] = { ...d, ledVoltageV: d.ledVoltageLamps > 0 ? vs / d.ledVoltageLamps : null };
  }

  // Açık arızası olan farklı lamba sayısı. Cihaz seviyesi kayıtlar (komut
  // hatası, channel NULL) sayılmaz — bunlar lamba arızası değil.
  const [faults] = await db
    .select({
      lamps: sql<number>`count(distinct (${schema.faultEvents.deviceId}, ${schema.faultEvents.channel}))`,
    })
    .from(schema.faultEvents)
    .where(
      and(
        isNull(schema.faultEvents.resolvedAt),
        isNotNull(schema.faultEvents.channel),
        inArray(schema.faultEvents.deviceId, macs),
      ),
    );

  return {
    powerW: powerSamples > 0 ? powerW : null,
    powerLamps: powerSamples,
    loadPowerW: loadSamples > 0 ? loadPowerW : null,
    ledVoltageV: voltageSamples > 0 ? voltageSum / voltageSamples : null,
    ledVoltageLamps: voltageSamples,
    ledVoltageEstimated: voltageEstimated,
    faultyLamps: Number(faults?.lamps ?? 0),
    devices,
  };
}
