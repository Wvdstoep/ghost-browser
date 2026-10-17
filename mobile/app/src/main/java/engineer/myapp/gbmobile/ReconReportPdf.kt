package engineer.myapp.gbmobile

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.widget.Toast
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object ReconReportPdf {

    private const val PAGE_WIDTH = 595 // A4 standard width (pt)
    private const val PAGE_HEIGHT = 842 // A4 standard height (pt)
    private const val MARGIN_X = 40f
    private const val PRINT_WIDTH = PAGE_WIDTH - (MARGIN_X * 2) // 515 pt

    /**
     * Generates a multi-page PDF document for a Security Recon Audit report
     * and saves it directly to the Android device's Downloads directory.
     */
    fun exportAndOpen(
        context: Context,
        targetUrl: String,
        modelName: String,
        reportText: String,
        detailsText: String
    ): Uri? {
        try {
            val doc = PdfDocument()
            var pageNumber = 1
            var pageInfo = PdfDocument.PageInfo.Builder(PAGE_WIDTH, PAGE_HEIGHT, pageNumber).create()
            var page = doc.startPage(pageInfo)
            var canvas = page.canvas

            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG)

            var y = 0f

            fun startNewPage() {
                paint.color = android.graphics.Color.parseColor("#94A3B8")
                paint.textSize = 8.5f
                paint.typeface = Typeface.DEFAULT
                canvas.drawText(
                    "Ghost Browser Mobile Security Recon Engine • Page $pageNumber",
                    MARGIN_X,
                    PAGE_HEIGHT - 25f,
                    paint
                )

                doc.finishPage(page)
                pageNumber++
                pageInfo = PdfDocument.PageInfo.Builder(PAGE_WIDTH, PAGE_HEIGHT, pageNumber).create()
                page = doc.startPage(pageInfo)
                canvas = page.canvas

                // Continuation header
                paint.color = android.graphics.Color.parseColor("#0F172A")
                canvas.drawRect(0f, 0f, PAGE_WIDTH.toFloat(), 35f, paint)

                paint.color = android.graphics.Color.WHITE
                paint.textSize = 10f
                paint.typeface = Typeface.DEFAULT_BOLD
                canvas.drawText("GHOST BROWSER • SECURITY RECON AUDIT (CONT.)", MARGIN_X, 22f, paint)

                y = 55f
            }

            // 1. TOP HEADER BANNER
            paint.color = android.graphics.Color.parseColor("#0F172A") // Dark Navy
            canvas.drawRect(0f, 0f, PAGE_WIDTH.toFloat(), 70f, paint)

            // Accent stripe
            paint.color = android.graphics.Color.parseColor("#E5484D") // Crimson
            canvas.drawRect(0f, 66f, PAGE_WIDTH.toFloat(), 70f, paint)

            paint.color = android.graphics.Color.WHITE
            paint.textSize = 15f
            paint.typeface = Typeface.DEFAULT_BOLD
            canvas.drawText("GHOST BROWSER • SECURITY RECON AUDIT", MARGIN_X, 32f, paint)

            paint.color = android.graphics.Color.parseColor("#94A3B8")
            paint.textSize = 9.5f
            paint.typeface = Typeface.DEFAULT
            val nowStr = SimpleDateFormat("yyyy-MM-dd HH:mm:ss z", Locale.US).format(Date())
            canvas.drawText("Automated Red Team & Perimeter Vulnerability Assessment  •  $nowStr", MARGIN_X, 50f, paint)

            y = 90f

            // 2. METADATA INFO CARD
            val metaRect = RectF(MARGIN_X, y, MARGIN_X + PRINT_WIDTH, y + 54f)
            paint.color = android.graphics.Color.parseColor("#F8FAFC")
            canvas.drawRoundRect(metaRect, 6f, 6f, paint)
            paint.style = Paint.Style.STROKE
            paint.color = android.graphics.Color.parseColor("#E2E8F0")
            paint.strokeWidth = 1f
            canvas.drawRoundRect(metaRect, 6f, 6f, paint)
            paint.style = Paint.Style.FILL

            paint.color = android.graphics.Color.parseColor("#334155")
            paint.textSize = 9.5f
            paint.typeface = Typeface.DEFAULT_BOLD
            val displayTarget = if (targetUrl.isNotBlank()) targetUrl else "Current Web Target"
            canvas.drawText("TARGET: $displayTarget", MARGIN_X + 14f, y + 20f, paint)

            paint.color = android.graphics.Color.parseColor("#64748B")
            paint.typeface = Typeface.DEFAULT
            val auditorModel = if (modelName.isNotBlank()) modelName else "glm-5.2"
            canvas.drawText("AUDITOR: Mobile Security Recon Agent  •  AI ENGINE: $auditorModel", MARGIN_X + 14f, y + 38f, paint)

            y += 72f

            // 3. SECTION HEADER
            paint.color = android.graphics.Color.parseColor("#0F172A")
            paint.textSize = 12f
            paint.typeface = Typeface.DEFAULT_BOLD
            canvas.drawText("AUDIT FINDINGS & RECOMMENDED ACTIONS", MARGIN_X, y, paint)
            y += 14f

            paint.color = android.graphics.Color.parseColor("#CBD5E1")
            canvas.drawLine(MARGIN_X, y, MARGIN_X + PRINT_WIDTH, y, paint)
            y += 18f

            // 4. PARSE AND RENDER REPORT LINES
            val lines = reportText.split("\n")
            for (rawLine in lines) {
                val line = rawLine.trim()
                if (line.isBlank()) {
                    y += 6f
                    continue
                }

                // Filter out raw action cards JSON syntax from PDF body
                if (line.startsWith("cards:") || line.startsWith("{ kind:") || line == "{" || line == "}" || line == "]" || line.startsWith("Interactive Action Cards")) {
                    continue
                }

                // Render horizontal markdown dividers
                if (line == "---" || line == "***" || line == "___") {
                    y += 4f
                    paint.color = android.graphics.Color.parseColor("#E2E8F0")
                    canvas.drawLine(MARGIN_X, y, MARGIN_X + PRINT_WIDTH, y, paint)
                    y += 10f
                    continue
                }

                if (y > PAGE_HEIGHT - 60f) {
                    startNewPage()
                }

                val lower = line.lowercase()
                val isCritical = lower.startsWith("critical") || lower.contains("critical") || lower.contains("🔴")
                val isHigh = lower.startsWith("high") || lower.contains("high") || lower.contains("🟠")
                val isMedium = lower.startsWith("medium") || lower.contains("medium") || lower.contains("🟡")
                val isLow = lower.startsWith("low") || lower.contains("low") || lower.contains("🟢")

                val hasSeverityPrefix = isCritical || isHigh || isMedium || isLow

                if (hasSeverityPrefix && (line.contains("min") || line.contains("REST") || line.contains("WP") || line.contains("Direct") || line.contains("Block") || line.contains("Disable") || line.contains("Add") || line.contains("Remove") || line.contains("Run") || line.contains("Exposure") || line.contains("Policy") || line.contains("Surface"))) {
                    val (badgeText, badgeColor) = when {
                        isCritical -> "CRITICAL" to "#EF4444"
                        isHigh -> "HIGH" to "#EA580C"
                        isMedium -> "MEDIUM" to "#F59E0B"
                        else -> "LOW" to "#06B6D4"
                    }

                    // Draw pill badge
                    val badgeRect = RectF(MARGIN_X, y - 10f, MARGIN_X + 54f, y + 4f)
                    paint.color = android.graphics.Color.parseColor(badgeColor)
                    canvas.drawRoundRect(badgeRect, 3f, 3f, paint)

                    paint.color = android.graphics.Color.WHITE
                    paint.textSize = 8f
                    paint.typeface = Typeface.DEFAULT_BOLD
                    canvas.drawText(badgeText, MARGIN_X + 6f, y, paint)

                    // Draw rest of the text, stripping Markdown syntax for clean print
                    var cleanText = line
                        .replace(Regex("""^(critical|high|medium|low|[🔴🟠🟡🟢ℹ️\s])+""", RegexOption.IGNORE_CASE), "")
                        .replace(Regex("""^[|:\[\]·•\-]+\s*"""), "")
                        .replace(Regex("""\*\*([^*]+)\*\*"""), "$1")
                        .replace(Regex("""\*([^*]+)\*"""), "$1")
                        .replace(Regex("""`([^`]+)`"""), "$1")
                        .trim()

                    textPaint.color = android.graphics.Color.parseColor("#1E293B")
                    textPaint.textSize = 9.5f
                    textPaint.typeface = Typeface.DEFAULT_BOLD

                    val textX = MARGIN_X + 62f
                    val availableWidth = (PRINT_WIDTH - 64f).toInt()

                    val sl = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        StaticLayout.Builder.obtain(cleanText, 0, cleanText.length, textPaint, availableWidth).build()
                    } else {
                        @Suppress("DEPRECATION")
                        StaticLayout(cleanText, textPaint, availableWidth, Layout.Alignment.ALIGN_NORMAL, 1f, 0f, false)
                    }

                    canvas.save()
                    canvas.translate(textX, y - 10f)
                    sl.draw(canvas)
                    canvas.restore()

                    y += (sl.height + 10f).coerceAtLeast(18f)
                } else {
                    // Regular paragraph or heading
                    val isHeading = line.startsWith("#") || (line.endsWith(":") && line.length < 50 && !line.contains("http"))
                    var cleanText = line
                        .replace(Regex("""^#+\s*"""), "")
                        .replace(Regex("""\*\*([^*]+)\*\*"""), "$1")
                        .replace(Regex("""\*([^*]+)\*"""), "$1")
                        .replace(Regex("""`([^`]+)`"""), "$1")
                        .trim()

                    if (isHeading) {
                        y += 4f
                    }

                    textPaint.color = if (isHeading) android.graphics.Color.parseColor("#0F172A") else android.graphics.Color.parseColor("#334155")
                    textPaint.textSize = if (isHeading) 10.5f else 9f
                    textPaint.typeface = if (isHeading) Typeface.DEFAULT_BOLD else Typeface.DEFAULT

                    val sl = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        StaticLayout.Builder.obtain(cleanText, 0, cleanText.length, textPaint, PRINT_WIDTH.toInt()).build()
                    } else {
                        @Suppress("DEPRECATION")
                        StaticLayout(cleanText, textPaint, PRINT_WIDTH.toInt(), Layout.Alignment.ALIGN_NORMAL, 1f, 0f, false)
                    }

                    if (y + sl.height > PAGE_HEIGHT - 60f) {
                        startNewPage()
                    }

                    canvas.save()
                    canvas.translate(MARGIN_X, y - 8f)
                    sl.draw(canvas)
                    canvas.restore()

                    y += sl.height + (if (isHeading) 6f else 4f)
                }
            }

            // 5. TECHNICAL DETAILS & EVIDENCE SECTION (if available)
            if (detailsText.isNotBlank()) {
                y += 10f
                if (y > PAGE_HEIGHT - 100f) startNewPage()

                paint.color = android.graphics.Color.parseColor("#0F172A")
                paint.textSize = 11f
                paint.typeface = Typeface.DEFAULT_BOLD
                canvas.drawText("TECHNICAL DETAILS & EVIDENCE", MARGIN_X, y, paint)
                y += 12f

                paint.color = android.graphics.Color.parseColor("#CBD5E1")
                canvas.drawLine(MARGIN_X, y, MARGIN_X + PRINT_WIDTH, y, paint)
                y += 14f

                textPaint.color = android.graphics.Color.parseColor("#475569")
                textPaint.textSize = 8.5f
                textPaint.typeface = Typeface.MONOSPACE

                val detailLines = detailsText.split("\n")
                for (dl in detailLines) {
                    val cleanDetail = dl.trim()
                    if (cleanDetail.isBlank()) continue

                    val sl = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        StaticLayout.Builder.obtain(cleanDetail, 0, cleanDetail.length, textPaint, PRINT_WIDTH.toInt()).build()
                    } else {
                        @Suppress("DEPRECATION")
                        StaticLayout(cleanDetail, textPaint, PRINT_WIDTH.toInt(), Layout.Alignment.ALIGN_NORMAL, 1f, 0f, false)
                    }

                    if (y + sl.height > PAGE_HEIGHT - 60f) startNewPage()

                    canvas.save()
                    canvas.translate(MARGIN_X, y)
                    sl.draw(canvas)
                    canvas.restore()

                    y += sl.height + 4f
                }
            }

            // Footer on the last page
            paint.color = android.graphics.Color.parseColor("#94A3B8")
            paint.textSize = 8.5f
            paint.typeface = Typeface.DEFAULT
            canvas.drawText(
                "Ghost Browser Mobile Security Recon Engine • Page $pageNumber (End of Report)",
                MARGIN_X,
                PAGE_HEIGHT - 25f,
                paint
            )

            doc.finishPage(page)

            // 6. SAVE TO DOWNLOADS VIA MEDIASTORE
            val out = ByteArrayOutputStream()
            doc.writeTo(out)
            doc.close()
            val pdfBytes = out.toByteArray()

            val sanitizedHost = targetUrl.replace(Regex("^https?://"), "").replace(Regex("[^a-zA-Z0-9.-]"), "_").take(30).ifBlank { "target" }
            val timeTag = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
            val filename = "Recon_Audit_${sanitizedHost}_${timeTag}.pdf"

            val uri = savePdfToDownloads(context, filename, pdfBytes)

            if (uri != null) {
                Toast.makeText(context, "Saved $filename to Downloads", Toast.LENGTH_LONG).show()
                openPdfViewer(context, uri)
            } else {
                Toast.makeText(context, "Could not save PDF to Downloads", Toast.LENGTH_SHORT).show()
            }

            return uri
        } catch (e: Exception) {
            Toast.makeText(context, "Error generating PDF: ${e.message}", Toast.LENGTH_SHORT).show()
            return null
        }
    }

    private fun savePdfToDownloads(context: Context, filename: String, bytes: ByteArray): Uri? {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, filename)
                    put(MediaStore.Downloads.MIME_TYPE, "application/pdf")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = context.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                if (uri != null) {
                    resolver.openOutputStream(uri)?.use { it.write(bytes) }
                    values.clear()
                    values.put(MediaStore.Downloads.IS_PENDING, 0)
                    resolver.update(uri, values, null, null)
                    uri
                } else null
            } else {
                @Suppress("DEPRECATION")
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                if (!dir.exists()) dir.mkdirs()
                val file = File(dir, filename)
                file.writeBytes(bytes)
                Uri.fromFile(file)
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun openPdfViewer(context: Context, uri: Uri) {
        try {
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/pdf")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(Intent.createChooser(intent, "Open Security Recon Report"))
        } catch (e: Exception) {
            // Toast already shown
        }
    }
}
