package engineer.myapp.gbmobile

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * The agent brain that uses the CLUSTER's configured LLM (POST /v1/agent/chat) — so this phone needs
 * NO model key of its own, and it dodges the Cloudflare block the phone hits calling ollama.com
 * directly. Rides the SSO session cookie (same as the reverse-channel / API calls).
 */
class ClusterLlm(base: String, private val cookie: () -> String) : Llm {
    private val root = base.trim().trimEnd('/')

    override fun chat(system: String, user: String): String {
        val c = URL("$root/v1/agent/chat").openConnection() as HttpURLConnection
        c.requestMethod = "POST"; c.doOutput = true
        c.connectTimeout = 15000; c.readTimeout = 120000
        c.instanceFollowRedirects = false
        c.setRequestProperty("Content-Type", "application/json")
        c.setRequestProperty("Accept", "application/json")
        c.setRequestProperty("X-Requested-With", "XMLHttpRequest")
        c.setRequestProperty("Origin", root)
        c.setRequestProperty("Referer", "$root/")
        val ck = cookie(); if (ck.isNotBlank()) c.setRequestProperty("Cookie", ck)
        c.outputStream.use { it.write(JSONObject().put("system", system).put("prompt", user).toString().toByteArray()) }
        val code = c.responseCode
        val txt = try { BufferedReader(InputStreamReader((if (code in 200..299) c.inputStream else c.errorStream))).use { it.readText() } } catch (e: Exception) { "" }
        if (code !in 200..299) {
            val err = try { JSONObject(txt).optString("error") } catch (e: Exception) { "" }
            throw RuntimeException(if (err.isNotBlank()) err else "cluster chat HTTP $code — sign in + open Ghost Browser from Tools, and set a model in the GB console")
        }
        return try { JSONObject(txt).optString("text") } catch (e: Exception) { txt }
    }
}
