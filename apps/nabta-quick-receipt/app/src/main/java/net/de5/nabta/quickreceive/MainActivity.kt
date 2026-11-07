package net.de5.nabta.quickreceive

import android.app.Activity
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
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
import kotlinx.coroutines.launch
import net.de5.nabta.inventoryscanner.ApiResult
import net.de5.nabta.inventoryscanner.NabtaApi
import net.de5.nabta.inventoryscanner.Product
import net.de5.nabta.inventoryscanner.PurchaseInvoiceLine
import net.de5.nabta.inventoryscanner.ScannerState
import net.de5.nabta.inventoryscanner.ScannerViewModel
import net.de5.nabta.inventoryscanner.Supplier

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: android.os.Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    setContent { QuickReceiveTheme { QuickReceiveApp() } }
  }
}

@Composable
private fun QuickReceiveTheme(content: @Composable () -> Unit) = MaterialTheme(
  colorScheme = androidx.compose.material3.lightColorScheme(
    primary = Color(0xFF087C61), secondary = Color(0xFF0D5B47), tertiary = Color(0xFF157A6E), error = Color(0xFFB3261E),
  ),
  content = content,
)

@Composable
private fun QuickReceiveApp(viewModel: ScannerViewModel = viewModel()) {
  val state by viewModel.state.collectAsStateWithLifecycle()
  Surface(Modifier.fillMaxSize()) {
    if (state.session == null) ReceiveLogin(state, viewModel)
    else ReceiveScreen(state, viewModel)
  }
}

