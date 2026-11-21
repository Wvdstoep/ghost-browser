package engineer.myapp.gbmobile

/**
 * WHICH SITES A PROFILE IS SIGNED IN TO (1.01, 2026-11-21).
 *
 * The owner's Facebook is signed in in this phone's "default" profile. The cluster routed by profile name
 * ("facebook"), so it never knew the login was here: the posts watcher read Facebook from the datacenter, and
 * a Claude session loaded Facebook there first. The phone now tells the cluster, per profile, which sites it
 * holds a real login for (caps.logins), and the cluster sends work for such a site straight here, into that
 * profile. Only the site names leave the phone, never a cookie.
 *
 * A login is the site's own session cookie, not "any cookie" (a signed-out visit leaves cookies too).
 */
internal object SiteLogins {
    /** site → the cookie names that only exist while signed in (as the cluster's sessionVault.AUTH_BY_HOST). */
    val SITES: Map<String, List<String>> = linkedMapOf(
        "facebook.com" to listOf("c_user"),
        "instagram.com" to listOf("sessionid"),
        "linkedin.com" to listOf("li_at"),
        "google.com" to listOf("SID", "__Secure-1PSID"),
        "x.com" to listOf("auth_token"),
        "tiktok.com" to listOf("sessionid"),
        "github.com" to listOf("user_session"),
        "reddit.com" to listOf("reddit_session", "token_v2"),
    )

    /** Is one of [names] set in this Cookie header ("a=1; c_user=123; xs=…")? */
    fun signedIn(cookieHeader: String?, names: List<String>): Boolean {
        if (cookieHeader.isNullOrBlank()) return false
        return cookieHeader.split(';').any { part ->
            val eq = part.indexOf('=')
            eq > 0 && part.substring(0, eq).trim() in names && part.substring(eq + 1).trim().isNotEmpty()
        }
    }

    /** The sites signed in, given how to read a site's cookies ("https://www.<site>/"). */
    fun of(cookiesFor: (String) -> String?): List<String> =
        SITES.filter { (site, names) -> signedIn(cookiesFor("https://www.$site/"), names) }.keys.toList()
}
