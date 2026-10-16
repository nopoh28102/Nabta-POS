import type { IpcRequest } from "@nabta/contracts";

export interface ApiFailure { code: string; messageAr: string; details?: unknown; }

export async function invoke<T>(request: IpcRequest): Promise<T> {
  try {
    const envelope = await window.nabta.invoke(request) as { ok: true; data: T } | { ok: false; error: ApiFailure };
    if (!envelope.ok) throw envelope.error;
    return envelope.data;
  } catch (error) {
    const candidate = error as Partial<ApiFailure>;
    throw { code: candidate.code ?? "CLIENT_ERROR", messageAr: candidate.messageAr ?? "تعذر تنفيذ العملية", details: candidate.details } satisfies ApiFailure;
  }
}

export function minorFromInput(input: string): number {
  const normalized = input.trim().replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))).replace("٫", ".");
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) throw new Error("اكتب مبلغًا صحيحًا حتى منزلتين عشريتين");
  const [whole = "0", fraction = ""] = normalized.split(".");
  const value = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")));
  if (!Number.isSafeInteger(value) || value > 9_000_000_000_000) throw new Error("المبلغ أكبر من الحد المسموح");
  return value;
}

export function formatMoney(minor: number): string {
  const sign = minor < 0 ? "−" : "";
  const absolute = Math.abs(minor);
  return `${sign}${new Intl.NumberFormat("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(absolute / 100)} ج.م`;
}

export function formatQty(qtyMilli: number, unit: "PIECE" | "WEIGHT"): string {
  return unit === "PIECE" ? `${new Intl.NumberFormat("ar-EG").format(qtyMilli / 1000)} قطعة` : `${new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 3 }).format(qtyMilli / 1000)} كجم`;
}
