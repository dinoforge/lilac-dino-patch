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

- 시작 기준선은 원본 v0.5.6 / `d7d4ec4853d252d67f0febb939be9770ca703444`이다. 2026-10-09 최신 원본을 다시 받아 보니 `upstream/main`은 `192fd8bd1965882fcb1f911178e6bfef0ff33e56`까지 갱신됐고, 기준선 이후 3개 커밋에 상세 카탈로그 필터·최근 업데이트순·회차 수 표시·자막 싱크 ±5초 제한 해제·3/4배속이 포함됐다. 싱크 제한 해제·3/4배속·전체 목록의 최근 업데이트순은 아래에 선별 반영했고, 상세 필터·홈/내 목록 정렬·회차 수 표시는 기존 변경과 공급원 제외 결정에 대조해 별도로 통합한다.
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
- 홈의 최신 회차 줄은 RE:Anime·Miruro의 AniList 방영 일정과 Animenosub·애니24의 공급원 업데이트 목록을 구분해 보여 준다. Animenosub·애니24는 확인된 업로드 화수가 있는 작품만 `최신 업데이트 회차`로 표시하고, 30분 캐시·12시간 저장본 복구를 쓴다. 카드 선택 때 공급원 상세 회차와 재생 가능 여부를 다시 확인한다. RE:Anime·Miruro 방영 일정 캐시 및 이어보기 우선 배치도 유지한다. Linkkf는 별도 최신 회차 목록 대신 요일별 방영표를 제공한다.
- 최신 회차 변경 검증: AniList 공식 GraphQL 일정 필터를 확인하고 실제 API에 ID 2개의 최소 쿼리를 보내 `episode`·`airingAt`·`media.id` 응답을 받았다. 자동 테스트 26/26 통과, `node --check`와 `git diff --check` 통과. `npm run dist` Windows NSIS 빌드가 성공했고 설치 파일은 124,522,709바이트다. `app.asar`에서 최신 회차 모듈·스타일·IPC·renderer·홈 마크업 포함을 확인했다. 실제 RE:Anime/Miruro 재생, 다른 공급원의 최신 회차, 기기별 UI는 미검증이다. AniList API 이용 조건은 공개 배포 전에 검토해야 한다.
- 검색 상단과 검색 화면에 작품 자동완성·최근 검색을 추가했다. 검색어는 입력 중 외부 요청 없이 이미 로드된 홈·방영·분기·보관함 작품 제목과 로컬 최근 검색 10개에서 제안하며, 회차 이름은 입력하지 않는다. 한국어·영어·일본어 제목 매칭, 키보드 위/아래·Enter·Escape, 최근 검색 전체 삭제를 지원한다.
- 플레이어에서 현재 회차의 Kairan·Csora·Anissia 상태를 `미확인`·`확인 중`·`있음`·`없음`·`확인 실패`로 보여 준다. 자동 재생 준비 중 진행된 출처별 검색 또는 사용자가 출처 버튼을 눌러 시작한 검색에서만 상태가 바뀐다. 연결 오류와 자막 없음은 구분한다. 자막 검색 기록은 앱 세션 동안 회차별로 유지하고, 저장 자막은 다음 실행에서도 `있음`으로 판정한다.
- 검색·회차별 자막 상태 테스트 포함 전체 자동 테스트 30/30, `node --check src/app.js`, `node --check src/player.js`, `git diff --check` 통과. `npm run dist` Windows NSIS 빌드 성공(설치 파일 124,525,390바이트); `app.asar`에서 검색 기록·회차 상태·접근성 문구가 포함된 것을 확인했다. 실제 Electron 창에서 화면·스크린리더·포인터 조작 및 공급원별 실제 검색 결과는 아직 확인하지 않았다.
- 이어보기 레일을 홈 상단으로 옮겨 히어로·최신 회차·요일표보다 먼저 보이게 했고, 작품별 최근 회차 최대 6개를 150–190px 카드로 압축했다. 앱 시작 시 다운로드 IPC 완료 전에 시청 기록을 렌더링한다. 전체 테스트 32/32와 `node --check src/app.js`, `git diff --check` 통과. `npm run dist` 성공(설치 파일 124,526,034바이트); 설치 패키지 `app.asar`에서 홈 순서, 이어보기 표시 상태, 조기 렌더링 및 카드 스타일을 확인했다. 실제 Electron 창 레이아웃과 기존 프로필 복구는 아직 검증하지 않았다.
- 최신 원본에서 자막 싱크 개선만 선별 반영했다. 설정과 플레이어에 밀리초 숫자 입력을 두고 ±250ms 버튼과 Z/X 단축키를 유지하며 ±5초 제한을 없앴다. 공백·숫자가 아닌 값은 거부하고 정수 ms로 저장한다. 90초·-90초, 잘못된 입력, 단축키를 포함한 테스트를 통과했다. `npm run dist` Windows NSIS 빌드 성공(설치 파일 124,525,528바이트); `app.asar`에서 두 입력·새 처리기·스타일 포함을 확인했다. 실제 재생 화면의 입력 조작 및 외부 자막 타이밍은 미검증이다.
- 최신 원본의 3/4배속도 반영했다. 플레이어 속도 선택, 설정 기본값 슬라이더, 키보드 배속 조절에 같은 0.1–4x 옵션 목록을 사용하고 3/4x 값도 기존 `defaultSpeed` 저장 방식으로 유지한다. 전체 테스트 35/35, 구문 검사, `git diff --check` 통과. `npm run dist` Windows NSIS 빌드 성공(설치 파일 124,526,507바이트); `app.asar`에서 3/4x 선택, 기본값 범위 및 싱크 개선 포함을 확인했다. 실제 영상에서 3/4배속 재생은 아직 확인하지 않았다.
- 전체 작품 목록에 최근 업데이트 정렬을 추가했다. RE:Anime는 `__data.json`의 최근 회차 목록, Miruro는 최근 2주 일정에서 75분 이상 전에 방영한 회차, Animenosub는 업데이트 정렬 목록, 애니24는 `/ing` 목록을 사용한다. 소스 응답은 5분 캐시를 쓰고, Linkkf·LinkAni는 지원하지 않는다. 전체 테스트 40/40, 구문·diff 검사 통과. `npm run dist` Windows NSIS 빌드 성공(설치 파일 124,529,761바이트); `app.asar`에서 모듈·IPC 연결·정렬 UI 포함을 확인했다. 실제 사이트 응답과 화면 조작은 미검증이다.

- upstream v0.5.8의 상세 카탈로그 필터를 공급원별로 통합했다. RE:Anime·Animenosub·Linkkf·Miruro·애니24가 제공하는 장르·형식·연도·분기 필터만 보여 주며, 전체 목록 페이지와 검색 결과를 분리해 기존 홈 로딩을 건드리지 않는다. LinkAni는 제외했다. 빈 페이지 뒤의 다음 페이지, 중복 결과, 필터 전환 중 늦게 온 응답도 처리한다.
- 홈 작품 줄에 선택 분기/이번 시즌과 최근 업데이트 정렬을 추가했다. 최근 피드는 RE:Anime·Miruro·Animenosub·애니24에서 공급원 순서를 유지하고 5분 캐시를 사용한다. 내 목록은 선택 시 각 지원 공급원의 최대 8페이지를 조회하고, 최근 피드 작품을 앞에 표시하며 나머지는 저장 순서를 유지한다. 새 메타데이터는 렌더링 중에만 덧씌우고 저장 데이터 배열은 변경하지 않는다. Linkkf의 홈 업데이트 정렬은 숨기고, 전체 보기에서는 해당 공급원의 기존 업데이트 정렬로 이동한다.
- 작품 카드·히어로·상세에 업로드 화수와 전체 화수를 구분해 표시한다. RE:Anime, Animenosub, Miruro, 애니24 응답에서 해당 정보를 정규화하고, 상세의 Animenosub 회차 목록 및 애니24 총화수로 보강한다.
- 카탈로그 UI 경합과 저장 순서 보호 테스트를 포함해 전체 테스트 65/65 통과. 변경 JavaScript 구문 검사와 `git diff --check` 통과. `npm run dist` Windows NSIS 빌드 성공(설치 파일 124,537,443바이트); 설치된 `app.asar`에 새 메타데이터·업데이트 UI·preload·IPC·HTML 연결이 들어간 것을 확인했다. 실제 공급원 웹 응답, Electron 창에서의 조작, 외부 영상 재생은 아직 검증하지 않았다.
- 2026-10-09 추가 권리 검토에서 Re:Anime·Miruro·Animenosub 공식 소개 페이지, 애니24 홈페이지, 업스트림 저장소, AniList API 이용 조건을 다시 확인해 `docs/RIGHTS_REVIEW.md`에 기록했다. 공식 소개는 앱 연동·오프라인 저장 허가가 아니며, AniList 조건은 대량 수집과 비보완적 유사 서비스 이용을 제한한다. 프로젝트별 허가는 여전히 확인되지 않아 비공개·미배포를 유지한다. 권리자에게 연락하거나 외부 미디어를 내려받지 않았다.
- 플레이어에 ChatGPT 수동 자막 번역을 추가했다. 선택한 자막의 문장을 최대 24개·약 7,000자 묶음으로 요청하고, 명시적으로 누를 때만 프롬프트를 클립보드에 복사해 `chatgpt.com`을 연다. 사용자가 응답을 붙여넣으면 묶음 ID를 검증하고 원래 VTT 시간·큐 정보를 보존해 번역 자막을 회차별로 저장·적용한다. 자동 로그인·전송과 ChatGPT API 호출은 없다. 전체 `node --test` 73/73 통과, JavaScript 구문 및 `git diff --check` 통과. `npm run dist` Windows NSIS 빌드 성공(설치 파일 124,540,744바이트); 패키지 `app.asar`에서 helper·UI·IPC·저장소 연결을 확인했다. 외부 ChatGPT 왕복과 공급원 재생은 미검증이고, 임시 로컬 영상의 앱 재생은 아래 smoke test에서 확인했다.
- 2026-10-09 Windows Electron headless smoke test를 임시 `userData`/`sessionData`와 외부 DNS 차단 상태로 실행했다. 가짜 일본어 VTT에서 번역 UI·프롬프트 복사·ChatGPT 열기(시스템 클립보드와 외부 브라우저는 캡처 대체 함수)·결과 적용·회차별 저장을 확인했고, 원래 큐 시간도 보존됐다. 12초 합성 MP4 실제 재생으로 28% 이어보기를 저장하고 앱 재시작 뒤 3.36초 재개를 확인했다. 자막의 활성 문장과 회차 종료 시 완료 100%·수동 다음 화 안내·자동 전환 없음도 확인했다. 상세 근거는 `docs/PHASE1_PLAN.md`와 `docs/FEATURE_GAP.md`에 기록했다. 실제 ChatGPT 왕복과 외부 공급원 연결은 확인하지 않았다. 임시 폴더 `%TEMP%\lilac-smoke-00ad878206974f2bacbb10c1213336e9`는 PowerShell 재귀 삭제가 실행 정책에 막혀 남아 있다.
- 검색→상세→회차 재생도 임시 프로필·외부 DNS 차단·합성 IPC 응답으로 Electron 창에서 확인했다. `테스트 애니` 검색, 결과 선택, 두 회차 표시, 1화의 12초 MP4 재생과 기록 저장이 통과했고 렌더러 예외와 외부 HTTP(S) 요청은 없었다. 이 과정에서 `catalog-browser.js`의 초기 DOM 함수 참조와 이어보기 진행률 HTML의 누락된 따옴표를 고쳤다. 실제 공급원은 호출하지 않았다.
- 전체 `node --test` 75/75가 통과했다. 카탈로그 helper 초기화와 이어보기 진행률 마크업 회귀 테스트 2개를 추가했다. 변경 JS·테스트 구문 검사와 `git diff --check`도 통과했다. Windows `npm run dist`는 앞선 코드 변경에서 성공했고 패키지 `app.asar`에 두 수정이 들어간 것을 확인했다. 로컬 NSIS 설치 파일은 124,540,629바이트이며 배포하지 않았다.
- 합성 한국어 VTT 트랙을 붙인 후속 Electron UI 스모크에서 검색→작품 상세→1화 재생, 한국어 트랙 자동 적용·활성 자막 표시를 확인했다. 플레이어 설정의 `자막 모양` 탭에서 싱크를 `500 ms`로 입력하고 확정하자 로컬 값과 `+0.50초 (늦게)` 표시가 함께 갱신됐다. 격리 사용자 프로필, 합성 IPC·12초 로컬 영상, 외부 HTTP(S) 요청 0건, 렌더러 오류 0건이며 11개 검증 조건이 통과했다. 전체 `node --test`는 싱크 입력 두 곳의 저장 회귀 테스트를 추가해 76/76 통과했다. 사이트 자막·영상의 실제 매칭은 여전히 미검증이다.
- 원본 `whispelyn-byte/LilacAnime-desktop/releases`에 고정돼 있던 앱 업데이트·변경 기록 주소를 제거했다. 자체 피드는 현재 비활성이며 검사·다운로드·릴리스 노트 요청은 네트워크를 쓰지 않는다. 향후 피드를 설정해도 확인 직후 자동 다운로드하지 않고 사용자가 다운로드·설치를 각각 선택해야 하며, 앱 종료 시 설치하지 않는다. 버전 다운그레이드도 막았다. 기존 userData 파일은 열거나 삭제하지 않는다. `tests/updater.test.cjs` 6/6, 전체 `node --test` 82/82, 변경 JavaScript 구문 검사와 `git diff --check`가 통과했다. `npm run dist` 성공, Windows NSIS 설치 파일은 124,541,399바이트다. 패키지 `app.asar`에서 기본 비활성 상태·안내 문구·원본 URL 제거·종료 시 자동 설치 제거를 확인했다. 실제 릴리스 피드나 설치는 검증하지 않았다.
- README와 PRODUCT 문서의 지원 공급원을 LinkAni 제외 다섯 곳으로 맞췄다. README에서 원본의 설치·다운로드 주소, macOS 사용 안내, TMDB 필수 표현, 자동 업데이트 주장을 제거하고 비공개 Windows 개발 상태와 권리 확인 한계를 표시했다. `PRODUCT.md`도 Windows 우선 범위·현재 기능·업데이트 비활성·권리 제약에 맞췄다. README 본문에서 원본 릴리스 다운로드 URL이 남지 않는 것을 확인했다.
- renderer와 Electron main에 중복된 한국어 자막 트랙 판별기가 `ko`, `ko-KR`, `kor`, 한국어/영어 레이블, `_kor_` URL을 동일하게 처리하고 영어·일본어·`koala`는 거부하는 회귀 테스트를 추가했다. 전체 `node --test` 83/83, 플레이어 테스트 20/20, 테스트 구문 검사와 `git diff --check`가 통과했다. 실제 공급원 트랙 응답은 검증하지 않았다.
- 제목 후보별 자막 검색과 Anissia 제작자·게시물 본문·이미지 자막 추출에서 실제 HTTP·네트워크 오류가 후속 미발견 결과로 덮여 자막 상태가 `없음`으로 잘못 표시될 수 있는 경로를 고쳤다. 후보 간 검색은 계속 진행하고, 적어도 하나의 기술 오류가 있으면 `확인 실패`, 모든 검색이 정상 완료되어 결과가 없을 때만 `없음`으로 남긴다. 미발견·기술 오류·다음 후보 성공·다음 제작자 성공·본문/이미지 오류를 확인하는 테스트 여덟 건을 추가해 `tests/subtitle-availability.test.cjs` 10/10, 전체 `node --test` 91/91, 관련 구문 검사가 통과했다. Windows NSIS 빌드도 성공했고(124,540,799바이트) 패키지 `app.asar`에서 제목 후보·제작자·게시물 본문·이미지 자막 추출 오류 보존을 확인했다. 실제 외부 검색은 여전히 미검증이다.
- 임시 `userData` 프로필로 Electron을 종료·재실행해 이어보기 UI를 확인했다. 저장한 합성 시청 기록이 다운로드 목록 응답 전에 홈에 표시되고, 187px 카드가 히어로보다 위에 놓이며, 카드 클릭 뒤 12초 합성 영상의 저장 위치 28%(3.43초)에서 재개됐다. 같은 UI 스모크에서 기록 기반 자동완성·키보드 선택·Enter 검색(입력 중 공급원 검색 0회), 자막 출처의 `없음`/`확인 실패` 표시, 설정 탭·0.75x 저장·일시정지를 확인했다. 렌더러 예외와 외부 HTTP(S) 요청은 0건이다. 상세 결과와 화면 캡처는 `%TEMP%\lilac-smoke-00ad878206974f2bacbb10c1213336e9`에 있다. 실제 사용자 프로필·공급원 응답·설치 앱 UI는 미검증이며 `docs/FEATURE_GAP.md`와 `docs/PHASE1_PLAN.md`를 갱신했다.
- TMDB API 공식 약관을 확인하고 6개월보다 짧은 캐시 만료를 적용했다. 한국어 제목 후보 30일, 표시 제목 7일, 카탈로그 제목 30일, 줄거리 30일(미발견 7일), 다운로드 작업의 표시 제목 30일이다. 날짜가 없는 이전 표시 제목은 재조회하며, 시청·다운로드 기록·영상·자막 경로는 보존한다. 공식 승인 TMDB SVG와 현행 크레딧 문구를 Settings > About에 넣었다. 선택형 AI 자막 기능과 TMDB 사용의 조합이 약관상 허용되는지는 문서만으로 확정할 수 없어 `docs/RIGHTS_REVIEW.md`에 배포 전 서면 확인 항목으로 기록했다.
- AniList GraphQL 6개 호출 경로(작품 ID 매핑, 애니24 보조 매칭, 제목 매칭, 이전 시즌 회차, 작품 줄거리, 최신 방영 회차)를 공통 요청 경로로 통합했다. 각 경로의 요청 시작은 앱 프로세스 안에서 2.1초 간격으로 직렬화해 약 29회/60.9초로 유지하고, 어느 경로에서든 429를 받으면 `Retry-After`(숫자 또는 HTTP 날짜)를 공유한다. 헤더가 없거나 잘못되면 60초간 다음 요청을 보류하며, 최신 방영표는 저장된 결과가 있으면 유지한다. 캐시 초기화는 제한 상태를 해제하지 않는다. 전체 `node --test` 105/105, 변경 JavaScript 구문 검사, `git diff --check`가 통과했다. `npm run dist` 성공(Windows NSIS, 124,542,753바이트); `app.asar`에서 공통 클라이언트와 최신 회차 경로의 주입 코드를 확인했다. 초기에 테스트용 fetch 전달을 빠뜨린 검증 시도에서 AniList에 잘못된 GraphQL 요청이 나가 HTTP 400을 받았다. 전달을 복구했고 테스트에서도 실호출을 차단한다. 현재 검증은 모의 응답 기반이며 실제 AniList 429, 공급원 재생, 설치 앱 실행, 기존 사용자 프로필은 검증하지 않았다.
- Animenosub·애니24 홈에도 `최신 업데이트 회차` 줄을 연결했다. 기존 공급원 업데이트 IPC에서 출처·작품 ID·URL·양수 업로드 화수를 확인하고 최대 30개를 피드 순서대로 표시한다. 출처별 저장 캐시는 30분 이내면 재사용하고, 최대 12시간 결과는 갱신 중 먼저 보여 주며 실패 시 재시도 버튼을 남긴다. 클릭하면 기존 상세 회차 경로에서 같은 화와 `playable !== false`를 다시 검증한다. 전체 `node --test` 110/110, 구문 검사, `git diff --check` 통과. `npm run dist` Windows NSIS 빌드 성공(124,544,882바이트); `app.asar`에서 모듈·스크립트 순서·renderer 연결을 확인했다. 공급원 실제 응답·회차 일치 및 새 줄의 Electron 런타임 화면은 아직 확인하지 않았다.
- 최신 회차 카드의 상세 응답에서 같은 화수라도 현재 선택 공급원과 다른 `episode.provider`는 재생하지 않도록 차단했다. 네 공급원 모두의 모의 상세 응답에 타 공급원·재생 불가·다른 화수·정상 회차를 섞어 같은 공급원의 정상 회차만 resolve되는 것을 확인했다. 타 공급원 화만 있을 때 상세 화면으로 안내하는 테스트도 추가했다. 전체 `node --test` 112/112, 구문 검사와 `git diff --check` 통과. Windows NSIS 빌드 성공(124,544,360바이트), `app.asar`에 공급원 경계 검사 포함을 확인했다. 외부 공급원 및 설치 앱 UI 실행은 확인하지 않았다.

