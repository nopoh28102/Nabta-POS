package net.de5.nabta.inventoryscanner

import android.os.Bundle
import android.app.Activity
import android.content.Context
import android.print.PrintAttributes
import android.print.PrintManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.YearMonth
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    setContent { NabtaScannerTheme { ScannerApp() } }
  }
}

@Composable
private fun NabtaScannerTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = androidx.compose.material3.lightColorScheme(
      primary = Color(0xFF087C61),
      secondary = Color(0xFF105B48),
      tertiary = Color(0xFF0F766E),
      error = Color(0xFFB3261E),
    ),
    content = content,
  )
}

@Composable
private fun ScannerApp(viewModel: ScannerViewModel = viewModel()) {
  val state by viewModel.state.collectAsStateWithLifecycle()
  Surface(modifier = Modifier.fillMaxSize()) {
    if (state.session == null) LoginScreen(state.savedLoginDetails, state.loading, state.message, viewModel::login)
    else InventoryScreen(state, viewModel)
  }
}

@Composable
private fun LoginScreen(
  savedLoginDetails: SavedLoginDetails?,
  loading: Boolean,
  message: String?,
  onLogin: (String, String, String, String) -> Unit,
) {
  val savedKey = listOf(savedLoginDetails?.baseUrl, savedLoginDetails?.terminalId, savedLoginDetails?.username, savedLoginDetails?.password).joinToString("|")
  var url by rememberSaveable(savedKey) { mutableStateOf(savedLoginDetails?.baseUrl ?: BuildConfig.DEFAULT_API_URL) }
  var terminalId by rememberSaveable(savedKey) { mutableStateOf(savedLoginDetails?.terminalId.orEmpty()) }
  var username by rememberSaveable(savedKey) { mutableStateOf(savedLoginDetails?.username.orEmpty()) }
  var password by rememberSaveable(savedKey) { mutableStateOf(savedLoginDetails?.password.orEmpty()) }
  LazyColumn(
    modifier = Modifier.fillMaxSize().padding(24.dp),
    verticalArrangement = Arrangement.Center,
    contentPadding = PaddingValues(vertical = 24.dp),
  ) {
    item {
      Text("ماسح مخزون نبتة", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
      Spacer(Modifier.height(8.dp))
      Text("تسجيل وإضافة وتعديل الأصناف من الهاتف، مع حفظ آمن للجلسة وسرعة في البحث بالباركود.")
      Spacer(Modifier.height(24.dp))
      AppField("رابط خدمة الهاتف الآمن", url, { url = it }, "https://…", keyboardType = KeyboardType.Uri)
      AppField("معرّف نقطة البيع", terminalId, { terminalId = it }, "UUID من نبتة")
      AppField("اسم المستخدم", username, { username = it })
      AppField("كلمة المرور", password, { password = it }, password = true)
      message?.let { Notice(it, it.startsWith("تم")) }
      Button(
        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
        enabled = !loading,
        onClick = { onLogin(url, terminalId, username, password) },
      ) { Text(if (loading) "جارٍ الاتصال…" else "تسجيل الدخول") }
      Text("تُحفظ الجلسة وبيانات الدخول مشفّرة على الهاتف. لا تُرسل كلمة المرور إلى أي جهة غير خادم نبتة.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 16.dp))
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InventoryScreen(state: ScannerState, viewModel: ScannerViewModel) {
  val activity = LocalActivity.current
  val selectedProduct = state.product
  var editorMode by rememberSaveable(selectedProduct?.id) { mutableStateOf("") }
  var showingPurchaseInvoice by rememberSaveable { mutableStateOf(false) }
  if (showingPurchaseInvoice) {
    PurchaseInvoiceScreen(state, viewModel, onClose = { showingPurchaseInvoice = false })
    return
  }
  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("ماسح مخزون نبتة") },
        actions = {
          TextButton(onClick = { showingPurchaseInvoice = true }) { Text("فاتورة توريد") }
          TextButton(onClick = viewModel::logout) { Text("خروج") }
        },
      )
    },
  ) { padding ->
    LazyColumn(
      modifier = Modifier.fillMaxSize().padding(padding),
      contentPadding = PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      item {
        Text("مرحبًا ${state.session?.displayName.orEmpty()}", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text("اكتب الاسم أو امسح الباركود؛ البحث يبدأ تلقائيًا، وتظهر نتائج الذاكرة فورًا.", style = MaterialTheme.typography.bodySmall)
      }
      item {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          Text("الفهرس المحلي: ${state.catalogCount} صنف", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
          FilledTonalButton(onClick = { viewModel.syncFullCatalog(force = true) }, enabled = !state.catalogSyncing) {
            Text(if (state.catalogSyncing) "جارٍ التحديث…" else "تحديث الفهرس")
          }
        }
        if (state.pendingMutations > 0) {
          Text("${state.pendingMutations} تعديل قيد المزامنة عند عودة اتصال نبتة.", color = MaterialTheme.colorScheme.tertiary, style = MaterialTheme.typography.bodySmall)
        }
      }
      item {
        BarcodeSearch(
          value = state.query,
          onQueryChange = viewModel::previewSearch,
          onSearch = { query -> viewModel.search(query) },
          onScan = { onResult ->
            startBarcodeScan(activity, viewModel, onResult)
          },
        )
      }
      state.message?.let { message -> item { Notice(message, message.startsWith("تم")) } }
      if (state.resultsAreCached) item { Text("نتائج محفوظة مؤقتًا — سيجري تحديثها عند عودة الاتصال.", color = MaterialTheme.colorScheme.tertiary, style = MaterialTheme.typography.bodySmall) }
      if (state.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = 4.dp)) }

      if (selectedProduct == null && state.query.isBlank() && state.recentProducts.isNotEmpty()) {
        item { Text("آخر أصناف تم الوصول إليها", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp)) }
        items(state.recentProducts, key = { it.id }) { product -> ProductRow(product) { viewModel.select(product) } }
      }
      if (selectedProduct == null && state.searchResults.isNotEmpty()) {
        item { Text("نتائج البحث", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp)) }
        items(state.searchResults, key = { it.id }) { product -> ProductRow(product) { viewModel.select(product) } }
      }
      if (selectedProduct != null) {
        item { ProductDetails(selectedProduct) }
        item {
          when (editorMode) {
            "stock" -> StockIncrease(
              selectedProduct,
              onCancel = { editorMode = "" },
              onSaveUnits = { viewModel.increaseStock(it); editorMode = "" },
              onSaveCartons = { viewModel.increaseCartons(it); editorMode = "" },
            )
            "expiry" -> ExpiryRegistration(
              selectedProduct,
              onCancel = { editorMode = "" },
              onSave = { qtyMilli, expiresOn -> viewModel.registerExpiry(qtyMilli, expiresOn); editorMode = "" },
            )
            "price" -> SalePriceEditor(selectedProduct, onCancel = { editorMode = "" }, onSave = { viewModel.updateSalePrice(it); editorMode = "" })
            "details" -> ProductEditor(selectedProduct, onCancel = { editorMode = "" }, onSave = { name, category, description, price, quantity, cost ->
              viewModel.updateProductDetails(name, category, description, price, quantity, cost)
              editorMode = ""
            })
            else -> ProductActions(
              enabled = !state.loading,
              onIncrease = { editorMode = "stock" },
              onExpiry = { editorMode = "expiry" },
              onPrice = { editorMode = "price" },
              onEdit = { editorMode = "details" },
              onClear = viewModel::clearProduct,
            )
          }
        }
      } else if (state.query.isNotBlank() && !state.loading && state.searchResults.isEmpty()) {
        item { NewProductForm(barcode = state.query, generatedBarcode = state.generatedBarcode, onGeneratedBarcodeConsumed = viewModel::consumeGeneratedBarcode, onGenerateBarcode = viewModel::generateBarcode, onScanBarcode = { _, receiver -> startBarcodeScan(activity, viewModel, receiver) }, onSave = viewModel::createProduct) }
      }
    }
  }
}

