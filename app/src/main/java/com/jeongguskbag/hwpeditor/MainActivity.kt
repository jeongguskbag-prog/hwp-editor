package com.jeongguskbag.hwpeditor

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
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
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
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
    @Volatile private var imgBytes: ByteArray = ByteArray(0)
    private var pendingSave: ByteArray? = null
    private var pendingOpen: Uri? = null
    private var pageReady = false

    private val openDoc = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) loadUri(uri)
    }

    /** HWP 가 있는 폴더를 한 번 허용받음 (앱이 기억) → 그 폴더의 HWP·HWPX 만 앱 안 목록으로 보여 줌 */
    private val pickTree = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { tree ->
        if (tree != null) {
            runCatching { contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            js("hwpApp.onFolderAdded(true)")
        } else {
            js("hwpApp.onFolderAdded(false)")
        }
    }

    /** 허용받은 폴더들에서 HWP·HWPX 찾기 (하위 폴더 3단계까지, 최대 500개, 최근 수정 순) */
    private fun scanDocs(): String {
        val files = ArrayList<JSONObject>()
        val folders = JSONArray()
        for (perm in contentResolver.persistedUriPermissions) {
            val tree = perm.uri
            if (!perm.isReadPermission || !DocumentsContract.isTreeUri(tree)) continue
            val rootId = runCatching { DocumentsContract.getTreeDocumentId(tree) }.getOrNull() ?: continue
            val label = rootId.substringAfter(':').ifEmpty { rootId }
            folders.put(JSONObject().put("uri", tree.toString()).put("label", label))
            walk(tree, rootId, label, 0, files)
        }
        files.sortByDescending { it.optLong("modified") }
        val arr = JSONArray()
        files.take(500).forEach { arr.put(it) }
        return JSONObject().put("folders", folders).put("files", arr).toString()
    }

    private fun walk(tree: Uri, docId: String, path: String, depth: Int, out: MutableList<JSONObject>) {
        if (out.size >= 2000) return
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        val subdirs = ArrayList<Pair<String, String>>()
        runCatching {
            contentResolver.query(children, cols, null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getString(0) ?: continue
                    val name = c.getString(1) ?: continue
                    val mime = c.getString(2) ?: ""
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        if (!name.startsWith(".")) subdirs.add(id to "$path/$name")
                    } else if (name.lowercase().let { it.endsWith(".hwp") || it.endsWith(".hwpx") }) {
                        out.add(JSONObject()
                            .put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString())
                            .put("name", name).put("folder", path)
                            .put("size", if (c.isNull(3)) 0L else c.getLong(3))
                            .put("modified", if (c.isNull(4)) 0L else c.getLong(4)))
                    }
                }
            }
        }
        if (depth < 3) for ((id, p) in subdirs) walk(tree, id, p, depth + 1, out)
    }

    /** 문서에 넣을 그림 고르기 → /__img__/current 로 넘기고 hwpApp.onImagePicked(mime) 호출 */
    private val pickImg = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) { js("hwpApp.onImagePicked(null)"); return@registerForActivityResult }
        io.execute {
            try {
                val bytes = contentResolver.openInputStream(uri)?.use { input ->
                    val out = ByteArrayOutputStream()
                    val buf = ByteArray(64 * 1024)
                    var total = 0
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_IMAGE_BYTES) throw IllegalStateException("too large")
                        out.write(buf, 0, n)
                    }
                    out.toByteArray()
                } ?: throw IllegalStateException("cannot open")
                imgBytes = bytes
                val mime = contentResolver.getType(uri) ?: "image/*"
                js("hwpApp.onImagePicked(${JSONObject.quote(mime)})")
            } catch (e: Exception) {
                runOnUiThread { toast(getString(R.string.image_failed, e.message ?: e.javaClass.simpleName)) }
            }
        }
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
            .addPathHandler("/__img__/") { _ ->
                WebResourceResponse("application/octet-stream", null, ByteArrayInputStream(imgBytes)).apply {
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

    private fun sendPdf(uri: Uri, name: String, toNotes: Boolean) {
        val send = Intent(Intent.ACTION_SEND)
            .setType("application/pdf")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .putExtra(Intent.EXTRA_TITLE, name)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (toNotes) {
            try {
                startActivity(Intent(send).setPackage(SAMSUNG_NOTES))
                return
            } catch (e: ActivityNotFoundException) {
                toast(getString(R.string.notes_missing))
            }
        }
        startActivity(Intent.createChooser(send, name))
    }

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
            // 파일 선택 화면은 확장자로 거를 수 없어 형식 이름(MIME)으로 거름. HWP 는 기기마다 이름이 달라서
            // 알려진 이름을 모두 넣고, 형식을 모르는 파일(octet-stream: 휴대폰이 HWP 를 모르면 이렇게 나옴)과
            // HWPX 가 ZIP 으로 잡히는 경우(application/zip)도 넣음. PDF·사진·문서 같은 다른 파일은 안 보임
            openDoc.launch(HWP_MIME_TYPES)
        }

        /** 앱 안 열기 목록용: 결과는 hwpApp.onDocList(json) 으로 */
        @JavascriptInterface
        fun listDocs() {
            io.execute {
                val json = runCatching { scanDocs() }.getOrElse { "{\"folders\":[],\"files\":[]}" }
                js("hwpApp.onDocList(${JSONObject.quote(json)})")
            }
        }

        @JavascriptInterface
        fun addFolder() = runOnUiThread { pickTree.launch(null) }

        @JavascriptInterface
        fun removeFolder(uri: String) {
            runCatching { contentResolver.releasePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            listDocs()
        }

        @JavascriptInterface
        fun openUri(uri: String) = runOnUiThread { loadUri(Uri.parse(uri)) }

        /**
         * PDF 를 다른 앱으로 보냄. target == "notes" 면 삼성 노트로 바로 (삼성 노트는 공유받은 PDF 로 새 노트를 만듦),
         * 없으면 앱 고르기 화면으로.
         */
        @JavascriptInterface
        fun sharePdf(base64: String, name: String, target: String) {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            io.execute {
                try {
                    val dir = File(cacheDir, "share").apply { deleteRecursively(); mkdirs() }
                    val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_")
                    val file = File(dir, safe).apply { writeBytes(bytes) }
                    val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", file)
                    runOnUiThread { sendPdf(uri, safe, target == "notes") }
                } catch (e: Exception) {
                    runOnUiThread { toast(getString(R.string.share_failed, e.message ?: e.javaClass.simpleName)) }
                }
            }
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

        @JavascriptInterface
        fun pickImage() = runOnUiThread { pickImg.launch("image/*") }
    }

    override fun onDestroy() {
        io.shutdown()
        web.removeJavascriptInterface("HwpHost")
        web.destroy()
        super.onDestroy()
    }

    private companion object {
        const val MAX_BYTES = 100L * 1024 * 1024
        const val MAX_IMAGE_BYTES = 30 * 1024 * 1024
        const val SAMSUNG_NOTES = "com.samsung.android.app.notes"
        val HWP_MIME_TYPES = arrayOf(
            "application/x-hwp", "application/haansofthwp", "application/vnd.hancom.hwp", "application/hwp",
            "application/hwp+zip", "application/vnd.hancom.hwpx", "application/haansofthwpx", "application/x-hwpx",
            "application/octet-stream", "application/zip",
        )
    }
}
