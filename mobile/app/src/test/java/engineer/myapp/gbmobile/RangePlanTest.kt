package engineer.myapp.gbmobile

import org.junit.Assert.*
import org.junit.Test

class RangePlanTest {
    @Test fun privateSubnetsAreBoundedAndNormalized() {
        val plan = RangePlan.parse("192.168.1.42/24")!!
        assertEquals("192.168.1.0/24", plan.cidr)
        assertEquals(254, plan.hosts.size)
        assertEquals("192.168.1.1", plan.hosts.first())
        assertEquals("192.168.1.254", plan.hosts.last())
        assertEquals(2, RangePlan.parse("10.0.0.1/30")!!.hosts.size)
        assertEquals(RangePlan.Scope.PRIVATE, plan.scope)
    }

    @Test fun publicRangesAreBoundedAndSpecialUseIsRejected() {
        assertEquals(RangePlan.Scope.PUBLIC, RangePlan.parse("8.8.8.9/30")!!.scope)
        listOf("0.0.0.0/0", "10.0.0.0/8", "192.168.1.0/23", "192.168.1.999/24",
            "127.0.0.1/32", "169.254.1.0/24", "192.0.2.0/24", "198.51.100.0/24",
            "203.0.113.0/24", "224.0.0.0/24", "100.64.0.0/24")
            .forEach { assertNull(it, RangePlan.parse(it)) }
        assertNotNull(RangePlan.parse("172.16.0.0/24"))
    }
}
