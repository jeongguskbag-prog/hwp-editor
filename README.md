# HWP 편집기

휴대폰에서 HWP·HWPX 문서를 열고, 고치고, 저장하는 안드로이드 앱입니다.

## 구조
- **편집 화면 (웹)**: `app/src/main/assets/www/` — `index.html`, `editor.css`, `editor.js`
  - 페이지 그리기(보이는 쪽만), 눌러서 커서 놓기, 한글 조합 입력, 줄바꿈·지우기, **표 칸 편집(중첩 표 포함)**,
    되돌리기·다시 하기(엔진 스냅샷), HWP·HWPX 저장, 확대·축소
- **HWP 엔진**: [@rhwp/core](https://www.npmjs.com/package/@rhwp/core) 0.9.0 (MIT) — 26MB WebAssembly 라서 저장소에 넣지 않고
  `scripts/fetch-engine.sh` 가 빌드 때 받아 `assets/www/engine/` 에 넣음 (버전·sha512 고정)
- **안드로이드 앱 (Kotlin)**: `MainActivity.kt` — WebView 하나, 파일 열기·저장은 시스템 파일 선택기.
  권한 없음(인터넷 권한도 없음). 다른 앱에서 HWP·HWPX "열기" 지원

## 빌드
```bash
bash scripts/fetch-engine.sh      # 엔진 받기 (한 번)
./gradlew assembleDebug           # app/build/outputs/apk/debug/app-debug.apk
```
GitHub Actions(`.github/workflows/build.yml`)가 푸시·PR 마다 같은 순서로 빌드하고 Artifacts 에 `HwpEditor-debug` 를 올립니다.

## 출시용(서명) 빌드
- 패키지 이름: `com.jeongguskbag.hwpeditor` (Play 출시 후 변경 불가)
- 서명 정보는 GitHub Secrets 로만 받음: `HWPEDITOR_KEYSTORE_BASE64`, `HWPEDITOR_KEYSTORE_PASSWORD`, `HWPEDITOR_KEY_ALIAS`, `HWPEDITOR_KEY_PASSWORD`
- 만들기: Actions → **Release build** → Run workflow → Artifacts 의 `HwpEditor-release` 에 `app-release.aab`(Play 업로드용), `app-release.apk`, `mapping.txt`

## Play 스토어 출시
- 올리는 순서: `store/PLAY-UPLOAD.md` · 등록 문구·가격: `store/LISTING.md` · 테스터 모집: `store/TESTERS.md`
- 개인정보처리방침: `docs/privacy/index.html` → https://jeongguskbag-prog.github.io/hwp-editor/privacy/ (Settings → Pages → `main` / `docs`)
- 그래픽: `store/icon-512.png`, `store/feature-graphic-ko.png`, `store/feature-graphic-en.png`

## 브라우저에서 편집 화면만 시험하기
`app/src/main/assets/www/` 를 아무 정적 웹 서버로 열면 됩니다 (엔진을 받은 뒤). 파일 열기는 브라우저 파일 선택, 저장은 다운로드로 동작합니다.

## 법적 고지
- "한글", "한컴" 은 한글과컴퓨터의 상표이므로 앱 이름에 쓰지 않습니다.
- 앱 첫 화면에 HWP 공개 문서 참고 문구와 엔진(MIT)·오픈소스 라이선스를 표시합니다.

## 아직 없는 것
글자 서식(굵게·크기·색) 도구, 범위 선택·복사·붙여넣기, 표 행·열 편집, 그림 넣기, PDF 저장, 한국어 글꼴 내장
