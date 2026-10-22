package engineer.myapp.gb.shared

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * PROFILES — its own surface, because a profile is not a preference.
 *
 * A profile is a logged-in identity that automations act through, and it lived three taps inside
 * Settings as a row of chips plus one read-only line naming its role. The role was worse than
 * hidden: it was kept in a JSON map in the PHONE's own preferences, so the cluster never knew about
 * it, the desktop never knew about it, and reinstalling the app lost it. That is why a CapCut
 * request asked for in the chat arrived at the cluster with no role at all and spent seventy steps
 * working out a video editor from scratch.
 *
 * So the choice now lives on the profile itself, on the server (see profileRole.js), and this is
 * where a person sees and changes it. Shared, so phone, desktop and web show the same surface.
 *
 * ONE THING DELIBERATELY UNCHANGED: pressing a profile opens it in a NEW TAB. That is the part of
 * the old UI that was right, and every management action here is additional to it, never instead.
 */

/**
 * One profile as this surface needs it. Everything except [name] is optional so a platform can
 * adopt the screen with what it already has and fill the rest in later.
 *
 * [roleSource] is `chosen` | `site` | `none`, straight from the server's own answer — a role and
 * the reason it is that role are different facts, and only the second one silently stops being true
 * when something is renamed. [missingRole] names a stored role that no longer exists: the one state
 * that looks configured and behaves like a generalist.
 */
data class ProfileCard(
    val name: String,
    val site: String = "",
    val note: String = "",
    val hasLogin: Boolean = false,
    val role: String = "",
    val roleSource: String = "",
    val missingRole: String = "",
    val device: String = "",          // which device holds this login, if the ring knows
    val automations: Int = 0,         // how many saved automations run steps in this profile
    val live: Boolean = false,        // a session is open on it right now
    val exit: String = "",            // where it leaves from: tailscale | direct | a proxy
)

/**
 * A role as it is READ BEFORE BEING CHOSEN — the whole point of this screen. [playbook] is the full
 * instruction text, not a summary: its traps are the valuable part. [requireWords] and [runsOn] are
 * sentences the SERVER writes (see requireWords.js), because a phone, a desktop and a web console
 * each translating the same capability flags is three copies of one rule and the third goes stale.
 */
data class RoleChoice(
    val name: String,
    val label: String = "",
    val site: String = "",
    val group: String = "",
    val description: String = "",
    val playbook: String = "",
    val requireWords: String = "",
    val runsOn: String = "",
    val tools: List<String> = emptyList(),
    val builtin: Boolean = false,
    /** Every way this role can be run — see [RoleVariant]. Empty for a role with no device section. */
    val variants: List<RoleVariant> = emptyList(),
)

/**
 * ONE WAY OF DOING THE WORK, ON ONE KIND OF DEVICE.
 *
 * A role used to state a single requirement, and that quietly decided which machine could ever run
 * it: the CapCut role asks for a desktop browser it can drag in, so a phone was excluded by
 * omission — though a phone could do the same job by long-pressing and dragging with a finger.
 *
 * For someone choosing a role this is the interesting part, and [ready] is the deciding fact: a
 * method that needs a device nobody has connected is not a method you can use today.
 */
data class RoleVariant(
    val kind: String,              // desktop | android | cluster | any
    val where: String,             // "your desktop", "your phone", …
    val requireWords: String = "",
    val method: String = "",       // how the work is done on THIS device
    val note: String = "",
    val ready: Boolean = false,    // a connected device satisfies it right now
    val runsOn: String = "",       // …and which, or why not
)

/** How the role came to be this profile's role, in the words the card shows. */
fun roleSourceLabel(source: String): String = when (source) {
    "chosen" -> "chosen"
    "site" -> "matched by site"
    else -> "not set"
}

/** The one line under a profile's name. */
fun profileSubtitle(p: ProfileCard): String {
    val bits = ArrayList<String>()
    bits.add(if (p.hasLogin) "login saved" else "no login yet")
    if (p.site.isNotBlank()) bits.add(p.site)
    if (p.live) bits.add("open now")
    return bits.joinToString(" · ")
}

