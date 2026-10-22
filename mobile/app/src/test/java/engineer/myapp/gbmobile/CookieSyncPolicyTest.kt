package engineer.myapp.gbmobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CookieSyncPolicyTest {
    @Test fun requiresExplicitApprovalForTheClusterAndProfile() {
        val cluster = "https://ghost-browser.example.test"
        val approval = setOf(CookieSyncPolicy.key(cluster, "p_shop"))

        assertFalse(CookieSyncPolicy.allows(emptySet(), cluster, "p_shop"))
        assertTrue(CookieSyncPolicy.allows(approval, "$cluster/", "p_shop"))
        assertFalse(CookieSyncPolicy.allows(approval, cluster, "p_mail"))
        assertFalse(CookieSyncPolicy.allows(approval, "https://other.example.test", "p_shop"))
        assertFalse(CookieSyncPolicy.allows(approval, cluster, "p_shop", "default"))
    }
}