private fun startBarcodeScan(activity: Activity?, viewModel: ScannerViewModel, onResult: (String) -> Unit) {
  if (activity == null) {
    viewModel.showMessage("تعذر تشغيل الماسح في هذه الشاشة")
    return
  }
  runCatching {
    val options = GmsBarcodeScannerOptions.Builder()
      .setBarcodeFormats(Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_CODE_128, Barcode.FORMAT_UPC_A, Barcode.FORMAT_UPC_E)
      .enableAutoZoom()
      .build()
    GmsBarcodeScanning.getClient(activity, options).startScan()
      .addOnSuccessListener { code -> code.rawValue?.let(onResult) }
      .addOnFailureListener { error -> viewModel.showMessage("تعذر فتح الماسح: ${error.message ?: "أعد المحاولة"}") }
  }.onFailure { error -> viewModel.showMessage("تعذر تشغيل الماسح: ${error.message ?: "أعد المحاولة"}") }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PurchaseInvoiceScreen(state: ScannerState, viewModel: ScannerViewModel, onClose: () -> Unit) {
  val activity = LocalActivity.current
  var supplierName by rememberSaveable { mutableStateOf("") }
  var supplierInvoiceNo by rememberSaveable { mutableStateOf("") }
  var productQuery by rememberSaveable { mutableStateOf("") }
  var lines by remember { mutableStateOf(emptyList<PurchaseInvoiceLine>()) }
  LaunchedEffect(state.postedPurchaseReceipt?.receipt?.receiptId) {
    val posted = state.postedPurchaseReceipt ?: return@LaunchedEffect
    if (activity != null) printPurchaseReceipt(activity, posted)
    viewModel.clearPostedPurchaseReceipt()
  }
  Scaffold(topBar = {
    TopAppBar(
      title = { Text("فاتورة توريد جديدة") },
      navigationIcon = { TextButton(onClick = onClose) { Text("رجوع") } },
    )
  }) { padding ->
    LazyColumn(
      modifier = Modifier.fillMaxSize().padding(padding),
      contentPadding = PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      item {
        Text("استلام سريع من المورد", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        Text("أضف المنتجات، حدّد سعر الجملة وسعر البيع، ثم تُسجل فاتورة واحدة وتُفتح نافذة الطباعة.", style = MaterialTheme.typography.bodySmall)
        AppField("اسم المورد", supplierName, { supplierName = it }, "مثال: شركة التوزيع")
        AppField("رقم فاتورة المورد (اختياري)", supplierInvoiceNo, { supplierInvoiceNo = it })
      }
      item {
        Text("إضافة صنف إلى الفاتورة", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        AppField("اسم المنتج أو الباركود", productQuery, { productQuery = it }, "امسح أو اكتب")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
          FilledTonalButton(onClick = { startBarcodeScan(activity, viewModel) { productQuery = it; viewModel.search(it) } }, modifier = Modifier.weight(1f)) { Text("مسح باركود") }
          Button(onClick = { viewModel.search(productQuery) }, modifier = Modifier.weight(1f)) { Text("إضافة من الكتالوج") }
        }
      }
      val candidates = (listOfNotNull(state.product) + state.searchResults).distinctBy { it.id }.take(8)
      if (productQuery.isNotBlank() && candidates.isNotEmpty()) {
        items(candidates, key = { "candidate-${it.id}" }) { product ->
          OutlinedCard(onClick = {
            val existing = lines.indexOfFirst { it.product.id == product.id }
            lines = if (existing < 0) lines + PurchaseInvoiceLine(product, purchaseCostMinor = product.wholesalePriceMinor ?: 0, retailPriceMinor = product.priceMinor)
            else lines.mapIndexed { index, line -> if (index == existing) line.copy(quantity = line.quantity + 1) else line }
            productQuery = ""
          }, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp)) {
              Text(product.nameAr, fontWeight = FontWeight.SemiBold)
              Text("اضغط لإضافته إلى الفاتورة", style = MaterialTheme.typography.bodySmall)
            }
          }
        }
      } else if (productQuery.isNotBlank() && !state.loading) {
        item { Text("لم يُعثر على الصنف. سجّله من شاشة البحث أولًا؛ سيولّد التطبيق باركودًا تلقائيًا إن لم يتوفر.", color = MaterialTheme.colorScheme.tertiary, style = MaterialTheme.typography.bodySmall) }
      }
      if (lines.isNotEmpty()) {
        item { Text("بنود الفاتورة", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold) }
        items(lines, key = { it.product.id }) { line ->
          PurchaseLineEditor(
            line = line,
            onChange = { changed -> lines = lines.map { if (it.product.id == changed.product.id) changed else it } },
            onRemove = { lines = lines.filterNot { it.product.id == line.product.id } },
          )
        }
        val total = lines.sumOf { purchaseLineTotalMinor(it) }
        item {
          Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
              Text("إجمالي الفاتورة: ${formatMoney(total.coerceAtMost(Int.MAX_VALUE.toLong()).toInt())}", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
              Text("يشمل قيمة البضاعة فقط؛ المصروفات الإضافية تُسجل من برنامج Windows حاليًا.", style = MaterialTheme.typography.bodySmall)
            }
          }
          Button(onClick = { viewModel.postPurchaseReceipt(supplierName, supplierInvoiceNo, lines) }, enabled = !state.loading, modifier = Modifier.fillMaxWidth()) {
            Text(if (state.loading) "جارٍ حفظ الفاتورة…" else "استلام وطباعة الفاتورة")
          }
        }
      }
      state.message?.let { message -> item { Notice(message, message.startsWith("تم")) } }
    }
  }
}

