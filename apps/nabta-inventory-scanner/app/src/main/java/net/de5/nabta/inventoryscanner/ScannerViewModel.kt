package net.de5.nabta.inventoryscanner

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.UUID

data class ScannerState(
  val session: SavedSession? = null,
  val product: Product? = null,
  val query: String = "",
  val loading: Boolean = false,
  val message: String? = null,
  val searchResults: List<Product> = emptyList(),
  val recentProducts: List<Product> = emptyList(),
  val resultsAreCached: Boolean = false,
  val catalogSyncing: Boolean = false,
  val catalogCount: Int = 0,
  val pendingMutations: Int = 0,
  val savedLoginDetails: SavedLoginDetails? = null,
  val generatedBarcode: GeneratedBarcode? = null,
  val postedPurchaseReceipt: PostedPurchaseReceipt? = null,
)

class ScannerViewModel(application: Application) : AndroidViewModel(application) {
  private val store = SecureSessionStore(application)
  private val catalogStore = CatalogSnapshotStore(application)
  private val json = Json { encodeDefaults = true }
  private var cachedProducts = store.loadProductCache()
  private var searchJob: Job? = null
  private var previewJob: Job? = null
  private var catalogSyncJob: Job? = null
  private val storedSession = store.load()
  private val storedLoginDetails = store.loadLoginDetails()
  private val _state = MutableStateFlow(
    ScannerState(
      session = storedSession?.takeUnless(::sessionNeedsRenewal),
      loading = storedSession?.let(::sessionNeedsRenewal) == true && storedLoginDetails != null,
      recentProducts = cachedProducts.take(8),
      catalogCount = cachedProducts.size,
      pendingMutations = store.loadPendingMutations().size,
      savedLoginDetails = storedLoginDetails,
    ),
  )
  val state: StateFlow<ScannerState> = _state.asStateFlow()

  init {
    viewModelScope.launch {
      val snapshot = catalogStore.load()
      if (snapshot.isNotEmpty()) {
        cachedProducts = snapshot
        _state.value = _state.value.copy(recentProducts = cachedProducts.take(8))
      }
      if (_state.value.session != null) syncFullCatalog()
    }
    if (_state.value.session == null) {
      storedLoginDetails?.let { login(it.baseUrl, it.terminalId, it.username, it.password) }
    }
  }

  fun login(baseUrl: String, terminalId: String, username: String, password: String) = viewModelScope.launch {
    val normalized = baseUrl.trim().trimEnd('/')
    val details = SavedLoginDetails(normalized, terminalId.trim(), username.trim(), password)
    if (!normalized.startsWith("https://")) {
      _state.value = _state.value.copy(message = "اكتب رابط HTTPS الآمن لخدمة الهاتف")
      return@launch
    }
    if (details.terminalId.isBlank() || details.username.isBlank() || password.isBlank()) {
      _state.value = _state.value.copy(message = "أكمل معرّف نقطة البيع وبيانات الدخول")
      return@launch
    }
    val previousDetails = store.loadLoginDetails()
    if (previousDetails != null && (previousDetails.baseUrl != normalized || previousDetails.terminalId != details.terminalId)) {
      cachedProducts = emptyList()
      store.saveProductCache(emptyList())
      catalogStore.clear()
    }
    store.saveLoginDetails(details)
    _state.value = _state.value.copy(loading = true, message = null, savedLoginDetails = details)
    when (val result = NabtaApi(normalized, null).login(details.username, details.password, details.terminalId)) {
      is ApiResult.Success -> {
        val session = SavedSession(normalized, details.terminalId, result.value.token, result.value.user.displayName, result.value.expiresAt)
        store.save(session)
        _state.value = ScannerState(
          session = session,
          recentProducts = cachedProducts.take(8),
          catalogCount = cachedProducts.size,
          pendingMutations = store.loadPendingMutations().size,
          message = "تم تسجيل الدخول",
        )
        syncFullCatalog(force = cachedProducts.isEmpty())
      }
      is ApiResult.Failure -> _state.value = _state.value.copy(loading = false, message = result.message)
    }
  }