- 요구사항 26의 `NEW` 표시를 내 목록에 연결했다. RE:Anime·Miruro·Animenosub·애니24는 내 목록 화면을 열 때 기존 최근 회차 피드를 확인하고, Linkkf는 즐겨찾기 작품별 회차 목록을 최대 3개씩 조회한다. 저장 당시 업로드 수보다 회차가 늘어난 작품에만 배지를 표시한다. 알 수 없는 기존 작품은 첫 확인 시 기준값을 저장해 과거 회차를 새 회차로 오인하지 않는다. 새 회차 재생 시 확인 기준을 해당 화수까지 올리고, 시청 기록의 출처·작품이 다르면 기준에 섞지 않는다. 목록 데이터나 저장 순서는 바꾸지 않는다. Linkkf 최근 업데이트순 정렬은 기존처럼 미지원이다.
- 관련 테스트 18/18, 전체 `node --test` 119/119 통과. 변경 JavaScript 구문 검사와 `git diff --check` 통과. Windows NSIS 빌드 성공(124,544,734바이트); `app.asar`에서 변경된 renderer·스타일·Linkkf 회차 수 처리를 확인했다. 피드는 합성 데이터이며 실제 공급원 응답·설치 UI는 미검증이다. 기존 사용자 프로필을 열거나 공급원에 직접 요청하지 않았다.

- 작품 상세에서 이어보기 회차를 고르면 위치 선택을 제공한다. 1–94%는 이어보기가 기본이고 처음부터 재생을 선택할 수 있다. 95–99%는 기존 규칙대로 처음부터가 기본이며 이어보기도 명시적으로 고를 수 있다. 미시청·완료 회차에는 보조 선택을 감춘다. 기록 연결은 공급원 경계를 지키고 재생 불가 회차는 건너뛴다.
- `tests/resume-choice.test.cjs`에 진행률 경계, 공급원별 회차 매칭, 비재생 회차 제외, 두 버튼의 위치 인자 전달 검증을 추가했다. 전체 `node --test` 126/126, `node --check src/app.js`, `node --check tests/resume-choice.test.cjs`, `git diff --check` 통과. `npm run dist` Windows NSIS 빌드 성공(124,545,419바이트); 패키지 `app.asar`에서 helper와 명시적 이어보기 위치 연결을 확인했다.
- 임시 `userData`·`sessionData`, DNS 차단, 합성 IPC와 12초 로컬 영상으로 Electron 소스 앱 상세 UI를 실행했다. 96% 기록은 `1화 처음부터`/`1화 이어보기` 표시 후 이어보기 선택이 11.5초에서 재개됐다. 28% 기록은 두 버튼을 표시하고 처음부터 선택 시 기록 0%, 위치 0.006초가 확인됐다. 두 경우 모두 외부 HTTP(S) 요청·렌더러 오류는 0건이다. 결과는 각각 `%TEMP%\lilac-resume-choice-MUEPqw\resume-choice-result.json`, `%TEMP%\lilac-resume-choice-cLxnZw\resume-choice-result.json`에 있다. NSIS 설치 앱 UI, 실제 공급원, 기존 프로필은 미검증이다.
- 빌드된 `dist/win-unpacked/resources/app.asar`의 renderer와 실제 preload를 임시 Electron harness에서 실행했다. 합성 IPC 88개와 12초 MP4로 상세 UI의 `1화 이어보기`/`1화 처음부터`, 회차 resolve, 처음부터 선택 뒤 0.01363초·기록 0%, 상세 닫힘을 확인했다. renderer 오류와 외부 HTTP(S) 요청은 0건이다. 결과는 `%TEMP%\lilac-packaged-ui-yFofCR\packaged-ui-result.json`에 있다.
- `dist/win-unpacked/LilacAnime.exe`도 임시 프로필로 headless 실행해 창 생성은 확인했지만, 상세 UI CDP 대기가 시간 초과됐다. 이 실행에는 IPC mock 호출·네트워크 차단 기록이 없어 패키지 exe의 실제 main 통합 검증으로 계산하지 않는다. 초기 화면은 카탈로그 IPC를 시작하고 `provider:catalog` handler는 RE:Anime `providerFetch`로 연결되므로, 이 시도에서 실제 외부 요청이 없었다고 확인할 수도 없다. 격리를 입증하지 못한 상태에서 재시도하지 않았다. 다음 패키지 검증은 main handler mock과 네트워크 차단이 실제로 먼저 적용됐다는 기록을 남기는 harness 준비 후 진행한다.

## 2026-10-09 패키지 exe 통합·한국어 자막 스모크

- `dist/win-unpacked`를 ignored 임시 폴더에 복사해 실제 `LilacAnime.exe`를 실행했다. exe SHA-256은 원본과 같았다. 격리용 테스트 `app.asar`는 실행 진입점만 harness로 바꾸고 실제 `electron/main.cjs`를 불러왔으며, 기존 앱 프로필과 별도인 임시 `userData`·`sessionData`를 사용했다.
- renderer를 열기 전에 `provider:catalog`·`provider:detail`·`provider:resolve` IPC 응답을 합성 데이터로 대체하고, 앱의 네트워크 차단을 설치했다. 테스트 기록에서 세 IPC의 등록과 호출, renderer 네트워크 차단기 설치를 확인했다. 외부 차단 기록 0건, 렌더러 예외 0건이다.
- 실제 packaged renderer/preload/main 경로로 `테스트 애니` 검색 → 작품 선택 → `1화 이어보기` 선택을 실행했다. 96% 기록은 `1화 처음부터`와 `1화 이어보기` 선택지를 보였고, 이어보기 후 합성 12초 MP4의 11.5초에서 멈췄으며 기록은 96%로 유지됐다. 한국어 합성 VTT 트랙은 `ko`·`showing`이고 현재 cue `한국어 합성 자막`이 활성화됐다.
- 검증 한계: 테스트 전용 ASAR 변경·합성 IPC·로컬 영상과 자막으로 확인했다. 실제 공급원 검색·스트림·자막의 작품·회차·영상판 일치, 설치 NSIS 앱, 자막 픽셀 렌더링, 이용 허가는 확인하지 않았다. 기존 사용자 프로필은 열지 않았다.

## 2026-10-09 홈 발견·내 목록 패키지 UI 스모크

- 패키지 `LilacAnime.exe` 바이너리 사본은 원본과 SHA-256이 같았다. 테스트 ASAR의 main 진입점만 격리 harness로 바꿔 실제 `electron/main.cjs`를 불러왔고, 실제 packaged renderer/preload를 별도 `userData`·`sessionData`에서 실행했다. 홈·회차 IPC 응답은 모두 합성 fixture로 대체했으며 전역/Electron 요청·renderer 요청을 차단했다.
- RE:Anime 홈에서 2026년 4분기 작품, `최신 방영 회차`의 EP.8, 별도 `방영 중` 줄을 확인했다. 1분기 탭을 누르면 제목·선택 상태가 2026년 1분기로 바뀌었다.
- Animenosub으로 전환해 `최신 업데이트 회차`와 EP.12 카드를 확인했다. Linkkf로 바꾸자 UP·월~일 8개 탭이 나타났고, 시스템 요일(금요일)을 자동 선택해 금요일 카드를 표시했다. 월요일 탭을 눌렀을 때 선택 상태와 카드가 함께 변경됐다.
- 격리 프로필의 내 목록에 업로드 7화 작품과 기준값 7을 넣고 합성 피드 12화로 갱신했을 때 `NEW` 배지가 보였다. IPC 등록·호출 조건 통과, 네트워크 차단기 설치, 차단 기록 0건, 렌더러 예외 0건이다.
- 검증 한계: 테스트 전용 ASAR 진입점과 합성 목록·회차 데이터를 이용한 DOM 런타임 확인이다. 실제 공급원 목록·업로드 화수, 실사이트·실영상·설치 NSIS 앱의 동작과 픽셀 화면은 검증하지 않았다. 기존 사용자 프로필은 열지 않았다.

## 2026-10-09 공식 이용 조건 재확인

- Re:Anime `/terms` 본문을 사이트 UI에서 확인했다. 개인·비상업적 일시 시청 범위와 복사·수정·공개 전시·미러링 등의 금지가 적혀 있지만 외부 앱 연동이나 자동 조회 허용은 명시하지 않는다.
- AniList 공식 약관은 대량 수집과 비보완적 동종 작품 목록/추적 서비스 이용을 제한한다. 현재 앱은 선택 작품 방영 일정만 조회하지만 내 목록·시청 기록도 제공하므로 허용을 단정하지 않는다. 제한 문서는 일시 30회/분, 정상 90회/분과 버스트 제한을 표시한다. 구현은 2.1초 공통 간격을 쓰며 실제 서비스 부하는 미검증이다.
- TMDB API 약관의 직접 열기는 robots 정책에 막혔다. 공식 FAQ와 검색 가능한 공식 약관 본문을 재확인했다. TMDB 줄거리 조회 코드는 번역 문맥과 분리돼 있지만, AI 앱과의 결합 금지가 같은 앱의 별도 기능에도 적용되는지는 불명확하다. 세부 내용과 한계는 `docs/RIGHTS_REVIEW.md`에 기록했다.
- 검증 결과는 이용 권한을 뜻하지 않는다. 공개 저장소·설치 파일 배포와 실사이트 콘텐츠 시험은 계속 보류한다. 다음 안전한 작업은 번들 종속성·에셋의 라이선스 고지 목록을 정리하고, 확인되지 않은 항목을 공개 차단 목록에 남기는 것이다.

## 2026-10-09 의존성·실행 파일·AI 모델 조건 정리

- `docs/DEPENDENCY_LICENSE_INVENTORY.md`를 추가했다. `package-lock.json` 기준 프로덕션 의존성 45개, 직접 개발 의존성, FFmpeg/JASSUB 번들, 첫 실행 시 내려받는 llama.cpp 및 GGUF 모델, 추적 가능한 이미지 에셋을 항목별로 정리했다.
- 최우선 배포 차단은 설치 패키지에 포함되는 GPLv3 FFmpeg 바이너리의 정확한 대응 소스·고지·배포 조건이다. JASSUB는 여러 라이선스가 결합된 메타데이터와 단일 MIT 파일 복사 사이의 고지 범위를 대조해야 한다.
- `ffmpeg-static@5.3.0`의 현재 Windows 바이너리를 직접 실행해 6.1.1 essentials/GPL v3, `--enable-gpl`, 정적 구성과 FFmpeg 본체 커밋 `e38092ef93`을 확인했다. README에는 외부 라이브러리 버전도 나열돼 있다. 실행 파일 SHA-256은 `04E1307997530F9CF2FE35CBA2CA7E8875CA91DA02F89D6C7243DF819C94AD00`이며, `node_modules`와 unpacked 앱 바이너리가 일치한다. 패키지에는 README·GPL 고지가 있지만 전체 Gyan 빌드 레시피와 외부 라이브러리 source snapshot/patch는 없다. FFmpeg 별도 프로세스가 앱에 미치는 법적 효과는 여기서 결론 내리지 않는다.
- 모델 사용 조건도 확정되지 않았다. HY-MT1.5 7B 저장소는 대한민국을 적용 지역에서 제외하며, Aya Expanse GGUF는 CC-BY-NC-4.0을 표시한다. Gemma 4, ja-ko-vn 및 legacy GGUF 저장소별 조건은 추가 확인이 필요하다. 모델 파일은 내려받거나 변경하지 않았다.
- 로고·아이콘 파일 해시를 기록했지만 출처·재배포 권한은 미확인이다. 현재 unpacked Electron 앱에서 Electron/Chromium 라이선스 파일을 확인했다.
- 문서 전용 변경이므로 앱 테스트와 패키징은 실행하지 않았다. `git diff --check`로 문서 패치만 확인한다. 외부 영상·자막 요청, 기존 사용자 데이터 접근, 릴리스 배포는 하지 않았다.

## 2026-10-09 이어보기 작품 식별 충돌 수정

- 저장된 회차에 URL·토큰이 없고 화수 숫자만 남은 경우, 같은 공급원의 다른 작품 기록도 회차 번호만으로 이어보기 대상으로 고를 수 있었다. 작품 ID가 다르면 기록을 건너뛰고 첫 재생 가능 회차를 쓰도록 했다. 같은 작품의 오래된 번호 전용 기록은 MAL ID, 또는 동일 공급원에서 일치하는 작품 ID로 계속 연결한다. 작품 ID가 없는 오래된 기록은 명시적 URL·토큰이 일치할 때만 연결한다. 저장 데이터 형식이나 기존 기록은 변경하지 않는다.
- 수정 전 회귀 검사는 다른 작품의 1화 기록 82%가 선택되는 실패를 재현했다. 회귀 사례, 동일 작품의 MAL ID·공급원 ID 기반 번호 기록, 작품 정보 없는 정확한 URL 기록을 확인하는 테스트를 추가했다. `tests/resume-choice.test.cjs` 11/11과 전체 `node --test` 130/130 통과했다. 변경 파일 `node --check`와 `git diff --check`도 통과했다.
- `npm run dist`로 Windows NSIS 빌드가 성공했고 `dist/win-unpacked/resources/app.asar`에서 작품 ID 충돌 차단과 과거 기록 연결 로직을 확인했다. 설치 파일은 124,544,954바이트이며 로컬 검증 산출물로만 남겼다.
- 실제 Electron 창, 설치 앱 조작, 공급원 응답·영상·자막은 이번 수정에서 확인하지 않았다. 기존 사용자 프로필은 열지 않았다.

## 2026-10-09 회차 자막 파일의 교차 회차 적용 방지

- Kairan·Csora·Anissia의 회차 게시물에서 내려받은 자막 묶음에 요청 회차 파일이 없으면, 다른 번호의 첫 파일이 대신 적용될 수 있었다. 이제 정확한 회차 파일만 선택하고, 명시적 회차 번호가 다른 파일만 있으면 해당 출처 결과를 `없음`으로 돌린다. 번호가 없는 직접 회차 자막은 계속 선택하며, 번호 없는 묶음은 1화에서만 가장 큰 파일을 사용한다.
- 파일명 회차 분석에서 `S02E05`·독립 회차 번호를 인식하고 CRC·시즌·해상도·비트 심도·오디오 채널 표기를 걸러낸다. 기존 데이터 형식이나 저장 파일은 변경하지 않는다.
- `tests/subtitle-matching.test.cjs` 6/6, 전체 `node --test` 136/136, 변경 JavaScript 구문 검사와 `git diff --check`가 통과했다. `npm run dist` Windows NSIS 빌드도 성공했고 `app.asar`에 회차 번호 분석·불일치 차단·자막 없음 처리가 들어간 것을 확인했다. 실제 자막 공급원 응답·게시물 파일명·영상판 일치는 미검증이며 기존 사용자 프로필은 열지 않았다.

## 2026-10-09 JASSUB 고지와 폰트 추적

- 현재 잠금 버전은 `jassub@2.5.16`이며 registry metadata에는 `gitHead`와 provenance attestation이 없다. 뒤이은 blob 대조에서 게시 4분 23초 전 upstream commit `656371a`의 9개 TypeScript·README·LICENSE, 두 WASM, 기본 font와 npm 산출물이 일치하고 package.json은 version만 다름을 확인했다. 다섯 submodule revision도 식별했지만, generated JS의 전체 빌드 provenance는 증명되지 않았다.
- 복합 SPDX 식에는 LGPL·FTL/GPL 대안 및 MIT·ISC·NTP·Zlib·BSL 조건이 포함된다. app build는 MIT `LICENSE`만 복사하고, 실제 생성된 JASSUB JS/worker에는 주석 블록이 없으며 `app.asar`에 집계된 `COPYRIGHT`/`THIRD-PARTY-NOTICES`가 없다. upstream license generator는 Expat도 열거하지만 pinned `.gitmodules`에는 대응 경로가 없다.
- 기본 `default.woff2`는 `656371a`의 `src/default.woff2`와 바이트 단위로 일치하고 기본 family는 `liberation sans`지만, 원 저작권자·다운로드 위치·적용 라이선스는 아직 미확인이다. upstream generator와 정확한 해시는 `docs/DEPENDENCY_LICENSE_INVENTORY.md`에 기록했다.
- 문서 조사만 진행했으며 앱 코드·기능·사용자 데이터는 바꾸지 않았다. 전체 고지·Expat 출처·font 권리를 확인하기 전까지 JASSUB 배포 검토는 미완료다.

