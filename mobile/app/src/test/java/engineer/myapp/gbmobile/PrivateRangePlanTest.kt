package engineer.myapp.gbmobile

import org.junit.Assert.*
import org.junit.Test

class PrivateRangePlanTest {
    @Test fun privateSubnetsAreBoundedAndNormalized() {
        val plan = PrivateRangePlan.parse("192.168.1.42/24")!!
        assertEquals("192.168.1.0/24", plan.cidr)
        assertEquals(254, plan.hosts.size)
        assertEquals("192.168.1.1", plan.hosts.first())
        assertEquals("192.168.1.254", plan.hosts.last())
        assertEquals(2, PrivateRangePlan.parse("10.0.0.1/30")!!.hosts.size)
    }

    @Test fun publicOrUnboundedRangesAreRejected() {
        listOf("0.0.0.0/0", "8.8.8.0/24", "10.0.0.0/8", "172.32.0.0/24", "192.169.0.0/24", "192.168.1.0/23", "192.168.1.999/24")
            .forEach { assertNull(it, PrivateRangePlan.parse(it)) }
        assertNotNull(PrivateRangePlan.parse("172.16.0.0/24"))
    }
}