/** What is going on with a profile, under the role row. Empty when there is nothing to say. */
fun profileMeta(p: ProfileCard): String {
    val bits = ArrayList<String>()
    if (p.device.isNotBlank()) bits.add("on ${p.device}")
    if (p.automations > 0) bits.add(if (p.automations == 1) "1 automation" else "${p.automations} automations")
    if (p.exit.isNotBlank()) bits.add("exits ${p.exit}")
    if (p.note.isNotBlank()) bits.add(p.note)
    return bits.joinToString(" · ")
}

/**
 * Open profiles first, then the ones with a login — the ones being worked in are the ones being
 * looked for. The rest alphabetical, so a list of twenty does not reorder itself between visits.
 */
fun sortProfiles(list: List<ProfileCard>): List<ProfileCard> =
    list.sortedWith(compareByDescending<ProfileCard> { it.live }
        .thenByDescending { it.hasLogin }
        .thenBy { it.name.lowercase() })

@Composable
fun ProfilesScreen(
    profiles: List<ProfileCard>,
    onOpen: (ProfileCard) -> Unit,                    // opens the profile in a NEW TAB
    onRefresh: () -> Unit,
    roleNames: List<String>,
    roleDetail: RoleChoice?,                          // the role being read right now, if loaded
    onReadRole: (String) -> Unit,                     // fetch one role in full
    onSetRole: (String, String) -> Unit,              // (profile, role) — "" clears it
    /*
     * MANAGING A LOGGED-IN IDENTITY (phase 4). Each of these refuses on the server while a session
     * holds the profile, because pulling a profile directory out from under a running Chromium
     * leaves the browser writing into a folder that no longer exists — and that surfaces minutes
     * later somewhere unrelated. The screen shows the refusal rather than pretending it worked.
     */
    onCreate: (name: String, site: String) -> Unit = { _, _ -> },
    onRename: (profile: String, to: String) -> Unit = { _, _ -> },
    onDuplicate: (profile: String, to: String) -> Unit = { _, _ -> },
    onClearLogin: (ProfileCard) -> Unit = {},
    onDelete: (ProfileCard) -> Unit = {},
    status: String = "",
    phonePlatforms: List<PlatformOpt> = emptyList(),
    onOpenPhonePlatform: ((PlatformOpt) -> Unit)? = null,
    onSetPhoneCookieSync: ((profile: String, approved: Boolean) -> Unit)? = null,
    /*
     * WHAT OPENING ACTUALLY DOES, IN EACH PLATFORM'S OWN WORDS.
     *
     * On the phone a profile IS a local cookie jar (WebView MULTI_PROFILE), so a new tab really is
     * that identity. The desktop has one JCEF cookie store for the whole app, so the same button
     * there opens the site in this browser — near, but not the same thing, and the saved login it
     * shows in the list lives on the cluster. Rather than one label quietly overclaiming on one of
     * them, each platform says what is true.
     */
    openLabel: String = "Open in a new tab",
    openHint: String = "",
    modifier: Modifier = Modifier,
    topInset: Modifier = Modifier,
) {
    val cs = MaterialTheme.colorScheme
    /* Which profile's role is being changed. Null = the list. A panel rather than a modal sheet:
       one code path that behaves the same on phone, desktop and web. */
    var picking by remember { mutableStateOf<ProfileCard?>(null) }
    var reading by remember { mutableStateOf("") }
    /* Which profile is being managed, and whether the Add row is showing. */
    var managing by remember { mutableStateOf<ProfileCard?>(null) }
    var adding by remember { mutableStateOf(false) }

    Surface(color = cs.background, contentColor = cs.onBackground, modifier = modifier.fillMaxSize()) {
        val manage = managing
        if (manage != null) {
            /* Managing reads the CURRENT card, not the one captured when the panel opened: after a
               rename or a cleared login the list reloads, and a stale copy would show the old
               name and act on it. */
            val live = profiles.firstOrNull { it.name == manage.name }
            if (live == null) { managing = null } else {
                ManagePanel(
                    profile = live,
                    /* The role belongs here as much as on the card: managing a profile is exactly
                       when someone wants to change which specialist it uses, and having to go back
                       to the list to find it is the reason it read as missing. */
                    onChooseRole = { picking = live; reading = ""; managing = null },
                    onRename = { to -> onRename(live.name, to); managing = null },
                    onDuplicate = { to -> onDuplicate(live.name, to); managing = null },
                    onClearLogin = { onClearLogin(live) },
                    onDelete = { onDelete(live); managing = null },
                    onBack = { managing = null },
                    status = status,
                    topInset = topInset,
                )
                return@Surface
            }
        }
        val open = picking
        if (open != null) {
            RolePickerPanel(
                profile = open,
                roleNames = roleNames,
                reading = reading,
                detail = roleDetail,
                onReadRole = { r -> reading = r; onReadRole(r) },
                onChoose = { r -> onSetRole(open.name, r); picking = null; reading = "" },
                onBack = { picking = null; reading = "" },
                topInset = topInset,
            )
            return@Surface
        }

        Column(Modifier.fillMaxSize().then(topInset)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Profiles", style = MaterialTheme.typography.headlineSmall)
                    /* "login saved", not "signed in": a profile is a cookie jar, and whether the
                       site still accepts that cookie is only knowable by opening it. */
                    val saved = profiles.count { it.hasLogin }
                    Text(
                        if (profiles.isEmpty()) "Your logged-in identities"
                        else "$saved of ${profiles.size} with a login saved",
                        color = cs.onSurfaceVariant, fontSize = 12.sp,
                    )
                }
                TextButton(onClick = { adding = !adding }) { Text(if (adding) "Cancel" else "Add") }
                TextButton(onClick = onRefresh) { Text("Refresh") }
            }
            if (adding) {
                AddProfileRow(onCreate = { n, s -> onCreate(n, s); adding = false })
            }
            if (status.isNotBlank()) {
                Text(status, color = cs.onSurfaceVariant, fontSize = 12.sp,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp))
            }
            if (profiles.isEmpty() && onSetPhoneCookieSync == null) {
                Text("No profiles yet. A profile is born the first time you sign into a site in it.",
                    color = cs.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.padding(16.dp))
            } else {
                Column(
                    Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (onSetPhoneCookieSync != null) {
                        Text("Phone platforms", style = MaterialTheme.typography.titleMedium)
                        Text("Open a platform in its phone profile, then choose whether that login may be copied to the cluster.",
                            color = cs.onSurfaceVariant, fontSize = 11.sp)
                        if (phonePlatforms.isEmpty()) {
                            Text("No platforms loaded yet. Tap Refresh to load them from the cluster.",
                                color = cs.onSurfaceVariant, fontSize = 12.sp)
                        }
                        phonePlatforms.forEach { platform ->
                            Surface(color = cs.surface, shape = RoundedCornerShape(14.dp),
                                border = BorderStroke(1.dp, cs.outline), modifier = Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(14.dp)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Column(Modifier.weight(1f)) {
                                            Text(platform.label, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                                            Text(if (platform.signedIn) "login saved on this phone" else "no phone login yet",
                                                color = cs.onSurfaceVariant, fontSize = 11.sp)
                                        }
                                        if (onOpenPhonePlatform != null)
                                            TextButton(onClick = { onOpenPhonePlatform(platform) }) { Text("Open") }
                                    }
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text("Share login with cluster", Modifier.weight(1f), fontSize = 12.sp)
                                        Switch(checked = platform.syncApproved,
                                            onCheckedChange = { onSetPhoneCookieSync(platform.profile, it) })
                                    }
                                }
                            }
                        }
                        Text("Sharing copies session cookies to the cluster. Android does not expose their original scope or HttpOnly flags. Turning sharing off stops future copies; sign out in the cluster profile to clear an existing session.",
                            color = cs.onSurfaceVariant, fontSize = 11.sp)
                        HorizontalDivider(color = cs.outline)
                        Text("Cluster profiles", style = MaterialTheme.typography.titleMedium)
                    }
                    if (openHint.isNotBlank()) {
                        Text(openHint, color = cs.onSurfaceVariant, fontSize = 11.sp)
                    }
                    if (profiles.isEmpty()) {
                        Text("No cluster profiles yet.", color = cs.onSurfaceVariant, fontSize = 12.sp)
                    } else {
                        sortProfiles(profiles).forEach { p ->
                            ProfileRow(p, openLabel = openLabel, onOpen = { onOpen(p) },
                                onRole = { picking = p; reading = "" }, onManage = { managing = p })
                        }
                    }
                    Spacer(Modifier.height(24.dp))
                }
            }
        }
    }
}