## 2026-10-09 JASSUB 한국어 ASS 합성 렌더 확인

- localhost 전용 임시 페이지에서 저장소의 JASSUB JS·worker·WASM과 `src/ass-renderer.js`를 그대로 불러왔다. Canvas `captureStream`으로 합성 1280×720 영상을 만들고, Windows Malgun Gothic 폰트 바이트를 `{ family, data }`로 래퍼에 전달했다. 폰트 파일은 로컬 경로로만 읽고 복사·배포하지 않았다.
- 직접 JASSUB 캔버스 시험은 ASS 이벤트 1개를 읽었다. 래퍼 시험에서 `LilacAss.attach`는 `true`, `active`도 `true`였고 비디오 시각 약 2.8초에 `한국어 ASS 자막 테스트`가 영상 위에 보이는 것을 브라우저 화면으로 확인했다.
- 이 Chromium 시험은 Electron main의 `font:default` IPC/font-family 추출, 설치 앱, 실제 공급원 영상, 자막의 작품·판본 매칭을 입증하지 않는다. Re:Anime 실제 재생과 외부 자막의 영상 일치는 아직 확인하지 않았다.
- 임시 페이지는 loopback 주소만 사용했고 공급원 사이트나 외부 API를 호출하지 않았다. JASSUB 및 기본 `default.woff2`의 배포 권리 추적은 별도 미완료 항목이다.

## 2026-10-09 검색·재생·한국어 ASS 글꼴 IPC 통합 스모크

- Windows Electron 소스 앱에서 실제 `electron/main.cjs`, preload, renderer를 실행했다. 검색·상세·resolve IPC는 합성 작품으로 대체하고 12초 로컬 합성 MP4, VTT, ASS 파일을 사용했다. 격리 `userData`·`sessionData`와 외부 DNS 차단을 적용했다.
- 검색 → 작품 선택 → 회차 재생 → 이어보기 기록 저장 → 제공 한국어 트랙 적용을 확인했다. stream의 ASS URL이 renderer에 전달되고 `LilacAss.active=true`, 1440×810 캔버스 생성·표시를 확인했다. 캡처에서 `한국어 ASS 통합 검증` 문구가 영상 위에 렌더됐다.
- `font:default`의 실제 main-process handler는 Windows `malgun.ttf` 13,459,196바이트, family `Malgun Gothic`을 반환했다. 500ms 수동 싱크 입력도 저장·레이블 갱신됐다. 14개 확인 조건 통과, renderer 오류 0건, 외부 HTTP(S) 요청 0건이다. 캡처와 JSON 결과는 `%TEMP%\lilac-ass-integration-20261009`에 있다.
- 한계: Electron 소스 앱 합성 스모크이며 NSIS 실행 파일이나 실제 Re:Anime 공급원·영상·자막 매칭을 입증하지 않는다. 기존 프로필과 외부 미디어는 사용하지 않았다.

## 2026-10-09 패키지 `app.asar` 한국어 ASS 픽셀 스모크

- Electron 38.8.6 런타임에서 `dist/win-unpacked/resources/app.asar`의 실제 main, preload, renderer를 열었다. `font:default`는 패키지 main handler를 사용했고 Windows `malgun.ttf`를 반환했다. 카탈로그·상세·resolve 응답만 합성 IPC로 대체했으며 12초 로컬 MP4와 한국어 VTT·ASS를 사용했다.
- 검색 → 상세 → 1화 재생 → 이어보기 기록·한국어 자막 적용과 실제 JASSUB 캔버스 렌더링을 확인했다. `LilacAss.active=true`, 1440×810 표시 캔버스와 화면에 보이는 `한국어 ASS 통합 검증`을 캡처했다. 싱크 500ms 저장도 통과했다. 14개 조건 통과, renderer 오류 0건, 외부 HTTP(S) 요청 0건이다. 결과와 캡처는 `%TEMP%\lilac-ass-integration-20261009`에 있다.
- 한계: `app.asar`를 Electron 런타임에 직접 연결한 격리 확인이며 `dist/win-unpacked/LilacAnime.exe`나 NSIS 설치 창을 이 스모크에서 실행하지 않았다. 공급원 IPC는 합성이며 실제 사이트·스트림·자막 매칭은 검증하지 않았다.

## 2026-10-09 JASSUB npm source 및 기본 폰트 출처 추적

