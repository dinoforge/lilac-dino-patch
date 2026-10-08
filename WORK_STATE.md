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
- 재생 변경 checkpoint: e9ce2df8e05c53044aaae181b1266a77faecc81e. 확인 시 origin/main SHA와 일치했고 작업 트리가 깨끗했다.

## 완료

- 새 폴더 이름 LilacAnime-Player로 시작했다.
- 비공개 GitHub 저장소 anime-player를 만들고 main을 push했다. 초기 root commit으로 원본 전체 이력을 새 저장소에 올리지 않았다.
- 사용자 제공 CODEX_FIRST_PROMPT.md와 CODEX_MASTER_PLAN.md를 docs/planning에 보관했다.
- 기준선 자동 테스트는 10/10, 자동 재생 제거 후 관련 자동 테스트는 11/11 통과했다.
- 변경 후 npm run dist가 성공했고 Windows NSIS 설치 파일을 다시 만들었다.
- 실제 외부 재생은 검증하지 않았다. 라이브 테스트 파일도 실행하지 않았다. 기존 기본 앱 데이터 프로필은 열어보지 않았다.
- Phase 0 보고서: docs/BASELINE_AUDIT.md, docs/FEATURE_GAP.md, docs/PHASE1_PLAN.md.

## 2026-10-09 진행 상태

- 원본 `main`과 최신 릴리스 태그는 모두 v0.5.6 / `d7d4ec4853d252d67f0febb939be9770ca703444`이며 기준선 이후 새 커밋은 없다.
- 회차 종료 처리에서 이어보기 진행률을 100%로 확정하고 `localStorage`에 즉시 저장하도록 보강했다. 5초 저장 간격 안에 앱을 닫아도 완료 위치가 빠지지 않도록 했다. 다음 화 자동 재생은 계속 비활성이다.
- 회차 종료 진행률 저장 수정 당시 `node --test tests/player-interactions.test.cjs tests/flix-proxy.test.cjs` 11/11 통과, `npm run dist` Windows NSIS 빌드 성공. 설치 패키지에서 수정 코드를 확인했다.
- 실제 외부 영상·자막 재생 및 별도 userData 프로필 검증은 아직 하지 않았다.
- 이전 `reanime-korean-display` 폴더는 사용자가 직접 정리하기로 했다. 이 프로젝트에서는 해당 폴더를 이동하거나 삭제하지 않는다.
- Linkkf 요일표가 요일별 API 실패와 실제 빈 목록을 구분하고, 실패한 요일을 다시 불러오도록 수정했다. 요일별 일부 실패도 다른 요일 목록을 유지한다.
- `node --test tests/player-interactions.test.cjs tests/flix-proxy.test.cjs`: 13/13 통과. `node --check`와 `git diff --check`도 통과했다. `npm run dist`로 Windows NSIS 설치 파일을 다시 만들었고, 패키지 `app.asar`에서 새 응답 상태 처리와 재시도 UI를 확인했다. 설치 파일은 124,519,640바이트다.
- LinkAni는 사용자 결정으로 콘텐츠 공급원에서 제외했다. 설정 선택지와 검색·상세·재생 네트워크 어댑터를 제거하고, 이전 `contentSource=linkani` 값만 RE:Anime로 옮긴다. 라이브러리·시청 기록·다운로드 데이터는 삭제하지 않는다. 이전 LinkAni 기록은 재생할 수 없다는 안내를 보인다.
- LinkAni 제거 검증: 관련 테스트 15/15 통과, `node --check`와 `git diff --check` 통과. `npm run dist` Windows NSIS 빌드 성공. 패키지 `app.asar`에서 LinkAni 선택지·온라인 어댑터가 없고, 이전 설정 마이그레이션과 저장 기록 안내는 포함된 것을 확인했다. 설치 파일은 124,518,298바이트다. 외부 사이트 재생은 이번 변경에서 검증하지 않았다.
- 분기별 탐색을 RE:Anime·Miruro·Animenosub에 추가했다. 연도와 1~4분기를 선택하며 공급원별 확인된 시즌·연도 필터만 사용한다. Linkkf·애니24는 과거 분기 분류에 쓸 확정 날짜가 없어 추정하지 않고 안내한다. 선택값은 공급원별로 저장하고 목록은 12시간 캐시(최대 16개 목록)를 사용하며, 새로고침 실패 시 저장본을 보여 준다. 빈 목록도 선택·재시도 UI에 남게 했고, 초기 응답이 뒤늦게 도착해 사용자의 새 선택을 덮지 않도록 했다. 관련 자동 테스트 20/20, 구문 검사, `git diff --check`가 통과했다. `npm run dist` Windows NSIS 빌드가 성공했고, 124,520,219바이트 설치 파일과 패키지 `app.asar`의 쿼리 헬퍼·IPC·preload·UI 포함을 확인했다. 실제 공급원 사이트 응답·재생·모바일은 미검증이다.
- 코드·영상·자막의 이용 조건을 1차 자료 중심으로 검토해 `docs/RIGHTS_REVIEW.md`에 기록했다. 업스트림 README는 원작자 허락을 받아 포팅했다고 주장하지만 허락 문서와 범위는 독립 확인되지 않았다. 각 영상·자막 공급원의 사이트 소개와 도메인 안내는 찾았으나 앱 연동·저장·재배포를 허용하는 조건은 확인되지 않았다. 따라서 저장소 비공개와 외부 설치 파일 미배포 결정을 유지한다. 권리자에게 연락하지 않았다.

## 주요 결정

- 새 앱은 Windows 우선, Android는 후속이다. Chrome·macOS는 제품 범위에서 제외한다.
- 새 저장소는 비공개로 둔다. 원본 라이선스와 출처별 이용 조건이 확인되기 전 공개 배포하지 않는다.
- 지원 공급원은 Linkkf, 애니24, Animenosub, RE:Anime, Miruro다. LinkAni는 제외한다.
- 첫 기능 검증은 검색·상세·회차·실제 재생·로컬 이어보기·한국어 자막·수동 싱크·다음 화 수동 시작이다.
- 자동 자막 싱크와 API 없는 ChatGPT 자동 번역은 미검증 목표다. 외부 API 자동 번역을 필수로 두지 않는다.
- 요구사항 28에 따라 다음 화 자동 재생을 끈다.

## 다음

1. 원본 코드·에셋과 공급원별 앱 연동·저장 권한을 서면 또는 명시된 약관으로 확인하기 전까지 공개 저장소·설치 파일 배포를 보류한다.
2. 허가된 테스트 자료와 분리된 userData 프로필로 Windows 검색·재생·한국어 자막·이어보기를 검증한다.