@Composable
private fun ProfileRow(p: ProfileCard, openLabel: String, onOpen: () -> Unit, onRole: () -> Unit, onManage: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, cs.outline),
        modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            /* The whole header opens the profile in a new tab — the gesture that already worked. */
            Row(Modifier.fillMaxWidth().clickable { onOpen() }, verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(9.dp).clip(CircleShape).background(if (p.hasLogin) Brand else cs.onSurfaceVariant))
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(p.name, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(profileSubtitle(p), color = cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Spacer(Modifier.height(10.dp))

            /* THE ROLE ROW — the plugin line. Pressable, because reading and changing it is why
               this screen exists; the source pill is there so a role that is only a site match
               cannot be mistaken for a decision somebody made. */
            Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth().clickable { onRole() }) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            if (p.role.isBlank() || p.role == "general") "No specialist — runs as a generalist" else p.role,
                            fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        Text(roleSourceLabel(p.roleSource), color = cs.onSurfaceVariant, fontSize = 10.sp)
                    }
                    Text("Change", color = Brand, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }

            if (p.missingRole.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                /* Configured on purpose, and the configuration has rotted. The one state that looks
                   set up and behaves like a generalist, so it is said out loud rather than shown as
                   an empty role. */
                Text("This profile names \"${p.missingRole}\", which no longer exists — pick another.",
                    color = cs.error, fontSize = 11.sp)
            }

            val meta = profileMeta(p)
            if (meta.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(meta, color = cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 2)
            }

            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onOpen, shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 7.dp)) {
                    Text(openLabel, fontSize = 13.sp)
                }
                TextButton(onClick = onManage, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 7.dp)) {
                    Text("Manage", fontSize = 13.sp)
                }
            }
        }
    }
}

