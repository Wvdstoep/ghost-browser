package engineer.myapp.gb.shared

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val ReconEmerald = Color(0xFF10B981)
private val ReconCyan = Color(0xFF06B6D4)
private val ReconAmber = Color(0xFFF59E0B)
private val ReconOrange = Color(0xFFEA580C)
private val ReconRed = Color(0xFFEF4444)
private val ReconDarkSurface = Color(0xFF131722)
private val ReconDarkCard = Color(0xFF1E2230)
private val ReconCodeBg = Color(0xFF0B0E14)

private fun gradeColor(grade: String): Color = when (grade.uppercase()) {
    "A" -> ReconEmerald
    "B" -> ReconCyan
    "C" -> ReconAmber
    "D" -> ReconOrange
    else -> ReconRed
}

private fun severityColor(sev: String): Color = when (sev.uppercase()) {
    "CRITICAL" -> ReconRed
    "HIGH" -> ReconOrange
    "MEDIUM" -> ReconAmber
    "LOW" -> ReconCyan
    else -> Color(0xFF94A3B8)
}

/**
 * Address bar icon: a sleek shield button that triggers the security audit.
 */
@Composable
fun ReconAddressBarIcon(
    ui: ReconUi,
    currentUrl: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val report = ui.report.value
    val isScanning = ui.isScanning.value
    val cs = MaterialTheme.colorScheme

    val tint = when {
        isScanning -> ReconCyan
        report != null -> gradeColor(report.grade)
        currentUrl.isNotBlank() -> cs.onSurfaceVariant
        else -> cs.onSurfaceVariant.copy(alpha = 0.5f)
    }

    Box(
        modifier = modifier
            .size(32.dp)
            .clip(CircleShape)
            .clickable { onClick() },
        contentAlignment = Alignment.Center,
    ) {
        if (isScanning) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
                color = ReconCyan,
            )
        } else {
            Icon(
                imageVector = Icons.Default.Shield,
                contentDescription = "Security Recon & Audit",
                tint = tint,
                modifier = Modifier.size(17.dp),
            )
        }
    }
}

/**
 * The ReconSheet: Comprehensive Defensive AppSec & Red Team Surface.
 */
@Composable
fun ReconSheet(
    ui: ReconUi,
    act: ReconActions,
    modifier: Modifier = Modifier,
) {
    val report = ui.report.value
    val isScanning = ui.isScanning.value
    val error = ui.error.value
    val tab = ui.selectedTab.value
    val target = ui.currentTarget.value

    Box(
        Modifier.fillMaxSize().background(Color(0xB3000000)).clickable { act.onClose() },
        contentAlignment = Alignment.BottomCenter,
    ) {
        Surface(
            color = ReconDarkSurface,
            contentColor = Color(0xFFF1F5F9),
            shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
            modifier = modifier.fillMaxWidth().widthIn(max = 680.dp).clickable(enabled = false) {},
        ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 14.dp),
        ) {
            // Drag handle
            Box(
                Modifier
                    .align(Alignment.CenterHorizontally)
                    .width(40.dp)
                    .height(4.dp)
                    .clip(CircleShape)
                    .background(Color(0xFF334155)),
            )
            Spacer(Modifier.height(12.dp))

            // Header Row
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Default.Shield, null, tint = ReconCyan, modifier = Modifier.size(24.dp))
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "ReconForge",
                            fontWeight = FontWeight.Bold,
                            fontSize = 17.sp,
                            color = Color.White,
                        )
                        Spacer(Modifier.width(8.dp))
                        Surface(
                            color = ReconCyan.copy(alpha = 0.15f),
                            shape = RoundedCornerShape(4.dp),
                        ) {
                            Text(
                                "COMPREHENSIVE",
                                color = ReconCyan,
                                fontSize = 10.sp,
                                fontWeight = FontWeight.Bold,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                    }
                    Text(
                        if (target.isBlank()) "No target domain selected" else target,
                        fontSize = 12.sp,
                        color = Color(0xFF94A3B8),
                        fontFamily = FontFamily.Monospace,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                IconButton(onClick = { act.onClose() }) {
                    Icon(Icons.Default.Close, "Close", tint = Color(0xFF94A3B8))
                }
            }

            Spacer(Modifier.height(12.dp))

            // Error banner if any
            if (error != null) {
                Surface(
                    color = ReconRed.copy(alpha = 0.15f),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
                ) {
                    Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Warning, null, tint = ReconRed, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(error, color = ReconRed, fontSize = 12.sp, modifier = Modifier.weight(1f))
                    }
                }
            }

            // Posture Overview Card
            if (report != null) {
                PostureCard(report)
                Spacer(Modifier.height(12.dp))
            } else if (isScanning) {
                ScanningBanner(target)
                Spacer(Modifier.height(12.dp))
            }

            // Navigation Tabs
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(ReconDarkCard)
                    .padding(3.dp),
            ) {
                ReconTabItem("advisories", "4 Pillars (" + (report?.findingsCount ?: 0) + ")", tab == "advisories") { ui.selectedTab.value = "advisories" }
                ReconTabItem("session", "Auth & Session (CWE-613)", tab == "session") { ui.selectedTab.value = "session" }
                ReconTabItem("perimeter", "Perimeter & DNS", tab == "perimeter") { ui.selectedTab.value = "perimeter" }
            }

            Spacer(Modifier.height(12.dp))

            // Tab Content
            Box(Modifier.weight(1f, fill = false)) {
                when (tab) {
                    "advisories" -> AdvisoriesList(ui, act)
                    "session" -> SessionSecurityView(ui, act)
                    "perimeter" -> PerimeterView(ui, act)
                }
            }

            Spacer(Modifier.height(10.dp))

            // Action Footer
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { act.onScan(target, true) },
                    enabled = !isScanning && target.isNotBlank(),
                    colors = ButtonDefaults.buttonColors(containerColor = ReconCyan, contentColor = Color.Black),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.weight(1f).height(44.dp),
                ) {
                    if (isScanning) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = Color.Black)
                        Spacer(Modifier.width(8.dp))
                        Text("Recon in Progress...", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    } else {
                        Icon(Icons.Default.Refresh, null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Run Comprehensive Audit", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    }
                }
            }
        }
    }
    }
}

