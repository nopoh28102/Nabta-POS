export interface Env {
  NABTA_TERMINAL_ORIGIN: string;
  NABTA_TERMINAL_RELAY_KEY: string;
}

function denied(): Response {
  return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const key = request.headers.get("x-nabta-terminal-key") ?? "";
    if (!env.NABTA_TERMINAL_RELAY_KEY || key.length !== env.NABTA_TERMINAL_RELAY_KEY.length || key !== env.NABTA_TERMINAL_RELAY_KEY) return denied();
    const incoming = new URL(request.url);
    if (!incoming.pathname.startsWith("/v1/")) return new Response("Not Found", { status: 404 });
    const target = new URL(incoming.pathname + incoming.search, env.NABTA_TERMINAL_ORIGIN);
    const headers = new Headers(request.headers);
    headers.delete("x-nabta-terminal-key");
    headers.set("x-nabta-terminal-relay-key", env.NABTA_TERMINAL_RELAY_KEY);
    headers.set("x-forwarded-proto", "https");
    return fetch(target, { method: request.method, headers, body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body, redirect: "manual" });
  },
};
