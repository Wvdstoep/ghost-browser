package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * S9 — ONE new-tab home for phone and desktop: brand wordmark, a search pill, platform shortcuts,
 * and the my-app.engineer /learn feed. Both platforms feed the lists + callbacks.
 */
@Composable
fun HomeScreen(
    platforms: List<PlatformOpt>,
    feed: List<LearnItem>,
    loading: Boolean,
    onSearch: () -> Unit,
    onOpenPlatform: (PlatformOpt) -> Unit,
    onOpenLearn: (String) -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.fillMaxSize().background(cs.background).verticalScroll(rememberScrollState())) {
        Spacer(Modifier.height(44.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(38.dp).clip(RoundedCornerShape(11.dp)).background(Brand), contentAlignment = Alignment.Center) {
                Text("G", color = BrandOn, fontSize = 24.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.width(12.dp))
            Row {
                Text("Ghost", color = cs.onBackground, fontSize = 30.sp, fontWeight = FontWeight.SemiBold)
                Text("Browser", color = Brand, fontSize = 30.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        Spacer(Modifier.height(24.dp))
        Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(26.dp),
            modifier = Modifier.fillMaxWidth(0.9f).align(Alignment.CenterHorizontally).height(52.dp).clickable { onSearch() }) {
            Row(Modifier.padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Search, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(14.dp))
                Text("Search or type a URL", color = cs.onSurfaceVariant, fontSize = 16.sp)
            }
        }
        Spacer(Modifier.height(22.dp))
        if (platforms.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
                platforms.take(12).forEach { p ->
                    Column(Modifier.width(78.dp).clickable { onOpenPlatform(p) }.padding(vertical = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(Modifier.size(50.dp).clip(CircleShape).background(cs.surfaceVariant), contentAlignment = Alignment.Center) {
                            Text(p.label.take(1).uppercase(), color = Brand, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(Modifier.height(6.dp))
                        Text(p.label, color = cs.onSurface, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            Spacer(Modifier.height(20.dp))
        }
        Row(Modifier.fillMaxWidth(0.92f).align(Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
            Text("From my-app.engineer", color = cs.onSurfaceVariant, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (loading) CircularProgressIndicator(Modifier.size(16.dp), color = Brand, strokeWidth = 2.dp)
            else IconButton(onClick = onRefresh) { Icon(Icons.Default.Refresh, "Refresh", tint = cs.onSurfaceVariant, modifier = Modifier.size(18.dp)) }
        }
        Spacer(Modifier.height(6.dp))
        if (feed.isEmpty() && !loading) Text("No articles yet.", color = cs.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp))
        else Column(Modifier.fillMaxWidth(0.92f).align(Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            feed.forEach { item -> LearnCard(item) { onOpenLearn(item.slug) } }
        }
        Spacer(Modifier.height(28.dp))
    }
}

@Composable
private fun LearnCard(item: LearnItem, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, cs.outline),
        modifier = Modifier.fillMaxWidth().clickable { onClick() }) {
        Column(Modifier.padding(16.dp)) {
            Text(item.title, color = cs.onSurface, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, lineHeight = 21.sp)
            if (item.description.isNotBlank()) { Spacer(Modifier.height(6.dp)); Text(item.description, color = cs.onSurfaceVariant, fontSize = 13.sp, maxLines = 3, overflow = TextOverflow.Ellipsis, lineHeight = 18.sp) }
            Spacer(Modifier.height(8.dp)); Text("my-app.engineer · Learn", color = cs.onSurfaceVariant, fontSize = 11.sp)
        }
    }
}