/**
 * A PROFILE BORN ON PURPOSE.
 *
 * Until now one appeared the first time a session opened it, so the only way to make a second
 * identity for a site was to open a browser and hope. The site is asked for here because it is what
 * matches the profile to the roles that know that site — a profile with no site is a login nothing
 * can reason about.
 */
@Composable
private fun AddProfileRow(onCreate: (String, String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var name by remember { mutableStateOf("") }
    var site by remember { mutableStateOf("") }
    Surface(color = cs.surface, shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, cs.outline),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
        Column(Modifier.padding(12.dp)) {
            OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true,
                placeholder = { Text("capcut-second") }, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(site, { site = it }, label = { Text("Site") }, singleLine = true,
                placeholder = { Text("capcut.com") }, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(10.dp))
            Button(onClick = { if (name.isNotBlank()) onCreate(name.trim(), site.trim()) },
                enabled = name.isNotBlank(), shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) {
                Text("Create", fontSize = 13.sp)
            }
            Spacer(Modifier.height(4.dp))
            Text("It starts empty. Sign into it once by hand and the login stays.",
                color = cs.onSurfaceVariant, fontSize = 11.sp)
        }
    }
}

/**
 * MANAGING ONE LOGGED-IN IDENTITY.
 *
 * Rename, duplicate, sign out, delete — and the distinction that matters most is between the last
 * two. Deleting a profile to be rid of a bad login also deletes its timezone, its exit and its
 * role, and those took thought; clearing the login keeps all of it. So signing out is offered
 * first, plainly, and deleting asks a second time.
 */