@Composable
private fun ReceiveLogin(state: ScannerState, viewModel: ScannerViewModel) {
  val saved = state.savedLoginDetails
  val key = listOf(saved?.baseUrl, saved?.terminalId, saved?.username, saved?.password).joinToString("|")
  var url by rememberSaveable(key) { mutableStateOf(saved?.baseUrl ?: BuildConfig.DEFAULT_API_URL) }
  var terminalId by rememberSaveable(key) { mutableStateOf(saved?.terminalId.orEmpty()) }
  var username by rememberSaveable(key) { mutableStateOf(saved?.username.orEmpty()) }
  var password by rememberSaveable(key) { mutableStateOf(saved?.password.orEmpty()) }
  LazyColumn(Modifier.fillMaxSize().padding(22.dp), verticalArrangement = Arrangement.Center) {
    item {
      Text("نبتة الاستلام السريع", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
      Spacer(Modifier.height(6.dp))
      Text("استلام توريد سريع وآمن من المورد إلى مخزون نبتة.", color = MaterialTheme.colorScheme.onSurfaceVariant)
      Spacer(Modifier.height(18.dp))
      Field("رابط بوابة نبتة الآمنة", url, { url = it }, KeyboardType.Uri)
      Field("رقم الكاشير", terminalId, { terminalId = it })
      Field("اسم المستخدم", username, { username = it })
      Field("كلمة المرور", password, { password = it }, KeyboardType.Password)
      state.message?.let { Notice(it, false) }
      Button(
        onClick = { viewModel.login(url, terminalId, username, password) }, enabled = !state.loading,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
      ) { Text(if (state.loading) "جارٍ الاتصال…" else "تسجيل الدخول") }
      Text("بيانات الدخول والجلسة تحفظ مشفّرة على هذا الهاتف فقط.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 10.dp))
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReceiveScreen(state: ScannerState, viewModel: ScannerViewModel) {
  val activity = LocalActivity.current
  val scope = rememberCoroutineScope()
  var supplierName by rememberSaveable { mutableStateOf("") }
  var supplierPhone by rememberSaveable { mutableStateOf("") }
  var supplierInvoiceNo by rememberSaveable { mutableStateOf("") }
  var supplierId by rememberSaveable { mutableStateOf<String?>(null) }
  var suppliers by remember { mutableStateOf(emptyList<Supplier>()) }
  var supplierMessage by remember { mutableStateOf<String?>(null) }
  var query by rememberSaveable { mutableStateOf("") }
  var lines by remember { mutableStateOf(emptyList<PurchaseInvoiceLine>()) }
  var newProductPending by rememberSaveable { mutableStateOf(false) }
  var successMessage by remember { mutableStateOf<String?>(null) }
  var printOnPrimary by rememberSaveable { mutableStateOf(true) }
  var confirmPosting by rememberSaveable { mutableStateOf(false) }
  val session = state.session

  LaunchedEffect(session?.token) {
    if (session == null) return@LaunchedEffect
    suppliers = when (val result = NabtaApi(session.baseUrl, session.token).suppliers()) {
      is ApiResult.Success -> result.value
      is ApiResult.Failure -> emptyList()
    }
  }
  LaunchedEffect(state.product?.id, newProductPending) {
    val product = state.product ?: return@LaunchedEffect
    if (newProductPending) {
      lines = addOrIncrement(lines, product)
      newProductPending = false
      query = ""
      viewModel.clearProduct()
    }
  }
  LaunchedEffect(state.postedPurchaseReceipt?.receipt?.receiptId) {
    val posted = state.postedPurchaseReceipt ?: return@LaunchedEffect
    successMessage = "تم اعتماد فاتورة الاستلام رقم ${posted.receipt.receiptId.take(8)} وتحديث المخزون${if (printOnPrimary) "؛ أُرسل أمر واحد لطباعة الإيصال على جهاز نبتة الرئيسي." else "."}"
    lines = emptyList()
    supplierInvoiceNo = ""
    viewModel.clearPostedPurchaseReceipt()
  }

  Scaffold(topBar = {
    TopAppBar(
      title = { Column { Text("نبتة الاستلام السريع", fontWeight = FontWeight.Bold); Text("توريد الموردين", style = MaterialTheme.typography.labelSmall) } },
      actions = {
        TextButton(onClick = { viewModel.syncFullCatalog(force = true) }, enabled = !state.catalogSyncing) { Text(if (state.catalogSyncing) "تحديث…" else "تحديث") }
        TextButton(onClick = viewModel::logout) { Text("خروج") }
      },
    )
  }) { padding ->
    LazyColumn(
      modifier = Modifier.fillMaxSize().padding(padding),
      contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      item { HeaderCard(state.catalogCount, state.pendingMutations) }
      item {
        SupplierCard(
          name = supplierName, phone = supplierPhone, invoiceNo = supplierInvoiceNo, suppliers = suppliers,
          message = supplierMessage,
          onName = { supplierName = it; supplierId = suppliers.firstOrNull { supplier -> supplier.name == it }?.id },
          onPhone = { supplierPhone = it }, onInvoice = { supplierInvoiceNo = it },
          onCreate = {
            val activeSession = session
            if (activeSession == null) supplierMessage = "انتهت الجلسة؛ سجل الدخول مرة أخرى"
            else if (supplierName.trim().length < 2) supplierMessage = "اكتب اسم المورد أولًا"
            else {
              scope.launch {
                when (val result = NabtaApi(activeSession.baseUrl, activeSession.token).createSupplier(supplierName.trim(), supplierPhone.trim())) {
                  is ApiResult.Success -> {
                    supplierId = result.value.id
                    suppliers = suppliers + Supplier(result.value.id, result.value.name, supplierPhone.trim().ifBlank { null })
                    supplierMessage = "تمت إضافة المورد واختياره للفواتير القادمة"
                  }
                  is ApiResult.Failure -> supplierMessage = result.message
                }
              }
            }
          },
        )
      }
      item {
        ScanCard(
          query = query,
          onQuery = { query = it; viewModel.previewSearch(it) },
          onScan = { startBarcodeScan(activity, viewModel) { code -> query = code; viewModel.search(code) } },
          onSearch = { viewModel.search(query) },
        )
      }
      if (state.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
      state.message?.let { item { Notice(it, it.startsWith("تم")) } }
      successMessage?.let { item { Notice(it, true) } }
      val candidates = (listOfNotNull(state.product) + state.searchResults).distinctBy { it.id }.take(8)
      if (query.isNotBlank() && candidates.isNotEmpty()) {
        item { Text("نتائج الكتالوج", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold) }
        items(candidates, key = { "candidate-${it.id}" }) { product ->
          ProductCandidate(product) { lines = addOrIncrement(lines, product); query = ""; viewModel.clearProduct() }
        }
      } else if (query.isNotBlank() && !state.loading) {
        item {
          NewProductCard(
            searchValue = query,
            onCreate = { name, category, unitBarcode, cost, sell, piecesPerCarton, cartonSell, cartonBarcode ->
              newProductPending = true
              viewModel.clearProduct()
              viewModel.createProduct(
                name = name, category = category, unitBarcode = unitBarcode, unitKind = "PIECE", weightUnit = "KILOGRAM",
                priceMinor = sell, quantityMilli = 0, costMinor = cost, purchasePackSize = piecesPerCarton,
                cartonPriceMinor = cartonSell, cartonContentsUnit = if (cartonSell != null) "PIECE" else null,
                cartonBarcode = cartonBarcode, retailPackage = null, packageBarcode = null,
              )
            },
          )
        }
      }
      if (lines.isNotEmpty()) {
        item { Text("المنتجات المضافة (${lines.size})", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold) }
        items(lines, key = { it.product.id }) { line ->
          ReceiveLineCard(line, onChange = { changed -> lines = lines.map { if (it.product.id == changed.product.id) changed else it } }, onRemove = { lines = lines.filterNot { it.product.id == line.product.id } })
        }
        val total = lines.sumOf(::lineTotalMinor)
        item {
          Card(colors = CardDefaults.cardColors(containerColor = Color(0xFFF5FBF7)), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
              Text("إجمالي الفاتورة", style = MaterialTheme.typography.titleSmall)
              SummaryRow("إجمالي الشراء", money(total), Color(0xFF075B46))
              SummaryRow("المدفوع", "0.00 ج.م", Color(0xFF087C61))
              SummaryRow("المديونية", money(total), Color(0xFFC56A12))
              FilterChip(selected = printOnPrimary, onClick = { printOnPrimary = !printOnPrimary }, label = { Text("طباعة إيصال الاستلام على XPrinter") })
              Text("يعتمد المخزون مرة واحدة فقط، وتحفظ العملية بنفس المفتاح عند ضعف الاتصال.", style = MaterialTheme.typography.bodySmall)
            }
          }
          Button(
            onClick = { confirmPosting = true },
            enabled = !state.loading && supplierName.trim().length >= 2 && receiptLinesAreValid(lines), modifier = Modifier.fillMaxWidth(),
          ) { Text(if (state.loading) "جارٍ اعتماد الفاتورة…" else "اعتماد وإرسال إلى نبتة") }
          if (!receiptLinesAreValid(lines)) Text("راجع الكمية وسعر الشراء وسعر البيع في كل صنف قبل الاعتماد.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
      }
    }
  }
  if (confirmPosting) {
    val confirmedTotal = lines.sumOf(::lineTotalMinor)
    AlertDialog(
      onDismissRequest = { confirmPosting = false },
      title = { Text("تأكيد اعتماد الاستلام") },
      text = { Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("المورد: ${supplierName.trim()}")
        Text("عدد الأصناف: ${lines.size}")
        Text("إجمالي الشراء: ${money(confirmedTotal)}", fontWeight = FontWeight.Bold)
        Text(if (printOnPrimary) "سيُرسل أمر طباعة واحد إلى XPrinter على جهاز نبتة الرئيسي." else "لن يُرسل أمر طباعة لهذا الاستلام.", style = MaterialTheme.typography.bodySmall)
      } },
      confirmButton = { Button(onClick = { confirmPosting = false; viewModel.postPurchaseReceipt(supplierName, supplierInvoiceNo, lines, supplierId, printOnPrimary) }) { Text("اعتماد نهائي") } },
      dismissButton = { TextButton(onClick = { confirmPosting = false }) { Text("مراجعة") } },
    )
  }
}

@Composable
private fun HeaderCard(catalogCount: Int, pending: Int) = Card(colors = CardDefaults.cardColors(containerColor = Color(0xFFE7F6EE))) {
  Column(Modifier.padding(14.dp)) {
    Text("استلام سريع من المورد", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
    Text("امسح الباركود أو اكتب الاسم، أضف الكمية والسعر ثم اعتمد الفاتورة.", style = MaterialTheme.typography.bodySmall)
    Text("فهرس الهاتف: $catalogCount صنف${if (pending > 0) " • $pending عملية محفوظة للمزامنة" else ""}", style = MaterialTheme.typography.labelMedium, color = Color(0xFF075B46))
  }
}

@Composable
private fun SummaryRow(label: String, value: String, color: Color) = Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.SpaceBetween) {
  Text(label, fontWeight = FontWeight.Bold)
  Text(value, fontWeight = FontWeight.Bold, color = color)
}

@Composable
private fun SupplierCard(name: String, phone: String, invoiceNo: String, suppliers: List<Supplier>, message: String?, onName: (String) -> Unit, onPhone: (String) -> Unit, onInvoice: (String) -> Unit, onCreate: () -> Unit) = OutlinedCard(Modifier.fillMaxWidth()) {
  Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Text("بيانات المورد", fontWeight = FontWeight.Bold)
    Field("اسم المورد", name, onName)
    suppliers.filter { name.length >= 2 && it.name.contains(name.trim(), ignoreCase = true) }.take(4).forEach { supplier ->
      TextButton(onClick = { onName(supplier.name) }, modifier = Modifier.fillMaxWidth()) { Text("اختيار: ${supplier.name}") }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
      OutlinedTextField(phone, onPhone, Modifier.weight(1f), label = { Text("الهاتف (اختياري)") }, singleLine = true, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Phone))
      FilledTonalButton(onClick = onCreate, modifier = Modifier.align(Alignment.CenterVertically)) { Text("إضافة مورد") }
    }
    Field("رقم فاتورة المورد (اختياري)", invoiceNo, onInvoice)
    message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
  }
}

@Composable
private fun ScanCard(query: String, onQuery: (String) -> Unit, onScan: () -> Unit, onSearch: () -> Unit) = OutlinedCard(Modifier.fillMaxWidth()) {
  Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text("إضافة صنف", fontWeight = FontWeight.Bold)
    Field("اسم الصنف أو الباركود", query, onQuery)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
      FilledTonalButton(onClick = onScan, modifier = Modifier.weight(1f)) { Text("مسح باركود") }
      Button(onClick = onSearch, modifier = Modifier.weight(1f), enabled = query.isNotBlank()) { Text("بحث وإضافة") }
    }
  }
}

@Composable
private fun ProductCandidate(product: Product, onAdd: () -> Unit) = OutlinedCard(onClick = onAdd, modifier = Modifier.fillMaxWidth()) {
  Column(Modifier.padding(12.dp)) {
    Text(product.nameAr, fontWeight = FontWeight.Bold)
    Text("شراء: ${product.wholesalePriceMinor?.let { money(it.toLong()) } ?: "غير محدد"} • بيع: ${money(product.priceMinor.toLong())}", style = MaterialTheme.typography.bodySmall)
    Text("اضغط لإضافته إلى الفاتورة", style = MaterialTheme.typography.labelMedium, color = Color(0xFF087C61))
  }
}

@Composable
private fun NewProductCard(searchValue: String, onCreate: (String, String, String, Int, Int, Int, Int?, String?) -> Unit) = key(searchValue) {
  var name by rememberSaveable { mutableStateOf(if (searchValue.all(Char::isDigit)) "" else searchValue) }
  var category by rememberSaveable { mutableStateOf("عام") }
  var barcode by rememberSaveable { mutableStateOf(if (searchValue.all(Char::isDigit)) searchValue else "") }
  var cost by rememberSaveable { mutableStateOf("") }
  var sell by rememberSaveable { mutableStateOf("") }
  var pieces by rememberSaveable { mutableStateOf("1") }
  var cartonSell by rememberSaveable { mutableStateOf("") }
  var cartonBarcode by rememberSaveable { mutableStateOf("") }
  OutlinedCard(Modifier.fillMaxWidth()) {
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Text("صنف جديد", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
      Text("اترك الباركود فارغًا ليولده نبتة تلقائيًا.", style = MaterialTheme.typography.bodySmall)
      Field("اسم الصنف", name, { name = it })
      Field("التصنيف", category, { category = it })
      Field("باركود القطعة (اختياري)", barcode, { barcode = it }, KeyboardType.Number)
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        OutlinedTextField(cost, { cost = it }, Modifier.weight(1f), label = { Text("شراء القطعة") }, singleLine = true, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal))
        OutlinedTextField(sell, { sell = it }, Modifier.weight(1f), label = { Text("بيع القطعة") }, singleLine = true, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal))
      }
      Field("عدد قطع الكرتونة (1 إن لم توجد)", pieces, { pieces = it }, KeyboardType.Number)
      if ((pieces.toIntOrNull() ?: 1) > 1) {
        Field("بيع الكرتونة (اختياري)", cartonSell, { cartonSell = it }, KeyboardType.Decimal)
        Field("باركود الكرتونة (اختياري)", cartonBarcode, { cartonBarcode = it }, KeyboardType.Number)
      }
      Button(onClick = {
        onCreate(name, category, barcode, moneyMinor(cost), moneyMinor(sell), (pieces.toIntOrNull() ?: 1).coerceAtLeast(1), cartonSell.takeIf { it.isNotBlank() }?.let(::moneyMinor), cartonBarcode.takeIf { it.isNotBlank() })
      }, enabled = name.trim().length >= 2 && category.isNotBlank() && moneyMinor(cost) >= 0 && moneyMinor(sell) > 0, modifier = Modifier.fillMaxWidth()) { Text("إنشاء الصنف وإضافته للفواتير") }
    }
  }
}