  private fun sessionNeedsRenewal(session: SavedSession): Boolean = runCatching {
    session.expiresAt.isNotBlank() && Instant.parse(session.expiresAt).isBefore(Instant.now().plusSeconds(60))
  }.getOrDefault(false)

  /** Shows memory-cached matches immediately while the debounce waits to query Nabta. */
  fun previewSearch(query: String) {
    searchJob?.cancel()
    previewJob?.cancel()
    val trimmed = query.trim()
    previewJob = viewModelScope.launch {
      val matches = withContext(Dispatchers.Default) { searchCachedProducts(cachedProducts, trimmed) }
      _state.value = _state.value.copy(
        query = query,
        product = matches.singleOrNull(),
        searchResults = matches,
        resultsAreCached = matches.isNotEmpty(),
        loading = false,
        message = null,
      )
    }
  }

  fun search(query: String, successMessage: String? = null) {
    val trimmed = query.trim()
    searchJob?.cancel()
    previewJob?.cancel()
    if (trimmed.isBlank()) {
      _state.value = _state.value.copy(query = "", product = null, searchResults = emptyList(), resultsAreCached = false, loading = false, message = successMessage)
      return
    }
    searchJob = viewModelScope.launch {
      val session = _state.value.session ?: return@launch
      val localMatches = withContext(Dispatchers.Default) { searchCachedProducts(cachedProducts, trimmed) }
      _state.value = _state.value.copy(
        query = trimmed,
        product = localMatches.singleOrNull(),
        searchResults = localMatches,
        resultsAreCached = localMatches.isNotEmpty(),
        loading = true,
        message = null,
      )
      val result = try {
        NabtaApi(session.baseUrl, session.token).search(trimmed)
      } catch (error: Exception) {
        if (error is CancellationException) throw error
        ApiResult.Failure("تعذر إتمام البحث: ${error.message ?: "خطأ غير معروف"}")
      }
      when (result) {
        is ApiResult.Success -> {
          rememberProducts(result.value.products)
          _state.value = _state.value.copy(
            loading = false,
            searchResults = result.value.products,
            product = result.value.products.singleOrNull(),
            recentProducts = cachedProducts.take(8),
            resultsAreCached = false,
            message = successMessage ?: if (result.value.products.isEmpty()) "الصنف غير مسجل — يمكنك إضافته الآن" else null,
          )
        }
        is ApiResult.Failure -> _state.value = _state.value.copy(
          loading = false,
          product = localMatches.singleOrNull(),
          searchResults = localMatches,
          resultsAreCached = localMatches.isNotEmpty(),
          message = if (localMatches.isNotEmpty()) "تعذر تحديث نبتة الآن؛ تظهر نتائج محفوظة مؤقتًا" else result.message,
        )
      }
    }
  }

  fun select(product: Product) {
    rememberProducts(listOf(product))
    _state.value = _state.value.copy(product = product, searchResults = emptyList(), recentProducts = cachedProducts.take(8), resultsAreCached = false, message = null)
  }

  fun clearProduct() {
    searchJob?.cancel()
    previewJob?.cancel()
    _state.value = _state.value.copy(product = null, query = "", searchResults = emptyList(), resultsAreCached = false, message = null, loading = false)
  }

  fun showMessage(message: String) {
    _state.value = _state.value.copy(loading = false, message = message)
  }

  fun generateBarcode(slot: BarcodeSlot) = viewModelScope.launch {
    if (_state.value.loading) return@launch
    val session = _state.value.session ?: return@launch
    _state.value = _state.value.copy(loading = true, message = null)
    when (val result = NabtaApi(session.baseUrl, session.token).generateBarcode()) {
      is ApiResult.Success -> _state.value = _state.value.copy(loading = false, generatedBarcode = GeneratedBarcode(slot, result.value.barcode), message = "تم توليد باركود ${result.value.symbology}")
      is ApiResult.Failure -> _state.value = _state.value.copy(loading = false, message = result.message)
    }
  }

  fun consumeGeneratedBarcode() {
    _state.value = _state.value.copy(generatedBarcode = null)
  }

  fun clearPostedPurchaseReceipt() {
    _state.value = _state.value.copy(postedPurchaseReceipt = null)
  }

