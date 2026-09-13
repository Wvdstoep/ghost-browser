package engineer.myapp.gbmobile

import android.content.Context
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** A few on-device models the user can pick by device strength, and a downloader with progress.
 *  [family] selects the chat template LocalLlm wraps prompts in ("chatml" for Qwen, "gemma" for Gemma).
 *  Defaults are UNGATED (Apache-2.0) so they download with no token; Gemma stays available for anyone
 *  who supplies a free Hugging Face token after accepting Google's licence. */
object ModelCatalog {
    data class Model(val id: String, val label: String, val sizeMb: Int, val url: String, val note: String, val family: String = "chatml", val gated: Boolean = false)
    val models = listOf(
        Model(
            "qwen-0_5b", "Qwen 2.5 · 0.5B — fast · no token · ~550 MB", 547,
            "https://huggingface.co/litert-community/Qwen2.5-0.5B-Instruct/resolve/main/Qwen2.5-0.5B-Instruct_multi-prefill-seq_q8_ekv1280.task",
            "Runs on most modern phones (4 GB+ RAM). No login needed.", "chatml"
        ),
        Model(
            "qwen-1_5b", "Qwen 2.5 · 1.5B — stronger · no token · ~1.6 GB", 1600,
            "https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct/resolve/main/Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv1280.task",
            "For strong phones (6 GB+ RAM). Slower but sharper. No login needed.", "chatml"
        ),
        Model(
            "gemma3-1b", "Gemma 3 · 1B — needs free HF token · ~550 MB", 555,
            "https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/Gemma3-1B-IT_multi-prefill-seq_q4_ekv1280.task",
            "Google Gemma: accept the licence on huggingface.co once, then paste a HF read token above.", "gemma", true
        ),
        Model(
            "custom", "Custom — paste a .task URL below", 0, "",
            "Any MediaPipe LLM .task URL. Assumes a ChatML-style model (Qwen/most); Gemma files use the Gemma option.", "chatml"
        )
    )
    fun byId(id: String) = models.firstOrNull { it.id == id } ?: models.first()
}

class ModelManager(private val ctx: Context) {
    fun file(id: String): File = File(ctx.filesDir, "models/$id.task")
    fun isReady(id: String): Boolean = file(id).let { it.exists() && it.length() > 10_000_000 }
    fun path(id: String): String = file(id).absolutePath

    /** Download [url] into models/<id>.task, reporting 0..100 progress. Runs on a background thread. */
    fun download(id: String, url: String, sizeMb: Int, token: String?, onProgress: (Int) -> Unit, onDone: (Boolean, String) -> Unit) {
        Thread {
            try {
                if (url.isBlank()) { onDone(false, "no URL — pick a model or paste a .task URL"); return@Thread }
                val out = file(id); out.parentFile?.mkdirs()
                val tmp = File(out.parentFile, out.name + ".part")
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.instanceFollowRedirects = true
                conn.connectTimeout = 20000; conn.readTimeout = 60000
                if (!token.isNullOrBlank()) conn.setRequestProperty("Authorization", "Bearer " + token.trim())
                val code = conn.responseCode
                if (code !in 200..299) { onDone(false, "HTTP $code — model may be license-gated; add a token or use a Custom URL"); return@Thread }
                val total = conn.contentLengthLong.let { if (it > 0) it else sizeMb.toLong() * 1024 * 1024 }
                conn.inputStream.use { ins ->
                    tmp.outputStream().use { os ->
                        val buf = ByteArray(1 shl 16); var read = 0L; var n: Int
                        while (ins.read(buf).also { n = it } >= 0) {
                            os.write(buf, 0, n); read += n
                            onProgress(((read * 100) / total).toInt().coerceIn(0, 100))
                        }
                    }
                }
                if (tmp.length() < 10_000_000) { tmp.delete(); onDone(false, "downloaded file too small (${tmp.length()} bytes) — wrong URL?"); return@Thread }
                if (out.exists()) out.delete()
                tmp.renameTo(out)
                onDone(true, "ready")
            } catch (e: Exception) { onDone(false, e.message ?: "download failed") }
        }.start()
    }
}