@Composable
private fun ReceiveLineCard(line: PurchaseInvoiceLine, onChange: (PurchaseInvoiceLine) -> Unit, onRemove: () -> Unit) {
  var quantity by rememberSaveable(line.product.id) { mutableStateOf(line.quantity.toString()) }
  var cost by rememberSaveable(line.product.id) { mutableStateOf(decimal(line.purchaseCostMinor.toLong())) }
  var sell by rememberSaveable(line.product.id) { mutableStateOf(decimal(line.retailPriceMinor.toLong())) }
  var day by rememberSaveable(line.product.id) { mutableStateOf(line.expiresOn?.takeLast(2)?.trimStart('0').orEmpty()) }
  var month by rememberSaveable(line.product.id) { mutableStateOf(line.expiresOn?.substring(5, 7)?.trimStart('0').orEmpty()) }
  var year by rememberSaveable(line.product.id) { mutableStateOf(line.expiresOn?.take(4).orEmpty()) }
  var detailsExpanded by rememberSaveable(line.product.id) { mutableStateOf(false) }
  val expiryInputStarted = day.isNotBlank() || month.isNotBlank() || year.isNotBlank()
  val expiryIsValid = !expiryInputStarted || expiryDate(year, month, day) != null
  OutlinedCard(Modifier.fillMaxWidth()) {
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Column {
          Text(line.product.nameAr, fontWeight = FontWeight.Bold)
          Text(line.product.barcodes.firstOrNull() ?: "باركود تلقائي", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text("✎", color = Color(0xFF087C61))
      }
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Metric("كرتون", if (line.product.purchasePackSize >= 2) line.product.purchasePackSize.toString() else "—")
        Metric("فرط", if (line.entryUnit == "PIECE") quantity else "0")
        Metric("إجمالي القطع", if (line.entryUnit == "CARTON") (line.quantity * line.product.purchasePackSize).toString() else quantity)
        Metric("شراء القطعة", money(if (line.entryUnit == "CARTON") line.purchaseCostMinor.toLong() / line.product.purchasePackSize else line.purchaseCostMinor.toLong()))
        Metric("بيع القطعة", money(line.retailPriceMinor.toLong()))
      }
      if (line.product.purchasePackSize >= 2) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(selected = line.entryUnit == "PIECE", onClick = { onChange(line.copy(entryUnit = "PIECE")) }, label = { Text("+ فرط") })
        FilterChip(selected = line.entryUnit == "CARTON", onClick = { onChange(line.copy(entryUnit = "CARTON")) }, label = { Text("+ كرتونة") })
      }
      TextButton(onClick = { detailsExpanded = !detailsExpanded }, modifier = Modifier.fillMaxWidth()) { Text(if (detailsExpanded) "▲ إخفاء تعديل الكميات والأسعار والعبوات" else "▼ تعديل الكميات والأسعار والعبوات") }
      if (!detailsExpanded) {
        Text("إجمالي السطر: ${money(lineTotalMinor(line))}", style = MaterialTheme.typography.bodySmall, color = Color(0xFF075B46))
        TextButton(onClick = onRemove, modifier = Modifier.fillMaxWidth()) { Text("حذف من الفاتورة") }
        return@Column
      }
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        OutlinedTextField(quantity, { quantity = it; onChange(line.copy(quantity = it.toLongOrNull() ?: 0)) }, Modifier.weight(1f), label = { Text(if (line.entryUnit == "CARTON") "عدد الكراتين" else "الكمية") }, singleLine = true, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number))
        OutlinedTextField(cost, { cost = it; onChange(line.copy(purchaseCostMinor = moneyMinor(it))) }, Modifier.weight(1f), label = { Text(if (line.entryUnit == "CARTON") "شراء الكرتونة" else "شراء القطعة") }, singleLine = true, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal))
      }
      Field("سعر بيع القطعة", sell, { sell = it; onChange(line.copy(retailPriceMinor = moneyMinor(it))) }, KeyboardType.Decimal)
      Text("الصلاحية اختيارية", style = MaterialTheme.typography.labelMedium)
      Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
        OutlinedTextField(day, { next -> day = next; onChange(line.copy(expiresOn = expiryDate(year, month, next))) }, Modifier.weight(1f), label = { Text("يوم") }, singleLine = true, isError = !expiryIsValid, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number))
        OutlinedTextField(month, { next -> month = next; onChange(line.copy(expiresOn = expiryDate(year, next, day))) }, Modifier.weight(1f), label = { Text("شهر") }, singleLine = true, isError = !expiryIsValid, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number))
        OutlinedTextField(year, { next -> year = next; onChange(line.copy(expiresOn = expiryDate(next, month, day))) }, Modifier.weight(1f), label = { Text("سنة") }, singleLine = true, isError = !expiryIsValid, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number))
      }
      if (!expiryIsValid) Text("أكمل تاريخ صلاحية صحيحًا أو امسح الحقول الثلاثة.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
      Text("إجمالي السطر: ${money(lineTotalMinor(line))}", style = MaterialTheme.typography.bodySmall, color = Color(0xFF075B46))
      TextButton(onClick = onRemove, modifier = Modifier.fillMaxWidth()) { Text("حذف من الفاتورة") }
    }
  }
}

