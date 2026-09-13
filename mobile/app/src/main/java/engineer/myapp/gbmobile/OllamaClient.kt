package engineer.myapp.gbmobile

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Talks to an Ollama-compatible chat endpoint (OpenAI-style /v1/chat/completions, which Ollama and
 * most hosted proxies expose). The device runs its OWN brain here — no cluster involved. Base URL,
 * API key and model are the user's own. Blocking call; run it off the UI thread.
 */
class OllamaClient(private var baseUrl: String, private var apiKey: String, private var model: String) : Llm {

    override fun chat(system: String, user: String): String {
        var base = baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) throw IllegalStateException("no endpoint set")
        // Accept either a bare host or a full URL; normalise to the chat-completions path.
        if (!base.startsWith("http")) base = "https://$base"
        val endpoint = if (base.endsWith("/chat/completions")) base else "$base/v1/chat/completions"

        val body = JSONObject()
        body.put("model", model)
        body.put("temperature", 0.1)
        body.put("stream", false)
        val msgs = JSONArray()
        msgs.put(JSONObject().put("role", "system").put("content", system))
        msgs.put(JSONObject().put("role", "user").put("content", user))
        body.put("messages", msgs)

        val conn = URL(endpoint).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 20000
        conn.readTimeout = 120000
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        if (apiKey.isNotBlank()) conn.setRequestProperty("Authorization", "Bearer ${apiKey.trim()}")

        conn.outputStream.use { os: OutputStream -> os.write(body.toString().toByteArray(Charsets.UTF_8)) }

        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { it.readText() }
        if (code !in 200..299) throw RuntimeException("LLM HTTP $code: ${text.take(300)}")

        val json = JSONObject(text)
        // OpenAI-compatible shape; fall back to Ollama-native {message:{content}} if present.
        json.optJSONArray("choices")?.let { ch ->
            if (ch.length() > 0) {
                val m = ch.getJSONObject(0).optJSONObject("message")
                if (m != null) return m.optString("content", "")
            }
        }
        json.optJSONObject("message")?.let { return it.optString("content", "") }
        return json.optString("response", text.take(500))
    }

    fun update(baseUrl: String, apiKey: String, model: String) {
        this.baseUrl = baseUrl; this.apiKey = apiKey; this.model = model
    }
}
