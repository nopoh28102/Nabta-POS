plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.serialization")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "net.de5.nabta.dokany"
  compileSdk = 36

  defaultConfig {
    applicationId = "net.de5.nabta.dokany"
    minSdk = 26
    targetSdk = 36
    versionCode = 6
    versionName = "1.3.2"
  }
  buildFeatures { buildConfig = true; compose = true }
  buildTypes {
    debug { buildConfigField("String", "DEFAULT_API_URL", "\"https://nabta-inventory-scanner-relay.mahmoudnabih989.workers.dev\"") }
    release {
      isMinifyEnabled = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      buildConfigField("String", "DEFAULT_API_URL", "\"https://nabta-inventory-scanner-relay.mahmoudnabih989.workers.dev\"")
    }
  }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlin { jvmToolchain(17) }
}

dependencies {
  implementation("androidx.core:core-ktx:1.17.0")
  implementation("androidx.activity:activity-ktx:1.12.1")
  implementation("androidx.activity:activity-compose:1.12.1")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
  implementation("androidx.security:security-crypto:1.1.0")
  implementation("androidx.webkit:webkit:1.14.0")
  implementation("com.squareup.okhttp3:okhttp:5.1.0")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
  implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
  implementation(platform("androidx.compose:compose-bom:2025.10.00"))
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
}
