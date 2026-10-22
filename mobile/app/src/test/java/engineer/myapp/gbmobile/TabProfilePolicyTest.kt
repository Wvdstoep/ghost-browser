package engineer.myapp.gbmobile

import org.junit.Assert.assertEquals
import org.junit.Test

class TabProfilePolicyTest {
    @Test fun genericNewTabUsesDefault() {
        assertEquals("default", TabProfilePolicy.forNewTab())
        assertEquals("default", TabProfilePolicy.forNewTab(""))
    }

    @Test fun profileOpenedFromProfilePageIsPreserved() {
        assertEquals("google", TabProfilePolicy.forNewTab("google"))
    }
}
