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
        versionCode = 2
        versionName = "0.2"
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

dependencies {
    // Embedded HTTP server — the device exposes the Ghost Browser API so the backend can drive it.
    implementation("org.nanohttpd:nanohttpd:2.3.1")
}