@Composable
private fun ManagePanel(
    profile: ProfileCard,
    onChooseRole: () -> Unit,
    onRename: (String) -> Unit,
    onDuplicate: (String) -> Unit,
    onClearLogin: () -> Unit,
    onDelete: () -> Unit,
    onBack: () -> Unit,
    status: String,
    topInset: Modifier,
) {
    val cs = MaterialTheme.colorScheme
    var newName by remember(profile.name) { mutableStateOf(profile.name) }
    var copyName by remember(profile.name) { mutableStateOf("${profile.name}-2") }
    var confirmDelete by remember(profile.name) { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().then(topInset)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack, contentPadding = PaddingValues(horizontal = 4.dp)) { Text("Back") }
            Spacer(Modifier.width(6.dp))
            Column(Modifier.weight(1f)) {
                Text(profile.name, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(profileSubtitle(profile), color = cs.onSurfaceVariant, fontSize = 12.sp)
            }
        }
        if (status.isNotBlank()) {
            Text(status, color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp))
        }

        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {

            val meta = profileMeta(profile)
            if (meta.isNotBlank()) Text(meta, color = cs.onSurfaceVariant, fontSize = 11.sp)

            /*
             * THE ROLE, FIRST — it is the thing most likely to be wanted here.
             *
             * The picker was only reachable from the card in the list, so opening Manage and
             * finding rename/duplicate/delete read as "the role selection is missing". It is the
             * same picker; this is just the door that was not there.
             */
            ManageCard("Role", "The playbook this profile's work runs with. Read a role in full before choosing it.") {
                Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(horizontal = 12.dp, vertical = 9.dp)) {
                        Text(
                            if (profile.role.isBlank() || profile.role == "general") "No specialist — runs as a generalist" else profile.role,
                            fontSize = 13.sp, fontWeight = FontWeight.Medium,
                        )
                        Text(roleSourceLabel(profile.roleSource), color = cs.onSurfaceVariant, fontSize = 10.sp)
                    }
                }
                if (profile.missingRole.isNotBlank()) {
                    Spacer(Modifier.height(6.dp))
                    Text("This profile names \"${profile.missingRole}\", which no longer exists — pick another.",
                        color = cs.error, fontSize = 11.sp)
                }
                Spacer(Modifier.height(10.dp))
                Button(onClick = onChooseRole, shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) {
                    Text(if (profile.roleSource == "chosen") "Change the role" else "Choose a role", fontSize = 13.sp)
                }
            }

            ManageCard("Rename", "Keeps the login and every setting.") {
                OutlinedTextField(newName, { newName = it }, singleLine = true, label = { Text("New name") },
                    modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                Button(onClick = { if (newName.isNotBlank() && newName != profile.name) onRename(newName.trim()) },
                    enabled = newName.isNotBlank() && newName != profile.name, shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) {
                    Text("Rename", fontSize = 13.sp)
                }
            }

            ManageCard("Duplicate",
                "A second identity on the same site: the timezone, the exit and the role come across, "
                    + "the cookies do not. Two profiles sharing one login is how both accounts get locked out.") {
                OutlinedTextField(copyName, { copyName = it }, singleLine = true, label = { Text("Name for the copy") },
                    modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                Button(onClick = { if (copyName.isNotBlank()) onDuplicate(copyName.trim()) },
                    enabled = copyName.isNotBlank(), shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = cs.surfaceVariant, contentColor = cs.onSurface)) {
                    Text("Duplicate", fontSize = 13.sp)
                }
            }

            ManageCard("Sign out", "Removes the saved login and keeps everything else. This is almost always what you want instead of deleting.") {
                Button(onClick = onClearLogin, enabled = profile.hasLogin, shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = cs.surfaceVariant, contentColor = cs.onSurface)) {
                    Text(if (profile.hasLogin) "Clear the login" else "No login saved", fontSize = 13.sp)
                }
            }

            ManageCard("Delete", buildString {
                append("The login, the timezone, the exit and the role, all gone. This cannot be undone.")
                if (profile.automations > 0) {
                    append(" ")
                    append(if (profile.automations == 1) "1 automation runs in this profile and will stop working."
                           else "${profile.automations} automations run in this profile and will stop working.")
                }
            }) {
                if (!confirmDelete) {
                    TextButton(onClick = { confirmDelete = true }) { Text("Delete this profile", color = cs.error, fontSize = 13.sp) }
                } else {
                    Text("Delete \"${profile.name}\" for good?", fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = onDelete, shape = RoundedCornerShape(10.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = cs.error, contentColor = BrandOn)) {
                            Text("Yes, delete it", fontSize = 13.sp)
                        }
                        TextButton(onClick = { confirmDelete = false }) { Text("Keep it", fontSize = 13.sp) }
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun ManageCard(title: String, why: String, body: @Composable () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, cs.outline),
        modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text(title, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(3.dp))
            Text(why, color = cs.onSurfaceVariant, fontSize = 11.sp)
            Spacer(Modifier.height(10.dp))
            body()
        }
    }
}

