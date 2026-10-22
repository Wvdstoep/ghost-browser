package engineer.myapp.gb.desktop

import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import engineer.myapp.gb.shared.ProfileCard
import engineer.myapp.gb.shared.ProfilesScreen
import engineer.myapp.gb.shared.RoleChoice
import org.json.JSONObject

/**
 * The desktop's half of the Profiles surface: fetch, set, and open in a new tab.
 *
 * The SCREEN is shared with the phone and the web console (:shared/ProfilesScreen.kt); this file is
 * only the wiring, which is the whole point — the phone kept its own idea of a profile's role in
 * its own preferences, so the cluster and this app never knew about it. One surface, one server
 * field, three platforms that cannot disagree.
 *
 * One cluster call fills the screen (GET /v1/profiles/overview), because the alternative is N+1:
 * the list, then each profile's settings, then the roles, then the flows, then the ring.
 */
class ProfilesUi {
    val cards = mutableStateOf<List<ProfileCard>>(emptyList())
    val roleNames = mutableStateOf<List<String>>(emptyList())
    val detail = mutableStateOf<RoleChoice?>(null)
    val status = mutableStateOf("")
}

/** Every profile and what it uses, in one call. Off the UI thread: this touches the network. */
fun loadProfilesD(state: DesktopState) {
    state.profiles.status.value = "loading your profiles…"
    Thread {
        try {
            val o = JSONObject(Cluster.authed("GET", "/v1/profiles/overview", null))
            if (o.has("error")) { state.profiles.status.value = o.optString("error"); return@Thread }
            val arr = o.optJSONArray("profiles")
            val out = ArrayList<ProfileCard>()
            for (i in 0 until (arr?.length() ?: 0)) {
                val p = arr!!.optJSONObject(i) ?: continue
                out.add(ProfileCard(
                    name = p.optString("name"),
                    site = p.optString("site"),
                    note = p.optString("note"),
                    hasLogin = p.optBoolean("hasLogin"),
                    role = p.optString("role"),
                    roleSource = p.optString("roleSource"),
                    missingRole = p.optString("missingRole"),
                    device = p.optString("device"),
                    automations = p.optInt("automations"),
                    live = p.optBoolean("live"),
                    exit = p.optString("exit"),
                ))
            }
            val names = ArrayList<String>()
            val rs = o.optJSONArray("roles")
            for (i in 0 until (rs?.length() ?: 0)) rs!!.optString(i).takeIf { it.isNotBlank() }?.let { names.add(it) }
            state.profiles.cards.value = out
            state.profiles.roleNames.value = names
            state.profiles.status.value = ""
        } catch (e: Exception) {
            state.profiles.status.value = "could not read your profiles: ${e.message}"
        }
    }.start()
}

/**
 * One role in full, for reading before choosing.
 *
 * `requireWords` and `runsOn` are sentences the SERVER writes (src/requireWords.js). Translating
 * capability flags here as well would be a second copy of one rule, and the copy in the client is
 * always the one that goes stale — which is exactly how a role's `require` came to be dropped from
 * this very endpoint's projection while the router still matched on it.
 */
fun readRoleD(state: DesktopState, name: String) {
    state.profiles.detail.value = null
    Thread {
        try {
            val r = JSONObject(Cluster.authed("GET", "/v1/agent/roles/$name", null))
            if (r.has("error")) { state.profiles.status.value = r.optString("error"); return@Thread }
            val tools = ArrayList<String>()
            val ta = r.optJSONArray("tools")
            for (i in 0 until (ta?.length() ?: 0)) ta!!.optString(i).takeIf { it.isNotBlank() }?.let { tools.add(it) }
            state.profiles.detail.value = RoleChoice(
                name = r.optString("name", name),
                label = r.optString("label"),
                site = r.optString("site"),
                group = r.optString("group"),
                description = r.optString("description"),
                playbook = r.optString("prompt"),
                requireWords = r.optString("requireWords"),
                runsOn = r.optJSONObject("runsOn")?.optString("summary") ?: "",
                tools = tools,
                builtin = r.optBoolean("builtin"),
                variants = roleVariantsOf(r),
            )
        } catch (e: Exception) {
            state.profiles.status.value = "could not read that role: ${e.message}"
        }
    }.start()
}

/**
 * Every way a role can be run, as the server listed them.
 *
 * Read, never derived: which device can do what is the ring's answer, and a client that works it
 * out from capability flags for itself is a second copy of the router's rule — and the copy in the
 * client is always the one that goes stale.
 */
