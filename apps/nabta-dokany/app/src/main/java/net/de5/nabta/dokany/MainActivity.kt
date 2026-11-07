package net.de5.nabta.dokany

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts

class MainActivity : ComponentActivity() {
  lateinit var webView: WebView
    private set
  private lateinit var bridge: NabtaBridge
  private val saveSpreadsheet = registerForActivityResult(ActivityResultContracts.CreateDocument("application/vnd.ms-excel")) { uri ->
    bridge.onSpreadsheetDestination(uri)
  }

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    webView = WebView(this)
    setContentView(webView)
    webView.settings.javaScriptEnabled = true
    webView.settings.domStorageEnabled = true
    webView.settings.allowFileAccess = true
    webView.settings.allowContentAccess = false
    webView.settings.allowFileAccessFromFileURLs = false
    webView.settings.allowUniversalAccessFromFileURLs = false
    webView.settings.mediaPlaybackRequiresUserGesture = true
    bridge = NabtaBridge(this, webView)
    webView.addJavascriptInterface(bridge, "NabtaAndroid")
    webView.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        // The application is an offline local HTML shell. All remote calls are
        // made by the typed native bridge, never by an arbitrary WebView page.
        return if (request.url.scheme == "file" && request.url.path?.startsWith("/android_asset/") == true) null else WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), null)
      }
    }
    webView.loadUrl("file:///android_asset/index.html")
  }

  override fun onBackPressed() {
    if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
  }

  fun launchSpreadsheetSave(filename: String) = saveSpreadsheet.launch(filename)
}
