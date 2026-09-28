import type { CustomerRole, Role } from "@/lib/auth/roles";
import type { LiveSummary } from "@/app/_lib/types";

/** Admin müşteri listesi kartı. */
export type CustomerOverview = {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
  createdAt: string | null;
  zoneCount: number;
  deviceCount: number;
  onlineDevices: number;
  userCount: number;
  summary: LiveSummary;
};

export type CustomerUser = {
  id: string;
  username: string;
  displayName: string | null;
  role: CustomerRole;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string | null;
};

export type AuditEntry = {
  id: number;
  at: string;
  username: string | null;
  action: string;
  target: string | null;
  detail: unknown;
  ip: string | null;
};

/** Oturumdaki kullanıcı — istemciye güvenle geçirilebilen alanlar. */
export type Viewer = {
  id: string;
  username: string;
  displayName: string | null;
  role: Role;
};
