package engineer.myapp.gbmobile

import engineer.myapp.gb.shared.*
import org.json.JSONArray
import org.json.JSONObject

object ReconJson {
    fun parseFinding(o: JSONObject): ReconFinding {
        return ReconFinding(
            id = o.optString("id", o.optString("title")),
            title = o.optString("title", "Finding"),
            severity = o.optString("severity", "MEDIUM"),
            cwe = o.optString("cwe", ""),
            owasp = o.optString("owasp", ""),
            impact = o.optString("impact", ""),
            rootCause = o.optString("rootCause", ""),
            threatScenario = o.optString("threatScenario", ""),
            traefik = o.optString("traefik", ""),
            nginx = o.optString("nginx", ""),
            express = o.optString("express", ""),
            dns = o.optString("dns", ""),
            secondaryDefense = o.optString("secondaryDefense", "")
        )
    }

    fun parseReport(json: String): ReconReport? {
        return try {
            val o = JSONObject(json)
            if (o.has("error") && !o.has("findings")) return null
            val findingsArr = o.optJSONArray("findings") ?: JSONArray()
            val findings = ArrayList<ReconFinding>()
            for (i in 0 until findingsArr.length()) {
                val fObj = findingsArr.optJSONObject(i) ?: continue
                findings.add(parseFinding(fObj))
            }
            val wafObj = o.optJSONObject("waf")
            val waf = ReconWafInfo(
                detected = wafObj?.optBoolean("detected") ?: false,
                name = wafObj?.optString("name", "None") ?: "None"
            )
            ReconReport(
                target = o.optString("target", ""),
                url = o.optString("url", ""),
                timestamp = o.optString("timestamp", ""),
                score = o.optInt("score", 100),
                grade = o.optString("grade", "A"),
                findingsCount = o.optInt("findingsCount", findings.size),
                findings = findings,
                waf = waf,
                rawJson = json
            )
        } catch (e: Exception) {
            null
        }
    }
}
