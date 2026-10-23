package engineer.myapp.gbmobile

import java.net.IDN
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.security.cert.X509Certificate
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

data class DomainCandidate(val url: String, val host: String, val source: String)

/** Finds possible names for one observed IP. A forward DNS match is required, but is not proof of ownership. */
object DomainDiscovery {
    fun discover(
        evidence: RangeEvidence,
        reverse: (String) -> String? = { InetAddress.getByName(it).canonicalHostName },
        resolve: (String) -> List<String> = { InetAddress.getAllByName(it).mapNotNull { address -> address.hostAddress } },
        certificateNames: (String, Int) -> List<String> = ::tlsNames,
    ): List<DomainCandidate> {
        val proposals = mutableListOf<DomainCandidate>()
        evidence.web.forEach { web ->
            val url = web.redirectUrl
            if (url.isNotBlank()) runCatching { URI(url) }.getOrNull()?.host?.let { name ->
                proposals += DomainCandidate(url, name, "HTTP redirect")
            }
        }
        evidence.web.filter { it.scheme == "https" }.take(2).forEach { web ->
            runCatching { certificateNames(evidence.host, web.port) }.getOrDefault(emptyList()).take(12).forEach { name ->
                proposals += DomainCandidate(web.url(name), name, "TLS certificate name")
            }
        }
        runCatching { reverse(evidence.host) }.getOrNull()?.let { name ->
            val web = evidence.web.firstOrNull { it.scheme == "https" } ?: evidence.web.firstOrNull()
            if (web != null) proposals += DomainCandidate(web.url(name), name, "Reverse DNS name")
        }
        return proposals.mapNotNull { proposal ->
            val host = normalizedHost(proposal.host) ?: return@mapNotNull null
            if (host == evidence.host || !runCatching { resolve(host).contains(evidence.host) }.getOrDefault(false)) return@mapNotNull null
            val uri = runCatching { URI(proposal.url) }.getOrNull() ?: return@mapNotNull null
            if (uri.scheme?.lowercase() !in setOf("http", "https") || uri.userInfo != null ||
                uri.host?.lowercase() != host) return@mapNotNull null
            proposal.copy(host = host)
        }.distinctBy { it.host }.take(8)
    }

    fun manual(input: String, evidence: RangeEvidence,
               resolve: (String) -> List<String> = { InetAddress.getAllByName(it).mapNotNull { address -> address.hostAddress } }): DomainCandidate? {
        val raw = input.trim()
        if (raw.isBlank()) return null
        val preferredScheme = if (evidence.web.any { it.scheme == "https" }) "https" else "http"
        val url = if (raw.startsWith("http://", true) || raw.startsWith("https://", true)) raw else "$preferredScheme://$raw/"
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        val host = normalizedHost(uri.host.orEmpty()) ?: return null
        if (uri.scheme?.lowercase() !in setOf("http", "https") || uri.userInfo != null ||
            !runCatching { resolve(host).contains(evidence.host) }.getOrDefault(false)) return null
        return DomainCandidate(uri.toASCIIString(), host, "Entered domain · DNS matches scanned IP")
    }

    private fun normalizedHost(value: String): String? {
        val name = runCatching { IDN.toASCII(value.trimEnd('.')).lowercase() }.getOrNull() ?: return null
        if (name.length !in 4..253 || '.' !in name || !name.split('.').all { label ->
                label.length in 1..63 && label.first().isLetterOrDigit() && label.last().isLetterOrDigit() &&
                    label.all { it.isLetterOrDigit() || it == '-' }
            }) return null
        if (name.split('.').all { it.toIntOrNull() != null }) return null
        return name
    }

    private fun tlsNames(host: String, port: Int): List<String> = try {
        Socket().use { plain ->
            plain.connect(InetSocketAddress(host, port), 1500)
            plain.soTimeout = 1500
            val ssl = (SSLSocketFactory.getDefault() as SSLSocketFactory)
                .createSocket(plain, host, port, true) as SSLSocket
            ssl.use { socket ->
                socket.soTimeout = 1500
                socket.startHandshake()
                val cert = socket.session.peerCertificates.firstOrNull() as? X509Certificate
                cert?.subjectAlternativeNames?.mapNotNull { entry ->
                    if (entry.size >= 2 && entry[0] == 2) entry[1] as? String else null
                }.orEmpty()
            }
        }
    } catch (_: Exception) { emptyList() }
}
