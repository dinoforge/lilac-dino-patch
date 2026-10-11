# 모든 작업 브랜치 통합 기록 · 2026-10-11

## 목표
`dinoforge/anime-player`의 **기존 작업 브랜치 17개 모두**를 `main`에 통합한다. 브랜치 및 커밋 이력을 삭제하거나 강제 재작성하지 않는다. 사용자 PC의 LilacAnime 기존 설치본과 개인 프로필은 건드리지 않는다.

## 통합 기준
주요 패치 01·02 계열(분기·요일별 편성, 사용자 프롬프트, 패치 관리자, 수동 ChatGPT 번역, 클립보드 보조, 별도 SIWC 계정 연결·자동 자막 변환)은 최신 후손 `codex/patch-02-siwc-runtime` 전체를 기반으로 한다.

이 버전에 포함되지 않은 나머지 세 갈래:
- `codex/companion-window-overlay`: 동반 앱·오버레이 실행 구조와 실험적 runtime attach 계열. 해당 계열의 `codex/runtime-companion-prototype`, `codex/runtime-attach-feasibility`, `codex/runtime-attach-native-style`, `codex/runtime-attach-unmodified-feasibility`를 조상으로 포함.
- `codex/inapp-upstream-v0.5.14-patch01-02`: 독립된 공식 v0.5.14 검증/적용 준비 스크립트 2개.
- `codex/companion-architecture-audit`: 별도 타당성 검토 문서.

## 충돌 해결 방침
최신 SIWC 브랜치의 기존 공통 파일(`src/app.js`, `electron/main.cjs`, `electron/preload.cjs`, `src/manual-subtitle-translation.js`, 기존 테스트, `WORK_STATE.md`)을 유지하고, 독립 브랜치에서만 만들어진 별개 파일을 합친다. 위 세 갈래의 신규 코드는 공통 player를 덮어쓰지 않는다.

이는 **단일 자동 설치 패치 완성**이 아니다. 동반 앱과 원본 앱 어댑터는 독립 구현체로 공존하며, 별도 기능과 테스트가 서로 일치하지 않을 수도 있다. SIWC 실제 계정 자격·로그인·AI 요청 및 라이브 자막 품질은 검증되지 않았다.

## CI
- 최신 SIWC 브랜치 Windows CI: 공식 v0.5.14 소스 격리 fixture 포함 `npm test` 330/330 성공(2026-10-11, 이전 브랜치 실행).
- 본 통합 브랜치와 `main`은 추가 Windows CI를 수행한다. **그 결과가 나오기 전 성공을 주장하지 않는다**.
- 기존 `D:\LilacAnime`, `%APPDATA%\lilacanime-desktop`, 원본 시청 기록·설정·업데이터 캐시 보존. 설치·NSIS·실물 앱 패치는 실행하지 않는다.

## 통합 대상 브랜치 목록
- codex/companion-architecture-audit
- codex/companion-window-overlay
- codex/inapp-upstream-v0.5.14-patch01-02
- codex/integration-01-02
- codex/patch-01-auto-quarter
- codex/patch-01-weekly-airing
- codex/patch-02-chatgpt-translation
- codex/patch-02-clipboard-companion
- codex/patch-02-siwc-additive
- codex/patch-02-siwc-runtime
- codex/patch-02-translation-ux-login
- codex/persistent-patch-manager
- codex/persistent-patch-manager-stage2
- codex/runtime-attach-feasibility
- codex/runtime-attach-native-style
- codex/runtime-attach-unmodified-feasibility
- codex/runtime-companion-prototype

모든 브랜치 헤드가 통합 커밋의 조상이 되었는지 `compare_commits`로 확인한다. 검증 완료 시 승인받은 `main`에 **비강제 fast-forward**로 반영한다.