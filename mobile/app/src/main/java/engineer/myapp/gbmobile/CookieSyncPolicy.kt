package engineer.myapp.gbmobile

/** A phone login is exported only after approval for this cluster and this browser profile. */
internal object CookieSyncPolicy {
    fun key(clusterUrl: String, profile: String): String = clusterUrl.trimEnd('/') + "|" + profile

    fun allows(approvals: Set<String>, clusterUrl: String, profile: String, sourceProfile: String = profile): Boolean =
        sourceProfile == profile && key(clusterUrl, profile) in approvals
}
