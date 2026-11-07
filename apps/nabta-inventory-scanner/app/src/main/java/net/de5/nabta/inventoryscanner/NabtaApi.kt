package net.de5.nabta.inventoryscanner

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException

@Serializable data class LoginResponse(val token: String, val expiresAt: String, val user: User)
@Serializable data class User(val id: String, val displayName: String, val role: String, val permissions: List<String>)
@Serializable data class CatalogResponse(val products: List<Product>, val hasMore: Boolean = false, val nextCursor: String? = null)
@Serializable data class CreatedProductResponse(val id: String, val merged: Boolean = false, val restored: Boolean = false)
@Serializable data class UpdatedProductResponse(val id: String, val stockVersion: Int)
@Serializable data class UpdatedProductPriceResponse(val id: String, val priceMinor: Int, val wholesalePriceMinor: Int? = null)
@Serializable data class GeneratedBarcodeResponse(val barcode: String, val symbology: String)
@Serializable data class PurchaseReceiptResponse(val receiptId: String, val goodsMinor: Int, val supplyExpensesMinor: Int, val totalMinor: Int, val postedAt: String)
@Serializable data class ExpiryRegistrationResponse(val lotId: String, val productId: String, val qtyMilli: Long, val expiresOn: String)
@Serializable data class Supplier(val id: String, val name: String, val phone: String? = null, val balanceMinor: Long = 0)
@Serializable data class CreatedSupplierResponse(val id: String, val name: String)
@Serializable data class RetailPackage(
  val unitsPerPackage: Int,
  val packagePriceMinor: Int,
  val contentsUnit: String,
  val label: String = "PACKAGE",
)
@Serializable data class BarcodeMapping(val barcode: String, val saleUnit: String)
@Serializable data class Product(
  val id: String, val warehouseId: String? = null, val nameAr: String, val description: String = "",
  val category: String, val unitKind: String, val weightUnit: String = "KILOGRAM", val priceMinor: Int,
  val cartonPriceMinor: Int? = null, val cartonContentsUnit: String? = null, val retailPackage: RetailPackage? = null,
  val wholesalePriceMinor: Int? = null, val purchasePackSize: Int = 1, val availableQtyMilli: Long,
  val reorderLevelMilli: Long = 0, val barcodes: List<String> = emptyList(), val version: Int,
  val barcodeMappings: List<BarcodeMapping> = emptyList(),
)

@Serializable data class ApiError(val code: String? = null, val message: String? = null)

sealed interface ApiResult<out T> {
  data class Success<T>(val value: T) : ApiResult<T>
  data class Failure(val message: String, val retryable: Boolean = false, val statusCode: Int? = null) : ApiResult<Nothing>
}

/** Calls only the dedicated mobile relay. Credentials and Nabta session tokens never enter URLs. */
class NabtaApi(private val baseUrl: String, private val token: String?) {
  companion object {
    /** Shared connection pool makes repeated scanner lookups noticeably faster. */
    private val client = OkHttpClient.Builder()
      .connectTimeout(8, TimeUnit.SECONDS)
      .readTimeout(15, TimeUnit.SECONDS)
      .writeTimeout(15, TimeUnit.SECONDS)
      .callTimeout(20, TimeUnit.SECONDS)
      .retryOnConnectionFailure(true)
      .build()
  }
  private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
  private fun endpoint(path: String) = baseUrl.trimEnd('/') + path

  suspend fun login(username: String, password: String, terminalId: String): ApiResult<LoginResponse> =
    post("/v1/auth/login", """{"username":${json.encodeToString(String.serializer(), username)},"password":${json.encodeToString(String.serializer(), password)},"terminalId":${json.encodeToString(String.serializer(), terminalId)}}""", null)

  suspend fun search(query: String): ApiResult<CatalogResponse> {
    // The Charset overload is not available on every Android version we support.
    // Calling it made the app terminate as soon as a barcode or product search began.
    val encoded = runCatching { URLEncoder.encode(query, "UTF-8") }
      .getOrElse { return ApiResult.Failure("تعذر تجهيز البحث: ${it.message ?: "خطأ غير معروف"}") }
    return get("/v1/catalog?query=$encoded&limit=20")
  }

  /** Pages through the authoritative catalogue for the phone's offline index. */
  suspend fun catalogPage(cursor: String? = null): ApiResult<CatalogResponse> {
    val cursorPart = cursor?.let { "&cursor=${URLEncoder.encode(it, "UTF-8")}" }.orEmpty()
    return get("/v1/catalog?limit=200$cursorPart")
  }

