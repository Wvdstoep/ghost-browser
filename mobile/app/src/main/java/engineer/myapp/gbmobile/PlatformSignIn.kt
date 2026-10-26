package engineer.myapp.gbmobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** System-browser login with a single-use PKCE handoff; the callback never contains a device key. */
object PlatformSignIn {
    data class Return(val cluster: String, val code: String, val verifier: String)
    private fun encode(s: String) = URLEncoder.encode(s, "UTF-8")
    private fun random() = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })
    fun challenge(verifier: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
    fun browserIntent(context: Context, url: String): Intent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
        val browsers = context.packageManager.queryIntentActivities(intent, 0).filter { it.activityInfo.packageName != context.packageName }
        val chosen = browsers.firstOrNull { it.activityInfo.packageName == "com.android.chrome" } ?: browsers.firstOrNull()
            ?: throw IllegalStateException("Install a system browser to sign in")
        return intent.setPackage(chosen.activityInfo.packageName)
    }
    fun isGoogleSignIn(url: String, mainFrame: Boolean): Boolean = try {
        val uri = URI(url)
        mainFrame && uri.scheme == "https" && uri.host == "my-app.engineer" && uri.path == "/api/auth/google"
    } catch (_: Exception) { false }
    fun begin(context: Context, google: Boolean = false): String {
        val verifier = random(); val state = random()
        check(context.getSharedPreferences("gb", Context.MODE_PRIVATE).edit()
            .putString("signinVerifier", verifier).putString("signinState", state)
            .putLong("signinExpires", System.currentTimeMillis() + 10 * 60 * 1000).commit())
        val next = "/api/cluster-tools/ghost-browser/open?device_challenge=${challenge(verifier)}&device_state=$state"
        return "https://my-app.engineer" + (if (google) "/api/auth/google" else "/") + "?next=${encode(next)}"
    }
    fun takeReturn(context: Context, callback: String): Return {
        val uri = URI(callback)
        require(uri.scheme == "ghostbrowser" && uri.host == "connect") { "Unexpected sign-in callback" }
        val params = (uri.rawQuery ?: "").split('&').associate {
            val pair = it.split('=', limit = 2)
            URLDecoder.decode(pair[0], "UTF-8") to URLDecoder.decode(pair.getOrElse(1) { "" }, "UTF-8")
        }
        val prefs = context.getSharedPreferences("gb", Context.MODE_PRIVATE)
        val state = prefs.getString("signinState", "") ?: ""
        require(state.isNotBlank() && MessageDigest.isEqual(state.toByteArray(), params["state"].orEmpty().toByteArray())
            && prefs.getLong("signinExpires", 0) > System.currentTimeMillis()) { "This sign-in expired. Please start again." }
        val origin = URI(params["cluster"].orEmpty())
        require(origin.scheme == "https" && origin.host.orEmpty().matches(Regex("ghost-browser\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.my-app\\.engineer"))
            && origin.userInfo == null && origin.port == -1 && origin.path.orEmpty() in listOf("", "/")
            && origin.query == null && origin.fragment == null) { "Unexpected browser address" }
        val code = params["code"].orEmpty()
        require(code.matches(Regex("[A-Za-z0-9_-]{43}"))) { "Invalid connection code" }
        val verifier = prefs.getString("signinVerifier", "") ?: ""
        require(verifier.isNotBlank()) { "Please start sign-in again" }
        check(prefs.edit().remove("signinState").remove("signinVerifier").remove("signinExpires").commit())
        return Return("https://${origin.host}", code, verifier)
    }
}
