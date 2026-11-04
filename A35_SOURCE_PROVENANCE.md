# A35-final 소스 출처 및 재현 범위

확인일: 2026-11-04
대상 패키지: 디노 패치 관리자 A35-final Windows x64
이 문서는 비공개 소스 이관 브랜치 `chore/a35-source-import`의 출처 기록이다. A35 태그·GitHub Release·공개 배포를 만들지 않았다.

## 확인한 A35 산출물

로컬 A35 배포 ZIP과 풀린 패키지의 해시·크기는 요청된 값과 일치했다.

| 산출물 | SHA-256 | 크기 |
|---|---|---:|
| `DinoPatchManager-A35-final-Windows-x64.zip` | `2A31616982AA16BC759FF8608E66D6FD7F646537E5336AD2CD71642B3D037D48` | 192,183,482 bytes |
| `디노패치관리자.exe` | `295CD7770FC3A36C8F3BB0137ED1E62DF9F501B6E0A7065544436ED02D15BA2B` | — |
| `resources/app.asar` | `7F473EE769716163D7BD93BD1D8064262BAEE05DB1E2361F4F425AF2E7E1B548` | — |
| `resources/manager-engine/DinoPatchManagerEngine.exe` | `E598A103B804AE5A8FBA99DF1E14C225C3997613B26202B89AA054DF144585E1` | — |

ZIP을 읽기 전용으로 검사한 결과 항목 610개가 모두 단일 `DinoPatchManager/` 루트 아래에 있고 `DinoPatchManager/README.md`가 한 개 포함됐다. ZIP을 다시 만들거나 수정하지 않았다.

## Electron 소스 대응

A35 `app.asar`에서 180개 파일을 OS Temp에 추출해 현재 Electron 관리자 소스와 SHA-256을 비교했다. 아래 7개 파일은 바이트 단위로 일치한다.

| A35 ASAR 항목 | 소스 SHA-256 | 판정 |
|---|---|---|
| `index.html` | `1EB9C97A937D769F4742D1A2FD0DFF9862A03904F7807C00F8E4D988D09939DD` | 일치 |
| `main.cjs` | `587EAE488056BBEA9442DCB7270B2CA3D26A8517926B9CCB0F46E23D38F80C95` | 일치 |
| `manager.css` | `DC8E5D579A800D95BF5654D4F043AAA8AB8CA876A45DB13D14BD5B5F2FF97A2B` | 일치 |
| `preload.cjs` | `83744B44DB939D70E6C79B0F3C037A3ECE6A18849C72C11C57418666CA1FB5E1` | 일치 |
| `renderer.js` | `EB8F6BCC0920C7B90D5063DB2B1C1F69914E5F3DE57E11DF4BDB2D65CCC7D584` | 일치 |
| `theme-leveldb.cjs` | `598F5038BD852B854F3A7BB505DDD741BE235A69A9A9D5BB84304A60FD8C06A0` | 일치 |
| `windows-path.cjs` | `B58757162B3B9A6E1ACA3A462ACE210B71B8FDBA195E0FDE291C4050905645F7` | 일치 |

소스 `electron-app/package.json` SHA-256은 `F780D93C26CF7E8700A7434476D66F4624E5E247844236587E75618D5FFC38C2`, ASAR의 패키지 파일 SHA-256은 `23238BA9A741CF407A1DE1BA5DBDB74CE9985D5882A6966A81AA287D6385FB4F`다. JSON 필드 비교에서 차이는 electron-builder가 패키징 시 `devDependencies`를 제거한 점뿐이었다. 소스 `package-lock.json` SHA-256은 `17199E3E8CA63E22D27BFDED509E92E2E115D869E8FA7D5A3F87F73E46FE7A0C`이며 `classic-level` 3.0.0과 Electron 38.8.6을 고정한다.

## 번들 Python 코드와 패치 자산

PyInstaller 아카이브의 `manager_bridge` 스크립트와 `PYZ.pyz`의 `manager_core` 코드 객체를 Python 3.14.7로 읽어 현재 소스에서 컴파일한 코드 객체와 재귀 비교했다. 바이트코드, 상수, 이름, 인자·로컬 정보, 위치표·예외표 등 정규화된 코드 필드가 각각 일치했다.

| 모듈 | A35 번들 코드 지문 | 현재 소스 SHA-256 | 판정 |
|---|---|---|---|
| `manager_bridge` | `E58D2B6A95E136D917AF8299377D7456AD37BD7F47D9687FB5287EE3952A8A99` | `1DEDD7A2EB0B410D15E6EB7C72730AA8BACA9DD509AA122FA5C07DA77959E47D` | 컴파일 코드 구조 일치 |
| `manager_core` | `A142E69057B7996079CF8F0169C8CAB91494CA6566788ED929736144B8DC7F54` | `79F7B6E204BB0EE4806A824A27CB25AAD7B9C26F0E87EEFF50B2F9F60C503311` | 컴파일 코드 구조 일치 |

PyInstaller 번들에는 다음 패치 고유 데이터도 들어 있었고, 로컬 파일과 각 SHA-256이 정확히 일치했다.