  fun logout() {
    searchJob?.cancel()
    previewJob?.cancel()
    catalogSyncJob?.cancel()
    cachedProducts = emptyList()
    store.clear()
    viewModelScope.launch { catalogStore.clear() }
    _state.value = ScannerState()
  }

  /** Downloads the full catalogue in pages once connected; searching remains local afterwards. */
  fun syncFullCatalog(force: Boolean = false) {
    val session = _state.value.session ?: return
    val isFresh = System.currentTimeMillis() - store.catalogLastSyncMillis() < 12 * 60 * 60 * 1000L
    if (!force && cachedProducts.isNotEmpty() && isFresh) return
    if (catalogSyncJob?.isActive == true) return
    catalogSyncJob = viewModelScope.launch {
      _state.value = _state.value.copy(catalogSyncing = true)
      val all = ArrayList<Product>()
      var cursor: String? = null
      while (true) {
        when (val page = NabtaApi(session.baseUrl, session.token).catalogPage(cursor)) {
          is ApiResult.Failure -> {
            _state.value = _state.value.copy(catalogSyncing = false)
            return@launch
          }
          is ApiResult.Success -> {
            all += page.value.products
            cursor = page.value.nextCursor
            if (!page.value.hasMore || cursor == null) {
              cachedProducts = all
              catalogStore.save(all)
              store.saveProductCache(all.take(120))
              store.markCatalogSynced()
              _state.value = _state.value.copy(
                recentProducts = cachedProducts.take(8),
                catalogCount = cachedProducts.size,
                catalogSyncing = false,
              )
              syncPendingMutations(session)
              return@launch
            }
          }
        }
      }
    }
  }

  fun increaseStock(deltaMilli: Long, successMessage: String = "تمت زيادة الكمية وتسجيل حركة المخزون") = viewModelScope.launch {
    if (_state.value.loading) return@launch
    val session = _state.value.session ?: return@launch
    val product = _state.value.product ?: return@launch
    if (deltaMilli <= 0) {
      _state.value = _state.value.copy(message = "أدخل كمية صحيحة أكبر من صفر")
      return@launch
    }
    val payload = buildJsonObject {
      put("nameAr", product.nameAr); put("category", product.category); put("description", product.description)
      put("priceMinor", product.priceMinor); product.wholesalePriceMinor?.let { put("wholesalePriceMinor", it) }
      put("purchasePackSize", product.purchasePackSize); put("availableQtyMilli", product.availableQtyMilli + deltaMilli); put("expectedStockVersion", product.version)
    }.toString()
    _state.value = _state.value.copy(loading = true, message = null)
    when (val result = NabtaApi(session.baseUrl, session.token).updateProduct(product.id, payload)) {
      is ApiResult.Success -> search(product.barcodes.firstOrNull() ?: product.nameAr, successMessage)
      is ApiResult.Failure -> handleMutationFailure(result, "UPDATE", product.id, payload)
    }
  }

  /** Records cartons as their exact number of base pieces; stock never has a separate carton balance. */
  fun increaseCartons(cartonCount: Long) {
    val product = _state.value.product ?: return
    if (product.unitKind != "PIECE" || product.purchasePackSize < 2 || cartonCount <= 0) {
      _state.value = _state.value.copy(message = "حدد عدد كراتين صحيحًا لصنف مُعدّ للكرتونة")
      return
    }
    val deltaMilli = cartonsToQtyMilli(cartonCount, product.purchasePackSize) ?: run {
      _state.value = _state.value.copy(message = "عدد الكراتين كبير جدًا")
      return
    }
    val contentsLabel = if (product.cartonContentsUnit == "BAG") "كيس" else "قطعة"
    increaseStock(deltaMilli, "تمت إضافة $cartonCount كرتونة (${cartonCount * product.purchasePackSize} $contentsLabel) وتسجيل حركة المخزون")
  }

