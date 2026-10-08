# 작업 상태

## 목표

LilacAnime 기반의 Windows 우선 애니메이션 앱을 별도 프로젝트로 시작하고, 1–42 요구사항에 맞춰 단계적으로 검증·개선한다. 원본 앱과 사용자의 기존 프로필은 보존한다.

## 저장소와 기준선

- 작업 폴더: D:\Codex-Coding-Folder\LilacAnime-Player
- GitHub: https://github.com/dinoforge/anime-player (비공개)
- 원본 기준: whispelyn-byte/LilacAnime-desktop main, v0.5.6, d7d4ec4853d252d67f0febb939be9770ca703444
- 초기 main 스냅샷: 2bf37e51f1ab07f7c7b0d06f86cb6705005642f2, root commit
- upstream 원본 이력은 로컬 upstream-main 브랜치에 남아 있다. 새 GitHub 저장소에는 main 스냅샷만 push했다.
- 원본 코드 변경은 아직 없다.

## 완료

- 새 폴더 이름 LilacAnime-Player로 시작했다.
- 비공개 GitHub 저장소 anime-player를 만들고 main을 push했다. 원격 SHA와 로컬 HEAD가 일치하고 작업 트리가 깨끗한 것을 확인했다.
- 사용자 제공 CODEX_FIRST_PROMPT.md와 CODEX_MASTER_PLAN.md를 docs/planning에 보관했다.
- 의존성 설치, 로컬 자동 테스트 10/10, Windows NSIS 패키지 빌드를 확인했다.
- 실제 외부 재생은 검증하지 않았다. 라이브 테스트 파일도 실행하지 않았다. 기존 기본 앱 데이터 프로필은 열어보지 않았다.
- Phase 0 보고서: docs/BASELINE_AUDIT.md, docs/FEATURE_GAP.md, docs/PHASE1_PLAN.md.

## 주요 결정

- 새 앱은 Windows 우선, Android는 후속이다. Chrome·macOS는 제품 범위에서 제외한다.
- 새 저장소는 비공개로 둔다. 원본 라이선스와 출처별 이용 조건이 확인되기 전 공개 배포하지 않는다.
- 첫 기능 검증은 검색·상세·회차·실제 재생·로컬 이어보기·한국어 자막·수동 싱크·다음 화 수동 시작이다.
- 자동 자막 싱크와 API 없는 ChatGPT 자동 번역은 미검증 목표다. 외부 API 자동 번역을 필수로 두지 않는다.
- 요구사항 28에 따라 다음 화 자동 재생을 끈다.

## 다음

1. Phase 1 코드 변경 전에 원본 재사용 권한과 실제 테스트 영상·자막 출처의 이용 조건을 확인한다.
2. 첫 코드 변경은 보고서의 최소 범위부터 시작한다.
3. 실제 서비스 검증과 로컬 테스트를 분리해 기록한다.
