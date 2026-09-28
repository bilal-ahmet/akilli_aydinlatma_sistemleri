import { db, schema } from "@/lib/db";
import type { Role } from "@/lib/auth/roles";

/**
 * Bellek içi kiracı (tenancy) index'i: hangi bölge/cihaz hangi müşterinin,
 * hangi kullanıcı aktif ve hangi token sürümünde.
 *
 * NEDEN: Komut yolunda DB'ye gidilmez (Kural #10) ama her komutta sahiplik ve
 * oturum geçerliliği kontrol edilmelidir. Bu index açılışta (instrumentation)
 * ısıtılır ve her CRUD işleminden sonra `refreshTenancy()` ile BÜTÜNÜYLE
 * yeniden yüklenir — veri küçüktür, kısmi güncelleme hatası riskine değmez.
 *
 * Tek instance varsayımına dayanır (Kural #8): başka bir process'teki CRUD
 * buradaki index'i tazelemez. Yatay ölçeklemede Redis pub/sub ile invalidation
 * gerekir (events.ts ile aynı not).
 */

export type CustomerInfo = {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  zoneSlugs: string[];
  macs: string[];
};

export type UserState = {
  id: string;
  username: string;
  displayName: string | null;
  role: Role;
  customerId: string | null;
  isActive: boolean;
  tokenVersion: number;
  mustChangePassword: boolean;
};

export type TenancyIndex = {
  customersById: Map<string, CustomerInfo>;
  customersBySlug: Map<string, CustomerInfo>;
  zoneOwner: Map<string, string>; // zone slug → customer id
  deviceOwner: Map<string, string>; // MAC → customer id
  users: Map<string, UserState>;
  loadedAt: number;
};

const g = globalThis as unknown as {
  __fenerTenancy?: TenancyIndex;
  __fenerTenancyLoading?: Promise<TenancyIndex> | null;
};

async function load(): Promise<TenancyIndex> {
  const [customerRows, zoneRows, deviceRows, userRows] = await Promise.all([
    db
      .select({
        id: schema.customers.id,
        slug: schema.customers.slug,
        name: schema.customers.name,
        isActive: schema.customers.isActive,
      })
      .from(schema.customers),
    db
      .select({ id: schema.zones.id, slug: schema.zones.slug, customerId: schema.zones.customerId })
      .from(schema.zones),
    db
      .select({ mac: schema.devices.deviceId, zoneId: schema.devices.zoneId })
      .from(schema.devices),
    db
      .select({
        id: schema.users.id,
        username: schema.users.username,
        displayName: schema.users.displayName,
        role: schema.users.role,
        customerId: schema.users.customerId,
        isActive: schema.users.isActive,
        tokenVersion: schema.users.tokenVersion,
        mustChangePassword: schema.users.mustChangePassword,
      })
      .from(schema.users),
  ]);

  const customersById = new Map<string, CustomerInfo>();
  const customersBySlug = new Map<string, CustomerInfo>();
  for (const c of customerRows) {
    const info: CustomerInfo = { ...c, zoneSlugs: [], macs: [] };
    customersById.set(c.id, info);
    customersBySlug.set(c.slug, info);
  }

  const zoneOwner = new Map<string, string>();
  const zoneCustomerById = new Map<string, string>();
  for (const z of zoneRows) {
    zoneOwner.set(z.slug, z.customerId);
    zoneCustomerById.set(z.id, z.customerId);
    customersById.get(z.customerId)?.zoneSlugs.push(z.slug);
  }

  const deviceOwner = new Map<string, string>();
  for (const d of deviceRows) {
    const cid = d.zoneId ? zoneCustomerById.get(d.zoneId) : undefined;
    if (!cid) continue;
    deviceOwner.set(d.mac, cid);
    customersById.get(cid)?.macs.push(d.mac);
  }

  const users = new Map<string, UserState>();
  for (const u of userRows) users.set(u.id, { ...u, role: u.role as Role });

  return { customersById, customersBySlug, zoneOwner, deviceOwner, users, loadedAt: Date.now() };
}

/**
 * Güncel index. Önbellekteyse DB'ye gidilmez (yalnızca çözülmüş bir promise).
 * İlk çağrıda (soğuk açılış) bir kez yüklenir; eşzamanlı çağrılar aynı
 * yüklemeyi bekler.
 */
export async function getTenancy(): Promise<TenancyIndex> {
  if (g.__fenerTenancy) return g.__fenerTenancy;
  return g.__fenerTenancyLoading ?? refreshTenancy();
}

/**
 * Index'i DB'den yeniden yükler. CRUD route'ları yanıt dönmeden ÖNCE bunu
 * beklemeli; böylece bir sonraki istek yeni sahipliği görür.
 *
 * Uçuşta bir yükleme varsa ona KATILMAZ, ardına yeni bir yükleme zincirler:
 * uçuştaki yükleme bu çağrıyı yapan CRUD yazımından önce başlamış olabilir ve
 * eski veriyi okumuş olabilir.
 */
export async function refreshTenancy(): Promise<TenancyIndex> {
  const prev = g.__fenerTenancyLoading ?? Promise.resolve(null);
  const p: Promise<TenancyIndex> = prev
    .catch(() => null)
    .then(load)
    .then((idx) => {
      g.__fenerTenancy = idx;
      return idx;
    });
  g.__fenerTenancyLoading = p;
  void p
    .finally(() => {
      if (g.__fenerTenancyLoading === p) g.__fenerTenancyLoading = null;
    })
    .catch(() => {});
  return p;
}

/** Senkron bakış — index henüz yüklenmemişse undefined (olay süzme gibi sıcak yollar için). */
export function peekTenancy(): TenancyIndex | undefined {
  return g.__fenerTenancy;
}

/** Olayın/kaynağın sahip müşterisini çözer (bölge slug'ı önce, sonra MAC). */
export function ownerOf(
  idx: TenancyIndex,
  ref: { zoneSlug?: string; deviceId?: string },
): string | undefined {
  if (ref.zoneSlug) {
    const c = idx.zoneOwner.get(ref.zoneSlug);
    if (c) return c;
  }
  if (ref.deviceId) return idx.deviceOwner.get(ref.deviceId);
  return undefined;
}