/**
 * One way of running this role: where, whether a device you own can do it right now, and the method
 * that applies there. A variant nothing can run is shown rather than hidden — "the phone method
 * exists but no phone is connected" is a different situation from "there is no phone method".
 */
@Composable
private fun VariantRow(v: RoleVariant) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.background, shape = RoundedCornerShape(8.dp), border = BorderStroke(1.dp, if (v.ready) Brand else cs.outline),
        modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(7.dp).clip(CircleShape).background(if (v.ready) Brand else cs.onSurfaceVariant))
                Spacer(Modifier.width(8.dp))
                Text(v.where, fontSize = 12.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                Text(if (v.ready) "ready" else "not connected", color = if (v.ready) Brand else cs.onSurfaceVariant, fontSize = 10.sp)
            }
            if (v.method.isNotBlank()) {
                Spacer(Modifier.height(5.dp))
                Text(v.method, fontSize = 11.sp)
            }
            if (v.requireWords.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(v.requireWords, color = cs.onSurfaceVariant, fontSize = 10.sp)
            }
            if (!v.ready && v.runsOn.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(v.runsOn, color = cs.onSurfaceVariant, fontSize = 10.sp)
            }
        }
    }
}

/**
 * READ BEFORE YOU CHOOSE.
 *
 * A role is a page of instructions that will act under your account, and it was chosen from a
 * dropdown of bare names. So: the list on the left of the decision, and the moment a name is
 * pressed, that role in full — what it is for, where it can run, which of your devices can run it,
 * and the whole playbook text. Only then the button that makes it this profile's role.
 *
 * The playbook is shown WHOLE and never summarised: its traps are the valuable part (a caption that
 * overflows a 9:16 frame; "Add heading" doing nothing while a text clip is selected; an export that
 * is not a file until its last Download is pressed). A summary of a playbook is a different document.
 */