- npm `jassub@2.5.16`은 `2026-09-05T18:49:36.487Z` 게시다. registry metadata에 `gitHead`/attestation은 없지만, 게시 4분 23초 전 commit [`656371a`](https://github.com/ThaUnknown/jassub/commit/656371af1c904be59a1008dcdb93f18dfe5e23d0)와 npm 파일 blob을 비교했다. 11개 경로(LICENSE·README·9개 TypeScript)가 정확히 일치하고 두 WASM 및 `default.woff2`도 해당 commit의 `src/` 자산과 byte-for-byte 일치한다. package.json은 version 2.5.15→2.5.16 변경만 있다. 생성된 `dist` JavaScript는 그 commit 트리에 같은 경로로 없어 전체 tarball의 재현 provenance까지 입증된 것은 아니다.
- 그 commit의 `.gitmodules`에서 Brotli, FreeType, FriBidi, HarfBuzz, libass의 고정 SHA를 기록했다. `Makefile_licence`는 이 구성요소와 Expat의 고지를 수집하지만, Expat은 해당 `.gitmodules`/tree에서 찾지 못했다. npm tarball과 앱 산출물에는 집계 고지가 없고, `build-jassub.cjs`는 MIT `LICENSE`만 복사한다.
- `dist/default.woff2` SHA-256 `886929903707C5BB28B07CD2EED69921B3D5EF5C49C73A0DD1E187EBF6546A4C`는 pinned `src/default.woff2`와 일치한다. 기본 family는 `liberation sans`지만 원 저작권자·별도 라이선스는 미확인이다. Docker/WSL 배포판이 없어 upstream shell 기반 고지 generator를 실행하지 않았다. 전체 고지·font 권리를 해결하지 않아 배포 허가는 미결정이다.

## 2026-10-09 자막 트랙 빈 결과·조회 실패 상태 보정

- RE:Anime·Miruro의 빈 트랙 목록을 “불러오지 못했습니다”와 구분한다. 정상 응답에 트랙이 없으면 현재 회차에 선택 가능한 트랙이 없다고 표시하고, Re:Anime 트랙 요청이 실패하면 실패 상태와 재시도를 제공한다. Miruro는 현재 재생 결과에서 트랙을 함께 받으므로, 별도 조회 기능이 없는 재시도 버튼을 보이지 않게 했다.
- 응답의 `tracks`가 배열인지 확인하고, 조회 중·성공·실패 상태는 현재 재생 문맥에만 둔다. 저장 데이터 형식, 사용자 기록, 공급원 IPC와 외부 요청 경로는 바꾸지 않았다.
- 회귀 테스트는 Miruro 빈 응답/재시도 비노출, Re:Anime 성공 빈 응답과 실패 후 재시도, 트랙 선택 상태를 확인한다. 관련 테스트 묶음 33/33, 전체 `node --test` 139/139 통과했으며 `node --check src/app.js`, 테스트 파일 구문 검사, `git diff --check`도 통과했다.
- 검증 범위는 격리 VM의 렌더러 UI와 합성 조회 응답이다. 실제 Re:Anime·Miruro 사이트 응답, 스트림 자막 일치, NSIS 설치 UI는 검증하지 않았다.

## 2026-10-09 FFmpeg LGPL 후보 비교

- BtbN 고정 릴리스의 Windows x64 LGPL shared FFmpeg 9.0.2를 OS 임시 폴더에 내려받았다. 77,229,825바이트 아카이브의 SHA-256이 GitHub API digest 및 릴리스 checksum과 일치했다. 실행 시 LGPL 3 이상으로 표시되고 `libx264`·`libx265`는 비활성화돼 있다.
- 기존 로컬 FFmpeg가 만든 8개 HLS 조각(H.264/AAC)을 후보 실행 파일이 MP4로 스트림 복사 remux했다. 후보 `ffprobe`에서 H.264/AAC와 8.021초 길이를 확인했고, 시작·끝 구간의 mono 8 kHz PCM 디코딩도 성공했다. 전부 합성 미디어 검사다.
- AAC ADTS, AC-3, E-AC-3, FLAC, MP3, Opus, Vorbis 사인파 파일로 시작 `-ss 0.5`와 끝 `-sseof -1` 오디오 디코딩을 두 후보에서 비교했다. 28개 조합 모두 8 kHz mono `s16le`를 만들었고, 끝 Opus를 제외하면 각 출력은 16,000바이트였다. 실제 작품 파일·지문 정확도 검사는 아니다.
- 후보 전체 추출물은 191,013,197바이트, `bin`은 176,381,440바이트로 현재 단일 정적 실행 파일(82,797,568바이트)보다 크다. `bin`에 불필요한 ffplay·ffprobe 등이 포함되지만 최소 DLL 구성 크기는 아직 모른다. 아카이브에 LICENSE와 개발 헤더/라이브러리는 있으나 C/C++ 소스가 없어, 정확한 소스·패치·외부 라이브러리 고지는 별도 추적이 필요하다.
- 버전 차이가 더 작은 8.1.3 LGPL shared도 같은 고정 릴리스에서 받아 체크섬을 확인했다. 같은 합성 미디어 작업은 통과했지만 전체 추출물 201,293,642바이트, `bin` 186,729,472바이트로 9.0.2보다도 컸다. 따라서 더 낮은 버전도 패키지 크기 대안은 되지 않았다.
- 의존성이나 설치 빌드를 바꾸지 않았으며 후보는 미채택이다. 상세 증거와 다음 배포 차단 항목은 `docs/DEPENDENCY_LICENSE_INVENTORY.md`, `docs/RIGHTS_REVIEW.md`에 기록했다.

## 2026-10-09 로컬 AI 모델 라이선스 적용

- Tencent 공식 HY-MT1.5 1.8B·7B `License.txt`는 대한민국을 적용 지역에서 제외한다. 두 preset은 앱의 기본 목록에서 사용·다운로드를 차단하고, 차단 상태와 근거를 설정에 표시한다. 설치된 기존 GGUF 파일은 읽거나 이동·수정·삭제하지 않는다.
- 기존 번역 설정이 HY-MT1.5를 선택하고 있어도 허용된 기본 모델로 안전하게 전환한다. local AI 준비 상태와 실행 직전에도 제한 모델을 거부한다. 직접 추가하는 임의 GGUF는 라이선스를 판별할 수 없다는 안내를 추가했다.
- 공식 Gemma 4 자료와 Tencent Hy-MT2 1.8B·7B·30B GGUF 저장소의 라이선스는 Apache-2.0을 표시한다. 8개 다운로드 가능 preset의 revision·SHA-256 고정은 아래 후속 작업에서 완료했다. Aya Expanse의 비상업 조건과 `ja-ko-vn` 가중치 권리는 계속 확인 대상이다.
- 당시 새 라이선스 회귀 테스트 2/2, 전체 `node --test` 141/141 통과. 변경된 JavaScript `node --check`와 `git diff --check`도 통과했다. `npm run dist` Windows NSIS 빌드 성공; `dist/LilacAnime-Setup.exe`는 124,545,583바이트다. 패키지 `app.asar`에서 main·translator·renderer에 차단 처리가 포함된 것을 확인했다. 검증은 격리 임시 프로필을 사용했으며 실제 사용자 프로필·설치 앱 창·모델 실행은 열지 않았다.

## 2026-10-09 AI 모델 다운로드 revision·무결성 고정

- Hugging Face 공식 API에서 Gemma 4 E2B·E4B·26B-A4B, Aya Expanse 8B, Hy-MT2 1.8B·7B·30B-A3B, `ja-ko-vn` 7B의 저장소 전체 commit SHA, GGUF LFS SHA-256, 정확한 파일 크기를 조회했다. 고정한 각 commit snapshot에서 같은 파일 SHA-256·크기를 다시 대조했다. 값과 commit 링크는 `docs/DEPENDENCY_LICENSE_INVENTORY.md`에 있다.
- 앱은 `resolve/main` 대신 저장소 commit URL을 사용한다. 새 파일은 내려받는 청크와 이어받은 `.part`를 함께 SHA-256으로 검증하고 일치할 때만 최종 파일명으로 옮긴다. 검증 실패 시 `.part`만 제거한다.
- 기존 `userData/local-ai` 모델 파일은 다시 읽거나 해시 계산·교체·삭제하지 않았다. 한국 적용 지역이 불허된 HY-MT1.5 두 preset은 계속 다운로드·실행을 차단한다.
- 신규 격리 테스트는 8개 preset의 pin, 고정 URL, 처음 받기, 이어받기, 해시 불일치 중단을 확인한다. 실제 수 GB 모델은 내려받지 않는다.
- 신규 로컬 AI 테스트 4/4, 전체 `node --test` 143/143, 변경 파일 `node --check`, `git diff --check`가 통과했다. `npm run dist` Windows NSIS 빌드 성공(124,547,978바이트); `app.asar`에서 고정 revision·SHA-256 검사 코드가 포함된 것을 확인했다.
- 실사용 모델 다운로드와 추론은 하지 않았다. 모델 다운로드 기능 검증은 격리 테스트의 합성 바이트만 사용했으며, 실제 Re:Anime 영상·자막 재생도 이번 변경에서는 검증하지 않았다.

## 2026-10-09 JASSUB의 구형 브라우저 GPL fallback 제외

- `jassub@2.5.16` entrypoint가 GPL-3.0 `rvfc-polyfill@1.0.8`을 import하며, 기존 `esbuild` 설정이 실제 browser bundle에 포함하는 것을 확인했다.
- 앱은 Electron 38.8.6/Chromium 140이고 JASSUB upstream은 Chrome 80부터 native `requestVideoFrameCallback`을 지원한다고 문서화한다. 빌드에서 선택 사항인 구형 브라우저 fallback을 native-only 빈 모듈로 alias하고, 출력 bundle에 native API가 있으며 polyfill marker는 없는지 검사하도록 했다.
- `npm run vendor`, 전체 `node --test` 143/143, `node --check`, `git diff --check` 통과. `npm run dist` Windows NSIS 빌드 성공(124,546,228바이트). 패키지 `app.asar`를 임시 폴더에 추출해 bundled JS에서 native callback은 있고 `_rvfcpolyfillmap`과 `rvfc-polyfill` import는 없는 것을 확인했다.
- 전체 notice와 `default.woff2` 원 라이선스, Expat 생성기 경로는 여전히 미해결이며 공개 배포를 막는다. Electron 공식 release page는 현재 고정된 38.8.6이 end-of-support라고 표시한다. 이 major runtime 변경은 승인 없이 바꾸지 않고 다음 설정 검토 항목에 둔다.

## 2026-10-09 JASSUB runtime dependency notice audit

- pinned `build/license_defaults`는 JASSUB·Brotli를 Expat(MIT), libass를 ISC, FriBidi를 LGPL-2.1+, HarfBuzz를 MIT~old, FreeType을 FTL로 분류한다. 다섯 pinned submodule의 `LICENSE`/`COPYING` 파일을 확인했다. `Makefile_licence`는 `expat` 입력도 요구하지만 `.gitmodules`에는 대응 경로가 없다. 이 설정만으로 WASM에 Expat 코드가 포함됐다고 볼 수 없다.
- 같은 esbuild 설정의 metafile에서 main bundle 입력은 `abslink@1.3.0`(Apache-2.0)·`throughput@1.0.2`(MIT), worker 입력은 `abslink@1.3.0`·`lfa-ponyfill@1.1.1`(MIT)로 확인됐다. `rvfc-polyfill@1.0.8`은 native-only alias로 대체됐다. 세 라이선스 문구는 vendor 빌드 산출물에 복사되지 않으며, 기본 폰트 family 표기만으로 `default.woff2`의 출처·라이선스를 확인하지 못했다.
- 상세 파일 위치와 한계는 `docs/DEPENDENCY_LICENSE_INVENTORY.md`에 기록했다. 이 조사에서는 앱 번들에 notice 파일을 추가하지 않았고, 공개 배포 차단 상태를 유지한다.

## 2026-10-09 로컬 번역 모델 이용 조건 재확인

- Aya Expanse GGUF의 고정 snapshot README와 API metadata를 확인했다. snapshot은 CC-BY-NC-4.0을 선언하며 Cohere license/privacy 안내와 비상업 사용 항목을 표시한다. GGUF 저장소 API의 `gated` 값은 false였고, 앱의 직접 다운로드에는 약관 확인이 없어서 모델 목록에 비상업 경고를 표시했다. 실제 모델 파일을 받거나 약관에 동의하지 않았다.
- `ja-ko-vn` GGUF의 고정 snapshot과 README는 Apache-2.0을 선언하고 `hell0ks/ja-ko-vn-7b-v1`에서 양자화했다고 밝힌다. 원 모델은 TrillionLabs Tri-7B-Base를 기반으로 fine-tune됐다고 설명하며, 두 저장소의 model card도 Apache-2.0을 표시한다. 학습 대화 자료의 출처·권리 설명은 찾지 못했다. 기존과 같이 성능 검토를 위해 legacy 목록 정책을 유지한다.
- `node --check electron/local-ai.cjs`, `node --test tests/local-ai-model-pins.test.cjs` 2/2, `git diff --check`가 통과했다. `npm run dist`도 성공해 Windows NSIS 설치 파일 124,546,916바이트를 만들었다. `app.asar`에서 비상업 경고와 JASSUB native callback을 확인했고, GPL fallback marker 및 별도 `node_modules/jassub` 패키지는 없다. 모델·사용자 데이터 파일은 읽거나 변경하지 않았다.

## 2026-10-09 Aya Expanse 다운로드 전 이용 조건 확인

- Aya Expanse 설정 행에 Cohere 공식 CC-BY-NC 4.0 및 허용 사용 추가 조건 링크를 넣었다. 다운로드 버튼을 누르면 조건을 먼저 확인하고 비상업 용도로만 사용한다는 확인 창이 뜬다. 취소하면 다운로드 IPC와 진행 상태를 시작하지 않는다.
- 확인 창은 사용자 안내용이며 앱이 약관 열람, 법적 동의 또는 사용 적격성을 검사하거나 기록하지 않는다. 약관 링크를 누르면 기본 브라우저에서 공식 Cohere 페이지를 연다. 기존 설치 모델 파일이나 사용자 설정은 건드리지 않았다.
- [Cohere 공식 모델 카드](https://huggingface.co/CohereLabs/aya-expanse-8b), [CC-BY-NC 4.0 및 허용 사용 추가 조건](https://cohere.com/cohere-labs-cc-by-nc-license), [Cohere 사용 정책](https://docs.cohere.com/docs/usage-policy/)을 확인했다. 공개 배포 제한은 유지한다.
- `node --test tests/local-ai-model-pins.test.cjs` 3/3, 전체 `node --test` 144/144 통과. `node --check electron/local-ai.cjs`, `node --check src/app.js`, 테스트 파일 구문 검사, `git diff --check`도 통과했다.
- `npm run dist` Windows NSIS 빌드 성공(설치 파일 124,547,245바이트). 패키지 `app.asar`에서 Cohere 링크, 확인 창, 다운로드 진행 전에 놓인 확인 검사를 확인했다. 실제 브라우저에서 링크를 열거나 Aya 모델을 받지는 않았고, 기존 사용자 데이터도 건드리지 않았다.

## 2026-10-09 한국어 우선 제목·원제 표시

- 제목 언어 설정을 제거하고 한국어 제목을 우선 표시하도록 통일했다. 번역 제목이 없으면 확인 가능한 일본어·원제를 표시한다. 홈 추천·작품 카드·이어보기·시청 기록·다운로드 목록·상세 화면·플레이어에 원제를 보조로 붙였다.
- 다운로드 기록에 영어 표시 제목만 저장돼 있더라도 한국어 제목 조회를 건너뛰지 않도록 세션 내 조회 상태를 캐시와 분리했다. 예전 `titleLanguage` 설정값은 읽거나 삭제하지 않으며, 라이브러리·시청 기록·다운로드 데이터도 변경하지 않았다.
- 검증: `node --test` 151/151, `node --check src/app.js`, `node --check src/title-display.js`, `git diff --check` 통과. `npm run dist`로 124,548,760바이트의 Windows NSIS 설치 파일을 만들고 `app.asar`에 새 제목 모듈·renderer·마크업·스타일이 포함된 것을 확인했다. 설치 파일은 로컬 산출물이며 배포하지 않았다.
- 한계: 실 TMDB 키를 이용한 제목 조회, 실제 작품별 시즌·판본 매칭, 설치 앱의 화면·외부 영상은 이번 변경에서 검증하지 않았다.

## 2026-10-09 ChatGPT 수동 자막 번역 저장 재시도

- ChatGPT 번역 결과의 마지막 저장이 실패해도 검증된 문장을 유지하고 저장만 재시도할 수 있게 했다. 다시 번역을 붙여넣을 필요가 없고, 같은 자막 원본·회차인지 확인하는 기존 안전 검사는 유지한다.
- `node --test tests/manual-subtitle-translation.test.cjs tests/manual-subtitle-translation-ui.test.cjs` 9/9 통과. 첫 저장 실패 뒤 재시도 성공, 재붙여넣기 없이 한 번만 파싱하는 동작을 시험했다. `npm run dist` 성공(124,548,604바이트); `app.asar`에서 저장 재시도 UI와 흐름을 확인했다. 실제 ChatGPT 왕복과 번역 품질은 미검증이다.

## 2026-10-09 자막 출처 선택 경합 방지

- 저장 자막 조회나 온라인 출처 검색이 지연된 사이 회차 또는 사용자의 출처 선택이 바뀌어도 이전 요청이 새 선택을 덮지 않도록 재생 회차 ID와 자막 선택 순번을 함께 확인한다. 자동 자막 검색을 중단하고 진행 중인 자막 번역을 취소한다. Re:Anime 트랙·Anissia 제작자·Jimaku 선택의 지연 결과에도 같은 경계를 적용했다.
- 회귀 검증 5건에서 이전 회차의 저장 결과, 오래된 출처 조회, 늦은 검색 응답, 자동 검색 중 명시적 출처 변경, 출처 선택 때 진행 중이던 번역의 취소를 확인했다. `node --test` 156/156, `node --check src/app.js`, `node --check src/player.js`, 테스트 구문 검사, `git diff --check`가 통과했다.
- `npm run dist` Windows NSIS 빌드 성공(124,548,713바이트). 패키지 `app.asar`의 `src/app.js`와 `src/player.js`에서 요청 선택 검사 포함을 확인했다. 설치 파일은 로컬 산출물이며 배포하지 않았다. 실제 공급원 검색과 실제 작품·회차·영상판 자막 일치는 여전히 미검증이다.

## 2026-10-10 홈 최신 회차 선택 경합 방지

- 홈 최신 회차 카드의 상세 조회가 늦게 끝나도, 나중에 고른 카드나 검색·상세 이동·다른 재생 요청을 덮지 않도록 요청 순번을 확인한다. 이전 요청은 오래된 오류 알림도 띄우지 않는다.
- 지연된 첫 조회보다 두 번째 선택의 응답이 먼저 오는 회귀 테스트를 추가했다. 첫 작품이 나중에 응답해도 두 번째 작품만 재생 요청되는 것을 확인했다. `node --test` 157/157, 대상 테스트 8/8, 앱·테스트 구문 검사, `git diff --check`가 통과했다.
- `npm run dist` Windows NSIS 빌드 성공(124,548,981바이트). 생성한 `app.asar`의 `src/app.js`에서 요청 순번과 오래된 요청 가드가 포함된 것을 확인했다. 설치 파일은 로컬 산출물이며 배포하지 않았다. 실제 공급원 요청·영상 재생과 사용자 프로필은 건드리거나 검증하지 않았다.

## 2026-10-10 HLS 이벤트 교체 경합 방지

- 각 HLS 이벤트 콜백이 자신을 만든 인스턴스가 여전히 현재 재생인지 확인한다. 이전 회차에서 늦게 도착한 manifest·buffer·fatal error 이벤트는 새 회차의 재생 시작, 오류 복구, 상태 표시를 건드리지 않는다. 기존 네트워크·미디어 복구 횟수 제한은 유지한다.
- `tests/hls-player-instance.test.cjs`에서 이전 인스턴스의 manifest·네트워크 오류·미디어 오류를 새 인스턴스 교체 뒤 전달해 현재 화면과 새 플레이어가 바뀌지 않는 것을 확인했다. 활성 인스턴스의 manifest 처리와 기존 네트워크 복구도 확인했다. 전체 `node --test` 159/159, 구문 검사, `git diff --check` 통과.
- `npm run dist` Windows NSIS 빌드 성공(124,549,211바이트). 패키지 `app.asar`에서 다섯 HLS 이벤트 등록 모두 인스턴스 가드가 포함되고 새 인스턴스에 연결된 것을 확인했다. 설치 파일은 로컬 산출물이며 배포하지 않았다. 실제 외부 HLS 스트림의 복구 동작은 미검증이다.

## 2026-10-10 직접 영상 오류 안내

- 브라우저 영상 요소에서 HLS 바깥의 네트워크·디코딩·지원 형식 오류가 발생하면 준비 스피너를 멈추고 원인을 설명한다. 공급원 영상 주소 조회가 실패한 경우에도 같은 스피너 종료 화면을 쓴다. HLS가 직접 관리하는 오류, 오류 객체가 없는 상태, 소스 변경에 따른 정상 중단은 중복 표시하지 않는다. 새 재생 준비를 시작하면 스피너 상태를 복구한다.
- 합성 MediaError 코드 2·3·4와 알 수 없는 코드의 안내, HLS/소스 없음/정상 중단 제외, 공급원 주소 조회 실패의 공통 오류 화면 사용, DOM 이벤트 연결을 검사했다. 전체 `node --test` 163/163, 앱·테스트 구문 검사, `git diff --check` 통과.
- `npm run dist` Windows NSIS 빌드 성공(124,549,614바이트). 패키지 `app.asar`에서 오류 처리기·이벤트 연결·스피너 복구가 들어간 것을 확인했다. 설치 파일은 로컬 산출물이며 배포하지 않았다. 실제 설치 UI에서 오류 화면이나 실제 영상 오류는 아직 검증하지 않았다.

## 2026-10-10 원본 v0.5.9 선별 반영

- `upstream/main`이 v0.5.8의 `192fd8bd1965882fcb1f911178e6bfef0ff33e56`에서 v0.5.9 `4550d61725a8b57e6e890e97bd0f25244a8cf164`로 갱신된 것을 확인하고, 새 커밋의 코드 차이를 검토했다. TMDB 실패 재시도, VTT 중앙 정렬, 재생 중 마우스 왼쪽 버튼 길게 누르기 2배속을 반영했다. 자동 다음 화 재생은 변경하지 않았다.
- TMDB 오류·시간 초과·잘못된 응답을 “검색했지만 한국어 제목 없음”으로 30일 캐시하지 않는다. 실패한 묶음은 중단하고 30분 뒤 재시도하며 설정 화면에서 실패 상태를 구분한다. 이전 숫자형 검색 기록은 한 번 다시 확인하고, 저장된 한국어 제목은 보존한다.
- Chromium에서 폭 90% 자막 큐가 왼쪽으로 밀리는 것을 막기 위해 큐를 100% 폭으로 두고, 미디어 텍스트 표시 상자에 좌우 5% 여백을 둔다. 재생 중인 영상·빈 영상 영역을 왼쪽 버튼으로 400ms 누르면 2배속을 임시 적용하고, 놓을 때 원래 속도로 복원하며 짧은 클릭과 구분한다. 키보드 Space 조작은 유지한다.
- TMDB 재시도·기존 캐시 이전·제목 페이지 오류·응답 코드 합성 테스트와 마우스 조작 테스트를 추가했다. 전체 `node --test` 175/175, 변경 파일 구문 검사, `git diff --check`가 통과했다. 별도 Electron 픽셀 스모크는 1080p, 4K/150%·200%, 상단 문구, 좁은 창 긴 문장, 4:3 화면의 7개 조합 모두 중앙 정렬을 확인했고 HTTP(S) 요청 시도는 0건이었다. 스모크는 임시 프로필과 합성 화면을 사용했다.
- `npm run dist` Windows NSIS 빌드 성공(설치 파일 124,549,935바이트). 패키지 `app.asar`에서 TMDB 오류 재시도, VTT 100% 큐 폭·5% 여백, 마우스 조작 설명이 포함된 것을 확인했다. 실제 TMDB 키·실제 공급원·영상·자막은 사용하거나 검증하지 않았다. 설치 파일은 로컬 산출물이며 배포하지 않았다.
- Electron 픽셀 스모크의 격리 프로필 `%TEMP%\lilac-subtitle-layout-OYTsIT\profile`이 임시 폴더에 남아 있다. 삭제 시도는 실행 환경 정책에 의해 차단되어 건드리지 않았다. 프로젝트 파일과 기존 앱 프로필은 변경하지 않았다.

## 2026-10-10 v0.5.9 빌드 버전 정렬과 재현 스모크

- 현재 코드가 upstream v0.5.9의 선택 반영을 포함하므로 `package.json`과 lockfile의 루트 앱 버전을 0.5.9로 맞췄다. package lock dependency 버전은 변경하지 않았다.
- Windows NSIS 패키지가 성공적으로 생성됐다. `app.asar/package.json`의 버전은 0.5.9, 설치 파일은 124,555,713바이트다. 설치 파일은 실행·배포하지 않았다. GitHub 저장소 visibility는 PRIVATE로 확인했다.
- `npm test`: 219/219 통과. `npm run test:phase1-electron`: 빌드 패키지의 검색→Re:Anime 회차→합성 한국어 VTT→27% 저장→이어보기 흐름 통과, 외부 요청 시도 0건·렌더러 오류 0건.
- `npm run test:phase1-subtitle-layout`: 1080p, 4K, 4K 150%·200%, 상단 자막, 긴 창 모드 자막, 4:3 stretched 영상 7개 픽셀 검사 통과. 이 검사는 현재 `src` 파일을 Electron 창에 넣어 실행하며 외부 HTTP(S) 요청 시도는 0건이다.
- 실제 공급원·실제 영상/자막 일치와 설치 앱은 여전히 미검증이다. 소스·API 이용 조건을 검토하기 전에는 공개 배포하지 않는다.

## 2026-10-10 패키지 오류 진단 복사 UI 스모크

- `tests/integrated-search.electron.cjs`에서 패키지 `app.asar` renderer/preload의 재생 오류 화면을 띄우고 `오류 정보 복사`를 직접 눌렀다. 성공 안내와 버전·Windows 아키텍처, 최근 5건 제한, 오류 상세 문자열·전체 미디어 주소 제외를 확인했다.
- `npm run test:phase1-electron` 통과: 검색 IPC 22회, 영상 resolve 2회, 이어보기 27%→약 3.26초, 렌더러 오류 0건, 외부 요청 시도 0건. Electron 프로필·합성 영상·자막·클립보드는 임시 폴더와 IPC fixture를 사용했다.
- 한계: 앱 main handler, 실제 시스템 클립보드, 설치 NSIS UI, 실제 공급원·영상은 검증하지 않았다.

## 2026-10-10 만료된 로컬 스트림 기록 보존

- 앱 시작 때 이전 버전의 `127.0.0.1/__flix/...` 재생 주소를 가진 시청 기록 전체를 지우던 처리를 바꿨다. 만료된 로컬 주소만 비우고 제목·회차·작품·진행률은 보존한다. 회차 정보가 없는 기록도 `playbackSourceExpired`로 구분해 기록에는 남기며, 재생할 수 없는 홈 이어보기 카드에서는 제외하고 선택하면 다시 작품 상세에서 회차를 고르도록 안내한다.
- `tests/home-continuation.test.cjs` 4/4, 전체 `npm test` 221/221 통과. 시작 시 한 번만 저장소를 마이그레이션하며 일반 주소와 기존 재생 키는 유지한다.
- Windows NSIS 빌드 성공. 패키지 `app.asar` 버전 0.5.9에 정리 코드가 포함됐고 설치 파일은 124,555,765바이트다. 로컬 산출물이며 실행·배포하지 않았다.
- `npm run test:phase1-electron`은 임시 프로필에 만료 주소를 가진 기록 2개를 심고 앱을 다시 열어 둘 다 보존되고 로컬 주소만 제거되는 것을 확인했다. 회차 정보가 있는 기록은 회차·41% 진행률이 유지되고 홈 이어보기 카드에 남았으며, 직접 재생 기록은 기록 저장소에 보존하고 홈 이어보기에서 제외했다. 이어서 검색→상세→재생→한국어 VTT→27% 저장→약 3.26초 이어보기와 오류 정보 복사도 통과했다. 검색 IPC 23회, resolve 2회, 렌더러 오류·외부 요청 시도 각각 0건이다.
- 한계: 기존 사용자 프로필, 실제 만료 기록, 실제 공급원 영상은 사용하지 않았다. 통합 검증은 합성 기록·IPC·영상으로 했다.

## 2026-10-10 재생 스트림 헤더 경합 보호

- 새 회차 재생을 시작할 때 요청 세대를 올리고 이전 스트림 헤더를 비운다. 현재 선택된 요청만 완료 시 헤더를 등록하며, 늦게 끝난 이전 공급원 응답은 새 재생 상태를 덮지 않는다. 탐색 후보·다운로드용 스트림 조회는 플레이어 세션 헤더에 영향을 주지 않도록 분리했다.
- Referer·Origin·User-Agent·Cookie·Authorization만 허용하고, 선택된 스트림의 호스트별 헤더를 적용한다. Miruro·Ohli24의 다중 미디어 호스트 fallback은 메인 플레이어 요청에만 사용하며, 로컬 FlixCloud 프록시에 원격 인증 헤더를 보내지 않는다.
- 회귀 테스트 4/4와 전체 `node --test` 179/179, 두 CJS 파일 구문 검사, `git diff --check`가 통과했다. `npm run dist` Windows NSIS 빌드 성공(설치 파일 124,549,384바이트); 패키지 `app.asar`에서 새 헤더 모듈 포함을 확인했다. 실제 Re:Anime·Miruro·Ohli24 요청과 영상 스트림 재생은 검증하지 않았다. 설치 파일은 로컬 산출물이며 배포하지 않았다.

## 2026-10-10 이어보기 조회 경합 보호

- 시청 기록의 작품·회차 조회가 늦게 끝나 뒤늦게 고른 이어보기나 홈 최신 회차 재생을 덮지 않도록, 이어보기·최신 회차·플레이어 스트림 요청에 공통 선택 순번을 적용했다. 화면 전환, 검색, 상세 열기, 새 재생 선택은 대기 중인 조회를 취소한다.
- 두 이어보기 카드를 연속 선택해 응답 순서가 뒤집히는 경우 최신 선택만 회차·진행률을 전달하는지 검증했다. 홈 최신 회차와 이어보기 조회를 서로 교차 실행해 가장 최근 선택만 재생하는 것도 확인했다. 탐색을 벗어난 요청은 재생을 시작하지 않는다. 관련 테스트 12/12, 전체 `node --test` 183/183, 앱·테스트 구문 검사, `git diff --check` 통과.
- `npm run dist` Windows NSIS 빌드 성공(설치 파일 124,549,216바이트). 패키지 `app.asar`의 `src/app.js`에 새 선택 순번과 늦은 이어보기 응답 차단이 포함된 것을 확인했다. 실제 공급원 요청·영상 재생은 수행하지 않았으며 설치 파일은 로컬 산출물로만 보관한다.

## 2026-10-10 JASSUB 고지 생성 경로 재확인

- JASSUB `656371a`의 공식 `Makefile_licence`, `.gitmodules`, `build/license_defaults`, `build/license_extract.sh`를 GitHub API로 직접 확인했다. Makefile은 `expat`을 고지 대상에 넣고 `.git/modules/lib/%/HEAD`를 요구하지만, `.gitmodules`에는 5개 submodule만 있고 `license_defaults`에도 `expat` 항목이 없다. 추출 script는 매핑된 라이선스, 소스 디렉터리, `licensecheck`를 요구한다.
- 따라서 선언된 submodule만으로는 upstream Expat 고지 target의 입력을 재현할 수 없다. 이 불일치는 Expat이 WASM에 포함됐다는 증거가 아니다. 번들된 `abslink@1.3.0`, `throughput@1.0.2`, `lfa-ponyfill@1.1.1`도 설치된 npm 패키지에 SPDX metadata만 있고 별도 LICENSE/COPYING/NOTICE 파일이 없다.
- 앱 코드·의존성·자산·사용자 데이터는 바꾸지 않았다. 전체 고지, Expat 입력 출처, 기본 font 권리는 미해결이며 배포 보류를 유지한다. 상세 출처와 추출 절차는 `docs/DEPENDENCY_LICENSE_INVENTORY.md`, `docs/RIGHTS_REVIEW.md`에 기록했다.

## 2026-10-10 JASSUB 기본 폰트 라이선스 동봉

- 기존 도구의 FontTools 4.63.0/Brotli 1.2.0으로 bundled `default.woff2`를 읽었다. 메타데이터는 Liberation Sans Version 2.00.5, copyright Google 2010/Red Hat 2012, SIL OFL 1.1을 표시한다. 공식 Liberation Fonts 2.00.5 release의 `LiberationSans-Regular.ttf`와 glyph order·cmap·horizontal metrics·모든 glyph outline을 대조해 일치시켰고, release `LICENSE`의 API 응답과 첨부 tarball 사본도 SHA-256 `93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b`로 byte-identical 확인했다.
- 공식 OFL 고지를 `licenses/Liberation-Fonts-2.00.5-OFL-1.1.txt`로 추가하고, `package.json`의 `extraResources`로 사용자 열람이 쉬운 `resources/licenses`에 복사하도록 했다. 이 보완은 JASSUB/libass, Expat, 번들 JS 의존성의 전체 고지 미해결을 해결하지 않는다.
- `node --check scripts/build-jassub.cjs`, package JSON 파싱, `npm run vendor`, 전체 `node --test` 183/183, `npm run dist` Windows NSIS 빌드가 통과했다. `app.asar`에 Liberation Sans font와 JASSUB `LICENSE`가 있고, unpacked Windows 앱의 `resources/licenses/Liberation-Fonts-2.00.5-OFL-1.1.txt` SHA-256이 저장소 파일과 일치한다. NSIS 설치 파일은 124,551,257바이트의 로컬 산출물이다. 설치 실행·실제 공급원·사용자 프로필은 검사하지 않았다.

## 2026-10-10 재생 오류 진단 정보 복사

- 스트림 주소 확인·직접 영상·HLS 재생의 최종 실패 화면에 `오류 정보 복사`를 추가했다. 사용자가 버튼을 눌렀을 때만 앱 버전, OS·CPU, 허용 목록의 공급원, 오류 단계·미디어 형식, 서버 호스트명, 제한된 오류 코드가 클립보드에 복사된다. 앱 실행 중 최근 5건만 메모리에 보관하며, 작품명·회차·전체 URL·요청 헤더·쿠키·자막 내용·상세 오류 문구는 보고서에 넣지 않는다.
- 개인정보 제거와 필드 허용 목록 테스트, 직접 영상 오류 연결을 포함한 전체 `node --test` 187/187 통과. 수정 파일 구문 검사와 `git diff --check`가 통과했고, `npm run dist` Windows NSIS 빌드가 성공해 124,553,317바이트의 설치 파일을 생성했다. `app.asar`에 UI·진단 모듈·preload·IPC 연결이 포함된 것도 확인했다.
- 설치된 앱에서 버튼을 누르는 화면 동작과 실제 공급원 오류는 아직 확인하지 않았다. 설치 파일은 로컬 검증 산출물로만 둔다.

## 2026-10-10 자동 영상 서버 전환

- HLS의 기존 네트워크·미디어 복구가 소진된 뒤, RE:Anime·Animenosub·Miruro가 현재 회차에서 제공한 서버 중 같은 유형의 후보만 최대 2개까지 자동 시도한다. 후보 주소를 확인하다 실패한 경우도 전환 횟수에 포함하며, 다음 서버 선택은 정확한 후보 하나로 제한해 다른 서버를 한꺼번에 열지 않는다. 실패 후보는 제외하고 저장된 서버 선호도는 바꾸지 않는다.
- 재생 중 전환은 현재 위치를 초 단위로 다시 적용하고 회차의 저장 진행률을 갱신한다. 이미 적용된 자막 파일·트랙 선택을 유지하며, 새 서버에서 트랙이 아직 적용 전이었다면 같은 트랙을 다시 찾는다. 대체 서버가 없거나 두 번 모두 실패하면 기존 HLS 오류 안내로 끝난다. 오프라인 재생과 다른 공급원에는 자동 전환하지 않는다.
- 전용 합성 회귀 테스트는 후보 유형·최대 횟수·주소 확인 실패 순서·기존 HLS 최종 오류를 확인한다. 추가 VM 통합 테스트에서는 앱의 `resolveIntoPlayer`·`startAutomaticVideoServerFallback`·HLS 이벤트 바인딩·`applyPendingResume` 함수를 합쳐, 초기 서버의 재시도 3회 후 정확한 대체 서버 resolve, 120.25초 위치 복구, 선택 자막 복구 및 저장된 서버 선호도 변경 없음까지 확인한다. 전체 `node --test` 197/197, 수정 JavaScript와 테스트 구문 검사, `git diff --check`가 통과했다. `npm run dist` Windows NSIS 빌드도 성공했고, 124,555,049바이트의 설치 파일은 로컬 산출물로만 남겼다. 패키지 `app.asar`에서 새 모듈과 main·renderer 연결을 확인했다.
- 검증은 합성 데이터와 패키지 구조에 한정한다. 실제 Re:Anime·Animenosub·Miruro 서버 목록·스트림, 설치 앱 재생은 확인하지 않았으며, 사이트 권리 검토 전 외부 요청과 공개 배포를 계속 보류한다.

## 2026-10-10 자막 파일 문자 인코딩 회귀 검증

- ASS/SSA의 WebVTT 대체본 생성만 UTF-8 고정 읽기를 사용해 CP949·UTF-16 파일에서 한글이 깨질 수 있어, 기존 SRT·SMI와 같은 인코딩 감지 함수로 읽도록 맞췄다. 원본 ASS/SSA 경로를 보존하는 동작은 유지했다.
- 실제 변환 함수와 `subtitleResult`를 호출하는 임시 파일 테스트에서 UTF-8 BOM SRT, CP949 SMI, UTF-16LE ASS, CP949 SSA 및 VTT 직접 사용을 확인했다. ASS의 `\N` 줄바꿈·쉼표 포함 대사와 SMI 다음 SYNC 기준 종료 시각도 확인했고 4/4 통과했다.
- 격리 Electron 창에서 실제 `src/ass-renderer.js`·JASSUB WASM에 640×360 합성 영상을 연결하고, Windows `Malgun Gothic` 파일과 한글 ASS cue를 전달했다. 캡처에서 아래쪽 한글 대사가 밝은 픽셀 738개로 렌더됐고 외부 HTTP(S) 요청은 0건이었다. 렌더 완료 전 캡처하면 픽셀 검사가 실패해 대기 후 캡처하도록 했다.
- 별도 흐름 테스트에서 실제 `file:subtitle` 처리기와 사용자 자막 버튼·`attachSubtitle` 코드를 연결했다. 합성 UTF-16LE ASS와 글꼴이 격리 userData 아래로 복사되고, 변환 WebVTT가 `<track>`에, 원본 ASS와 글꼴·125ms 싱크가 JASSUB 호출에 전달되며 단순 WebVTT 트랙은 숨겨지는 것을 확인했다. 원본 ASS는 바뀌지 않았다.
- 파일 선택 창을 기다리는 동안 출처나 회차가 바뀌면 늦게 돌아온 파일이 현재 선택을 덮는 경합을 재현하고 수정했다. 반환 시 `playbackRequestId`와 `subtitleSelectionRequestId`를 모두 확인하며, 회귀 테스트에서 더 새 출처 선택과 회차가 오래된 파일보다 우선하는 것을 확인했다.
- 전체 `node --test` 202/202, `src/app.js`·신규 테스트 구문 검사, `git diff --check`가 통과했다. `npm run dist` Windows NSIS 빌드가 성공해 124,555,809바이트 설치 파일을 만들었고, 패키지 `app.asar`에서 ASS/SSA 공유 인코딩 판독기와 늦은 파일 선택 차단 코드를 확인했다. 설치 파일은 로컬 산출물로만 두었다.
- 합성 로컬 파일만 사용했다. 실제 사용자가 가진 자막 파일, SMI SAMI 변형, 설치 NSIS 앱의 설정·화면 동작, 외부 공급원 자막은 확인하지 않았다.

## 2026-10-10 자막 파일 선택 오류 복구

- 사용자 자막 선택창이 열려 있는 동안 버튼을 잠가 중복 네이티브 대화상자 호출을 막고, IPC 실패 시 현재 회차에서만 다시 선택하라는 안내를 표시하도록 했다. 취소·성공·실패 모두 버튼이 다시 활성화되며 자막 상태는 실패한 선택으로 바뀌지 않는다.
- 회귀 테스트에서 겹친 호출이 하나로 제한되고 IPC 오류 뒤 버튼이 복구되며 자막이 적용되지 않는 것을 확인했다. 전체 `node --test` 203/203, 수정 JavaScript·테스트 구문 검사, `git diff --check` 통과. `npm run dist` Windows NSIS 빌드가 성공해 124,555,862바이트의 로컬 설치 파일을 만들었다. 패키지 `app.asar`의 renderer에 버튼 잠금과 오류 안내가 들어간 것을 확인했다.
- 합성 오류만 사용했다. 설치된 앱에서 Windows 파일 대화상자와 실제 오류 화면은 검증하지 않았고 설치 파일은 배포하지 않았다.

## 2026-10-10 JASSUB JS 보조 의존성 출처 재확인

- 고정 패키지 버전의 npm 페이지는 `abslink@1.3.0`을 Apache-2.0, `throughput@1.0.2`와 `lfa-ponyfill@1.1.1`을 MIT로 표시하고, registry `dist.integrity` 세 값은 lockfile과 일치한다. `throughput`·`lfa-ponyfill`에는 `ThaUnknown` author가 있으나 `abslink` package metadata에는 author가 없고, registry metadata는 세 패키지의 `gitHead`를 제공하지 않는다.
- 세 공식 GitHub 저장소의 현재 기본 브랜치에서 LICENSE/NOTICE를 찾지 못했고 GitHub API도 감지된 라이선스를 반환하지 않았다. 이 브랜치가 lockfile tarball의 정확한 source revision이라는 증거는 없어, 저작권 문구를 추정하거나 새 notice를 생성하지 않았다. 상세 출처와 공개 배포 차단 사유를 `docs/DEPENDENCY_LICENSE_INVENTORY.md`에 추가했다. JASSUB 전체 고지는 계속 미해결이다.

## 2026-10-10 자막 선택 초기화 오류 복구

- 사용자 자막 선택 버튼을 잠근 뒤 `beginSubtitleSelection()` 초기화가 실패하면 기존에는 `finally` 전에 예외가 나 버튼이 계속 잠길 수 있었다. 초기화를 같은 `try/finally`에 넣고 버튼을 항상 복구하며, 오류 토스트는 현재 재생·자막 선택에서만 표시하도록 했다. 오래된 파일 선택 오류는 숨긴다.
- 초기화 실패·IPC 오류·중복 열기·더 새 선택 뒤의 늦은 오류를 포함한 사용자 자막 회귀 테스트 4/4, 전체 `node --test` 205/205, 수정 파일 구문 및 diff 검사가 통과했다. `npm run dist` Windows NSIS 빌드가 성공해 124,554,569바이트 로컬 설치 파일을 생성했다. 패키지 `app.asar`의 초기화 이동·오류 선택 검사·버튼 복구를 4개 확인 항목으로 검사했다.
- 설치 파일은 실행·배포하지 않았다. 실제 Windows 파일 대화상자와 외부 공급원은 미검증이다.

## 2026-10-10 늦은 한국어 자막 교체 제안 경합 방지

- 현재 자막이 한국어가 아닐 때 제안하는 한국어 자막 검색은 회차 순번만 확인해, 사용자가 다른 자막 출처를 고른 뒤 늦게 완료되면 이전 검색의 제안을 표시할 수 있었다. 표시·적용 시 회차, 자막 선택 순번, 현재 자막이 모두 그대로인지 확인하도록 했다.
- 늦은 제안 표시와 제안이 뜬 뒤 바뀐 출처로 덮어쓰기 방지 회귀 테스트를 추가했다. 관련 테스트 30/30, 전체 `node --test` 207/207, `node --check` 및 `git diff --check`가 통과했다. `npm run dist` Windows NSIS 빌드 성공(124,556,088바이트) 및 패키지 `app.asar`에 네 조건이 포함된 것을 확인했다.
- 합성 검색 결과만 사용했으며, 설치 파일은 실행·배포하지 않았다. 실제 외부 공급원은 미검증이다.

## 2026-10-10 5개 공급원 통합 검색

- 검색 화면에서 RE:Anime·Animenosub·Miruro·애니24·Linkkf를 함께 조회하고, 제목 변형은 최대 3개, 공급원 조회 동시성은 6으로 제한한다. 한국어 검색은 RE:Anime·Animenosub의 한국어 카탈로그 검색을 병행하며, 한국어 검색을 지원하지 않는 Animenosub·Miruro에는 원문 한국어 검색을 보내지 않는다.
- AniList ID가 같은 결과만 우선 통합하고, MAL ID는 연결 대상 AniList ID가 하나로 확정될 때만 보조 식별자로 쓴다. ID가 없거나 연결이 모호한 결과는 별도 카드다. 공급원 필터와 상세 화면의 원본 공급원 선택을 연결했으며, 내 목록에는 선택된 실제 공급원 항목을 보관한다. 검색 실패 상태와 성공한 빈 결과를 구분한다.
- 기본 검색 결과를 제목 변형 조회보다 먼저 표시하고, 변형 검색 완료 뒤 합치는 2단계 검색으로 구성했다. 첫 결과 이후 변형 준비 중과 추가 검색 중을 상태 문구로 구분하며, 변형이 없으면 대기 문구를 지운다. 이전 검색 결과의 늦은 응답은 검색 순번으로 무시한다.
- 통합 검색 때 숨기는 Linkkf 태그 필터는 Linkkf 홈 목록을 다시 열면 복구하도록 했다.
- `tests/integrated-search.test.cjs` 12/12, 전체 `node --test` 219/219, 변경 JS 구문 검사 및 `git diff --check`가 통과했다. `npm run dist` Windows NSIS 빌드 성공(124,555,418바이트). 빌드된 `app.asar`에서 앱 코드·HTML·CSS 포함, 검색 모듈의 앱 코드 선행 로드, 2단계 검색 문구를 확인했다.
- 통합 ID 규칙은 합성 데이터로 검증했다. 실제 공급원 응답/ID 품질과 상세·회차·영상은 권리 확인 전이라 조회하지 않았다. NSIS 설치 파일은 실행하거나 배포하지 않았다.

## 2026-10-10 패키지 통합 검색 화면 스모크 (첫 단계)

- `tests/integrated-search.electron.cjs`에서 빌드된 `app.asar`의 실제 HTML·렌더러·preload를 격리 Electron 창으로 열었다. IPC는 테스트 전용 합성 응답으로 등록했고 외부 요청은 Chromium 단계에서 차단했다. 앱 `main.cjs`와 설치된 EXE는 실행하지 않았다.
- 검색어 `통합 검색 테스트`에서 제목 변형 응답을 1초 지연해도 기본 검색의 3개 카드가 먼저 나타나고 `다른 제목 표기 준비 중`이 표시됐다. 응답 전에 `경합 확인 테스트`를 시작하자 새 검색이 유지되고 늦은 이전 결과는 공급원 검색이나 화면을 덮지 않았다. 제목 변형이 없는 경우 대기 상태가 사라지는 것도 확인했다. 이어 제목 변형을 포함한 검색에서 5개 공급원의 결과가 3개 작품으로 합쳐지고, AniList/MAL ID 연결 작품이 3개 공급원 묶음으로 보였다. Miruro 필터, 상세의 3개 공급원 선택, 필터를 따른 Miruro 초기 선택, Re:Anime 선택 뒤 해당 공급원의 상세 재조회도 통과했다.
- 전체 `node --test` 219/219, 변경 파일 구문 검사, `git diff --check`, Windows NSIS 빌드가 통과했다. 패키지 설치 파일은 124,555,556바이트다. 패키지 렌더러 스모크는 합성 검색 IPC 21회, renderer console 오류 0건, 외부 요청 시도 0회, 임시 `userData` 프로필을 사용했다.
- 검증 한계: 앱 main-process의 실제 공급원 핸들러, 공급원 응답·ID 신뢰도·회차·영상·자막, 설치 NSIS 앱과 사용자 프로필은 확인하지 않았다. 설치 파일은 실행·배포하지 않았다.

## 2026-10-10 이어보기 통합 패키지 스모크

- `tests/integrated-search.electron.cjs`를 확장해 기존 통합 검색 경합·출처 선택 검사 뒤 Re:Anime 회차를 연속 검증한다. 빌드된 `app.asar`의 실제 renderer·preload를 실행하고, IPC는 테스트 합성 응답으로 대체했다. 합성 MP4와 VTT는 격리 임시 폴더에서 생성했다.
- 1화의 로컬 12초 MP4 재생, `srclang=ko` 자막 트랙, `showing` 상태와 활성 한국어 cue가 확인됐다. 3.25초 위치가 27% 이력으로 저장됐고 새로고침 후 이어보기 카드에서 재생해 약 3.3초(실행별 3.26–3.27초)로 복구됐다.
- 반복 실행을 위해 `npm test`(전체 단위 테스트)와 `npm run test:phase1-electron`(패키지 UI 스모크)을 추가했다. 두 명령 모두 통과했고 전체 테스트는 219/219다. Electron 스모크는 검색 IPC 22회·`provider:resolve` 2회·렌더러 오류 0건·외부 요청 시도 0건이다. 사용자 프로필은 사용하지 않았다.
- **PASS — 패키지 renderer/preload 검색→상세→로컬 회차 재생→한국어 자막→새로고침 후 이어보기(합성 데이터)**. 이 스모크는 앱 main handler와 라이브 공급원 응답, 실제 영상·자막 매칭, 설치 NSIS 앱 및 기존 프로필을 검증하지 않는다. 테스트 코드만 바뀌어 이번에는 패키지를 다시 빌드하지 않았다.

## 2026-10-10 패키지 main-process IPC 스모크

- 반복 가능한 `npm run test:phase1-main`과 `tests/phase1-main.electron.cjs`를 추가했다. 빌드된 `dist/win-unpacked/resources/app.asar`의 main/preload 바이트가 현재 소스와 일치하는지 확인한 뒤 실제 패키지 main·preload와 앱 renderer를 격리 Electron 프로세스에서 연결한다.
- 테스트 전용 `userData`·`sessionData`를 사용한다. Node `fetch`·Electron `net.fetch`는 등록된 Re:Anime·VTT·loopback HLS fixture만 반환하고, 나머지 요청은 503으로 거부한다. Chromium 세션은 fixture용 loopback 외부 요청을 차단한다.
- 실제 `provider:catalog` 검색, `provider:detail` 메타데이터·회차 정규화, `provider:subtitle-tracks`의 한국어 VTT 트랙 파싱, 서버가 없는 회차의 `provider:resolve` 안내를 확인했다. 성공 경로에서는 FlixCloud 페이지를 HTTP loopback fixture로 리다이렉트하고 합성 HLS 요청을 관찰했다. main은 로컬 `127.0.0.1/__flix/...` 프록시 주소를 반환하고 한국어 VTT를 격리 `userData` 아래에 저장했다. 앱 프록시가 합성 HLS manifest를 가져와 segment 링크를 자체 loopback 경로로 다시 쓰고, 188바이트 합성 MPEG-TS 조각을 반환하는 것도 확인했다. 합성 네트워크 fixture 15회, loopback 페이지 리다이렉트 1회·브라우저 loopback 요청 2회·앱 프록시 요청 2회, 알 수 없는 fetch 0회, 차단된 외부 브라우저 요청 0회다.
- 외부 네트워크는 호출하지 않았다. 합성 segment를 실제 영상 요소에서 디코딩·재생하거나 실제 외부 segment를 가져오지는 않았다. 서버 없음 경로는 main IPC가 예상 오류를 reject하며 Electron이 오류 로그를 출력하지만 검증은 통과한다.
- 병렬 검증에서 기존 패키지 UI 스모크가 첫 자막 cue를 읽기 전에 playback이 다음 cue로 진행하는 타이밍을 한 번 드러냈다. 테스트가 재생을 멈추고 1.2초로 되돌려 첫 문장을 확인하도록 보강했다. 이후 전체 `npm test`와 UI 스모크를 병렬 재실행해 각각 통과했다.
- 전체 `npm test` 221/221과 기존 `npm run test:phase1-electron` 검색→합성 영상·한국어 자막→이어보기 스모크가 통과했다. 변경 JS 구문 검사와 `git diff --check`도 통과했다. 실제 공급원 응답·외부 스트림 재생과 자막 일치·설치 NSIS UI·사용자 프로필은 미검증이다. NSIS 설치 파일은 재빌드·설치·배포하지 않았으며, 기존 `app.asar` main/preload는 테스트 프로세스에서 실행했다.

## 2026-10-10 패키지 HLS 재생과 자막 자동 적용 검증

- `tests/phase1-main.electron.cjs`를 확장해 현재 소스와 패키지 `app.asar`의 renderer 파일 일치도 확인한다. FFmpeg로 4초짜리 합성 HLS/MPEG-TS를 만들고, 실제 패키지 main·preload·renderer의 `resolveIntoPlayer` 경로에서 영상과 Re:Anime 한국어 자막을 연결한다. AniSkip 응답은 빈 합성 fixture로 처리한다.
- `npm run test:phase1-main` 통과: Hls.js가 합성 segment를 실제 `<video>`에서 320×180으로 디코딩했고, 재생 1.02초에 `합성 한국어 자막` cue가 `showing` 상태였다. 50% 진행률이 reload 뒤 이어보기 카드에 남았고, 다시 재생했을 때 2.03초부터 같은 한국어 cue와 함께 복구됐다. main renderer는 앱 소유 HLS 프록시에서 초기 재생·이어보기 manifest와 segment를 요청했다. FlixCloud 페이지 요청 3회는 loopback으로 리다이렉트했고, 미등록 main fetch 0회·차단된 외부 browser 요청 0회였다. 테스트 전용 프로필과 media는 임시 폴더에서 사용·정리했다. 미재생 99화 오류 로그는 예상한 실패 경로다.
- 회귀 확인: `npm run test:phase1-electron` 통과(통합 검색·자막·이어보기, 27% 저장 및 3.27초 복구, renderer 오류 0회·외부 요청 0회); `npm test` 221/221 통과. 이는 합성 공급원/영상의 패키지 renderer 검증이며 실제 Re:Anime 콘텐츠, 실제 자막 일치, 설치 NSIS 앱과 사용자 프로필은 검증하지 않는다.
- 후속 복구 확인: 합성 RE:Anime episode에 같은 종류의 `HD-2`·`HD-1` 서버를 제공하고 패키지 Hls.js 인스턴스에 fatal 오류를 넣었다. 실제 main IPC가 `HD-1`로 재해석하고, 320×180 영상 디코드·선택한 한국어 자막 트랙·활성 cue·약 2.02초 위치를 복구했다. FlixCloud loopback redirect 4회, renderer 프록시 요청 6회, 미등록 fetch·차단된 브라우저 요청·외부 네트워크 호출은 각 0회다. `npm run test:phase1-main`, `npm run test:phase1-electron`, `npm test` 221/221 모두 통과했다. 공급원·영상·자막은 전부 합성 데이터다.

## 2026-10-10 패키지 홈 탐색 IPC 검증

- `tests/phase1-main.electron.cjs`에서 패키지 main/preload의 실제 IPC를 사용해 홈 탐색 핵심 경로를 추가 검증했다. RE:Anime 2026년 4분기는 main handler가 `season=FALL&year=2026`으로 요청하고 올바른 작품·분기 라벨을 반환했다. Miruro는 `FALL/2026` API 응답을 해독해 가용 회차 목록이 실제로 있는 작품만 반환했다. Animenosub은 `fall-2026` 페이지에서 Upcoming 카드를 제외했다. AniList 최신 방영은 RE:Anime·Miruro 후보 ID를 각각 분리하고 가용 회차 초과·미래 회차를 거른 뒤 각각 2화·3화를 선택했다. RE:Anime 두 번째 요청은 15분 캐시를 사용했고 미지원 Linkkf 최신 방영은 외부 호출을 하지 않았다.
- Linkkf 주간 방영표는 월요일~일요일 요청 7개를 실행했고, 합성 월요일 카드 1개와 나머지 빈 요일, 오류 없는 상태를 반환했다. `catalog:updates`는 Animenosub 업데이트 정렬 페이지에서 12화 작품과 다음 페이지 offset을 반환하고, 반복 호출은 main 캐시를 재사용했다. 애니24 `/ing` 응답에서는 13화 작품·상세 URL·완료 상태를 만들었다. Wikidata 제목 보강은 빈 합성 결과로 처리했다. 합성 fixture 59회, 미등록 fetch·차단된 브라우저 요청·외부 네트워크 호출은 0회다.
- `npm run test:phase1-main`, `npm run test:phase1-electron`, 전체 `npm test` 221/221, 테스트 파일 `node --check`가 통과했다. 이 결과는 main handler 연결·필터·캐시·요일 배열·분기 및 업데이트 파서를 합성 데이터로 확인한 것으로 실제 AniList/Re:Anime/Miruro/Linkkf/Animenosub/애니24 응답과 방영 정보 정확도는 검증하지 않는다.

## 주요 결정

- 새 앱은 Windows 우선, Android는 후속이다. Chrome·macOS는 제품 범위에서 제외한다.
- 새 저장소는 비공개로 둔다. 원본 라이선스와 출처별 이용 조건이 확인되기 전 공개 배포하지 않는다.
- 지원 공급원은 Linkkf, 애니24, Animenosub, RE:Anime, Miruro다. LinkAni는 제외한다.
- 첫 기능 검증은 검색·상세·회차·실제 재생·로컬 이어보기·한국어 자막·수동 싱크·다음 화 수동 시작이다.
- 자동 자막 싱크와 API 없는 ChatGPT 자동 번역은 미검증 목표다. 외부 API 자동 번역을 필수로 두지 않는다.
- 요구사항 28에 따라 다음 화 자동 재생을 끈다.

## 다음

1. FFmpeg는 아직 선택하지 않는다. BtbN의 8.1.3·9.0.2 LGPL shared 후보는 합성 remux/디코딩을 통과했지만 기존 FFmpeg 6.1.1보다 큰 배포 폴더와 미확인 소스·외부 고지가 남았다. 최소 호환 빌드에는 shell 기반 빌드 환경이 필요하지만 현재 Docker·WSL 배포판·Bash·Make가 없어 설치하지 않고 보류했다. 해결 전까지 현행 의존성 유지, 설치 파일 공개 보류를 계속한다.
2. JASSUB source commit 후보·다섯 submodule SHA를 확인했고, GPL-3.0 `rvfc-polyfill` fallback과 원격 Google Fonts fallback은 앱 빌드에서 제외한다. 2026-10-10 생성 worker에 Google Fonts 주소·목록이 없는지 확인하는 빌드 검사를 추가했다. 기본 font는 공식 Liberation Sans 2.00.5와 glyph·metrics를 대조했고 OFL notice를 unpacked Windows 앱의 `resources/licenses`에 넣어 원본 파일과 해시가 같은 것을 확인했다. 남은 항목은 pinned C/WASM source의 완전한 고지, upstream generator의 Expat 입력 불일치/실제 포함 여부, 번들에 남는 `abslink`·`throughput` 고지다. 이 환경에는 Docker/WSL 배포판, Bash, Make, `licensecheck`가 없어 upstream shell generator를 실행하지 않았다. 전체 재배포 조건은 미해결이다.
3. Aya Expanse GGUF는 설정의 Cohere 조건 링크와 다운로드 전 사용자 확인을 제공한다. 앱이 약관 열람·법적 동의나 자격을 검증하지는 않는다. `ja-ko-vn` GGUF와 기반 모델 두 저장소는 Apache-2.0을 선언하지만 학습 대화 자료 출처·권리는 확인하지 못했다. 임의 GGUF의 약관은 앱이 검사하지 않는다. 8개 preset 다운로드 pin은 적용됐으며 기존 모델 파일은 새로 검사하거나 교체하지 않는다. HY-MT1.5 1.8B·7B는 앱에서 차단했고 기존 사용자 파일을 보존한다.
4. 프로젝트 코드·로고·아이콘 재배포 허가와 AniList 보완성, TMDB·AI 기능 결합 조건을 해결하기 전까지 공개 저장소·설치 파일 배포와 실사이트 콘텐츠 요청은 보류한다. 권리 해결 후 검색→상세→회차 재생→자막→이어보기 실제 인수 검증을 계획한다. 그 전에는 합성·로컬 검증이 가능한 Phase 1 안정화 작업을 이어간다.

## 2026-10-10 홈 업데이트·분기 화면과 패키지 IPC 연결

- `tests/phase1-main.electron.cjs`에서 패키지의 실제 renderer 정렬 버튼을 눌러 Animenosub `최근 업데이트` 화면을 표시했다. `catalog:updates` 실제 main/preload IPC가 합성 업데이트 HTML을 처리했고 카드 제목 `합성 Animenosub 최신작`, `업로드 12화`, 업데이트 안내 문구와 선택된 정렬 상태를 확인했다.
- 같은 renderer에서 연도 선택을 2025년으로 바꾸고 4분기 카드가 나타나는 것, 이어 3분기 탭을 눌러 제목·선택 표시·카드가 변경되는 것을 확인했다. 두 분기 요청은 패키지 `provider:quarter` main IPC까지 도달했다.
- Re:Anime 최신 방영 줄은 실제 패키지 `provider:latest-episodes` IPC의 별도 합성 ID 응답을 받아 `EP.4` 카드와 상태 문구를 표시했다. Linkkf `loadLinkkfHome`은 현재 요일을 선택하고 `요일별 방영표`의 월요일 탭을 누르면 월요일 합성 카드로 전환됐다. 홈 탭 요청 7개가 패키지 `linkkf:schedule` handler를 통과했다.
- `npm run test:phase1-main` 통과: 합성 fixture 요청 72회, 미등록 fetch·차단된 브라우저 요청·외부 네트워크 0회. 전체 `npm test` 221/221과 `npm run test:phase1-electron`도 통과했고, 테스트 파일 구문 검사와 `git diff --check` 통과.
- 공급원 상태는 격리 renderer 테스트에서 Animenosub·RE:Anime·Linkkf로 설정했다. 실제 사이트 응답, 사용자 설정 전환/재시작, 설치 NSIS 화면은 확인하지 않았다.

## 2026-10-10 설정 공급원 전환과 재로딩 검증

- 패키지 설정의 `Animenosub` 버튼을 실제로 클릭해 공급원을 저장하고 600ms 뒤 renderer가 다시 로드되는 흐름을 확인했다. 재로드 후 `localStorage`, 설정 선택 상태, 앱 `state.source`가 모두 `animenosub`이며, 분기 홈에 합성 Animenosub 작품 카드가 나타났다.
- 새 공급원의 정규 목록 페이지와 sitemap 인덱스·sitemap, 진행 중 목록, 상세 페이지 및 현재 분기 응답을 main/preload IPC fixture로 제공했다. 격리 프로필만 사용했다.
- `npm run test:phase1-main` 통과: 합성 HTTP 요청 82회, 미등록 main fetch 0회, 차단된 브라우저 요청 0회, 외부 네트워크 0회. 기존 `npm run test:phase1-electron` 및 `npm test` 221/221도 통과했고 `node --check tests/phase1-main.electron.cjs`, `git diff --check`도 통과했다.
- 이 단계는 실제 공급원 버튼→저장→renderer 재로드→새 공급원 홈 연결을 합성 응답으로 확인했다. 이 renderer 재로드만으로는 앱 프로세스 재시작을 검증하지 못했다. 라이브 사이트 응답, 실제 재생 적합성, 설치 NSIS 화면도 검증하지 않았다.

## 2026-10-10 앱 프로세스 재시작 후 이어보기 복원

- `npm run test:phase1-source-restart`가 패키지 Electron 앱을 같은 임시 프로필로 두 번 실행한다. 첫 프로세스는 설정 버튼에서 Animenosub을 고른 뒤 Re:Anime 합성 영상을 2초(50%)까지 재생·일시정지해 진행률을 저장하고 종료했다. 두 번째 프로세스는 공급원 설정과 홈 카드를 복원한 뒤 이어보기 카드를 눌러 실제 패키지 main IPC로 다시 해석했다.
- 재실행 뒤 합성 HLS가 약 2.01초 위치에서 재생되고 한국어 VTT cue가 활성화됐다. seed/verify 각각 31회/20회 합성 HTTP 요청, 두 프로세스 모두 미등록 fetch 0·차단 브라우저 요청 0이었다. 앱 프로필은 임시 폴더에서 생성·삭제했고 기본 사용자 프로필은 사용하지 않았다.
- 이번 검증: `npm run test:phase1-source-restart`, 구문 검사와 `git diff --check` 통과. 실제 공급원/실영상, 커뮤니티 자막 매칭, 설치 NSIS UI는 검증하지 않았다.

## 2026-10-10 패키지 검색 UI에서 회차 재생까지

- `tests/phase1-main.electron.cjs`가 실제 패키지 renderer의 검색 입력과 검색 버튼을 눌러 Re:Anime 검색 결과를 만들고, 작품 카드→상세→1화 버튼으로 재생한다. 검색·상세·회차 해석은 패키지 preload와 main IPC를 통과하며, 한국어 제목·회차 버튼·`provider:resolve` 호출 증가를 확인한다.
- 재생 검증은 합성 320×180 HLS와 합성 한국어 VTT cue를 사용했다. 영상 디코드·cue 표시, 50% 이어보기 저장 후 약 2초 위치 복원, HD-2 오류 뒤 HD-1 대체 재생과 선택 자막 복구가 통과했다. 앱 프로세스·프로필은 격리했고 Kairan/Csora/Anissia 자동 검색은 이 경로에서 호출하지 않았다.
- 최종 `npm run test:phase1-main` 결과: 합성 HTTP fixture 89회, FlixCloud 요청 4회가 로컬 fixture로 리디렉션, 알 수 없는 fetch 0, 외부 브라우저 요청 0, 외부 네트워크 0. `npm run test:phase1-electron`, `npm test`(221/221), `node --check tests/phase1-main.electron.cjs`, `git diff --check`도 통과했다.
- 기능 코드는 바꾸지 않았고 `tests/phase1-main.electron.cjs`, `tests/phase1-source-restart.cjs`, `WORK_STATE.md`, `docs/FEATURE_GAP.md`만 수정했다. 실제 공급원 응답·작품/회차/영상판 일치·커뮤니티 자막 매칭·설치 NSIS UI는 여전히 미검증이다.

## 2026-10-10 JASSUB 원격 글꼴 fallback 차단

- 앱은 JASSUB `queryFonts: 'local'`로 Windows 시스템 글꼴과 자막에 동봉된 글꼴만 사용한다. 그런데 worker에는 사용되지 않는 Google Fonts 목록·원격 fallback 코드도 들어갈 수 있어, `lfa-ponyfill` import를 빈 결과를 반환하는 앱 소유 모듈로 alias하고 생성 worker에 Google Fonts URL 또는 `fonts.json`이 있으면 빌드를 실패시키도록 했다. JASSUB 옵션을 나중에 바꾸더라도 원격 글꼴 요청은 시작되지 않는다.
- `npm run vendor`와 Windows `npm run dist`가 성공했다. 패키지 `app.asar`의 worker는 생성된 소스와 바이트 단위로 일치하며 Google Fonts URL·목록 문자열이 없다. 격리 Electron JASSUB/WASM 스모크에서 Windows Malgun Gothic으로 한글 ASS 자막을 738개 밝은 픽셀로 렌더링했고 외부 HTTP(S) 요청 시도는 0회였다. 테스트 harness는 기존 `dist\\ass-renderer-smoke` 폴더를 건드리지 않게 고유 임시 디렉터리를 사용한다.
- `npm test` 221/221, `npm run test:phase1-electron`, `npm run test:phase1-main`, `npm run test:phase1-source-restart`, `node --check` 및 `git diff --check`가 통과했다. 통합 UI는 27% 진행률을 저장하고 3.27초로 이어졌으며, main-process smoke는 320×180 합성 HLS·한국어 cue와 50% 이어보기·HD-2 실패 후 HD-1 복구를 확인했다. 두 프로세스 재시작 후 Animenosub 설정, 50% 기록, 약 2.01초 재생 위치와 한국어 cue가 복구됐다.
- 변경한 JASSUB font fallback은 라이브러리 자체의 pinned C/WASM 고지, Expat 포함 여부, 번들에 남는 `abslink`·`throughput` 고지를 해결하지 않는다. 외부 공급원·실제 작품/회차/영상판 자막 매칭, 기존 사용자 프로필과 설치 NSIS 앱은 미검증이며 설치 파일은 실행·배포하지 않았다. 저장소 공개와 설치 파일 배포 보류를 유지한다.

## 2026-10-10 작품별 자막 출처 기억

- 플레이어에서 Re:Anime·Linkkf·Kairan·Csora·Anissia를 고르면 출처 우선순위를 현재 작품에 저장하고, 자동 자막 검색과 다운로드가 다음 회차부터 이를 먼저 사용한다. `subtitleSource` 설정은 전역 기본값으로 남겨 다른 작품에 적용한다. 작품별 초기화는 출처 필드만 지워 기존 Jimaku·AI 선택과 다른 작품 설정을 보존한다.
- 한국어 자막 제안에서 사용자가 `바꾸기`를 누르거나 Re:Anime 트랙을 직접 고른 경우도 해당 작품의 출처 선택으로 기록한다. 재생 화면에 현재 작품 출처 또는 전역 기본값을 표시하고 `이 작품은 기본 출처 사용`으로 되돌릴 수 있다.
- `npm test` 225/225, `npm run test:phase1-electron`, `npm run test:phase1-main`, `npm run test:phase1-source-restart`, 구문 검사와 `git diff --check`가 통과했다. Windows `npm run dist`도 성공했고, `app.asar`에서 상태 표시·초기화 UI·출처 helper가 포함됨을 확인했다.
- 검증은 자동 테스트 및 격리 합성 fixture다. 실제 공급원 응답·자막 작품/회차/영상판 매칭·기존 프로필의 저장 상태는 확인하지 않았다. 설치 파일은 로컬 빌드만 했으며 실행·배포하지 않았다.

## 2026-10-10 작품별 자막 출처 패키지 재시작 확인

- `npm run test:phase1-source-restart`의 격리 패키지 앱에서 Re:Anime 자막 출처 버튼을 실제로 눌렀다. 작품별 출처가 저장되고 재생 화면에 `이 작품 출처: Re:Anime`와 초기화 버튼이 나타났으며 전역 `subtitleSource` 기본값은 바뀌지 않았다.
- 프로세스를 완전히 종료하고 같은 임시 프로필로 다시 열었을 때 작품별 출처와 50% 시청 기록이 복원됐다. 이어보기 후 320×180 합성 영상이 약 2.01초에서 재생되고 `합성 한국어 자막` cue가 표시됐다. 초기화 버튼을 눌러 `설정 기본값: 자동`으로 돌아가고 버튼이 비활성화되는 것도 확인했다.
- seed/verify 합성 HTTP 요청은 32회/20회였고 두 실행 모두 미등록 fetch 0, 차단된 브라우저 요청 0이었다. 전체 `npm test` 225/225, `npm run test:phase1-electron`, `npm run test:phase1-main`, `npm run test:phase1-source-restart`가 통과했다.
- 검증은 테스트 전용 패키지와 임시 사용자 프로필, 합성 영상·자막이다. 실제 자막 공급원 매칭, 설치된 사용자 앱·프로필, 권리 조건은 확인하지 않았다. 설치 파일은 로컬 빌드만 했으며 배포하지 않았다.

## 2026-10-10 Kairan·Csora·Anissia 출처 버튼 IPC 확인

- `tests/phase1-main.electron.cjs`가 격리 패키지 플레이어에서 Kairan·Csora·Anissia 버튼을 각각 눌러 renderer→preload→main `subtitle:find` 경로를 탔다. 합성 Blogger 피드와 Anissia 작품 검색·제작자 API, 제작자 블로그, 합성 VTT 파일을 fixture로 제공했다.
- 각 출처에서 파일을 임시 프로필 아래 저장하고 해당 회차의 `있음` 상태, 출처별 자막 이름, 플레이어 활성 한국어 cue까지 확인했다. seed 45회·verify 18회의 합성 HTTP 요청에서 미등록 fetch와 차단된 브라우저 요청은 모두 0회였다.
- 두 번째 Electron 프로세스에서 기존 Re:Anime 작품별 출처와 50% 시청 기록을 복원하고 합성 영상 약 2.01초·한국어 cue를 확인했다. 기록 저장은 테스트가 수동 `timeupdate`를 보내므로 `saveHistorySoon()`을 명시 호출해 50%가 저장됐는지도 확인한다.
- `npm run test:phase1-source-restart` 통과. 이 검증은 실제 앱 renderer/preload/main과 격리 fixture를 사용하며 실제 Kairan/Csora/Anissia 사이트, 자막 작품·회차·영상판 일치, 권리 조건, 설치 NSIS 앱은 검증하지 않았다.
- 회귀 확인: `npm test` 225/225, `npm run test:phase1-electron`, `npm run test:phase1-main`(합성 HTTP fixture 89회, 미등록 fetch·외부 브라우저 요청 0), `node --check tests/phase1-main.electron.cjs`, `git diff --check` 통과.
- 원격 `dinoforge/anime-player`는 비공개 저장소다. 활성 `Build` workflow는 `v*` 태그와 수동 실행만 받는 릴리스 workflow이므로 `main` push에서 실행되지 않는다. 이 release workflow는 비활성화하거나 수정하지 않았다.

## 2026-10-10 Anissia API 권리 문서 확인

- Anissia 공식 README와 편성표 API 문서를 확인했다. API 문서는 편성·회차 자막 endpoint, 회차·등록일·외부 웹사이트·제작자 필드를 정의하고 브라우저 직접 JavaScript 요청을 권장한다. `captionCount`는 약 5분 캐시로 실시간 자막 정보와 다를 수 있어 사용 비권장이라고 적혀 있다.
- 기술적 CORS/API 접근 안내는 API, 자막 파일의 저장·번역·재배포 권리를 부여하는 문구가 아니다. 공개 문서에서 그런 사용 허가를 찾지 못했고 제작자 블로그별 파일 권리도 미확인이다. 앱은 회차 자막 항목을 조회하며 캐시된 `captionCount`로 존재 여부를 정하지 않는다.
- `docs/RIGHTS_REVIEW.md`에 공식 출처와 확인 범위를 추가했다. 실제 API·자막 파일 요청, 코드 변경, 사용자 데이터 접근은 하지 않았다. 비공개 개발·미배포와 GitHub push 보류를 유지한다.

## 2026-10-10 Kairan·Csora 공개 안내 확인

- 두 Blogger 원문을 브라우저에서 읽었다. Kairan 공개 회차 글은 Google Drive 링크와 제작자가 작업을 언제든 멈출 수 있다는 설명을 포함한다. Csora 프로필은 자막 수익화와 사칭을 하지 말라고 요청하고, 공개 회차 글은 자막·폰트 링크를 제공한다.
- 공개 링크와 개인 시청자 공유 의사는 앱의 자동 수집·저장·변환·재배포 허가가 아니다. 외부 Drive 파일이나 실제 자막은 열거나 내려받지 않았다. `docs/RIGHTS_REVIEW.md`에 출처별 문구와 한계를 기록했다.
- 브라우저 CLI 런타임은 의존성 누락으로 시작되지 않았으나 Codex 브라우저를 통해 두 사이트를 읽었다. 이 내용은 공개 안내의 확인 범위를 기록하며 이용 허가 판정을 추가하지 않는다.

## 2026-10-10 비공개 main push 확인

- Push 전 `gh repo view`로 `dinoforge/anime-player`가 private이고 기본 브랜치가 `main`임을 확인했다. 활성 workflow는 `Build` 하나이며 `v*` 태그 push·수동 실행에만 반응한다. 일반 `main` push에는 실행되는 CI가 없고 릴리스 workflow도 변경하지 않았다.
- `8a6f5e2`, `a69e9f9`, `b603163` 세 커밋의 outgoing diff와 추가된 텍스트를 검토했다. 의도된 테스트·권리 문서·상태 문서만 포함됐고 일반적인 자격 증명 패턴은 발견되지 않았다. `git diff --check`가 통과했다.
- `git push origin main` 성공 후 원격 `main`과 로컬 HEAD가 모두 `b603163e50b5055caf17f5cafe00baac6135f142`임을 확인했다. `gh run list --branch main`은 빈 목록을 반환했다. 현재 작업 트리는 깨끗하다. 태그 생성·설치 파일 배포·공개 저장소 전환은 하지 않았다.

## 2026-10-10 최신 LilacAnime 원본 재확인

- 현재 `upstream/main`은 `4550d61725a8b57e6e890e97bd0f25244a8cf164`이고 `v0.5.9` peeled tag도 같은 커밋이다. 원격 태그 목록에 이후 버전은 없으며 프로젝트 `package.json`도 `0.5.9`다.
- v0.5.9에서 선별한 동작을 현재 코드와 테스트 위치에서 다시 확인했다. TMDB 실패는 완료 조회로 저장하지 않고 30분 뒤 다시 시도한다. 회귀 테스트는 timeout/HTTP/JSON 오류 뒤 예약 타이머를 실행해 서비스 복구 후 인덱스가 `ready`가 되는 것까지 확인한다. WebVTT 중앙 정렬과 재생 중 마우스 길게 누르기 2배속 경로도 현재 코드에 있다. 새 원본 버전이나 추가로 반영할 변경은 이번 확인에서 발견하지 못했다.
- 이는 원본의 전체 코드·권리 재검토나 실제 영상/자막 테스트 완료를 뜻하지 않는다. 외부 서비스와 권리 검토 전에는 공개 배포를 보류한다.

## 2026-10-10 Phase 1 회귀 스위트 재실행

- `npm test` 225/225 및 `node --test tests/catalog-title-retry.test.cjs` 9/9 통과. 패키지 renderer 통합 스모크, main/preload/renderer 스모크, Electron 프로세스 재시작, 자막 배치 검증도 모두 통과했다.
- 패키지 UI는 검색→상세→회차→합성 영상·한국어 VTT→27% 이어보기(3.26초), 오류 진단 복사 흐름을 확인했다. main 경로에서는 합성 HLS 320×180 재생, 50% 기록의 약 2.01초 복구, HD-2 오류 뒤 HD-1 대체 재생·자막 유지가 확인됐다. 별도 프로세스 재시작 후 공급원·작품별 자막 출처·50% 이어보기와 한국어 cue가 복원됐다.
- 자막 레이아웃 7개 배치(1080p·4K 배율·상단 자막·좁은 창·4:3 영상)의 중심 정렬이 확인됐다. main fixture 외 네트워크 요청과 자막 레이아웃 검사의 외부 HTTP(S) 시도는 0회였다. `git diff --check` 통과.
- 이번 실행은 테스트 전용 프로필과 합성 데이터다. 실제 공급원 작품·회차·영상판·자막 매칭, 실제 사용자 프로필, 설치 NSIS 앱, 출처별 이용 권한은 검증하지 않았다. 애플리케이션 코드는 변경하지 않았다.

## 2026-10-10 원본 저장소 라이선스 재확인

- GitHub API의 `license.spdx_id`는 `whispelyn-byte/LilacAnime-desktop`과 `dream150/LilacAnime` 모두 `null`이다. 데스크톱 v0.5.9 `upstream/main` 트리 및 Android 원본 루트 파일 목록에서 `LICENSE`·`COPYING`·`NOTICE`를 찾지 못했다.
- 데스크톱 업스트림 README의 원작자 허락 주장은 확인했으나, 허락 문서와 이 파생 앱에 적용되는 범위는 공개 근거로 검증되지 않았다. 설치 파일 배포와 공개 전환은 계속 보류하고, 실제 공급원 콘텐츠 요청은 하지 않았다.

## 2026-10-10 패키지 오류 진단 복사 IPC 검증

- `tests/phase1-main.electron.cjs`의 격리 Electron 프로세스에서 `clipboard.writeText`만 테스트 수신기로 대체했다. 실제 시스템 클립보드에 쓰지 않고 빌드된 `app.asar`의 main·preload·renderer 연결을 유지했다.
- 패키지 renderer에서 실제 앱 정보 IPC를 호출하고 7개 합성 오류로 만든 진단 보고서를 실제 `window.lilac.copyText`→`clipboard:copy-text` main IPC에 전달했다. 허용된 최근 5건만 남고 작품명·전체 URL·토큰·쿠키는 제외됐으며 테스트 수신기는 보고서만 받았다. 이어 실제 `오류 정보 복사` 버튼을 눌러 같은 IPC와 `오류 정보가 복사됐어요` 성공 안내를 확인했다. 빈 문자열과 2MB 초과 입력은 거부되고 수신기에 기록되지 않았다.
- `npm run test:phase1-main`과 `npm run test:phase1-source-restart` 통과. main 스모크는 합성 HTTP fixture 89회, 등록되지 않은 fetch·차단된 브라우저 요청·외부 네트워크 호출 0회였다. `node --check tests/phase1-main.electron.cjs` 및 `git diff --check` 통과. 시스템 클립보드와 설치 NSIS UI는 검증하지 않았다.

## 2026-10-10 PIP 종료 리소스 정리

- `src/player.js`에서 PIP 종료 또는 열기 실패 때 숨은 합성 영상도 명시적으로 일시 정지한다. 기존 캡처 트랙 종료, `srcObject` 해제, 30fps 타이머 정지와 미니플레이어 버튼 상태 초기화는 그대로 유지한다.
- `togglePictureInPicture`의 스트림 생성과 capability 확인을 예외 처리 안으로 옮겼다. Canvas 캡처 또는 브라우저 PIP API가 없는 경우 한국어 안내를 보이고 부분 생성된 타이머·캡처·숨은 영상을 정리한다.
- `tests/player-interactions.test.cjs`에서 실제 미니플레이어 버튼 바인딩을 통해 디코드 전 안내, 영상 프레임·한국어 VTT cue 합성, PIP 재생/일시정지 동기화, 닫기, 요청 실패와 API 미지원 경로를 확인했다. 종료 경로는 숨은 영상 정지·캡처 트랙 해제·타이머 정리를 검증한다.
- 전체 `npm test` 228/228 및 상호작용 파일 37/37 통과. `npm run dist`로 Windows NSIS를 재빌드하고 새 패키지에서 `npm run test:phase1-electron`과 `npm run test:phase1-main`이 통과했다. main 스모크는 합성 HTTP fixture 89회, 미등록 fetch·차단 브라우저 요청·외부 네트워크 호출 0회다.
- `npm run test:phase1-pip-native`는 격리 Electron 38.8.6 Windows 창에서 640×360 캔버스 영상을 CDP 사용자 클릭으로 네이티브 PIP에 진입·종료했다. 닫기 이벤트 뒤 트랙 종료·숨은 영상 정지·스트림 해제를 확인했고 외부 HTTP(S) 요청은 0회였다. 실행기는 Electron이 종료된 뒤에만 자체 임시 프로필을 지우도록 해 Windows 잠금 파일이 남지 않게 한다.
- `npm run test:phase1-pip-app`는 빌드된 앱 `app.asar`의 실제 미니플레이어 버튼을 CDP 사용자 클릭으로 실행했다. 합성 HLS와 한국어 VTT가 재생되는 동안 320×180 캡처 스트림의 네이티브 PIP 진입·닫기를 확인하고 버튼 초기화·숨은 영상 정지·`srcObject` 해제·모든 트랙 종료를 검증했다. 합성 HTTP fixture 89회, 미등록 fetch·차단된 브라우저 요청·외부 네트워크 호출 0회였다.
- `tests/run-phase1-main.cjs`가 임시 프로필을 만들고 Electron 하위 프로세스가 완전히 닫힌 뒤 전용 폴더만 지우도록 바꿨다. 기존 `lilac-phase1-main-*` 임시 디렉터리 52개는 내용과 경로를 확인하고 정리했으며, 일반 main 스모크와 앱 PIP 스모크 뒤에도 폴더가 남지 않음을 확인했다.
- 전체 `npm test`, `npm run test:phase1-main`, `npm run test:phase1-pip-app`, `npm run test:phase1-source-restart`가 통과했다. 재시작 테스트에서 공급원/회차별 자막 선택·기본값 초기화·50% 이어보기와 한국어 cue 복원을 다시 확인했다.
- 설치 NSIS 앱과 실제 사용자 프로필은 실행하지 않았다. 빌드 파일은 로컬 테스트 산출물이며 설치·배포하지 않았다.

## 2026-10-10 실제 Windows 실행 파일 시작 스모크

- `npm run test:phase1-exe`는 `dist/win-unpacked/LilacAnime.exe`를 직접 실행해 실제 `app.asar`의 `src/index.html`을 열었다. 별도 임시 `APPDATA`, `LOCALAPPDATA`, Chromium userData, TEMP를 사용하고 Chromium 외부 DNS 해석을 차단했다.
- 실제 창에서 홈·검색 DOM, 검색 입력/버튼, preload `window.lilac` bridge와 `appDiagnosticInfo()` IPC를 확인했다. 응답 버전은 0.5.9, 플랫폼은 win32/x64였다. CDP를 loopback에만 열고 앱 종료 후 테스트 프로필을 제거했다.
- 실행 파일은 정상 종료했고 임시 프로필 경로가 사라진 것을 확인했다. 기존 설치 앱·사용자 프로필·NSIS 설치 화면 및 실제 공급원·영상·자막 요청은 검증하지 않았다.

## 2026-10-10 최신 원본 v0.5.10 선택 반영 및 패키지 재검증

- `upstream/main`의 `f38763949d9e8b3be2284bf97207a960bd642443`(v0.5.10)을 다시 비교하고 검색·자막에 직접 필요한 변경만 현재 파생 코드에 맞춰 적용했다. 트레이/창 상태와 대규모 다운로드 전송·재개 수명주기는 Phase 1 핵심 경로 밖이라 보류했다. 앱 package 버전은 0.5.9이며 새 릴리스 버전으로 올리지 않았다.
- `electron/community-matching.cjs`의 회차 판별과 `electron/main.cjs` 연결을 추가했다. 시즌·소수 회차, 범위 파일, 검증된 AniList 누적 회차 오프셋, 잘못된 첨부 뒤 최대 5개 게시물 시도와 한 번의 강제 새로고침, 고유 임시 폴더, 원래 파일명 보존을 처리한다. 다른 회차 번호가 섞인 경우 무번호 자막을 대체로 고르지 않는다. ASS/SSA 선택 때 같은 작업에서 받은 폰트 파일을 보존한다.
- `electron/tmdb-client.cjs`를 추가하고 전체 TMDB 요청에서 최소 150ms 간격·공유 429 Retry-After 대기·408/429/5xx/전송/JSON 재시도·오류 메시지 키 제거를 적용했다. 설정 화면은 인증·요청 제한·연결·응답·HTTP 실패와 재시도 시각을 구분한다. 공유 요청 간격과 장시간 429 대기도 합성 시계/응답으로 검증했다.
- `npm test` 241/241, `node --check` 대상 파일과 `git diff --check`가 통과했다. 커뮤니티 매칭/다운로드 격리 및 재시도, TMDB 요청 클라이언트와 카탈로그 복구 테스트를 포함한다.
- `npm run test:phase1-electron` 통과(검색·상세·회차·합성 VTT 재생, 27% 이어보기 3.27초, renderer 오류·차단 외부 요청 0). `npm run dist` Windows NSIS 빌드 성공. 새 `app.asar`로 `npm run test:phase1-main` 통과(합성 HTTP fixture 89회, 외부 네트워크 0), `npm run test:phase1-exe` 통과(실제 win32/x64 EXE의 홈·검색·preload·앱 정보 IPC), `npm run test:phase1-source-restart` 통과(공급원·작품별 자막 출처·50% 진행률·한국어 cue 복구).
- 모든 실행은 테스트 전용 프로필과 합성 공급원·미디어를 썼다. 실제 Blogger/TMDB 결과, 공급원 콘텐츠의 작품·회차·영상판 일치, 권리 범위, 설치된 NSIS 앱과 기존 사용자 프로필은 검증하지 않았다. 빌드 산출물은 로컬에만 두고 배포하지 않는다.

## 2026-10-10 이어보기 95% 경계

- `tests/resume-choice.test.cjs`에 94.99%와 정확히 95%의 사용자 선택 경계를 추가했다. 95% 미만은 이어보기가 기본이고, 95%부터는 처음부터 시작하되 사용자가 원하면 저장 위치에서 계속할 수 있음을 확인한다.
- Phase 1 계획의 `playerAutoPlay` 설정·마이그레이션 문구를 실제 코드에 맞췄다. 별도 자동 다음 화 설정은 없고 `handleEpisodeEnded`는 다음 화 직접 선택 안내만 표시한다. 기존 프로필 설정을 변경하지 않는다.
- `tests/windows-package-startup.cjs`를 확장해 실제 `dist/win-unpacked/LilacAnime.exe`의 번들 renderer에서 95% 경계 버튼 라벨·대체 버튼 클릭·저장 위치 이어가기 인자를 확인했다. 임시 사용자·앱 데이터 경로와 외부 DNS 차단을 사용했다. 기존 설치 NSIS 앱은 실행하지 않았다.
- `npm test` 242/242, `npm run test:phase1-exe`, `git diff --check` 통과. 앱 런타임 코드는 변경하지 않아 NSIS 패키지를 다시 빌드하지 않았다.

## 2026-10-10 설치 파일 권리 게이트

- 현재 `Build` workflow는 `v*` 태그와 수동 실행에 반응해 세 플랫폼 설치 파일 산출물을 만들고, 태그 실행에서는 Release에 올리는 구성이다. GitHub 저장소는 비공개이고 Releases 목록은 비어 있으며 저장소 Actions 변수도 설정돼 있지 않다.
- 권리 검토 전 잘못된 태그가 올라가도 파일이 생성·업로드되지 않도록 `.github/workflows/build.yml`의 `build`와 `release` 두 job에 `LILAC_RELEASE_RIGHTS_APPROVED == 'true'` 조건을 추가했다. 변수는 만들거나 설정하지 않았고, 기존 Release 워크플로 파일·태그·수동 실행 트리거는 보존한다.
- `node --test tests/release-rights-gate.test.cjs` 1/1, 전체 `npm test` 243/243, `git diff --check`, js-yaml 구문 검사 통과. `e740feb` push 후 `gh workflow view Build --yaml`이 새 조건을 포함해 반환됐고 워크플로는 `active` 상태다. `gh run list --branch main`은 빈 목록이며, 해당 검증 시점의 원격/로컬 HEAD가 일치했다.
- 저장소는 private, Releases 목록과 Actions 변수 목록은 비어 있다. 이 gate는 설치 파일 생성·배포를 막는 설정이며 권리 확인을 완료한 것은 아니다.

## 2026-10-10 AniList·TMDB 약관 재확인

- AniList 공식 약관을 다시 열어 비상업적 이용과 대량 수집·비보완적 동종 서비스 제한을 확인했다. 작품 목록·시청 기록을 제공하는 이 앱의 선택 작품 방영 정보 조회가 허용 범위인지는 여전히 미확인이다.
- TMDB 공식 약관은 검색으로 관련 제한을 확인했지만, 직접 페이지 열기는 robots 정책에 막혔다. AI 기반 애플리케이션과의 연결 제한을 현재 앱에 적용할지 문서만으로 확정할 수 없어 서면 확인 전 배포 보류를 유지한다.
- `docs/RIGHTS_REVIEW.md`에 근거와 확인 한계를 기록했다. API 요청, 실제 콘텐츠 요청, 권리자 연락은 하지 않았다. 설치 생성·배포 게이트 변수는 계속 미설정이다.

## 2026-10-10 패키지 회차 종료 동작

- `tests/windows-package-startup.cjs`가 실제 `LilacAnime.exe`의 `app.asar` renderer에서 합성 시청 기록으로 `handleEpisodeEnded()`를 호출하도록 확장했다. 완료 진행률이 100%로 저장되고, 다음 회차가 있어도 안내만 보이며 자동 재생 함수는 호출되지 않는지 확인한다.
- `npm run test:phase1-exe`와 `npm test` 243/243, `git diff --check`가 통과했다. 실제 영상·회차 공급원은 쓰지 않았으며 테스트 전용 프로필과 합성 다음 회차를 사용했다.
- `docs/FEATURE_GAP.md`의 재생 항목 9에도 이 패키지 검증을 반영하고, 실제 HLS 복구·설치 NSIS 오류 화면·실제 공급원 검증은 미완료로 유지했다.

## 2026-10-10 패키지 상세 화면 이어보기 선택

- `tests/integrated-search.electron.cjs`의 격리 패키지 앱 스모크에 실제 상세 화면 경로를 추가했다. 96% 시청 기록을 저장·재로드하고 Re:Anime 작품 상세를 연 뒤 기본 `1화 처음부터`와 보조 `1화 이어보기`가 표시되는지, 보조 버튼을 누르면 12초 합성 영상의 11.50초에서 재생을 재개하는지 확인한다.
- `npm run test:phase1-electron`, `node --check tests/integrated-search.electron.cjs` 통과. 통합 검색 24회, resolve 3회, 기존 이어보기 27% 기록이 3.27초로 복구됐다. 렌더러 오류와 외부 HTTP(S) 차단 요청은 각각 0회였다.
- 이 스모크는 패키지 앱·임시 프로필·합성 공급원 IPC·로컬 MP4/VTT를 쓴다. 실제 공급원 회차·영상·자막 매칭, 설치 NSIS 실행, 기존 사용자 프로필은 검증하지 않았다.

## 2026-10-10 공식 공급원·API 권리 최신 페이지 재확인

- 공식 AniList API 문서의 현재 주소에서 대량 수집과 비보완적 애니 목록/추적 서비스 제한을 재확인했다. 이 앱의 작품 목록·시청 기록과 AniList 방영 정보 조회가 허용되는지 판단할 앱별 확인은 없다.
- TMDB 개발자 FAQ를 직접 열어 비상업 사용의 크레딧·로고·고지 요건을 확인했다. TMDB API 약관은 직접 페이지 열기가 robots 정책으로 막혔지만 검색 가능한 공식 본문은 AI/ML 기반 애플리케이션 관련 제한을 포함한다. 앱에서 TMDB 메타데이터와 선택형 AI 번역을 함께 제공하는 것이 허용되는지는 미확인이다.
- Re:Anime 홈페이지의 현재 소개는 스트리밍 서비스임을 보여 주지만 앱 연동·자동 조회·캐시·재배포 허가를 증명하지 않는다. `docs/RIGHTS_REVIEW.md`에 공식 링크와 확인 한계를 기록했다. API 호출·실제 영상/자막 요청·파일 다운로드·권리자 연락은 하지 않았고, 비공개 저장소·미배포 및 설치 파일 권리 게이트를 유지한다.

## 2026-10-10 창 종료 시 이어보기 위치 저장

- `src/app.js`의 재생 기록 저장 직전에 현재 영상 시각으로 진행률을 다시 계산하고, Electron 창 종료(`beforeunload`)와 문서 이탈(`pagehide`) 때 현재 회차 기록을 즉시 저장한다. 재생 중이 아닌 페이지 종료에서는 오래된 메모리 기록을 덮어쓰지 않는다.
- `tests/integrated-search.electron.cjs`가 패키지 앱의 실제 격리 `BrowserWindow`를 닫고 같은 임시 프로필로 다시 열어 복구를 확인한다. 영상 위치 6.25/12초와 메모리·디스크의 오래된 96% 기록을 준비한 뒤, 종료 후 52%가 저장되는 것을 검증했다.
- `npm run pack`, `npm run test:phase1-electron`, `npm test` 243/243, `npm run test:phase1-exe`, `npm run test:phase1-source-restart`, `node --check src/app.js`, `node --check tests/integrated-search.electron.cjs`, `git diff --check` 통과. 통합 스모크는 검색 IPC 25회·회차 resolve 3회, renderer 오류 0회, 차단된 외부 요청 0회였다. Windows 실행 파일 시작 확인과 별도 Electron 프로세스 재시작 후 공급원·작품별 자막 선택·50% 이어보기·한국어 cue 복구도 통과했다.
- 빌드는 로컬 unpacked 앱으로만 만들었고 설치 파일을 실행하지 않았다. 합성 MP4/VTT와 임시 프로필만 사용했으며, 실제 공급원 재생·자막 일치와 기존 사용자 프로필은 미검증이다. 최신 원본은 `upstream/main` v0.5.10 (`f38763949d9e8b3be2284bf97207a960bd642443`)으로 확인했다.

## 2026-10-10 임시 NSIS 설치·실행 검증

- 고유 앱 ID·제품명과 바로가기 비활성화를 적용한 테스트 전용 NSIS를 `%TEMP%` 아래 별도 폴더에 설치했다. 실행 프로필·`APPDATA`·`LOCALAPPDATA`도 임시 경로를 사용해 기존 앱 프로필을 열지 않았다.
- 테스트 빌드에서 Node `fetch`와 Electron `net.fetch`를 차단하고 Chromium 외부 DNS를 막았다. `reanime.to` 3회, `api.jikan.moe` 2회의 차단을 기록했으며 실제 응답·영상·자막은 받지 않았다.
- 설치된 `LilacAnime.exe`의 실제 `app.asar`로 홈·검색 UI, preload bridge, 앱 정보 IPC(0.5.9, win32/x64), 이어보기 94.99%/95% 경계, 회차 종료 시 진행률 100% 저장과 수동 다음 화 안내를 확인했다. 임시 설치본 시작 스모크가 정상 종료했다.
- 전용 제거 프로그램으로 테스트 설치를 지웠다. 테스트 HKCU 등록은 사라졌고 기존 전체 사용자 설치 등록 및 ProgramData 시작 메뉴·공용 바탕화면 바로가기 해시는 유지됐다. 임시 진단 폴더는 검사 후 Recycle Bin으로 이동했다.
- 테스트 전용 코드·식별자를 원복하고 표준 설정으로 `npm run dist`를 다시 성공시켰다. 현재 로컬 NSIS 파일은 124,549,154바이트다. 실제 공급원·콘텐츠, 기존 사용자 프로필, 이용 권한은 미검증이다.

## 2026-10-10 반복 재생 자막 상태 수정

- 같은 작품·회차·선호 출처의 온라인 자막 검색을 반복 재생에서 재사용할 때, 결과 콜백이 오래된 `playbackRequestId`를 붙잡아 Kairan·Csora·Anissia 상태 표시가 `확인 중`에 남을 수 있었다. 재사용된 검색 상태에 현재 요청 ID를 연결하고, 캐시된 상태와 늦게 완료된 출처 결과를 현재 재생 상태에 적용하도록 수정했다. 기존 검색 promise와 네트워크 요청 수는 그대로 재사용한다.
- `tests/subtitle-availability.test.cjs`에 진행 중 요청 재사용·완료 캐시 재사용·상태 복원·중복 요청 방지 회귀 테스트를 추가했다. 대상 테스트와 전체 `npm test` 244/244 통과.
- `node --check src/app.js`, `node --check tests/subtitle-availability.test.cjs`, `git diff --check` 통과. `npm run dist`로 현재 소스의 NSIS를 재빌드했고, `npm run test:phase1-electron` 및 `npm run test:phase1-main` 통과했다. main 패키지 스모크는 합성 HTTP fixture 89회, 등록되지 않은 fetch·차단된 브라우저 요청·외부 네트워크 호출 각각 0회였다.
- `tests/windows-package-startup.cjs`에 `LILAC_PHASE1_EXE_PATH` 입력을 추가해 unpacked 실행 파일뿐 아니라 설치된 실행 파일도 같은 검증기로 확인할 수 있게 했다. 기본 경로 실행은 `npm run test:phase1-exe`에서 계속 통과한다.
- 별도 앱 ID·제품명·무바로가기 설정과 임시 설치·프로필을 사용해 현재 수정본으로 NSIS를 설치했다. 홈·검색 UI, preload, 앱 정보 IPC, 이어보기 경계와 회차 종료 동작이 통과했고 외부 main-process 요청 6건을 차단했다. 무인 제거 뒤 전용 등록은 사라졌고 기존 `LilacAnime 0.5.9` machine-wide 등록이 남았다. 임시 프로필과 설치 폴더는 정리했다.
- 테스트 전용 네트워크 guard·앱 식별자·설치 옵션을 원복해 표준 설정으로 `npm run dist`를 성공시켰다. 최종 확인: `npm test` 244/244, `npm run test:phase1-electron`, `npm run test:phase1-main`, `npm run test:phase1-exe`, 구문 검사와 `git diff --check` 통과. main smoke는 fixture 89회, 외부 네트워크 호출 0회다.
- 실제 공급원 자막 응답·정확한 작품/회차/영상판 일치와 이용 권한은 미검증이다. 설치 파일은 로컬에만 두며 배포하지 않는다. 다음은 문서와 outgoing diff를 검토한 뒤 관련 소스·테스트·문서만 커밋·push하는 것이다.

## 2026-10-10 회차 전환 중 자막 검색 재사용 및 최신 원본 비교

- 직전 단일 전역 검색 슬롯은 A회 검색 중 B회로 이동한 뒤 A회로 돌아오면 A회의 세 provider 조회를 다시 실행했다. `onlineSubtitleSearches`를 작품·제목·회차·선호 출처별 Map으로 바꾸고 최근 64개 key까지만 보관한다. 검색 재사용 시 활성 `playbackRequestId`와 회차별 provider 상태를 갱신한다. 미발견 검색은 캐시에서 빼 다음 재생에 재시도한다.
- 회귀 테스트에서 A→B→A 전환 후 조회 6회만 실행되고 각 회차의 Kairan/Csora/Anissia 상태가 분리되는 것을 확인했다. 미발견 뒤 재생 시 새 provider batch가 생기는 것도 확인했다.
- `upstream/main`은 기록된 v0.5.10(`f387639`)에서 `f2ee438`로 진행했다. 원본은 수동 source chip과 Anissia 제작자 검색에 `subtitleSearchId`를 추가해 이전 응답을 억제한다. 현재 파생 코드는 두 경로 모두 `beginSubtitleSelection()`/`subtitleSelectionRequestId`로 이미 이를 막는다. 기존 source-chip 경합 테스트와 추가한 Anissia 제작자 A→B 지연 응답 테스트로 확인했으며 원본의 중복 상태 변수를 이식하지 않았다.
- 대상 테스트 13/13, 플레이어 상호작용 38/38, 전체 `npm test` 247/247 통과. `npm run dist` 및 패키지 renderer/main/EXE/프로세스 재시작 스모크 통과. main fixture 89회, 미등록 fetch·차단 browser 요청·외부 네트워크 호출 각각 0회.
- 이 변경 이후 별도 임시 NSIS 설치는 하지 않았다. 표준 NSIS는 빌드했으며 로컬에만 둔다. 실공급원 자막 검색·작품/회차/영상판 일치와 이용 권한은 계속 미확인이다. 다음은 이 변경의 diff와 저장소 상태를 검토한 뒤 source/test/docs만 커밋·push하는 것이다.

## 2026-10-10 자막 회차 전환 캐시 변경 후 NSIS 설치 검증

- `f3a7f95446a612ea956a7fbe64fcf1bf06d0f158`의 깨끗한 소스 복사본에서 고유 앱 ID·제품명, 바로가기 비활성화, per-user 설정을 적용해 별도 NSIS(124,546,483바이트)를 만들었다. 설치 대상은 `%TEMP%` 아래 전용 폴더였고 기존 앱 데이터 경로는 사용하지 않았다.
- 설치본의 실제 `LilacAnime.exe`/`app.asar`에서 홈·검색 UI, preload bridge, 앱 정보 IPC(0.5.9, win32/x64), 94.99%/95% 이어보기 경계, 완료 진행률 100% 저장과 수동 다음 화 안내를 검증했다. 임시 앱 main 프로세스의 네트워크 guard가 로드됐음을 확인한 뒤 검색 IPC를 호출했고, 외부 요청 5건은 차단되어 합성 빈 응답만 사용했다. 실제 공급원 응답·영상·자막은 요청하지 않았다.
- 설치 시 전용 HKCU 제거 등록 1개·HKLM 등록 0개를 확인했다. 테스트 제거 프로그램 실행 뒤 전용 등록과 설치 폴더가 사라졌고, 검증기 임시 프로필도 제거됐다.
- 표준 NSIS를 재빌드하거나 배포하지 않았다. 실제 공급원 매칭과 이용 권한은 계속 미검증이다. 임시 빌드 복사본은 `%TEMP%\lilac-nsis-smoke-a7c3d9e102`에 남아 있으며 그 안 `source\node_modules`는 프로젝트의 `node_modules`를 가리키는 junction이다. 안전 검사가 junction 제거를 거부해 전체 임시 폴더는 보존했다.
