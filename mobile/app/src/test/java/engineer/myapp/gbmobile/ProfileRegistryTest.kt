package engineer.myapp.gbmobile

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** 2026-11-01: "AliExpress" made on the Profiles page lived on the cluster only; every page handed to the phone showed the login screen. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ProfileRegistryTest {
    private val R = ProfileRegistry
    private fun ok(c: ProfileRegistry.Change) = (c as ProfileRegistry.Change.Ok)
    private fun refused(c: ProfileRegistry.Change) = (c as ProfileRegistry.Change.Refused).why

    @Test fun theNameRuleIsTheClustersOwnAndKeepsCase() {
        assertEquals("AliExpress", R.key("AliExpress"))
        assertEquals("shop-2_nl", R.key("shop-2_nl"))
        assertEquals("ali", R.key("a.l i!"))
        assertEquals(40, R.key("x".repeat(60)).length)
    }

    @Test fun aNameThatWouldChangeIsRefusedNotSilentlyRewritten() {
        val base = R.parse(null)
        assertTrue(refused(R.add(base, "Ali Express", Storage.SYNCED)).contains("would become \"AliExpress\""))
        assertEquals("AliExpress", ok(R.add(base, "AliExpress", Storage.SYNCED)).profile.name)
    }

    @Test fun aNewProfileHasAStoreOfItsOwnName() {
        val p = ok(R.add(R.parse(null), "AliExpress", Storage.SYNCED, "aliexpress.com")).profile
        assertEquals(PhoneProfile("AliExpress", "AliExpress", Storage.SYNCED, "aliexpress.com"), p)
    }

    @Test fun workFromTheClusterRunsOnlyInDefaultOrASyncedProfileAndNeverInAnEmptyStore() {
        var list = ok(R.add(R.parse(null), "AliExpress", Storage.SYNCED)).list
        list = ok(R.add(list, "privebank", Storage.PHONE)).list
        assertEquals("AliExpress", R.forCluster(list, "AliExpress")!!.jar)
        assertEquals("default", R.forCluster(list, "")!!.jar)
        assertNull(R.forCluster(list, "privebank"))
        assertNull(R.forCluster(list, "aliexpress"))      // case matters, as on the cluster
        assertTrue(R.refusalFor(list, "privebank").contains("Sync with cluster"))
        assertTrue(R.refusalFor(list, "Temu").contains("Use on this phone"))
        assertEquals(listOf("default", "AliExpress"), R.deviceProfiles(list))
    }

    @Test fun aClusterProfileIsAddedUnderItsOwnNameAndOnlyOnce() {
        val list = ok(R.useOnPhone(R.parse(null), "AliExpress", "aliexpress.com")).list
        assertEquals(Storage.SYNCED, R.find(list, "AliExpress")!!.storage)
        assertTrue(refused(R.useOnPhone(list, "AliExpress")).contains("already on this phone"))
        val phoneOnly = ok(R.add(R.parse(null), "mail", Storage.PHONE)).list
        assertTrue(refused(R.useOnPhone(phoneOnly, "mail")).contains("Turn on \"Sync with cluster\""))
    }

    @Test fun aPhoneOnlyProfileCannotShareANameWithTheCluster() {
        assertTrue(refused(R.add(R.parse(null), "AliExpress", Storage.PHONE, clusterNames = listOf("AliExpress"))).contains("already has"))
        assertTrue(R.add(R.parse(null), "AliExpress", Storage.SYNCED, clusterNames = listOf("AliExpress")) is ProfileRegistry.Change.Ok)
    }

    @Test fun theOldLayoutMovesOverWithoutLosingAStore() {
        val cluster = "https://gb.example.test"
        val list = R.migrate(listOf("default", "p_linkedin", "p_reddit", "aliexpress", "linkedin"),
            setOf(CookieSyncPolicy.key(cluster, "p_linkedin")), cluster)
        assertEquals(PhoneProfile("linkedin", "p_linkedin", Storage.SYNCED), R.find(list, "linkedin"))
        assertEquals(PhoneProfile("reddit", "p_reddit", Storage.PHONE), R.find(list, "reddit"))
        assertEquals(PhoneProfile("aliexpress", "aliexpress", Storage.PHONE), R.find(list, "aliexpress"))
        // "linkedin" belongs to the store whose login went to the cluster's "linkedin"; the plain one moves aside
        assertEquals(PhoneProfile("linkedin-phone", "linkedin", Storage.PHONE), R.find(list, "linkedin-phone"))
        assertEquals(list.size, list.map { it.name }.distinct().size)
        assertEquals(5, list.size)
        assertEquals("p_linkedin", R.jarOf(list, "linkedin"))
    }

    @Test fun survivesARoundTripAndAlwaysHasDefault() {
        val list = ok(R.add(R.parse(null), "AliExpress", Storage.SYNCED, "aliexpress.com")).list
        assertEquals(list, R.parse(R.serialize(list)))
        assertEquals("default", R.parse("not json").single().name)
    }

    @Test fun renameKeepsTheStoreAndDefaultStaysPut() {
        val list = ok(R.add(R.parse(null), "shop", Storage.PHONE)).list
        val p = ok(R.rename(list, "shop", "shop2")).profile
        assertEquals(PhoneProfile("shop2", "shop", Storage.PHONE), p)
        assertTrue(R.rename(list, "default", "x") is ProfileRegistry.Change.Refused)
        assertTrue(R.remove(list, "default") is ProfileRegistry.Change.Refused)
        assertTrue(R.setStorage(list, "default", Storage.SYNCED) is ProfileRegistry.Change.Refused)
    }

    @Test fun thePageSaysWhereEachProfileLives() {
        var list = ok(R.add(R.parse(null), "AliExpress", Storage.SYNCED)).list
        list = ok(R.add(list, "privebank", Storage.PHONE)).list
        assertEquals(mapOf("default" to "main", "AliExpress" to "synced", "privebank" to "phone", "facebook" to "cluster"),
            R.placement(list, listOf("AliExpress", "facebook", "default")))
    }
}
