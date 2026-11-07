plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.compose.compiler)
}

android {
  // Kotlin sources are shared with the inventory scanner; the install ID is
  // intentionally different so both APKs can coexist on one employee phone.
  namespace = "net.de5.nabta.inventoryscanner"
  compileSdk = 36
  defaultConfig {
    applicationId = "net.de5.nabta.expiryscanner"
    minSdk = 26
    targetSdk = 36
    versionCode = 4
    versionName = "1.0.3"
  }
  buildFeatures { compose = true; buildConfig = true }
  buildTypes {
    debug { buildConfigField("String", "DEFAULT_API_URL", "\"https://nabta-cloud-core.mahmoudnabih989.workers.dev\"") }
    release {
      isMinifyEnabled = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      buildConfigField("String", "DEFAULT_API_URL", "\"https://nabta-cloud-core.mahmoudnabih989.workers.dev\"")
    }
  }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlin { jvmToolchain(17) }
}

dependencies {
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.lifecycle.runtime)
  implementation(libs.androidx.lifecycle.viewmodel)
  implementation(platform(libs.androidx.compose.bom))
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.compose.material3)
  implementation(libs.androidx.datastore)
  implementation(libs.androidx.security.crypto)
  implementation(libs.okhttp)
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.google.code.scanner)
  testImplementation(libs.junit)
  debugImplementation(libs.androidx.compose.ui.tooling)
}
