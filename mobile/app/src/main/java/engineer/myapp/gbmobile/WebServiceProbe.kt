package engineer.myapp.gbmobile

import java.net.InetSocketAddress
import java.net.Socket
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** Bounded, read-only root-page identification for a host already found in the selected range. */
object WebServiceProbe {
    private val webPorts = setOf(80, 443, 8000, 8080, 8081, 8443, 8888)
    data class Finding(val port: Int, val scheme: String, val status: Int, val title: String, val server: String, val poweredBy: String) {
        fun label(): String = listOf("${scheme.uppercase()} $status", server, poweredBy, title.takeIf { it.isNotBlank() }?.let { "\"$it\"" })
            .filterNotNull().filter { it.isNotBlank() }.joinToString(" · ")
    }

    fun supports(port: Int) = port in webPorts

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
                val bytes = ByteArray(8192)
                var count = 0
                while (count < bytes.size) {
                    val read = socket.getInputStream().read(bytes, count, bytes.size - count)
                    if (read <= 0) break
                    count += read
                    if (String(bytes, 0, count, Charsets.ISO_8859_1).contains("</title>", ignoreCase = true)) break
                }
                parse(port, scheme, String(bytes, 0, count, Charsets.ISO_8859_1))
            }
        } catch (_: Exception) { null }
    }

    internal fun parse(port: Int, scheme: String, response: String): Finding? {
        val boundary = response.indexOf("\r\n\r\n")
        if (boundary < 0) return null
        val headers = response.substring(0, boundary).split("\r\n")
        val status = Regex("^HTTP/\\d(?:\\.\\d)?\\s+(\\d{3})").find(headers.firstOrNull().orEmpty())
            ?.groupValues?.get(1)?.toIntOrNull() ?: return null
        fun header(name: String) = headers.drop(1).firstOrNull { it.startsWith("$name:", ignoreCase = true) }
            ?.substringAfter(':')?.trim()?.take(100).orEmpty()
        val body = response.substring(boundary + 4)
        val title = Regex("<title[^>]*>(.*?)</title>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
            .find(body)?.groupValues?.get(1)?.replace(Regex("\\s+"), " ")?.trim()?.take(120).orEmpty()
        return Finding(port, scheme, status, title, header("Server"), header("X-Powered-By"))
    }
}
