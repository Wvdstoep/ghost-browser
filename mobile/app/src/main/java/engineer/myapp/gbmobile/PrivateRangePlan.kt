package engineer.myapp.gbmobile

/** Bounded, private-network-only target list for an on-device discovery run. */
data class PrivateRangePlan(val cidr: String, val hosts: List<String>) {
    companion object {
        fun parse(input: String): PrivateRangePlan? {
            val parts = input.trim().split('/')
            if (parts.size != 2) return null
            val prefix = parts[1].toIntOrNull() ?: return null
            if (prefix !in 24..32) return null
            val octets = parts[0].split('.').map { it.toIntOrNull() ?: return null }
            if (octets.size != 4 || octets.any { it !in 0..255 }) return null
            val address = octets.fold(0L) { value, octet -> (value shl 8) or octet.toLong() }
            val mask = (0xffffffffL shl (32 - prefix)) and 0xffffffffL
            val network = address and mask
            val size = 1L shl (32 - prefix)
            fun private(ip: Long): Boolean {
                val a = (ip ushr 24).toInt()
                val b = ((ip ushr 16) and 255).toInt()
                return (a == 10) || (a == 172 && b in 16..31) || (a == 192 && b == 168)
            }
            if (!private(network) || !private(network + size - 1)) return null
            val first = if (prefix <= 30) 1L else 0L
            val end = if (prefix <= 30) size - 1 else size
            val hosts = (first until end).map { offset ->
                val ip = network + offset
                "${ip ushr 24}.${(ip ushr 16) and 255}.${(ip ushr 8) and 255}.${ip and 255}"
            }
            return PrivateRangePlan("${network ushr 24}.${(network ushr 16) and 255}.${(network ushr 8) and 255}.${network and 255}/$prefix", hosts)
        }
    }
}
