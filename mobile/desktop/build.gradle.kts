// :desktop — the Compose Desktop app. Shares the design system + models + scaffold with the phone
// via :shared. The real Chromium browser (JCEF) and the desktop capabilities (CDP drag, self-saving
// downloads, upload_file) land in S8; Electron is retired in S9 once parity is verified.
import org.jetbrains.compose.desktop.application.dsl.TargetFormat
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.compose")
}

// Compile with the JDK Gradle already runs on (targeting 17 bytecode) — no toolchain download needed.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
tasks.withType<KotlinCompile>().configureEach { kotlinOptions.jvmTarget = "17" }

dependencies {
    implementation(project(":shared"))
    implementation(compose.desktop.currentOs)
    implementation(compose.material3)
    implementation(compose.materialIconsExtended)
    implementation("me.friwi:jcefmaven:127.3.1")   // S8: real Chromium (JCEF), natives auto-downloaded on first run
    implementation("org.json:json:20240303")        // parse device-hub command JSON
}

compose.desktop {
    application {
        mainClass = "engineer.myapp.gb.desktop.MainKt"
        // JCEF/AWT need these opens at runtime; the dev `run` task adds them but the packaged app does
        // not unless we bake them in — missing them is why the installed app crashed on launch.
        jvmArgs += listOf(
            "--add-opens=java.base/java.lang=ALL-UNNAMED",
            "--add-opens=java.base/java.util=ALL-UNNAMED",
            "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED",
            "--add-opens=java.desktop/java.awt=ALL-UNNAMED",
            "--add-opens=java.desktop/sun.awt=ALL-UNNAMED",
            "-Djava.awt.headless=false",
        )
        nativeDistributions {
            targetFormats(TargetFormat.Exe, TargetFormat.Msi)
            // Bundle only the JDK modules JCEF/skiko/networking need (keeps the installer < 100 MB for
            // GitHub, unlike includeAllModules). suggestModules found the first three; the rest are for
            // TLS/DNS/HTTP that JCEF uses at runtime but bytecode analysis misses.
            modules("java.instrument", "java.sql", "jdk.unsupported", "java.naming", "jdk.crypto.ec", "java.net.http", "jdk.zipfs")
            packageName = "Ghost Browser"
            packageVersion = "1.0.26"     // bump each release so the MSI upgrades in place (no manual uninstall)
            description = "Ghost Browser — one codebase, phone + desktop"
            vendor = "my-app.engineer"
            windows {
                menu = true                 // Start-menu shortcut
                menuGroup = "Ghost Browser"
                shortcut = true             // desktop shortcut
                perUserInstall = true       // installs without admin, into the user's profile
                dirChooser = true           // let the user pick the install location
                // Stable id so future versions UPGRADE the install instead of stacking copies.
                upgradeUuid = "8f2b1c4a-7d6e-4a3b-9c21-0a1b2c3d4e5f"
            }
        }
    }
}