private fun roleVariantsOf(r: JSONObject): List<engineer.myapp.gb.shared.RoleVariant> {
    val out = ArrayList<engineer.myapp.gb.shared.RoleVariant>()
    val va = r.optJSONArray("variants") ?: return out
    for (i in 0 until va.length()) {
        val v = va.optJSONObject(i) ?: continue
        out.add(engineer.myapp.gb.shared.RoleVariant(
            kind = v.optString("kind"), where = v.optString("where"),
            requireWords = v.optString("requireWords"), method = v.optString("method"),
            note = v.optString("note"), ready = v.optBoolean("ready"), runsOn = v.optString("runsOn"),
        ))
    }
    return out
}

/** Make a role this profile's default — or clear it back to the site match with "". */
fun setProfileRoleD(state: DesktopState, profile: String, role: String) {
    Thread {
        try {
            val body = JSONObject().put("defaultRole", role).toString()
            val r = JSONObject(Cluster.authed("PUT", "/v1/profiles/$profile/settings", body))
            /* The server refuses a role that does not exist and says which ones do — a typo'd id
               would otherwise leave the profile looking configured and behaving as a generalist. */
            if (r.has("error")) { state.profiles.status.value = r.optString("error") }
            else state.profiles.status.value = if (role.isBlank()) "$profile works it out from the site again" else "$profile uses $role"
        } catch (e: Exception) {
            state.profiles.status.value = "could not save that: ${e.message}"
        }
        loadProfilesD(state)
    }.start()
}

/**
 * One management call, its answer shown as it came.
 *
 * Every one of these refuses on the server while a session holds the profile, because pulling a
 * profile directory out from under a running Chromium leaves the browser writing into a folder that
 * no longer exists. The refusal is the useful part, so it is shown verbatim rather than swallowed.
 */
private fun manageProfileD(state: DesktopState, method: String, path: String, body: String?, ok: String) {
    state.profiles.status.value = "…"
    Thread {
        try {
            val r = JSONObject(Cluster.authed(method, path, body))
            state.profiles.status.value = if (r.has("error")) r.optString("error") else ok
        } catch (e: Exception) {
            state.profiles.status.value = "that did not go through: ${e.message}"
        }
        loadProfilesD(state)
    }.start()
}

/** The screen, wired. Opening a profile opens it in a NEW TAB — unchanged on purpose. */
@Composable
fun ProfilesScreenD(state: DesktopState, openInNewTab: (ProfileCard) -> Unit) {
    ProfilesScreen(
        profiles = state.profiles.cards.value,
        onOpen = openInNewTab,
        onRefresh = { loadProfilesD(state) },
        roleNames = state.profiles.roleNames.value,
        roleDetail = state.profiles.detail.value,
        onReadRole = { r -> readRoleD(state, r) },
        onSetRole = { p, r -> setProfileRoleD(state, p, r) },
        onCreate = { name, site ->
            manageProfileD(state, "POST", "/v1/profiles",
                JSONObject().put("name", name).put("site", site).toString(),
                "created \"$name\" — sign into it once by hand")
        },
        onRename = { p, to -> manageProfileD(state, "POST", "/v1/profiles/$p/rename", JSONObject().put("to", to).toString(), "renamed to \"$to\"") },
        onDuplicate = { p, to -> manageProfileD(state, "POST", "/v1/profiles/$p/duplicate", JSONObject().put("to", to).toString(), "copied to \"$to\" — settings only, so sign into it once") },
        onClearLogin = { p -> manageProfileD(state, "POST", "/v1/profiles/${p.name}/clear-login", "{}", "signed \"${p.name}\" out; its settings are untouched") },
        onDelete = { p -> manageProfileD(state, "DELETE", "/v1/profiles/${p.name}", null, "deleted \"${p.name}\"") },
        status = state.profiles.status.value,
        /*
         * SAY WHAT THIS ACTUALLY DOES HERE. On the phone a profile is a local cookie jar, so a new
         * tab really is that identity. This app has ONE JCEF cookie store, so the same press opens
         * the site in this browser with this browser's own cookies — the saved login listed above
         * lives on the cluster. Calling it "open the profile" would be quietly untrue.
         */
        openLabel = "Open the site here",
        openHint = "The saved logins live on the cluster. Opening here uses this browser's own cookies.",
    )
}
