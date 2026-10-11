# LilacAnime 업데이트 지속형 패치 매니저 2단계 검증

2026-10-11 · 브랜치 `codex/persistent-patch-manager-stage2` · 시작 기준 `ace1f4b446a4efe0c632ecd91b253eace4cb8144`

## 2026-10-11 실행 추가분 — v0.5.14 어댑터와 지속 적용 한계

### 판정

**격리된 공식 v0.5.14 소스 복사본에는 패치 01·02를 적용하고 원상 복구할 수 있었다. 실제 LilacAnime 설치본에 지속 적용하거나 공식 업데이트 뒤 자동 재적용하는 기능은 아직 완료되지 않았다.** 이번 브랜치의 호환성 범위는 정확히 v0.5.14 파일 지문에 고정되어 있으며, 미지원 버전은 변경하지 않고 중단한다.

2026-10-11에 확인한 [공식 Releases](https://github.com/whispelyn-byte/LilacAnime-desktop/releases)의 최신 공개 항목은 v0.5.14 (`f095fc3d775451e144ed780e1fa081f739927652`)였다.

| 범위 | 결과 |
| --- | --- |
| v0.5.14 실제 소스 payload 적용·백업·롤백 | 격리된 원본 복사본에서 통과 |
| v0.5.15 모의 업데이트 | 미지원 판정, 업데이트 파일 바이트 보존 통과 |
| 패치 01·02 renderer/IPC 보조 테스트 | 합성 DOM과 IPC를 둔 Electron harness에서 통과 |
| 공식 v0.5.14 전체 앱 UI와 실제 NSIS 업데이트 | 미검증·미실시 |
| 실제 LilacAnime 설치본 및 사용자 데이터 변경 | 미실시 |

### 실제 적용한 범위

- 새 어댑터 `patch-manager/adapters/lilacanime-v0.5.14.cjs`는 `package.json`, `src/index.html`, `src/app.js`, `src/player.js`, `src/ott.css`, `electron/main.cjs`, `electron/preload.cjs`, `electron/subtitle-store.cjs`의 해시를 고정한다. 예상 바이트가 하나라도 달라지면 검사에서 거부한다.
- 격리된 v0.5.14 소스 사본에 main/preload IPC, renderer 스크립트, 패치 01·02 helper payload와 사용자 번역 프롬프트를 추가했다. 매니저가 백업과 적용 영수증을 만들고 `rollbackPersistent()`로 되돌릴 때 원본 추적 파일들의 해시와 추가 파일 부재를 확인했다.
- 업데이트 모의 테스트는 적용 후 복사본의 버전을 `0.5.15`로 바꾸고 새 파일 내용을 넣었다. `reconcileAfterUpdate()`가 `unsupported-update` / `version-unverified`로 멈췄고 모의 업데이터가 쓴 바이트를 그대로 보존했다. 실제 v0.5.15 호환성은 입증하지 않는다.
- 영어/일본어 프롬프트 2개의 SHA-256과 Reazon 예시 파일의 SHA-256은 이전에 기록한 원본 해시와 일치한다. 영어·일본어 프롬프트 선택, 앞뒤 최대 두 cue 문맥, cue ID 검증, 원래 VTT 시간 코드 보존 및 테스트 프로필로의 저장을 합성 데이터로 확인했다.
- Patch 01은 분기 자동 인식, 월~일 일정 병합, 같은 시즌/회차 후보에 대한 RE:Anime·Miruro·Animenosub·애니24·Linkkf 상태 확인 흐름을 연결한다. 현재 코드가 실제 재생 URL을 확인하지 않은 경우 `재생 가능`이라고 표시하지 않는다. 외부 사이트 호출은 차단하거나 mock 처리했다.

### 공식 updater 조사와 자동 재적용 판단

공식 v0.5.14 소스에서 `electron/updater.cjs`, `electron/main.cjs`, `package.json`을 읽기 전용으로 조사했다. 패치 적용 전후 원본 clone의 추적 파일은 바뀌지 않았다.

- updater는 `releases/latest`를 조회하고 버전이 다르면 설치기를 백그라운드에서 내려받는다 (`electron/updater.cjs:8-56`). 다운로드 검사는 응답 코드와 자산 크기 일치이며, 로컬에서 확인한 경로에는 자산 서명 또는 SHA-256 manifest 검증이 없다.
- Windows 설치는 updater가 NSIS 설치기를 분리 실행하고 `['/S', '--updated', '--force-run']`를 전달한 다음 300ms 후 LilacAnime 프로세스를 종료한다 (`electron/updater.cjs:108-119`). `ready` 상태의 설치기는 앱 종료 처리에서도 설치될 수 있다 (`electron/updater.cjs:121-123`, `electron/main.cjs:2565`). 설치 완료를 외부 매니저에 알리는 IPC/callback은 확인되지 않았다.
- NSIS 설정은 설치 위치 변경을 허용한다 (`package.json:46-52`). 외부 프로그램이 업데이트 완료 뒤 정확한 설치 폴더를 신뢰성 있게 찾고, 재실행 경쟁을 피하며, 업데이트된 바이너리의 신뢰성을 검증할 공식 계약은 없다.
- 따라서 폴더 감시만 추가하는 것으로 “업데이트 직후 새 앱이 열리기 전에 자동 패치”를 보장할 수 없다. 설치기가 앱을 다시 시작한 뒤 파일을 바꾸면 실행 중 파일 교체/앱 중단 위험이 있고, 앱 실행 전에 패치하려고 하면 런처·설치기 또는 공식 updater를 바꿔야 한다. 이번 단계에서 어느 방식도 설치본에 적용하지 않았다.

권장되는 장기 연결 순서는 다음과 같다.

1. **우선 권장: 공식 확장 브리지.** 원본 앱이 안정된 버전별 API, 앱 내 플러그인 로딩, 일정·회차·자막 UI extension point를 제공한다. 앱 업데이트는 브리지 계약을 유지하고 Companion 모듈은 격리된 데이터 디렉터리에서 읽는다.
2. **대안: 공식 post-update hook.** 원본 updater/NSIS가 설치 성공과 설치 폴더 경로를 명시적으로 전달하고, 서명·해시가 검증된 패치 매니저를 앱 재실행 전에 한 번 호출한다. 매니저는 정확한 버전·전체 지문·앱 종료를 확인하고, 실패 시 백업 복원 후 원본 앱을 시작한다.
3. **현재 무승인 상태에서 가능한 것: 별도 수동/일회성 격리 적용.** 정확한 v0.5.14 소스 복사본을 검증하고 미지원 업데이트는 보류한다. 실사용 설치본 수정, 감시 등록, 바로가기 변경, 재시작 유도는 사용자의 별도 승인과 공식 연동 계약 전에는 하지 않는다.

### 검증 로그 요약

- `node --test patch-manager/test/lilacanime-v0514-adapter.test.cjs`: 3/3 통과. 실제 v0.5.14 복사본에 적용·롤백했고 upstream clone은 해시 동일, v0.5.15 모의 업데이트는 거부했다.
- `node --test patch-manager/test/patch-manager-stage2.test.cjs`: 3/3 통과. 분기 선택, 모의 provider adapter, 수동 VTT 저장을 확인했다.
- `tests/run-patch-manager-stage2-v0514-electron.cjs`: 통과. 격리 Electron 창에서 합성 DOM, 오늘 요일, 5개 mock 출처 상태, 일본어 수동 번역 결과 저장을 확인했다. HTTP 요청 수는 0이다. 이것은 공식 `src/index.html` 전체 UI를 로드한 시험이 아니다.
- 전체 `npm test`: 306 통과, 0 실패, 0 건너뜀. 새 파일 `node --check` 및 기존 `npm run test:phase1-electron`, `npm run test:phase1-main`도 통과했다. Phase 1 두 smoke는 기존 `dist\\win-unpacked` 산출물을 사용했으며 새 v0.5.14 adapter 패키지를 검증한 결과는 아니다.
- 라이브 공급원, 실제 영상, ChatGPT 웹 요청, NSIS 설치/업데이트, 전체 upstream 앱 UI는 실행하지 않았다.

### 남은 작업과 실사용 판정

- 실사용 설치본에 자동 재적용 가능한 패치 매니저라고 부를 수 없다. 현재 `patch-manager/persistent.cjs`는 안전을 위해 `%TEMP%` 아래의 명시적 합성 표식 대상만 허용한다. 업데이트 완료 신호도 호출자가 주입하는 테스트 인자이며 실제 updater와 연결되지 않았다.
- v0.5.14의 실제 앱 창에 주입된 전체 화면·원본 검색/설정/상세 회귀, 재생과 자막 선택까지는 미검증이다. 현재 Electron harness는 스크립트 동작을 점검하는 합성 DOM이다.
- 다음 기술 단계는 원본 제작자에게 안정된 플러그인/브리지 API 또는 NSIS 종료 후 재실행 전 호출되는 공식 hook을 요청하는 것이다. 해당 계약이 없으면 설치 위치 변경을 감지하는 외부 polling만으로는 안전한 무인 자동 재적용을 완성할 수 없다.
- 앞선 직접 Electron 시험 중 생성된 임시 프로필 디렉터리 7개는 정책이 재귀 삭제를 거부해 그대로 보존했다. 경로는 `%TEMP%\lilac-patch-stage2-electron-1csgSj`, `1HTibj`, `dxJKZz`, `K3kgfQ`, `lXmEFg`, `ViRxcz`, `XJSDd4`이며 테스트용 `sessionData`/`userData`만 포함한다. 실제 LilacAnime 프로필과 무관하고, 이번 변경에서는 다시 삭제를 시도하지 않았다.

---

아래는 이번 어댑터 실행 전의 Stage 1 조사 기록이다. 이후 구현·검증 범위는 위의 추가 결과가 우선한다.

## 초기 Stage 1 결론 (이번 어댑터 실행 이전 기록)

**실제 LilacAnime v0.5.14 파일을 전혀 바꾸지 않은 채 현재 패치 01·02를 내부 화면에 적용하고, 공식 업데이트 뒤 자동으로 유지하는 것은 이번 결과로 입증되지 않았다.** 공식 v0.5.14는 기존 통합 패치의 코드 기준과 맞지 않아 패치 매니저가 적용을 거부해야 한다. 실제 설치본에는 어떤 변경도 하지 않았다.

구현·검증한 것은 임시 폴더의 표식된 합성 fixture에 한정된 적용, 백업, 업데이트 시뮬레이션, 재적용 및 롤백 엔진이다. 여기에 현재 프로젝트의 패치 01·02 helper 모듈과 원문 프롬프트 파일을 fixture payload로 복사하고 핵심 helper 동작을 검사했다. 이것은 공식 원본 v0.5.14용 패치 adapter가 아니다.

## 확인한 기준과 범위

- 신규 브랜치는 `codex/persistent-patch-manager`의 `ace1f4b446a4efe0c632ecd91b253eace4cb8144`에서 시작했다. 기존 브랜치와 `main`은 수정하지 않았다.
- 공식 최신 릴리스는 [LilacAnime v0.5.14](https://github.com/whispelyn-byte/LilacAnime-desktop/releases/tag/v0.5.14)이며, 격리된 소스 복사본은 `C:\Users\공룡\AppData\Local\Temp\LilacAnime-upstream-v0.5.14-stage2-bb4e6e315244496faa4ab824383d4c6c`에서 읽기 전용 비교에만 사용했다.
- 실제 설치 경로 `D:\LilacAnime`, 기존 `%APPDATA%\lilacanime-desktop`, `%LOCALAPPDATA%\lilacanime-desktop-updater`에는 접근하지 않았다. 설치·제거·NSIS·자동 업데이터 후킹을 하지 않았다.
- 공식 원본 v0.5.14 앱은 실행하지 않았다. 실제 공급원·영상·ChatGPT 요청도 하지 않았다.

## 구현 내용

### 격리 적용 엔진

- `patch-manager/core.cjs`: 고정 앱 버전·SHA-256·고유 삽입 지점을 확인하고, 기존 대상 파일 및 Windows에서 충돌하는 경로를 거부한다. 심볼릭 링크와 과도한 payload도 차단한다.
- `patch-manager/staging.cjs`: OS 임시 폴더 안의 표식된 합성 fixture만 허용한다. 검증된 원본 설치 경로를 받거나 대상으로 삼는 API는 없다. fixture 정리도 이 작업이 만든 유효 표식을 확인해야 한다.
- `patch-manager/feature-payload.cjs`: 프로젝트의 `src/quarter-selection.js`, `src/weekday-schedule.js`, `src/manual-subtitle-translation.js`, 관련 Electron helper 및 세 프롬프트 파일을 고정된 `0.5.9` fixture payload로 준비한다. 입력 프롬프트의 원본 바이트를 그대로 복사한다.
- `patch-manager/persistent.cjs`: 앱이 중지된 fixture에서만 적용한다. 업데이트 재적용에는 호출자가 확인한 업데이트 완료 신호, 앱 중지 확인, 기본 1.5초 간격의 두 동일 지문, 정확한 버전·파일 기준 일치를 요구한다. 백업과 영수증은 fixture 외부 sidecar에 두며, 롤백은 현재 파일이 패치 결과와 일치하는지 확인해 업데이트 소유 바이트를 덮지 않는다.
- `patch-manager/cli.cjs`: `--help`와 새 합성 fixture에 적용하는 `--demo`만 허용한다. 실제 설치 경로를 받는 옵션은 없다. demo는 생성한 임시 fixture 및 sidecar를 자동 삭제하지 않는다.

### 패치 01·02 payload 검증 범위

fixture에서 분기 계산, 요일 회차 가용성 상태, AniList 요일 매핑, WebVTT cue 파싱 및 프롬프트 선택 helper를 불러 실행했다. `영어 번역 프롬프트.txt`, `일본어 번역 프롬프트.txt`, `Reazon_작품용_단어사전_예시.txt` SHA-256은 각각 다음과 같았고 기존 원문과 일치했다.

- 영어: `582EAF421CABBCF89279579E5723AA07B070E5B1DF2E28EE044994B2E951E37E`
- 일본어: `9FF7E860CF0C79396621C2EF65B364596EBB884AA5B3CE68E60AB0D4B42EC584`
- Reazon 예시: `2DCB15B42D31BD6413D74E9A91303F0055574E030F875720CB1A1C07B814CCF8`

이 테스트는 fixture 파일 복사와 helper 수준 검사다. 공식 원본 앱의 홈·방영표·상세·재생 화면 안에 패치 UI가 통합됐다는 뜻은 아니다. 두 번역 프롬프트 사용은 로컬 helper까지 확인했으며 실제 ChatGPT 왕복·번역 품질은 미검증이다.

## 공식 v0.5.14 호환성 비교

비교 기준 통합 패치 원본은 앱 버전 `0.5.9`를 사용한 anime-player 기준 커밋 `64749271b8a57fad84ee52dae622c6bb7c1e294d`였다. Patch 01 `b79a69a49521d80dd0c1a26915bbda624ea79366`과 Patch 02 `2715f8158c37754448e89abc1552302d7706711c`의 diff를 공식 v0.5.14 소스에 **`git apply --check`로만** 시험했다.

- 기준 파일 5개(`package.json`, `src/app.js`, `src/index.html`, `electron/main.cjs`, `electron/preload.cjs`) 모두 기존 통합 기준과 달랐다.
- 정확한 버전을 `0.5.14`로 지정해도 `src/app.js`의 예상 지문 불일치로 manifest 검사가 `incompatible`를 반환했다.
- Patch 01 dry run은 `electron/main.cjs`, `electron/preload.cjs`, `src/app.js`, `src/index.html` 충돌과 통합 저장소에만 있는 파일의 부재로 실패했다.
- Patch 02 dry run도 main/preload/app 충돌 및 `src/manual-subtitle-translation.js` 등 파일 부재로 실패했다.
- 검사 전후 공식 소스의 기준 파일 SHA-256이 같았다. 적용이나 파일 쓰기는 하지 않았다.

따라서 현 단계에서 자동 업데이트 후 재적용을 활성화하면 안 된다. v0.5.14에 맞는 별도 adapter를 작성하고 합성 네트워크로 차단된 unpacked 테스트 앱에서 UI·회귀 검증을 먼저 해야 한다.

## 업데이트·롤백 테스트

fixture에서 다음을 검증했다.

1. 패치 전 지문·유일 앵커 확인 후 staging 사본을 만들고 payload를 적용한다.
2. 동일 patch set 재적용은 `already-applied`로 멈춘다.
3. 업데이트 완료 신호가 없거나 앱이 실행 중이면 변경하지 않는다.
4. 안정화 대기 중 지문이 변하면 `update-still-changing`으로 중단한다.
5. fixture의 합성 업데이트가 끝나고 시험 전용 adapter 지문이 주어졌을 때만 재적용한다.
6. 미지원 버전·파일 변경은 `unsupported-update`로 남기고 새 updater 바이트를 보존한다.
7. 수동 롤백은 패치 후 파일이 바뀌었다면 덮어쓰기를 거부한다. 정상일 때는 원본 fixture와 백업을 검증해 되돌린다.

`0.5.9` → `0.5.10` 업데이트는 테스트 코드에서 manifest 지문을 합성으로 다시 만든 시뮬레이션이다. `0.5.10` 또는 그 밖의 어떤 실제 LilacAnime 버전도 지원한다는 의미가 아니다. 프로세스 강제 종료·정전 중 중간 쓰기 복구도 아직 보장하지 않는다.

## Windows unpacked 검증

- 새 worktree에서 `node_modules`가 없어서 기존 프로젝트 의존성을 임시 junction으로 재사용했다. 의존성 설치나 package manifest 변경은 하지 않았다.
- `electron-builder --win --dir --publish never`를 직접 실행해 `dist\win-unpacked`를 생성했다. 빌드에는 격리 ID `com.lilac.anime.desktop.stage2.test.20261011`, 제품명 `LilacAnime Stage2 Test`, 실행 파일명 `LilacAnimeStage2Test.exe`를 지정했다. `npm run pack`의 prepack 스크립트와 NSIS 설치기는 실행하지 않았다.
- `npm run test:phase1-electron`: 통과. 검색 IPC 30회, 공급원 resolve 3회, renderer 오류 0회, 차단된 외부 요청 0회. 테스트 전용 임시 `userData`·`sessionData`와 합성 미디어를 사용한다.
- `npm run test:phase1-main`: 통과. 검색→상세→회차→합성 재생, 한국어 자막, 이어보기, 자막 프롬프트 및 수동 번역 helper 흐름 등 기존 Phase 1 smoke를 통과했다. 합성 HTTP fixture 104회, 알 수 없는 fetch 0회, 차단 브라우저 요청 0회, 외부 네트워크 0회. 로그에 출력된 잘못된 clipboard/resolve IPC 오류는 거부 동작을 검증하는 harness 입력이며 프로세스 테스트 종료 코드는 0이었다.
- 이것은 현재 프로젝트의 unpacked 패키지 테스트다. 공식 v0.5.14 원본 앱의 화면을 실행해 패치 UI를 확인한 결과는 아니다. 이번 작업은 Computer Use나 화면 캡처를 사용하지 않았다.

처음 두 Phase 1 명령은 `dist\win-unpacked\resources\app.asar`가 없어 시작 단계에서 실패했다. NSIS 또는 `prepack`을 실행하지 않고 unpacked 디렉터리 빌드를 만든 뒤 같은 테스트를 다시 수행해 통과했다.

## 테스트 결과

| 검증 | 결과 |
| --- | --- |
| `node --test patch-manager/test/manager.test.cjs` | 통과 16/16; 중간 쓰기 오류의 원본 복구 포함 |
| 공식 소스 `upstream-compatibility.test.cjs` | 통과 1/1: 호환 불가와 파일 무변경 확인 |
| `npm test` | 통과 299, 실패 0, skip 1 (총 300). 환경 변수 없는 공식 upstream 검사는 skip; 위 전용 실행에서 통과 |
| `npm run test:phase1-main` | 통과; 합성 fixture 및 네트워크 차단 |
| `npm run test:phase1-electron` | 통과; 임시 프로필·합성 미디어 |
| 변경 파일 `node --check`, `git diff --check`, CLI `--help` | 통과 |
| 공식 원본 v0.5.14 UI / 라이브 공급원 / 실제 ChatGPT | 미검증·미실시 |
| 실제 설치본 적용 / NSIS / 공식 updater 연동 | 미실시 |

## 실사용 전 남은 작업

1. 공식 v0.5.14의 renderer·preload·main 구조를 읽고 Patch 01·02 동작을 버전별 공식 소스 adapter로 다시 연결한다. 단순한 과거 diff 재적용은 허용하지 않는다.
2. 격리된 upstream 소스 복사본을 unpacked로 빌드하고, 앱 ID·`userData`·`sessionData`를 별도로 지정해 홈/검색/상세/요일표/번역 UI 회귀를 확인한다.
3. updater의 실제 완료 신호, 업데이트 중 파일 잠금, 코드서명/무결성 정책, 백그라운드 실행 정책을 공식 지원 범위에서 조사하고 adapter 기반 안전 검증을 추가한다.
4. 중간 종료 시 복구 가능한 영속 저널과 다중 파일 원자성 검증을 구현한다.
5. 실제 설치본의 파일을 바꾸는 최초 작업 전, 별도의 명시적 승인을 받는다. 현재 설치본·프로필·업데이트 캐시에 대한 패치 기능은 전혀 구현 또는 실행하지 않았다.

## 남아 있는 테스트 환경 항목

새 worktree의 `node_modules`는 기존 프로젝트 의존성을 가리키는 임시 junction이다. 테스트 후 junction 자체를 제거하려는 PowerShell 동작이 자동 안전 검토에서 거부되어 그대로 남아 있다. junction target은 `D:\Codex-Coding-Folder\LilacAnime-Player\node_modules`다. 실제 설치 경로·프로필과는 무관하며 Git에는 추적되지 않는다. 정리 전 target을 확인하고 junction만 제거해야 한다.
