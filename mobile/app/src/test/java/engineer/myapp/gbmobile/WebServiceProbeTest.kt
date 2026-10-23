package engineer.myapp.gbmobile

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.io.InputStream
import java.net.SocketTimeoutException

class WebServiceProbeTest {
    @Test fun parsesOnlyHttpResponsesAndKeepsEvidenceBounded() {
        val response = "HTTP/1.1 200 OK\r\nServer: ExampleServer\r\nX-Powered-By: Demo\r\n\r\n<html><title>  Test   App </title></html>"
        val finding = WebServiceProbe.parse(80, "http", response)!!
        assertEquals(200, finding.status)
        assertEquals("Test App", finding.title)
        assertEquals("ExampleServer", finding.server)
        assertTrue(finding.label().contains("HTTP 200"))
        assertNull(WebServiceProbe.parse(80, "http", "SSH-2.0-OpenSSH\r\n\r\n"))
        assertFalse(WebServiceProbe.supports(22))
    }

    @Test fun acceptsOnlyCurrentMatchingSecurityTxtContact() {
        val url = "https://192.0.2.10:443/.well-known/security.txt"
        val valid = "Contact: mailto:security@example.org\nCanonical: $url\nExpires: 2030-01-01T00:00:00Z\n"
        val now = Instant.parse("2026-01-01T00:00:00Z")
        assertEquals("security@example.org", WebServiceProbe.parseSecurityContact(valid, url, now))
        assertEquals("", WebServiceProbe.parseSecurityContact(valid.replace("2030", "2020"), url, now))
        assertEquals("", WebServiceProbe.parseSecurityContact(valid.replace(url, "https://other.example/.well-known/security.txt"), url, now))
        assertEquals("", WebServiceProbe.parseSecurityContact(valid.replace("mailto:security@example.org", "https://example.org/contact"), url, now))
    }

    @Test fun keepsHeadersWhenAnOpenConnectionTimesOut() {
        val bytes = "HTTP/1.1 200 OK\r\nServer: Example\r\n\r\n".toByteArray()
        val stream = object : InputStream() {
            var readOnce = false
            override fun read(): Int = throw SocketTimeoutException()
            override fun read(destination: ByteArray, offset: Int, length: Int): Int {
                if (readOnce) throw SocketTimeoutException()
                readOnce = true
                bytes.copyInto(destination, offset)
                return bytes.size
            }
        }
        assertEquals(200, WebServiceProbe.parse(80, "http", WebServiceProbe.readBounded(stream))?.status)
    }

    @Test fun storesOnlyAbsoluteHttpRedirectAsAnUnverifiedAddress() {
        val response = "HTTP/1.1 301 Moved\r\nLocation: https://site.example/path\r\n\r\n"
        val finding = WebServiceProbe.parse(443, "https", response)!!
        assertEquals("https://192.0.2.3/", finding.url("192.0.2.3"))
        assertEquals("https://site.example/path", finding.redirectUrl)
        assertEquals("https://site.example/path", WebServiceProbe.confirmedUrl("192.0.2.3", finding) { listOf("192.0.2.3") })
        assertEquals("https://192.0.2.3/", WebServiceProbe.confirmedUrl("192.0.2.3", finding) { listOf("203.0.113.9") })
        assertEquals("", WebServiceProbe.parse(80, "http", response.replace("https://site.example/path", "javascript:bad()"))!!.redirectUrl)
        assertEquals("", WebServiceProbe.parse(80, "http", response.replace("https://site.example/path", "https://user:pass@site.example/"))!!.redirectUrl)
    }
}
