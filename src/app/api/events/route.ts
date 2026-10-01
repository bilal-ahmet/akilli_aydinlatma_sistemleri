import { onLiveEvent } from "@/lib/events";
import { onDomainEvent, type DomainEvent } from "@/lib/domainEvents";
import { authorizeScope } from "@/lib/auth/guard";
import { peekTenancy } from "@/lib/tenancy";
import type { LiveEvent } from "@/types/lighting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/events?customer=<slug> — Server-Sent Events. MQTT'den gelen status
 * mesajlarını (ve optimistic komut olaylarını) dashboard'a push eder. Native
 * Next.js route handler ile çalışır; custom server gerekmez.
 *
 * Çok kiracılık: yalnızca `customerId`'si bu panelin müşterisi olan olaylar
 * iletilir; `customerId` istemciye gönderilmez. Uzun ömürlü akışta oturum
 * her heartbeat'te yeniden kontrol edilir: kullanıcı/müşteri pasifleşirse ya
 * da şifre değişirse akış kapanır.
 */
export async function GET(req: Request) {
  const ctx = await authorizeScope(req, "read");
  if (ctx instanceof Response) return ctx;
  const customerId = ctx.customer.id;
  const userId = ctx.user.id;
  const startTv = peekTenancy()?.users.get(userId)?.tokenVersion;

  const stillAllowed = () => {
    const idx = peekTenancy();
    if (!idx) return true;
    const u = idx.users.get(userId);
    if (!u || !u.isActive || u.tokenVersion !== startTv) return false;
    const c = idx.customersById.get(customerId);
    if (!c) return false;
    if (u.role === "admin") return true;
    return c.isActive && u.customerId === customerId;
  };

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: LiveEvent) => {
        if (event.customerId !== customerId) return;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { customerId: _omit, ...pub } = event;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(pub)}\n\n`));
      };

      // Arıza alan olayları İSİMLİ SSE olayı olarak gider (`event: fault`).
      // Tarayıcıdaki `EventSource.onmessage` isimli olayları almaz → web
      // paneli etkilenmez; mobil istemci olay adına göre ayrıştırır.
      const sendDomain = (event: DomainEvent) => {
        if (event.customerId !== customerId) return;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { customerId: _omit, ...pub } = event;
        controller.enqueue(encoder.encode(`event: fault\ndata: ${JSON.stringify(pub)}\n\n`));
      };

      // İlk yorum satırı: bağlantıyı aç ve proxy buffer'larını flush et.
      controller.enqueue(encoder.encode(": connected\n\n"));

      const unsubscribe = onLiveEvent(send);
      const unsubscribeDomain = onDomainEvent(sendDomain);

      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribeDomain();
        try {
          controller.close();
        } catch {
          /* zaten kapalı */
        }
      };

      // 25sn'de bir heartbeat (idle bağlantı kopmasın) + oturum kontrolü.
      const heartbeat = setInterval(() => {
        if (!stillAllowed()) return close();
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, 25_000);

      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
