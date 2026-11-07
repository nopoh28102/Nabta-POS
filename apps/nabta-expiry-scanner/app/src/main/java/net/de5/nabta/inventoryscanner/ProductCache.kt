package net.de5.nabta.inventoryscanner

import java.util.Locale

/**
 * A small in-memory search index for recently reached products.  It makes the
 * scanner feel immediate and remains useful when the mobile connection drops;
 * the server still remains the only authority for every write.
 */
internal fun searchCachedProducts(products: List<Product>, rawQuery: String, limit: Int = 20): List<Product> {
  val query = normalizeSearch(rawQuery)
  if (query.isBlank()) return emptyList()

  return products.mapIndexedNotNull { index, product ->
    val normalizedName = normalizeSearch(product.nameAr)
    val barcodeRank = (product.barcodes + product.barcodeMappings.map { it.barcode }).distinct().minOfOrNull { barcode ->
      when {
        barcode == rawQuery.trim() -> 0
        barcode.startsWith(rawQuery.trim()) -> 1
        else -> 4
      }
    } ?: 4
    val rank = when {
      barcodeRank < 4 -> barcodeRank
      normalizedName == query -> 2
      normalizedName.startsWith(query) -> 3
      normalizedName.contains(query) || normalizeSearch(product.category).contains(query) -> 4
      else -> return@mapIndexedNotNull null
    }
    CachedMatch(product, rank, index)
  }.sortedWith(compareBy<CachedMatch> { it.rank }.thenBy { it.index })
    .take(limit)
    .map { it.product }
}

private data class CachedMatch(val product: Product, val rank: Int, val index: Int)

internal fun normalizeSearch(value: String): String = value
  .lowercase(Locale.ROOT)
  .replace(Regex("[\\u064B-\\u065F\\u0670]"), "")
  .replace('أ', 'ا')
  .replace('إ', 'ا')
  .replace('آ', 'ا')
  .replace('ى', 'ي')
  .replace('ة', 'ه')
  .trim()
