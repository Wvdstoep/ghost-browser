package engineer.myapp.gbmobile

import org.json.JSONArray
import org.json.JSONObject

/**
 * THE PHONE'S PROFILES: ONE NAME, ONE PLACE TO CREATE, AND IT SAYS WHERE IT LIVES.
 *
 * Until 0.92 a profile had up to three unrelated names. The Profiles page created it on the CLUSTER
 * ("AliExpress"); opening it there made a phone profile with the name lowercased ("aliexpress");
 * platform shortcuts made "p_aliexpress"; and a session the cluster handed to this phone opened yet
 * another one, the exact name it was given, empty. A login made by hand never reached the work that
 * needed it (AliExpress order handling, 2026-11-01: every page showed the login screen).
 *
 * Now a profile is created on the Profiles page only, with the cluster's own name rule, and is
 * stored in one of two ways:
 *  - [Storage.PHONE]: on this phone only. Its logins never leave the phone, and work the cluster
 *    hands to this phone cannot use it.
 *  - [Storage.SYNCED]: on this phone and on the cluster under the same name. You sign in on the
 *    phone; the login is copied to the cluster profile, and work handed to this phone runs in it.
 * A cluster profile that is not on this phone is shown as such and can be added here.
 *
 * [PhoneProfile.jar] is the WebView cookie store behind the name. It equals the name for every new
 * profile; older ones keep their store ("p_linkedin" behind "linkedin") so no login is lost, because
 * Android cannot rename a WebView profile.
 */
internal enum class Storage { PHONE, SYNCED }

internal data class PhoneProfile(val name: String, val jar: String, val storage: Storage, val site: String = "")

internal object ProfileRegistry {
    const val PREF = "profileRegistry"
    const val DEFAULT = "default"

    /** The cluster's rule for a profile name (src/profiles.js safeName): letters, digits, - and _, case kept, 40 at most. */
    fun key(raw: String): String = raw.replace(Regex("[^A-Za-z0-9_-]"), "").take(40)

