package net.de5.nabta.inventoryscanner

import android.app.Activity
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
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
    setContent { NabtaExpiryTheme { ExpiryApp() } }
  }
}

@Composable
private fun NabtaExpiryTheme(content: @Composable () -> Unit) = MaterialTheme(
  colorScheme = androidx.compose.material3.lightColorScheme(
    primary = Color(0xFF087C61), secondary = Color(0xFF105B48), tertiary = Color(0xFF0F766E), error = Color(0xFFB3261E),
  ),
  content = content,
)

@Composable
private fun ExpiryApp(viewModel: ScannerViewModel = viewModel()) {
  val state by viewModel.state.collectAsStateWithLifecycle()
  Surface(Modifier.fillMaxSize()) {
    if (state.session == null) LoginScreen(state.savedLoginDetails, state.loading, state.message, viewModel::login)
    else ExpiryOnlyScreen(state, viewModel)
  }
}

/** This APK intentionally exposes barcode lookup and expiry registration only. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ExpiryOnlyScreen(state: ScannerState, viewModel: ScannerViewModel) {
  val activity = LocalActivity.current
  val selectedProduct = state.product
  Scaffold(topBar = {
    TopAppBar(
      title = { Text("نبتة صلاحية") },
      actions = { TextButton(onClick = viewModel::logout) { Text("خروج") } },
    )
  }) { padding ->
    LazyColumn(
      modifier = Modifier.fillMaxSize().padding(padding),
      contentPadding = PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      item {
        Text("تسجيل صلاحية المنتجات", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text("امسح الباركود ثم أدخل اليوم اختياريًا والشهر والسنة. لا يمكن من هذا التطبيق إضافة صنف أو تغيير سعر أو كمية.", style = MaterialTheme.typography.bodySmall)
        if (state.pendingMutations > 0) Text("${state.pendingMutations} تسجيل صلاحية محفوظ للمزامنة عند عودة الاتصال.", color = MaterialTheme.colorScheme.tertiary, style = MaterialTheme.typography.bodySmall)
      }
      item {
        BarcodeSearch(
          value = state.query,
          onQueryChange = viewModel::previewSearch,
          onSearch = viewModel::search,
          onScan = { result -> startBarcodeScan(activity, viewModel, result) },
        )
      }
      state.message?.let { item { Notice(it, it.startsWith("تم")) } }
      if (state.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
      if (selectedProduct == null && state.searchResults.isNotEmpty()) {
        item { Text("اختر الصنف المطابق", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold) }
        items(state.searchResults, key = { it.id }) { product -> ProductRow(product) { viewModel.select(product) } }
      }
      if (selectedProduct != null) {
        item { ProductDetails(selectedProduct) }
        item { ExpiryRegistration(selectedProduct, viewModel::clearProduct, viewModel::registerExpiry) }
        item { TextButton(onClick = viewModel::clearProduct, modifier = Modifier.fillMaxWidth()) { Text("مسح منتج آخر") } }
      } else if (state.query.isNotBlank() && !state.loading && state.searchResults.isEmpty()) {
        item { Notice("هذا الباركود غير مسجل في نبتة. راجع المسؤول لإضافة الصنف أولاً.", false) }
      }
    }
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
      Text("نبتة صلاحية", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
      Text("تطبيق الموظفين لتسجيل صلاحية المنتجات فقط.")
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

@Composable
private fun BarcodeSearch(value: String, onQueryChange: (String) -> Unit, onSearch: (String) -> Unit, onScan: ((String) -> Unit) -> Unit) {
  var query by rememberSaveable { mutableStateOf(value) }
  var lastSearch by rememberSaveable { mutableStateOf("") }
  LaunchedEffect(value) { if (value != query) query = value }
  LaunchedEffect(query) {
    val text = query.trim()
    if (text.length >= 2 && text != lastSearch) {
      delay(280)
      if (query.trim() == text) { lastSearch = text; onSearch(text) }
    }
  }
  Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    OutlinedTextField(
      value = query, onValueChange = { next -> query = next; onQueryChange(next) }, modifier = Modifier.weight(1f),
      label = { Text("باركود أو اسم المنتج") }, placeholder = { Text("امسح أو اكتب أول حرفين") }, singleLine = true,
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
      keyboardActions = KeyboardActions(onSearch = { lastSearch = query.trim(); onSearch(query) }),
    )
    FilledTonalButton(onClick = { onScan { barcode -> query = barcode; lastSearch = barcode; onSearch(barcode) } }, modifier = Modifier.height(56.dp)) { Text("مسح") }
  }
  Button(onClick = { lastSearch = query.trim(); onSearch(query) }, modifier = Modifier.fillMaxWidth()) { Text("بحث الآن") }
}

@Composable
private fun ProductRow(product: Product, onClick: () -> Unit) = OutlinedCard(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
  Column(Modifier.padding(14.dp)) {
    Text(product.nameAr, fontWeight = FontWeight.Bold)
    Text(product.category, style = MaterialTheme.typography.bodySmall)
  }
}

@Composable
private fun ProductDetails(product: Product) = Card(
  modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
  colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
) {
  Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text(product.nameAr, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
    Text(product.category)
    if (product.barcodes.isNotEmpty()) Text(product.barcodes.joinToString(" • "), style = MaterialTheme.typography.bodySmall)
    Text("الرصيد المتاح: ${formatQuantity(product)}", style = MaterialTheme.typography.bodySmall)
  }
}

@Composable
private fun ExpiryRegistration(product: Product, onCancel: () -> Unit, onSave: (Long, String) -> Unit) {
  var amount by rememberSaveable(product.id) { mutableStateOf("1") }
  var entryUnit by rememberSaveable(product.id) { mutableStateOf("UNIT") }
  var day by rememberSaveable(product.id) { mutableStateOf("") }
  var month by rememberSaveable(product.id) { mutableStateOf("") }
  var year by rememberSaveable(product.id) { mutableStateOf("") }
  var validation by rememberSaveable(product.id) { mutableStateOf("") }
  Text("تسجيل صلاحية: ${product.nameAr}", style = MaterialTheme.typography.titleMedium)
  Text("لا يضيف مخزونًا ولا يغير الرصيد؛ يربط كمية موجودة بتاريخ صلاحيتها.", style = MaterialTheme.typography.bodySmall)
  if (product.unitKind == "PIECE" && (product.retailPackage != null || product.purchasePackSize >= 2)) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      FilterChip(selected = entryUnit == "UNIT", onClick = { entryUnit = "UNIT" }, label = { Text("قطع") })
      product.retailPackage?.let { pack -> FilterChip(selected = entryUnit == "PACKAGE", onClick = { entryUnit = "PACKAGE" }, label = { Text("عبوات (${pack.unitsPerPackage})") }) }
      if (product.purchasePackSize >= 2) FilterChip(selected = entryUnit == "CARTON", onClick = { entryUnit = "CARTON" }, label = { Text("كراتين (${product.purchasePackSize})") })
    }
  }
  AppField(
    when (entryUnit) { "CARTON" -> "عدد الكراتين"; "PACKAGE" -> "عدد العبوات"; else -> quantityLabel(product) },
    amount, { amount = it }, "مثال: 1", keyboardType = KeyboardType.Decimal,
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
    val multiplier = when (entryUnit) { "CARTON" -> product.purchasePackSize.toLong(); "PACKAGE" -> product.retailPackage?.unitsPerPackage?.toLong() ?: 1L; else -> 1L }
    val qty = if (product.unitKind == "PIECE") amount.trim().toLongOrNull()?.let { runCatching { Math.multiplyExact(Math.multiplyExact(it, multiplier), 1_000L) }.getOrNull() }
      else parseQuantityToMilli(amount, product.unitKind)
    if (expiry == null) validation = "أدخل شهرًا وسنة صحيحين (واليوم اختياري)."
    else if (qty == null || qty <= 0) validation = "أدخل كمية صحيحة أكبر من صفر."
    else onSave(qty, expiry)
  }, saveLabel = "حفظ الصلاحية")
}

@Composable
private fun ActionRow(onCancel: () -> Unit, onSave: () -> Unit, saveLabel: String) = Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
  Button(onClick = onSave) { Text(saveLabel) }
  OutlinedButton(onClick = onCancel) { Text("إلغاء") }
}

@Composable
private fun AppField(label: String, value: String, onChange: (String) -> Unit, placeholder: String = "", password: Boolean = false, keyboardType: KeyboardType = KeyboardType.Text) = OutlinedTextField(
  value = value, onValueChange = onChange, modifier = Modifier.fillMaxWidth(), label = { Text(label) }, placeholder = { Text(placeholder) }, singleLine = true,
  keyboardOptions = KeyboardOptions(keyboardType = keyboardType), visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
)

@Composable
private fun Notice(text: String, success: Boolean) = Text(text, color = if (success) Color(0xFF087C61) else MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 4.dp))

private fun formatQuantity(product: Product) = "${formatQuantityInput(product.availableQtyMilli, product.unitKind)} ${if (product.unitKind == "PIECE") "قطعة" else weightUnitLabel(product.weightUnit)}"
private fun quantityLabel(product: Product) = if (product.unitKind == "PIECE") "الكمية بالقطعة" else "الكمية المتاحة (${weightUnitLabel(product.weightUnit)})"
private fun weightUnitLabel(unit: String) = when (unit) { "GRAM" -> "جرام"; "LITER" -> "لتر"; "MILLILITER" -> "مل"; else -> "كيلو" }
private fun formatQuantityInput(quantityMilli: Long, unitKind: String): String = if (unitKind == "PIECE") (quantityMilli / 1_000L).toString() else BigDecimal.valueOf(quantityMilli, 3).stripTrailingZeros().toPlainString()
private fun parseQuantityToMilli(value: String, unitKind: String): Long? = runCatching {
  if (unitKind == "PIECE") Math.multiplyExact(value.trim().toLong(), 1_000L)
  else BigDecimal(value.trim().replace('،', '.').replace(',', '.')).movePointRight(3).setScale(0, RoundingMode.HALF_UP).longValueExact()
}.getOrNull()

/** A supplier may print only month/year; use the month's last day conservatively. */
private fun expiryDateFromParts(yearText: String, monthText: String, dayText: String): String? {
  if (yearText.isBlank() && monthText.isBlank() && dayText.isBlank()) return null
  val year = yearText.trim().toIntOrNull() ?: return null
  val month = monthText.trim().toIntOrNull() ?: return null
  return runCatching {
    val yearMonth = YearMonth.of(year, month)
    val day = dayText.trim().toIntOrNull() ?: yearMonth.lengthOfMonth()
    if (day !in 1..yearMonth.lengthOfMonth()) null else "%04d-%02d-%02d".format(year, month, day)
  }.getOrNull()
}
