package engineer.myapp.gbmobile
import android.content.Context
import android.content.Intent
import android.content.ActivityNotFoundException
import android.net.Uri
import android.content.pm.ActivityInfo
import android.content.pm.ResolveInfo
import java.net.URI
import java.net.URLDecoder
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
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
    @Test fun googleLinksInTheAppOpenTheSystemBrowserWithTheSameAutomaticReturn() {
        assertTrue(PlatformSignIn.isGoogleSignIn("https://my-app.engineer/api/auth/google?next=test", true))
        assertFalse(PlatformSignIn.isGoogleSignIn("https://my-app.engineer/api/auth/google", false))
        assertFalse(PlatformSignIn.isGoogleSignIn("https://my-app.engineer.evil.test/api/auth/google", true))
        assertFalse(PlatformSignIn.isGoogleSignIn("http://my-app.engineer/api/auth/google", true))
        val login = URI(PlatformSignIn.begin(ctx, google = true))
        assertEquals("/api/auth/google", login.path)
        val next = URLDecoder.decode(login.rawQuery.substringAfter("next="), "UTF-8")
        val result = PlatformSignIn.takeReturn(ctx, callback())
        assertTrue(next.contains("device_challenge=${PlatformSignIn.challenge(result.verifier)}"))
    }
    @Test fun openingSignInCannotLoopIntoGhostBrowserWhenItIsTheDefaultBrowser() {
        val url = "https://my-app.engineer/api/auth/google?next=test"
        val request = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
        val pm = shadowOf(ctx.packageManager)
        fun handler(pkg: String) = ResolveInfo().apply { activityInfo = ActivityInfo().apply { packageName = pkg; name = "$pkg.Browser"; exported = true } }
        pm.addResolveInfoForIntent(request, handler(ctx.packageName))
        var launched: Intent? = null
        assertNull(PlatformSignIn.open(ctx) { launched = it })
        assertEquals("com.android.chrome", launched?.`package`)
    }
    @Test fun emailLoginOpensInsideTheAppWhenNoOtherBrowserIsAvailable() {
        val url = PlatformSignIn.open(ctx, launch = { throw ActivityNotFoundException() })
        assertNotNull(url)
        assertEquals("my-app.engineer", URI(url!!).host)
        val next = URLDecoder.decode(URI(url).rawQuery.substringAfter("next="), "UTF-8")
        val result = PlatformSignIn.takeReturn(ctx, callback())
        assertTrue(next.contains("device_challenge=${PlatformSignIn.challenge(result.verifier)}"))
    }
    @Test fun unavailableGoogleBrowserDoesNotBreakTheExistingEmailLogin() {
        PlatformSignIn.begin(ctx)
        val response = callback()
        assertThrows(IllegalStateException::class.java) { PlatformSignIn.open(ctx, google = true, launch = { throw ActivityNotFoundException() }) }
        assertNotNull(PlatformSignIn.takeReturn(ctx, response))
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
