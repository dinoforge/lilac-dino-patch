# DinoPatch Windows EXE 빌드 전 점검 (CI 절약)

이 문서는 `feature/dino-windows-build-preflight` 개발 브랜치의 절차입니다.
실행 파일은 기존 공식 LilacAnime 설치본의 `app.asar`를 안전하게 패치하는
**독립 Rust 관리자**입니다. 공식 앱 실행 파일, 원본 ASAR 또는 영상 파일은
DinoPatch에 포함하지 않습니다.

## 1. 로컬 사전 점검 (CI 0분)

Node.js 22 이상으로 저장소 루트에서 실행합니다.

```bash
node scripts/dino-release-preflight.cjs
```

이 명령은 외부 npm 의존성 설치 없이 다음을 검사합니다.

- 패치 모듈 5개의 SHA-256과 manifest가 정확히 일치하는지
- Rust `include_bytes!` 및 `include_str!`로 모든 패치 파일이 EXE에 포함되는지
- Windows GUI 서브시스템 설정과 수동 전용 빌드 워크플로
- SQLite 작품 데이터, 공급원 수동 분리, 오래된 캐시 복원, 최신 회차 갱신
- 검색·설정 호환성과 네이티브 GUI 계약 테스트

Rust 툴체인이 있는 개발용 PC에서는 다음처럼 CLI 엔진 테스트도 추가할 수 있습니다.

```bash
node scripts/dino-release-preflight.cjs --rust
```

이때 Rust 검사는 `cargo test --no-default-features`이고 Windows GUI
바이너리를 만들지 않습니다. 테스트 중 실제 공식 앱은 수정하지 않습니다.

## 2. Windows GUI 로컬 빌드

Windows에 Rust stable이 설치돼 있고 1단계를 통과했을 때:

```powershell
cd tools/dino-patch-manager/native-rust
cargo fmt --all
cargo build --release --features gui
```

생성 파일: `target/release/dino-native-manager.exe`.

GUI 버전에는 `#![cfg_attr(all(windows, feature = "gui"), windows_subsystem = "windows")]`
설정을 적용하므로 CMD 창을 따로 열지 않습니다.
Windows PE 헤더 검사 및 앱 시작 테스트를 통과하기 전에는 이를 최종 검증된
실행 파일로 표시하지 않습니다.

## 3. GitHub Actions를 한 번만 사용할 때

GitHub 저장소 **Actions**에서 `Package DinoPatch Rust-native Windows UI`의
**Run workflow**를 선택하고
`feature/dino-windows-build-preflight` 브랜치를 지정합니다.
이 워크플로는 `workflow_dispatch`만 사용합니다. 푸시/PR에서는
자동 실행되지 않습니다.

1. 저렴한 Ubuntu 사전 검사가 먼저 실행됩니다.
2. 모든 검사가 통과해야 Windows-2025 Rust GUI 컴파일을 시작합니다.
3. Windows GUI PE 서브시스템 `2` 확인과 무효 ASAR 테스트를 진행합니다.
4. 성공 시 `DinoPatch-Rust-Native-Windows-TEST` 아티팩트에 Windows ZIP이 저장됩니다.

Windows 빌드·시작 점검을 통과해도 공식 앱 모든 버전에 대한 호환을 의미하지
않습니다. 현재 Rust 패치 엔진은 미리 검증한 공식 버전 지문만 허용하며,
그 외 버전이나 손상된 `app.asar`에는 쓰지 않습니다.

## 배포 전 안전 점검

- 원본 설치본이 아닌 **복사본**으로 패치 적용·해제·복구를 확인합니다.
- 기존 LilacAnime 프로필, 한국어 제목 캐시, SQLite DB, 관리자 백업을 삭제하지 않습니다.
- 실제 Windows 설치에서 CMD 숨김, 권한 오류, 초기 실행, 재시작, 백업 복원을 확인합니다.
- 실제 Windows EXE 빌드 및 공식 원본 실사용 테스트가 끝나기 전에는 Beta 8 정식 배포를 하지 않습니다.