@Composable
private fun RowScope.ReconTabItem(id: String, label: String, selected: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .weight(1f)
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) Color(0xFF334155) else Color.Transparent)
            .clickable { onClick() }
            .padding(vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 11.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            color = if (selected) Color.White else Color(0xFF94A3B8),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun PostureCard(report: ReconReport) {
    val gradeColor = gradeColor(report.grade)
    val criticalCount = report.findings.count { it.severity.equals("CRITICAL", true) }
    val highCount = report.findings.count { it.severity.equals("HIGH", true) }
    val medCount = report.findings.count { it.severity.equals("MEDIUM", true) }
    val lowCount = report.findings.count { it.severity.equals("LOW", true) }

    Surface(
        color = ReconDarkCard,
        shape = RoundedCornerShape(14.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFF334155)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Grade & Score Badge
            Box(
                Modifier
                    .size(64.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(gradeColor.copy(alpha = 0.15f))
                    .border(1.5.dp, gradeColor, RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        report.grade,
                        fontSize = 26.sp,
                        fontWeight = FontWeight.Black,
                        color = gradeColor,
                    )
                    Text(
                        "" + report.score + "/100",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = gradeColor,
                    )
                }
            }

            Spacer(Modifier.width(14.dp))

            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Security Posture", fontWeight = FontWeight.Bold, fontSize = 14.sp, color = Color.White)
                    Spacer(Modifier.weight(1f))
                    Text(
                        if (report.waf.detected) "WAF: " + report.waf.name else "No WAF Detected",
                        fontSize = 11.sp,
                        color = if (report.waf.detected) ReconEmerald else ReconAmber,
                        fontWeight = FontWeight.SemiBold,
                    )
                }

                Spacer(Modifier.height(8.dp))

                // Severity Counters
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    SevCountChip("CRITICAL", criticalCount, ReconRed)
                    SevCountChip("HIGH", highCount, ReconOrange)
                    SevCountChip("MED", medCount, ReconAmber)
                    SevCountChip("LOW", lowCount, ReconCyan)
                }
            }
        }
    }
}

@Composable
private fun SevCountChip(label: String, count: Int, color: Color) {
    Surface(
        color = color.copy(alpha = 0.12f),
        shape = RoundedCornerShape(6.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, color.copy(alpha = 0.3f)),
    ) {
        Row(
            Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("" + count, fontWeight = FontWeight.Black, fontSize = 11.sp, color = color)
            Spacer(Modifier.width(3.dp))
            Text(label, fontSize = 9.sp, fontWeight = FontWeight.SemiBold, color = color.copy(alpha = 0.8f))
        }
    }
}

@Composable
private fun ScanningBanner(target: String) {
    Surface(
        color = ReconCyan.copy(alpha = 0.1f),
        shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, ReconCyan.copy(alpha = 0.3f)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.5.dp, color = ReconCyan)
            Spacer(Modifier.width(12.dp))
            Column {
                Text("Analyzing External Attack Surface...", fontWeight = FontWeight.Bold, fontSize = 13.sp, color = Color.White)
                Text("Querying DNS, probing ports, inspecting headers, evaluating session invalidation...", fontSize = 11.sp, color = Color(0xFF94A3B8))
            }
        }
    }
}

