/**
 * Kiracı (müşteri) izolasyonu uçtan uca kontrolü — çalışan bir sunucuya karşı.
 *
 *   CHECK_BASE_URL=http://localhost:3000 \
 *   CHECK_ADMIN_USER=admin CHECK_ADMIN_PASS=... \
 *   npm run check:tenancy
 *
 * İki geçici test müşterisi (A, B) ve kullanıcıları açar, çapraz erişimleri
 * dener, sonunda oluşturduğu her şeyi siler. Komut testleri bölge
 * topic'lerine GERÇEK publish yapar: CANLI BROKER'A BAĞLI BİR SUNUCUDA
 * ÇALIŞTIRMAYIN (lokal/test sunucusunda MQTT_HOST'u erişilemez bir adrese
 * yönlendirin).
 */

const BASE = process.env.CHECK_BASE_URL ?? "http://localhost:3000";
const ADMIN_USER = process.env.CHECK_ADMIN_USER;
const ADMIN_PASS = process.env.CHECK_ADMIN_PASS;

let failures = 0;
let passes = 0;

function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}`, extra ?? "");
  }
}

type Session = { cookie: string };

async function call(
  s: Session | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: { ok?: boolean; data?: unknown; error?: string } | null; res: Response }> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(s ? { cookie: s.cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, res };
}

function cookieFrom(res: Response): string {
  const set = res.headers.getSetCookie?.() ?? [];
  const c = set.find((x) => x.startsWith("fener_session="));
  return c ? c.split(";")[0] : "";
}

async function login(username: string, password: string): Promise<Session> {
  const r = await call(null, "POST", "/api/auth/login", { username, password });
  if (r.status !== 200) throw new Error(`giriş başarısız ${username}: ${r.status} ${r.json?.error}`);
  return { cookie: cookieFrom(r.res) };
}

async function changePassword(s: Session, current: string, next: string): Promise<Session> {
  const r = await call(s, "POST", "/api/auth/password", { currentPassword: current, newPassword: next });
  if (r.status !== 200) throw new Error(`şifre değişmedi: ${r.status} ${r.json?.error}`);
  return { cookie: cookieFrom(r.res) };
}

/** SSE akışını `ms` boyunca dinler, gelen olayları döner. */
async function collectEvents(s: Session, customer: string, ms: number): Promise<Record<string, unknown>[]> {
  const ctrl = new AbortController();
  const events: Record<string, unknown>[] = [];
  const res = await fetch(`${BASE}/api/events?customer=${customer}`, {
    headers: { cookie: s.cookie },
    signal: ctrl.signal,
  });
  if (!res.body) return events;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const timer = setTimeout(() => ctrl.abort(), ms);
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)));
      }
    }
  } catch {
    /* abort */
  } finally {
    clearTimeout(timer);
  }
  return events;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!ADMIN_USER || !ADMIN_PASS) {
    console.error("CHECK_ADMIN_USER ve CHECK_ADMIN_PASS gerekli");
    process.exit(2);
  }
  const tag = Date.now().toString(36);
  const pw = "Gecici-Sifre-123";
  const pw2 = "Yeni-Sifre-45678";

  console.log(`\n[1] Oturumsuz erişim (${BASE})`);
  check("oturumsuz GET /api/zones → 401", (await call(null, "GET", "/api/zones")).status === 401);
  check("oturumsuz GET /api/events → 401", (await call(null, "GET", "/api/events")).status === 401);
  const home = await fetch(BASE + "/", { redirect: "manual" });
  check("oturumsuz / → /login yönlendirmesi", home.status >= 300 && home.status < 400 && (home.headers.get("location") ?? "").includes("/login"));

  console.log("\n[2] Admin kurulum");
  const admin = await login(ADMIN_USER, ADMIN_PASS);
  const cA = await call(admin, "POST", "/api/admin/customers", { name: `Test A ${tag}` });
  const cB = await call(admin, "POST", "/api/admin/customers", { name: `Test B ${tag}` });
  const A = (cA.json?.data as { slug: string }).slug;
  const B = (cB.json?.data as { slug: string }).slug;
  check("iki müşteri oluştu", cA.status === 201 && cB.status === 201);
  check("admin ?customer olmadan /api/zones → 400", (await call(admin, "GET", "/api/zones")).status === 400);

  const zA = await call(admin, "POST", `/api/zones?customer=${A}`, { name: `A Cadde ${tag}` });
  const zB = await call(admin, "POST", `/api/zones?customer=${B}`, { name: `B Cadde ${tag}` });
  const zoneA = (zA.json?.data as { id: string }).id;
  const zoneB = (zB.json?.data as { id: string }).id;
  check("admin her iki müşteriye bölge açtı", zA.status === 201 && zB.status === 201);

  const macB = `B0${tag.padStart(10, "0")}`.slice(0, 12).toUpperCase().replace(/[^0-9A-F]/g, "C");
  const dB = await call(admin, "POST", `/api/devices?customer=${B}`, { mac: macB, zoneSlug: zoneB });
  check("admin B'ye cihaz ekledi", dB.status === 201, dB.json);

  for (const [slug, username, role] of [
    [A, `a-mgr-${tag}`, "manager"],
    [A, `a-view-${tag}`, "viewer"],
    [B, `b-mgr-${tag}`, "manager"],
  ] as const) {
    const u = await call(admin, "POST", `/api/customers/${slug}/users`, { username, role, password: pw });
    check(`kullanıcı ${username} oluştu`, u.status === 201, u.json);
  }

  console.log("\n[3] Müşteri A yöneticisi");
  let aMgr = await login(`a-mgr-${tag}`, pw);
  check("şifre değiştirmeden API → 403", (await call(aMgr, "GET", `/api/zones`)).status === 403);
  const aMgrOld = aMgr;
  aMgr = await changePassword(aMgr, pw, pw2);
  check("şifre değişince eski çerez → 401", (await call(aMgrOld, "GET", "/api/zones")).status === 401);

  const zonesA = await call(aMgr, "GET", "/api/zones");
  const slugsA = (zonesA.json?.data as { id: string }[]).map((z) => z.id);
  check("A yalnızca kendi bölgesini görür", zonesA.status === 200 && slugsA.includes(zoneA) && !slugsA.includes(zoneB), slugsA);
  check("A ?customer=B → 403", (await call(aMgr, "GET", `/api/zones?customer=${B}`)).status === 403);
  check("A, B bölgesini düzenleyemez → 404", (await call(aMgr, "PATCH", `/api/zones/${zoneB}`, { name: "x" })).status === 404);
  check("A, B bölgesine komut veremez → 404", (await call(aMgr, "POST", `/api/zones/${zoneB}/command`, { action: "on" })).status === 404);
  check("A, B bölgesini silemez → 404", (await call(aMgr, "DELETE", `/api/zones/${zoneB}`)).status === 404);
  check("A, B cihazına komut veremez → 404", (await call(aMgr, "POST", `/api/devices/${macB}/command`, { action: "on" })).status === 404);
  check("A, B cihaz telemetrisini okuyamaz → 404", (await call(aMgr, "GET", `/api/devices/${macB}/telemetry`)).status === 404);
  const devA = await call(aMgr, "GET", "/api/devices");
  check("A cihaz listesinde B cihazı yok", !(devA.json?.data as { deviceId: string }[]).some((d) => d.deviceId === macB));
  const claim = await call(aMgr, "POST", "/api/devices", { mac: macB, zoneSlug: zoneA });
  check("A, B'nin MAC'ini sahiplenemez → 409 (sahip açıklanmaz)", claim.status === 409 && !String(claim.json?.error).includes(B), claim.json);
  check("A, bölgeyi B'ye taşıyamaz → 403", (await call(aMgr, "PATCH", `/api/zones/${zoneA}`, { customerSlug: B })).status === 403);
  check('A "all" slug\'lı bölge açamaz → 422', (await call(aMgr, "POST", "/api/zones", { name: "x", slug: "all" })).status === 422);
  const hexSlug = await call(aMgr, "POST", "/api/zones", { name: "x", slug: "a842e3123456" });
  check("A MAC biçimli slug açamaz → 422", hexSlug.status === 422);
  const named = await call(aMgr, "POST", "/api/zones", { name: "All" });
  const namedSlug = (named.json?.data as { id: string } | undefined)?.id;
  check('"All" adlı bölge rezerv olmayan slug alır', named.status === 201 && namedSlug !== "all", namedSlug);
  check("A, B kullanıcılarını listeleyemez → 404", (await call(aMgr, "GET", `/api/customers/${B}/users`)).status === 404);
  check("A admin API'sine erişemez → 403", (await call(aMgr, "GET", "/api/admin/customers")).status === 403);
  check("A global komut veremez → 403", (await call(aMgr, "POST", "/api/admin/command/global", { action: "on" })).status === 403);

  console.log("\n[4] Salt okunur kullanıcı");
  let aView = await login(`a-view-${tag}`, pw);
  aView = await changePassword(aView, pw, pw2);
  check("izleyici bölgeleri okur", (await call(aView, "GET", "/api/zones")).status === 200);
  check("izleyici komut veremez → 403", (await call(aView, "POST", `/api/zones/${zoneA}/command`, { action: "on" })).status === 403);
  check('izleyici "Tüm Sistem" veremez → 403', (await call(aView, "POST", "/api/command/all", { action: "on" })).status === 403);
  check("izleyici bölge açamaz → 403", (await call(aView, "POST", "/api/zones", { name: "x" })).status === 403);
  check("izleyici kullanıcı açamaz → 403", (await call(aView, "POST", `/api/customers/${A}/users`, { username: `x-${tag}`, role: "viewer", password: pw })).status === 403);

  console.log("\n[5] Canlı akış (SSE) izolasyonu");
  let bMgr = await login(`b-mgr-${tag}`, pw);
  bMgr = await changePassword(bMgr, pw, pw2);
  const streamA = collectEvents(aMgr, A, 2500);
  const streamB = collectEvents(bMgr, B, 2500);
  await sleep(400);
  const cmd = await call(aMgr, "POST", `/api/zones/${zoneA}/command`, { action: "dim", value: 42 });
  check("A kendi bölgesine komut verir → 202", cmd.status === 202, cmd.json);
  const allCmd = await call(aMgr, "POST", "/api/command/all", { action: "dim", value: 43 });
  check('A "Tüm Sistem" → 202, yalnızca kendi bölgelerine', allCmd.status === 202 && (allCmd.json?.data as { zones: number }).zones === 2, allCmd.json);
  const [evA, evB] = await Promise.all([streamA, streamB]);
  check("A akışı kendi bölge olayını aldı", evA.some((e) => e.zoneSlug === zoneA && e.brightness === 42), evA);
  check('A akışı kendi "Tüm Sistem" olayını aldı', evA.some((e) => e.scope === "all" && e.brightness === 43));
  check("B akışına A'nın hiçbir olayı düşmedi", evB.length === 0, evB);
  check("olaylar customerId taşımaz", evA.every((e) => !("customerId" in e)));

  console.log("\n[6] Slug yeniden kullanılmaz");
  check("A bölgesini siler", (await call(aMgr, "DELETE", `/api/zones/${zoneA}`)).status === 200);
  const again = await call(aMgr, "POST", "/api/zones", { name: `A Cadde ${tag}` });
  const againSlug = (again.json?.data as { id: string }).id;
  check("aynı isimle yeni bölge farklı slug alır", again.status === 201 && againSlug !== zoneA, againSlug);

  console.log("\n[7] Admin bölge taşıma ve pasifleştirme");
  const move = await call(admin, "PATCH", `/api/zones/${againSlug}`, { customerSlug: B });
  check("admin bölgeyi B'ye taşır", move.status === 200 && (move.json?.data as { movedTo: { slug: string } }).movedTo?.slug === B);
  const zonesB = await call(bMgr, "GET", "/api/zones");
  check("taşınan bölge B'de görünür", (zonesB.json?.data as { id: string }[]).some((z) => z.id === againSlug));
  check("taşınan bölge A'da görünmez", (await call(aMgr, "PATCH", `/api/zones/${againSlug}`, { name: "x" })).status === 404);
  check("admin B'yi pasifleştirir", (await call(admin, "PATCH", `/api/admin/customers/${B}`, { isActive: false })).status === 200);
  check("pasif müşterinin oturumu düşer → 401", (await call(bMgr, "GET", "/api/zones")).status === 401);
  const bLogin = await call(null, "POST", "/api/auth/login", { username: `b-mgr-${tag}`, password: pw2 });
  check("pasif müşteri giriş yapamaz → 403", bLogin.status === 403);

  console.log("\n[8] Hatalı giriş kilidi");
  let last = 0;
  for (let i = 0; i < 6; i++) {
    last = (await call(null, "POST", "/api/auth/login", { username: `a-view-${tag}`, password: "yanlis-sifre-xx" })).status;
  }
  check("5 hatadan sonra kilit → 429", last === 429, last);

  console.log("\n[9] Temizlik");
  for (const slug of [A, B]) {
    const zs = await call(admin, "GET", `/api/zones?customer=${slug}`);
    for (const z of (zs.json?.data as { id: string }[]) ?? []) {
      await call(admin, "DELETE", `/api/zones/${z.id}`);
    }
    const del = await call(admin, "DELETE", `/api/admin/customers/${slug}`);
    check(`müşteri ${slug} silindi`, del.status === 200, del.json);
  }

  console.log(`\nSonuç: ${passes} geçti, ${failures} başarısız`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
