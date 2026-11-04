# LilacAnime Companion 원본 무수정 연동 프로토타입

검토일: 2026-10-11 (Asia/Seoul)
작업 브랜치: `codex/runtime-companion-prototype`
기준: `codex/integration-01-02` / `4610a45f52e9a076b67a6774bcf3887dc390e485`
상태: **별도 창 코드 프로토타입 구현, 원본 앱 연결과 Windows 화면 실행은 미검증**

## 요약

Companion을 원본 LilacAnime 안에 넣는 공식 확장 지점은 확인되지 않았다. 원본 v0.5.14의 Electron main은 내장 `src/index.html`을 띄우고, preload는 `window.lilac`이라는 원본 renderer 전용 IPC 다리를 제공한다. 공개 소스에서 외부 플러그인 로더, Companion용 IPC·deep link, 외부 앱이 호출할 재생 제어 계약은 찾지 못했다. 따라서 이 프로토타입은 원본에 붙어 보인다고 주장하지 않는 **별도 창**이다.

별도 창에는 분기·요일표와 다섯 공급원 상태의 합성 예시, 사용자 선택 WebVTT를 바탕으로 한 ChatGPT 수동 번역 보조가 있다. 일정/출처 조회는 네트워크에 연결되지 않으며 재생도 없다. 자막 내용은 앱에서 ChatGPT로 전송하지 않는다. 사용자가 프롬프트를 복사해 브라우저에서 직접 붙여넣고, 응답을 가져온다. 검증된 결과는 새 파일로만 내보낸다.

따라서 요구사항은 **부분 충족**이다. 독립 Companion 프로토타입과 오프라인 로직은 구현됐지만, 원본 앱 내부 UI·현재 회차 자동 인식·원본 플레이어 제어·실제 서비스 조회·실제 영상 재생은 지원하지 않거나 미검증이다.

## 원본 버전과 연결점 조사

