package engineer.myapp.gbmobile

import org.junit.Assert.*
import org.junit.Test

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
}
