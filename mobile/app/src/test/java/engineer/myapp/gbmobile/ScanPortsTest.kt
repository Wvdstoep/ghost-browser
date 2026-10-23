package engineer.myapp.gbmobile

import org.junit.Assert.*
import org.junit.Test

class ScanPortsTest {
    @Test fun customPortsAreValidated() {
        assertEquals(listOf(80, 443), ScanPorts.parseCustom("80, 443, 80"))
        listOf("", "0", "65536", "80,abc", (1..25).joinToString(","))
            .forEach { assertNull(it, ScanPorts.parseCustom(it)) }
    }
}