@Composable
private fun PurchaseLineEditor(line: PurchaseInvoiceLine, onChange: (PurchaseInvoiceLine) -> Unit, onRemove: () -> Unit) {
  var quantityText by rememberSaveable(line.product.id) { mutableStateOf(line.quantity.toString()) }
  var costText by rememberSaveable(line.product.id) { mutableStateOf(formatAmountForInput(line.purchaseCostMinor)) }
  var retailText by rememberSaveable(line.product.id) { mutableStateOf(formatAmountForInput(line.retailPriceMinor)) }
  var expiryDay by rememberSaveable(line.product.id) { mutableStateOf(line.expiresOn?.takeLast(2)?.trimStart('0').orEmpty()) }
  var expiryMonth by rememberSaveable(line.product.id) { mutableStateOf(line.expiresOn?.substring(5, 7)?.trimStart('0').orEmpty()) }
  var expiryYear by rememberSaveable(line.product.id) { mutableStateOf(line.expiresOn?.take(4).orEmpty()) }
  fun updateExpiry() = onChange(line.copy(expiresOn = expiryDateFromParts(expiryYear, expiryMonth, expiryDay)))
  LaunchedEffect(line.quantity) { if (quantityText != line.quantity.toString()) quantityText = line.quantity.toString() }
  OutlinedCard(modifier = Modifier.fillMaxWidth()) {
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text(line.product.nameAr, fontWeight = FontWeight.Bold)
      if (line.product.purchasePackSize >= 2) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          FilterChip(selected = line.entryUnit == "PIECE", onClick = { onChange(line.copy(entryUnit = "PIECE")) }, label = { Text("قطع") })
          FilterChip(selected = line.entryUnit == "CARTON", onClick = { onChange(line.copy(entryUnit = "CARTON")) }, label = { Text("كراتين (${line.product.purchasePackSize})") })
        }
      }
      AppField(if (line.entryUnit == "CARTON") "عدد الكراتين" else "عدد القطع", quantityText, { value -> quantityText = value; onChange(line.copy(quantity = value.toLongOrNull() ?: 0)) }, keyboardType = KeyboardType.Number)
      AppField(if (line.entryUnit == "CARTON") "سعر جملة الكرتونة" else "سعر جملة القطعة", costText, { value -> costText = value; onChange(line.copy(purchaseCostMinor = parseMoneyToMinor(value) ?: 0)) }, keyboardType = KeyboardType.Decimal)
      AppField("سعر بيع الوحدة", retailText, { value -> retailText = value; onChange(line.copy(retailPriceMinor = parseMoneyToMinor(value) ?: 0)) }, keyboardType = KeyboardType.Decimal)
      Text("تاريخ الصلاحية (اختياري)", style = MaterialTheme.typography.bodySmall)
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        OutlinedTextField(expiryDay, { expiryDay = it; updateExpiry() }, Modifier.weight(1f), label = { Text("يوم") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        OutlinedTextField(expiryMonth, { expiryMonth = it; updateExpiry() }, Modifier.weight(1f), label = { Text("شهر") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        OutlinedTextField(expiryYear, { expiryYear = it; updateExpiry() }, Modifier.weight(1f), label = { Text("سنة") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
      }
      Text("اترك الثلاثة فارغة إن لم تتوفر. اليوم الفارغ = آخر يوم بالشهر.", style = MaterialTheme.typography.bodySmall)
      Text("إجمالي السطر: ${formatMoney(purchaseLineTotalMinor(line).coerceAtMost(Int.MAX_VALUE.toLong()).toInt())}", style = MaterialTheme.typography.bodySmall)
      TextButton(onClick = onRemove, modifier = Modifier.fillMaxWidth()) { Text("حذف من الفاتورة") }
    }
  }
}

private fun purchaseLineTotalMinor(line: PurchaseInvoiceLine): Long =
  runCatching { Math.multiplyExact(line.quantity, line.purchaseCostMinor.toLong()) }.getOrDefault(0L)

private fun printPurchaseReceipt(activity: Activity, posted: PostedPurchaseReceipt) {
  val rows = posted.lines.joinToString("") { line -> "<tr><td>${html(line.product.nameAr)}</td><td>${line.quantity}</td><td>${html(if (line.entryUnit == "CARTON") "كرتونة" else "قطعة")}</td><td>${html(formatMoney(purchaseLineTotalMinor(line).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()))}</td></tr>" }
  val content = """<html dir='rtl'><meta charset='utf-8'><style>body{font-family:sans-serif;padding:18px}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:right}h1{font-size:20px}</style><body><h1>إيصال استلام توريد</h1><p>المورد: ${html(posted.supplierName)}<br>رقم الفاتورة: ${html(posted.supplierInvoiceNo.ifBlank { "—" })}<br>التاريخ: ${html(posted.receipt.postedAt)}</p><table><tr><th>الصنف</th><th>الكمية</th><th>الوحدة</th><th>الإجمالي</th></tr>$rows</table><h2>الإجمالي: ${html(formatMoney(posted.receipt.totalMinor))}</h2><p>رقم الاستلام: ${html(posted.receipt.receiptId)}</p></body></html>"""
  val webView = WebView(activity)
  webView.settings.defaultTextEncodingName = "utf-8"
  webView.webViewClient = object : WebViewClient() {
    override fun onPageFinished(view: WebView, url: String) {
      val manager = activity.getSystemService(Context.PRINT_SERVICE) as? PrintManager ?: return
      manager.print("Nabta-Purchase-${posted.receipt.receiptId.take(8)}", view.createPrintDocumentAdapter("Nabta purchase receipt"), PrintAttributes.Builder().build())
    }
  }
  webView.loadDataWithBaseURL(null, content, "text/html", "UTF-8", null)
}

private fun html(value: String): String = value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

@Composable
private fun BarcodeSearch(
  value: String,
  onQueryChange: (String) -> Unit,
  onSearch: (String) -> Unit,
  onScan: ((String) -> Unit) -> Unit,
) {
  var query by rememberSaveable { mutableStateOf(value) }
  var lastSearch by rememberSaveable { mutableStateOf("") }
  LaunchedEffect(value) { if (value != query) query = value }
  LaunchedEffect(query) {
    val text = query.trim()
    if (text.length >= 2 && text != lastSearch) {
      delay(280)
      if (query.trim() == text) {
        lastSearch = text
        onSearch(text)
      }
    }
  }
  Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    OutlinedTextField(
      value = query,
      onValueChange = { next -> query = next; onQueryChange(next) },
      modifier = Modifier.weight(1f),
      label = { Text("باركود أو اسم المنتج") },
      placeholder = { Text("امسح أو اكتب أول حرفين") },
      singleLine = true,
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
      keyboardActions = KeyboardActions(onSearch = { lastSearch = query.trim(); onSearch(query) }),
    )
    FilledTonalButton(
      onClick = {
        onScan { barcode ->
          query = barcode
          lastSearch = barcode
          onSearch(barcode)
        }
      },
      modifier = Modifier.height(56.dp),
    ) { Text("مسح") }
  }
  Button(onClick = { lastSearch = query.trim(); onSearch(query) }, modifier = Modifier.fillMaxWidth()) { Text("بحث الآن") }
}

@Composable
private fun ProductRow(product: Product, onClick: () -> Unit) = OutlinedCard(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
  Column(Modifier.padding(14.dp)) {
    Text(product.nameAr, fontWeight = FontWeight.Bold)
    Text("${product.category} · ${formatMoney(product.priceMinor)}")
    Text("المتاح ${formatQuantity(product)}", style = MaterialTheme.typography.bodySmall)
  }
}

@Composable
private fun ProductDetails(product: Product) = Card(
  modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
  colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
) {
  Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text(product.nameAr, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
    Text("${product.category} · ${if (product.unitKind == "PIECE") "قطعة" else weightUnitLabel(product.weightUnit)}")
    if (product.barcodes.isNotEmpty()) Text(product.barcodeMappings.ifEmpty { product.barcodes.map { BarcodeMapping(it, "UNIT") } }.joinToString(" • ") { "${barcodeUnitLabel(it.saleUnit)}: ${it.barcode}" }, style = MaterialTheme.typography.bodySmall)
    Text("سعر البيع: ${formatMoney(product.priceMinor)}")
    product.wholesalePriceMinor?.let { Text("سعر الجملة: ${formatMoney(it)}") }
    Text("الكمية المتاحة: ${formatQuantity(product)}")
    product.retailPackage?.let { Text("عبوة ${it.unitsPerPackage} ${contentsUnitLabel(it.contentsUnit)} — ${formatMoney(it.packagePriceMinor)}") }
    product.cartonPriceMinor?.let { Text("كرتونة ${product.purchasePackSize} ${contentsUnitLabel(product.cartonContentsUnit ?: "PIECE")} — ${formatMoney(it)}") }
    if (product.description.isNotBlank()) Text(product.description)
  }
}

@Composable
private fun ProductActions(enabled: Boolean, onIncrease: () -> Unit, onExpiry: () -> Unit, onPrice: () -> Unit, onEdit: () -> Unit, onClear: () -> Unit) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      Button(onClick = onIncrease, enabled = enabled, modifier = Modifier.weight(1f)) { Text("زيادة كمية") }
      FilledTonalButton(onClick = onPrice, enabled = enabled, modifier = Modifier.weight(1f)) { Text("تعديل سعر") }
    }
    FilledTonalButton(onClick = onExpiry, enabled = enabled, modifier = Modifier.fillMaxWidth()) { Text("تسجيل تاريخ الصلاحية") }
    OutlinedButton(onClick = onEdit, enabled = enabled, modifier = Modifier.fillMaxWidth()) { Text("تعديل بيانات الصنف والكمية") }
    TextButton(onClick = onClear, modifier = Modifier.fillMaxWidth()) { Text("بحث جديد") }
  }
}

