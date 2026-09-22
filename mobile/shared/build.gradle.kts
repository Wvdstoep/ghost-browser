// :shared — the one codebase. Toolkit-independent design system + data models + (later) the engine
// core, sync, ring and journal, shared by the Android app, the Desktop app and (S10 POC) the WEB
// (the GB tool console). UI here is Compose Multiplatform; nothing Android-specific lives in commonMain.
import org.jetbrains.kotlin.gradle.targets.js.dsl.ExperimentalWasmDsl

plugins {
    id("org.jetbrains.kotlin.multiplatform")
    id("com.android.library")
    id("org.jetbrains.compose")
}

kotlin {
    androidTarget { compilations.all { kotlinOptions { jvmTarget = "17" } } }
    jvm("desktop") { compilations.all { kotlinOptions { jvmTarget = "17" } } }
    // S10 POC: the SAME Compose UI on the web via Kotlin/Wasm — one codebase, three targets.
    @OptIn(ExperimentalWasmDsl::class)
    wasmJs {
        moduleName = "gbweb"
        browser { commonWebpackConfig { outputFileName = "gbweb.js" } }
        binaries.executable()
    }

    sourceSets {
        val commonMain by getting {
            dependencies {
                implementation(compose.runtime)
                implementation(compose.foundation)
                implementation(compose.material3)
                implementation(compose.ui)
                implementation(compose.materialIconsExtended)
            }
        }
        val wasmJsMain by getting {
            dependencies {
                // The web console talks to the cluster over same-origin fetch and parses the /v1 JSON
                // itself (commonMain deliberately carries no JSON lib). Coroutines await the fetch Promise.
                implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0")
            }
        }
        /*
         * AgentCore reads a model reply with a hand-rolled, string-level JSON reader, because
         * commonMain deliberately carries no parser (see above). A hand-rolled reader without tests
         * is how a brace inside a quoted string silently truncates a tool's arguments, so it gets
         * tests — and they run on the desktop JVM target, where the agent actually runs.
         */
        val commonTest by getting {
            dependencies { implementation(kotlin("test")) }
        }
    }
}

android {
    namespace = "engineer.myapp.gb.shared"
    compileSdk = 34
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
