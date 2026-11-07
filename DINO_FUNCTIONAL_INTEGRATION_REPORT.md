# LilacAnime 원본 + 디노 패치 기능적 융합 검증

- 검증일: 2026-11-07
- 작업 브랜치: **test/dino-full-functional-integration**
- 시작 커밋: **366eb093ec5aa129116bbb5bacaf322df07d89bc**
- 판정: **PARTIAL**
- 기준 원본: LilacAnime Desktop v0.5.58, commit **e2a28266b0ee9c9391bdf41801e39fd5342c7b3c**, tree **638476606f3d4a2712c5cfbe4c1013cbcb78c14e**, 170개 파일

## 판정 요약

A35-final을 덮어쓰지 않고 별도 실험용 Windows 패키지를 만들었다. 실제 패키지 관리자의 Electron 창에서 v0.5.58 원본을 인식하고 패치를 자동 적용했으며, 재실행 후 적용 상태와 백업 1개가 유지되는 것을 확인했다. 번들 엔진으로 패치를 해제한 뒤 공식 원본 파일 170개가 Git tree blob과 모두 일치했다.

공식 v0.5.58 renderer를 격리 Electron harness에서 실행해 7요일 주간표, 통합 검색, 그룹핑, 공급원 선택, 공식 상세 및 회차 흐름, 로컬 합성 MP4/VTT 재생과 이어보기를 검증했다. 이 renderer 테스트는 공급원 IPC 합성 응답을 사용하고 외부 요청을 차단했다. 따라서 실제 공급원 네트워크 검색과 외부 영상 스트림 재생은 이번 검증에서 확인하지 않았다.

원본 애플리케이션의 모든 기능을 실제 패키지의 main/preload/renderer와 실제 공급원으로 검증한 것은 아니다. 기존 Companion은 별도 프로토타입이며 LilacAnime 안의 플러그인으로 연결되어 있지 않다. 이 공백 때문에 전체 판정은 COMPLETE가 아니라 PARTIAL이다.

## 이전 네 가지 수정 검토

| 결함 | 수정 위치 | 확인 |
|---|---|---|
| 늦은 통합 검색 응답이 홈 목록을 덮음 | patches/patch03/patch03-bridge.js에서 검색 sequence를 화면 전환·홈 목록 갱신 시 증가 | 계약 테스트와 격리 renderer E2E에서 이전 응답 완료 후 홈 목록 유지 |
| 한국어 제목 변형 재검색에서 생략 공급원이 잘못 제외됨 | src/integrated-search.js에서 안전한 제목 변형 대상에 ready-empty와 skipped 공급원을 포함 | 한국어 fixture에서 변형 검색이 공급원 네 곳에 전달되고 세 공급원 결과가 한 작품 그룹으로 합쳐짐 |
| 공급원 필터 선택이 최초 상세 공급원에 반영되지 않음 | patch03-bridge.js가 선택 공급원을 정한 뒤 공식 openDetail(selectedId) 호출 | fixture에서 Miruro 선택이 상세 기본 공급원 및 활성 선택 상태로 표시됨 |
| 상세 호출 호환성 검사가 단일 인자 문자열에만 고정됨 | manager_core.py, scripts/validate-patch03-clean-source.cjs | 기존 직접 ID와 선택된 공급원 ID 경로만 허용하고, 공식 상세 함수 및 IPC 경계 검사는 유지. 구조 계약 테스트 13/13 통과 |

호환성 검사 완화는 임의의 상세 함수 호출을 허용하지 않는다. 현재 연결 코드의 두 명시적 인자 형태만 허용한다. 추가로 manifest.json의 두 모듈 SHA-256을 변경된 실제 코드에 맞춰 갱신했다.

## 원본 기능 및 패치 연결 결과

