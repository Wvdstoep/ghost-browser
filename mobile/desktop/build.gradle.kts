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
}

compose.desktop {
    application {
        mainClass = "engineer.myapp.gb.desktop.MainKt"
        nativeDistributions {
            targetFormats(TargetFormat.Exe, TargetFormat.Msi)
            packageName = "Ghost Browser"
            packageVersion = "1.0.0"
        }
    }
}
