# A35-final 소스 이관 검토

검토일: 2026-11-05

저장소: `dinoforge/lilac-dino-patch` (private)

대상 브랜치: `chore/a35-source-import`

대상 커밋: `134cc48361953eff33cf5a89b1ab6e9d8e2bf4cd`

기준 `main`: `15885e99313e17c1ed750ec44fdf34fe3a8f451f`

## 판정 요약

| 항목 | 결과 |
|---|---|
| 이관 범위 | 관리자·패치 고유 파일 32개로 제한됨. 공식 LilacAnime 전체 소스, 배포 바이너리, ZIP은 이관되지 않음 |
| A35 대응 | Electron 실행 파일과 `app.asar`는 독립 실험 빌드에서 A35와 SHA-256 일치. Python 엔진 바이너리는 불일치 |
| 독립 빌드 | 임시 복제본에서 수동 경로 조정 후 패키징 완료. 기본 스크립트는 고정 개발 경로 때문에 다른 checkout에서 직접 실행할 수 없음 |
| 테스트 | Python 63/63, 관리자 UI 21/21 통과. 전체 `npm test`는 1개 실패·14개 건너뜀. 공식 계약 테스트 10개는 공식 v0.5.58 원본 부재로 건너뜀 |
| 패키지 실행 | 빌드된 엔진의 읽기 전용 `info` 요청이 manifest 경로 오류로 실패. GUI 통합 실행은 하지 않음 |
| 보안·권리 | 이관 파일의 비밀정보 패턴 검사에서 일치 0건. 공개 배포 권리는 미확정이며 저장소는 private 유지 필요 |
| `main` 병합 준비 | **준비되지 않음.** 전체 테스트 실패, 계약 검사 누락, 번들 엔진 실행 실패, 빌드 환경의 고정 경로·미고정 도구가 남아 있음 |

## 저장소와 변경 범위

GitHub 저장소는 private이고 기본 브랜치는 `main`이다. 이관 브랜치는 검토 시점에 위 커밋을 가리켰으며 `main`은 기준 SHA를 유지했다. 이관 커밋은 32개 경로를 추가하거나 수정한다.

```text
.gitattributes
A35_SOURCE_PROVENANCE.md
patches/patch03/manifest.json
patches/patch03/patch03-bridge.js
scripts/validate-patch03-clean-source.cjs
src/integrated-search.css
src/integrated-search.js
tests/dino-manager-ui.test.cjs
tests/patch03-clean-source.contract.test.cjs
tests/patch03-providers-live.electron.cjs
tools/dino-patch-manager/README.md
tools/dino-patch-manager/build-electron.cjs
tools/dino-patch-manager/build_electron_windows.ps1
tools/dino-patch-manager/electron-app/index.html
tools/dino-patch-manager/electron-app/main.cjs
tools/dino-patch-manager/electron-app/manager.css
tools/dino-patch-manager/electron-app/package-lock.json
tools/dino-patch-manager/electron-app/package.json
tools/dino-patch-manager/electron-app/preload.cjs
tools/dino-patch-manager/electron-app/renderer.js
tools/dino-patch-manager/electron-app/theme-leveldb.cjs
tools/dino-patch-manager/electron-app/windows-path.cjs
tools/dino-patch-manager/manager_bridge.py
tools/dino-patch-manager/manager_core.py
tools/dino-patch-manager/tests/electron-profile-isolation-v055.smoke.cjs
tools/dino-patch-manager/tests/electron-source-change-reapply.smoke.cjs
tools/dino-patch-manager/tests/electron_ui_smoke.cjs
tools/dino-patch-manager/tests/fixtures/legacy_tk/build_windows.ps1
tools/dino-patch-manager/tests/fixtures/legacy_tk/manager_gui.py
tools/dino-patch-manager/tests/test_manager.py
tools/dino-patch-manager/tests/test_manager_bridge.py
tools/dino-patch-manager/tests/theme-leveldb-electron.integration.cjs
```

