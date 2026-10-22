package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * API TOKENS — the owner mints Bearer tokens to hand to a script or another machine, copies each ONCE,
 * and revokes it when it is done. Ghost Browser's own setting, like the AI model: the tokens live on
 * the GB server (GET/POST /v1/tokens, DELETE /v1/tokens/:id), so the same list shows on web, phone and
 * desktop. Only the signed-in owner can manage them; a minted token can never mint another.
 */
data class ApiTokenRow(val tokenId: String, val name: String, val createdAt: Long, val preview: String)

class ApiTokensUi {
    val tokens = mutableStateOf<List<ApiTokenRow>>(emptyList())
    val minted = mutableStateOf<String?>(null)   // the full secret of a just-created token, shown ONCE
    val busy = mutableStateOf(false)
    val note = mutableStateOf("")
    val loading = mutableStateOf(false)
}

class ApiTokensActions(
    val onLoad: () -> Unit,
    val onGenerate: (name: String) -> Unit,
    val onRevoke: (tokenId: String) -> Unit,
    val onClearMinted: () -> Unit,
)

@Composable
fun ApiTokensSheet(ui: ApiTokensUi, act: ApiTokensActions, connected: Boolean, onConnect: () -> Unit, onClose: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    var name by remember { mutableStateOf("") }
    LaunchedEffect(connected) { if (connected) act.onLoad() }
    Box(Modifier.fillMaxSize().background(Color(0x99000000)).clickable { onClose() }, contentAlignment = Alignment.BottomCenter) {
        Surface(color = cs.surface, contentColor = cs.onSurface, shape = RoundedCornerShape(20.dp, 20.dp, 0.dp, 0.dp), tonalElevation = 6.dp,
            modifier = Modifier.fillMaxWidth().widthIn(max = 560.dp).clickable(enabled = false) {}) {
            Column(Modifier.padding(horizontal = 20.dp, vertical = 14.dp).verticalScroll(rememberScrollState())) {
                Box(Modifier.align(Alignment.CenterHorizontally).width(36.dp).height(4.dp).clip(CircleShape).background(cs.outline))
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("API tokens", style = MaterialTheme.typography.titleLarge)
                        Text("Bearer keys for scripts and other machines to drive your Ghost Browser.", color = cs.onSurfaceVariant, fontSize = 12.sp)
                    }
                    IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close", tint = cs.onSurfaceVariant) }
                }
                Spacer(Modifier.height(14.dp))
                if (!connected) {
                    Text("Connect this device to your Ghost Browser first — tokens live there, once, for every device.", color = cs.onSurfaceVariant, fontSize = 13.sp, lineHeight = 18.sp)
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = onConnect, shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Connect") }
                    Spacer(Modifier.height(8.dp)); return@Column
                }

                // The freshly minted secret — shown exactly once. Selectable so it can be copied off any platform.
                ui.minted.value?.let { secret ->
                    Surface(color = Brand.copy(alpha = 0.12f), shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, Brand), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp)) {
                            Text("COPY THIS NOW — it is shown only once", color = Brand, fontSize = 10.sp, letterSpacing = 1.sp, fontWeight = FontWeight.SemiBold)
                            Spacer(Modifier.height(6.dp))
                            SelectionContainer { Text(secret, fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 18.sp) }
                            Spacer(Modifier.height(8.dp))
                            TextButton(onClick = { act.onClearMinted() }, contentPadding = PaddingValues(0.dp)) { Text("Done, hide it", fontSize = 12.sp) }
                        }
                    }
                    Spacer(Modifier.height(16.dp))
                }

                // Mint a new one.
                Text("Generate a token", fontWeight = FontWeight.Medium, fontSize = 14.sp)
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(name, { name = it }, label = { Text("Name (e.g. CI runner)") }, singleLine = true, modifier = Modifier.weight(1f), shape = RoundedCornerShape(10.dp))
                    Button(onClick = { act.onGenerate(name); name = "" }, enabled = !ui.busy.value, shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) {
                        Icon(Icons.Default.Add, null, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)); Text("Generate")
                    }
                }
                if (ui.note.value.isNotBlank()) { Spacer(Modifier.height(8.dp)); Text(ui.note.value, color = if (ui.note.value.startsWith("✓")) Brand else cs.onSurfaceVariant, fontSize = 12.sp) }
                Spacer(Modifier.height(18.dp))

                // The tokens that exist (masked — the secret is never shown again).
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Your tokens", Modifier.weight(1f), fontWeight = FontWeight.Medium, fontSize = 14.sp)
                    if (ui.loading.value) CircularProgressIndicator(Modifier.size(15.dp), color = Brand, strokeWidth = 2.dp)
                    else TextButton(onClick = { act.onLoad() }, contentPadding = PaddingValues(horizontal = 8.dp)) { Text("Refresh", fontSize = 12.sp) }
                }
                Spacer(Modifier.height(6.dp))
                if (ui.tokens.value.isEmpty()) {
                    Text("No tokens yet. Generate one above and hand it to whatever needs API access.", color = cs.onSurfaceVariant, fontSize = 12.sp)
                } else {
                    Column(Modifier.fillMaxWidth().border(BorderStroke(1.dp, cs.outline.copy(alpha = 0.5f)), RoundedCornerShape(10.dp))) {
                        ui.tokens.value.forEach { t ->
                            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(t.name.ifBlank { t.tokenId }, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(t.preview, color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                                }
                                IconButton(onClick = { act.onRevoke(t.tokenId) }) { Icon(Icons.Default.Delete, "Revoke", tint = cs.error, modifier = Modifier.size(18.dp)) }
                            }
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
            }
        }
    }
}
