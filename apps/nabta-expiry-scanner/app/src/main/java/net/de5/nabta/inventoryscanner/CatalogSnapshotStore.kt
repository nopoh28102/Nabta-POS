package net.de5.nabta.inventoryscanner

import android.content.Context
import androidx.core.util.AtomicFile
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Full offline catalogue (20k+ products) stored privately on the phone. */
class CatalogSnapshotStore(context: Context) {
  private val file = AtomicFile(context.filesDir.resolve("nabta-catalog-v1.json.gz"))
  private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

  suspend fun load(): List<Product> = withContext(Dispatchers.IO) {
    runCatching {
      file.openRead().use { input ->
        GZIPInputStream(BufferedInputStream(input)).bufferedReader().use { reader -> json.decodeFromString<List<Product>>(reader.readText()) }
      }
    }.getOrDefault(emptyList())
  }

  suspend fun save(products: List<Product>) = withContext(Dispatchers.IO) {
    val output = file.startWrite()
    try {
      GZIPOutputStream(BufferedOutputStream(output)).bufferedWriter().use { writer -> writer.write(json.encodeToString(products)) }
      file.finishWrite(output)
    } catch (error: Exception) {
      file.failWrite(output)
      throw error
    }
  }

  suspend fun clear() = withContext(Dispatchers.IO) { file.delete() }
}