@Composable
private fun StockIncrease(product: Product, onCancel: () -> Unit, onSaveUnits: (Long) -> Unit, onSaveCartons: (Long) -> Unit) {
  var quantity by rememberSaveable(product.id) { mutableStateOf("") }
  var entryUnit by rememberSaveable(product.id) { mutableStateOf("UNIT") }
  Text("إضافة كمية إلى ${product.nameAr}", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
  if (product.unitKind == "PIECE" && product.purchasePackSize >= 2) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      FilterChip(selected = entryUnit == "UNIT", onClick = { entryUnit = "UNIT" }, label = { Text("قطع/أكياس") })
      FilterChip(selected = entryUnit == "CARTON", onClick = { entryUnit = "CARTON" }, label = { Text("كراتين (${product.purchasePackSize})") })
    }
  }
  AppField(
    if (entryUnit == "CARTON") "عدد الكراتين" else quantityLabel(product),
    quantity,
    { quantity = it },
    if (entryUnit == "CARTON") "مثال: 3" else if (product.unitKind == "PIECE") "مثال: 12" else "مثال: 1.250",
    keyboardType = KeyboardType.Decimal,
  )
  ActionRow(onCancel = onCancel, onSave = {
    if (entryUnit == "CARTON") onSaveCartons(quantity.trim().toLongOrNull() ?: 0)
    else onSaveUnits(parseQuantityToMilli(quantity, product.unitKind) ?: 0)
  }, saveLabel = "حفظ الزيادة")
}

