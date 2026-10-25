package engineer.myapp.gbmobile
import android.content.Context
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceSignOutTest {
    @Test fun restartCannotRestoreSignedOutDeviceOrSyncApproval() {
        val ctx = RuntimeEnvironment.getApplication()
        val prefs = ctx.getSharedPreferences("gb", Context.MODE_PRIVATE)
        prefs.edit().putString("clusterKey", "saved-key").putString("clusterUrl", "https://host.test")
            .putStringSet("approvedCookieSync", setOf("shop")).putString("flowsCache", "private").commit()
        assertTrue(DeviceSignOut.clear(ctx))
        val reopened = ctx.getSharedPreferences("gb", Context.MODE_PRIVATE)
        assertEquals("", reopened.getString("clusterKey", ""))
        assertFalse(reopened.contains("approvedCookieSync"))
        assertFalse(reopened.contains("flowsCache"))
        assertEquals("https://host.test", reopened.getString("clusterUrl", ""))
    }
}
