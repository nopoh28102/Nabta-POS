interface Env {
  /** Private Cloudflare Tunnel origin for the primary Nabta device. */
  NABTA_MOBILE_ORIGIN?: string;
  /** Kept only in Cloudflare; never sent to or stored by the APK. */
  NABTA_TERMINAL_RELAY_KEY?: string;
}

const allowed = (path: string, method: string) =>
  (path === "/v1/relay/health" && method === "GET") ||
  (path === "/v1/auth/login" && method === "POST") ||
  (path === "/v1/auth/logout" && method === "POST") ||
  (path === "/v1/auth/me" && method === "GET") ||
  (path === "/v1/catalog" && method === "GET") ||
  (path === "/v1/stock-lots/expiry-registration" && method === "POST");

function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Nabta-Relay-Version", "2");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function unavailable(code: string): Response {
  return secure(Response.json({ code, message: "Mobile origin is temporarily unavailable" }, { status: 503 }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!allowed(url.pathname, request.method)) return secure(Response.json({ code: "NOT_FOUND" }, { status: 404 }));
    if (url.pathname === "/v1/relay/health") {
      return secure(Response.json({ status: "ok", service: "nabta-expiry-relay", apiVersion: 2 }));
    }
    if (!env.NABTA_MOBILE_ORIGIN || !env.NABTA_TERMINAL_RELAY_KEY) return secure(Response.json({ code: "MOBILE_RELAY_UNAVAILABLE", message: "خدمة الهاتف غير مهيأة" }, { status: 503 }));
    const body = request.method === "GET" ? undefined : request.body;
    const headers = new Headers(request.headers);
    headers.delete("host"); headers.delete("cookie"); headers.delete("cf-connecting-ip");
    headers.set("x-nabta-terminal-relay-key", env.NABTA_TERMINAL_RELAY_KEY);
    let upstream: URL;
    try {
      const origin = new URL(env.NABTA_MOBILE_ORIGIN);
      if (origin.protocol !== "https:") return unavailable("MOBILE_ORIGIN_INVALID");
      upstream = new URL(url.pathname + url.search, origin);
    } catch {
      return unavailable("MOBILE_ORIGIN_INVALID");
    }
    try {
      const response = await fetch(upstream, { method: request.method, headers, body, redirect: "manual" });
      if ([502, 503, 504, 530].includes(response.status)) return unavailable("MOBILE_ORIGIN_UNAVAILABLE");
      return secure(response);
    } catch {
      return secure(Response.json({ code: "MOBILE_ORIGIN_UNAVAILABLE", message: "تعذر الوصول إلى الجهاز الرئيسي؛ سيُعاد الإرسال من التطبيق عند عودة الاتصال." }, { status: 503 }));
    }
  },
};
