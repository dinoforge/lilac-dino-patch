# A35-final 독립 빌드 재현 검토

검토일: 2026-11-05

원격 기준: `dinoforge/lilac-dino-patch`, `chore/a35-source-import`

입력 커밋: `134cc48361953eff33cf5a89b1ab6e9d8e2bf4cd`

## 결론

OS Temp의 독립 clone에서 Windows x64 `win-unpacked` 실험 패키징은 완료했다. 기존 A35와 Electron 실행 파일 및 `app.asar`의 SHA-256은 일치했지만, Python 엔진 해시는 달랐고 새 엔진의 읽기 전용 `info` 요청도 manifest를 찾지 못해 실패했다. 따라서 **독립 패키지 생성은 재현했으나 실행 가능한 A35 전체 빌드 또는 완전한 재현성은 입증하지 못했다.** 생성한 실험 산출물은 A35/A36 정식 빌드가 아니며 ZIP도 만들지 않았다.

## 격리 환경

- 저장소를 OS Temp 아래 별도 clone으로 복제하고 `chore/a35-source-import`의 `134cc48361953eff33cf5a89b1ab6e9d8e2bf4cd`에서 검사했다.
- Python venv, pip cache/config, npm cache/logs, Electron cache, 테스트 임시 폴더 및 앱 프로필용 환경 변수를 별도 Temp 경로에 두었다.
- 소스 검증 테스트는 자체 임시 fixture를 사용했다. 공식 v0.5.58 소스 폴더는 clone 및 테스트 환경에 포함되지 않았다.
- 실험 빌드는 clone 내부의 새 `DinoPatchManager-Electron-v1.2.4-repro-experiment/win-unpacked` 경로에만 썼다. 기존 A35/A20~A34 릴리스와 사용자 설치본을 입력·출력으로 사용하지 않았다.

## 도구와 잠금 상태

| 도구/패키지 | 실험에 사용한 버전 | 출처·잠금 상태 |
|---|---:|---|
| Node.js | 24.14.1 | 기존 시스템 PATH. 저장소에서 버전 고정/검사 없음 |
| npm | 11.11.0 | 기존 시스템 PATH |
| Electron | 38.8.6 | 관리자 `package.json`/lock 및 루트 설치 패키지에서 확인 |
| electron-builder | 26.15.3 | 루트 lock/설치 패키지에서 확인. 빌드 스크립트는 루트 `node_modules`를 요구 |
| classic-level | 3.0.0 | 관리자 `package.json`/lock에서 고정 |
| Python | 3.14.7 | 별도 OS Temp venv |
| PyInstaller | 6.21.0 | 별도 venv에 설치. 저장소 내 build requirements lock 없음 |
| PyInstaller hooks contrib | 2026.9 | 설치 시점의 venv 동결 목록에 기록 |
| altgraph / packaging / pefile / pywin32-ctypes / setuptools / pip | 0.17.5 / 26.3 / 2024.8.26 / 0.2.3 / 84.2.1 / 26.2.1 | 실험 venv `pip freeze` 목록 |

실험 venv에 사용한 Python 패키지 목록은 `altgraph==0.17.5`, `packaging==26.3`, `pefile==2024.8.26`, `pip==26.2.1`, `pyinstaller==6.21.0`, `pyinstaller-hooks-contrib==2026.9`, `pywin32-ctypes==0.2.3`, `setuptools==84.2.1`이다. 이 동결 파일은 OS Temp에 보관했고 저장소 입력으로 추가하지 않았다. A35 당시의 역사적 설치 버전 및 빌드 환경과 같은지 확인할 자료는 없다.

## 실행한 검사

### 테스트