| 런타임 자산 | SHA-256 |
|---|---|
| `patches/patch03/manifest.json` | `25F5DCC8DF79437C6B3EF5B4E472E895F8D1F250F55C5AA17CFCD586B6A2ACD3` |
| `src/integrated-search.js` | `60E2D484926549531933329751A3C16A582B507371762260B00753148C45527D` |
| `src/integrated-search.css` | `FA2513F3D8652395E4B6E5275F07C6789E0A2D49008BCED7AA708B6273A24899` |
| `patches/patch03/patch03-bridge.js` | `2874DBB5B6437EF417127727A195CE9911615F974116FB02229339F2A8E796CD` |
| `scripts/validate-patch03-clean-source.cjs` | `E7F83FE8F78F65DF9435977BBB9236CD4AF562D3031A206523FFFB6C9AF1BF6D` |
| `tests/patch03-clean-source.contract.test.cjs` | `A06B9D2DEC7FD0A94FAF074A8F4F39F69D5900696E4A1C7EF7ECFDDE84CB5B15` |

코드 객체 일치는 실행 코드가 일치한다는 증거지만, 바이너리에는 원본 주석·공백이 보존되지 않는다. 따라서 Python 원문의 문자 단위 동일성이나 당시 빌드 시점의 원본 파일 해시는 주장하지 않는다.

## 이 브랜치에 이관한 범위

- Electron 관리자 소스, `package.json` 및 lockfile
- Python 엔진과 Electron 브리지
- A35 번들에서 해시가 일치한 디노 패치 manifest, 통합 검색 모듈, bridge, 검증기 및 호출 계약 테스트
- 관리자 Python·Node UI·Electron 격리·테마 테스트
- 기존 A35 빌드 스크립트와 Electron 패키징 스크립트
- `A35_SOURCE_PROVENANCE.md`

테스트를 기존 저장소의 경로 밖에서 실행할 수 있게 Python 테스트의 두 경로 참조만 `tests/fixtures/legacy_tk/`로 옮겼다. 해당 폴더의 Tk GUI와 구형 `build_windows.ps1`은 일부 공통 엔진 동작을 검사하는 테스트 전용 fixture이며 A35 Electron 앱의 런타임, 빌드 입력 또는 배포 GUI가 아니다. A35 빌드 스크립트는 `manager_bridge.py`를 진입점으로 사용하고 `DinoPatchManager.spec`, `manager_gui.py`, 구형 `build_windows.ps1`은 사용하지 않는다.

루트의 `tests/patch03-providers-live.electron.cjs`는 Node UI 계약 테스트가 정적으로 읽는 관련 fixture로 포함했다. 실행 테스트로 사용하거나 외부 공급원에 접속하지 않았다.

## 빌드 재현 범위와 한계

`build_electron_windows.ps1`와 `build-electron.cjs`는 A35 경로·산출물 형식·ASAR 구성과 들어맞고, A35 `builder-debug.yml`에는 A35 릴리스 폴더 제외 규칙과 실제 ASAR 파일 패턴이 남아 있다. 현재 로컬 스크립트 해시는 각각 `B86FB53A107795EBC9B2AB2C1F7A2B3FF07CDFCEF5CFE844A80FAC65D327EB35`, `5F0B78639A62BD611BE2CC6C7F769B73DCC6D4947B9F40D19E536787F726562F`다. 그러나 원 A35 빌드 실행 로그나 입력 파일 해시 매니페스트가 없어 이 스크립트들의 당시 실행 바이트가 동일했다고 암호학적으로 증명할 수는 없다.

재현 빌드는 시도하지 않았다. 현재 스크립트와 엔진은 개발 프로젝트 경로 `D:\Codex-Coding-Folder\LilacAnime-Player`를 안전 가드로 고정하고, OS Temp 안의 복제본에서는 해당 경로 검사가 의도적으로 거부한다. 이 가드를 해제해 빌드하면 개발 프로젝트 보호 동작이 달라지고, A35 엔진에 내장된 개발 경로 보호값도 새 복제본을 반영하지 않아 테스트 EXE가 복제 저장소를 수정할 가능성을 안전하게 배제할 수 없다. 또한 A35의 역사적 Python·PyInstaller·Node·electron-builder 실행 환경을 서명된 빌드 기록으로 확인할 수 없다. 따라서 이 브랜치는 재현 가능한 **소스 입력 이관**이지 A35 바이너리의 완전 재현 증명은 아니다.

현재 복제 환경에서 실행한 확인:

- Python 관리자·브리지 회귀: 63/63 통과. 새 체크아웃 경로를 위한 `EXPECTED_PROJECT_ROOT` 설정과 OS Temp 분리는 테스트 실행 harness에서만 적용했다.
- Node 관리자 UI: 21/21 통과.
- 패치 계약 테스트: 공식 v0.5.58 원본 폴더를 이관본에 넣지 않아 10개 모두 명시적으로 건너뜀.
- JavaScript `node --check`: 선택한 관리자·패치 런타임 파일 통과.
- 전체 `npm test`, 실제 Electron EXE 재빌드, 재현 패키지 실행 및 공식 원본 적용: 이번에는 실행하지 않았다.

## 권리·제외 범위

이번 브랜치는 사용자 요청대로 비공개 저장소에만 반영한다. 기존 `docs/RIGHTS_REVIEW.md`의 권리 미확정·공개 배포 금지 상태를 유지한다. 공개 Release, 태그, 저장소 공개 전환, 권리 승인 변수 변경은 없다. 공식 LilacAnime의 `src/app.js`, `src/index.html`, 전체 소스 아카이브, 설치 프로그램, 사용자 프로필, A35 바이너리/ASAR/ZIP, `node_modules`, `.recovery/`, `.rej`, Temp 테스트 원본과 로그는 새로 이관하지 않았다.

`src/integrated-search.js`, CSS, bridge와 manifest는 A35 런타임에서 확인한 디노 패치 고유 자산으로 취급했다. 공식 앱 원본 파일은 아니다. 저장소의 전반적인 권리 검토는 미완료이며, 이 문서는 공개 배포 권한을 주장하지 않는다.
