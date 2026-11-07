package net.de5.nabta.inventoryscanner

import android.content.Context
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

data class SavedSession(val baseUrl: String, val terminalId: String, val token: String, val displayName: String, val expiresAt: String = "")

class SecureSessionStore(context: Context) {
  private val preferences = EncryptedSharedPreferences.create(context, "nabta_dokany_session", MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(), EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
  fun load(): SavedSession? { val token = preferences.getString("token", "").orEmpty(); return if (token.isBlank()) null else SavedSession(preferences.getString("base_url", "").orEmpty(), preferences.getString("terminal_id", "").orEmpty(), token, preferences.getString("display_name", "").orEmpty(), preferences.getString("expires_at", "").orEmpty()) }
  fun save(session: SavedSession) = preferences.edit { putString("base_url", session.baseUrl); putString("terminal_id", session.terminalId); putString("token", session.token); putString("display_name", session.displayName); putString("expires_at", session.expiresAt) }
  fun clear() = preferences.edit { clear() }
}

@Serializable data class User(val id: String, val displayName: String, val role: String, val permissions: List<String>)
@Serializable data class LoginResponse(val token: String, val expiresAt: String, val user: User)
@Serializable data class BarcodeMapping(val barcode: String, val saleUnit: String)
@Serializable data class RetailPackage(val unitsPerPackage: Int, val packagePriceMinor: Int, val contentsUnit: String, val label: String = "PACKAGE")
@Serializable data class Product(val id: String, val warehouseId: String? = null, val nameAr: String, val description: String = "", val category: String, val unitKind: String, val weightUnit: String = "KILOGRAM", val priceMinor: Int, val cartonPriceMinor: Int? = null, val cartonContentsUnit: String? = null, val retailPackage: RetailPackage? = null, val wholesalePriceMinor: Int? = null, val purchasePackSize: Int = 1, val availableQtyMilli: Long, val reorderLevelMilli: Long = 0, val barcodes: List<String> = emptyList(), val version: Int, val barcodeMappings: List<BarcodeMapping> = emptyList())
@Serializable data class CatalogResponse(val products: List<Product>, val hasMore: Boolean = false, val nextCursor: String? = null)
@Serializable data class CreatedProductResponse(val id: String, val merged: Boolean = false)
@Serializable data class GeneratedBarcodeResponse(val barcode: String, val symbology: String)
@Serializable data class PurchaseReceiptResponse(val receiptId: String, val goodsMinor: Int, val supplyExpensesMinor: Int, val totalMinor: Int, val postedAt: String)
@Serializable data class ExpiryRegistrationResponse(val lotId: String, val productId: String, val qtyMilli: Long, val expiresOn: String)
@Serializable data class Supplier(val id: String, val name: String, val phone: String? = null, val balanceMinor: Long = 0)
@Serializable data class CreatedSupplierResponse(val id: String, val name: String)
@Serializable data class ApiError(val code: String? = null, val message: String? = null)
sealed interface ApiResult<out T> { data class Success<T>(val value: T): ApiResult<T>; data class Failure(val message: String, val retryable: Boolean = false, val statusCode: Int? = null): ApiResult<Nothing> }

class NabtaApi(private val baseUrl: String, private val token: String?) {
  companion object { private val client = OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).writeTimeout(15, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS).retryOnConnectionFailure(true).build() }
  private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
  private fun endpoint(path: String) = baseUrl.trimEnd('/') + path
  suspend fun login(username: String, password: String, terminalId: String) = post<LoginResponse>("/v1/auth/login", "{\"username\":${json.encodeToString(String.serializer(), username)},\"password\":${json.encodeToString(String.serializer(), password)},\"terminalId\":${json.encodeToString(String.serializer(), terminalId)}}", null)
  suspend fun search(query: String): ApiResult<CatalogResponse> = get("/v1/catalog?query=${URLEncoder.encode(query, "UTF-8")}&limit=20")
  suspend fun createProduct(requestJson: String) = post<CreatedProductResponse>("/v1/products", requestJson, token)
  suspend fun generateBarcode() = post<GeneratedBarcodeResponse>("/v1/product-barcodes/generate", "{}", token)
  suspend fun createPurchaseReceipt(requestJson: String, key: String) = post<PurchaseReceiptResponse>("/v1/purchase-receipts", requestJson, token, mapOf("Idempotency-Key" to key))
  suspend fun suppliers() = get<List<Supplier>>("/v1/partners/suppliers")
  suspend fun createSupplier(name: String, phone: String) = post<CreatedSupplierResponse>("/v1/partners/suppliers", "{\"name\":${json.encodeToString(String.serializer(), name)},\"phone\":${json.encodeToString(String.serializer(), phone)},\"openingBalanceMinor\":0}", token)
  suspend fun registerExpiry(requestJson: String, key: String) = post<ExpiryRegistrationResponse>("/v1/stock-lots/expiry-registration", requestJson, token, mapOf("Idempotency-Key" to key))
  suspend fun mobileCommand(path: String, method: String, body: String? = null, key: String? = null): ApiResult<JsonElement> = request(path, method, body, token, key?.let { mapOf("Idempotency-Key" to it) } ?: emptyMap())
  private suspend inline fun <reified T> get(path: String) = request<T>(path, "GET", null, token)
  private suspend inline fun <reified T> post(path: String, body: String, auth: String?, headers: Map<String, String> = emptyMap()) = request<T>(path, "POST", body, auth, headers)
  private suspend inline fun <reified T> request(path: String, method: String, body: String?, auth: String?, headers: Map<String, String> = emptyMap()): ApiResult<T> = withContext(Dispatchers.IO) { runCatching { val builder = Request.Builder().url(endpoint(path)).header("Accept", "application/json"); if (!auth.isNullOrBlank()) builder.header("Authorization", "Bearer $auth"); headers.forEach { (key, value) -> builder.header(key, value) }; val requestBody = body?.toRequestBody("application/json; charset=utf-8".toMediaType()); val request = when(method) { "POST" -> builder.post(requestBody!!).build(); "PUT" -> builder.put(requestBody!!).build(); else -> builder.get().build() }; client.newCall(request).execute().use { response -> val text = response.body.string(); if (!response.isSuccessful) { val error = runCatching { json.decodeFromString<ApiError>(text) }.getOrNull(); val message = when (response.code) { 401 -> "انتهت جلسة نبتة أو بيانات الدخول غير صالحة. سجّل الدخول من جديد."; 403 -> "الحساب لا يملك صلاحية تنفيذ هذه العملية."; else -> error?.message ?: "تعذر الاتصال بنبتة (${response.code})" }; return@use ApiResult.Failure(message, response.code in 500..599, response.code) }; ApiResult.Success(json.decodeFromString<T>(text)) } }.getOrElse { if (it is CancellationException) throw it; ApiResult.Failure("تعذر الوصول لخادم نبتة. تحقق من الإنترنت والجهاز الرئيسي.", it is IOException) } }
}