/** Fast one-product expiry flow used after scanning a packet, bag, or carton. */
@Composable
private fun ExpiryRegistration(product: Product, onCancel: () -> Unit, onSave: (Long, String) -> Unit) {
  var amount by rememberSaveable(product.id) { mutableStateOf("1") }
  var entryUnit by rememberSaveable(product.id) { mutableStateOf("UNIT") }
  var day by rememberSaveable(product.id) { mutableStateOf("") }
  var month by rememberSaveable(product.id) { mutableStateOf("") }
  var year by rememberSaveable(product.id) { mutableStateOf("") }
  var validation by rememberSaveable(product.id) { mutableStateOf("") }
  Text("تسجيل صلاحية: ${product.nameAr}", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
  Text("لا يضيف مخزونًا ولا يغيّر الرصيد؛ يربط الكمية الموجودة بتاريخ صلاحيتها.", style = MaterialTheme.typography.bodySmall)
  if (product.unitKind == "PIECE" && (product.retailPackage != null || product.purchasePackSize >= 2)) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      FilterChip(selected = entryUnit == "UNIT", onClick = { entryUnit = "UNIT" }, label = { Text("قطع") })
      product.retailPackage?.let { pack ->
        FilterChip(selected = entryUnit == "PACKAGE", onClick = { entryUnit = "PACKAGE" }, label = { Text("عبوات (${pack.unitsPerPackage})") })
      }
      if (product.purchasePackSize >= 2) {
        FilterChip(selected = entryUnit == "CARTON", onClick = { entryUnit = "CARTON" }, label = { Text("كراتين (${product.purchasePackSize})") })
      }
    }
  }
  AppField(
    when (entryUnit) { "CARTON" -> "عدد الكراتين"; "PACKAGE" -> "عدد العبوات"; else -> quantityLabel(product) },
    amount,
    { amount = it },
    "مثال: 1",
    keyboardType = KeyboardType.Decimal,
  )
  Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
    OutlinedTextField(day, { day = it }, Modifier.weight(1f), label = { Text("اليوم اختياري") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
    OutlinedTextField(month, { month = it }, Modifier.weight(1f), label = { Text("الشهر") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
    OutlinedTextField(year, { year = it }, Modifier.weight(1f), label = { Text("السنة") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
  }
  Text("إن تركت اليوم فارغًا يُعتمد آخر يوم من الشهر.", style = MaterialTheme.typography.bodySmall)
  if (validation.isNotBlank()) Text(validation, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
  ActionRow(onCancel = onCancel, onSave = {
    val expiry = expiryDateFromParts(year, month, day)
    val multiplier = when (entryUnit) {
      "CARTON" -> product.purchasePackSize.toLong()
      "PACKAGE" -> product.retailPackage?.unitsPerPackage?.toLong() ?: 1L
      else -> 1L
    }
    val qty = if (product.unitKind == "PIECE") amount.trim().toLongOrNull()?.let { it * multiplier * 1_000L }
      else parseQuantityToMilli(amount, product.unitKind)
    if (expiry == null) validation = "أدخل شهرًا وسنة صحيحين (واليوم اختياري)."
    else if (qty == null || qty <= 0) validation = "أدخل كمية صحيحة أكبر من صفر."
    else onSave(qty, expiry)
  }, saveLabel = "حفظ الصلاحية")
}

@Composable
private fun SalePriceEditor(product: Product, onCancel: () -> Unit, onSave: (Int) -> Unit) {
  var price by rememberSaveable(product.id) { mutableStateOf(formatAmountForInput(product.priceMinor)) }
  Text("تعديل سعر البيع: ${product.nameAr}", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
  AppField("سعر البيع الجديد بالجنيه", price, { price = it }, "مثال: 12.50", keyboardType = KeyboardType.Decimal)
  ActionRow(onCancel = onCancel, onSave = { onSave(parseMoneyToMinor(price) ?: 0) }, saveLabel = "حفظ السعر")
}

@Composable
private fun ProductEditor(
  product: Product,
  onCancel: () -> Unit,
  onSave: (String, String, String, Int, Long, Int?) -> Unit,
) {
  var name by rememberSaveable(product.id) { mutableStateOf(product.nameAr) }
  var category by rememberSaveable(product.id) { mutableStateOf(product.category) }
  var description by rememberSaveable(product.id) { mutableStateOf(product.description) }
  var price by rememberSaveable(product.id) { mutableStateOf(formatAmountForInput(product.priceMinor)) }
  var quantity by rememberSaveable(product.id) { mutableStateOf(formatQuantityInput(product.availableQtyMilli, product.unitKind)) }
  var cost by rememberSaveable(product.id) { mutableStateOf(product.wholesalePriceMinor?.let(::formatAmountForInput).orEmpty()) }
  Text("تعديل بطاقة الصنف", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
  Text("الحفظ يسجل مراجعة للكمية ويمنع التعارض إذا تغير الرصيد من جهاز آخر.", style = MaterialTheme.typography.bodySmall)
  AppField("اسم الصنف", name, { name = it })
  AppField("التصنيف", category, { category = it })
  AppField("وصف اختياري", description, { description = it })
  AppField("سعر البيع بالجنيه", price, { price = it }, keyboardType = KeyboardType.Decimal)
  AppField(quantityLabel(product), quantity, { quantity = it }, keyboardType = KeyboardType.Decimal)
  if (product.wholesalePriceMinor != null) AppField("سعر الجملة بالجنيه", cost, { cost = it }, keyboardType = KeyboardType.Decimal)
  ActionRow(
    onCancel = onCancel,
    onSave = { onSave(name, category, description, parseMoneyToMinor(price) ?: -1, parseQuantityToMilli(quantity, product.unitKind) ?: -1, if (product.wholesalePriceMinor != null) parseMoneyToMinor(cost) else null) },
    saveLabel = "حفظ التعديل",
  )
}

@Composable
private fun NewProductForm(
  barcode: String,
  generatedBarcode: GeneratedBarcode?,
  onGeneratedBarcodeConsumed: () -> Unit,
  onGenerateBarcode: (BarcodeSlot) -> Unit,
  onScanBarcode: (BarcodeSlot, (String) -> Unit) -> Unit,
  onSave: (String, String, String, String, String, Int, Long, Int, Int, Int?, String?, String?, RetailPackage?, String?) -> Unit,
) {
  var name by rememberSaveable(barcode) { mutableStateOf("") }
  var category by rememberSaveable(barcode) { mutableStateOf("") }
  var unitBarcode by rememberSaveable(barcode) { mutableStateOf(barcode.takeIf { it.matches(Regex("\\d{8,14}")) }.orEmpty()) }
  var unitKind by rememberSaveable(barcode) { mutableStateOf("PIECE") }
  var weightUnit by rememberSaveable(barcode) { mutableStateOf("KILOGRAM") }
  var price by rememberSaveable(barcode) { mutableStateOf("") }
  var quantity by rememberSaveable(barcode) { mutableStateOf("") }
  var cost by rememberSaveable(barcode) { mutableStateOf("") }
  var hasCarton by rememberSaveable(barcode) { mutableStateOf(false) }
  var cartonSize by rememberSaveable(barcode) { mutableStateOf("") }
  var cartonPrice by rememberSaveable(barcode) { mutableStateOf("") }
  var cartonBarcode by rememberSaveable(barcode) { mutableStateOf("") }
  var cartonContentsUnit by rememberSaveable(barcode) { mutableStateOf("PIECE") }
  var hasPackage by rememberSaveable(barcode) { mutableStateOf(false) }
  var packageSize by rememberSaveable(barcode) { mutableStateOf("") }
  var packagePrice by rememberSaveable(barcode) { mutableStateOf("") }
  var packageBarcode by rememberSaveable(barcode) { mutableStateOf("") }
  var packageContentsUnit by rememberSaveable(barcode) { mutableStateOf("BAG") }
  LaunchedEffect(generatedBarcode) {
    when (generatedBarcode?.slot) {
      BarcodeSlot.UNIT -> unitBarcode = generatedBarcode.barcode
      BarcodeSlot.CARTON -> cartonBarcode = generatedBarcode.barcode
      BarcodeSlot.PACKAGE -> packageBarcode = generatedBarcode.barcode
      null -> Unit
    }
    if (generatedBarcode != null) onGeneratedBarcodeConsumed()
  }
  Card(Modifier.fillMaxWidth().padding(top = 6.dp)) {
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text("تسجيل صنف جديد", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
      Text("سجّل باركود الوحدة المفردة، ثم أضف باركود الكرتونة أو العبوة/الكيس عند توفره.", style = MaterialTheme.typography.bodySmall)
      AppField("اسم الصنف", name, { name = it })
      AppField("التصنيف", category, { category = it })
      BarcodeInput("باركود الوحدة المفردة (قطعة أو كيس)", unitBarcode, { unitBarcode = it }, BarcodeSlot.UNIT, onGenerateBarcode, onScanBarcode)
      Text("طريقة التخزين والبيع", style = MaterialTheme.typography.labelLarge)
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(selected = unitKind == "PIECE", onClick = { unitKind = "PIECE" }, label = { Text("قطعة") })
        FilterChip(selected = unitKind == "WEIGHT", onClick = { unitKind = "WEIGHT" }, label = { Text("وزن/سائل") })
      }
      if (unitKind == "WEIGHT") {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
          FilterChip(selected = weightUnit == "KILOGRAM", onClick = { weightUnit = "KILOGRAM" }, label = { Text("كيلو") })
          FilterChip(selected = weightUnit == "GRAM", onClick = { weightUnit = "GRAM" }, label = { Text("جرام") })
          FilterChip(selected = weightUnit == "LITER", onClick = { weightUnit = "LITER" }, label = { Text("لتر") })
        }
      }
      AppField("سعر البيع بالجنيه", price, { price = it }, "مثال: 12.50", keyboardType = KeyboardType.Decimal)
      AppField(if (unitKind == "PIECE") "الكمية الافتتاحية (قطعة)" else "الكمية الافتتاحية (${weightUnitLabel(weightUnit)})", quantity, { quantity = it }, "مثال: ${if (unitKind == "PIECE") "12" else "1.250"}", keyboardType = KeyboardType.Decimal)
      AppField("تكلفة الوحدة بالجنيه", cost, { cost = it }, "مثال: 8.00", keyboardType = KeyboardType.Decimal)
      if (unitKind == "PIECE") {
        FilterChip(selected = hasCarton, onClick = { hasCarton = !hasCarton }, label = { Text("يباع أو يُستلم في كراتين") })
        if (hasCarton) {
          Text("بيانات الكرتونة", style = MaterialTheme.typography.labelLarge)
          AppField("عدد المحتويات في الكرتونة", cartonSize, { cartonSize = it }, "مثال: 24", keyboardType = KeyboardType.Number)
          AppField("سعر بيع الكرتونة بالجنيه", cartonPrice, { cartonPrice = it }, "مثال: 240.00", keyboardType = KeyboardType.Decimal)
          BarcodeInput("باركود الكرتونة", cartonBarcode, { cartonBarcode = it }, BarcodeSlot.CARTON, onGenerateBarcode, onScanBarcode)
          Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilterChip(selected = cartonContentsUnit == "PIECE", onClick = { cartonContentsUnit = "PIECE" }, label = { Text("تحتوي قطع") })
            FilterChip(selected = cartonContentsUnit == "BAG", onClick = { cartonContentsUnit = "BAG" }, label = { Text("تحتوي أكياس") })
          }
        }
        FilterChip(selected = hasPackage, onClick = { hasPackage = !hasPackage }, label = { Text("له عبوة/باكت بسعر وباركود مستقلين") })
        if (hasPackage) {
          Text("بيانات العبوة أو الباكت", style = MaterialTheme.typography.labelLarge)
          AppField("عدد المحتويات في العبوة", packageSize, { packageSize = it }, "مثال: 6", keyboardType = KeyboardType.Number)
          AppField("سعر بيع العبوة بالجنيه", packagePrice, { packagePrice = it }, "مثال: 60.00", keyboardType = KeyboardType.Decimal)
          BarcodeInput("باركود العبوة/الكيس", packageBarcode, { packageBarcode = it }, BarcodeSlot.PACKAGE, onGenerateBarcode, onScanBarcode)
          Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilterChip(selected = packageContentsUnit == "BAG", onClick = { packageContentsUnit = "BAG" }, label = { Text("محتواها أكياس") })
            FilterChip(selected = packageContentsUnit == "PIECE", onClick = { packageContentsUnit = "PIECE" }, label = { Text("محتواها قطع") })
          }
        }
      }
      Button(
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        onClick = {
          val cartonCount = cartonSize.trim().toIntOrNull() ?: 0
          val retailPackage = if (hasPackage) RetailPackage(packageSize.trim().toIntOrNull() ?: 0, parseMoneyToMinor(packagePrice) ?: 0, packageContentsUnit) else null
          onSave(name, category, unitBarcode, unitKind, weightUnit, parseMoneyToMinor(price) ?: 0, parseQuantityToMilli(quantity, unitKind) ?: -1, parseMoneyToMinor(cost) ?: -1, if (hasCarton) cartonCount else 1, if (hasCarton) (parseMoneyToMinor(cartonPrice) ?: -1) else null, if (hasCarton) cartonContentsUnit else null, if (hasCarton) cartonBarcode else null, retailPackage, if (hasPackage) packageBarcode else null)
        },
      ) { Text("حفظ الصنف") }
    }
  }
}

@Composable
private fun BarcodeInput(
  label: String,
  value: String,
  onChange: (String) -> Unit,
  slot: BarcodeSlot,
  onGenerate: (BarcodeSlot) -> Unit,
  onScan: (BarcodeSlot, (String) -> Unit) -> Unit,
) {
  AppField(label, value, onChange, "8 إلى 14 رقمًا", keyboardType = KeyboardType.Number)
  Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
    FilledTonalButton(onClick = { onScan(slot, onChange) }, modifier = Modifier.weight(1f)) { Text("مسح الباركود") }
    OutlinedButton(onClick = { onGenerate(slot) }, modifier = Modifier.weight(1f)) { Text("توليد تلقائي") }
  }
}

@Composable
private fun ActionRow(onCancel: () -> Unit, onSave: () -> Unit, saveLabel: String) {
  Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
    Button(onClick = onSave) { Text(saveLabel) }
    OutlinedButton(onClick = onCancel) { Text("إلغاء") }
  }
}

@Composable
private fun AppField(
  label: String,
  value: String,
  onChange: (String) -> Unit,
  placeholder: String = "",
  password: Boolean = false,
  keyboardType: KeyboardType = KeyboardType.Text,
) = OutlinedTextField(
  value = value,
  onValueChange = onChange,
  modifier = Modifier.fillMaxWidth(),
  label = { Text(label) },
  placeholder = { Text(placeholder) },
  singleLine = true,
  keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
  visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
)

@Composable
private fun Notice(text: String, success: Boolean) = Text(
  text,
  color = if (success) Color(0xFF087C61) else MaterialTheme.colorScheme.error,
  modifier = Modifier.padding(vertical = 4.dp),
)

private fun formatMoney(minor: Int) = "${formatAmountForInput(minor)} ج.م"
private fun formatQuantity(product: Product) = "${formatQuantityInput(product.availableQtyMilli, product.unitKind)} ${if (product.unitKind == "PIECE") "قطعة" else weightUnitLabel(product.weightUnit)}"
private fun formatQuantityInput(quantityMilli: Long, unitKind: String): String = if (unitKind == "PIECE") (quantityMilli / 1000L).toString() else BigDecimal.valueOf(quantityMilli, 3).stripTrailingZeros().toPlainString()
private fun quantityLabel(product: Product) = if (product.unitKind == "PIECE") "الكمية بالقطعة" else "الكمية المتاحة (${weightUnitLabel(product.weightUnit)})"
private fun weightUnitLabel(unit: String) = when (unit) { "GRAM" -> "جرام"; "LITER" -> "لتر"; "MILLILITER" -> "مل"; else -> "كيلو" }
private fun contentsUnitLabel(unit: String) = if (unit == "BAG") "كيس" else "قطعة"
private fun barcodeUnitLabel(unit: String) = when (unit) { "CARTON" -> "كرتونة"; "PACKAGE" -> "عبوة/كيس"; else -> "وحدة" }
private fun formatAmountForInput(minor: Int) = BigDecimal.valueOf(minor.toLong(), 2).toPlainString()
private fun parseMoneyToMinor(value: String): Int? = runCatching {
  BigDecimal(value.trim().replace('،', '.').replace(',', '.')).movePointRight(2).setScale(0, RoundingMode.HALF_UP).intValueExact()
}.getOrNull()
private fun parseQuantityToMilli(value: String, unitKind: String): Long? = runCatching {
  if (unitKind == "PIECE") Math.multiplyExact(value.trim().toLong(), 1000L)
  else BigDecimal(value.trim().replace('،', '.').replace(',', '.')).movePointRight(3).setScale(0, RoundingMode.HALF_UP).longValueExact()
}.getOrNull()

/** A supplier may print only month/year; we conservatively use the month's last day. */
private fun expiryDateFromParts(yearText: String, monthText: String, dayText: String): String? {
  if (yearText.isBlank() && monthText.isBlank() && dayText.isBlank()) return null
  val year = yearText.trim().toIntOrNull() ?: return null
  val month = monthText.trim().toIntOrNull() ?: return null
  return runCatching {
    val yearMonth = YearMonth.of(year, month)
    val day = dayText.trim().toIntOrNull() ?: yearMonth.lengthOfMonth()
    if (day !in 1..yearMonth.lengthOfMonth()) return null
    "%04d-%02d-%02d".format(year, month, day)
  }.getOrNull()
}
