package engineer.myapp.gb.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The readable parts of the Profiles surface.
 *
 * Compose itself is not unit-tested here, but every sentence this screen shows is produced by a
 * plain function, and those are exactly the places a wrong word misleads: a role that is only a
 * site match must never read as a decision somebody made, and a profile nobody is signed into must
 * not read as connected.
 */
class ProfilesScreenTest {

    @Test
    fun source_is_never_dressed_up_as_a_decision() {
        assertEquals("chosen", roleSourceLabel("chosen"))
        assertEquals("matched by site", roleSourceLabel("site"))
        assertEquals("not set", roleSourceLabel("none"))
        // Anything unexpected reads as not set rather than as a choice.
        assertEquals("not set", roleSourceLabel(""))
        assertEquals("not set", roleSourceLabel("something-new"))
    }

    @Test
    fun the_subtitle_says_a_login_is_SAVED_and_never_that_you_are_signed_in() {
        /* A profile is a cookie jar. Whether the site still accepts that cookie is only knowable by
           opening it, so "signed in" would state as fact something nothing has checked — and the
           platform registry already uses that word for something else ("a profile exists"). */
        val p = ProfileCard(name = "capcut", site = "capcut.com", hasLogin = true)
        assertEquals("login saved · capcut.com", profileSubtitle(p))
        assertEquals("no login yet · capcut.com", profileSubtitle(p.copy(hasLogin = false)))
        assertEquals("login saved · capcut.com · open now", profileSubtitle(p.copy(live = true)))
        assertEquals("no login yet", profileSubtitle(ProfileCard(name = "scratch")))
        assertTrue(!profileSubtitle(p).contains("signed in"))
    }

    @Test
    fun the_meta_line_says_only_what_is_known() {
        assertEquals("", profileMeta(ProfileCard(name = "p")))
        assertEquals("on WojMagEmi", profileMeta(ProfileCard(name = "p", device = "WojMagEmi")))
        assertEquals("1 automation", profileMeta(ProfileCard(name = "p", automations = 1)))
        assertEquals("3 automations", profileMeta(ProfileCard(name = "p", automations = 3)))
        assertEquals(
            "on WojMagEmi · 2 automations · exits tailscale · my business page",
            profileMeta(ProfileCard(name = "p", device = "WojMagEmi", automations = 2, exit = "tailscale", note = "my business page")),
        )
    }

    @Test
    fun the_profiles_being_worked_in_come_first_then_the_ones_with_a_login() {
        val list = listOf(
            ProfileCard(name = "zebra", hasLogin = false),
            ProfileCard(name = "apple", hasLogin = true),
            ProfileCard(name = "capcut", hasLogin = true, live = true),
            ProfileCard(name = "beta", hasLogin = false),
        )
        assertEquals(listOf("capcut", "apple", "beta", "zebra"), sortProfiles(list).map { it.name })
    }

    @Test
    fun the_order_does_not_shuffle_between_visits() {
        /* Alphabetical below the active ones, so a list of twenty looks the same next time — an
           order that changes on its own is a list nobody learns. */
        val a = listOf(ProfileCard(name = "b"), ProfileCard(name = "A"), ProfileCard(name = "c"))
        assertEquals(sortProfiles(a).map { it.name }, sortProfiles(a.reversed()).map { it.name })
        assertEquals(listOf("A", "b", "c"), sortProfiles(a).map { it.name })
    }

    @Test
    fun a_card_carries_the_rot_case_separately_from_the_role() {
        /* A stored role that no longer exists is its own fact: the profile looks configured and
           behaves like a generalist. It must not arrive as an empty role. */
        val p = ProfileCard(name = "capcut", role = "capcut-video-editor", roleSource = "site", missingRole = "capcut-editor-v2")
        assertTrue(p.missingRole.isNotBlank())
        assertEquals("matched by site", roleSourceLabel(p.roleSource))
    }

    @Test
    fun a_profile_needs_nothing_but_a_name_to_be_shown() {
        /* So a platform can adopt the screen with what it already has instead of waiting for the
           server to grow every field. */
        val p = ProfileCard(name = "default")
        assertEquals("default", p.name)
        assertEquals("", p.role)
        assertEquals("not set", roleSourceLabel(p.roleSource))
    }
}
