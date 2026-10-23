package engineer.myapp.gbmobile

import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.io.InputStream
import java.net.URL
import java.net.InetAddress
import java.time.Instant
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** Bounded, read-only root-page identification for a host already found in the selected range. */
object WebServiceProbe {
    private val webPorts = setOf(80, 443, 8000, 8080, 8081, 8443, 8888)
    data class Finding(val port: Int, val scheme: String, val status: Int, val title: String, val server: String, val poweredBy: String,
                       val contact: String = "", val redirectUrl: String = "") {
        fun url(host: String): String = "$scheme://$host${if (port == 80 && scheme == "http" || port == 443 && scheme == "https") "" else ":$port"}/"
        fun label(): String = listOf("${scheme.uppercase()} $status", server, poweredBy, title.takeIf { it.isNotBlank() }?.let { "\"$it\"" })
            .filterNotNull().filter { it.isNotBlank() }.joinToString(" · ")
    }

    fun supports(port: Int) = port in webPorts

    /** A redirect becomes a research target only if its hostname currently resolves to the scanned IP. */
    internal fun confirmedUrl(host: String, finding: Finding,
                              resolve: (String) -> List<String> = { name -> InetAddress.getAllByName(name).mapNotNull { it.hostAddress } }): String {
        val candidate = finding.redirectUrl.takeIf { it.isNotBlank() } ?: return finding.url(host)
        return try {
            val uri = java.net.URI(candidate)
            if (uri.scheme?.lowercase() in setOf("http", "https") && uri.userInfo == null &&
                !uri.host.isNullOrBlank() && resolve(uri.host).contains(host)) candidate else finding.url(host)
        } catch (_: Exception) { finding.url(host) }
    }

    fun inspect(host: String, port: Int): Finding? {
        if (!supports(port)) return null
        val tls = port == 443 || port == 8443
        val scheme = if (tls) "https" else "http"
        return try {
            Socket().use { plain ->
                plain.connect(InetSocketAddress(host, port), 1500)
                plain.soTimeout = 1500
                val socket = if (tls) (SSLSocketFactory.getDefault() as SSLSocketFactory)
                    .createSocket(plain, host, port, true).also { (it as SSLSocket).startHandshake() } else plain
                socket.soTimeout = 1500
                socket.getOutputStream().write("GET / HTTP/1.1\r\nHost: $host\r\nUser-Agent: GhostBrowser-Recon/1.0\r\nAccept: text/html,*/*\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
                socket.getOutputStream().flush()
                parse(port, scheme, readBounded(socket.getInputStream()))?.let { finding ->
                    if (tls) finding.copy(contact = securityContact(host, port)) else finding
                }
            }
        } catch (_: Exception) { null }
    }

    internal fun readBounded(stream: InputStream): String {
        val bytes = ByteArray(8192)
        var count = 0
        while (count < bytes.size) {
            val read = try { stream.read(bytes, count, bytes.size - count) }
                catch (_: SocketTimeoutException) { break }
            if (read <= 0) break
            count += read
            if (String(bytes, 0, count, Charsets.ISO_8859_1).contains("</title>", ignoreCase = true)) break
        }
        return String(bytes, 0, count, Charsets.ISO_8859_1)
    }

    /** HTTPS and its normal certificate/hostname checks are required for a trusted contact. */
    private fun securityContact(host: String, port: Int): String {
        val url = URL("https://$host:$port/.well-known/security.txt")
        val connection = (url.openConnection() as HttpsURLConnection).apply {
            connectTimeout = 1500; readTimeout = 1500; instanceFollowRedirects = false
            setRequestProperty("Accept", "text/plain")
            setRequestProperty("User-Agent", "GhostBrowser-Recon/1.0")
        }
        return try {
            if (connection.responseCode != 200 || !connection.contentType.orEmpty().startsWith("text/plain", true)) return ""
            val bytes = ByteArray(4096)
            var count = 0
            connection.inputStream.use { stream ->
                while (count < bytes.size) {
                    val read = stream.read(bytes, count, bytes.size - count)
                    if (read <= 0) break
                    count += read
                }
            }
            parseSecurityContact(String(bytes, 0, count, Charsets.UTF_8), url.toString())
        } catch (_: Exception) { "" } finally { connection.disconnect() }
    }

    internal fun parseSecurityContact(text: String, sourceUrl: String, now: Instant = Instant.now()): String {
        val lines = text.lineSequence().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith('#') }.toList()
        fun fields(key: String) = lines.filter { it.substringBefore(':').equals(key, true) }
            .map { it.substringAfter(':').trim() }
        val expires = fields("Expires").firstOrNull()?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return ""
        if (!expires.isAfter(now)) return ""
        val canonical = fields("Canonical")
        if (canonical.isNotEmpty() && canonical.none { it == sourceUrl }) return ""
        return fields("Contact").firstNotNullOfOrNull { value ->
            if (!value.startsWith("mailto:", true)) null else value.substringAfter(':').substringBefore('?')
                .takeIf { it.length <= 254 && EMAIL.matches(it) }
        }.orEmpty()
    }

    private val EMAIL = Regex("[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}")

    internal fun parse(port: Int, scheme: String, response: String): Finding? {
        val boundary = response.indexOf("\r\n\r\n")
        if (boundary < 0) return null
        val headers = response.substring(0, boundary).split("\r\n")
        val status = Regex("^HTTP/\\d(?:\\.\\d)?\\s+(\\d{3})").find(headers.firstOrNull().orEmpty())
            ?.groupValues?.get(1)?.toIntOrNull() ?: return null
        fun rawHeader(name: String) = headers.drop(1).firstOrNull { it.startsWith("$name:", ignoreCase = true) }
            ?.substringAfter(':')?.trim().orEmpty()
        fun header(name: String) = rawHeader(name).take(100)
        val body = response.substring(boundary + 4)
        val title = Regex("<title[^>]*>(.*?)</title>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
            .find(body)?.groupValues?.get(1)?.replace(Regex("\\s+"), " ")?.trim()?.take(120).orEmpty()
        val location = rawHeader("Location")
        val redirect = if (status in 300..399 && location.length in 1..2048) {
            runCatching {
                val uri = java.net.URI(location)
                if (uri.isAbsolute && uri.scheme.lowercase() in setOf("http", "https") &&
                    !uri.host.isNullOrBlank() && uri.userInfo == null) uri.toASCIIString() else ""
            }.getOrDefault("")
        } else ""
        return Finding(port, scheme, status, title, header("Server"), header("X-Powered-By"), redirectUrl = redirect)
    }
}