@Composable
private fun AdvisoriesList(ui: ReconUi, act: ReconActions) {
    val report = ui.report.value
    val findings = report?.findings ?: emptyList()
    val expandedId = ui.expandedFindingId.value

    if (findings.isEmpty()) {
        Box(
            Modifier
                .fillMaxWidth()
                .padding(vertical = 32.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text("No vulnerabilities found or target not yet scanned.", color = Color(0xFF94A3B8), fontSize = 13.sp)
        }
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(findings) { finding ->
            val isExpanded = expandedId == finding.id
            FindingCard(
                finding = finding,
                isExpanded = isExpanded,
                selectedStack = ui.selectedRemediationStack.value,
                onToggleExpand = {
                    ui.expandedFindingId.value = if (isExpanded) null else finding.id
                },
                onSelectStack = { ui.selectedRemediationStack.value = it },
                onCopy = { act.onCopySnippet(it) },
            )
        }
    }
}

@Composable
private fun FindingCard(
    finding: ReconFinding,
    isExpanded: Boolean,
    selectedStack: String,
    onToggleExpand: () -> Unit,
    onSelectStack: (String) -> Unit,
    onCopy: (String) -> Unit,
) {
    val sevColor = severityColor(finding.severity)

    Surface(
        color = ReconDarkCard,
        shape = RoundedCornerShape(10.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, if (isExpanded) sevColor.copy(alpha = 0.5f) else Color(0xFF334155)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { onToggleExpand() }
                    .padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Surface(
                    color = sevColor.copy(alpha = 0.15f),
                    shape = RoundedCornerShape(4.dp),
                ) {
                    Text(
                        finding.severity.uppercase(),
                        color = sevColor,
                        fontWeight = FontWeight.Black,
                        fontSize = 10.sp,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }

                Spacer(Modifier.width(10.dp))

                Column(Modifier.weight(1f)) {
                    Text(
                        finding.title,
                        fontWeight = FontWeight.Bold,
                        fontSize = 13.sp,
                        color = Color.White,
                        maxLines = if (isExpanded) 3 else 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (finding.cwe.isNotBlank() || finding.owasp.isNotBlank()) {
                        Text(
                            finding.cwe + " · " + finding.owasp,
                            fontSize = 10.sp,
                            color = Color(0xFF94A3B8),
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }

                Icon(
                    imageVector = if (isExpanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                    contentDescription = null,
                    tint = Color(0xFF94A3B8),
                )
            }

            AnimatedVisibility(visible = isExpanded) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 4.dp)
                        .padding(bottom = 12.dp),
                ) {
                    Divider(color = Color(0xFF334155))
                    Spacer(Modifier.height(10.dp))

                    PillarHeader("PILLAR 1: ROOT CAUSE & TECHNICAL BREAKDOWN")
                    Text(
                        if (finding.rootCause.isNotBlank()) finding.rootCause else finding.impact,
                        fontSize = 12.sp,
                        color = Color(0xFFCBD5E1),
                        lineHeight = 17.sp,
                    )

                    Spacer(Modifier.height(10.dp))

                    PillarHeader("PILLAR 2: THREAT MODELING & ATTACK SCENARIO")
                    Text(
                        if (finding.threatScenario.isNotBlank()) finding.threatScenario else "An attacker can exploit this misconfiguration to bypass transport controls, impersonate services, or access unauthorized data.",
                        fontSize = 12.sp,
                        color = Color(0xFFFCA5A5),
                        lineHeight = 17.sp,
                    )

                    Spacer(Modifier.height(10.dp))

                    PillarHeader("PILLAR 3: COPY-PASTE CONFIGURATION REMEDIATION")

                    Row(
                        Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        StackChip("Traefik", selectedStack == "traefik") { onSelectStack("traefik") }
                        StackChip("Nginx", selectedStack == "nginx") { onSelectStack("nginx") }
                        StackChip("Express Helmet", selectedStack == "express") { onSelectStack("express") }
                        StackChip("DNS Record", selectedStack == "dns") { onSelectStack("dns") }
                    }

                    Spacer(Modifier.height(6.dp))

                    val snippet = when (selectedStack) {
                        "traefik" -> finding.traefik
                        "nginx" -> finding.nginx
                        "express" -> finding.express
                        "dns" -> finding.dns
                        else -> finding.traefik
                    }

                    Surface(
                        color = ReconCodeBg,
                        shape = RoundedCornerShape(8.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFF1E293B)),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.padding(10.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    selectedStack.uppercase(),
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = ReconCyan,
                                )
                                Spacer(Modifier.weight(1f))
                                Text(
                                    "COPY CONFIG",
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = ReconEmerald,
                                    modifier = Modifier.clickable { onCopy(snippet) },
                                )
                            }
                            Spacer(Modifier.height(4.dp))
                            Text(
                                if (snippet.isNotBlank()) snippet else "# No specific configuration change required for this stack.",
                                fontFamily = FontFamily.Monospace,
                                fontSize = 11.sp,
                                color = Color(0xFFE2E8F0),
                                lineHeight = 15.sp,
                            )
                        }
                    }

                    Spacer(Modifier.height(10.dp))

                    PillarHeader("PILLAR 4: SECONDARY DEFENSES & FALLBACKS")
                    Text(
                        if (finding.secondaryDefense.isNotBlank()) finding.secondaryDefense else "Implement WAF edge filtering and monitoring alarms.",
                        fontSize = 12.sp,
                        color = Color(0xFF94A3B8),
                        lineHeight = 17.sp,
                    )
                }
            }
        }
    }
}

