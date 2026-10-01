import { ok, fail } from "@/lib/api/respond";
import { loginSchema } from "@/types/auth";
import { authenticate } from "@/lib/auth/credentials";
import { writeSessionCookie } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * POST /api/auth/login — WEB girişi: kullanıcı adı + şifre ile çerez oturumu
 * açar. Doğrulama kuralları mobil girişle ortaktır (lib/auth/credentials.ts).
 * Mobil uygulama bunun yerine `POST /api/auth/token` kullanır.
 */
export async function POST(req: Request) {
  const parsed = loginSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Kullanıcı adı ve şifre gerekli", 422);

  const result = await authenticate(req, parsed.data, { kind: "web" });
  if ("response" in result) return result.response;
  const { user } = result;

  await writeSessionCookie({
    id: user.id,
    role: user.role as "admin" | "manager" | "viewer",
    customerId: user.customerId,
    tokenVersion: user.tokenVersion,
  });

  let redirect = "/";
  if (user.mustChangePassword) redirect = "/hesap";
  return ok({ redirect });
}
