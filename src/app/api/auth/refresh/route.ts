import { ok, fail } from "@/lib/api/respond";
import { refreshRequestSchema } from "@/types/auth";
import { refreshMobileSession } from "@/lib/auth/mobileSession";
import { toMe } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * POST /api/auth/refresh — { refreshToken } → yeni token çifti (rotasyon).
 * Eski refresh token artık geçersizdir (kısa tolerans penceresi hariç, bkz.
 * lib/auth/mobileSession.ts). 401 → uygulama yerel oturumu silip girişe döner.
 */
export async function POST(req: Request) {
  const parsed = refreshRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("refreshToken gerekli", 422);

  const result = await refreshMobileSession(req, parsed.data.refreshToken);
  if (!result.ok) return fail(result.message, 401);
  return ok({ ...result.pair, user: toMe(result.user) });
}
