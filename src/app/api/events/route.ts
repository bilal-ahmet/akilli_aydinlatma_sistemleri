import { onLiveEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/events — Server-Sent Events. MQTT'den gelen status mesajlarını
 * (ve optimistic komut olaylarını) dashboard'a push eder. Native Next.js
 * route handler ile çalışır; custom server gerekmez.
 */
export async function GET(req: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // İlk yorum satırı: bağlantıyı aç ve proxy buffer'larını flush et.
      controller.enqueue(encoder.encode(": connected\n\n"));

      const unsubscribe = onLiveEvent(send);

      // 25sn'de bir heartbeat (idle bağlantı kopmasın).
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, 25_000);

      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* zaten kapalı */
        }
      };

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
