package engineer.myapp.gbmobile

/** A readable, searchable on-phone history of scans against targets the user selected. */
object LocalReconResultPage {
    data class Port(val number: Int, val service: String)
    data class Finding(val severity: String, val title: String, val impact: String)
    data class Run(
        val target: String, val time: String, val status: String, val grade: String,
        val score: Int, val findingCount: Int, val videoCandidate: Boolean,
        val ports: List<Port>, val findings: List<Finding>, val error: String = "", val scope: String = "",
    )

    private fun esc(value: String): String = buildString(value.length) {
        value.forEach { char -> append(when (char) {
            '&' -> "&amp;"; '<' -> "&lt;"; '>' -> "&gt;"; '"' -> "&quot;"; '\'' -> "&#39;"
            else -> char.toString()
        }) }
    }

    fun render(name: String, runs: List<Run>): String {
        val isRange = name == "Range discoveries"
        val candidates = runs.count { it.videoCandidate }
        val openPorts = runs.sumOf { it.ports.size }
        val scopes = runs.map { it.scope }.filter { it.isNotBlank() }.distinct().size
        val failures = runs.count { it.status == "failed" }
        val findings = runs.sumOf { it.findingCount }
        val cards = runs.joinToString("\n") { run ->
            val state = if (run.status == "failed") "fail" else if (isRange && run.ports.isNotEmpty()) "open" else if (run.videoCandidate) "video" else if (run.findingCount > 0) "issue" else "clear"
            val label = when (state) { "fail" -> "Scan failed"; "open" -> "Open TCP services"; "video" -> "Video service candidate"; "issue" -> "Findings to review"; else -> "No findings observed" }
            val portsHtml = if (run.ports.isEmpty()) "<p class='muted'>No open ports recorded by this scan.</p>" else
                run.ports.joinToString("") { "<span class='port'>${it.number} <small>${esc(it.service)}</small></span>" }
            val findingsHtml = if (run.findings.isEmpty()) "<p class='muted'>No findings recorded. This does not prove the target is secure.</p>" else
                run.findings.joinToString("") { "<div class='finding'><b class='severity'>${esc(it.severity)}</b><strong>${esc(it.title)}</strong><p>${esc(it.impact)}</p></div>" }
            val errorHtml = if (run.error.isBlank()) "" else "<div class='error'>${esc(run.error)}</div>"
            """<article class="run" data-state="$state" data-findings="${run.findingCount}" data-search="${esc(run.target + " " + run.scope + " " + run.ports.joinToString(" ") { it.number.toString() } + " " + run.findings.joinToString(" ") { it.title })}">
              <div class="runhead"><div><span class="eyebrow">${esc(run.time)}</span><h2>${esc(run.target)}</h2></div><span class="badge $state">$label</span></div>
              <div class="runmeta">${if (isRange) "<span>Open ports <b>${run.ports.size}</b></span><span>Scope <b>${esc(run.scope)}</b></span>" else "<span>Grade <b>${esc(run.grade.ifBlank { "—" })}</b></span><span>Score <b>${if (run.status == "failed" || run.score < 0) "—" else run.score.toString()}</b></span><span>Findings <b>${run.findingCount}</b></span><span>Open ports <b>${run.ports.size}</b></span>"}</div>
              $errorHtml
              <details><summary>Evidence and findings <span>View details</span></summary><div class="detail"><h3>Observed open ports</h3><div class="ports">$portsHtml</div><h3>Findings</h3>$findingsHtml</div></details>
            </article>"""
        }
        return """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>${esc(name)} · Recon results</title><style>
        :root{color-scheme:dark;--bg:#0b101a;--panel:#151e2c;--line:#33445e;--text:#f3f7ff;--muted:#b6c7dd;--blue:#80b9ff;--green:#86e6c0;--amber:#ffd181;--red:#ff9aa3}
        *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 100% 0%,#18375b 0%,var(--bg) 43%);color:var(--text);font:15px/1.45 system-ui,Roboto,sans-serif}
        header{position:sticky;top:0;z-index:10;background:#0b101aee;border-bottom:1px solid var(--line);padding:14px 18px;display:flex;align-items:center;gap:12px;backdrop-filter:blur(12px)}
        header b{font-size:17px;flex:1}button{font:inherit;cursor:pointer}button.close{background:#25374e;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:8px 12px}
        main{max-width:1000px;margin:auto;padding:22px 16px 60px}.eyebrow{color:var(--blue);text-transform:uppercase;font-size:11px;letter-spacing:.13em;font-weight:700}
        h1{font-size:clamp(25px,5vw,38px);line-height:1.1;margin:7px 0}h2{font-size:18px;margin:4px 0 0;overflow-wrap:anywhere}h3{font-size:13px;text-transform:uppercase;color:var(--muted);letter-spacing:.09em;margin:22px 0 9px}
        .intro{color:var(--muted);max-width:720px;margin:0 0 18px}.notice{border:1px solid #5378a1;background:#17304a;border-radius:12px;padding:12px 14px;color:#dfedff;margin:14px 0 22px}
        .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.stats.range{grid-template-columns:repeat(3,1fr)}.stat,.run{background:var(--panel);border:1px solid var(--line);border-radius:16px}.stat{padding:15px}.stat strong{display:block;font-size:25px}.stat span{color:var(--muted);font-size:12px}
        .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:24px 0 14px}input{min-width:180px;flex:1;background:#17263a;border:1px solid #5b7395;border-radius:11px;color:var(--text);padding:12px;font:inherit}input::placeholder{color:var(--muted)}
        .filters{display:flex;gap:6px;overflow-x:auto}button.filter{white-space:nowrap;background:#17263a;border:1px solid var(--line);color:var(--muted);padding:9px 12px;border-radius:999px}button.filter.active{background:#2b527e;color:#fff;border-color:#81baff}
        .run{padding:16px;margin-bottom:11px}.runhead{display:flex;justify-content:space-between;gap:10px;align-items:start}.badge{font-size:11px;font-weight:700;border-radius:999px;padding:6px 9px;white-space:nowrap;background:#243e5c;color:#d6eaff}.badge.open{background:#184a41;color:var(--green)}.badge.video{background:#564018;color:var(--amber)}.badge.issue{background:#54313a;color:var(--red)}.badge.fail{background:#58343a;color:var(--red)}
        .runmeta{display:flex;gap:13px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin:15px 0}.runmeta b{color:var(--text)}details{border-top:1px solid var(--line)}summary{cursor:pointer;padding:13px 0 2px;color:var(--blue);font-weight:700}summary span{float:right;color:var(--muted);font-size:12px}.detail{padding:2px 0 10px}.ports{display:flex;flex-wrap:wrap;gap:7px}.port{display:inline-flex;gap:5px;align-items:center;border:1px solid #50749a;background:#1b344e;border-radius:8px;padding:6px 8px;font-weight:700}.port small{font-weight:400;color:var(--muted)}
        .finding{border-left:3px solid #e4a35d;padding:5px 0 6px 11px;margin:9px 0}.finding p{color:var(--muted);margin:3px 0}.severity{color:var(--amber);font-size:11px;margin-right:8px}.muted,.empty{color:var(--muted)}.empty{text-align:center;padding:42px 12px;border:1px dashed var(--line);border-radius:14px}.error{color:var(--red);padding:10px;border-radius:9px;background:#442834}
        @media(max-width:650px){.stats,.stats.range{grid-template-columns:repeat(2,1fr)}.runhead{display:block}.badge{display:inline-block;margin-top:10px}}
        </style></head><body><header><b>Ghost Browser · Recon</b><button class="close" onclick="GbArtifact.close()">Close</button></header>
        <main><span class="eyebrow">On-device scan history</span><h1>${esc(name)}</h1>
        <p class="intro">Evidence from selected targets. Results remain on this phone unless you separately enable cluster sharing.</p>
        <div class="notice">${if (isRange) "These results show accepted TCP connections. They do not identify the service, prove access, or show a device vulnerability." else "A video-service candidate means a TCP connection succeeded on a port commonly used for RTSP. The protocol, device type, access, and stream were not verified."}</div>
        <section class="stats ${if (isRange) "range" else ""}">${if (isRange) "<div class='stat'><strong>${runs.size}</strong><span>Hosts found</span></div><div class='stat'><strong>$openPorts</strong><span>Open ports</span></div><div class='stat'><strong>$scopes</strong><span>Scanned scopes</span></div>" else "<div class='stat'><strong>${runs.size}</strong><span>Runs</span></div><div class='stat'><strong>$candidates</strong><span>Video-service candidates</span></div><div class='stat'><strong>$findings</strong><span>Findings</span></div><div class='stat'><strong>$failures</strong><span>Failed runs</span></div>"}</section>
        <div class="toolbar"><input id="search" type="search" aria-label="Search results" placeholder="${if (isRange) "Search IP, port, or subnet" else "Search target or finding"}">
        ${if (isRange) "" else "<div class='filters'><button class='filter active' data-filter='all'>All</button><button class='filter' data-filter='video'>Video candidates</button><button class='filter' data-filter='issue'>Findings</button><button class='filter' data-filter='fail'>Failed</button></div>"}</div>
        <section id="runs">${if (runs.isEmpty()) "<div class='empty'>${if (isRange) "No open ports recorded yet. Start a range scan to discover services." else "No local scan results yet. Run a security automation or wait for the next scheduled watcher pass."}</div>" else cards}</section>
        <div id="noMatch" class="empty" hidden>No results match this filter.</div></main>
        <script>const q=document.getElementById('search'),buttons=[...document.querySelectorAll('.filter')],cards=[...document.querySelectorAll('.run')];let filter='all';function update(){let shown=0;for(const card of cards){const state=card.dataset.state;const match=(filter==='all'||state===filter||(filter==='issue'&&Number(card.dataset.findings)>0))&&card.dataset.search.toLowerCase().includes(q.value.toLowerCase());card.hidden=!match;if(match)shown++}document.getElementById('noMatch').hidden=shown>0||cards.length===0}q.addEventListener('input',update);for(const b of buttons)b.addEventListener('click',()=>{filter=b.dataset.filter;buttons.forEach(x=>x.classList.toggle('active',x===b));update()});</script></body></html>"""
    }
}
