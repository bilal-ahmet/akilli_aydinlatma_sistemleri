import { NextResponse } from "next/server";

/** Tutarlı JSON başarı/hata zarfları. */

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

/**
 * Hata metni seçimi: admin teknik metni (MAC, kanal, slug…), müşteri
 * kullanıcıları sade metni görür — panelin `useTechnical` kuralıyla aynı.
 */
export function msg(user: { role: string }, technical: string, plain: string): string {
  return user.role === "admin" ? technical : plain;
}

export function fail(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ ok: false, error: message, details }, { status });
}
