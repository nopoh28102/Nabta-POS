package net.de5.nabta.inventoryscanner

/** Converts whole supplier cartons into the thousandth-based base stock unit. */
internal fun cartonsToQtyMilli(cartonCount: Long, unitsPerCarton: Int): Long? =
  if (cartonCount <= 0 || unitsPerCarton < 2) null
  else runCatching {
    Math.multiplyExact(Math.multiplyExact(cartonCount, unitsPerCarton.toLong()), 1_000L)
  }.getOrNull()