관리자 Electron UI, Python 엔진·브리지, 패치 데이터, 계약·회귀 테스트와 빌드 스크립트가 중심이다. `tests/fixtures/legacy_tk/`의 두 파일은 일부 과거 Python 테스트 계약에만 사용되는 fixture이며 A35 실행 파일이나 Electron 빌드 입력이 아니다. `tests/patch03-providers-live.electron.cjs`는 이 검토에서 실행하거나 공급원에 접속하지 않았다.

## A35 산출물과 소스의 대응 증거

이관 브랜치의 [`A35_SOURCE_PROVENANCE.md`](A35_SOURCE_PROVENANCE.md)는 기존 A35-final Windows ZIP과 패키지를 읽기 전용으로 조사한 기록이다. 기록된 기준은 ZIP `2A31616982AA16BC759FF8608E66D6FD7F646537E5336AD2CD71642B3D037D48`, EXE `295CD7770FC3A36C8F3BB0137ED1E62DF9F501B6E0A7065544436ED02D15BA2B`, `app.asar` `7F473EE769716163D7BD93BD1D8064262BAEE05DB1E2361F4F425AF2E7E1B548`, 엔진 `E598A103B804AE5A8FBA99DF1E14C225C3997613B26202B89AA054DF144585E1`이다. 이번 검토에서는 A35 배포 폴더나 ZIP을 빌드 입력·출력으로 사용하지 않았다.

분류 결과:

1. **A35와 바이트 단위 대응:** 기존 기록에서 Electron `index.html`, `main.cjs`, `manager.css`, `preload.cjs`, `renderer.js`, `theme-leveldb.cjs`, `windows-path.cjs` 7개가 ASAR와 이관 소스 간 일치했다. 패치 manifest, 통합 검색 JS/CSS, bridge, validator, 공식 계약 테스트 등 런타임 자산 6개도 기존 A35 번들과 SHA-256 일치로 기록되어 있다.
2. **A35 컴파일 코드 구조 대응:** 기존 기록은 Python 3.14.7로 A35 PyInstaller 아카이브의 `manager_bridge`와 `manager_core` 코드 객체를 현재 이관 소스와 재귀 비교해 구조적 일치를 확인했다. Python 원문 주석·공백이나 빌드 당시 입력 파일의 바이트 동일성을 증명하지는 않는다.
3. **A35 빌드 입력으로 부합:** `manager_bridge.py`, 관리자 Electron 파일, 패치 manifest/모듈, validator 및 테스트는 현재 빌드 스크립트가 참조하거나 패키지하는 자료다. 이것은 A35 당시 실제 사용된 파일 해시 매니페스트나 빌드 로그를 대신하지 않는다.
4. **테스트·유지보수 자료:** Python·Node UI·Electron 격리·LevelDB 테스트와 README는 유지보수 자료다. 테스트가 있다는 사실은 과거 A35 산출물의 입력이었다는 증거가 아니다.
5. **대응 불명확:** 빌드 스크립트, README, fixture 및 일부 테스트는 당시 A35에 포함되거나 실행됐다는 서명된 입력 기록이 없다. 새 실험 패키지의 엔진 바이너리도 A35 엔진과 해시가 다르다.

이번 Temp 실험 패키지에서 Electron 실행 EXE와 `resources/app.asar`는 각각 A35 기준과 SHA-256이 정확히 일치했다. 새 PyInstaller 엔진 EXE 해시는 `3FF35C2BA94EEB42287CFF1B6DC906101AE899E9F8D97ACF3CB7CD583F10CF7B`로 A35의 `E598…`과 다르다. 따라서 A35 전체 Windows 패키지가 바이트 단위로 재현됐다고 볼 수 없다.

## 보안·개인정보·권리