- Python 관리자·브리지 suite: **63/63 통과**. 독립 clone 때문에 `EXPECTED_PROJECT_ROOT` 제한이 있는 테스트는 별도 harness에서 메모리상으로만 clone 경로에 맞췄다. Python 소스 파일은 수정하지 않았다. 기본 unittest 실행은 먼저 5개 경로 검증 오류로 실패했고, 원인을 확인한 뒤 harness 설정을 적용해 전체 suite를 다시 실행했다.
- Electron 관리자 UI Node 테스트: **21/21 통과**.
- 전체 루트 `npm test`: **383개 중 368 통과, 1 실패, 14 건너뜀**. 유일한 실패는 `tests/integrated-search.test.cjs`의 ambiguous MAL bridge 사례로, 입력 fixture의 `linkkf`를 그룹 결과에 남길 것을 기대한다. 현재 `groupResults()`는 집계 대상 allowlist에 없는 `linkkf`를 제외하며 주석상 Linkkf는 독립 검색 전용이다. 테스트 기대와 현재 정책이 서로 맞지 않는다.
- 별도 공식 소스 계약 suite: **10개 건너뜀**. 테스트가 요구하는 공식 v0.5.58 소스 경로가 없었다. 실제 공식 버전 계약이 통과한 것으로 계산하지 않는다.
- 관리자 패키지 GUI와 공식 LilacAnime 앱을 실행하지 않았다. 실제 공급원 검색·재생 검증도 하지 않았다.

### 패키징 시도

`build_electron_windows.ps1`의 현재 기본값은 프로젝트 경로 `D:\Codex-Coding-Folder\LilacAnime-Player`, Python/PyInstaller 외부 도구 경로를 고정한다. 독립 clone에서는 이 가드가 의도대로 거부하므로, 실험용 clone에서만 일시적으로 네 항목을 조정했다.

1. 새 산출물 이름 `repro-experiment`를 허용하는 검증 패턴
2. `$expectedRoot`를 독립 Temp clone으로 지정
3. Python과 PyInstaller 실행 파일을 별도 Temp venv로 지정
4. 빌드 staging의 `TEMP/TMP`를 더 짧은 전용 Windows Temp 하위 경로로 지정

이 임시 편집은 실험 후 clone에서 복구했다. GitHub에 포함되는 빌드 스크립트는 변경하지 않았다.

기본 LocalAppData Temp 경로에서 첫 PyInstaller `COLLECT`는 `_internal` DLL을 쓰는 도중 `FileNotFoundError`로 실패했다. 실패 대상 경로 길이는 261자였고 대상 DLL은 생성되지 않았다. 같은 소스·도구로 `TEMP/TMP`만 짧은 `C:\Windows\Temp` 하위 격리 폴더로 바꿔 재시도하자 PyInstaller 및 electron-builder 단계가 성공했다. 경로 길이 경계가 실패 조건이라는 강한 정황은 있으나 예외에 WinError 206 코드가 기록되진 않았으므로, 정확한 Windows API 오류 코드까지 확인한 것으로 주장하지 않는다.

## 실험 산출물과 A35 비교

실험 패키지: OS Temp clone 내부의 `tools/dino-patch-manager/release/DinoPatchManager-Electron-v1.2.4-repro-experiment/win-unpacked/`

구성: 609개 파일. 기존 A35 ZIP처럼 배포 ZIP으로 압축하지 않았다.

| 파일 | 실험 SHA-256 | A35 기준 SHA-256 | 결과 |
|---|---|---|---|
| `디노패치관리자.exe` | `295CD7770FC3A36C8F3BB0137ED1E62DF9F501B6E0A7065544436ED02D15BA2B` | 동일 | 바이트 동일 |
| `resources/app.asar` | `7F473EE769716163D7BD93BD1D8064262BAEE05DB1E2361F4F425AF2E7E1B548` | 동일 | 바이트 동일 |
| `resources/manager-engine/DinoPatchManagerEngine.exe` | `3FF35C2BA94EEB42287CFF1B6DC906101AE899E9F8D97ACF3CB7CD583F10CF7B` | `E598A103B804AE5A8FBA99DF1E14C225C3997613B26202B89AA054DF144585E1` | 다름 |

