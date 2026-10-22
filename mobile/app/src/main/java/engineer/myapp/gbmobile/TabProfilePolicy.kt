package engineer.myapp.gbmobile

/** A generic new-tab action never inherits the profile of the current tab. */
internal object TabProfilePolicy {
    fun forNewTab(explicitProfile: String? = null): String =
        explicitProfile?.takeIf { it.isNotBlank() } ?: "default"
}
