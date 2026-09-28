import "server-only";
import { and, asc, desc, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { readMeasurement, type D4iBlock } from "@/lib/d4i";
import type { D4iRaw, LiveSummary } from "@/app/_lib/types";

/**
 * Ölçümün "güncel" sayıldığı pencere. Cihaz kanal başına ~30 sn'de bir rapor
 * yayınlar; 10 dakika kısa kesintileri (deploy, yeniden bağlanma) tolere ederken
 * susmuş bir lambanın gücünü toplama sokmayacak kadar dar.
 */
export const FRESH_MS = 10 * 60_000;

const EMPTY: LiveSummary = {
  powerW: null,
  powerLamps: 0,
  loadPowerW: null,
  ledVoltageV: null,
  ledVoltageLamps: 0,
  ledVoltageEstimated: false,
  faultyLamps: 0,
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
  if (macs.length === 0) return { ...EMPTY };
  const cutoff = new Date(Date.now() - FRESH_MS);

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

  for (const row of rows) {
    const d4i = (row.raw as D4iRaw | null)?.d4i;

    const power = row.powerW ?? d4i?.power?.value ?? null;
    if (typeof power === "number") {
      powerW += power;
      powerSamples += 1;
    }

    const load = d4i?.load_power?.value;
    if (typeof load === "number") {
      loadPowerW += load;
      loadSamples += 1;
    }

    // Gerilim TOPLANMAZ, ortalanır — lambalar paralel sürülür.
    const voltage = readMeasurement(d4i?.led as D4iBlock | undefined, "voltage", "v");
    if (voltage) {
      voltageSum += voltage.value;
      voltageSamples += 1;
      if (voltage.kind !== "exact") voltageEstimated = true;
    }
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
  };
}