  /** Records expiry against existing undated stock without changing its balance. */
  fun registerExpiry(qtyMilli: Long, expiresOn: String) = viewModelScope.launch {
    if (_state.value.loading) return@launch
    val session = _state.value.session ?: return@launch
    val product = _state.value.product ?: return@launch
    if (qtyMilli <= 0 || (product.unitKind == "PIECE" && qtyMilli % 1_000L != 0L)) {
      _state.value = _state.value.copy(message = "أدخل كمية صحيحة لتسجيل الصلاحية")
      return@launch
    }
    val payload = buildJsonObject {
      put("productId", product.id)
      put("qtyMilli", qtyMilli)
      put("expiresOn", expiresOn)
    }.toString()
    _state.value = _state.value.copy(loading = true, message = null)
    // Reuse the same key if the response is lost: the server will then apply this
    // registration at most once when the phone synchronizes it later.
    val mutationId = UUID.randomUUID().toString()
    when (val result = NabtaApi(session.baseUrl, session.token).registerExpiry(payload, mutationId)) {
      is ApiResult.Success -> {
        _state.value = _state.value.copy(
          loading = false,
          message = "تم تسجيل صلاحية ${product.nameAr} حتى ${result.value.expiresOn} دون تغيير الرصيد",
        )
      }
      is ApiResult.Failure -> handleMutationFailure(result, "EXPIRY", product.id, payload, mutationId)
    }
  }

  /** Updates the whole product card through Nabta's audited, version-checked endpoint. */
  fun updateProductDetails(name: String, category: String, description: String, priceMinor: Int, quantityMilli: Long, wholesalePriceMinor: Int?) = viewModelScope.launch {
    if (_state.value.loading) return@launch
    val session = _state.value.session ?: return@launch
    val product = _state.value.product ?: return@launch
    if (name.trim().length < 2 || category.isBlank() || priceMinor < 0 || quantityMilli < 0 || wholesalePriceMinor != null && wholesalePriceMinor < 0) {
      _state.value = _state.value.copy(message = "راجع الاسم والتصنيف والسعر والكمية")
      return@launch
    }
    if (product.unitKind == "PIECE" && quantityMilli % 1000L != 0L) {
      _state.value = _state.value.copy(message = "صنف القطعة يجب أن يكون بعدد صحيح")
      return@launch
    }
    val payload = buildJsonObject {
      put("nameAr", name.trim()); put("category", category.trim()); put("description", description.trim())
      put("priceMinor", priceMinor); wholesalePriceMinor?.let { put("wholesalePriceMinor", it) }
      put("purchasePackSize", product.purchasePackSize); put("availableQtyMilli", quantityMilli); put("expectedStockVersion", product.version)
    }.toString()
    _state.value = _state.value.copy(loading = true, message = null)
    when (val result = NabtaApi(session.baseUrl, session.token).updateProduct(product.id, payload)) {
      is ApiResult.Success -> search(product.barcodes.firstOrNull() ?: product.nameAr, "تم حفظ بيانات الصنف وتسجيل أي فرق في الكمية")
      is ApiResult.Failure -> handleMutationFailure(result, "UPDATE", product.id, payload)
    }
  }

  fun updateSalePrice(priceMinor: Int) = viewModelScope.launch {
    if (_state.value.loading) return@launch
    val session = _state.value.session ?: return@launch
    val product = _state.value.product ?: return@launch
    if (priceMinor <= 0) {
      _state.value = _state.value.copy(message = "أدخل سعر بيع صحيحًا أكبر من صفر")
      return@launch
    }
    _state.value = _state.value.copy(loading = true, message = null)
    when (val result = NabtaApi(session.baseUrl, session.token).updateSalePrice(product.id, priceMinor)) {
      is ApiResult.Success -> search(product.barcodes.firstOrNull() ?: product.nameAr, "تم تعديل سعر البيع")
      is ApiResult.Failure -> handleMutationFailure(result, "PRICE", product.id, priceMinor.toString())
    }
  }

