# 패치 02 — ChatGPT 웹 클립보드 보조 기능

2026-10-11 · 브랜치 `codex/patch-02-clipboard-companion`
시작 기준: `codex/patch-02-translation-ux-login` (`bf0cb840c500183f1cbb68af1cfea37c42b0646e`)

## 목표와 구현 범위

웹쫀쿠처럼 번역 과정의 클릭 수를 줄이는 요청에 따라, ChatGPT 웹사이트를 사용자가 직접 이용하면서 **결과 복사 뒤 LilacAnime 안에서 한 번 클릭으로 확인 및 적용**하도록 추가했다.

기존 자막 번역 패널에 `복사한 번역 가져와 바로 적용` 버튼을 추가했다. 버튼을 누른 경우에만 Electron clipboard `readText()`를 IPC를 통해 호출한다. 클립보드의 번역 결과를 **해당 회차·현재 묶음의 정확한 자막 ID**와 대조해 유효할 때만 입력창에 반영하고 기존 검증·회차별 세션 저장·VTT 생성·즉시 적용 경로를 사용한다. 마지막 묶음이면 기존의 자동 저장·적용·설정에 따른 임시 세션 정리가 수행된다.

- 사용자가 이미 입력창에 내용을 작성한 경우 클립보드로 교체하기 전에 확인을 받는다.
- 빈 클립보드, 2,000,000자 초과, 파싱 불가 JSON, 중복·누락·다른 회차 ID를 거부한다.
- 잘못된 클립보드 내용은 번역 입력창이나 저장 세션을 덮지 않는다.
- 비동기 클립보드 읽기 중 재생 회차·원본 자막이 변경되면 적용하지 않는다.
- 원래 WebVTT의 시간 코드·cue 순서와 번역 프롬프트 원문 파일을 유지한다.
- 별도의 설치 파일, 실제 사용자 폴더 수정, 기존 설치본 적용, `main` 병합은 하지 않았다.

## 사용자 사용 흐름 (키보드 명령어 불필요)

1. 격리된 패치 적용 앱에서 영어 또는 일본어 자막을 선택한다.
2. `ChatGPT 수동 번역`을 선택하고 `요청 복사 · ChatGPT 열기`를 클릭한다.
3. 브라우저의 ChatGPT에 직접 붙여넣고 번역 요청을 전송한다.
4. ChatGPT가 반환한 JSON 번역 결과를 사용자가 복사한다.
5. 앱으로 돌아와 `복사한 번역 가져와 바로 적용`을 클릭한다.
6. 앱은 유효한 응답만 처리하고 진행률을 갱신한다. 묶음이 더 있으면 2–5단계를 반복한다. 마지막 묶음 뒤에는 한국어 VTT를 저장하고 영상에 적용한다.

기존 직접 붙여넣기와 `입력한 결과 확인` 버튼도 유지한다.

## ChatGPT 인증·웹 대화 관련 한계

- 별도 허가된 SIWC 클라이언트 연결/Responses API 권한이 확인되지 않아, **ChatGPT 계정 로그인과 완전 자동 AI 요청은 추가하지 않았다.**
- 앱이 ChatGPT의 웹 세션, 인증 쿠키, 메시지 DOM, 대화 목록을 접근하거나 자동 추출하지 않는다.
- ChatGPT 웹 대화 자동 삭제도 구현하지 않았다. 앱 내부 번역 작업의 정리와는 다르다.
- ChatGPT 웹사이트에서 사용자가 직접 결과를 복사해야 한다.
- 공식 인증 경로는 https://developers.openai.com/siwc/quickstart 및 https://developers.openai.com/siwc/token-sharing-open-source 를 별도로 검토하고, 동의·등록·권한이 갖춰질 때만 확장한다.

## 검증과 미검증을 분리한 기록

- 연결된 GitHub 저장소의 실제 `src/patch-manager-stage2.js`, `electron/patch-manager-stage2.cjs`, `patch-manager/adapters/lilacanime-v0.5.14.cjs`를 가져와 수정했다.
- 세 파일의 JavaScript 문법을 V8 구문 분석으로 확인했다.
- 실제 Electron IPC 등록 코드를 모의 외부 의존성에 연결해 실행했고, **사용자 호출 전 클립보드 조회 0회**, 명시적 조회, 빈/초과 길이 거부, 잘못된 cue ID 거부, 실제 `manual-subtitle-translation.js`의 VTT 시간 코드 보존을 확인했다.
- 신규 회귀 테스트 파일: `patch-manager/test/clipboard-companion.test.cjs`. 명시적 IPC 조회, 거부 케이스, 자막 결과 적용, v0.5.14 preload 브리지 및 UI 버튼 연결을 검사한다.
- **이번 실행 환경은 사용자 PC의 프로젝트 워크트리와 실제 Electron GUI를 실행할 수 없으므로**, 전체 `npm test`, 새 회귀 테스트의 Node 실행, Windows unpacked 패키징, 실제 브라우저 로그인·외부 ChatGPT 왕복을 다시 실행했다고 보고하지 않는다.
- 기존 브랜치의 315/315 및 Windows 격리 Electron 통합 결과는 이번 변경에 대한 새 검증으로 집계하지 않는다.

후속 검증 필요: 새 브랜치 전체 `npm test`, 해당 Electron UI에 대한 마우스 이벤트 시험, 24 cue 초과 다중 묶음, 클립보드 읽는 도중 회차 전환, 유효/잘못된 JSON 응답 교대, 비활성화 상태, 격리 Windows unpacked 빌드. 기존 앱과 사용자 데이터는 유지한다.
