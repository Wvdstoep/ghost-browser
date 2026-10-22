package engineer.myapp.gbmobile.ui

data class VisitedPage(val url: String, val title: String)

/** Keep address suggestions local to the active browser profile. Callers supply only that profile's visits. */
object VisitedHistory {
    fun add(recent: List<VisitedPage>, page: VisitedPage, limit: Int = 300): List<VisitedPage> {
        if (page.url.length > 2048 || !(page.url.startsWith("https://") || page.url.startsWith("http://"))) return recent
        return (listOf(page) + recent.filterNot { it.url == page.url }).take(limit)
    }

    fun match(recent: List<VisitedPage>, query: String, limit: Int = 8): List<VisitedPage> {
        val term = query.trim()
        if (term.isBlank()) return emptyList()
        return recent.filter { it.url.contains(term, ignoreCase = true) || it.title.contains(term, ignoreCase = true) }.take(limit)
    }
}
