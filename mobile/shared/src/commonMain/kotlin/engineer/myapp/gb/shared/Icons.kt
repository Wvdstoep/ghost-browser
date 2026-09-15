package engineer.myapp.gb.shared

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Public
import androidx.compose.ui.graphics.vector.ImageVector

/** Shared nav icons (from material-icons-extended) so the scaffold reads the same on both platforms. */
object GbIcons {
    val browser: ImageVector get() = Icons.Default.Public
    val agent: ImageVector get() = Icons.Default.Bolt
    val flows: ImageVector get() = Icons.Default.AccountTree
}
