plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.jeongguskbag.hwpeditor"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.jeongguskbag.hwpeditor"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    // 출시용 서명: 키 파일과 비밀번호는 저장소에 넣지 않고 환경 변수로만 받음
    // (GitHub Actions 에서는 Secrets → .github/workflows/release.yml 이 넘겨줌).
    // 값이 없으면 release 빌드는 서명 없이 만들어짐 (빌드 확인용).
    val releaseKeystore = System.getenv("HWPEDITOR_KEYSTORE_FILE")
    signingConfigs {
        if (!releaseKeystore.isNullOrBlank()) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("HWPEDITOR_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("HWPEDITOR_KEY_ALIAS")
                keyPassword = System.getenv("HWPEDITOR_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            if (!releaseKeystore.isNullOrBlank()) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}

// HWP 엔진(scripts/fetch-engine.sh 로 받음)이 없으면 빌드를 멈추고 알려 줌
val checkEngine by tasks.registering {
    val wasm = file("src/main/assets/www/engine/rhwp_bg.wasm")
    doLast {
        if (!wasm.exists()) throw GradleException("HWP engine missing: run scripts/fetch-engine.sh first")
    }
}
tasks.named("preBuild") { dependsOn(checkEngine) }
