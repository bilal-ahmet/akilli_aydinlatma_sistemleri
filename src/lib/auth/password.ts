import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Parola özeti — Node'un yerleşik scrypt'i (native bağımlılık yok; Railway ve
 * Windows'ta derleme sorunu çıkmaz). Biçim: `scrypt$N$r$p$<salt b64>$<hash b64>`.
 * Parametreler özetin içinde saklandığından ileride artırılabilir; eski
 * özetler kendi parametreleriyle doğrulanmaya devam eder.
 *
 * Bu dosya `server-only` import etmez: `scripts/create-admin.ts` gibi Next
 * dışı araçlar da kullanır. İstemciden import edilmez (node:crypto).
 */
const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
// scrypt belleği ≈ 128 * N * r = 32 MiB; Node'un varsayılan üst sınırı tam
// 32 MiB olduğu için sınır açıkça yükseltilir.
const MAXMEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, opts: ScryptOptions, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, keylen, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, { N, r: R, p: P, maxmem: MAXMEM }, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  try {
    const key = await derive(
      password,
      Buffer.from(saltB64, "base64"),
      { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM },
      expected.length,
    );
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/**
 * Kullanıcı bulunamadığında da aynı süreyi harcamak için doğrulanan sahte
 * özet. Böylece yanıt süresinden "bu kullanıcı adı var mı" anlaşılmaz.
 */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("fener-dummy-password");
  await verifyPassword(password, await dummyHash);
}