  fun createProduct(
    name: String,
    category: String,
    unitBarcode: String,
    unitKind: String,
    weightUnit: String,
    priceMinor: Int,
    quantityMilli: Long,
    costMinor: Int,
    purchasePackSize: Int,
    cartonPriceMinor: Int?,
    cartonContentsUnit: String?,
    cartonBarcode: String?,
    retailPackage: RetailPackage?,
    packageBarcode: String?,
  ) = viewModelScope.launch {
    if (_state.value.loading) return@launch
    val session = _state.value.session ?: return@launch
    if (name.trim().length < 2 || category.isBlank() || priceMinor <= 0 || quantityMilli < 0 || costMinor < 0) {
      _state.value = _state.value.copy(message = "راجع الاسم والتصنيف والباركود والأسعار والكمية")
      return@launch
    }
    if (purchasePackSize < 1 || (cartonPriceMinor != null && cartonPriceMinor <= 0) || (retailPackage != null && (retailPackage.unitsPerPackage < 2 || retailPackage.packagePriceMinor <= 0)) || (cartonPriceMinor != null && (purchasePackSize < 2 || cartonContentsUnit == null)) || (cartonBarcode != null && cartonBarcode.isNotBlank() && cartonPriceMinor == null) || (packageBarcode != null && packageBarcode.isNotBlank() && retailPackage == null)) {
      _state.value = _state.value.copy(message = "راجع إعداد الكرتونة أو العبوة والباركود؛ لا يمكن تكرار الباركود")
      return@launch
    }
    if (unitKind != "PIECE" && (cartonPriceMinor != null || retailPackage != null)) {
      _state.value = _state.value.copy(message = "الكرتونة والعبوة الكاملة متاحتان للأصناف المخزنة بالقطعة فقط")
      return@launch
    }
    if (unitKind == "PIECE" && quantityMilli % 1000L != 0L) {
      _state.value = _state.value.copy(message = "كمية القطعة يجب أن تكون عددًا صحيحًا")
      return@launch
    }
    suspend fun generatedOr(value: String): String = when (val generated = NabtaApi(session.baseUrl, session.token).generateBarcode()) {
      is ApiResult.Success -> generated.value.barcode
      is ApiResult.Failure -> throw IllegalStateException(generated.message)
    }
    val resolvedUnitBarcode = try { unitBarcode.trim().ifBlank { generatedOr("UNIT") } } catch (error: IllegalStateException) {
      _state.value = _state.value.copy(message = error.message ?: "تعذر توليد باركود الوحدة")
      return@launch
    }
    val resolvedCartonBarcode = if (cartonPriceMinor != null) try { cartonBarcode?.trim().orEmpty().ifBlank { generatedOr("CARTON") } } catch (error: IllegalStateException) {
      _state.value = _state.value.copy(message = error.message ?: "تعذر توليد باركود الكرتونة")
      return@launch
    } else null
    val resolvedPackageBarcode = if (retailPackage != null) try { packageBarcode?.trim().orEmpty().ifBlank { generatedOr("PACKAGE") } } catch (error: IllegalStateException) {
      _state.value = _state.value.copy(message = error.message ?: "تعذر توليد باركود العبوة")
      return@launch
    } else null
    val barcodes = listOfNotNull(resolvedUnitBarcode, resolvedCartonBarcode, resolvedPackageBarcode)
    if (barcodes.any { !it.matches(Regex("\\d{8,14}")) } || barcodes.distinct().size != barcodes.size) {
      _state.value = _state.value.copy(message = "الباركودات يجب أن تكون أرقامًا فريدة من 8 إلى 14 رقمًا")
      return@launch
    }
    val mappings = buildList {
      add(BarcodeMapping(resolvedUnitBarcode, "UNIT"))
      resolvedCartonBarcode?.let { add(BarcodeMapping(it, "CARTON")) }
      resolvedPackageBarcode?.let { add(BarcodeMapping(it, "PACKAGE")) }
    }
    val payload = buildJsonObject {
      put("nameAr", name.trim()); put("category", category.trim()); put("unitKind", unitKind); put("weightUnit", weightUnit); put("priceMinor", priceMinor)
      put("wholesalePriceMinor", costMinor); put("reorderLevelMilli", 0); put("openingQtyMilli", quantityMilli); put("openingUnitCostMinor", costMinor)
      put("purchasePackSize", purchasePackSize)
      cartonPriceMinor?.let { put("cartonPriceMinor", it) }
      cartonContentsUnit?.let { put("cartonContentsUnit", it) }
      retailPackage?.let { retail -> put("retailPackage", buildJsonObject {
        put("unitsPerPackage", retail.unitsPerPackage); put("packagePriceMinor", retail.packagePriceMinor)
        put("contentsUnit", retail.contentsUnit); put("label", retail.label)
      }) }
      put("barcodes", buildJsonArray { mappings.forEach { add(kotlinx.serialization.json.JsonPrimitive(it.barcode)) } })
      put("barcodeMappings", buildJsonArray { mappings.forEach { mapping -> add(buildJsonObject { put("barcode", mapping.barcode); put("saleUnit", mapping.saleUnit) }) } })
    }.toString()
    _state.value = _state.value.copy(loading = true, message = null)
    when (val result = NabtaApi(session.baseUrl, session.token).createProduct(payload)) {
      is ApiResult.Success -> search(resolvedUnitBarcode, if (result.value.merged) "تم إنشاء الصنف وتكويد كل المستويات المطلوبة" else "تم إنشاء الصنف وتوليد الباركودات الناقصة")
      is ApiResult.Failure -> handleMutationFailure(result, "CREATE", null, payload)
    }
  }

