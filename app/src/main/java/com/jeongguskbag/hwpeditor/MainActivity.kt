package com.jeongguskbag.hwpeditor

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * 앱은 WebView 하나에 편집 화면(assets/www, 웹)을 띄우고, 파일 열기·저장만 안드로이드가 맡는다.
 * - 화면과 엔진은 https://appassets.androidplatform.net/assets/www/ 에서 제공 (WebViewAssetLoader)
 * - 연 문서는 같은 주소의 /__doc__/current 로 넘겨줌 (큰 파일도 문자열 변환 없이 바로 전달)
 * - 저장은 웹이 base64 로 넘겨주면 시스템 "다른 이름으로 저장" 화면(ACTION_CREATE_DOCUMENT)으로 씀
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private val io = Executors.newSingleThreadExecutor()

    @Volatile private var docBytes: ByteArray = ByteArray(0)
    private var pendingSave: ByteArray? = null
    private var pendingOpen: Uri? = null
    private var pageReady = false

    private val openDoc = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) loadUri(uri)
    }

    /** 저장할 때 파일 이름과 형식(MIME)을 함께 넘기는 "다른 이름으로 저장" */
    private class CreateDoc : ActivityResultContract<Pair<String, String>, Uri?>() {
        override fun createIntent(context: Context, input: Pair<String, String>): Intent =
            Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(input.second)
                .putExtra(Intent.EXTRA_TITLE, input.first)

        override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
            if (resultCode == RESULT_OK) intent?.data else null
    }

    private val createDoc = registerForActivityResult(CreateDoc()) { uri ->
        val bytes = pendingSave
        pendingSave = null
        if (uri == null || bytes == null) {
            // 사용자가 취소 → 편집기에 알려 "저장하고 종료" 같은 대기 동작을 버리게 함 (메시지 없음)
            js("hwpApp.onSaved(false, '')")
            return@registerForActivityResult
        }
        io.execute {
            try {
                contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
                    ?: throw IllegalStateException("cannot open output")
                val name = displayName(uri) ?: "document"
                js("hwpApp.onSaved(true, ${JSONObject.quote(name)})")
            } catch (e: Exception) {
                js("hwpApp.onSaved(false, ${JSONObject.quote(e.message ?: e.javaClass.simpleName)})")
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)

        // 상태 표시줄·내비게이션 바·키보드에 화면이 가리지 않게 여백을 줌
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root)) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/__doc__/") { _ ->
                WebResourceResponse("application/octet-stream", null, ByteArrayInputStream(docBytes)).apply {
                    responseHeaders = mapOf("Cache-Control" to "no-store")
                }
            }
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
        }
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            // 문서 안 링크 등 앱 밖 주소는 브라우저로
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == WebViewAssetLoader.DEFAULT_DOMAIN) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
        }
        web.addJavascriptInterface(Host(), "HwpHost")
        web.loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/www/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    // 라이선스 같은 다른 화면을 보고 있으면 편집기로 돌아감
                    web.url?.endsWith("/www/index.html") == false && web.canGoBack() -> web.goBack()
                    pageReady -> web.evaluateJavascript("hwpApp.handleBack()", null)
                    else -> finish()
                }
            }
        })

        handleViewIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleViewIntent(intent)
    }

    private fun handleViewIntent(intent: Intent?) {
        val uri = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.data ?: return
        if (pageReady) loadUri(uri) else pendingOpen = uri
    }

    /** 고른 파일을 읽어 /__doc__/current 로 준비한 뒤 웹에 "열어라" 라고 알림 */
    private fun loadUri(uri: Uri) {
        io.execute {
            try {
                val out = ByteArrayOutputStream()
                contentResolver.openInputStream(uri)?.use { input ->
                    val buf = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_BYTES) {
                            runOnUiThread { toast(getString(R.string.too_large)) }
                            return@execute
                        }
                        out.write(buf, 0, n)
                    }
                } ?: throw IllegalStateException("cannot read")
                docBytes = out.toByteArray()
                val name = displayName(uri) ?: "document.hwp"
                js("hwpApp.loadFromHost(${JSONObject.quote(name)})")
            } catch (e: Exception) {
                runOnUiThread { toast(getString(R.string.open_failed, e.message ?: e.javaClass.simpleName)) }
            }
        }
    }

    private fun displayName(uri: Uri): String? = runCatching {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }.getOrNull()

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript(code, null) }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    /** 웹(editor.js)에서 window.HwpHost 로 부르는 함수들 */
    inner class Host {
        @JavascriptInterface
        fun onReady() = runOnUiThread {
            pageReady = true
            pendingOpen?.let { pendingOpen = null; loadUri(it) }
        }

        @JavascriptInterface
        fun openFile() = runOnUiThread {
            // HWP 는 기기마다 형식 이름(MIME)이 달라 모든 파일을 보여 주고, 열 수 있는지는 편집기가 판단
            openDoc.launch(arrayOf("*/*"))
        }

        @JavascriptInterface
        fun saveFile(base64: String, name: String, mime: String) {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            runOnUiThread {
                pendingSave = bytes
                createDoc.launch(name to mime)
            }
        }

        @JavascriptInterface
        fun exit() = runOnUiThread { finish() }
    }

    override fun onDestroy() {
        io.shutdown()
        web.removeJavascriptInterface("HwpHost")
        web.destroy()
        super.onDestroy()
    }

    private companion object {
        const val MAX_BYTES = 100L * 1024 * 1024
    }
}
