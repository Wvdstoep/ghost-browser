package engineer.myapp.gbmobile

import org.junit.Assert.*
import org.junit.Test

class DomainDiscoveryTest {
    private val evidence = RangeEvidence(7, 1, "192.0.2.0/24", "192.0.2.7", listOf(80, 443), 1,
        listOf(
            WebServiceProbe.Finding(80, "http", 301, "", "nginx", "", redirectUrl = "https://app.example.test/"),
            WebServiceProbe.Finding(443, "https", 200, "Portal", "nginx", "")
        ), "new")

    @Test fun onlyForwardMatchedNamesBecomeCandidates() {
        val found = DomainDiscovery.discover(evidence, reverse = { "host.example.test" },
            resolve = { name -> if (name == "app.example.test" || name == "host.example.test") listOf("192.0.2.7") else listOf("203.0.113.5") },
            certificateNames = { _, _ -> listOf("app.example.test", "unrelated.example.test", "*.example.test") },
            refreshPage = { _, _ -> null })
        assertEquals(listOf("app.example.test", "host.example.test"), found.map { it.host })
        assertEquals("https://app.example.test/", found.first().url)
        assertEquals("HTTP redirect", found.first().source)
    }

    @Test fun pageHintsAreCandidatesOnlyWhenTheirDomainsResolveToTheObservedIp() {
        val found = DomainDiscovery.discover(evidence, reverse = { null },
            resolve = { name -> if (name == "canonical.example.test") listOf("192.0.2.7") else listOf("203.0.113.5") },
            certificateNames = { _, _ -> emptyList() },
            refreshPage = { _, _ -> WebServiceProbe.Finding(443, "https", 200, "DataTrainingGPT", "nginx", "",
                canonicalUrl = "https://canonical.example.test/", openGraphUrl = "https://wrong.example.test/") })
        assertEquals(listOf("canonical.example.test"), found.map { it.host })
        assertEquals("HTML canonical link", found.single().source)
    }

    @Test fun manualDomainMustResolveToScannedIp() {
        assertEquals("https://app.example.test/", DomainDiscovery.manual("app.example.test", evidence) { listOf("192.0.2.7") }?.url)
        assertNull(DomainDiscovery.manual("app.example.test", evidence) { listOf("203.0.113.5") })
        assertNull(DomainDiscovery.manual("https://user:pass@app.example.test/", evidence) { listOf("192.0.2.7") })
        assertNull(DomainDiscovery.manual("https://192.0.2.7/", evidence) { listOf("192.0.2.7") })
    }
}