  suspend fun createProduct(requestJson: String): ApiResult<CreatedProductResponse> = post("/v1/products", requestJson, token)
  /**
   * Barcodes are allocated by Nabta only.  A phone-generated EAN can collide
   * with an existing item on another terminal, so a relay that lacks this
   * endpoint must be upgraded instead of falling back to a local value.
   */
  suspend fun generateBarcode(): ApiResult<GeneratedBarcodeResponse> =
    post("/v1/product-barcodes/generate", "{}", token)
  suspend fun createPurchaseReceipt(requestJson: String, idempotencyKey: String): ApiResult<PurchaseReceiptResponse> =
    post("/v1/purchase-receipts", requestJson, token, mapOf("Idempotency-Key" to idempotencyKey))
  suspend fun suppliers(): ApiResult<List<Supplier>> = get("/v1/partners/suppliers")
  suspend fun createSupplier(name: String, phone: String): ApiResult<CreatedSupplierResponse> =
    post("/v1/partners/suppliers", "{\"name\":${json.encodeToString(String.serializer(), name)},\"phone\":${json.encodeToString(String.serializer(), phone)},\"openingBalanceMinor\":0}", token)
  suspend fun registerExpiry(requestJson: String, idempotencyKey: String): ApiResult<ExpiryRegistrationResponse> =
    post("/v1/stock-lots/expiry-registration", requestJson, token, mapOf("Idempotency-Key" to idempotencyKey))
  suspend fun updateProduct(id: String, requestJson: String): ApiResult<UpdatedProductResponse> = put("/v1/products/$id", requestJson, token)
  suspend fun updateSalePrice(id: String, priceMinor: Int): ApiResult<UpdatedProductPriceResponse> =
    put("/v1/products/$id/price", "{\"priceMinor\":$priceMinor}", token)
  /** Used by the separate Dokany-style shell only after its native bridge has
   * matched the request against its fixed mobile endpoint allow-list. */
  suspend fun mobileCommand(path: String, method: String, body: String? = null, idempotencyKey: String? = null): ApiResult<JsonElement> =
    request(path, method, body, token, if (idempotencyKey == null) emptyMap() else mapOf("Idempotency-Key" to idempotencyKey))

  private suspend inline fun <reified T> get(path: String): ApiResult<T> = request(path, "GET", null, token)
  private suspend inline fun <reified T> post(path: String, body: String, auth: String?, extraHeaders: Map<String, String> = emptyMap()): ApiResult<T> = request(path, "POST", body, auth, extraHeaders)
  private suspend inline fun <reified T> put(path: String, body: String, auth: String?): ApiResult<T> = request(path, "PUT", body, auth)

  private suspend inline fun <reified T> request(path: String, method: String, body: String?, auth: String?, extraHeaders: Map<String, String> = emptyMap()): ApiResult<T> = withContext(Dispatchers.IO) {
    runCatching {
      val builder = Request.Builder().url(endpoint(path)).header("Accept", "application/json")
      if (!auth.isNullOrBlank()) builder.header("Authorization", "Bearer $auth")
      extraHeaders.forEach { (name, value) -> builder.header(name, value) }
      if (body != null) builder.header("Content-Type", "application/json")
      val requestBody = body?.toRequestBody("application/json; charset=utf-8".toMediaType())
      val request = when (method) { "POST" -> builder.post(requestBody!!).build(); "PUT" -> builder.put(requestBody!!).build(); else -> builder.get().build() }
      client.newCall(request).execute().use { response ->
        val text = response.body.string()
        if (!response.isSuccessful) {
          val error = runCatching { json.decodeFromString<ApiError>(text) }.getOrNull()
          return@use ApiResult.Failure(
            // A 530 is emitted by the relay when its protected origin cannot
            // be reached. Keep the explicit explanation even if an HTML error
            // page happens to contain a non-actionable message.
            if (response.code == 530) friendlyHttpMessage(530) else error?.message ?: friendlyHttpMessage(response.code),
            retryable = response.code == 429 || response.code in 500..599,
            statusCode = response.code,
          )
        }
        ApiResult.Success(json.decodeFromString<T>(text))
      }
    }.getOrElse {
      if (it is CancellationException) throw it
      ApiResult.Failure(
        "تعذر الوصول لخادم نبتة. تحقق من الإنترنت ومن تشغيل الجهاز الرئيسي ثم أعد المحاولة.",
        retryable = it is IOException,
      )
    }
  }

  private fun friendlyHttpMessage(statusCode: Int): String = when (statusCode) {
    530 -> "تعذر اتصال بوابة الهاتف بالجهاز الرئيسي (530). لم تُؤكَّد العملية؛ شغّل نبتة وCloudflare Tunnel على الجهاز الرئيسي ثم أعد المحاولة أو انتظر المزامنة."
    502, 503, 504 -> "الخادم أو Cloudflare غير متاح مؤقتًا؛ سيُعاد إرسال العملية تلقائيًا عند عودة الاتصال."
    429 -> "يوجد ضغط مؤقت على الخادم؛ سيُعاد الإرسال تلقائيًا بعد قليل."
    else -> "تعذر الاتصال بنبتة ($statusCode)"
  }
}
