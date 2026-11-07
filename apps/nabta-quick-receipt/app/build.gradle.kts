plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.serialization")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "net.de5.nabta.quickreceive"
  compileSdk = 36

  defaultConfig {
    applicationId = "net.de5.nabta.quickreceive"
    minSdk = 26
    targetSdk = 36
    versionCode = 2
    versionName = "1.1.0"
  }
  buildFeatures { compose = true; buildConfig = true }
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
  sourceSets {
    getByName("main") {
      java.srcDir(file("../../nabta-inventory-scanner/app/src/main/java"))
      res.srcDir(file("../../nabta-inventory-scanner/app/src/main/res"))
    }
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.17.0")
  implementation("androidx.activity:activity-compose:1.12.1")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
  implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
  implementation(platform("androidx.compose:compose-bom:2025.10.00"))
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.datastore:datastore-preferences:1.1.7")
  implementation("androidx.security:security-crypto:1.1.0")
  implementation("com.squareup.okhttp3:okhttp:5.1.0")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
  implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
  debugImplementation("androidx.compose.ui:ui-tooling")
}
