# 패치 02 — Sign in with ChatGPT(SIWC) 추가 연결 런타임

작성일: 2026-10-11
작업 브랜치: `codex/patch-02-siwc-runtime`
기준 브랜치: `codex/patch-02-siwc-additive`
GitHub Actions SIWC 단독 검증: https://github.com/dinoforge/anime-player/actions/runs/38130205203

## 구현 목적과 기존 기능 보존

사용자 요구대로 ChatGPT 계정 직접 연결을 **네 번째 번역 방식으로 추가**한다. 기존 로컬 AI, Gemini/OpenAI/DeepL/Qwen API, ChatGPT 웹 수동 번역, 패치 01은 수정하지 않았다. 최종 패치 적용은 여전히 **격리된 LilacAnime v0.5.14 소스 복사본의 어댑터**를 대상으로 하며, 실제 기존 설치본에 적용하지 않았다.

## 추가된 모듈과 실제 동작 코드

- `electron/siwc-contract.cjs`: PKCE S256, 랜덤 state/nonce, issued client ID, 정확한 127.0.0.1 콜백, 권한·요청 형식
- `electron/siwc-oidc.cjs`: RS256 JWKS 서명 검증, ID token issuer/audience/nonce/만료 검사, 계정별 모델 목록 필터, Responses SSE 완료 상태 검증
- `electron/siwc-client.cjs`: 명시적 버튼 클릭 시 시스템 브라우저 OAuth 실행, 임시 로컬 HTTP 콜백, 토큰 교환과 신원 확인, Electron safeStorage 보안 저장, 토큰 갱신, 모델 조회, 번역 요청, 중단·연결 해제
- `src/patch-manager-stage2.js`: SIWC 별도 설정, 연결 상태, 연결·해제, 모델 선택, 공식 도움말 링크
- `src/siwc-subtitle-bridge.js`: 자막이 준비된 회차에 별도 ChatGPT 계정 자동 번역 버튼 추가. 원본 영어·일본어 VTT, 기존 사용자 프롬프트, 작품/회차/앞뒤 문맥을 사용해 묶음별 번역 요청. 각 응답은 cue ID 검사 후 진행률 갱신. 마지막 묶음은 한국어 VTT로 별도 저장·즉시 적용. 중단 또는 실패 시 완료된 묶음을 기존 안전한 회차·원본 지문 세션에 보존.
- `electron/patch-manager-stage2.cjs`: 추가된 SIWC IPC의 Electron main 한정 등록
- `patch-manager/adapters/lilacanime-v0.5.14.cjs`: SIWC 런타임/자막 UI payload 추가, 앱 Electron preload IPC 브리지 연결
- `.github/workflows/siwc-isolated.yml`: Windows 자동 검증, 전체 프로젝트 회귀 테스트 단계

SIWC 렌더러에는 OAuth 토큰이나 refresh token을 전달하지 않는다. 서버 주소는 공식 인증·모델·Responses API만 사용한다. OpenAI 웹사이트에서 쿠키를 추출하거나 chatgpt.com을 자동 조작하지 않는다. 자동 API 요청은 `store: false`와 `stream: true`로 생성하며, 서버의 `response.completed`를 수신하지 못하면 번역 성공으로 표시하지 않는다.

계정 로그아웃은 앱이 자체 `userData/siwc-account/credential.enc`에 생성한 암호화 자격증명만 삭제하며, 원본 자막·시청 기록·기존 프로필은 삭제하지 않는다. 보안 암호화를 사용할 수 없는 환경에서는 로그인 기능을 거부한다. 계정 승인 시작은 마우스 클릭이며, 브라우저의 로그인 동의는 사용자가 직접 수행해야 한다.

## 지원 범위 / 중요한 미검증 항목

**실제 ChatGPT 계정으로의 로그인 성공은 검증하지 않았다.** SIWC의 계정 자격과 프로젝트 등록·승인 여부도 알 수 없다. 특히 개인 비공개 프로젝트가 승인된 SIWC 클라이언트인지 확신할 근거가 없다. 브라우저가 가입/동의를 거절하거나 모델이 없으면 앱은 오류를 안내하고 기존 번역 방식을 유지한다.

실제 OpenAI 서버와 왕복한 번역, 실시간 번역 품질, 사용자 계정 사용량·요금 조건, 일반 LilacAnime 설치본과 실제 GUI 전체 클릭 테스트, 원본 upstream 전체 화면 스크린샷은 아직 미검증이다. ChatGPT 웹 대화 기록을 읽거나 삭제하는 기능도 구현하지 않았다. SIWC는 계정 인증·공식 API 호출이고 chatgpt.com 브라우저 대화 조작이 아니다.

실제 계정 로그인에 성공하더라도, 계정에서 ChatGPT 플랜 직접 사용 scopes가 부여된 경우에만 모델 목록과 자동 번역을 제공한다. 당사자의 승인·권한 없는 요청이나 유료 API 키 요청을 실행하지 않는다.

## 검증 결과

- 새로운 SIWC 파일, adapter 및 테스트 파일의 V8 JavaScript 구문 검사 통과.
- Windows GitHub Actions run `38130205203`: **SIWC 전용 Node 테스트 10개 통과, 0실패**. 합성 RSA 서명 ID token, 실제 로컬 loopback HTTP 서버(가짜 OpenAI 서버 응답), 클립보드/번역 시스템과의 격리, 계정별 모델 조회, SSE 결과 확인, 암호화 미지원 시 거부, 다른 사용자 파일 보존을 검사.
- 이 테스트는 사용자 ChatGPT 계정, 공개 OpenAI 인증 서버, 외부 자막 공급원, 실제 실물 영상에 접속하지 않는다.
- 같은 브랜치에 Windows full `npm test` 수행용 CI 단계를 추가했다. **완료 여부는 GitHub Actions 결과로 별도 확인**하며 실행 전에는 통과했다고 주장하지 않는다.

## 작업 안전 조건

- `main` 브랜치, 공식 upstream, 기존 `D:LilacAnime` 설치본, 기존 `%APPDATA%lilacanime-desktop`와 시청 기록/업데이트 캐시에는 패치를 적용하거나 변경하지 않았다.
- NSIS 설치·기존 설치 앱 수정·패치 매니저 실제 설치본 적용을 수행하지 않았다.
- `영어 번역 프롬프트.txt`, `일본어 번역 프롬프트.txt`, 사전 원본은 수정하지 않았다.
- 신규 기능에 필요한 파일은 독립 브랜치와 SIWC 자체의 별도 프로필 영역에만 위치한다.

## 공식 문서

- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/website

## 다음 검증 단계

1. Windows 전체 회귀 테스트의 GitHub Actions 로그 확인.
2. 별도 격리된 Windows Electron v0.5.14 실제 인덱스 화면과 시스템 브라우저 콜백을 조작하는 통합 시험.
3. OpenAI가 해당 프로젝트·계정의 SIWC 사용을 허용할 때만 사용자 동의로 실제 로그인 및 모델·스트리밍 요청 시험.
4. 이후 사용자 승인에 따라 설치 방식 검토. 기존 설치본이나 기본 프로필을 수정하지 말 것.