@Composable
private fun PillarHeader(title: String) {
    Text(
        title,
        fontSize = 10.sp,
        fontWeight = FontWeight.Black,
        color = Color(0xFF64748B),
        modifier = Modifier.padding(bottom = 3.dp),
    )
}

@Composable
private fun StackChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        color = if (selected) ReconCyan.copy(alpha = 0.2f) else Color(0xFF1E293B),
        shape = RoundedCornerShape(6.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, if (selected) ReconCyan else Color(0xFF334155)),
        modifier = Modifier.clickable { onClick() },
    ) {
        Text(
            label,
            fontSize = 11.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            color = if (selected) ReconCyan else Color(0xFFCBD5E1),
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}

@Composable
private fun SessionSecurityView(ui: ReconUi, act: ReconActions) {
    Surface(
        color = ReconDarkCard,
        shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFF334155)),
        modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(14.dp),
    ) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.VpnKey, null, tint = ReconAmber, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text("Broken Auth & Session Management (CWE-613)", fontWeight = FontWeight.Bold, fontSize = 14.sp, color = Color.White)
            }
            Spacer(Modifier.height(8.dp))
            Text(
                "Audit based on vulnerability report (Zain / Penetration Test): Validates whether changing a password or revoking access terminates existing active sessions on other browsers.",
                fontSize = 12.sp,
                color = Color(0xFFCBD5E1),
                lineHeight = 17.sp,
            )
            Spacer(Modifier.height(12.dp))

            Surface(
                color = ReconCodeBg,
                shape = RoundedCornerShape(8.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFF1E293B)),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(10.dp)) {
                    Text("REMEDIATION PATTERN (TOKEN VERSION / SESSION REVOCATION):", fontSize = 10.sp, fontWeight = FontWeight.Bold, color = ReconAmber)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "// 1. In User model, increment tokenVersion on password update:\nuser.tokenVersion = (user.tokenVersion || 0) + 1;\nawait user.save();\n\n// 2. In auth verification middleware:\nconst payload = jwt.verify(token, SECRET);\nif (payload.tokenVersion !== user.tokenVersion) {\n  return res.status(401).json({ error: 'Session revoked due to password change.' });\n}",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        color = Color(0xFFE2E8F0),
                        lineHeight = 15.sp,
                    )
                }
            }
        }
    }
}

@Composable
private fun PerimeterView(ui: ReconUi, act: ReconActions) {
    val report = ui.report.value
    Surface(
        color = ReconDarkCard,
        shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFF334155)),
        modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(14.dp),
    ) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Dns, null, tint = ReconCyan, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text("Perimeter & DNS Attack Surface", fontWeight = FontWeight.Bold, fontSize = 14.sp, color = Color.White)
            }
            Spacer(Modifier.height(8.dp))
            Text(
                "Autonomous scan inspected apex DNS records (A, AAAA, MX, TXT, DMARC, DKIM), checked for dangling CNAME takeovers, mapped HTTP security headers, and detected reverse-proxy topology.",
                fontSize = 12.sp,
                color = Color(0xFFCBD5E1),
                lineHeight = 17.sp,
            )
            Spacer(Modifier.height(10.dp))
            val wafText = if (report?.waf?.detected == true) report.waf.name else "Direct Origin"
            Text("Target Domain: " + (report?.target ?: ui.currentTarget.value), fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = ReconCyan)
            Text("WAF / Edge: " + wafText, fontSize = 12.sp, color = Color(0xFF94A3B8))
        }
    }
}
