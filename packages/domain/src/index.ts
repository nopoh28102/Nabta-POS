export const MILLI_PER_UNIT = 1_000n;
export const MAX_SAFE_MINOR = 9_000_000_000_000n;

export type RoundingMode = "HALF_UP";

export interface PricedLine {
  lineId: string;
  unitPriceMinor: bigint;
  qtyMilli: bigint;
  /** A package price can be exact even when it is not divisible into piastres per piece. */
  grossMinor?: bigint;
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
  const withGross = lines.map((line) => ({ ...line, grossMinor: line.grossMinor ?? calculateLineMinor(line.unitPriceMinor, line.qtyMilli) }));
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

export function extractTokenVariants(token: string): string[] {
  const clean = token.trim();
  if (!clean) return [];
  const variants = [clean];
  // Small retail vocabulary groups cover the common forms a cashier uses at
  // the counter. They are deliberately explicit instead of a broad stemmer,
  // so a search for an unrelated word does not become noisy.
  const retailSynonyms: Record<string, string[]> = {
    "كيس": ["اكياس"],
    "اكياس": ["كيس"],
    "ابيض": ["بيضا", "بيضاء", "بيضه", "بيض"],
    "بيضا": ["ابيض", "بيضاء", "بيضه", "بيض"],
    "بيضاء": ["ابيض", "بيضا", "بيضه", "بيض"],
    "بيضه": ["ابيض", "بيضا", "بيضاء", "بيض"],
  };
  variants.push(...(retailSynonyms[clean] ?? []));
  if (clean.startsWith("ال") && clean.length > 3) {
    variants.push(clean.slice(2));
  } else if ((clean.startsWith("بال") || clean.startsWith("وال") || clean.startsWith("كال") || clean.startsWith("فال")) && clean.length > 4) {
    variants.push(clean.slice(3));
    variants.push(clean.slice(1));
  } else if ((clean.startsWith("و") || clean.startsWith("ب") || clean.startsWith("ف") || clean.startsWith("ك")) && clean.length > 3) {
    variants.push(clean.slice(1));
  }
  return [...new Set(variants)];
}

export function matchesArabicGuessing(text: string, query: string): boolean {
  if (!query) return true;
  const normalizedText = normalizeArabicSearch(text);
  const normalizedQuery = normalizeArabicSearch(query);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => {
    const variants = extractTokenVariants(token);
    return variants.some((v) => normalizedText.includes(v));
  });
}

/**
 * Gives a conservative score for a misspelled Arabic product query.  It is
 * deliberately used only after the fast indexed token search: barcode and
 * exact/partial name searches must always stay first.  The score accepts a
 * small typo (for example: "شبس" for "شيبسي"), while avoiding unrelated
 * words that merely share one or two letters.
 */
export function scoreArabicFuzzyMatch(text: string, query: string): number {
  const normalizedText = normalizeArabicSearch(text);
  const normalizedQuery = normalizeArabicSearch(query);
  if (!normalizedText || !normalizedQuery || normalizedQuery.length < 3) return 0;
  if (normalizedText.includes(normalizedQuery)) return 1;

  const textTokens = normalizedText.split(/\s+/).filter((token) => token.length >= 2);
  const queryTokens = normalizedQuery.split(/\s+/).filter((token) => token.length >= 3);
  if (!textTokens.length || !queryTokens.length) return 0;

  const tokenScores = queryTokens.map((queryToken) => {
    const variants = extractTokenVariants(queryToken).filter((variant) => variant.length >= 3);
    let best = 0;
    for (const textToken of textTokens) {
      for (const variant of variants) {
        if (textToken.includes(variant) || variant.includes(textToken)) {
          best = Math.max(best, Math.min(variant.length, textToken.length) / Math.max(variant.length, textToken.length));
          continue;
        }
        if (isSubsequence(variant, textToken) || isSubsequence(textToken, variant)) {
          // Common cashier typing drops an internal vowel/letter; accepting a
          // short ordered subsequence is useful, but is scored below a true
          // substring so exact partial searches still win.
          best = Math.max(best, 0.72 + 0.12 * Math.min(variant.length, textToken.length) / Math.max(variant.length, textToken.length));
          continue;
        }
        const length = Math.max(variant.length, textToken.length);
        // A short word needs a near-perfect match; longer product words can
        // absorb one or two common keyboard/spelling mistakes.
        const maxDistance = length <= 4 ? 1 : length <= 8 ? 2 : 3;
        const distance = boundedLevenshtein(variant, textToken, maxDistance);
        if (distance <= maxDistance) best = Math.max(best, 1 - distance / length);
      }
    }
    return best;
  });

  const average = tokenScores.reduce((sum, score) => sum + score, 0) / tokenScores.length;
  const strongest = Math.max(...tokenScores);
  // One confidently recognised word is useful for a cashier even when an
  // extra word was omitted or typed differently; multiple words still need a
  // reasonable overall match to avoid noisy results.
  if (queryTokens.length === 1) return strongest >= 0.7 ? strongest : 0;
  return strongest >= 0.82 && average >= 0.52 ? average : 0;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let needleIndex = 0;
  for (const character of haystack) {
    if (character === needle[needleIndex]) needleIndex += 1;
    if (needleIndex === needle.length) return true;
  }
  return false;
}

function boundedLevenshtein(left: string, right: string, maximum: number): number {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMinimum = current[0]!;
    for (let column = 1; column <= right.length; column += 1) {
      const value = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maximum) return maximum + 1;
    previous = current;
  }
  return previous[right.length]!;
}
