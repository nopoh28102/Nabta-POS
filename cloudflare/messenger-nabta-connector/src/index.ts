import { submitMessengerOrder, type MessengerOrderRequest } from "./nabta";

interface Env {
  NABTA_COMMERCE_ORIGIN?: string;
  NABTA_COMMERCE_SHARED_SECRET?: string;
  NABTA_BOT_CONNECTOR_TOKEN?: string;
}

function unauthorized(): Response {
  return Response.json({ code: "BOT_CONNECTOR_AUTH_REQUIRED", messageAr: "صلاحية ربط البوت مطلوبة." }, { status: 401 });
}

function requestToken(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Optional protected HTTP adapter for an existing bot that cannot import the
 * TypeScript helper directly.  The bot itself must continue to verify Meta's
 * webhook signature before it invokes this endpoint.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/internal/nabta/orders") return new Response("Not Found", { status: 404 });
    if (!env.NABTA_BOT_CONNECTOR_TOKEN || requestToken(request) !== env.NABTA_BOT_CONNECTOR_TOKEN) return unauthorized();
    let order: MessengerOrderRequest;
    try { order = await request.json() as MessengerOrderRequest; }
    catch { return Response.json({ code: "ORDER_JSON_INVALID", messageAr: "بيانات الطلب غير صالحة." }, { status: 400 }); }
    if (!order || typeof order !== "object" || !Array.isArray(order.lines) || order.lines.length === 0) {
      return Response.json({ code: "ORDER_INVALID", messageAr: "تفاصيل الطلب غير مكتملة." }, { status: 422 });
    }
    try {
      const upstream = await submitMessengerOrder(env, order);
      return new Response(upstream.body, { status: upstream.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ code: "NABTA_UNAVAILABLE", messageAr: "تعذر الوصول إلى نبتة الآن؛ لا تؤكد الطلب للعميل قبل إعادة المحاولة." }, { status: 503 });
    }
  },
};
