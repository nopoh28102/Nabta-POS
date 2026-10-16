export const MILLI_PER_UNIT = 1_000n;
export const MAX_SAFE_MINOR = 9_000_000_000_000n;

export type RoundingMode = "HALF_UP";

export interface PricedLine {
  lineId: string;
  unitPriceMinor: bigint;
  qtyMilli: bigint;
}

export interface AllocatedLine extends PricedLine {
  grossMinor: bigint;
  discountMinor: bigint;
  netMinor: bigint;
}

export function assertNonNegative(value: bigint, field: string): void {
  if (value < 0n) throw new RangeError(`${field} must be non-negative`);
}

export function assertPositive(value: bigint, field: string): void {
  if (value <= 0n) throw new RangeError(`${field} must be positive`);
}

export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  if (numerator < 0n) return -roundHalfUp(-numerator, denominator);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

export function calculateLineMinor(unitPriceMinor: bigint, qtyMilli: bigint): bigint {
  assertNonNegative(unitPriceMinor, "unitPriceMinor");
  assertPositive(qtyMilli, "qtyMilli");
  return roundHalfUp(unitPriceMinor * qtyMilli, MILLI_PER_UNIT);
}

export function allocateInvoiceDiscount(
  lines: readonly PricedLine[],
  discountMinor: bigint,
): AllocatedLine[] {
  if (lines.length === 0) throw new RangeError("sale requires at least one line");
  assertNonNegative(discountMinor, "discountMinor");
  const withGross = lines.map((line) => ({ ...line, grossMinor: calculateLineMinor(line.unitPriceMinor, line.qtyMilli) }));
  const grossTotal = withGross.reduce((sum, line) => sum + line.grossMinor, 0n);
  if (discountMinor > grossTotal) throw new RangeError("discount exceeds invoice gross");
  if (discountMinor === 0n || grossTotal === 0n) {
    return withGross.map((line) => ({ ...line, discountMinor: 0n, netMinor: line.grossMinor }));
  }

  const shares = withGross.map((line) => {
    const numerator = discountMinor * line.grossMinor;
    return {
      ...line,
      discountMinor: numerator / grossTotal,
      remainder: numerator % grossTotal,
    };
  });
  let remaining = discountMinor - shares.reduce((sum, line) => sum + line.discountMinor, 0n);
  const remainderOrder = [...shares].sort((a, b) => {
    if (a.remainder === b.remainder) return a.lineId.localeCompare(b.lineId, "en");
    return a.remainder > b.remainder ? -1 : 1;
  });
  for (const target of remainderOrder) {
    if (remaining === 0n) break;
    target.discountMinor += 1n;
    remaining -= 1n;
  }
  const allocations = shares
    .map(({ remainder: _remainder, ...line }) => ({ ...line, netMinor: line.grossMinor - line.discountMinor }))
    .sort((a, b) => lines.findIndex((line) => line.lineId === a.lineId) - lines.findIndex((line) => line.lineId === b.lineId));
  if (allocations.reduce((sum, line) => sum + line.discountMinor, 0n) !== discountMinor) {
    throw new Error("discount allocation invariant failed");
  }
  return allocations;
}

export function allocateReturnValue(params: {
  originalValueMinor: bigint;
  soldQtyMilli: bigint;
  previouslyReturnedQtyMilli: bigint;
  previouslyRefundedMinor: bigint;
  returnQtyMilli: bigint;
}): bigint {
  const { originalValueMinor, soldQtyMilli, previouslyReturnedQtyMilli, previouslyRefundedMinor, returnQtyMilli } = params;
  assertNonNegative(originalValueMinor, "originalValueMinor");
  assertPositive(soldQtyMilli, "soldQtyMilli");
  assertNonNegative(previouslyReturnedQtyMilli, "previouslyReturnedQtyMilli");
  assertNonNegative(previouslyRefundedMinor, "previouslyRefundedMinor");
  assertPositive(returnQtyMilli, "returnQtyMilli");
  if (previouslyReturnedQtyMilli + returnQtyMilli > soldQtyMilli) throw new RangeError("return exceeds sold quantity");
  if (previouslyRefundedMinor > originalValueMinor) throw new RangeError("previous refund exceeds original value");
  if (previouslyReturnedQtyMilli + returnQtyMilli === soldQtyMilli) {
    return originalValueMinor - previouslyRefundedMinor;
  }
  const cumulative = roundHalfUp(originalValueMinor * (previouslyReturnedQtyMilli + returnQtyMilli), soldQtyMilli);
  const current = cumulative - previouslyRefundedMinor;
  if (current < 0n || previouslyRefundedMinor + current > originalValueMinor) {
    throw new Error("return allocation invariant failed");
  }
  return current;
}

export function allocateProportionally<T extends { id: string; weight: bigint }>(
  totalMinor: bigint,
  items: readonly T[],
): Map<string, bigint> {
  assertNonNegative(totalMinor, "totalMinor");
  if (items.length === 0) return new Map();
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0n);
  if (totalWeight <= 0n) throw new RangeError("allocation weights must be positive in total");
  const rows = items.map((item) => {
    assertNonNegative(item.weight, "weight");
    const numerator = totalMinor * item.weight;
    return { id: item.id, value: numerator / totalWeight, remainder: numerator % totalWeight };
  });
  let remainder = totalMinor - rows.reduce((sum, row) => sum + row.value, 0n);
  rows.sort((a, b) => a.remainder === b.remainder ? a.id.localeCompare(b.id, "en") : a.remainder > b.remainder ? -1 : 1);
  for (const row of rows) {
    if (remainder === 0n) break;
    row.value += 1n;
    remainder -= 1n;
  }
  return new Map(rows.map((row) => [row.id, row.value]));
}

export function calculateInventoryIssueValue(
  inventoryValueMinor: bigint,
  availableQtyMilli: bigint,
  issueQtyMilli: bigint,
): bigint {
  assertNonNegative(inventoryValueMinor, "inventoryValueMinor");
  assertPositive(availableQtyMilli, "availableQtyMilli");
  assertPositive(issueQtyMilli, "issueQtyMilli");
  if (issueQtyMilli > availableQtyMilli) throw new RangeError("issue exceeds available quantity");
  if (issueQtyMilli === availableQtyMilli) return inventoryValueMinor;
  return roundHalfUp(inventoryValueMinor * issueQtyMilli, availableQtyMilli);
}

const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670]/g;
export function normalizeArabicSearch(input: string): string {
  return input
    .normalize("NFKC")
    .replace(ARABIC_DIACRITICS, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ـ/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ar-EG");
}

export function toSafeNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${field} exceeds safe integer boundary`);
  }
  return Number(value);
}