  fun postPurchaseReceipt(supplierName: String, supplierInvoiceNo: String, lines: List<PurchaseInvoiceLine>, supplierId: String? = null, printOnPrimary: Boolean = false) = viewModelScope.launch {
    if (_state.value.loading) return@launch
    val session = _state.value.session ?: return@launch
    if (supplierName.trim().length < 2 || lines.isEmpty()) {
      _state.value = _state.value.copy(message = "اكتب اسم المورد وأضف صنفًا واحدًا على الأقل")
      return@launch
    }
    val warehouseId = lines.first().product.warehouseId
    if (warehouseId.isNullOrBlank() || lines.any { it.product.warehouseId != warehouseId }) {
      _state.value = _state.value.copy(message = "حدّث الفهرس قبل إصدار فاتورة التوريد")
      return@launch
    }
    val payloadLines = try {
      lines.map { line ->
        require(line.quantity > 0 && line.purchaseCostMinor >= 0 && line.retailPriceMinor > 0)
        val carton = line.entryUnit == "CARTON"
        val qtyMilli = if (carton) cartonsToQtyMilli(line.quantity, line.product.purchasePackSize) ?: throw IllegalArgumentException() else Math.multiplyExact(line.quantity, 1_000L)
        buildJsonObject {
          put("productId", line.product.id); put("qtyMilli", qtyMilli); put("retailPriceMinor", line.retailPriceMinor)
          line.expiresOn?.let { put("expiresOn", it) }
          if (carton) {
            put("entryUnit", "CARTON"); put("costBasis", "PACKAGE"); put("packageCount", line.quantity)
            put("unitsPerPackage", line.product.purchasePackSize); put("packageCostMinor", line.purchaseCostMinor)
            put("unitCostMinor", line.purchaseCostMinor / line.product.purchasePackSize); put("wholesalePriceMinor", line.purchaseCostMinor / line.product.purchasePackSize)
          } else {
            put("entryUnit", "PIECE"); put("costBasis", "UNIT"); put("unitCostMinor", line.purchaseCostMinor); put("wholesalePriceMinor", line.purchaseCostMinor)
          }
        }
      }
    } catch (_: Exception) {
      _state.value = _state.value.copy(message = "راجع كمية وسعر كل سطر في الفاتورة")
      return@launch
    }
    val payload = buildJsonObject {
      put("warehouseId", warehouseId); put("supplierName", supplierName.trim()); supplierId?.takeIf { it.isNotBlank() }?.let { put("supplierId", it) }; if (supplierInvoiceNo.isNotBlank()) put("supplierInvoiceNo", supplierInvoiceNo.trim())
      put("supplyExpensesMinor", 0); put("printOnPrimary", printOnPrimary); put("lines", buildJsonArray { payloadLines.forEach(::add) })
    }.toString()
    // Store the request before it leaves the device. If the server posts it
    // but the response is lost, the same key is replayed rather than creating
    // a second supplier receipt on the next tap or after restarting the app.
    val existing = store.loadPendingMutations().firstOrNull {
      it.kind == PURCHASE_RECEIPT_MUTATION && it.payload == payload
    }
    val mutationId = existing?.id ?: UUID.randomUUID().toString()
    if (existing == null) addPendingMutation(
      PendingMutation(
        id = mutationId,
        kind = PURCHASE_RECEIPT_MUTATION,
        productId = null,
        payload = payload,
        createdAtMillis = System.currentTimeMillis(),
      ),
    )
    _state.value = _state.value.copy(loading = true, message = null, pendingMutations = store.loadPendingMutations().size)
    when (val result = NabtaApi(session.baseUrl, session.token).createPurchaseReceipt(payload, mutationId)) {
      is ApiResult.Success -> {
        removePendingMutation(mutationId)
        _state.value = _state.value.copy(
          loading = false,
          pendingMutations = store.loadPendingMutations().size,
          postedPurchaseReceipt = PostedPurchaseReceipt(supplierName.trim(), supplierInvoiceNo.trim(), lines, result.value),
          message = "تم استلام الفاتورة وتحديث المخزون",
        )
        syncFullCatalog(force = true)
      }
      is ApiResult.Failure -> {
        if (!result.retryable) removePendingMutation(mutationId)
        _state.value = _state.value.copy(
          loading = false,
          pendingMutations = store.loadPendingMutations().size,
          message = if (result.retryable) "${result.message} تم حفظ الفاتورة محليًا بنفس رقم العملية، ولا تُدخلها مرة أخرى؛ ستُعاد المزامنة تلقائيًا." else result.message,
        )
      }
    }
  }

