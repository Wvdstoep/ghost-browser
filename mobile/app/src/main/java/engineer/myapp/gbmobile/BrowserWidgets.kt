package engineer.myapp.gbmobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

const val ACTION_WIDGET_SEARCH = "engineer.myapp.gbmobile.WIDGET_SEARCH"
const val ACTION_WIDGET_WATCHERS = "engineer.myapp.gbmobile.WIDGET_WATCHERS"

private fun widgetIntent(context: Context, action: String, requestCode: Int): PendingIntent =
    PendingIntent.getActivity(
        context, requestCode,
        Intent(context, MainActivity::class.java).setAction(action)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

class SearchWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { id ->
            val views = RemoteViews(context.packageName, R.layout.widget_search)
            views.setOnClickPendingIntent(R.id.widget_search_button, widgetIntent(context, ACTION_WIDGET_SEARCH, 1))
            manager.updateAppWidget(id, views)
        }
    }
}

class WatchersWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val prefs = context.getSharedPreferences("gb_widget", Context.MODE_PRIVATE)
        val count = prefs.getInt("watchers_count", -1)
        val names = prefs.getString("watchers_names", "") ?: ""
        val syncedAt = prefs.getLong("watchers_synced_at", 0L)
        ids.forEach { id ->
            val views = RemoteViews(context.packageName, R.layout.widget_watchers)
            views.setTextViewText(R.id.widget_watchers_count, if (count < 0) "Open to load watchers" else "$count active watcher${if (count == 1) "" else "s"}")
            views.setTextViewText(R.id.widget_watchers_names, names.ifBlank { "Tap to view your watchers" })
            views.setTextViewText(R.id.widget_watchers_updated, if (syncedAt == 0L) "" else "Last synced " + java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(syncedAt)))
            views.setOnClickPendingIntent(R.id.widget_watchers_button, widgetIntent(context, ACTION_WIDGET_WATCHERS, 2))
            manager.updateAppWidget(id, views)
        }
    }

    companion object {
        fun refresh(context: Context, activeNames: List<String>) {
            context.getSharedPreferences("gb_widget", Context.MODE_PRIVATE).edit()
                .putInt("watchers_count", activeNames.size)
                .putString("watchers_names", activeNames.take(2).joinToString(" • ").take(100))
                .putLong("watchers_synced_at", System.currentTimeMillis()).apply()
            val manager = AppWidgetManager.getInstance(context)
            val component = ComponentName(context, WatchersWidgetProvider::class.java)
            val ids = manager.getAppWidgetIds(component)
            if (ids.isNotEmpty()) WatchersWidgetProvider().onUpdate(context, manager, ids)
        }
    }
}
