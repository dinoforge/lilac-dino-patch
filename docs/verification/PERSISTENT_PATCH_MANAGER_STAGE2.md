# LilacAnime 업데이트 지속형 패치 매니저 2단계 검증

2026-10-11 · 브랜치 `codex/persistent-patch-manager-stage2` · 시작 기준 `ace1f4b446a4efe0c632ecd91b253eace4cb8144`

## 결론

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
- `electron-builder --win --dir --publish never`를 직접 실행해 `dist\win-unpacked`를 생성했다. `npm run pack`의 prepack 스크립트와 NSIS 설치기는 실행하지 않았다.
- `npm run test:phase1-electron`: 통과. 검색 IPC 30회, 공급원 resolve 3회, renderer 오류 0회, 차단된 외부 요청 0회. 테스트 전용 임시 `userData`와 합성 미디어를 사용했다.
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
