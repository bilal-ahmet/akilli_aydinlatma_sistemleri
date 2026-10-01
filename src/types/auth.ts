import { z } from "zod";
import {
  CUSTOMER_ROLES,
  PASSWORD_MAX,
  PASSWORD_MIN,
  USERNAME_RE,
  type Role,
} from "@/lib/auth/roles";

/** Giriş, hesap, müşteri ve kullanıcı yönetimi gövde şemaları. */

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Kullanıcı adı gerekli").max(64),
  password: z.string().min(1, "Şifre gerekli").max(PASSWORD_MAX),
});

// ── Mobil oturum (Bearer) ─────────────────────────────────────
export const MOBILE_PLATFORMS = ["android", "ios"] as const;

/** POST /api/auth/token — mobil giriş. */
export const tokenRequestSchema = loginSchema.extend({
  deviceName: z.string().trim().max(100).optional(),
  platform: z.enum(MOBILE_PLATFORMS).optional(),
});

/** POST /api/auth/refresh */
export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(200),
});

/** POST /api/auth/logout — mobil, access token'ı süresi dolmuşsa refresh ile iptal eder. */
export const logoutRequestSchema = z.object({
  refreshToken: z.string().min(1).max(200).optional(),
});

/** Mobil token çifti. Tarihler ISO (UTC). */
export type TokenPair = {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
};

/**
 * Oturumdaki kullanıcının istemciye verilen özeti (`GET /api/auth/me`).
 * Mobil rol/ekran kararlarını YALNIZCA bundan verir; token'ı çözmez.
 */
export type Me = {
  id: string;
  username: string;
  displayName: string | null;
  role: Role;
  canWrite: boolean;
  mustChangePassword: boolean;
  /** Müşteri kullanıcısının müşterisi; admin için null. */
  customer: { id: string; slug: string; name: string; isActive: boolean } | null;
};

const password = z
  .string()
  .min(PASSWORD_MIN, `Şifre en az ${PASSWORD_MIN} karakter olmalı`)
  .max(PASSWORD_MAX);

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, "Mevcut şifre gerekli").max(PASSWORD_MAX),
  newPassword: password,
});

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

export const customerCreateSchema = z.object({
  name: z.string().trim().min(1, "Müşteri adı zorunlu").max(150),
  slug: z.string().trim().max(100).optional(),
  contactName: optionalText(150),
  contactEmail: optionalText(150),
  contactPhone: optionalText(50),
  notes: optionalText(2000),
});

export const customerUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(150).optional(),
    contactName: z.string().trim().max(150).optional(),
    contactEmail: z.string().trim().max(150).optional(),
    contactPhone: z.string().trim().max(50).optional(),
    notes: z.string().trim().max(2000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "En az bir alan güncellenmeli" });

export const userCreateSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(USERNAME_RE, "Kullanıcı adı 3-64 karakter: küçük harf, rakam, . _ -"),
  displayName: optionalText(150),
  role: z.enum(CUSTOMER_ROLES),
  password,
});

export const userUpdateSchema = z
  .object({
    displayName: z.string().trim().max(150).optional(),
    role: z.enum(CUSTOMER_ROLES).optional(),
    isActive: z.boolean().optional(),
    /** Şifre sıfırlama: yeni şifre + ilk girişte değiştirme zorunluluğu. */
    password: password.optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "En az bir alan güncellenmeli" });
