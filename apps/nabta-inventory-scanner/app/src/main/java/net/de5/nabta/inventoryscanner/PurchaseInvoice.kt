package net.de5.nabta.inventoryscanner

/** A line is kept on the phone only until Nabta posts the atomic supplier receipt. */
data class PurchaseInvoiceLine(
  val product: Product,
  val quantity: Long = 1,
  val entryUnit: String = "PIECE",
  val purchaseCostMinor: Int = 0,
  val retailPriceMinor: Int = 0,
  /** ISO date; null means the supplier did not provide an expiry date. */
  val expiresOn: String? = null,
)

data class PostedPurchaseReceipt(
  val supplierName: String,
  val supplierInvoiceNo: String,
  val lines: List<PurchaseInvoiceLine>,
  val receipt: PurchaseReceiptResponse,
)

enum class BarcodeSlot { UNIT, CARTON, PACKAGE }
data class GeneratedBarcode(val slot: BarcodeSlot, val barcode: String)
