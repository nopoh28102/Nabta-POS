/**
 * Import this small adapter into the existing Messenger Worker after the bot
 * has collected and validated the customer's name, phone, address and cart.
 * The Commerce secret stays in Cloudflare Worker secrets; it is never sent to
 * Messenger, the browser, Android, or the Nabta renderer.
 */
export interface NabtaMessengerEnv {
  NABTA_COMMERCE_ORIGIN?: string;
  NABTA_COMMERCE_SHARED_SECRET?: string;
}

export interface MessengerOrderLine {
  productId: string;
  qtyMilli: number;
  saleUnit?: "UNIT" | "PACKAGE" | "CARTON";
}

export interface MessengerOrderRequest {
  clientOrderId: string;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  notes?: string;
  lines: MessengerOrderLine[];
}

export async function submitMessengerOrder(env: NabtaMessengerEnv, order: MessengerOrderRequest): Promise<Response> {
  if (!env.NABTA_COMMERCE_ORIGIN || !env.NABTA_COMMERCE_SHARED_SECRET) {
    throw new Error("Nabta Messenger connector is not configured with the secure origin and shared secret.");
  }
  const endpoint = new URL("/v1/commerce/messenger/orders", env.NABTA_COMMERCE_ORIGIN);
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Nabta-Commerce-Key": env.NABTA_COMMERCE_SHARED_SECRET,
    },
    body: JSON.stringify(order),
  });
}
