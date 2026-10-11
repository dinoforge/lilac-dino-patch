# 디노 라일락 패치 — ChatGPT 내장 웹 창 검증

2026-10-11 · 작업 브랜치 `codex/dino-chatgpt-web-translation`
기준 브랜치 `codex/dino-lilac-patch-engine` (`9fec31108cc58a374794eb808a5887fb87aae389`)

## 사용자가 요청한 방향

- 패치 02에서 **SIWC를 새 적용 대상에서 제외**한다. 기존 API/로컬 AI 번역은 보존한다.
- ChatGPT 웹사이트를 별도의 시스템 브라우저 대신 LilacAnime가 띄우는 **전용 Electron 창**에 표시한다.
- 자막 번역용 프롬프트/묶음 생성, 클립보드 복사/가져오기, 응답 ID 검증, 한국어 VTT 저장과 즉시 적용은 유지한다.
- ChatGPT 웹 번역에 쓰인 대화만 정리하고 싶다는 목표가 있지만, **현재 웹 대화방 자동 삭제는 미구현**이다.

## 실제 변경

- `electron/embedded-chatgpt-web.cjs`: ChatGPT 홈페이지를 사용자 클릭에서만 여는 전용 Electron BrowserWindow 구현. 고정된 기본 창 크기, 재사용 가능한 창, 독립적인 `persist:dino-lilac-chatgpt-web` 세션을 사용한다. Node 통합 비활성, context isolation, sandbox, web security를 적용한다.
- 외부 브라우저 쿠키·프로필·비밀번호·ChatGPT 메시지를 프로그램이 읽지 않는다. 보안상 `file:`, `javascript:`, `data:`, HTTP 탐색을 거부하고 로그인에 필요한 HTTPS 팝업도 동일한 분리된 세션으로 열도록 한다.
- `electron/patch-manager-stage2.cjs`: SIWC IPC 등록을 제거하고 `patch:chatgpt-web:open`으로 사용자가 내장 창을 열도록 연결.
- `patch-manager/adapters/lilacanime-v0.5.14.cjs` 및 `patch-manager/adapters/lilacanime-independent.cjs`: 새 패치 02 payload에서 `electron/siwc-*.cjs`, `src/siwc-subtitle-bridge.js`, SIWC preload IPC를 제외하고 내장 창 모듈/IPC를 연결. 기존 SIWC 구현 파일과 독립 테스트는 이력으로 보존하지만 새 앱 payload에 포함하지 않는다.
- `src/patch-manager-stage2.js`: ChatGPT 계정 연결(SIWC) UI 대신 내장 ChatGPT 버튼을 제공하고, 사용자가 작성된 번역 프롬프트를 복사해 내장 창에서 붙여넣을 수 있게 연결한다. 수동 응답 가져오기/검증/자막 적용은 그대로 사용한다. 저장 성공 이후 웹 대화 정리 안내를 표시한다.
- 독립 적용 구조와 패치 01은 그대로 보존한다.

## 확인한 테스트

Windows GitHub Actions: [검증 성공 실행](https://github.com/dinoforge/anime-player/actions/runs/38149182789)

| 검사 | 결과 |
|---|---|
| 내장 창 모듈/IPC/네비게이션/실패 보호 집중 테스트 | **5/5 성공** |
| v0.5.14·v0.5.15 공식 소스 격리 복사본 대상 독립 패치 적용 테스트 | **9/9 성공** |
| 전체 Node 회귀 테스트 (`npm test`) | **376/376 성공, 실패 0, 건너뜀 0** |
| 변경 JS/CJS 구문 확인 | 성공 |
| 처음 발견된 오래된 SIWC 포함 검증과 CI 얕은 체크아웃 문제 | SIWC 제외 기대값 및 Git 전체 이력 조회로 수정 후 통과 |

검증은 **모의 Electron 창과 공식 소스의 격리 복사본에 한정**되어 있다. 원본 LilacAnime 전체 GUI 또는 실계정으로 ChatGPT를 연 것이 아니다.

## 중요한 미구현/제약

1. ChatGPT 웹사이트의 HTML/DOM, 버튼, 웹 접근/로그인 정책은 앱이 고정할 수 없다. 내장 BrowserWindow의 창 크기와 패치쪽 UI만 고정할 수 있다.
2. **번역 프롬프트 웹 입력·제출, ChatGPT 웹 응답 자동 수집, 웹 대화방 자동 삭제는 미구현**이다. 기존 클릭+복사·붙여넣기/가져오기 방식을 그대로 유지한다. API 키나 SIWC를 통해 웹 대화에 자동 접근하지 않는다.
3. 내장 Electron 창에서 ChatGPT 로그인이 실제 허용되는지, 타사 로그인 팝업이 완료되는지, 웹 페이지를 렌더링할 수 있는지 실환경 검증하지 않았다.
4. `DinoLilacPatch.exe` 제작, 실사용 설치본 `app.asar` 적용·복원, 공식 updater 연결도 아직 없다.
5. 삭제할 웹 대화는 오직 해당 사용자가 ChatGPT 화면에서 직접 선택하여 삭제해야 한다. 사용자 기존 대화를 전혀 조회하지 않는다.
6. 실제 `D:\LilacAnime`, `%APPDATA%\lilacanime-desktop`, `%LOCALAPPDATA%\lilacanime-desktop-updater`는 읽거나 수정하지 않았다.

## 판정

**내장 ChatGPT 웹 화면으로 전환할 수 있는 패치 02용 시험적 브리지는 구현·단위 검증 완료.** 완전 자동 웹 번역/웹 대화 삭제 및 실제 Electron 사용성은 검증되거나 구현된 것으로 보고하지 않는다. `main`에는 병합하지 않는다.