@Composable
private fun Metric(label: String, value: String) = Column(horizontalAlignment = Alignment.CenterHorizontally) {
  Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
  Text(value, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
}

@Composable
private fun Field(label: String, value: String, onValue: (String) -> Unit, keyboardType: KeyboardType = KeyboardType.Text) = OutlinedTextField(
  value = value, onValueChange = onValue, modifier = Modifier.fillMaxWidth(), label = { Text(label) }, singleLine = true,
  keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = keyboardType),
  visualTransformation = if (keyboardType == KeyboardType.Password) PasswordVisualTransformation() else VisualTransformation.None,
)

@Composable
private fun Notice(text: String, success: Boolean) = Card(colors = CardDefaults.cardColors(containerColor = if (success) Color(0xFFE7F6EE) else Color(0xFFFFEDEC))) {
  Text(text, Modifier.padding(12.dp), color = if (success) Color(0xFF075B46) else MaterialTheme.colorScheme.error)
}

private fun startBarcodeScan(activity: Activity?, viewModel: ScannerViewModel, onResult: (String) -> Unit) {
  if (activity == null) { viewModel.showMessage("تعذر فتح الماسح في هذه الشاشة"); return }
  runCatching {
    GmsBarcodeScanning.getClient(activity, GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_CODE_128, Barcode.FORMAT_UPC_A, Barcode.FORMAT_UPC_E).enableAutoZoom().build()).startScan()
      .addOnSuccessListener { result -> result.rawValue?.let(onResult) }
      .addOnFailureListener { error -> viewModel.showMessage("تعذر تشغيل الماسح: ${error.message ?: "أعد المحاولة"}") }
  }.onFailure { error -> viewModel.showMessage("تعذر تشغيل الماسح: ${error.message ?: "أعد المحاولة"}") }
}

