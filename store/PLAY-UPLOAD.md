# HWP 편집기 — Play 스토어에 올리는 순서

같이 보는 문서: 등록 문구·가격 `store/LISTING.md` · 테스터 모집 `store/TESTERS.md`
ApkVault 를 먼저 올렸다면 개발자 계정·결제 프로필은 이미 있으니 **③ 앱 만들기부터** 하면 됩니다.

## 0. 처음 한 번: 서명 키 등록 (출시용 빌드에 필요)

1. 받은 `secrets-to-add.txt` 를 열고, GitHub → **hwp-editor** → Settings → Secrets and variables → Actions →
   **New repository secret** 으로 4개 추가
   (`HWPEDITOR_KEYSTORE_BASE64`, `HWPEDITOR_KEYSTORE_PASSWORD`, `HWPEDITOR_KEY_ALIAS`, `HWPEDITOR_KEY_PASSWORD`)
2. `hwpeditor-upload.keystore` 와 비밀번호를 안전한 곳 두 군데 이상에 보관 (저장소에는 절대 올리지 않기)
3. GitHub → hwp-editor → Actions → **Release build** → Run workflow →
   끝나면 Artifacts 의 `HwpEditor-release` 에 `app-release.aab`(업로드용), `app-release.apk`(폰 설치용)

## 0-1. 처음 한 번: 개인정보처리방침 페이지 켜기
GitHub → hwp-editor → Settings → **Pages** → Source: Deploy from a branch → Branch `main`, 폴더 `/docs` → Save
→ 몇 분 뒤 https://jeongguskbag-prog.github.io/hwp-editor/privacy/ 가 열리는지 확인

## ①·② 개발자 계정, 결제 프로필
ApkVault 때 만든 것을 그대로 사용 (없으면 apk-extractor 저장소의 `store/PLAY-UPLOAD.md` ①·② 참고)

## ③ 앱 만들기
Play Console → 모든 앱 → **앱 만들기**

| 칸 | 입력 |
|---|---|
| 앱 이름 | `HWP 편집기 - 광고 없는 HWP·HWPX 편집` |
| 기본 언어 | 한국어 – ko-KR |
| 앱 또는 게임 | 앱 |
| 무료 또는 유료 | **유료** ← 꼭! |

## ④ 앱 설정 질문

| 항목 | 답 |
|---|---|
| 개인정보처리방침 | https://jeongguskbag-prog.github.io/hwp-editor/privacy/ |
| 앱 액세스 권한 | 모든 기능을 특별한 액세스 권한 없이 사용 가능 |
| 광고 | 아니요 |
| 콘텐츠 등급 | 카테고리 "기타(유틸리티·생산성 등)" → 폭력·성·약물·도박·사용자 간 소통 모두 아니요 → 전체이용가 |
| 타겟층 | 18세 이상 |
| 뉴스 / 정부 / 금융 / 건강 | 모두 아니요 |
| 데이터 보안 | 사용자 데이터 수집·공유 → **아니요** |
| 광고 ID | 아니요 |

권한 신고는 없습니다 (요청하는 권한이 하나도 없음).

## ⑤ 스토어 등록정보
- 이름·간단한 설명·자세한 설명: `LISTING.md` (한국어 → 기본, 영어 → 번역 추가)
- 아이콘 `store/icon-512.png`, 그래픽 이미지 `store/feature-graphic-ko.png`, 스크린샷 2장 이상
  (스크린샷은 **개인정보 없는 샘플 문서**로 찍기)
- 스토어 설정: 카테고리 **생산성**, 연락처 이메일
- 가격: 수익 창출 → 앱 가격 → 2,900원

## ⑥ 비공개 테스트 (12명 이상 · 14일 연속)
`TESTERS.md` 참고. ApkVault 테스터에게 같이 부탁해도 됩니다 (앱마다 따로 12명·14일 필요).
- 첫 버전 만들 때 **Play 앱 서명**은 기본값("Google에서 생성한 키") 그대로
- `app-release.aab` 는 15MB 안팎 (HWP 엔진 포함). 크기 제한(150MB)과는 거리가 멉니다

## ⑦ 프로덕션 신청 → ⑧ 정식 출시
14일 지나면 대시보드 → 프로덕션 액세스 신청 → 승인 후 프로덕션 트랙에 같은 버전 출시

## 업데이트할 때
`app/build.gradle.kts` 의 **versionCode +1** (versionName 1.0.0 → 1.0.1 등) → Release build → 새 AAB 업로드