해시는 재현 기준으로 사용한 기존 [`A35_SOURCE_PROVENANCE.md`](A35_SOURCE_PROVENANCE.md)의 값과 비교했다. EXE와 ASAR의 일치는 Electron 셸 및 UI 패키징 재현을 지지한다. Python 엔진의 바이너리 차이는 도구·환경·패키징 차이 또는 미확인 빌드 입력의 영향을 받을 수 있지만, 현재 증거만으로 원인을 특정하지 않는다. 해시 차이를 곧바로 Python 소스 기능 차이라고 단정하지도 않는다.

### 엔진 실행 확인

실험 패키지의 `DinoPatchManagerEngine.exe`에 `{"operation":"info"}`를 stdin으로 전달했다. 엔진은 `ManagerError`를 반환하며 manifest를 `resources\\patches\\patch03\\manifest.json`에서 찾지 못했다. 현재 working directory에서 실행했을 때와 엔진 디렉터리에서 실행했을 때 같은 오류였다. 이 검사에서 파일을 수정하지 않았다.

이 실패 때문에 Electron GUI 버튼 연결, 관리자 프로필 격리, 실제 패치 적용/복원, 빌드 EXE의 동작은 이번 검토에서 검증하지 않았다. 오류 원인이 PyInstaller의 frozen resource 위치, 패키징 레이아웃 또는 다른 런타임 경로 계약 중 무엇인지는 확정하지 않았다.

## 재현 가능한 범위와 누락 입력

확인된 재현 범위:

- 관리자 Electron 코드 및 잠금 의존성으로 `app.asar`가 A35 해시와 일치했다.
- 현재 개발된 루트 `node_modules` 및 Electron 배포 폴더를 바탕으로 셸 EXE 해시가 A35와 일치했다.
- 별도 Python/PyInstaller 환경에서 전체 `win-unpacked` 패키지를 생성할 수 있었다.

미확정 또는 미재현 범위:

- 복제본 checkout만으로 실행 가능한 단일 빌드 절차. 현재 스크립트의 고정 루트/도구 경로를 임시 override 해야 했다.
- Python/PyInstaller와 hooks 버전, 전체 Python 빌드 의존성, Node 버전의 저장소 내 잠금.
- A35 당시 실제 빌드 입력 파일의 서명된 hash manifest와 실행 로그.
- 새 PyInstaller 엔진과 A35 엔진 간 byte-identical 재현 및 해시 차이 원인.
- 새 번들 엔진이 패키지 내 실제 patch asset을 읽는 runtime 경로. `info` 요청이 실패했다.
- 공식 v0.5.58 계약 fixture가 필요한 10개 테스트 및 실제 GUI/패치 작업.
- 전체 `npm test`의 한 실패와 14개 건너뜀 해소.

## 다음 단계

`main` 병합이나 정식 배포 전에 최소한 다음이 필요하다.

1. clone 경로 및 toolchain을 인자로 받거나 안전하게 탐지하도록 빌드 입력을 외부화하고 Python 빌드 의존성을 lock한다.
2. Windows 긴 경로를 고려해 짧은 staging 경로를 사전검사하거나 staging 이름을 줄인다.
3. PyInstaller 패키지의 frozen resource 경로에서 manifest/모듈을 찾는 bundle smoke를 추가하고, `info` 호출부터 GUI bridge까지 검증한다.
4. 현재 집계 정책(Linkkf 개별 검색)을 테스트 기대와 일치시키고 전체 Node suite를 다시 실행한다.
5. 격리된 공식 v0.5.58 원본으로 빠진 계약 테스트 및 패키지 통합 검증을 실행한다.
6. 기존 권리 검토 문서에 남은 upstream·asset·의존성 재배포 조건을 해결하기 전 공개하지 않는다.

이번 작업에서는 제품 코드, 공식 LilacAnime 파일, A35, ZIP, `main`, 권리 승인 설정을 변경하지 않았다.
