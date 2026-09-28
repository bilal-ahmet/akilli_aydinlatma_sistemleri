import { config } from "dotenv";
config({ path: ".env.local" });

import { createInterface } from "node:readline/promises";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/lib/db/schema";
import { hashPassword } from "../src/lib/auth/password";
import { PASSWORD_MIN, USERNAME_RE, normalizeUsername } from "../src/lib/auth/roles";

/**
 * Platform yöneticisi (admin) hesabı açar ya da şifresini sıfırlar.
 *
 *   npm run auth:create-admin -- <kullanici>            # yeni admin
 *   npm run auth:create-admin -- <kullanici> --reset    # mevcut admin'in şifresini sıfırla
 *
 * Şifre `ADMIN_PASSWORD` ortam değişkeninden, yoksa terminalden okunur.
 * DATABASE_URL `.env.local`'den gelir — canlı Neon'a bağlanıyorsa işlem
 * canlıda yapılır.
 *
 * Çalışan sunucu yeni kullanıcıyı ilk girişte index'e alır (login route'u
 * tenancy'yi tazeler). Şifre sıfırlamada token sürümü artar ve eski
 * oturumlar düşer, ancak sunucunun index'i sıfırlamayı bir sonraki CRUD ya da
 * yeniden başlatmaya kadar görmez.
 */
async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const raw = args.find((a) => !a.startsWith("--"));
  if (!raw) {
    console.error("Kullanım: npm run auth:create-admin -- <kullanici> [--reset]");
    process.exit(1);
  }
  const username = normalizeUsername(raw);
  if (!USERNAME_RE.test(username)) {
    console.error("Geçersiz kullanıcı adı (3-64 karakter: küçük harf, rakam, . _ -)");
    process.exit(1);
  }

  let password = process.env.ADMIN_PASSWORD ?? "";
  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question(`Şifre (en az ${PASSWORD_MIN} karakter): `);
    rl.close();
  }
  if (password.length < PASSWORD_MIN) {
    console.error(`Şifre en az ${PASSWORD_MIN} karakter olmalı`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  const [existing] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);

  const passwordHash = await hashPassword(password);

  if (existing) {
    if (!reset) {
      console.error(`"${username}" zaten var. Şifre sıfırlamak için --reset ekleyin.`);
      await pool.end();
      process.exit(1);
    }
    if (existing.role !== "admin") {
      console.error(`"${username}" bir admin değil (${existing.role}); bu script yalnızca admin'i sıfırlar.`);
      await pool.end();
      process.exit(1);
    }
    await db
      .update(schema.users)
      .set({
        passwordHash,
        isActive: true,
        mustChangePassword: false,
        tokenVersion: sql`${schema.users.tokenVersion} + 1`,
      })
      .where(eq(schema.users.id, existing.id));
    console.log(`✓ "${username}" admin şifresi sıfırlandı.`);
  } else {
    await db.insert(schema.users).values({
      username,
      passwordHash,
      role: "admin",
      customerId: null,
      displayName: "Yönetici",
    });
    console.log(`✓ Admin "${username}" oluşturuldu.`);
  }

  await db.insert(schema.auditLog).values({
    username,
    action: existing ? "admin.password_reset_cli" : "admin.create_cli",
    target: username,
  });

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
