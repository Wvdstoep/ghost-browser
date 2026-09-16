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
    content: @Composable () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxSize().background(cs.background)) {
        if (showTopBar && (selected == "browser" || selected == "flows")) {
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
                        }
                    }
                    Spacer(Modifier.width(6.dp))
                    Box(Modifier.size(30.dp).clip(RoundedCornerShape(8.dp)).border(2.dp, cs.onSurface, RoundedCornerShape(8.dp)).clickable { onOpenSwitcher() },
                        contentAlignment = Alignment.Center) { Text(if (tabCount > 99) "99" else "$tabCount", color = cs.onSurface, fontSize = 12.sp, fontWeight = FontWeight.SemiBold) }
                    IconButton(onClick = onOpenMenu) { Icon(Icons.Default.MoreVert, "Menu", tint = cs.onSurface) }
                }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
        NavigationBar(containerColor = cs.surface, tonalElevation = 0.dp) {
            navItem(GbIcons.browser, "Browser", selected == "browser") { onNav("browser") }
            navItem(GbIcons.agent, "Agent", selected == "agent") { onNav("agent") }
            navItem(GbIcons.flows, "Flows", selected == "flows") { onNav("flows") }
            navItem(Icons.Default.Verified, "Approvals", selected == "approvals", badge = approvalsBadge) { onNav("approvals") }
            navItem(Icons.Default.Settings, "Settings", selected == "settings") { onNav("settings") }
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
