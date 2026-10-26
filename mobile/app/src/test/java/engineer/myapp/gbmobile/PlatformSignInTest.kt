package engineer.myapp.gbmobile
import android.content.Context
import java.net.URI
import java.net.URLDecoder
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlatformSignInTest {
    private val ctx get() = RuntimeEnvironment.getApplication()
    private fun callback(cluster: String = "https://ghost-browser.ben-magrill.my-app.engineer", state: String? = null): String {
        val saved = ctx.getSharedPreferences("gb", Context.MODE_PRIVATE).getString("signinState", "")
        return "ghostbrowser://connect?cluster=$cluster&code=${"c".repeat(43)}&state=${state ?: saved}"
    }
    @Test fun normalSignInReturnsToTheCorrectAccountWithoutToolsNavigation() {
        val login = URI(PlatformSignIn.begin(ctx))
        assertEquals("my-app.engineer", login.host)
        val next = URLDecoder.decode(login.rawQuery.substringAfter("next="), "UTF-8")
        assertTrue(next.startsWith("/api/cluster-tools/ghost-browser/open?"))
        val result = PlatformSignIn.takeReturn(ctx, callback())
        assertEquals("https://ghost-browser.ben-magrill.my-app.engineer", result.cluster)
        assertTrue(next.contains("device_challenge=${PlatformSignIn.challenge(result.verifier)}"))
        assertThrows(IllegalArgumentException::class.java) { PlatformSignIn.takeReturn(ctx, callback()) }
    }
    @Test fun rejectsUnrequestedCallbacksAndWrongState() {
        ctx.getSharedPreferences("gb", Context.MODE_PRIVATE).edit().clear().commit()
        assertThrows(IllegalArgumentException::class.java) { PlatformSignIn.takeReturn(ctx, callback()) }
        PlatformSignIn.begin(ctx)
        assertThrows(IllegalArgumentException::class.java) { PlatformSignIn.takeReturn(ctx, callback(state = "wrong")) }
        assertNotNull(PlatformSignIn.takeReturn(ctx, callback()))
    }
    @Test fun rejectsLookalikeHostsHttpUserinfoAndOtherPorts() {
        for (host in listOf("https://ghost-browser.ben.my-app.engineer.attacker.test", "http://ghost-browser.ben.my-app.engineer", "https://evil@ghost-browser.ben.my-app.engineer", "https://ghost-browser.ben.my-app.engineer:444")) {
            PlatformSignIn.begin(ctx)
            assertThrows(IllegalArgumentException::class.java) { PlatformSignIn.takeReturn(ctx, callback(cluster = host)) }
        }
    }
    @Test fun signOutCancelsAnOutstandingBrowserLogin() {
        PlatformSignIn.begin(ctx); val response = callback(); DeviceSignOut.clear(ctx)
        assertThrows(IllegalArgumentException::class.java) { PlatformSignIn.takeReturn(ctx, response) }
    }
}