@Composable
private fun RolePickerPanel(
    profile: ProfileCard,
    roleNames: List<String>,
    reading: String,
    detail: RoleChoice?,
    onReadRole: (String) -> Unit,
    onChoose: (String) -> Unit,
    onBack: () -> Unit,
    topInset: Modifier,
) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxSize().then(topInset)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack, contentPadding = PaddingValues(horizontal = 4.dp)) { Text("Back") }
            Spacer(Modifier.width(6.dp))
            Column(Modifier.weight(1f)) {
                Text("Role for ${profile.name}", style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Read it, then make it this profile's default", color = cs.onSurfaceVariant, fontSize = 12.sp)
            }
        }

        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            /*
             * WHAT IS SELECTED NOW, AT THE TOP, BEFORE THE LIST.
             *
             * A list of twenty role names with one small line under one of them is not an answer to
             * "which one is selected". Saying it once, plainly, above the list is.
             */
            Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 9.dp)) {
                    Text("NOW USING", color = cs.onSurfaceVariant, fontSize = 10.sp, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.height(2.dp))
                    Text(
                        if (profile.role.isBlank() || profile.role == "general") "No specialist — runs as a generalist" else profile.role,
                        fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                    )
                    Text(roleSourceLabel(profile.roleSource), color = cs.onSurfaceVariant, fontSize = 10.sp)
                }
            }
            Spacer(Modifier.height(10.dp))

            /* Clearing is a real choice and belongs with the others: back to whatever the site
               match says, which for an unconfigured profile is still its specialist. */
            Surface(color = cs.surface, shape = RoundedCornerShape(10.dp),
                border = BorderStroke(1.dp, if (profile.roleSource != "chosen") Brand else cs.outline),
                modifier = Modifier.fillMaxWidth().clickable { onChoose("") }) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                    Text("No default role", fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    Text(
                        if (profile.roleSource != "chosen") "selected — worked out from the site each time"
                        else "work it out from the site each time",
                        color = if (profile.roleSource != "chosen") Brand else cs.onSurfaceVariant, fontSize = 11.sp,
                    )
                }
            }
            Spacer(Modifier.height(10.dp))

            if (roleNames.isEmpty()) {
                Text("No roles loaded yet — pull Refresh on Profiles.", color = cs.onSurfaceVariant, fontSize = 13.sp)
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                roleNames.forEach { name ->
                    val isOpen = reading == name
                    val d = if (isOpen) detail else null
                    val current = profile.role == name
                    Surface(color = if (isOpen) cs.surfaceVariant else cs.surface, shape = RoundedCornerShape(12.dp),
                        border = BorderStroke(if (current) 2.dp else 1.dp, if (isOpen || current) Brand else cs.outline),
                        modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.fillMaxWidth().padding(12.dp)) {
                            Row(Modifier.fillMaxWidth().clickable { onReadRole(name) }, verticalAlignment = Alignment.CenterVertically) {
                                /* A filled dot on the one in use, so which is selected reads at a
                                   glance instead of from a line of small text under a name. */
                                Box(Modifier.size(8.dp).clip(CircleShape).background(if (current) Brand else cs.outline))
                                Spacer(Modifier.width(9.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(name, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    if (current) Text("this profile's role now (${roleSourceLabel(profile.roleSource)})", color = Brand, fontSize = 10.sp)
                                }
                                Text(if (isOpen) "Hide" else "Read", color = Brand, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                            }

                            if (isOpen) {
                                Spacer(Modifier.height(10.dp))
                                if (d == null || d.name != name) {
                                    Text("Loading the role…", color = cs.onSurfaceVariant, fontSize = 12.sp)
                                } else {
                                    if (d.description.isNotBlank()) {
                                        Text(d.description, fontSize = 12.sp)
                                        Spacer(Modifier.height(8.dp))
                                    }
                                    val facts = ArrayList<String>()
                                    if (d.site.isNotBlank()) facts.add(d.site)
                                    if (d.group.isNotBlank()) facts.add(d.group)
                                    facts.add(if (d.builtin) "ships with Ghost Browser" else "yours")
                                    Text(facts.joinToString(" · "), color = cs.onSurfaceVariant, fontSize = 11.sp)

                                    /*
                                     * EVERY WAY IT CAN RUN, AND WHICH ONE CAN RUN TODAY.
                                     *
                                     * A role with a device section says how the work is done on
                                     * each kind of machine, and those methods differ a lot. Showing
                                     * only one requirement sentence hid that the phone was excluded
                                     * by omission rather than by anything anyone decided.
                                     */
                                    if (d.variants.size > 1) {
                                        Spacer(Modifier.height(10.dp))
                                        Text("HOW IT RUNS, PER DEVICE", color = cs.onSurfaceVariant, fontSize = 10.sp, fontWeight = FontWeight.Medium)
                                        Spacer(Modifier.height(6.dp))
                                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                            d.variants.forEach { v -> VariantRow(v) }
                                        }
                                    } else {
                                        if (d.requireWords.isNotBlank()) {
                                            Spacer(Modifier.height(8.dp))
                                            Text(d.requireWords, fontSize = 12.sp)
                                        }
                                        if (d.runsOn.isNotBlank()) {
                                            Spacer(Modifier.height(4.dp))
                                            Text(d.runsOn, color = cs.onSurfaceVariant, fontSize = 11.sp)
                                        }
                                    }
                                    if (d.tools.isNotEmpty()) {
                                        Spacer(Modifier.height(8.dp))
                                        Text("Tools: " + d.tools.joinToString(", "), color = cs.onSurfaceVariant, fontSize = 11.sp)
                                    }
                                    if (d.playbook.isNotBlank()) {
                                        Spacer(Modifier.height(10.dp))
                                        Text("THE PLAYBOOK", color = cs.onSurfaceVariant, fontSize = 10.sp, fontWeight = FontWeight.Medium)
                                        Spacer(Modifier.height(4.dp))
                                        Surface(color = cs.background, shape = RoundedCornerShape(8.dp),
                                            border = BorderStroke(1.dp, cs.outline), modifier = Modifier.fillMaxWidth()) {
                                            Text(d.playbook, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                                                modifier = Modifier.padding(10.dp))
                                        }
                                    }
                                    Spacer(Modifier.height(12.dp))
                                    Button(onClick = { onChoose(name) }, shape = RoundedCornerShape(10.dp),
                                        colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn),
                                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 7.dp)) {
                                        Text(if (profile.role == name) "Keep as default" else "Make this the default", fontSize = 13.sp)
                                    }
                                }
                            }
                        }
                    }
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}
