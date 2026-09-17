package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.ClickableText
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Markdown, the subset a chat answer uses, rendered natively: headings, paragraphs, bullet and
 * numbered lists, tables (as a grid), fenced code, rules, and inline bold / italic / code / links.
 * No library — the models write this shape and the reader must never see raw `**` or `|---|` again.
 */
private sealed class Block {
    data class Heading(val level: Int, val text: String) : Block()
    data class Para(val text: String) : Block()
    data class Bullets(val items: List<String>, val numbered: Boolean) : Block()
    data class Table(val rows: List<List<String>>) : Block()
    data class Code(val text: String) : Block()
    object Rule : Block()
}

private fun parseBlocks(src: String): List<Block> {
    val out = ArrayList<Block>()
    val lines = src.replace("\r\n", "\n").split("\n")
    var i = 0
    val para = StringBuilder()
    fun flushPara() { if (para.isNotBlank()) out.add(Block.Para(para.toString().trim())); para.clear() }
    while (i < lines.size) {
        val raw = lines[i]; val l = raw.trim()
        when {
            l.startsWith("```") -> {
                flushPara(); val buf = StringBuilder(); i++
                while (i < lines.size && !lines[i].trim().startsWith("```")) { buf.append(lines[i]).append('\n'); i++ }
                out.add(Block.Code(buf.toString().trimEnd())); i++
            }
            l.isEmpty() -> { flushPara(); i++ }
            l.matches(Regex("^(-{3,}|\\*{3,}|_{3,})$")) -> { flushPara(); out.add(Block.Rule); i++ }
            l.startsWith("#") -> {
                flushPara(); val level = l.takeWhile { it == '#' }.length.coerceIn(1, 4)
                out.add(Block.Heading(level, l.drop(level).trim().trimEnd('#').trim())); i++
            }
            l.startsWith("|") && l.endsWith("|") -> {
                flushPara(); val rows = ArrayList<List<String>>()
                while (i < lines.size && lines[i].trim().startsWith("|")) {
                    val row = lines[i].trim().removePrefix("|").removeSuffix("|").split("|").map { it.trim() }
                    if (!row.all { it.matches(Regex("^:?-{2,}:?$")) }) rows.add(row)   // skip the |---| separator
                    i++
                }
                if (rows.isNotEmpty()) out.add(Block.Table(rows))
            }
            l.matches(Regex("^([-*•]|\\d+[.)])\\s+.*")) -> {
                flushPara(); val items = ArrayList<String>(); val numbered = l[0].isDigit()
                while (i < lines.size) {
                    val t = lines[i].trim()
                    if (t.matches(Regex("^([-*•]|\\d+[.)])\\s+.*"))) items.add(t.replaceFirst(Regex("^([-*•]|\\d+[.)])\\s+"), ""))
                    else if (t.isNotEmpty() && lines[i].startsWith("  ") && items.isNotEmpty()) items[items.size - 1] = items.last() + " " + t   // wrapped item
                    else break
                    i++
                }
                out.add(Block.Bullets(items, numbered))
            }
            else -> { if (para.isNotEmpty()) para.append(' '); para.append(l); i++ }
        }
    }
    flushPara()
    return out
}

/** Inline **bold**, *italic* / _italic_, `code`, [text](url), and bare https links. */
private fun inline(text: String, base: Color, accent: Color, codeBg: Color): AnnotatedString = buildAnnotatedString {
    val rx = Regex("(\\*\\*(.+?)\\*\\*)|(`([^`]+)`)|(\\[([^\\]]+)]\\(([^)]+)\\))|(https?://[^\\s)]+)|((?<![\\w*])[*_]([^*_]+)[*_](?![\\w*]))")
    var last = 0
    for (m in rx.findAll(text)) {
        append(text.substring(last, m.range.first)); last = m.range.last + 1
        when {
            m.groups[2] != null -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = base)) { append(m.groups[2]!!.value) }
            m.groups[4] != null -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg, fontSize = 13.sp)) { append(m.groups[4]!!.value) }
            m.groups[6] != null -> { pushStringAnnotation("url", m.groups[7]!!.value); withStyle(SpanStyle(color = accent, textDecoration = TextDecoration.Underline)) { append(m.groups[6]!!.value) }; pop() }
            m.groups[8] != null -> { pushStringAnnotation("url", m.groups[8]!!.value); withStyle(SpanStyle(color = accent, textDecoration = TextDecoration.Underline)) { append(m.groups[8]!!.value) }; pop() }
            m.groups[10] != null -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(m.groups[10]!!.value) }
        }
    }
    append(text.substring(last))
}

