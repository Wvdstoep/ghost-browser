package engineer.myapp.gb.shared

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * THIS DEVICE IS WORKING FOR YOU — on the device's own screen.
 *
 * The ring can hand a whole job to this machine and then drive its browser for minutes. Until now
 * the app said nothing while that happened: the window moved on its own, clicked things, uploaded a
 * file, and there was no line anywhere saying what or why. On someone's own computer that is not a
 * missing feature, it is alarming.
 *
 * Collapsed it is one line — what it is doing right now. Tapped it opens the account of everything
 * it has done, which is the same set of lines the assistant reads over the ring, so what the owner
 * sees here and what the chat says cannot disagree.
 */
@Composable
fun RingWorkStrip(modifier: Modifier = Modifier) {
    val busy by RingWork.busy
    val lines by RingWork.lines
    val goal by RingWork.goal
    var open by remember { mutableStateOf(false) }

    /* Nothing to say and nothing has been said: take no space at all. */
    if (!busy && lines.isEmpty()) return

    val cs = MaterialTheme.colorScheme
    Surface(
        color = cs.surface, contentColor = cs.onSurface,
        border = BorderStroke(1.dp, if (busy) Brand else cs.outline),
        shape = RoundedCornerShape(10.dp),
        modifier = modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp).clickable { open = !open },
    ) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(if (busy) Brand else cs.onSurfaceVariant))
                Spacer(Modifier.width(9.dp))
                Column(Modifier.weight(1f)) {
                    /* WHERE it is running, named — one UI across two devices means the surface you
                       asked on must say which machine is doing it, or "working" is ambiguous. */
                    val where by RingWork.onDevice
                    Text(
                        when {
                            busy && where.isNotBlank() -> "Working on $where"
                            busy -> "Working on this device"
                            where.isNotBlank() -> "Finished on $where"
                            else -> "Finished working for you"
                        },
                        fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        lines.lastOrNull() ?: "starting…",
                        color = cs.onSurfaceVariant, fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(if (open) "Hide" else "${lines.size}", color = Brand, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
            if (open) {
                if (goal.isNotBlank()) {
                    Spacer(Modifier.height(8.dp))
                    Text("THE JOB IT WAS GIVEN", color = cs.onSurfaceVariant, fontSize = 9.sp, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.height(2.dp))
                    /* Capped: a handed-over goal carries the role's whole playbook in front of it,
                       which is pages. The first part is the part that identifies the job. */
                    Text(goal.take(400), fontSize = 11.sp, maxLines = 6, overflow = TextOverflow.Ellipsis)
                }
                Spacer(Modifier.height(8.dp))
                Text("WHAT IT DID", color = cs.onSurfaceVariant, fontSize = 9.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(2.dp))
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    /* Newest first once it is opened: the last thing it did is the thing being looked for. */
                    lines.asReversed().forEach { l ->
                        Text(l, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                            color = cs.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}
