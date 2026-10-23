package engineer.myapp.gbmobile

import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.RemoteViews
import android.appwidget.AppWidgetManager
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RangeScanWidgetLayoutTest {
    @Test fun remoteWidgetLayoutContainsTheLiveProgressAndControls() {
        val context = RuntimeEnvironment.getApplication()
        val root = RemoteViews(context.packageName, R.layout.widget_range_scan).apply(context, FrameLayout(context))
        assertNotNull(root.findViewById<ProgressBar>(R.id.scan_widget_bar))
        assertNotNull(root.findViewById<android.widget.TextView>(R.id.scan_widget_start))
        assertNotNull(root.findViewById<android.widget.TextView>(R.id.scan_widget_pause))
        assertNotNull(root.findViewById<android.widget.TextView>(R.id.scan_widget_stop))
        assertNotNull(root.findViewById<android.widget.TextView>(R.id.scan_widget_setup))
    }

    @Test fun providerCanRenderItsIdleState() {
        val context = RuntimeEnvironment.getApplication()
        context.deleteDatabase("gb_range_scan.db")
        val manager = AppWidgetManager.getInstance(context)
        val shadow = Shadows.shadowOf(manager)
        val id = shadow.createWidget(RangeScanWidgetProvider::class.java, R.layout.widget_range_scan)
        RangeScanWidgetProvider().onUpdate(context, manager, intArrayOf(id))
        val widget = shadow.getViewFor(id)
        assertNotNull(widget.findViewById<android.widget.TextView>(R.id.scan_widget_progress))
    }
}