  /** Keeps only reachability failures. Validation or conflict failures remain visible and are not retried blindly. */
  private fun handleMutationFailure(result: ApiResult.Failure, kind: String, productId: String?, payload: String, mutationId: String = UUID.randomUUID().toString()) {
    if (!result.retryable) {
      _state.value = _state.value.copy(loading = false, message = result.message)
      return
    }
    addPendingMutation(PendingMutation(
      id = mutationId,
      kind = kind,
      productId = productId,
      payload = payload,
      createdAtMillis = System.currentTimeMillis(),
    ))
    val queued = store.loadPendingMutations()
    _state.value = _state.value.copy(
      loading = false,
      pendingMutations = queued.size,
      message = "لا يوجد اتصال بنبتة الآن؛ حُفظ التعديل قيد المزامنة ولن يُعتبر نهائيًا قبل تأكيد الخادم.",
    )
  }

  /** Replays preserved writes only after a fresh catalogue has been obtained from Nabta. */
  private suspend fun syncPendingMutations(session: SavedSession) {
    val queued = store.loadPendingMutations()
    if (queued.isEmpty()) return
    val api = NabtaApi(session.baseUrl, session.token)
    val remaining = ArrayList<PendingMutation>()
    for (mutation in queued) {
      val result = when (mutation.kind) {
        "CREATE" -> api.createProduct(mutation.payload)
        "UPDATE" -> mutation.productId?.let { api.updateProduct(it, mutation.payload) }
        "PRICE" -> mutation.productId?.let { id -> mutation.payload.toIntOrNull()?.let { api.updateSalePrice(id, it) } }
        "EXPIRY" -> api.registerExpiry(mutation.payload, mutation.id)
        PURCHASE_RECEIPT_MUTATION -> api.createPurchaseReceipt(mutation.payload, mutation.id)
        else -> null
      }
      when (result) {
        is ApiResult.Success -> Unit
        is ApiResult.Failure -> remaining += mutation
        null -> remaining += mutation
      }
    }
    store.savePendingMutations(remaining)
    _state.value = _state.value.copy(pendingMutations = remaining.size)
  }

  private fun rememberProducts(products: List<Product>) {
    if (products.isEmpty()) return
    val merged = LinkedHashMap<String, Product>()
    (products + cachedProducts).forEach { product -> merged.putIfAbsent(product.id, product) }
    cachedProducts = merged.values.toList()
    store.saveProductCache(cachedProducts)
  }

  /** Prevents duplicate entries when a user taps retry before connectivity returns. */
  private fun addPendingMutation(mutation: PendingMutation) {
    val existing = store.loadPendingMutations()
    if (existing.any { it.id == mutation.id }) return
    store.savePendingMutations(existing + mutation)
  }

  private fun removePendingMutation(mutationId: String) {
    store.savePendingMutations(store.loadPendingMutations().filterNot { it.id == mutationId })
  }

  private companion object {
    const val PURCHASE_RECEIPT_MUTATION = "PURCHASE_RECEIPT"
  }
}
