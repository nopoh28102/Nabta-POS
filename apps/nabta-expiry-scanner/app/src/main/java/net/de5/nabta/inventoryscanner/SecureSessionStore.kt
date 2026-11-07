package net.de5.nabta.inventoryscanner

import android.content.Context
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.encodeToString
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

data class SavedSession(
  val baseUrl: String,
  val terminalId: String,
  val token: String,
  val displayName: String,
  val expiresAt: String = "",
)

/** Stored in Android encrypted storage and erased on explicit logout. */
data class SavedLoginDetails(
  val baseUrl: String,
  val terminalId: String,
  val username: String,
  val password: String,
)

/** A mutation is never discarded merely because the phone is temporarily offline. */
@Serializable
data class PendingMutation(
  val id: String,
  val kind: String,
  val productId: String? = null,
  val payload: String,
  val createdAtMillis: Long,
)

class SecureSessionStore(context: Context) {
  private companion object {
    const val PRODUCT_CACHE_KEY = "product_cache"
    const val PENDING_MUTATIONS_KEY = "pending_mutations"
    const val CATALOG_LAST_SYNC_KEY = "catalog_last_sync"
    const val MAX_CACHED_PRODUCTS = 120
  }
  private val preferences = EncryptedSharedPreferences.create(
    context,
    "nabta_scanner_session",
    MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
  )
  private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

  fun load(): SavedSession? {
    val baseUrl = preferences.getString("base_url", "").orEmpty()
    val terminalId = preferences.getString("terminal_id", "").orEmpty()
    val token = preferences.getString("token", "").orEmpty()
    val displayName = preferences.getString("display_name", "").orEmpty()
    val expiresAt = preferences.getString("expires_at", "").orEmpty()
    return if (baseUrl.isNotBlank() && terminalId.isNotBlank() && token.isNotBlank()) SavedSession(baseUrl, terminalId, token, displayName, expiresAt) else null
  }

  fun loadLoginDetails(): SavedLoginDetails? {
    val baseUrl = preferences.getString("base_url", "").orEmpty()
    val terminalId = preferences.getString("terminal_id", "").orEmpty()
    val username = preferences.getString("username", "").orEmpty()
    val password = preferences.getString("password", "").orEmpty()
    return if (baseUrl.isNotBlank() && terminalId.isNotBlank() && username.isNotBlank() && password.isNotBlank()) {
      SavedLoginDetails(baseUrl, terminalId, username, password)
    } else null
  }

  fun save(session: SavedSession) = preferences.edit {
    putString("base_url", session.baseUrl)
    putString("terminal_id", session.terminalId)
    putString("token", session.token)
    putString("display_name", session.displayName)
    putString("expires_at", session.expiresAt)
  }

  fun saveLoginDetails(details: SavedLoginDetails) = preferences.edit {
    putString("base_url", details.baseUrl)
    putString("terminal_id", details.terminalId)
    putString("username", details.username)
    putString("password", details.password)
  }

  fun loadProductCache(): List<Product> = runCatching {
    json.decodeFromString<List<Product>>(preferences.getString(PRODUCT_CACHE_KEY, "[]") ?: "[]")
  }.getOrDefault(emptyList())

  /** Keeps only a compact, encrypted cache; it is never used to write stock offline. */
  fun saveProductCache(products: List<Product>) = preferences.edit {
    putString(PRODUCT_CACHE_KEY, json.encodeToString(products.take(MAX_CACHED_PRODUCTS)))
  }

  fun catalogLastSyncMillis(): Long = preferences.getLong(CATALOG_LAST_SYNC_KEY, 0L)

  fun markCatalogSynced(now: Long = System.currentTimeMillis()) = preferences.edit {
    putLong(CATALOG_LAST_SYNC_KEY, now)
  }

  fun loadPendingMutations(): List<PendingMutation> = runCatching {
    json.decodeFromString<List<PendingMutation>>(preferences.getString(PENDING_MUTATIONS_KEY, "[]") ?: "[]")
  }.getOrDefault(emptyList())

  fun savePendingMutations(mutations: List<PendingMutation>) = preferences.edit {
    putString(PENDING_MUTATIONS_KEY, json.encodeToString(mutations.takeLast(200)))
  }

  fun clear() = preferences.edit { clear() }
}
