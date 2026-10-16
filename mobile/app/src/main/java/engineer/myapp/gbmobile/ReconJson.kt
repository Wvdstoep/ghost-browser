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

    fun parseCve(o: JSONObject): CveVulnerability {
        return CveVulnerability(
            cveId = o.optString("cveId", o.optString("id", "CVE-2026-UNKNOWN")),
            component = o.optString("component", "target-service"),
            version = o.optString("version", ""),
            severity = o.optString("severity", "HIGH"),
            cvss = o.optDouble("cvss", 7.5),
            title = o.optString("title", ""),
            description = o.optString("description", ""),
            source = o.optString("source", "NVD National Vulnerability Database"),
            fixAvailable = o.optString("fixAvailable", ""),
            advisoryUrl = o.optString("advisoryUrl", "")
        )
    }

    fun parseJsLeak(o: JSONObject): JsLeakItem {
        return JsLeakItem(
            type = o.optString("type", "SECRET"),
            location = o.optString("location", "inline"),
            snippet = o.optString("snippet", ""),
            risk = o.optString("risk", "HIGH"),
            description = o.optString("description", "")
        )
    }

    fun parseDns(o: JSONObject): DnsRecordItem {
        return DnsRecordItem(
            type = o.optString("type", "A"),
            host = o.optString("host", ""),
            value = o.optString("value", ""),
            status = o.optString("status", "OK"),
            note = o.optString("note", "")
        )
    }

    fun parsePort(o: JSONObject): PortProbeResult {
        val st = o.optString("state", o.optString("status", "OPEN")).uppercase()
        return PortProbeResult(
            port = o.optInt("port", 80),
            service = o.optString("service", "HTTP"),
            state = if (st == "OPEN") "OPEN" else st,
            sensitive = o.optBoolean("sensitive", false)
        )
    }

    fun parseEndpoint(o: JSONObject): CrawlEndpoint {
        return CrawlEndpoint(
            url = o.optString("url", "/"),
            method = o.optString("method", "GET"),
            status = o.optInt("status", 200),
            isAuthRequired = o.optBoolean("isAuthRequired", false),
            contentType = o.optString("contentType", "text/html")
        )
    }

    fun parseSessionProbe(o: JSONObject?): SessionInvalidationProbeResult {
        if (o == null) return SessionInvalidationProbeResult()
        return SessionInvalidationProbeResult(
            tested = o.optBoolean("tested", true),
            vulnerable = o.optBoolean("vulnerable", true),
            details = o.optString("details", ""),
            attackPath = o.optString("attackPath", ""),
            remediationPattern = o.optString("remediationPattern", "")
        )
    }

    fun parseReport(json: String): ReconReport? {
        return try {
            val o = JSONObject(json)
            if (o.has("error") && !o.has("findings") && !o.has("score")) return null

            val targetHost = o.optString("target", "")

            val findings = ArrayList<ReconFinding>()
            val findingsArr = o.optJSONArray("findings")
            if (findingsArr != null) {
                for (i in 0 until findingsArr.length()) {
                    val fObj = findingsArr.optJSONObject(i) ?: continue
                    findings.add(parseFinding(fObj))
                }
            }

            val cves = ArrayList<CveVulnerability>()
            val cvesArr = o.optJSONArray("cves")
            if (cvesArr != null) {
                for (i in 0 until cvesArr.length()) {
                    val cObj = cvesArr.optJSONObject(i) ?: continue
                    cves.add(parseCve(cObj))
                }
            }

            val jsLeaks = ArrayList<JsLeakItem>()
            val jsArr = o.optJSONArray("jsLeaks")
            if (jsArr != null) {
                for (i in 0 until jsArr.length()) {
                    val jObj = jsArr.optJSONObject(i) ?: continue
                    jsLeaks.add(parseJsLeak(jObj))
                }
            }

            val dnsRecords = ArrayList<DnsRecordItem>()
            val dnsArr = o.optJSONArray("dnsRecords")
            if (dnsArr != null) {
                for (i in 0 until dnsArr.length()) {
                    val dObj = dnsArr.optJSONObject(i) ?: continue
                    dnsRecords.add(parseDns(dObj))
                }
            } else {
                val dObj = o.optJSONObject("dns")
                if (dObj != null) {
                    val aArr = dObj.optJSONArray("a")
                    if (aArr != null && aArr.length() > 0) {
                        val ipList = (0 until aArr.length()).map { aArr.optString(it) }.joinToString(", ")
                        dnsRecords.add(DnsRecordItem("A", targetHost, ipList, "OK", "IPv4 address routing configured."))
                    }
                    val aaaaArr = dObj.optJSONArray("aaaa")
                    if (aaaaArr != null && aaaaArr.length() > 0) {
                        val ipv6List = (0 until aaaaArr.length()).map { aaaaArr.optString(it) }.joinToString(", ")
                        dnsRecords.add(DnsRecordItem("AAAA", targetHost, ipv6List, "OK", "IPv6 routing active."))
                    }
                    val mxArr = dObj.optJSONArray("mx")
                    if (mxArr != null && mxArr.length() > 0) {
                        val mxList = (0 until mxArr.length()).map { mxArr.optJSONObject(it)?.optString("exchange") ?: mxArr.optString(it) }.joinToString(", ")
                        dnsRecords.add(DnsRecordItem("MX", targetHost, mxList, "OK", "Mail exchanger records published."))
                    }
                    val dmarc = dObj.optString("dmarc")
                    if (dmarc.isNotBlank()) {
                        dnsRecords.add(DnsRecordItem("DMARC", "_dmarc." + targetHost, dmarc, "OK", "Email origin authentication policy configured."))
                    }
                }
            }

            val openPorts = ArrayList<PortProbeResult>()
            val portsArr = o.optJSONArray("openPorts") ?: o.optJSONObject("network")?.optJSONArray("openPorts")
            if (portsArr != null) {
                for (i in 0 until portsArr.length()) {
                    val pObj = portsArr.optJSONObject(i) ?: continue
                    openPorts.add(parsePort(pObj))
                }
            }

            val crawlEndpoints = ArrayList<CrawlEndpoint>()
            val crawlArr = o.optJSONArray("crawlEndpoints")
            if (crawlArr != null) {
                for (i in 0 until crawlArr.length()) {
                    val epObj = crawlArr.optJSONObject(i) ?: continue
                    crawlEndpoints.add(parseEndpoint(epObj))
                }
            }

            val wafObj = o.optJSONObject("waf")
            val waf = if (wafObj != null) {
                ReconWafInfo(
                    detected = wafObj.optBoolean("detected", false),
                    name = wafObj.optString("name", "None")
                )
            } else {
                ReconWafInfo(false, "None")
            }

            val sessionProbeObj = o.optJSONObject("sessionProbe")
            val sessionProbe = parseSessionProbe(sessionProbeObj)

            ReconReport(
                target = targetHost,
                url = o.optString("url", ""),
                timestamp = o.optString("timestamp", ""),
                score = o.optInt("score", 85),
                grade = o.optString("grade", "B"),
                findingsCount = if (o.has("findingsCount")) o.optInt("findingsCount") else findings.size,
                findings = findings,
                waf = waf,
                cves = cves,
                jsLeaks = jsLeaks,
                dnsRecords = dnsRecords,
                openPorts = openPorts,
                crawlEndpoints = crawlEndpoints,
                sessionProbe = sessionProbe,
                rawJson = json
            )
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }
}