- 최신 공개 태그는 [`v0.5.14`](https://github.com/whispelyn-byte/LilacAnime-desktop/releases/tag/v0.5.14), 태그 커밋은 `f095fc3d775451e144ed780e1fa081f739927652`다. 공개 릴리스 설명은 v0.5.14와 v0.5.13 변경 사항을 기록한다.
- 태그의 [`package.json`](https://github.com/whispelyn-byte/LilacAnime-desktop/blob/v0.5.14/package.json)은 원본 앱 ID `com.lilac.anime.desktop`, 제품명 `LilacAnime`를 사용한다.
- 태그의 [`electron/main.cjs`](https://github.com/whispelyn-byte/LilacAnime-desktop/blob/v0.5.14/electron/main.cjs#L1996-L2015)는 main window를 만들고 원본 `src/index.html`을 로드한다.
- 태그의 [`electron/preload.cjs`](https://github.com/whispelyn-byte/LilacAnime-desktop/blob/v0.5.14/electron/preload.cjs#L1-L6)는 `contextBridge.exposeInMainWorld('lilac', ...)`로 내부 renderer API를 노출한다. API에는 방영표·공급원·재생·자막·번역 IPC가 있지만, 이 API가 외부 프로그램에 공개되는 인터페이스라는 근거는 없다.
- v0.5.14 태그 소스를 별도 객체로 읽어 `main.cjs`와 `preload.cjs`를 확인했다. `main.cjs`에서 plugin loader, external protocol/deep link, 원격 디버깅 포트를 찾지 못했다. 이 확인은 공개 소스에 대한 정적 조사이며, 설치된 원본을 실행하거나 파일·프로필을 읽은 결과가 아니다.
- 기존 타당성 조사는 원격 브랜치 [`codex/companion-architecture-audit`](https://github.com/dinoforge/lilac-dino-patch/blob/codex/companion-architecture-audit/docs/planning/COMPANION_ADDON_FEASIBILITY.md)의 `docs/planning/COMPANION_ADDON_FEASIBILITY.md`에서 읽었다. 결론은 위 태그 소스 확인과 일치한다.

| 접점 | 상태 | 판단 |
|---|---|---|
| 원본 내부 탭/버튼 | **미지원** | 별도 애드온 API가 확인되지 않음 |
| 현재 재생 회차 전달 | **미지원** | 외부 IPC 또는 딥링크 계약이 확인되지 않음 |
| 원본 재생 제어 | **미지원** | Companion에 원본 프로세스 제어 코드를 넣지 않음 |
| 별도 Companion 창 | **프로토타입 구현 / 실행 미검증** | 서로 다른 ID와 데이터 경로를 쓰도록 작성 |
| 원본의 수동 자막 파일 선택 | 공개 소스에 존재 | 사용자가 Companion에서 내보낸 파일을 원본에서 직접 고르는 흐름은 가능하나, 실제 실행은 확인하지 않음 |

## 구현 내용

### 별도 실행 및 데이터 경계

`companion/`은 원본 Electron `package.json`의 파일 목록에 포함되지 않는다. Companion 메타데이터와 main process는 다음 값을 원본과 분리한다.

- 제품명: `LilacAnime Companion Prototype`
- 앱 ID: `com.dinoforge.animeplayer.companion.prototype`
- 데이터 루트: `%LOCALAPPDATA%\LilacAnime-Companion-Prototype\` 아래의 전용 `userData`, `sessionData`, `cache`
- 렌더러: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- 외부 요청: Companion 세션에서 HTTP/HTTPS/WebSocket 차단, renderer CSP에서 `connect-src 'none'`
- preload: 분기 상태·합성 자막 번역·클립보드·사용자가 누른 ChatGPT 열기·새 파일 내보내기만 노출

원본 실행 파일, `app.asar`, 설치 디렉터리, 원본 설정·시청 기록·자막·쿠키·세션·업데이트 캐시에 접근하지 않는다. 원본 프로세스에 붙거나 스크립트를 주입하지 않는다. 이번 작업은 원본 LilacAnime를 실행하거나 재설치하지 않았고, NSIS 또는 설치용 패키지도 만들지 않았다.

### 패치 01 로직

- `src/quarter-selection.js`의 현지 날짜 분기 계산·저장 선택 해석을 재사용한다. 같은 분기에서는 사용자가 과거 분기를 고른 상태를 보존하고, 새 분기가 시작되면 현재 분기로 이동한다.
- `src/weekday-schedule.js`의 월요일 우선 요일 인덱스, Linkkf + Re:Anime/Miruro AniList 일정 병합, 보수적인 작품 매칭, 정확 회차 상태 분류를 재사용한다.
- UI는 가상 작품 7개와 합성 공급원 상태만 표시한다. RE:Anime·Miruro·Animenosub·애니24·Linkkf에 네트워크 요청을 하지 않는다. `재생 가능` 표시는 테스트 fixture의 가상값이며 실제 재생 주소 확인을 뜻하지 않는다.
- Linkkf 요일표와 AniList 예정 일정만 일정 입력으로 사용한다. 애니24/Animenosub의 방영 요일을 추정하지 않는다. 별도 출처 상태 목록은 회차 확인 화면용 합성 fixture다.

### 패치 02 로직

- 기존 `src/manual-subtitle-translation.js` parser, 언어 판별, batch 생성, 문맥 포함 프롬프트, 응답 cue ID 검증, WebVTT 재구성을 재사용한다.
- 기존 번역 프롬프트 로더를 통해 사용자 제공 영어/일본어 원문 파일을 고정된 언어 키로 불러온다. 두 프롬프트와 Reazon 예시 파일은 편집하지 않았고, SHA-256과 바이트 수는 [`prompt-hashes.json`](../../companion/prompt-hashes.json)에 기록했다.
- 사용자가 VTT를 직접 고르면 그 파일만 읽는다. 자동 ChatGPT 제출·쿠키/토큰 접근·비공식 API 호출은 없다. ChatGPT는 버튼을 눌렀을 때 브라우저에서 열리며, 대화 응답을 사용자가 앱으로 직접 붙여넣는다.
- 응답 cue ID의 누락·중복·추가를 거부하고, 번역이 모두 끝난 경우에만 기존 타임코드/순서를 유지한 `.ko.vtt`를 새 파일로 만든다. 원본 경로와 같은 출력 경로 및 이미 존재하는 파일은 덮어쓰지 않는다.
- Companion은 원본 앱의 로컬 AI 번역 경로를 호출하지 않는다. 이 프로토타입은 해당 기능을 변경하지 않았으며, 기존 로컬 AI가 원본에서 실행되는지 다시 검증하지 않았다.

## 사용자 의도 상태표

| 요구 | 구현/관찰 | 판정 |
|---|---|---|
| 원본 LilacAnime 유지 및 자동 업데이트 방해 없음 | 원본 저장소/프로필/설치본에 접근하지 않음. 별도 앱 ID·데이터 경로 작성 | 코드 경계 검증; Windows 실행 미검증 |
| Companion 실행 후 현재 분기·월~일 보기 | 현지 날짜 계산과 오늘 선택을 연결하고 5분 간격/창 복귀 시 상태 재확인 | 합성 로직 테스트 통과; 화면 미검증 |
| 새 분기 자동 반영, 과거 분기 선택 | 기존 분기 선택 헬퍼와 새 데이터 계산 사용 | 경계/저장 선택 테스트 통과 |
| 같은 작품 중복 방지, 다른 시즌 보호 | 기존 AniList ID 우선 및 제목/연도/시즌 보수 매칭 사용 | 합성 매칭 테스트 통과 |
| 다섯 출처 회차 상태 구분 | 정확 회차 기준으로 다섯 상태를 가상 fixture에서 표시 | 합성 로직 테스트 통과; 외부 서비스 미검증 |
| 불필요한 출처 조작 없이 재생 | 실제 출처 확인/재생은 연결되지 않음 | **미충족** |
| 영어/일본어 프롬프트·문맥·ID 검증 | 원문 프롬프트와 기존 수동 번역 helper 재사용 | 테스트 통과; 실제 ChatGPT 왕복 미검증 |
| 기존 로컬 AI 번역 유지 | 원본 코드를 수정하지 않고 Companion에서도 호출하지 않음 | 정적 경계 확인; 실제 실행 미검증 |
| 원본 안에서 애드온처럼 보이기 | 원본은 외부 플러그인 API를 제공하지 않음 | **미지원** |
| 원본에 번역 자막 자동 적용 | 새 VTT 내보내기 후 사용자가 원본에서 직접 선택해야 함 | 자동 적용 **미지원**; 수동 적용 미검증 |

## 검증

- `node --test companion/tests/*.test.cjs`: 13/13 통과. 분기 경계, 과거 선택, 요일 병합, 시즌 분리, 다섯 회차 상태, 프롬프트 선택/문맥, 응답 ID 검증, VTT 시간·순서, 출력 덮어쓰기 방지, 고유 앱/프로필·네트워크 경계를 확인했다.
- `npm test`: 296/296 통과. 이 격리 worktree에는 `node_modules`를 복사하거나 junction/symlink로 연결하지 않았다. 기존 개발 checkout의 설치된 패키지를 `NODE_PATH`로 참조했다.
- Companion `.js`/`.cjs` 구문 검사: 8/8 통과.
- 제공 프롬프트 2종과 Reazon 예시의 SHA-256/길이 검증 통과.
- 실제 원본 창, Companion 창, 설치 패키지, 공급원 HTTP 응답, 영상, 자막 검색, ChatGPT 왕복은 실행하지 않았다. 화면 사용성/Windows 런타임은 **미검증**이다.
- 앞서 중단한 패치 01·02 Windows 사용성 감사는 계속 중단 상태다. 이번 Companion 구현은 그 감사를 재개한 것이 아니다.

## 파일

- 신규: `companion/package.json`, `companion/compatibility.json`, `companion/prompt-hashes.json`
- 신규: `companion/core/catalog.cjs`, `companion/core/subtitle-workflow.cjs`
- 신규: `companion/electron/main.cjs`, `companion/electron/preload.cjs`
- 신규: `companion/renderer/index.html`, `companion/renderer/app.css`, `companion/renderer/app.js`
- 신규: `companion/tests/catalog.test.cjs`, `companion/tests/subtitle-workflow.test.cjs`, `companion/tests/security-boundaries.test.cjs`, `companion/README.md`
- 변경: `WORK_STATE.md`
- 신규: `docs/verification/RUNTIME_COMPANION_PROTOTYPE.md`

## 다음 단계

기능이 완성됐다고 보기 전에 사용자가 별도 Companion 창의 화면 검증을 허용해야 한다. 허용되면 실제 원본을 열지 않고 Companion 전용 프로필·합성 데이터만 사용해 화면과 반응형 동작을 검증한다. 원본 내부 UI 연동과 실제 재생 자동 연결은 공개/허용된 버전형 원본 API가 생기기 전까지 미지원으로 유지한다.
