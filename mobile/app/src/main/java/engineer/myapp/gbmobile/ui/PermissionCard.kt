package engineer.myapp.gbmobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * THE TWO ANDROID PERMISSIONS, ASKED IN THE APP — NEVER BY JUMPING INTO SETTINGS.
 *
 * Up to 0.92 the app opened "Display over other apps" and the battery screen by itself on every start
 * until both were allowed. On Samsung the overlay screen is the full list of apps, so to a new user the
 * app icon "opened Android settings" (Saskia, 2026-11-03). Now this card explains why, and Settings opens
 * only when the person taps a button. Each line ticks itself off when Android reports it as allowed.
 */
data class PermissionAsk(
    val needBattery: Boolean,
    val needOverlay: Boolean,
    val dutch: Boolean,
    val onBattery: () -> Unit,
    val onOverlay: () -> Unit,
    val onLater: () -> Unit,
)

@Composable
fun PermissionCard(ask: PermissionAsk, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    val nl = ask.dutch
    Surface(
        modifier = modifier.fillMaxWidth().padding(12.dp).navigationBarsPadding(),
        shape = RoundedCornerShape(20.dp), color = cs.surfaceVariant, tonalElevation = 6.dp, shadowElevation = 8.dp,
    ) {
        Column(Modifier.padding(18.dp)) {
            Text(if (nl) "Laat je telefoon meewerken" else "Let your phone help out", color = cs.onSurface, fontSize = 18.sp)
            Spacer(Modifier.height(6.dp))
            Text(
                if (nl) "Zodat taken ook doorlopen als je de app niet open hebt. Twee keer toestaan, daarna vragen we het niet meer."
                else "So tasks keep running when the app is not open. Allow two things once and we won't ask again.",
                color = cs.onSurfaceVariant, fontSize = 14.sp,
            )
            Spacer(Modifier.height(14.dp))
            Step(
                done = !ask.needOverlay,
                title = if (nl) "1. Weergeven boven andere apps" else "1. Display over other apps",
                hint = if (nl) "Je ziet een lijst met apps: zoek GB Mobile, zet de schakelaar aan en ga terug."
                else "You see a list of apps: find GB Mobile, switch it on and go back.",
                button = if (nl) "Openen" else "Open",
                onClick = ask.onOverlay,
            )
            Spacer(Modifier.height(10.dp))
            Step(
                done = !ask.needBattery,
                title = if (nl) "2. Batterij niet beperken" else "2. Don't restrict battery",
                hint = if (nl) "Er komt een vraag van Android: kies Toestaan." else "Android asks a question: choose Allow.",
                button = if (nl) "Openen" else "Open",
                onClick = ask.onBattery,
            )
            Spacer(Modifier.height(6.dp))
            TextButton(onClick = ask.onLater, modifier = Modifier.align(Alignment.End)) { Text(if (nl) "Later" else "Later") }
        }
    }
}

@Composable
private fun Step(done: Boolean, title: String, hint: String, button: String, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, color = cs.onSurface, fontSize = 15.sp)
            if (!done) Text(hint, color = cs.onSurfaceVariant, fontSize = 13.sp)
        }
        Spacer(Modifier.width(10.dp))
        if (done) Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = cs.primary)
        else FilledTonalButton(onClick = onClick) { Text(button) }
    }
}