@Composable
fun MarkdownText(text: String, modifier: Modifier = Modifier, fontSize: TextUnit = 15.sp, onOpenUrl: (String) -> Unit = {}) {
    val cs = MaterialTheme.colorScheme
    val base = cs.onSurface; val accent = Brand; val codeBg = cs.surfaceVariant
    val lineH = fontSize * 1.45f
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (b in parseBlocks(text)) when (b) {
            is Block.Heading -> Text(inline(b.text, base, accent, codeBg), color = base, fontWeight = FontWeight.SemiBold,
                fontSize = when (b.level) { 1 -> fontSize * 1.25f; 2 -> fontSize * 1.12f; else -> fontSize * 1.02f }, lineHeight = lineH * 1.1f,
                modifier = Modifier.padding(top = 4.dp))
            is Block.Para -> Linkified(inline(b.text, base, accent, codeBg), TextStyle(color = base, fontSize = fontSize, lineHeight = lineH), onOpenUrl)
            is Block.Bullets -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                b.items.forEachIndexed { n, it ->
                    Row(verticalAlignment = Alignment.Top) {
                        Text(if (b.numbered) "${n + 1}." else "•", color = accent, fontSize = fontSize, lineHeight = lineH, modifier = Modifier.width(if (b.numbered) 22.dp else 14.dp))
                        Linkified(inline(it, base, accent, codeBg), TextStyle(color = base, fontSize = fontSize, lineHeight = lineH), onOpenUrl, Modifier.weight(1f))
                    }
                }
            }
            is Block.Table -> {
                val cols = b.rows.maxOf { it.size }
                Column(Modifier.fillMaxWidth().background(cs.surfaceVariant.copy(alpha = 0.35f), RoundedCornerShape(10.dp)).horizontalScroll(rememberScrollState())) {
                    b.rows.forEachIndexed { r, row ->
                        Row(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                            for (c in 0 until cols) {
                                val cell = row.getOrElse(c) { "" }
                                Text(inline(cell, base, accent, codeBg), color = if (r == 0) cs.onSurfaceVariant else base, fontSize = fontSize * 0.9f, lineHeight = lineH * 0.9f,
                                    fontWeight = if (r == 0) FontWeight.SemiBold else FontWeight.Normal, modifier = Modifier.widthIn(min = 90.dp, max = 220.dp).padding(end = 14.dp))
                            }
                        }
                        if (r == 0) Box(Modifier.fillMaxWidth().height(1.dp).background(cs.outline.copy(alpha = 0.5f)))
                    }
                }
            }
            is Block.Code -> Text(b.text, color = base, fontFamily = FontFamily.Monospace, fontSize = fontSize * 0.85f, lineHeight = lineH * 0.9f,
                modifier = Modifier.fillMaxWidth().background(codeBg, RoundedCornerShape(8.dp)).horizontalScroll(rememberScrollState()).padding(10.dp))
            Block.Rule -> Box(Modifier.fillMaxWidth().height(1.dp).background(cs.outline.copy(alpha = 0.5f)))
        }
    }
}

@Composable
private fun Linkified(text: AnnotatedString, style: TextStyle, onOpenUrl: (String) -> Unit, modifier: Modifier = Modifier) {
    if (text.getStringAnnotations("url", 0, text.length).isEmpty()) Text(text, style = style, modifier = modifier)
    else ClickableText(text, style = style, modifier = modifier) { off -> text.getStringAnnotations("url", off, off).firstOrNull()?.let { onOpenUrl(it.item) } }
}
