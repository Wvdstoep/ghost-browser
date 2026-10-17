package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Verified
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The shared app chrome — one Chrome-tight scaffold (top bar + bottom nav) rendered identically on
 * phone and desktop. The browser surface and the per-screen bodies are injected by each platform
 * (Android hosts a WebView, Desktop will host JCEF in S8), so this file has no platform code.
 */
@Composable
fun GbScaffold(
    host: String,
    tabCount: Int,
    selected: String,               // browser | agent | flows | settings
    onFocusUrl: () -> Unit,
    onOpenSwitcher: () -> Unit,
    onOpenMenu: () -> Unit,
    onNav: (String) -> Unit,
    showTopBar: Boolean = true,     // desktop supplies its own address bar, so it hides this one
    approvalsBadge: Int = 0,        // pending approvals — shown as a badge on the Approvals nav item
    /*
     * 0 = the chrome is slid off the screen, 1 = fully shown. Driven by the page's own scroll so the
     * content gets the space while it is being read. Only a page may collapse it: sliding the nav
     * off Profiles or the chat would leave no way out of the screen, so every other surface passes
     * 1 and the bars stay put.
     */
    chromeFraction: Float = 1f,
    reconUi: ReconUi? = null,
    onOpenRecon: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxSize().background(cs.background)) {
        if (showTopBar && (selected == "browser" || selected == "flows")) {
          CollapsingSlot(if (selected == "browser") chromeFraction else 1f, fromTop = true) {
            Surface(color = cs.surface, contentColor = cs.onSurface) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                    Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(22.dp),
                        modifier = Modifier.weight(1f).height(44.dp).clickable { onFocusUrl() }) {
                        Row(Modifier.padding(start = 14.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.Lock, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(15.dp))
                            Spacer(Modifier.width(10.dp))
                            Text(host.ifBlank { "Search or type a URL" },
                                color = if (host.isBlank()) cs.onSurfaceVariant else cs.onSurface,
                                fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            if (reconUi != null && onOpenRecon != null) {
                                ReconAddressBarIcon(ui = reconUi, currentUrl = host, onClick = onOpenRecon)
                            }
                        }
                    }
                    Spacer(Modifier.width(6.dp))
                    Box(Modifier.size(30.dp).clip(RoundedCornerShape(8.dp)).border(2.dp, cs.onSurface, RoundedCornerShape(8.dp)).clickable { onOpenSwitcher() },
                        contentAlignment = Alignment.Center) { Text(if (tabCount > 99) "99" else "$tabCount", color = cs.onSurface, fontSize = 12.sp, fontWeight = FontWeight.SemiBold) }
                    IconButton(onClick = onOpenMenu) { Icon(Icons.Default.MoreVert, "Menu", tint = cs.onSurface) }
                }
            }
          }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
        /*
         * WHAT THE RING IS DOING, ON EVERY SURFACE.
         *
         * Above the nav rather than over the page: it is a status line about the whole app, not
         * about the page being looked at, and it must not cover the thing being read. It takes no
         * space at all when nothing is or was running.
         */
        RingWorkStrip()
        CollapsingSlot(chromeFraction, fromTop = false) {
        NavigationBar(containerColor = cs.surface, tonalElevation = 0.dp) {
            navItem(GbIcons.browser, "Browser", selected == "browser") { onNav("browser") }
            navItem(GbIcons.agent, "Agent", selected == "agent") { onNav("agent") }
            navItem(GbIcons.flows, "Flows", selected == "flows") { onNav("flows") }
            /*
             * PROFILES IS A DESTINATION, NOT A PREFERENCE.
             *
             * It sat three taps inside Settings as a row of chips plus one read-only line naming a
             * role — and that role was kept in the phone's own preferences, so the cluster and the
             * desktop never knew about it. A logged-in identity that automations act through belongs
             * beside the browser, not inside a settings list.
             */
            navItem(GbIcons.profiles, "Profiles", selected == "profiles") { onNav("profiles") }
            navItem(Icons.Default.Verified, "Approvals", selected == "approvals", badge = approvalsBadge) { onNav("approvals") }
            navItem(Icons.Default.Settings, "Settings", selected == "settings") { onNav("settings") }
        }
        }
    }
}

@Composable
private fun RowScope.navItem(icon: ImageVector, label: String, sel: Boolean, badge: Int = 0, onClick: () -> Unit) {
    NavigationBarItem(
        selected = sel, onClick = onClick,
        icon = {
            if (badge > 0) BadgedBox(badge = { Badge(containerColor = Brand, contentColor = BrandOn) { Text("$badge") } }) { Icon(icon, label) }
            else Icon(icon, label)
        },
        label = { Text(label, fontSize = 11.sp) },
        colors = NavigationBarItemDefaults.colors(
            selectedIconColor = BrandOn, indicatorColor = Brand, selectedTextColor = Brand,
            unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
            unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
        ),
    )
}


@Composable
fun CollapsingSlot(
    fraction: Float = 1f,
    fromTop: Boolean = true,
    content: @Composable () -> Unit
) {
    if (fraction > 0.05f) {
        Box(modifier = Modifier.fillMaxWidth()) {
            content()
        }
    }
}

@Composable
fun RingWorkStrip() {
}

@Composable
fun rememberChromeFraction(hidden: Boolean): Float {
    return if (hidden) 0f else 1f
}

object RingWork {
    val busy = androidx.compose.runtime.mutableStateOf(false)
}

object RingWatch {
    fun apply(body: String?, hostName: String) {}
}
