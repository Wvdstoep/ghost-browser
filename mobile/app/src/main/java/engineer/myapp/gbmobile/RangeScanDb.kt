package engineer.myapp.gbmobile

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject

data class RangeScanJob(
    val runId: Long, val cidr: String, val ports: List<Int>, val attemptsPerSecond: Int,
    val nextIndex: Int, val total: Int, val hits: Int, val status: String, val updatedAt: Long,
    val webFollowUp: Boolean,
)

/** A single resumable job and an append-only result log. Each host checkpoint is atomic. */
class RangeScanDb(context: Context) : SQLiteOpenHelper(context, "gb_range_scan.db", null, 2) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE job (slot INTEGER PRIMARY KEY CHECK(slot=1), run_id INTEGER NOT NULL, cidr TEXT NOT NULL, ports TEXT NOT NULL, rate INTEGER NOT NULL, next_index INTEGER NOT NULL, total INTEGER NOT NULL, hits INTEGER NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, web_follow_up INTEGER NOT NULL DEFAULT 0)")
        db.execSQL("CREATE TABLE result (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, cidr TEXT NOT NULL, host TEXT NOT NULL, ports TEXT NOT NULL, recorded_at INTEGER NOT NULL, web_services TEXT NOT NULL DEFAULT '[]')")
        db.execSQL("CREATE INDEX result_time ON result(recorded_at DESC)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE job ADD COLUMN web_follow_up INTEGER NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE result ADD COLUMN web_services TEXT NOT NULL DEFAULT '[]'")
        }
    }

    @Synchronized fun begin(plan: RangePlan, ports: List<Int>, rate: Int, webFollowUp: Boolean = false): RangeScanJob {
        val now = System.currentTimeMillis()
        val values = ContentValues().apply {
            put("slot", 1); put("run_id", now); put("cidr", plan.cidr)
            put("ports", ports.joinToString(",")); put("rate", rate)
            put("next_index", 0); put("total", plan.hosts.size); put("hits", 0)
            put("status", "starting"); put("updated_at", now); put("web_follow_up", if (webFollowUp) 1 else 0)
        }
        writableDatabase.insertWithOnConflict("job", null, values, SQLiteDatabase.CONFLICT_REPLACE)
        return requireNotNull(read())
    }

    @Synchronized fun read(): RangeScanJob? = readableDatabase.rawQuery(
        "SELECT run_id,cidr,ports,rate,next_index,total,hits,status,updated_at,web_follow_up FROM job WHERE slot=1", null
    ).use { cursor ->
        if (!cursor.moveToFirst()) null else RangeScanJob(
            cursor.getLong(0), cursor.getString(1), cursor.getString(2).split(',').mapNotNull { it.toIntOrNull() },
            cursor.getInt(3), cursor.getInt(4), cursor.getInt(5), cursor.getInt(6), cursor.getString(7), cursor.getLong(8), cursor.getInt(9) != 0,
        )
    }

    @Synchronized fun status(runId: Long, value: String) {
        val values = ContentValues().apply { put("status", value); put("updated_at", System.currentTimeMillis()) }
        writableDatabase.update("job", values, "slot=1 AND run_id=?", arrayOf(runId.toString()))
    }

    @Synchronized fun checkpoint(job: RangeScanJob, host: String, openPorts: List<Int>, nextIndex: Int,
                                 webServices: List<WebServiceProbe.Finding> = emptyList()) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val values = ContentValues().apply {
                put("next_index", nextIndex); put("hits", job.hits + if (openPorts.isNotEmpty()) 1 else 0)
                put("updated_at", System.currentTimeMillis())
            }
            db.update("job", values, "slot=1 AND run_id=?", arrayOf(job.runId.toString()))
            if (openPorts.isNotEmpty()) db.insert("result", null, ContentValues().apply {
                put("run_id", job.runId); put("cidr", job.cidr); put("host", host)
                put("ports", openPorts.joinToString(",")); put("recorded_at", System.currentTimeMillis())
                put("web_services", JSONArray().also { arr -> webServices.forEach { item ->
                    arr.put(JSONObject().put("port", item.port).put("scheme", item.scheme).put("status", item.status)
                        .put("title", item.title).put("server", item.server).put("poweredBy", item.poweredBy))
                } }.toString())
            })
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    @Synchronized fun results(limit: Int = 1000): JSONArray {
        val output = JSONArray()
        readableDatabase.rawQuery(
            "SELECT cidr,host,ports,recorded_at,web_services FROM result ORDER BY recorded_at DESC,id DESC LIMIT ?",
            arrayOf(limit.coerceIn(1, 5000).toString())
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val cidr = cursor.getString(0); val host = cursor.getString(1)
                val ports = cursor.getString(2).split(',').mapNotNull { it.toIntOrNull() }
                val web = JSONArray(cursor.getString(4))
                val firstWeb = (0 until web.length()).mapNotNull { web.optJSONObject(it) }.firstOrNull()
                val webUrl = firstWeb?.let { "${it.optString("scheme")}://$host:${it.optInt("port")}" } ?: "http://$host"
                val evidence = JSONArray().also { arr -> ports.forEach { port ->
                    val identified = (0 until web.length()).mapNotNull { web.optJSONObject(it) }.firstOrNull { it.optInt("port") == port }
                    val label = if (identified == null) "TCP connection accepted" else
                        WebServiceProbe.Finding(port, identified.optString("scheme"), identified.optInt("status"),
                            identified.optString("title"), identified.optString("server"), identified.optString("poweredBy")).label()
                    arr.put(JSONObject().put("port", port).put("service", label))
                } }
                val fields = JSONObject().put("recordedAt", cursor.getLong(3))
                    .put("status", "completed on this phone").put("scope", cidr)
                    .put("source", "On-device range scan").put("openPorts", ports.joinToString(", "))
                    .put("videoCandidate", ports.any { it == 554 || it == 8554 }).put("webServices", web)
                output.put(JSONObject().put("title", "Open TCP ports: $host").put("url", webUrl)
                    .put("kind", "security").put("fields", fields).put("ports", evidence))
            }
        }
        return output
    }
}
