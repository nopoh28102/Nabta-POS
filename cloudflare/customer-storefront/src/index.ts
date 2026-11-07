interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  NABTA_COMMERCE_ORIGIN?: string;
  NABTA_COMMERCE_SHARED_SECRET?: string;
  /** Shared only with the verified Messenger Worker; never exposed to browsers. */
  NABTA_MESSENGER_INTERNAL_SECRET?: string;
}

import { productImages } from "./product-images";

function isAllowedCommercePath(pathname: string, method: string): boolean {
  if (pathname === "/v1/commerce/catalog") return method === "GET";
  if (pathname === "/v1/commerce/orders") return method === "POST";
  // The opaque per-order tracking token is required and checked by Nabta.
  // This route never exposes the customer profile or store admin operations.
  return method === "GET" && /^\/v1\/commerce\/orders\/[0-9a-f-]{36}$/i.test(pathname);
}

function isMessengerInternalOrder(pathname: string, method: string, request: Request, env: Env): boolean {
  if (pathname !== "/v1/commerce/messenger/orders" || method !== "POST") return false;
  const expected = env.NABTA_MESSENGER_INTERNAL_SECRET;
  const received = request.headers.get("X-Nabta-Messenger-Internal");
  return Boolean(expected && received && received.length === expected.length && received === expected);
}

function securityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data: https://res.cloudinary.com; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function unavailable(): Response {
  return Response.json({ code: "COMMERCE_UNAVAILABLE", messageAr: "خدمة الطلبات غير مفعلة حالياً. حاول مرة أخرى لاحقاً." }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

async function decorateCatalogResponse(response: Response): Promise<Response> {
  const body = await response.json().catch(() => null) as { products?: unknown } | null;
  if (!body || !Array.isArray(body.products)) return response;

  const products = body.products.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const product = value as Record<string, unknown>;
    const { barcodes, ...publicProduct } = product;
    const imageUrl = Array.isArray(barcodes)
      ? barcodes.find((barcode): barcode is string => typeof barcode === "string" && Boolean(productImages[barcode]))
      : undefined;
    return imageUrl ? { ...publicProduct, imageUrl: productImages[imageUrl] } : publicProduct;
  });

  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ ...body, products }), { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestUrl = new URL(request.url);
    if (!requestUrl.pathname.startsWith("/api/")) {
      return securityHeaders(await env.ASSETS.fetch(request));
    }
    const upstreamPath = requestUrl.pathname.slice(4);
    const isMessengerOrder = isMessengerInternalOrder(upstreamPath, request.method, request, env);
    if (!isAllowedCommercePath(upstreamPath, request.method) && !isMessengerOrder) return new Response("Not Found", { status: 404 });
    if (!env.NABTA_COMMERCE_ORIGIN || !env.NABTA_COMMERCE_SHARED_SECRET) return unavailable();
    const upstream = new URL(upstreamPath + requestUrl.search, env.NABTA_COMMERCE_ORIGIN);
    const headers = new Headers(request.headers);
    headers.set("X-Nabta-Commerce-Key", env.NABTA_COMMERCE_SHARED_SECRET);
    // The private marker is consumed at this Worker boundary and never reaches
    // Nabta or the public internet.
    headers.delete("X-Nabta-Messenger-Internal");
    headers.delete("host");
    headers.delete("cookie");
    const response = await fetch(upstream, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : request.body,
      redirect: "manual",
    });
    const safeResponse = upstreamPath === "/v1/commerce/catalog" && request.method === "GET" && response.ok
      ? await decorateCatalogResponse(response)
      : response;
    const responseHeaders = new Headers(safeResponse.headers);
    responseHeaders.set("Cache-Control", "no-store");
    responseHeaders.set("X-Content-Type-Options", "nosniff");
    return new Response(safeResponse.body, { status: safeResponse.status, statusText: safeResponse.statusText, headers: responseHeaders });
  },
};
