# LilacAnime Desktop 기준선 점검

점검일: 2026-10-09
기준 원본: whispelyn-byte/LilacAnime-desktop, main, d7d4ec4853d252d67f0febb939be9770ca703444 (v0.5.6)
새 작업 저장소: dinoforge/anime-player, 비공개

## 결론

원본은 Electron 기반 Windows 데스크톱 앱으로 설치 파일 빌드가 가능하다. 목록·검색·상세·회차·재생·시청 기록·자막·다운로드의 구현이 이미 있고, 자동 테스트와 Windows 패키지 빌드도 로컬에서 통과했다. 다만 이는 코드·로컬 테스트·패키징 기준선이다. 실제 외부 사이트의 현재 응답, 실제 영상 재생, 자막의 회차·영상판 일치, 앱을 설치한 뒤의 흐름은 검증되지 않았다.

요구사항과 충돌하는 부분은 다음과 같다.

- 다음 회차 자동 재생이 설정 기본값이다. 요구사항 28은 자동 재생 금지다.
- 앱 업데이트 조회 주소는 새 저장소가 아니라 원본 LilacAnime 저장소를 가리킨다.
- 현재 홈에는 히어로, 이번 시즌, 방영 중, 인기 순위와 일정이 있다. 목표인 최신 회차·요일별·분기별 구성을 그대로 제공하지 않는다.
- Windows/Android 계정과 프로필 동기화는 구현 근거를 찾지 못했다. 기록과 설정은 로컬에 저장된다.
- 저장소에 LICENSE 파일이 없고 GitHub가 표시하는 원본 저장소 라이선스도 null이다. package.json의 MIT 선언만으로 재사용·재배포 범위를 확정하지 않는다.

## 실행 및 검증 기록

| 항목 | 실제 명령 또는 범위 | 결과 |
|---|---|---|
| 런타임 | Node v24.14.1, npm 11.11.0 | 확인 |
| 의존성 | npm ci | 성공, 363개 패키지 설치. npm 보고에 취약점 11개(중간 8, 높음 3)가 포함됨 |
| 오프라인 자동 테스트 | node --test tests/player-interactions.test.cjs tests/flix-proxy.test.cjs | 성공, 10/10 통과. 플레이어 입력·화면비·자막 레이아웃과 로컬 loopback 프록시 테스트 |
| Windows 설치 파일 | npm run dist | 성공, dist/LilacAnime-Setup.exe 생성 |
| 실제 앱 창 | npm start / npm run dev | 실행하지 않음. 기존 사용자 데이터가 있는 기본 LilacAnime 프로필을 건드리지 않도록 했다. 해당 데이터는 열람하지 않았다 |
| 실시간 재생 테스트 | tests/flix-live-electron.cjs | 실행하지 않음. RE:Anime API와 FlixCloud 페이지를 사용하는 라이브 테스트이며, 실제 출처의 이용 조건과 현재 동작을 확인하지 않은 상태 |
| 실제 외부 자막·영상 | 공급원별 재생/회차 매칭 | 미검증. 로컬 자동 테스트 결과를 실제 사이트 성공으로 간주하지 않음 |

따라서 패키지 빌드와 지정된 오프라인 테스트는 PASS, 실제 앱 UI 및 실제 서비스 연결은 미검증이다. 네트워크 사이트 테스트의 성공을 주장하지 않는다.

## 구조 및 구현 위치

