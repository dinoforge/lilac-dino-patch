# 패치 02 — ChatGPT 계정 직접 연결은 추가 옵션 (SIWC)

2026-10-11 · 별도 브랜치 `codex/patch-02-siwc-additive` · 기준 `codex/patch-02-clipboard-companion`

## 목적과 변경 범위

사용자의 명시적 요구는 **기존 로컬 AI·API 번역·수동 ChatGPT 번역을 전혀 대체하지 않고**, 여기에 별도의 `ChatGPT 계정 연결(SIWC)` 번역 방식을 **추가하는 것**이다.

기존 번역 흐름은 수정하지 않았다. 별도 설정 항목을 추가하고 `electron/siwc-contract.cjs`에 공식 흐름의 검증 가능한 프로토콜 구성 요소를 마련했다. 기술 준비 내용은 동적 신규 등록 `dynamic_agent_client`, 시스템 브라우저 인가 URL, `ext_agent_host_id`, loopback `127.0.0.1` 콜백, `state`, OIDC `nonce`, PKCE S256, 발급된 `oaiapp_...` 클라이언트 ID 검사, 허용된 토큰 교환 요청 형식, `chatgpt.tokens.use.direct` 및 `resource.invoke` 별도 권한 검사, Responses API의 `store:false, stream:true` 요청 형식이다.

설정의 SIWC 연결 버튼은 **의도적으로 비활성화**되어 있다. 이는 미지원 프로젝트·미완성 인증을 작동하는 것처럼 보이지 않게 하기 위한 것이다. `공식 연결 안내` 버튼은 사용자 명시 클릭 시 공식 설명 페이지로 연다.

## 현재 구현하지 않은 실제 로그인 및 번역

- 시스템 브라우저 OAuth 시작, loopback HTTP 서버 및 성공 callback 이벤트 연결
- OpenAI JWKS를 이용한 ID token 서명·`iss`/`aud`/`nonce` 검증
- Refresh token을 OS 보안 저장소에 저장하고 갱신·철회·로그아웃
- 실제 사용자 계정의 동적 클라이언트 등록 가능 여부 검증
- 사용자 소유 모델 목록 조회 및 모델 선택 UI
- OAuth 액세스 토큰으로 스트리밍 Responses API를 호출하고, 자막 ID 검사·저장·적용까지 연결하는 동작
- 실제 ChatGPT 로그인·AI 요청·번역 품질 테스트

따라서 **ChatGPT 계정 직접 로그인 또는 자동 번역이 완료됐다고 주장하지 않는다**. 현재 단계는 분리된 추가 옵션과 안전한 프로토콜 구성 준비에 한한다. API 키 없이 웹 UI를 자동 조작하거나 쿠키를 가져오는 코드는 없다. 대화 읽기·대화 삭제도 없다.

## 공식 문서

- https://developers.openai.com/siwc/quickstart
- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

공식 문서는 ChatGPT plan 사용을 오픈소스 파트너 및 일부 비공개 클라이언트에 제공한다고 명시한다. 이 **비공개 저장소가 허용되는지 불분명**하다. 배포·연결 전에 자격과 승인 흐름을 별도 확인해야 한다.

## 검증 기록

- 수정된 `src/patch-manager-stage2.js`와 새 `electron/siwc-contract.cjs` JavaScript의 V8 구문 검사 통과.
- `patch-manager/test/siwc-contract.test.cjs`에 PKCE 분리, 정확한 loopback URI, OAuth 콜백 state, 발급 클라이언트 ID 검증, 토큰 교환 구성, 권한 격리, 추론 요청 옵션 테스트 추가.
- 이번 작업 환경에서 실제 Node `node --test`, 전체 `npm test`, Electron GUI, 설치본·프로필·NSIS·실제 OAuth 요청은 실행하지 않았다. 기존 315/315 테스트 결과를 신규 브랜치의 성공 결과로 간주하지 않는다.

다음 검증은 격리된 Windows 복사본에서 새 테스트와 기존 테스트 전부를 실행하고, 별도 승인된 자격이 확보된 경우에만 인증과 실사용 번역을 구현·검증하는 것이다. 실제 설치본 `D:\LilacAnime`, `main`, upstream 및 기존 개인 기록은 변경하지 않는다.
