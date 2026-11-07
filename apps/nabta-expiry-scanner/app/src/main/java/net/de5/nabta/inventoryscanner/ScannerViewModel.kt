package net.de5.nabta.inventoryscanner

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** State deliberately limited to lookup and expiry registration. */
data class ScannerState(
  val session: SavedSession? = null,
  val product: Product? = null,
  val query: String = "",
  val loading: Boolean = false,
  val message: String? = null,
  val searchResults: List<Product> = emptyList(),
  val resultsAreCached: Boolean = false,
  val catalogSyncing: Boolean = false,
  val catalogCount: Int = 0,
  val pendingMutations: Int = 0,
  val savedLoginDetails: SavedLoginDetails? = null,
)

/**
 * The expiry employee app can search products and attach an expiry date only.
 * It contains no stock, price, product-creation, or supplier-receipt action.
 */
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
        _state.value = _state.value.copy(catalogCount = cachedProducts.size)
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
      _state.value = _state.value.copy(loading = false, message = "اكتب رابط HTTPS الآمن لخدمة الهاتف")
      return@launch
    }
    if (details.terminalId.isBlank() || details.username.isBlank() || password.isBlank()) {
      _state.value = _state.value.copy(loading = false, message = "أكمل معرّف نقطة البيع وبيانات الدخول")
      return@launch
    }
    val previous = store.loadLoginDetails()
    if (previous != null && (previous.baseUrl != normalized || previous.terminalId != details.terminalId)) {
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
          catalogCount = cachedProducts.size,
          pendingMutations = store.loadPendingMutations().size,
          savedLoginDetails = details,
          message = "تم تسجيل الدخول",
        )
        syncFullCatalog(force = cachedProducts.isEmpty())
      }
      is ApiResult.Failure -> _state.value = _state.value.copy(loading = false, message = result.message)
    }
  }

  fun previewSearch(query: String) {
    searchJob?.cancel()
    previewJob?.cancel()
    previewJob = viewModelScope.launch {
      val matches = withContext(Dispatchers.Default) { searchCachedProducts(cachedProducts, query.trim()) }
      _state.value = _state.value.copy(
        query = query,
        product = matches.singleOrNull(),
        searchResults = matches,
        resultsAreCached = matches.isNotEmpty(),
      )
    }
  }

  fun search(query: String) {
    searchJob?.cancel()
    val session = _state.value.session ?: return
    val trimmed = query.trim()
    if (trimmed.isBlank()) {
      _state.value = _state.value.copy(query = query, product = null, searchResults = emptyList(), resultsAreCached = false, message = null)
      return
    }
    val localMatches = searchCachedProducts(cachedProducts, trimmed)
    _state.value = _state.value.copy(query = query, loading = true, message = null, product = localMatches.singleOrNull(), searchResults = localMatches, resultsAreCached = localMatches.isNotEmpty())
    searchJob = viewModelScope.launch {
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
            product = result.value.products.singleOrNull(),
            searchResults = result.value.products,
            resultsAreCached = false,
            message = if (result.value.products.isEmpty()) "الصنف غير مسجل في نبتة؛ راجع المسؤول لإضافته." else null,
          )
        }
        is ApiResult.Failure -> _state.value = _state.value.copy(
          loading = false,
          product = localMatches.singleOrNull(),
          searchResults = localMatches,
          resultsAreCached = localMatches.isNotEmpty(),
          message = result.message,
        )
      }
    }
  }

  fun select(product: Product) {
    _state.value = _state.value.copy(product = product, searchResults = listOf(product), resultsAreCached = false, message = null)
  }

  fun clearProduct() {
    _state.value = _state.value.copy(product = null, query = "", searchResults = emptyList(), resultsAreCached = false, message = null)
  }

  fun showMessage(message: String) {
    _state.value = _state.value.copy(loading = false, message = message)
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

  /** Refreshes the encrypted offline catalogue; it is never used for expiry writes. */
  private fun syncFullCatalog(force: Boolean = false) {
    val session = _state.value.session ?: return
    val isFresh = System.currentTimeMillis() - store.catalogLastSyncMillis() < CATALOG_FRESHNESS_MS
    if (!force && cachedProducts.isNotEmpty() && isFresh) {
      viewModelScope.launch { syncPendingExpiry(session) }
      return
    }
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
              store.saveProductCache(all.take(CACHE_PREVIEW_LIMIT))
              store.markCatalogSynced()
              _state.value = _state.value.copy(catalogCount = cachedProducts.size, catalogSyncing = false)
              syncPendingExpiry(session)
              return@launch
            }
          }
        }
      }
    }
  }

  /** Records expiry against existing stock only; it never changes the balance. */
  fun registerExpiry(qtyMilli: Long, expiresOn: String) = viewModelScope.launch {
    if (_state.value.loading) return@launch
    val session = _state.value.session ?: return@launch
    val product = _state.value.product ?: return@launch
    if (qtyMilli <= 0 || expiresOn.isBlank()) {
      _state.value = _state.value.copy(message = "أدخل كمية وتاريخ صلاحية صحيحين")
      return@launch
    }
    val payload = buildJsonObject {
      put("productId", product.id)
      put("warehouseId", product.warehouseId ?: "")
      put("qtyMilli", qtyMilli)
      put("expiresOn", expiresOn)
    }.toString()
    val existing = store.loadPendingMutations().firstOrNull { it.kind == EXPIRY_MUTATION && it.payload == payload }
    val mutationId = existing?.id ?: UUID.randomUUID().toString()
    if (existing == null) addPendingExpiry(mutationId, payload)
    _state.value = _state.value.copy(loading = true, message = null, pendingMutations = store.loadPendingMutations().size)
    when (val result = NabtaApi(session.baseUrl, session.token).registerExpiry(payload, mutationId)) {
      is ApiResult.Success -> {
        removePendingMutation(mutationId)
        _state.value = _state.value.copy(
          loading = false,
          pendingMutations = store.loadPendingMutations().size,
          message = "تم تسجيل صلاحية ${product.nameAr} حتى ${result.value.expiresOn} دون تغيير الرصيد",
        )
      }
      is ApiResult.Failure -> {
        if (!result.retryable) removePendingMutation(mutationId)
        _state.value = _state.value.copy(
          loading = false,
          pendingMutations = store.loadPendingMutations().size,
          message = if (result.retryable) "${result.message} تم حفظ تسجيل الصلاحية بنفس رقم العملية؛ لا تُدخله مرة أخرى." else result.message,
        )
      }
    }
  }

  private suspend fun syncPendingExpiry(session: SavedSession) {
    val queued = store.loadPendingMutations().filter { it.kind == EXPIRY_MUTATION }
    if (queued.isEmpty()) return
    val api = NabtaApi(session.baseUrl, session.token)
    val remaining = store.loadPendingMutations().filterNot { it.kind == EXPIRY_MUTATION }.toMutableList()
    queued.forEach { mutation ->
      when (api.registerExpiry(mutation.payload, mutation.id)) {
        is ApiResult.Success -> Unit
        is ApiResult.Failure -> remaining += mutation
      }
    }
    store.savePendingMutations(remaining)
    _state.value = _state.value.copy(pendingMutations = remaining.size)
  }

  private fun addPendingExpiry(mutationId: String, payload: String) {
    val existing = store.loadPendingMutations()
    if (existing.any { it.id == mutationId }) return
    store.savePendingMutations(existing + PendingMutation(mutationId, EXPIRY_MUTATION, null, payload, System.currentTimeMillis()))
  }

  private fun removePendingMutation(mutationId: String) {
    store.savePendingMutations(store.loadPendingMutations().filterNot { it.id == mutationId })
  }

  private fun rememberProducts(products: List<Product>) {
    if (products.isEmpty()) return
    val merged = LinkedHashMap<String, Product>()
    (products + cachedProducts).forEach { product -> merged.putIfAbsent(product.id, product) }
    cachedProducts = merged.values.toList()
    store.saveProductCache(cachedProducts)
  }

  private fun sessionNeedsRenewal(session: SavedSession): Boolean = runCatching {
    session.expiresAt.isNotBlank() && Instant.parse(session.expiresAt).isBefore(Instant.now().plusSeconds(60))
  }.getOrDefault(false)

  private companion object {
    const val EXPIRY_MUTATION = "EXPIRY"
    const val CACHE_PREVIEW_LIMIT = 120
    const val CATALOG_FRESHNESS_MS = 12 * 60 * 60 * 1000L
  }
}
