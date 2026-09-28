import { ok } from "@/lib/api/respond";
import { clearSessionCookie } from "@/lib/auth/session";

export const runtime = "nodejs";

// POST /api/auth/logout — oturum çerezini siler.
export async function POST() {
  await clearSessionCookie();
  return ok({ redirect: "/login" });
}
