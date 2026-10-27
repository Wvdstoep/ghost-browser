pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")   // Compose Multiplatform plugin
    }
}
dependencyResolutionManagement {
    // Kotlin/Wasm adds the Node distribution repository during task configuration.
    repositoriesMode.set(RepositoriesMode.PREFER_PROJECT)
    repositories {
        google()
        mavenCentral()
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")   // Compose Desktop (skiko) artifacts
    }
}
rootProject.name = "GBMobile"
include(":app")
include(":shared")     // S7: one codebase — toolkit-independent design system + logic (Android + Desktop)
include(":desktop")    // S7: Compose Desktop app (JCEF browser in S8; Electron retired in S9)
