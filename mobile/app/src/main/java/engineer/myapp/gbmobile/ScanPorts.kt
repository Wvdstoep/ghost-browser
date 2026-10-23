package engineer.myapp.gbmobile

/** Small service presets for private-network discovery. */
object ScanPorts {
    val presets = linkedMapOf(
        "Common services" to listOf(21, 22, 23, 25, 53, 80, 139, 443, 445, 554, 3389, 5432, 5900, 6379, 8080, 8443, 8554),
        "Web" to listOf(80, 443, 8080, 8443),
        "Remote access" to listOf(22, 23, 3389, 5900),
        "Infrastructure" to listOf(21, 25, 53, 139, 445),
        "Databases" to listOf(3306, 5432, 6379, 27017),
        "Video services" to listOf(554, 8554),
    )

    fun parseCustom(value: String): List<Int>? {
        val tokens = value.split(',').map { it.trim() }
        if (tokens.isEmpty() || tokens.size > 24) return null
        val ports = tokens.map { it.toIntOrNull() ?: return null }
        if (ports.any { it !in 1..65535 }) return null
        return ports.distinct().takeIf { it.isNotEmpty() }
    }
}
