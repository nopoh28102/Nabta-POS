package net.de5.nabta.dokany

import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import java.util.UUID
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.de5.nabta.dokany.BuildConfig
import net.de5.nabta.inventoryscanner.ApiResult
import net.de5.nabta.inventoryscanner.NabtaApi
import net.de5.nabta.inventoryscanner.SavedSession
import net.de5.nabta.inventoryscanner.SecureSessionStore
import org.json.JSONObject

/** Native-only relay client for the bundled HTML. The page has no token or
 * Cloudflare key and cannot navigate away from the local assets directory. */
class NabtaBridge(private val activity: ComponentActivity, private val webView: WebView) {
  private val store = SecureSessionStore(activity.applicationContext)
  private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
  private var pendingSpreadsheet: PendingSpreadsheet? = null

  @JavascriptInterface fun initialState(callbackId: String) = async(callbackId) {
    val session = store.load()
    ok(objectOf(
      "baseUrl" to JsonPrimitive(session?.baseUrl ?: BuildConfig.DEFAULT_API_URL),
      "loggedIn" to JsonPrimitive(session != null),
      "displayName" to JsonPrimitive(session?.displayName ?: ""),
      "terminalId" to JsonPrimitive(session?.terminalId ?: ""),
    ))
  }

  @JavascriptInterface fun login(callbackId: String, baseUrl: String, terminalId: String, username: String, password: String) = async(callbackId) {
    if (terminalId.isBlank() || username.isBlank() || password.isBlank()) return@async fail("أكمل رقم الكاشير وبيانات الدخول")
    val normalized = baseUrl.trim().trimEnd('/').ifBlank { BuildConfig.DEFAULT_API_URL }
    when (val result = NabtaApi(normalized, null).login(username.trim(), password, terminalId.trim())) {
      is ApiResult.Success -> {
        val session = SavedSession(normalized, terminalId.trim(), result.value.token, result.value.user.displayName, result.value.expiresAt)
        store.save(session)
        ok(objectOf("displayName" to JsonPrimitive(session.displayName), "terminalId" to JsonPrimitive(session.terminalId)))
      }
      is ApiResult.Failure -> failForApi(result)
    }
  }

  @JavascriptInterface fun logout(callbackId: String) = async(callbackId) { store.clear(); ok(JsonObject(emptyMap())) }

  @JavascriptInterface fun search(callbackId: String, query: String) = async(callbackId) {
    val api = apiOrError()
    when (val result = api.search(query.trim())) {
      is ApiResult.Success -> json.encodeToString(result.value)
      is ApiResult.Failure -> failForApi(result)
    }
  }

  @JavascriptInterface fun suppliers(callbackId: String) = async(callbackId) {
    val api = apiOrError()
    when (val result = api.suppliers()) {
      is ApiResult.Success -> json.encodeToString(result.value)
      is ApiResult.Failure -> failForApi(result)
    }
  }

  @JavascriptInterface fun createSupplier(callbackId: String, name: String, phone: String) = async(callbackId) {
    val api = apiOrError()
    when (val result = api.createSupplier(name.trim(), phone.trim())) {
      is ApiResult.Success -> json.encodeToString(result.value)
      is ApiResult.Failure -> failForApi(result)
    }
  }