- 이관 32개 경로에 대해 토큰, API 자격 증명, 개인키, bearer 값 등 명백한 비밀정보 패턴을 검색했고 일치 항목은 없었다. 이는 정해진 패턴 검색 결과이며 전체 보안 감사를 뜻하지 않는다.
- 사용자 계정명, 개인 AppData, 프로필·쿠키, 사용자 백업, 임시 테스트 데이터, 관리자 EXE/ZIP은 이관 커밋에서 확인되지 않았다. 개발 경로 상수 `D:\Codex-Coding-Folder\LilacAnime-Player`와 `D:\Codex-Coding-Folder\tools\python314-build\Scripts\`는 빌드 스크립트 및 엔진에 남아 있다. `D:\LilacAnime`는 엔진의 보호 경로로 쓰인다.
- `tools/dino-patch-manager/electron-app/package.json`은 `UNLICENSED`다. 기존 [`docs/RIGHTS_REVIEW.md`](docs/RIGHTS_REVIEW.md)는 upstream 원본 코드·에셋·공급원 이용 및 재배포 권리를 확정할 근거가 부족하다고 기록한다. 패키지 잠금 파일의 라이선스 metadata는 권리 허가나 전이 의존성 전체의 고지 검토를 대신하지 않는다.
- 저장소의 private 상태와 Actions 권리 gate를 유지한다. 공개 Release, 태그, 공개 다운로드 또는 권리 gate 변경을 수행하지 않았다.

## 빌드 입력과 독립성

관리자 Electron lock은 `classic-level` 3.0.0과 Electron 38.8.6을 고정한다. 빌드 스크립트는 루트 `node_modules`의 Electron/electron-builder를 요구하며, 루트 lock에서 확인된 electron-builder는 26.15.3이다. Windows 스크립트는 프로젝트 루트 `D:\Codex-Coding-Folder\LilacAnime-Player`와 외부 Python/PyInstaller 경로를 고정하고 Node 버전을 확인하지 않는다. Python/PyInstaller 및 관련 hook 버전의 저장소 내 requirements lock도 없다.

따라서 이관 브랜치만 clone한 상태에서는 빌드가 바로 재현되지 않는다. 독립 빌드 문서는 [`A35_REPRODUCIBLE_BUILD.md`](A35_REPRODUCIBLE_BUILD.md)를 참조한다. 이번에 기록한 실행은 임시 clone과 별도 Python venv를 썼으며, 임시 build-script 경로 조정과 짧은 OS Temp 경로가 필요했다. 제품 소스나 A35 배포본을 변경하지 않았다.

## 테스트와 병합 판단

- Python 관리자·브리지 테스트: 63/63 통과. checkout 경로를 제한하는 상수는 복제본 테스트 harness 안에서만 메모리상 조정했다. 파일 원본은 편집하지 않았다.
- Node 관리자 UI: 21/21 통과.
- 전체 루트 `npm test`: 383개 중 368 통과, 1 실패, 14 건너뜀. 실패는 `tests/integrated-search.test.cjs`의 `ambiguous MAL bridges...` 기대값이다. 테스트가 `linkkf`를 `groupResults()` 입력에 포함해 독립 그룹으로 남을 것을 기대하지만, 구현의 집계 provider allowlist에는 `linkkf`가 없어 입력에서 제외한다. 코드의 주석은 Linkkf가 개별 검색 전용이라고 설명한다. 이 테스트 기대와 코드 정책의 불일치를 해결하기 전에는 전체 suite 통과로 판정하지 않는다.
- 공식 v0.5.58 호출 계약 테스트: 별도 실행에서 10개 모두 공식 원본 소스 경로를 제공하지 않아 건너뜀. v0.5.58 실제 호환성에 대한 이번 실행 증거는 아니다.
- 빌드된 PyInstaller 엔진을 `{"operation":"info"}` 요청으로 단독 실행했을 때 manifest를 `resources\\patches\\patch03\\manifest.json`에서 찾지 못해 실패했다. 실행 위치를 엔진 폴더로 바꿔도 같은 오류였다. 실제 Electron GUI 통합 실행은 하지 않았으며 원인을 확정하지 못했다.

**결론: `main` 병합 준비가 되지 않았다.** 전체 테스트의 실패와 건너뜀, 미실행 공식 계약 검사, 신규 패키지 엔진의 manifest 조회 실패, 빌드 스크립트의 특정 개발 경로 의존성, Python 빌드 환경 lock 부재, 권리 미확정이 남아 있다. 이번 작업에서는 병합, PR, 태그, Release를 만들지 않았다.