| 기능 | 원본/패치 적용 후 검증 | 판정 |
|---|---|---|
| 홈 및 기본 메뉴 | 공식 v0.5.58 HTML/renderer가 격리 Electron harness에서 표시됨. IPC는 합성 fixture | PARTIAL |
| 기존 7요일 주간표 | 월~일 각 탭을 실제 클릭. 선택 상태, 상태 문구, 해당 요일 합성 카드 갱신과 provider IPC 7회 확인 | PASS |
| 기존 검색과 통합 검색 공존 | 공식 개별 검색 경로를 보존하는 계약 테스트 통과. 실제 외부 검색은 미실행 | PARTIAL |
| 통합 검색 결과 및 그룹핑 | 합성 응답으로 2개 작품 그룹과 공급원별 결과 표시. 동일 작품 묶기 및 서로 다른 작품 분리 확인 | PASS |
| 공급원 선택·전환 | RE:Anime/Miruro/Animenosub 선택기가 동일 공식 상세 창 안에 표시되고 선택 공급원에 맞춰 상세 갱신 | PASS |
| 공식 작품 상세 및 회차 | #detailDialog 재사용, 선택 공급원의 합성 상세와 회차 목록 표시 | PASS |
| 영상 연결 | 공식 renderer가 provider:resolve 합성 IPC 후 로컬 12초 MP4를 재생. 시간 이동·이어보기 동작 확인 | PARTIAL |
| 자막 | 로컬 합성 한국어 VTT가 ko/showing 상태로 활성 cue 표시 | PARTIAL |
| 시청 기록 및 이어보기 | 격리 프로필에서 약 27% 저장, reload 후 약 3.25초 재개, 창 종료 시 약 52% 기록 확인 | PASS |
| 즐겨찾기·설정 저장 | 합성 즐겨찾기, 테마, 공급원, 재생속도, 자막 설정을 저장하고 reload/창 재생성 후 값 유지 확인. 모든 설정 UI 조작은 미검증 | PARTIAL |
| 공식 Chromium 테마 저장소 | 실제 사용자 LevelDB 접근 없음. 이 renderer 검증은 합성 localStorage 값을 사용 | NOT TESTED |
| 실제 공급원 검색·실제 스트림 | LinkAni/Ohli24 포함 실제 외부 공급원 요청을 차단했고 보내지 않음 | NOT TESTED |
| 다운로드, 실제 외부 자막, 업데이트 오류 처리 | 이번 E2E에서 실행하지 않음 | NOT TESTED |
| Companion | 별도 실행 파일/프로필을 가진 독립 프로토타입. 공식 앱 extension API가 없어 원본과 앱 내부 연결은 미지원. 별도 단위 테스트만 실행 | PARTIAL |

테스트 renderer에서 기록한 검색 IPC는 19회, provider resolve는 2회였고 렌더러 오류 0건, 차단된 외부 요청 0건이었다. 이는 합성 계약 검증이며 실제 공급원 성공을 뜻하지 않는다.

## 패치 관리자 및 원본 복원

실험 패키지 경로:

**tools/dino-patch-manager/release/DinoPatchManager-Electron-v1.2.4-full-integration-experimental/win-unpacked/**

실제 패키지 구성 해시:

| 파일 | SHA-256 |
|---|---|
| 디노패치관리자.exe | F167E902DFF8E9C57B2802D4E3D38F1E8034704B1425F8EB67319D21EE71A5B7 |
| resources/app.asar | 1B5A605839365D5C76E724339B8A6F5586125955E668D25E1BEEDEBD76F79ABB |
| resources/manager-engine/DinoPatchManagerEngine.exe | 1085BFC671003CB4DB39146AE177F30BC3422FD917CDBC0757318E863B014AD0 |
| 번들 매니페스트 | 18C32BD43639E10D45A1C27CF7117953E3B0DE29C3227DFAAA8272045F01F373 |

실제 관리 GUI 실행 결과:

- v0.5.58 및 출처 identity 인식, compatibilityMode=STRUCTURAL
- 자동 적용 성공: src/app.js, src/index.html 수정; 패치 모듈 3개 추가
- 별도 프로필로 재실행 시 이미 적용 상태, 백업 수 1개 유지
- 관리자 Chromium 자식 프로세스의 --user-data-dir와 Electron 런타임 데이터 경로는 새 OS Temp 프로필을 사용
- 사용자 실제 AppData와 설치된 LilacAnime는 사용하지 않음

패치 해제는 CUA에서 GUI 버튼 흐름을 끝까지 확정하지 못했다. 따라서 GUI의 수동 해제 버튼 검증은 PARTIAL이다. 대신 동일 패키지의 번들 엔진에 명시적 uninstall 요청을 보내 PATCH_UNINSTALL / PASS를 확인했다. 상태는 UNPATCHED, 백업 1개는 보존됐다. 공식 파일 170개를 해당 Git commit의 raw blob SHA-1과 비교한 결과 170/170 일치, 패치 추가 모듈 3개는 원본에 남지 않았다.

## 캡처 및 실제 Electron renderer 검증

검증 캡처는 다음 OS Temp 폴더에 저장했다.

**C:\Users\공룡\AppData\Local\Temp\dino-functional-integration-v058-d4f3bb1c53cc4e6fa3c72ef47940a096\captures-e2e-19\**

- official-v058-weekly-schedule-monday.png
- official-v058-weekly-schedule-sunday.png
- patched-v058-integrated-search-grouped-results.png
- patched-v058-official-detail-provider-picker.png
- patched-v058-official-detail-reanime-episodes.png
- patched-v058-local-mp4-korean-vtt-player.png
- patched-v058-local-mp4-korean-vtt-active-cue.png

캡처는 실제 격리 Electron renderer에서 만들어졌고 fixture 응답 및 로컬 합성 영상/VTT를 사용했다. 패치 관리자 GUI 화면 자체는 실제 창으로 확인했지만 PNG 파일은 남기지 않았다.

실행 로그: **C:\Users\공룡\AppData\Local\Temp\dino-functional-integration-v058-d4f3bb1c53cc4e6fa3c72ef47940a096\renderer-e2e-19.log**

패키지 관리자와 renderer harness는 서로 분리된 OS Temp 프로필을 사용했다. renderer harness는 `app.getPath()`의 appData/userData/sessionData/temp/logs/crashDumps를 각 지정 경로와 대조하고, Chromium의 실제 `--user-data-dir`, `--disk-cache-dir`, `--crash-dumps-dir`도 별도 경로로 일치하는지 단언한다. Chromium 캐시는 `app.getPath('cache')` 값으로 추정하지 않고 실제 캐시 스위치를 확인했다. OS Temp 밖의 사용자 지정 테스트 루트는 디렉터리 생성 전에 거부하며, 호출자가 지정한 루트는 테스트 종료 시 자동 삭제하지 않도록 했다.

## 테스트 결과

| 검증 | 결과 |
|---|---|
| Python 관리자/브리지 | 66/66 통과 |
| 공식 v0.5.58 Patch 03 계약 | 13/13 통과 |
| 전체 npm test | 386개: 382 통과, 0 실패, 4 건너뜀 |
| Companion 별도 테스트 | 22/22 통과 |
| 격리 Electron renderer E2E | 통과; 검색/상세/회차/로컬 재생·자막/이어보기/주간표 |
| OS Temp 경로 탈출 차단 | 잘못된 외부 루트 거부, 외부 디렉터리 생성 없음 |
| 실제 패키지 관리자 GUI | 실제 Windows 창 실행, 자동 적용 및 재실행 확인 |
| JS 구문 검사와 git diff --check | 통과 |

네 건너뜀은 별도의 격리 공식 v0.5.14 upstream 소스가 필요한 세 가지 adapter 검사와 한 legacy fingerprint 검사다. 이번 검증 기준인 v0.5.58 구조 계약은 별도 patched fixture를 지정해 13/13 실행했다.

테스트 수 비교: 이번에는 패키지 안의 _internal/tests가 프로젝트 node --test 자동 검색에 섞이지 않도록 실험 패키지를 실행 중에만 OS Temp로 이동하고 실행 종료 후 원위치했다. 같은 checkout에서 패키지를 두면 추가된 번들 계약 테스트 13개가 발견되는 것을 재현했다. 이전 기록의 387/371/16 및 2026-11-06의 413/369/44는 다른 실행 상태다. 현재 기록된 건너뜀 사유는 source-root/번들 복사본 조건과 일치하지만, 과거 413과 현재 깨끗한 386 사이의 나머지 테스트 인벤토리 차이는 이 worktree에 보존된 당시 실행 목록이 없어 정확히 재구성하지 못했다. 테스트를 삭제하거나 조건을 약화하지 않았다.

## 수정 파일 및 보존

코드/검증 하네스 변경:

- patches/patch03/manifest.json
- patches/patch03/patch03-bridge.js
- scripts/validate-patch03-clean-source.cjs
- src/integrated-search.js
- tests/integrated-search.electron.cjs
- tests/patch03-clean-source.contract.test.cjs
- tools/dino-patch-manager/manager_core.py

이번 요청용 문서:

- DINO_FUNCTIONAL_INTEGRATION_REPORT.md
- WORK_STATE.md

패치 엔진 전체 재작성, 공식 앱의 공급원/플레이어/자막 구현 추가, 실제 소스 설치 업데이트는 하지 않았다. A35-final ZIP/기존 A20~A35 배포는 덮어쓰지 않았다. 실험 패키지는 별도 untracked release 경로에 남아 있으며 Git 커밋에는 넣지 않는다. 기존 dirty 체크아웃 D:\Codex-Coding-Folder\LilacAnime-Player, 실제 설치본 및 사용자 AppData는 사용하거나 변경하지 않았다.

## 미완료

1. 실제 공식 공급원에 대한 권한이 확인된 요청 및 live search/result validation
2. 실제 외부 스트림/영상 프레임 및 공급원 자막 매칭
3. 공식 앱 전체 Windows 배포본의 main/preload/network IPC 실행 (renderer source harness는 합성 IPC)
4. 원본 앱의 다운로드·업데이트·전체 설정 화면과 오류 복구 흐름
5. GUI에서 사용자가 누르는 패치 해제 확인창부터 완료까지의 상호작용

위 항목들을 이유로 이번 결과를 완전 융합 또는 실사용 전체 검증으로 표시하지 않는다.