  @JavascriptInterface fun createProduct(callbackId: String, requestJson: String) = async(callbackId) {
    val api = apiOrError()
    val source = runCatching { json.parseToJsonElement(requestJson).jsonObject }.getOrElse { return@async fail("بيانات الصنف غير صحيحة") }
    val name = source["nameAr"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
    if (name.length < 2) return@async fail("اكتب اسم الصنف")
    val generated = when (val barcode = source["unitBarcode"]?.jsonPrimitive?.contentOrNull?.trim()) {
      null, "" -> when (val result = api.generateBarcode()) {
        is ApiResult.Success -> result.value.barcode
        is ApiResult.Failure -> return@async fail(result.message)
      }
      else -> barcode
    }
    val cartonBarcode = source["cartonBarcode"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
    val packageBarcode = source["packageBarcode"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
    val packSize = source["purchasePackSize"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 1
    val carton = when {
      cartonBarcode.isNotBlank() -> cartonBarcode
      packSize > 1 -> when (val result = api.generateBarcode()) {
        is ApiResult.Success -> result.value.barcode
        is ApiResult.Failure -> return@async fail(result.message)
      }
      else -> ""
    }
    // A bag/retail package is optional.  When it is configured, its barcode is
    // optional too: generate a unique code at save time rather than blocking
    // the receiving clerk on a missing supplier barcode.
    val packageCode = when {
      packageBarcode.isNotBlank() -> packageBarcode
      source["retailPackage"] is JsonObject -> when (val result = api.generateBarcode()) {
        is ApiResult.Success -> result.value.barcode
        is ApiResult.Failure -> return@async fail(result.message)
      }
      else -> ""
    }
    val fields = source.toMutableMap()
    fields.remove("unitBarcode")
    fields.remove("cartonBarcode")
    fields.remove("packageBarcode")
    val mappings = mutableListOf(objectOf("barcode" to JsonPrimitive(generated), "saleUnit" to JsonPrimitive("UNIT")))
    if (carton.isNotBlank() && carton != generated) mappings += objectOf("barcode" to JsonPrimitive(carton), "saleUnit" to JsonPrimitive("CARTON"))
    if (packageCode.isNotBlank() && packageCode != generated && packageCode != carton) mappings += objectOf("barcode" to JsonPrimitive(packageCode), "saleUnit" to JsonPrimitive("PACKAGE"))
    fields["barcodes"] = JsonArray(mappings.map { it["barcode"]!! })
    fields["barcodeMappings"] = JsonArray(mappings)
    when (val result = api.createProduct(json.encodeToString(JsonObject(fields)))) {
      is ApiResult.Success -> ok(objectOf("id" to JsonPrimitive(result.value.id), "barcode" to JsonPrimitive(generated), "cartonBarcode" to JsonPrimitive(carton), "packageBarcode" to JsonPrimitive(packageCode), "merged" to JsonPrimitive(result.value.merged)))
      is ApiResult.Failure -> failForApi(result)
    }
  }

  @JavascriptInterface fun postPurchaseReceipt(callbackId: String, requestJson: String) = async(callbackId) {
    val api = apiOrError()
    val source = runCatching { json.parseToJsonElement(requestJson).jsonObject }.getOrElse { return@async fail("بيانات الفاتورة غير صحيحة") }
    val fields = source.toMutableMap()
    // The Windows primary device owns the physical printer. This request is
    // committed atomically with the receipt and cannot create duplicate paper.
    fields["printOnPrimary"] = JsonPrimitive(true)
    when (val result = api.createPurchaseReceipt(json.encodeToString(JsonObject(fields)), UUID.randomUUID().toString())) {
      is ApiResult.Success -> json.encodeToString(result.value)
      is ApiResult.Failure -> failForApi(result)
    }
  }

  @JavascriptInterface fun registerExpiry(callbackId: String, productId: String, qtyMilli: Long, expiresOn: String) = async(callbackId) {
    val api = apiOrError()
    val payload = objectOf("productId" to JsonPrimitive(productId), "qtyMilli" to JsonPrimitive(qtyMilli), "expiresOn" to JsonPrimitive(expiresOn))
    when (val result = api.registerExpiry(json.encodeToString(payload), UUID.randomUUID().toString())) {
      is ApiResult.Success -> json.encodeToString(result.value)
      is ApiResult.Failure -> failForApi(result)
    }
  }

  /** A deliberately narrow command bridge for screens that use existing Nabta
   * transactions. HTML cannot select an arbitrary URL or add credentials. */
  @JavascriptInterface fun command(callbackId: String, method: String, path: String, bodyJson: String) = async(callbackId) {
    val normalizedMethod = method.uppercase()
    if (!isMobileCommandAllowed(normalizedMethod, path)) return@async fail("هذه العملية غير متاحة من تطبيق الهاتف")
    val body = bodyJson.takeIf { it.isNotBlank() && it != "null" }
    if (body != null) runCatching { json.parseToJsonElement(body) }.getOrElse { return@async fail("بيانات العملية غير صحيحة") }
    when (val result = apiOrError().mobileCommand(path, normalizedMethod, body, if (normalizedMethod == "GET") null else UUID.randomUUID().toString())) {
      is ApiResult.Success -> json.encodeToString(result.value)
      is ApiResult.Failure -> failForApi(result)
    }
  }

  @JavascriptInterface fun scan(callbackId: String) {
    activity.runOnUiThread {
      val options = GmsBarcodeScannerOptions.Builder()
        .setBarcodeFormats(Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_CODE_128, Barcode.FORMAT_UPC_A, Barcode.FORMAT_UPC_E)
        .enableAutoZoom().build()
        GmsBarcodeScanning.getClient(activity, options).startScan()
          .addOnSuccessListener { code -> respond(callbackId, true, code.rawValue?.let { "{\"barcode\":${JSONObject.quote(it)}}" } ?: "{}") }
          .addOnCanceledListener { respond(callbackId, false, "{}", "تم إيقاف المسح") }
          .addOnFailureListener { error -> respond(callbackId, false, "{}", error.message ?: "تعذر تشغيل ماسح الباركود") }
    }
  }

  /** Saves a SpreadsheetML workbook chosen by the employee.  The HTML never
   * receives filesystem access; Android's document picker owns the location. */
  @JavascriptInterface fun exportSpreadsheet(callbackId: String, filename: String, workbookXml: String) {
    activity.runOnUiThread {
      if (pendingSpreadsheet != null) {
        respond(callbackId, false, "{}", "هناك عملية تصدير قيد التنفيذ")
        return@runOnUiThread
      }
      val safeName = filename.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80).ifBlank { "nabta-report" }
      pendingSpreadsheet = PendingSpreadsheet(callbackId, workbookXml)
      runCatching {
        (activity as MainActivity).launchSpreadsheetSave(if (safeName.endsWith(".xls")) safeName else "$safeName.xls")
      }.onFailure {
        pendingSpreadsheet = null
        respond(callbackId, false, "{}", "تعذر فتح نافذة حفظ ملف Excel")
      }
    }
  }

  fun onSpreadsheetDestination(uri: Uri?) {
    val pending = pendingSpreadsheet ?: return
    pendingSpreadsheet = null
    if (uri == null) {
      respond(pending.callbackId, false, "{}", "تم إلغاء تصدير التقرير")
      return
    }
    activity.lifecycleScope.launch {
      runCatching {
        activity.contentResolver.openOutputStream(uri)?.bufferedWriter(Charsets.UTF_8)?.use { writer ->
          writer.write(pending.workbookXml)
        } ?: error("تعذر إنشاء الملف")
      }.onSuccess { respond(pending.callbackId, true, "{}") }
        .onFailure { respond(pending.callbackId, false, "{}", "تعذر حفظ ملف Excel") }
    }
  }

  private fun async(callbackId: String, block: suspend NabtaBridge.() -> String) {
    activity.lifecycleScope.launch {
      try {
        respond(callbackId, true, block())
      } catch (error: Throwable) {
        respond(callbackId, false, "", (error as? BridgeError)?.message ?: "تعذر تنفيذ العملية")
      }
    }
  }
  private fun apiOrError(): NabtaApi {
    val session = store.load() ?: run { throw BridgeError("سجّل الدخول أولًا") }
    return NabtaApi(session.baseUrl, session.token)
  }
  private fun failForApi(result: ApiResult.Failure): Nothing {
    if (result.statusCode == 401) store.clear()
    return fail(result.message)
  }
  private fun isMobileCommandAllowed(method: String, path: String): Boolean {
    val noQuery = path.substringBefore('?')
    return (method == "GET" && noQuery in setOf("/v1/shifts/current", "/v1/reports/summary", "/v1/reports/comprehensive", "/v1/inventory/periodic-report", "/v1/partners/customers", "/v1/invoices", "/v1/sales/lookup")) ||
      (method == "POST" && noQuery in setOf("/v1/shifts", "/v1/quotes", "/v1/sales", "/v1/partners/customers", "/v1/partners/customer/collect", "/v1/product-barcodes/generate", "/v1/weighted-labels")) ||
      (method == "POST" && Regex("^/v1/shifts/[0-9a-f-]{36}/cash-movements$", RegexOption.IGNORE_CASE).matches(noQuery)) ||
      (method == "POST" && Regex("^/v1/sales/[0-9a-f-]{36}/returns$", RegexOption.IGNORE_CASE).matches(noQuery)) ||
      (method == "PUT" && Regex("^/v1/products/[0-9a-f-]{36}$", RegexOption.IGNORE_CASE).matches(noQuery))
  }
  private fun ok(value: JsonObject): String = json.encodeToString(value)
  private fun objectOf(vararg entries: Pair<String, JsonElement>): JsonObject = JsonObject(mapOf(*entries))
  private fun fail(message: String): Nothing = throw BridgeError(message)
  private fun respond(callbackId: String, success: Boolean, dataJson: String, error: String? = null) {
    val payload = if (success) "{\"ok\":true,\"data\":$dataJson}" else "{\"ok\":false,\"message\":${JSONObject.quote(error ?: "تعذر تنفيذ العملية")}}"
    webView.post { webView.evaluateJavascript("window.NabtaNative.onNativeResult(${JSONObject.quote(callbackId)}, ${JSONObject.quote(payload)});", null) }
  }
  private class BridgeError(message: String) : IllegalStateException(message)
  private data class PendingSpreadsheet(val callbackId: String, val workbookXml: String)
}
