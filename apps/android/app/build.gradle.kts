import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "org.estia.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.estia.app"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // Il nucleo c'è solo per arm64: tutti i telefoni di questi anni.
        ndk { abiFilters += "arm64-v8a" }
    }

    buildTypes {
        release {
            // JNA e i legami di UniFFI si trovano per nome: niente R8 finché
            // non ci sono le regole per tenerli.
            isMinifyEnabled = false
        }
    }

    sourceSets["main"].java.srcDir("src/generato/kotlin")

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures { compose = true }

    packaging {
        // Le librerie native restano non compresse e allineate a 16 KB.
        jniLibs { useLegacyPackaging = false }
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    val bom = platform("androidx.compose:compose-bom:2025.05.01")
    implementation(bom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    // I legami di UniFFI chiamano il nucleo attraverso JNA.
    implementation("net.java.dev.jna:jna:5.17.0@aar")
}
