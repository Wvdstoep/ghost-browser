plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "engineer.myapp.gbmobile"
    compileSdk = 34

    defaultConfig {
        applicationId = "engineer.myapp.gbmobile"
        minSdk = 26
        targetSdk = 34
        versionCode = 44
        versionName = "0.32"
    }

    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    // Jetpack Compose lives alongside the existing view-binding UI (incremental migration, not a big-bang
    // rewrite): new screens are Compose, old ones keep working until they are ported.
    buildFeatures { viewBinding = true; compose = true }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.14" }   // matches Kotlin 1.9.24
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.6")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("com.google.mediapipe:tasks-genai:0.10.24")   // on-device Gemma (LLM Inference)

    // --- Jetpack Compose (foundation for the new UI: run sheet, settings, results) ---
    implementation(platform("androidx.compose:compose-bom:2024.09.02"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.compose.runtime:runtime-livedata")   // observeAsState for LiveData in Compose
    debugImplementation("androidx.compose.ui:ui-tooling")
}