    fun parse(json: String?): List<PhoneProfile> {
        // Nothing stored or unreadable: still "default", or a fresh phone would refuse even plain work.
        val arr = try { JSONArray(json ?: return withDefault(emptyList())) } catch (e: Exception) { return withDefault(emptyList()) }
        val out = ArrayList<PhoneProfile>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val name = o.optString("name"); if (name.isBlank()) continue
            val storage = if (o.optString("storage") == "synced") Storage.SYNCED else Storage.PHONE
            out.add(PhoneProfile(name, o.optString("jar").ifBlank { name }, storage, o.optString("site")))
        }
        return withDefault(out)
    }

    fun serialize(list: List<PhoneProfile>): String {
        val arr = JSONArray()
        for (p in list) arr.put(JSONObject().put("name", p.name).put("jar", p.jar).put("site", p.site)
            .put("storage", if (p.storage == Storage.SYNCED) "synced" else "phone"))
        return arr.toString()
    }

    /** "default" always exists: the phone's main browser, the one plain work handed to the phone uses. */
    private fun withDefault(list: List<PhoneProfile>): List<PhoneProfile> =
        if (list.any { it.name == DEFAULT }) list else listOf(PhoneProfile(DEFAULT, DEFAULT, Storage.PHONE)) + list

    /**
     * From the 0.91 layout: a comma list of local stores plus the per-cluster "share login" approvals.
     * "p_linkedin" becomes "linkedin" (the cluster name its login was copied to), synced only when that
     * copy was approved. The platform stores claim their cluster names first; any other store keeps its
     * own name, or gets "-phone" added when that name is taken. No store is touched.
     */
    fun migrate(localStores: List<String>, approvals: Set<String>, clusterUrl: String): List<PhoneProfile> {
        val stores = localStores.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        val out = ArrayList<PhoneProfile>()
        val taken = { n: String -> out.any { it.name == n } }
        for (jar in stores.filter { it.startsWith("p_") }) {
            val wanted = key(jar.removePrefix("p_")).ifBlank { key(jar) }
            val shared = CookieSyncPolicy.allows(approvals, clusterUrl, jar)
            out.add(PhoneProfile(if (taken(wanted)) key(jar) else wanted, jar, if (shared) Storage.SYNCED else Storage.PHONE))
        }
        for (jar in stores.filter { !it.startsWith("p_") }) {
            var name = key(jar).ifBlank { "profile" }
            if (taken(name)) { val base = key("$name-phone"); name = base; var i = 2; while (taken(name)) name = key("$base$i").also { i++ } }
            out.add(PhoneProfile(name, jar, Storage.PHONE))
        }
        return withDefault(out)
    }

    /** The stored list, or the 0.91 layout moved over (the service may run before the app ever opens after the update). */
    fun load(stored: String?, oldStores: String?, approvals: Set<String>, clusterUrl: String): List<PhoneProfile> =
        if (stored != null) parse(stored) else migrate((oldStores ?: DEFAULT).split(","), approvals, clusterUrl)

    fun find(list: List<PhoneProfile>, name: String): PhoneProfile? = list.firstOrNull { it.name == name }

    /** The cookie store behind a name; a name the phone does not have maps to nothing. */
    fun jarOf(list: List<PhoneProfile>, name: String): String? = find(list, name.ifBlank { DEFAULT })?.jar

    /**
     * The store work from the cluster may run in. Only "default" and synced profiles: a phone-only
     * profile is private to this phone, and a name the phone does not have is refused rather than
     * silently given an empty store (the AliExpress login page).
     */
    fun forCluster(list: List<PhoneProfile>, requested: String): PhoneProfile? {
        val p = find(list, requested.ifBlank { DEFAULT }) ?: return null
        return if (p.name == DEFAULT || p.storage == Storage.SYNCED) p else null
    }

    fun refusalFor(list: List<PhoneProfile>, requested: String): String {
        val name = requested.ifBlank { DEFAULT }
        val p = find(list, name)
        return if (p == null) "The profile \"$name\" is not on this phone. In the Ghost Browser app open Profiles, tap \"Use on this phone\" on \"$name\", and sign in there once."
        else "The profile \"$name\" is kept on this phone only. In the Ghost Browser app open Profiles and turn on \"Sync with cluster\" for \"$name\" to let work from the cluster use it."
    }

    /** What the phone tells the cluster it can run: exactly the stores [forCluster] accepts. */
    fun deviceProfiles(list: List<PhoneProfile>): List<String> = list.filter { it.name == DEFAULT || it.storage == Storage.SYNCED }.map { it.name }

    sealed class Change { data class Ok(val list: List<PhoneProfile>, val profile: PhoneProfile) : Change(); data class Refused(val why: String) : Change() }

    /** A new profile on this phone, with a fresh store of its own name. */
    fun add(list: List<PhoneProfile>, rawName: String, storage: Storage, site: String = "", clusterNames: Collection<String> = emptyList()): Change {
        val name = key(rawName)
        if (name.isBlank()) return Change.Refused("Use letters, digits, - or _ in the name.")
        if (name != rawName.trim()) return Change.Refused("\"${rawName.trim()}\" would become \"$name\": use letters, digits, - or _ only, so the name is the same on the phone and the cluster.")
        if (find(list, name) != null || list.any { it.jar == name }) return Change.Refused("\"$name\" is already on this phone.")
        // A phone-only profile may not share a name with a cluster profile: one name, one identity.
        if (storage == Storage.PHONE && name in clusterNames) return Change.Refused("Your cluster already has \"$name\". Use it on this phone instead, or pick another name.")
        val p = PhoneProfile(name, name, storage, site.trim())
        return Change.Ok(list + p, p)
    }

    /** Add a cluster profile to this phone: synced, under the cluster's own name. */
    fun useOnPhone(list: List<PhoneProfile>, clusterName: String, site: String = ""): Change {
        find(list, clusterName)?.let { existing ->
            return if (existing.storage == Storage.SYNCED) Change.Refused("\"$clusterName\" is already on this phone.")
            else Change.Refused("\"$clusterName\" is on this phone as a phone-only profile. Turn on \"Sync with cluster\" for it instead.")
        }
        if (list.any { it.jar == clusterName }) return Change.Refused("This phone already has a store named \"$clusterName\" under another profile.")
        val p = PhoneProfile(clusterName, clusterName, Storage.SYNCED, site.trim())
        return Change.Ok(list + p, p)
    }

    fun setStorage(list: List<PhoneProfile>, name: String, storage: Storage): Change {
        val p = find(list, name) ?: return Change.Refused("\"$name\" is not on this phone.")
        if (p.name == DEFAULT) return Change.Refused("\"default\" is the phone's main browser and stays as it is.")
        val q = p.copy(storage = storage)
        return Change.Ok(list.map { if (it.name == name) q else it }, q)
    }

    fun rename(list: List<PhoneProfile>, name: String, to: String): Change {
        val p = find(list, name) ?: return Change.Refused("\"$name\" is not on this phone.")
        val target = key(to)
        if (p.name == DEFAULT) return Change.Refused("\"default\" cannot be renamed.")
        if (target.isBlank() || target != to.trim()) return Change.Refused("Use letters, digits, - or _ only.")
        if (find(list, target) != null) return Change.Refused("\"$target\" is already on this phone.")
        val q = p.copy(name = target)   // the store stays: the login stays
        return Change.Ok(list.map { if (it.name == name) q else it }, q)
    }

    fun remove(list: List<PhoneProfile>, name: String): Change {
        val p = find(list, name) ?: return Change.Refused("\"$name\" is not on this phone.")
        if (p.name == DEFAULT) return Change.Refused("\"default\" cannot be deleted.")
        return Change.Ok(list.filter { it.name != name }, p)
    }

    /**
     * Where each profile lives, for the Profiles page: "synced" (both), "phone" (this phone only) or
     * "cluster" (the cluster has it, this phone does not).
     */
    fun placement(list: List<PhoneProfile>, clusterNames: Collection<String>): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for (p in list) out[p.name] = if (p.name == DEFAULT) "main" else if (p.storage == Storage.SYNCED) "synced" else "phone"
        for (n in clusterNames) if (n !in out) out[n] = "cluster"
        return out
    }
}
