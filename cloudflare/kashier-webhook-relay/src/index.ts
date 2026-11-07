export interface Env {
  EVENTS: D1Database;
  KASHIER_TEST_PAYMENT_API_KEY: string;
  KASHIER_LIVE_PAYMENT_API_KEY: string;
  RELAY_BEARER_TOKEN: string;
}

type KashierPayload = { event?: unknown; data?: Record<string, unknown> };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)));
  return [...signature].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function fixedTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) difference |= (a[index % a.length] ?? 0) ^ (b[index % b.length] ?? 0);
  return difference === 0;
}

async function webhookSignatureValid(data: Record<string, unknown> | undefined, signature: string | null, key: string): Promise<boolean> {
  if (!data || !signature) return false;
  const signatureKeys = Array.isArray(data.signatureKeys) ? data.signatureKeys.filter((item): item is string => typeof item === "string").sort() : [];
  if (!signatureKeys.length) return false;
  const signed = signatureKeys.map((name) => `${name}=${encodeURIComponent(String(data[name] ?? ""))}`).join("&");
  return fixedTimeEqual(await hmacHex(key, signed), signature.toLowerCase());
}

function requireRelayToken(request: Request, env: Env): boolean {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return fixedTimeEqual(token, env.RELAY_BEARER_TOKEN);
}

function paymentReturnPage(): Response {
  return new Response(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>اكتمل الرجوع إلى نبته</title><style>body{font-family:Segoe UI,Tahoma,Arial,sans-serif;background:#f8fafc;color:#0f172a;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:520px;margin:24px;padding:32px;border-radius:16px;background:white;box-shadow:0 10px 30px #0f172a18;text-align:center}.icon{font-size:42px}h1{color:#047857}p{line-height:1.8;color:#475569}</style><main class="card"><div class="icon">✓</div><h1>تمت العودة من بوابة الدفع</h1><p>ارجع إلى برنامج نبته لإتمام التحقق من حالة العملية. لا تُغلق العملية أو تعيد المحاولة قبل ظهور النتيجة داخل البرنامج.</p></main></html>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/return") return paymentReturnPage();
    const match = /^\/kashier\/(TEST|LIVE)$/.exec(url.pathname);
    if (request.method === "POST" && match) {
      let payload: KashierPayload;
      try { payload = await request.json() as KashierPayload; } catch { return json({ error: "invalid_json" }, 400); }
      const environment = match[1]!;
      const key = environment === "LIVE" ? env.KASHIER_LIVE_PAYMENT_API_KEY : env.KASHIER_TEST_PAYMENT_API_KEY;
      const signature = request.headers.get("x-kashier-signature");
      if (!await webhookSignatureValid(payload.data, signature, key)) return json({ error: "invalid_signature" }, 401);
      const data = payload.data ?? {};
      const eventType = String(payload.event ?? "unknown");
      const transactionId = typeof data.transactionId === "string" ? data.transactionId : null;
      const merchantOrderId = typeof data.merchantOrderId === "string" ? data.merchantOrderId : null;
      const eventKey = `${transactionId ?? "none"}::${String(data.status ?? "none")}::${eventType}`;
      const inserted = await env.EVENTS.prepare(`INSERT OR IGNORE INTO kashier_events(environment, event_key, event_type, merchant_order_id, transaction_id, signature, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(environment, eventKey, eventType, merchantOrderId, transactionId, signature, JSON.stringify(payload)).run();
      return new Response(null, { status: inserted.meta.changes ? 200 : 409 });
    }
    if (request.method === "GET" && url.pathname === "/events") {
      if (!requireRelayToken(request, env)) return json({ error: "unauthorized" }, 401);
      const after = Math.max(0, Number(url.searchParams.get("after") ?? "0") || 0);
      const rows = await env.EVENTS.prepare(`SELECT id, environment, signature, payload FROM kashier_events WHERE delivered_at IS NULL AND id > ? ORDER BY id LIMIT 100`).bind(after).all<{ id: number; environment: "TEST" | "LIVE"; signature: string; payload: string }>();
      return json({ events: rows.results.map((row) => ({ id: row.id, environment: row.environment, signature: row.signature, payload: JSON.parse(row.payload) })), nextAfter: rows.results.at(-1)?.id ?? after });
    }
    if (request.method === "POST" && /^\/events\/\d+\/ack$/.test(url.pathname)) {
      if (!requireRelayToken(request, env)) return json({ error: "unauthorized" }, 401);
      const id = Number(url.pathname.split("/")[2]);
      await env.EVENTS.prepare("UPDATE kashier_events SET delivered_at = datetime('now') WHERE id = ?").bind(id).run();
      return json({ acknowledged: true });
    }
    return json({ error: "not_found" }, 404);
  },
};
