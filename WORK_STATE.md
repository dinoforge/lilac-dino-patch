# 작업 상태

## 목표

LilacAnime 기반의 Windows 우선 애니메이션 앱을 별도 프로젝트로 시작하고, 1–42 요구사항에 맞춰 단계적으로 검증·개선한다. 원본 앱과 사용자의 기존 프로필은 보존한다.

## 저장소와 기준선

- 작업 폴더: D:\Codex-Coding-Folder\LilacAnime-Player
- GitHub: https://github.com/dinoforge/anime-player (비공개)
- 원본 기준: whispelyn-byte/LilacAnime-desktop main, v0.5.6, d7d4ec4853d252d67f0febb939be9770ca703444
- 초기 main 스냅샷: 2bf37e51f1ab07f7c7b0d06f86cb6705005642f2, root commit
- upstream 원본 이력은 로컬 upstream-main 브랜치에 남아 있다. 새 GitHub 저장소에는 main 스냅샷만 push했다.
- Phase 0 보고서 commit: f2feb47c7440ae5c5a7995e9f7bc67e4c17ae472.
- 첫 Phase 1 코드 변경: 다음 화 자동 재생 설정과 종료 후 자동 전환을 제거하고, 종료 시 수동 선택 안내를 표시한다. 다음 화 버튼은 유지한다.

## 완료

- 새 폴더 이름 LilacAnime-Player로 시작했다.
- 비공개 GitHub 저장소 anime-player를 만들고 main을 push했다. Phase 0 보고서 commit까지 원격 SHA와 로컬 HEAD가 일치하는 것을 확인했다.
- 사용자 제공 CODEX_FIRST_PROMPT.md와 CODEX_MASTER_PLAN.md를 docs/planning에 보관했다.
- 기준선 자동 테스트는 10/10, 자동 재생 제거 후 관련 자동 테스트는 11/11 통과했다.
- 변경 후 npm run dist가 성공했고 Windows NSIS 설치 파일을 다시 만들었다.
- 실제 외부 재생은 검증하지 않았다. 라이브 테스트 파일도 실행하지 않았다. 기존 기본 앱 데이터 프로필은 열어보지 않았다.
- Phase 0 보고서: docs/BASELINE_AUDIT.md, docs/FEATURE_GAP.md, docs/PHASE1_PLAN.md.

## 주요 결정

- 새 앱은 Windows 우선, Android는 후속이다. Chrome·macOS는 제품 범위에서 제외한다.
- 새 저장소는 비공개로 둔다. 원본 라이선스와 출처별 이용 조건이 확인되기 전 공개 배포하지 않는다.
- 첫 기능 검증은 검색·상세·회차·실제 재생·로컬 이어보기·한국어 자막·수동 싱크·다음 화 수동 시작이다.
- 자동 자막 싱크와 API 없는 ChatGPT 자동 번역은 미검증 목표다. 외부 API 자동 번역을 필수로 두지 않는다.
- 요구사항 28에 따라 다음 화 자동 재생을 끈다.

## 다음

1. 보고서 및 첫 코드 변경을 새 main에 commit/push하고 원격 SHA를 확인한다.
2. 실제 영상·자막 테스트 전 원본 재사용 권한과 각 출처의 이용 조건을 확인한다.
3. 허가된 실제 자료와 분리된 userData 프로필로 Windows 시청 흐름을 검증한다.
