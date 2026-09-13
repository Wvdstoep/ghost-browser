plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "engineer.myapp.gbmobile"
    compileSdk = 34

    defaultConfig {
        applicationId = "engineer.myapp.gbmobile"
        minSdk = 26            // adaptive icon (v26) so no raster launcher assets needed; Android 8+
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// No external UI deps on purpose — a plain Activity + WebView keeps the build minimal and robust.
dependencies {
}