| 영역 | 구현 위치 | 기준선 관찰 |
|---|---|---|
| 앱·빌드 | package.json, .github/workflows/build.yml | Electron 38 계열, electron-builder. Windows NSIS와 macOS DMG 설정이 있다. 계획은 Windows 우선이며 macOS는 범위 밖이다 |
| 화면·탐색 | src/index.html, src/app.js | 홈, 전체, 검색, 시청 기록, 내 목록, 설정, 상세 창, 플레이어 화면이 있다 |
| 앱 데이터·IPC | electron/main.cjs, electron/preload.cjs | Electron main process에 사이트별 목록·상세·회차·재생·자막 서비스와 IPC가 집중되어 있다 |
| 콘텐츠 공급원 | README.md, electron/main.cjs | README에는 RE:Anime, Miruro, Animenosub, 애니24, 링크애니, Linkkf가 기재돼 있다. PRODUCT.md는 Linkkf, Animenosub, RE:Anime만 열거해 문서가 일치하지 않는다 |
| 한국어 제목 | electron/main.cjs, README.md | TMDB → AniList → Wikidata 순서가 코드와 README에 있다. TMDB 조회에는 사용자가 등록한 API 키가 필요하다 |
| 자막 탐색·저장 | src/app.js, src/player.js, electron/main.cjs, electron/subtitle-store.cjs | 사이트 트랙, Kairan, Csora, Anissia 등록 제작자, Jimaku 일본어 자막, 사용자 파일 경로가 있다. 실제 후보의 회차·판본 적합도는 확인되지 않았다 |
| 번역 | electron/subtitle-translator.cjs, electron/local-ai.cjs | 로컬 AI 및 여러 번역 API 경로가 있다. 계획의 API 없는 ChatGPT 복사·붙여넣기 흐름은 구현 근거를 찾지 못했다 |
| 자막 렌더링 | src/ass-renderer.js, src/player.js, electron/main.cjs | ASS/SSA 렌더러 경로와 SMI/SRT/VTT 변환·사용자 파일 지원이 있다. 형식별 실제 파일 검증은 하지 않았다 |
| 다운로드 | electron/download-manager.cjs, src/app.js | 큐, 진행률, 재시도·재개, 로컬 보관함 및 자막 연결 구현이 있다. 실제 출처·권한·오프라인 재생은 미검증이다 |
| 기록·설정 | src/app.js, src/player.js | 시청 기록·이어보기·선호 설정은 renderer localStorage와 Electron userData 아래의 로컬 파일을 사용한다. 클라우드 계정 및 기기간 동기화는 확인되지 않았다 |
| 업데이트 | electron/updater.cjs | 조회 대상이 https://api.github.com/repos/whispelyn-byte/LilacAnime-desktop/releases 로 고정돼 있다. 새 저장소를 사용하는 제품에서 수정할 항목이다 |

홈의 현재 순서는 히어로, 방영 일정, 이어서 보기, PV·트레일러, 극장판, 16+ 애니, 이번 시즌 신작, 방영 중, 인기 순위다. 방영 일정에는 날짜 탭이 있지만 Linkkf 일정 경로에 묶여 있고, 분기별 분류는 찾지 못했다. 근거: src/index.html 49–59행, src/app.js 844–858행 및 910–914행.

## 권리·배포와 자동화 범위

- 원본 GitHub API의 license 필드는 null이고 원본 저장소 루트에서 LICENSE/COPYING 파일을 찾지 못했다. package.json은 MIT를 선언한다. 이 차이를 해소할 근거가 없으므로 공개 배포나 원본 자산 재배포 권한을 확정하지 않는다.
- README의 공급원 목록과 크레딧은 코드 구현 또는 이용허락의 증거가 아니다. 각 콘텐츠·자막 출처와 제공 API의 최신 이용 조건은 별도 확인이 필요하다.
- 새 저장소는 비공개로 두었다. 공개 배포·릴리스와 자동 업데이트 주소 변경은 권리와 제품 이름을 확인한 뒤 결정한다.
- .github/workflows/build.yml은 v* 태그 push 또는 workflow_dispatch로만 실행되는 빌드·릴리스 워크플로다. main push에서 실행되는 자동 CI는 없다. 실행 결과를 검증 성공으로 주장하지 않는다.
- 자막 음성 의미 비교 자동 싱크, API 없는 ChatGPT 자동 번역, 클라우드 인증·동기화는 목표 문서에 있으나 현재 구현 성공 증거가 없다.

## 다음 단계

1. 아래 FEATURE_GAP.md에서 1–42 요구사항을 분류한다.
2. PHASE1_PLAN.md에 첫 Windows 테스트 버전의 순서와 통과 기준을 고정한다.
3. 실제 외부 영상 검증 전 각 공급원의 사용 권한과 테스트에 쓸 수 있는 자산을 확인한다.
4. 28번 자동 재생 금지와 새 저장소 업데이트 설정을 포함해 첫 코드 변경을 별도 검토한다.
