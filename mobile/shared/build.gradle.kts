// :shared — the one codebase. Toolkit-independent design system + data models + (later) the engine
// core, sync, ring and journal, shared by the Android app and the Desktop app. UI here is Compose
// Multiplatform; nothing Android-specific lives in commonMain.
plugins {
    id("org.jetbrains.kotlin.multiplatform")
    id("com.android.library")
    id("org.jetbrains.compose")
}

kotlin {
    androidTarget { compilations.all { kotlinOptions { jvmTarget = "17" } } }
    jvm("desktop") { compilations.all { kotlinOptions { jvmTarget = "17" } } }

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