private fun addOrIncrement(lines: List<PurchaseInvoiceLine>, product: Product): List<PurchaseInvoiceLine> {
  val index = lines.indexOfFirst { it.product.id == product.id }
  return if (index < 0) lines + PurchaseInvoiceLine(product, purchaseCostMinor = product.wholesalePriceMinor ?: 0, retailPriceMinor = product.priceMinor)
  else lines.mapIndexed { lineIndex, line -> if (lineIndex == index) line.copy(quantity = line.quantity + 1) else line }
}

private fun receiptLinesAreValid(lines: List<PurchaseInvoiceLine>): Boolean = lines.isNotEmpty() && lines.all { line ->
  line.quantity > 0 && line.purchaseCostMinor >= 0 && line.retailPriceMinor > 0
    && (line.entryUnit != "CARTON" || line.product.purchasePackSize >= 2)
}

private fun moneyMinor(value: String): Int = runCatching { BigDecimal(value.trim()).movePointRight(2).setScale(0, RoundingMode.HALF_UP).intValueExact() }.getOrDefault(0)
private fun decimal(value: Long): String = BigDecimal.valueOf(value, 2).stripTrailingZeros().toPlainString()
private fun money(value: Long): String = "${decimal(value)} ج.م"
private fun lineTotalMinor(line: PurchaseInvoiceLine): Long = runCatching { Math.multiplyExact(line.quantity, line.purchaseCostMinor.toLong()) }.getOrDefault(0)
private fun expiryDate(year: String, month: String, day: String): String? = runCatching {
  if (year.isBlank() && month.isBlank() && day.isBlank()) null else {
    val ym = YearMonth.of(year.toInt(), month.toInt())
    val resolvedDay = day.toIntOrNull() ?: ym.lengthOfMonth()
    require(resolvedDay in 1..ym.lengthOfMonth())
    "%04d-%02d-%02d".format(ym.year, ym.monthValue, resolvedDay)
  }
}.getOrNull()
