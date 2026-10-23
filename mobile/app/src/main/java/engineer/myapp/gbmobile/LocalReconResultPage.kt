package engineer.myapp.gbmobile

/** Searchable scan history: a compact paged list and one focused evidence sheet. */
object LocalReconResultPage {
    data class Port(val number: Int, val service: String)
    data class Finding(val severity: String, val title: String, val impact: String)
    data class Run(
        val target: String, val time: String, val status: String, val grade: String,
        val score: Int, val findingCount: Int, val videoCandidate: Boolean,
        val ports: List<Port>, val findings: List<Finding>, val error: String = "", val scope: String = "",
        val webIdentified: Boolean = false,
    )

    private const val PAGE_SIZE = 20

    private fun esc(value: String): String = buildString(value.length) {
        value.forEach { char -> append(when (char) {
            '&' -> "&amp;"; '<' -> "&lt;"; '>' -> "&gt;"; '"' -> "&quot;"; '\'' -> "&#39;"
            else -> char.toString()
        }) }
    }

    fun render(name: String, runs: List<Run>): String {
        val isRange = name == "Range discoveries"
        val scopes = runs.map { it.scope }.filter { it.isNotBlank() }.distinct().sorted()
        val failures = runs.count { it.status == "failed" }
        val openPorts = runs.sumOf { it.ports.size }
        val findings = runs.sumOf { it.findingCount }
        fun hasWeb(run: Run) = run.webIdentified || run.ports.any { it.service.startsWith("HTTP ") || it.service.startsWith("HTTPS ") }
        val webCount = runs.count(::hasWeb)
        val cards = runs.mapIndexed { index, run ->
            val web = hasWeb(run)
            val state = when {
                run.status == "failed" -> "fail"
                isRange && web -> "web"
                isRange -> "open"
                run.findingCount > 0 -> "issue"
                run.videoCandidate -> "video"
                else -> "clear"
            }
            val label = when (state) {
                "fail" -> "Failed"; "web" -> "Web identified"; "open" -> "Open TCP services"
                "issue" -> "Findings"; "video" -> "Video candidate"; else -> "No findings"
            }
            val portsHtml = if (run.ports.isEmpty()) "<p class='muted'>No open ports recorded.</p>" else
                run.ports.joinToString("") { "<div class='evidence-line'><span class='number'>:${it.number}</span><span>${esc(it.service)}</span></div>" }
            val findingsHtml = if (run.findings.isEmpty()) "<p class='muted'>No findings recorded. This does not prove the target is secure.</p>" else
                run.findings.joinToString("") { "<div class='finding'><span class='severity'>${esc(it.severity)}</span><strong>${esc(it.title)}</strong><p>${esc(it.impact)}</p></div>" }
            val errorHtml = if (run.error.isBlank()) "" else "<div class='error'>${esc(run.error)}</div>"
            val detail = """<div class="sheet-eyebrow">${esc(run.time)} · ${esc(run.scope.ifBlank { "Selected target" })}</div>
                <h2>${esc(run.target)}</h2><span class="badge $state">$label</span>
                <div class="detail-metrics"><div><strong>${run.ports.size}</strong><span>Open ports</span></div><div><strong>${run.findingCount}</strong><span>Findings</span></div>${if (isRange) "<div><strong>${if (web) "Yes" else "No"}</strong><span>Web response</span></div>" else "<div><strong>${esc(run.grade.ifBlank { "—" })}</strong><span>Grade</span></div>"}</div>
                $errorHtml<h3>Observed services</h3>$portsHtml<h3>Findings and context</h3>$findingsHtml
                <p class="sheet-note">An accepted connection or HTTP response alone does not establish a vulnerability. Review the evidence before reporting.</p>"""
            """<button type="button" class="result" data-state="$state" data-scope="${esc(run.scope)}"
                data-search="${esc(run.target + " " + run.scope + " " + run.ports.joinToString(" ") { "${it.number} ${it.service}" } + " " + run.findings.joinToString(" ") { it.title })}"
                data-detail="detail-$index" ${if (index >= PAGE_SIZE) "hidden" else ""} aria-label="View evidence for ${esc(run.target)}">
                <span class="result-main"><span class="result-target">${esc(run.target)}</span><span class="result-sub">${esc(run.scope.ifBlank { "Selected target" })} · ${esc(run.time)}</span></span>
                <span class="result-count">${run.ports.size} ports</span><span class="badge $state">$label</span><span class="arrow" aria-hidden="true">›</span></button>
                <template id="detail-$index">$detail</template>"""
        }.joinToString("\n")
        val scopeOptions = scopes.joinToString("") { "<option value=\"${esc(it)}\">${esc(it)}</option>" }
        val filters = if (isRange) listOf("all" to "All hosts", "web" to "Web identified", "open" to "TCP only", "fail" to "Failed")
            else listOf("all" to "All runs", "issue" to "Findings", "video" to "Video candidates", "fail" to "Failed")
        val filterHtml = filters.joinToString("") { (value, label) ->
            "<button type=\"button\" class=\"filter ${if (value == "all") "active" else ""}\" data-filter=\"$value\" aria-pressed=\"${value == "all"}\">$label</button>"
        }
        val empty = if (isRange) "No open ports recorded yet. Start range discovery to collect evidence." else
            "No local scan results yet. Run a security automation or wait for a watcher."
        return """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>${esc(name)} · Ghost Browser</title><style>
        :root{color-scheme:dark;--bg:#0a101b;--surface:#141f30;--raised:#1b2b40;--line:#3d506a;--text:#f5f8ff;--muted:#b9c9dd;--blue:#96c7ff;--green:#83e2c2;--amber:#ffd38b;--red:#ffadb5}
        *{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 85% -12%,#244466 0%,transparent 42%),var(--bg);color:var(--text);font:15px/1.45 system-ui,Roboto,sans-serif}
        button,select,input{font:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
        .topbar{position:sticky;top:0;z-index:5;background:#0a101bf2;border-bottom:1px solid var(--line);backdrop-filter:blur(14px);display:flex;align-items:center;gap:12px;padding:12px max(16px,calc((100vw - 1100px)/2))}
        .brand{display:flex;align-items:center;gap:9px;font-weight:800;flex:1}.mark{width:26px;height:26px;border-radius:8px;background:linear-gradient(145deg,#a0cdff,#4c8edb);box-shadow:0 0 20px #4c8edb66}
        .close,.sheet-close{border:1px solid var(--line);background:var(--raised);color:var(--text);border-radius:11px;padding:9px 13px;min-height:40px}
        main{max-width:1100px;margin:auto;padding:28px 16px 80px}.eyebrow,.sheet-eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--blue);font-weight:800}
        h1{font-size:clamp(29px,5vw,43px);line-height:1.08;margin:8px 0}h2{font-size:22px;overflow-wrap:anywhere;line-height:1.25}h3{font-size:12px;text-transform:uppercase;letter-spacing:.11em;color:var(--muted);margin:24px 0 10px}
        .intro{color:var(--muted);max-width:720px;margin:0 0 22px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.metric{border:1px solid var(--line);border-radius:16px;background:linear-gradient(155deg,#1b314a,var(--surface));padding:16px}.metric strong{display:block;font-size:27px;line-height:1.1}.metric span{display:block;color:var(--muted);font-size:12px;margin-top:5px}
        .notice{margin:18px 0 22px;border:1px solid #4b7097;background:#19334d;border-radius:13px;padding:12px 14px;color:#e0efff;font-size:13px}
        .workspace{border:1px solid var(--line);border-radius:20px;background:#101a29;overflow:hidden}.toolbar{padding:17px;border-bottom:1px solid var(--line);display:grid;grid-template-columns:minmax(220px,1fr) minmax(150px,230px);gap:10px}
        .toolbar input,.toolbar select{width:100%;min-height:45px;border:1px solid #6480a1;background:#1a2b40;color:var(--text);border-radius:11px;padding:10px 12px}.toolbar input::placeholder{color:#a9bdd4}
        .filters{display:flex;overflow-x:auto;gap:7px;padding:0 17px 14px;scrollbar-width:thin}.filter{white-space:nowrap;border:1px solid var(--line);border-radius:999px;background:#1c2d42;color:var(--muted);padding:8px 13px;min-height:39px}.filter.active{background:#315b88;border-color:#91c4ff;color:#fff}
        .list-head{display:flex;align-items:center;justify-content:space-between;padding:10px 17px;background:#172337;border-top:1px solid var(--line);color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
        .result{display:flex;align-items:center;text-align:left;gap:14px;width:100%;border:0;border-bottom:1px solid #304159;background:transparent;color:var(--text);padding:14px 17px;min-height:77px}.result:hover,.result:focus-visible{background:#1b2d43}.result:last-of-type{border-bottom:0}.result-main{display:flex;flex:1;min-width:0;flex-direction:column;gap:3px}.result-target{font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.result-sub{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.result-count{white-space:nowrap;color:var(--muted);font-size:12px}.arrow{font-size:26px;color:var(--blue);line-height:1}
        .badge{display:inline-block;white-space:nowrap;border-radius:999px;padding:6px 9px;font-size:11px;font-weight:800;background:#304760;color:#e5f2ff}.badge.web,.badge.open{background:#1d5248;color:var(--green)}.badge.video{background:#5a461f;color:var(--amber)}.badge.issue,.badge.fail{background:#59343d;color:var(--red)}
        .pagination{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--line);padding:13px 17px}.page-actions{display:flex;gap:7px}.page-actions button{border:1px solid var(--line);background:var(--raised);color:var(--text);border-radius:10px;padding:8px 13px;min-height:39px}.page-actions button:disabled{opacity:.42;cursor:default}.empty{padding:36px 18px;text-align:center;color:var(--muted)}[hidden]{display:none!important}
        .overlay{position:fixed;inset:0;z-index:20;background:#02060dbb;display:flex;justify-content:flex-end}.sheet{width:min(100%,520px);height:100%;overflow:auto;background:#122033;border-left:1px solid #6282a5;padding:20px 22px 60px;box-shadow:-22px 0 60px #0008}.sheet-top{display:flex;justify-content:flex-end}.sheet h2{margin:10px 0 13px}.detail-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:22px 0}.detail-metrics div{padding:11px;border:1px solid var(--line);border-radius:10px;background:var(--raised)}.detail-metrics strong,.detail-metrics span{display:block}.detail-metrics strong{font-size:19px}.detail-metrics span{font-size:11px;color:var(--muted)}
        .evidence-line{display:flex;gap:12px;padding:10px 12px;margin:6px 0;border:1px solid var(--line);border-radius:10px;background:#1a2c42;overflow-wrap:anywhere}.number{font-weight:800;color:var(--blue);min-width:48px}.finding{border-left:3px solid #e7af6a;padding:4px 0 5px 12px;margin:9px 0}.finding p,.muted{color:var(--muted)}.severity{color:var(--amber);font-size:11px;font-weight:800;margin-right:8px}.error{padding:11px;border-radius:10px;background:#512f3d;color:var(--red)}.sheet-note{border-top:1px solid var(--line);padding-top:15px;margin-top:24px;color:var(--muted);font-size:13px}
        @media(max-width:650px){main{padding-top:21px}.metrics{grid-template-columns:repeat(2,1fr)}.toolbar{grid-template-columns:1fr}.result{gap:8px}.result-count{display:none}.badge{font-size:10px}.sheet{border-left:0}.topbar{padding-left:16px;padding-right:16px}}
        </style></head><body><header class="topbar"><div class="brand"><span class="mark" aria-hidden="true"></span>Ghost Browser · Recon</div><button class="close" type="button" onclick="GbArtifact.close()">Close</button></header>
        <main><span class="eyebrow">On-device evidence</span><h1>${esc(name)}</h1><p class="intro">A focused view of scan history from targets you selected. Results remain on this phone unless you enable cluster sharing.</p>
        <section class="metrics" aria-label="Scan overview"><div class="metric"><strong>${runs.size}</strong><span>${if (isRange) "Host results" else "Runs"}</span></div><div class="metric"><strong>$openPorts</strong><span>Open ports</span></div><div class="metric"><strong>${if (isRange) webCount else findings}</strong><span>${if (isRange) "Web results" else "Findings"}</span></div><div class="metric"><strong>${if (isRange) scopes.size else failures}</strong><span>${if (isRange) "Scanned scopes" else "Failed runs"}</span></div></section>
        <div class="notice">${if (isRange) "A TCP connection or web response is an observation, not proof of a vulnerability. Open one host to inspect its evidence." else "Findings are observations to review. A video candidate does not prove the device type or access."}</div>
        <section class="workspace" aria-label="Results navigator"><div class="toolbar"><input id="search" type="search" aria-label="Search results" placeholder="Search host, port, title, or finding"><select id="scope" aria-label="Filter by scope"><option value="">All scopes</option>$scopeOptions</select></div>
        <div class="filters" aria-label="Result filters">$filterHtml</div><div class="list-head"><span id="matchCount" aria-live="polite">${runs.size} results</span><span>Tap a result for evidence</span></div>
        <div id="runs">${if (runs.isEmpty()) "<div class='empty'>$empty</div>" else cards}</div><div id="noMatch" class="empty" hidden>No results match your search or filters.</div>
        <nav class="pagination" aria-label="Results pages"><span id="pageInfo" aria-live="polite"></span><div class="page-actions"><button id="previous" type="button">Previous</button><button id="next" type="button">Next</button></div></nav></section></main>
        <div id="overlay" class="overlay" hidden><aside class="sheet" role="dialog" aria-modal="true" aria-label="Result evidence"><div class="sheet-top"><button id="sheetClose" class="sheet-close" type="button">Close details</button></div><div id="sheetContent"></div></aside></div>
        <script>
        (()=>{const size=$PAGE_SIZE,rows=[...document.querySelectorAll('.result')],q=document.getElementById('search'),scope=document.getElementById('scope'),filters=[...document.querySelectorAll('.filter')],previous=document.getElementById('previous'),next=document.getElementById('next'),info=document.getElementById('pageInfo'),count=document.getElementById('matchCount'),empty=document.getElementById('noMatch'),overlay=document.getElementById('overlay'),sheet=document.getElementById('sheetContent'),close=document.getElementById('sheetClose');let page=0,filter='all',lastFocus=null;
        function update(reset){if(reset)page=0;const query=q.value.trim().toLowerCase(),matched=rows.filter(row=>(filter==='all'||row.dataset.state===filter)&&(!scope.value||row.dataset.scope===scope.value)&&row.dataset.search.toLowerCase().includes(query));const pages=Math.max(1,Math.ceil(matched.length/size));page=Math.min(page,pages-1);const visible=new Set(matched.slice(page*size,(page+1)*size));rows.forEach(row=>row.hidden=!visible.has(row));count.textContent=matched.length+' results';info.textContent=matched.length?((page*size+1)+'–'+Math.min((page+1)*size,matched.length)+' of '+matched.length):'0 results';previous.disabled=page===0;next.disabled=page>=pages-1;empty.hidden=matched.length!==0||rows.length===0}
        q.addEventListener('input',()=>update(true));scope.addEventListener('change',()=>update(true));filters.forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;filters.forEach(other=>{other.classList.toggle('active',other===button);other.setAttribute('aria-pressed',String(other===button))});update(true)}));previous.addEventListener('click',()=>{page--;update(false);document.querySelector('.workspace').scrollIntoView({block:'start'})});next.addEventListener('click',()=>{page++;update(false);document.querySelector('.workspace').scrollIntoView({block:'start'})});
        function hideDetail(){overlay.hidden=true;document.body.style.overflow='';sheet.replaceChildren();if(lastFocus)lastFocus.focus()}rows.forEach(row=>row.addEventListener('click',()=>{const template=document.getElementById(row.dataset.detail);if(!template)return;lastFocus=row;sheet.replaceChildren(template.content.cloneNode(true));overlay.hidden=false;document.body.style.overflow='hidden';close.focus()}));close.addEventListener('click',hideDetail);overlay.addEventListener('click',event=>{if(event.target===overlay)hideDetail()});document.addEventListener('keydown',event=>{if(overlay.hidden)return;if(event.key==='Escape')hideDetail();if(event.key==='Tab'){event.preventDefault();close.focus()}});update(false)})();
        </script></body></html>"""
    }
}
