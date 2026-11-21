package engineer.myapp.gbmobile

import org.junit.Assert.*
import org.junit.Test

/** 1.01 (2026-11-21): the phone says which sites a profile is signed in to, so the cluster sends that work here. */
class SiteLoginsTest {
    @Test fun aLoginIsTheSitesSessionCookieNotAnyCookie() {
        assertTrue(SiteLogins.signedIn("datr=abc; c_user=1000123; xs=99%3Aab", listOf("c_user")))
        assertFalse(SiteLogins.signedIn("datr=abc; fr=xyz", listOf("c_user")))          // a signed-out visit
        assertFalse(SiteLogins.signedIn("c_user=", listOf("c_user")))                   // cleared on sign-out
        assertFalse(SiteLogins.signedIn(null, listOf("c_user")))
        assertFalse(SiteLogins.signedIn("my_c_user=1", listOf("c_user")))               // a name, not a part of one
    }

    @Test fun theSitesOfAProfileAreReadFromItsOwnCookies() {
        val jar = mapOf(
            "https://www.facebook.com/" to "datr=a; c_user=1; xs=2",
            "https://www.google.com/" to "NID=1; __Secure-1PSID=abc",
            "https://www.linkedin.com/" to "bcookie=x",
        )
        assertEquals(listOf("facebook.com", "google.com"), SiteLogins.of { jar[it] })
        assertEquals(emptyList<String>(), SiteLogins.of { null })
    }
}
