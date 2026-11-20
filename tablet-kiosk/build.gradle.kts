plugins { id("com.android.application") }
android {
    namespace = "xyz.madineni.music.kiosk"
    compileSdk = 35
    defaultConfig {
        applicationId = "xyz.madineni.music.kiosk"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }
    buildTypes { getByName("release") { isMinifyEnabled = false } }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}
