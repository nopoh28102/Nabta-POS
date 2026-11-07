package net.de5.nabta.inventoryscanner

import java.security.SecureRandom

private val internalBarcodeRandom = SecureRandom()

/**
 * Creates a scanner-compatible EAN-13 internal code. The 209 prefix is reserved
 * for retailer-assigned identifiers, so it never pretends to be a supplier code.
 */
internal fun generateInternalEan13(): String {
  val base = buildString(12) {
    append("209")
    repeat(9) { append(internalBarcodeRandom.nextInt(10)) }
  }
  return base + ean13CheckDigit(base)
}

internal fun isValidEan13(barcode: String): Boolean =
  barcode.matches(Regex("\\d{13}")) && barcode.last().digitToInt() == ean13CheckDigit(barcode.dropLast(1))

private fun ean13CheckDigit(base: String): Int {
  require(base.matches(Regex("\\d{12}"))) { "EAN-13 base must contain 12 digits" }
  val sum = base.mapIndexed { index, digit -> digit.digitToInt() * if (index % 2 == 0) 1 else 3 }.sum()
  return (10 - (sum % 10)) % 10
}
