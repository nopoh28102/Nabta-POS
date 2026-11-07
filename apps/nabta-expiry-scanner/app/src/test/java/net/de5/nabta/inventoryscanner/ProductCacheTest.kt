package net.de5.nabta.inventoryscanner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProductCacheTest {
  private val milk = Product(
    id = "milk",
    nameAr = "لبن كامل الدسم",
    category = "ألبان",
    unitKind = "WEIGHT",
    weightUnit = "LITER",
    priceMinor = 3000,
    availableQtyMilli = 12_000,
    barcodes = listOf("6221000000011"),
    version = 1,
  )
  private val tea = Product(
    id = "tea",
    nameAr = "شاي أحمر",
    category = "مشروبات",
    unitKind = "PIECE",
    priceMinor = 4500,
    availableQtyMilli = 8_000,
    barcodes = listOf("6221000000028"),
    version = 2,
  )

  @Test fun `barcode exact match has priority`() {
    assertEquals(listOf(milk), searchCachedProducts(listOf(tea, milk), "6221000000011"))
  }

  @Test fun `Arabic normalization finds a product when hamza differs`() {
    assertEquals(listOf(tea), searchCachedProducts(listOf(milk, tea), "شاي احمر"))
  }

  @Test fun `empty search never returns the whole local cache`() {
    assertTrue(searchCachedProducts(listOf(milk, tea), " ").isEmpty())
  }

  @Test fun `carton barcode mappings are retained with the product`() {
    val product = tea.copy(barcodeMappings = listOf(BarcodeMapping("6221000000028", "UNIT"), BarcodeMapping("6221000000035", "CARTON")))
    assertEquals(listOf(product), searchCachedProducts(listOf(product), "6221000000035"))
  }

  @Test fun `cartons convert to the exact base stock quantity`() {
    assertEquals(72_000L, cartonsToQtyMilli(3, 24))
    assertEquals(null, cartonsToQtyMilli(0, 24))
  }

  @Test fun `locally generated internal barcode is a valid EAN-13`() {
    repeat(20) {
      val barcode = generateInternalEan13()
      assertTrue(barcode.startsWith("209"))
      assertTrue(isValidEan13(barcode))
    }
  }
}
