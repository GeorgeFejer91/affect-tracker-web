plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.jetbrains.kotlin.android)
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.meta.spatial.plugin)
}

android {
  namespace = "io.github.georgefejer91.affecttracker.vr"
  compileSdk = 34
  buildToolsVersion = "35.0.0"
  ndkVersion = "27.0.12077973"

  defaultConfig {
    applicationId = "io.github.georgefejer91.affecttracker.vr"
    minSdk = 34
    targetSdk = 34
    versionCode = 1
    versionName = "0.1.0-alpha.1"
    ndk { abiFilters += "arm64-v8a" }
  }

  buildTypes {
    getByName("release") {
      isMinifyEnabled = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  buildFeatures { compose = true }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions {
    jvmTarget = "17"
    // Polar BLE SDK 8.1.0 publishes a newer Kotlin metadata version while retaining the
    // Kotlin 2.1-compatible runtime ABI used by the pinned Spatial SDK project.
    freeCompilerArgs += "-Xskip-metadata-version-check"
  }
  packaging {
    resources.excludes.add("META-INF/LICENSE")
    resources.excludes.add("META-INF/LICENSE.md")
    resources.excludes.add("META-INF/LICENSE-notice.md")
  }
  sourceSets.getByName("main").jniLibs.srcDir("../native-lsl/target/jniLibs")
  sourceSets.getByName("test").resources.srcDir("../contracts")
  testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity.compose)
  implementation(platform(libs.androidx.compose.bom))
  implementation(libs.androidx.ui)
  implementation(libs.androidx.ui.tooling.preview)
  implementation(libs.androidx.material3)
  implementation(libs.androidx.documentfile)
  implementation(libs.androidx.media3.common)
  implementation(libs.androidx.media3.exoplayer)
  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.kotlinx.coroutines.rx3)
  implementation(libs.polar.ble.sdk)
  implementation(libs.meta.spatial.sdk.base)
  implementation(libs.meta.spatial.sdk.compose)
  implementation(libs.meta.spatial.sdk.isdk)
  implementation(libs.meta.spatial.sdk.toolkit)
  implementation(libs.meta.spatial.sdk.vr)
  testImplementation(libs.junit4)
  testImplementation(libs.json)
}

spatial { allowUsageDataCollection.set(false) }
