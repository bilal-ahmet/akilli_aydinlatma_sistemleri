"use client";

import { createContext, useCallback, useContext } from "react";
import type { Role } from "@/lib/auth/roles";

/**
 * Müşteri paneli bağlamı. `/c/[customer]/layout.tsx` sunucuda erişimi
 * doğruladıktan sonra kurar; panel içindeki tüm bileşenler API çağrılarını
 * `useApi()` ile bu müşteriye kapsamlar.
 *
 * `canWrite` yalnızca kullanım kolaylığıdır (salt okunur hesapta kontrolleri
 * pasif gösterir) — asıl yetki sunucuda (lib/auth/guard.ts) kontrol edilir.
 */
export type PanelInfo = {
  customerSlug: string;
  customerName: string;
  role: Role;
  canWrite: boolean;
  /** Admin başka bir müşterinin panelini görüntülüyor. */
  isAdminView: boolean;
  /**
   * Teknik dil (DALI kanalı, MAC, D4i, sürücü, ham hata metni…) gösterilsin
   * mi? Yalnızca admin; müşteri kullanıcıları sade dil görür (bkz. useTechnical).
   */
  technical: boolean;
  /** Yalnızca admin: bölge taşıma seçicisi için tüm müşteriler. */
  customers: { slug: string; name: string }[];
};

const PanelContext = createContext<PanelInfo | null>(null);

export function PanelProvider({
  value,
  children,
}: {
  value: PanelInfo;
  children: React.ReactNode;
}) {
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

export function usePanel(): PanelInfo {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error("usePanel yalnızca müşteri paneli içinde kullanılabilir");
  return ctx;
}

/**
 * Metin seçimi: admin teknik terimleri görür, müşteri kullanıcıları sade dil.
 * Kullanım: `const technical = useTechnical(); technical ? "Kanal 3" : "Lamba 3"`.
 */
export function useTechnical(): boolean {
  return usePanel().technical;
}

/** `/api/...` yoluna `customer=<slug>` sorgu parametresini ekler. */
export function withCustomer(path: string, customerSlug: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}customer=${encodeURIComponent(customerSlug)}`;
}

/**
 * Panelin müşterisine kapsamlanmış API yolu üretir. Koleksiyon route'ları
 * (`/api/zones`, `/api/devices`, `/api/summary`, `/api/events`…) için
 * zorunludur; kaynak route'larında zararsızdır.
 */
export function useApi(): (path: string) => string {
  const { customerSlug } = usePanel();
  return useCallback((path: string) => withCustomer(path, customerSlug), [customerSlug]);
}
