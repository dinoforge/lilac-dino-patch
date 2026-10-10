# LilacAnime Companion 원본 스타일 검증

## 결론

격리된 LilacAnime v0.5.14 렌더러의 `#scheduleSection` 안에 Companion 테스트 요일표를 표시했다. 기존 “방영 일정” 제목을 재사용하고, Companion UI의 요일 버튼·작품 레일·카드는 원본 스타일과 계산된 스타일이 일치했다. 월~일 선택, 오늘 요일 기본 선택, 라이트·다크 테마 상속, 연결 해제 후 원본 DOM·표시 상태 복구가 통과했다.

이번 결과는 **테스트용 v0.5.14 소스 사본에서 화면을 삽입하고 제거한 증거**다. 수정하지 않은 설치본에 별도 Companion이 연결된다는 뜻은 아니다.

## 기준과 안전 경계

- 브랜치: `codex/runtime-attach-native-style`
- 기준 커밋: `b1889ae5d7e45658c2670c55152c0d4e6e717d9c` (`codex/runtime-attach-feasibility`)
- 화면 소스: LilacAnime v0.5.14, 커밋 `f095fc3d775451e144ed780e1fa081f739927652`
- 화면은 해당 커밋의 Git 아카이브를 고유한 시스템 임시 디렉터리에 풀어 실행했다. 시험 고리는 임시 사본의 `electron/main.cjs`에만 추가했다.
- Electron `webContents.debugger` 내부 연결로 테스트 스크립트를 실행했다. 외부 TCP 디버그 포트는 열지 않았다. 테스트 앱의 네트워크는 차단했다.
- `userData`, `sessionData`, 캐시를 임시 프로필로 분리했다. 기존 의존성을 읽기 전용으로 재사용했고 설치·NSIS·Computer Use는 사용하지 않았다.
- `D:\LilacAnime`, 기존 사용자 프로필, 업데이트 캐시는 접근하거나 수정하지 않았다. 사본의 `src/index.html`·preload 해시는 유지됐고 변경 경로는 임시 `electron/main.cjs` 하나였다. 격리 임시 트리는 검증 후 정리됐다.

## 화면 비교

| 뷰포트 | 원본 홈의 방영 일정 | Companion 삽입 후 |
| --- | --- | --- |
| 1440×900 | [원본 캡처](assets/runtime-attach-v0.5.14-native-style-20261010T183201Z-original-dark-1440x900.png) | [삽입 캡처](assets/runtime-attach-v0.5.14-native-style-20261010T183201Z-companion-dark-1440x900.png) |
| 1280×720 | [원본 캡처](assets/runtime-attach-v0.5.14-native-style-20261010T183201Z-original-dark-1280x720.png) | [삽입 캡처](assets/runtime-attach-v0.5.14-native-style-20261010T183201Z-companion-dark-1280x720.png) |
| 760×700 | [원본 캡처](assets/runtime-attach-v0.5.14-native-style-20261010T183201Z-original-dark-760x700.png) | [삽입 캡처](assets/runtime-attach-v0.5.14-native-style-20261010T183201Z-companion-dark-760x700.png) |

라이트 테마: [1440×900 캡처](assets/runtime-attach-v0.5.14-native-style-20261010T183201Z-companion-light-1440x900.png)

캡처는 같은 뷰포트와 원본의 같은 스크롤 위치를 사용했다. 홈 콘텐츠가 화면 높이보다 길어 포스터 카드 아래쪽은 첫 화면 밖으로 이어진다. 카드 전체를 화면 안으로 스크롤해 볼 수 있는지도 별도로 확인했다.

## 스타일과 동작

- 기존 `#scheduleSection`과 제목 “방영 일정”을 유지했다. 제목을 복제하지 않았다.
- Companion 자식 영역은 기존 `.chip-row`, `.poster-rail`, `.anime-card`, `.poster`를 사용한다. 보라색 그라데이션, 별도 카드 배경·그림자·테두리, 강제 폰트, 큰 내부 여백, 버튼 인라인 스타일은 제거했다.
- 계산 스타일을 원본 클래스 샘플과 비교했다. 제목, 버튼 행, 선택/비선택 버튼, 레일, 카드, 포스터, 제목·보조 글씨 9개 비교가 모두 일치했고 Companion 요소의 인라인 스타일은 0개였다.
- 원본 버튼 계산값은 `Segoe UI Variable, Segoe UI, Pretendard`, 12px, 최소 높이 34px, 가로 여백 14px, 둥근 모서리 17px, 버튼 간격 8px였다. 포스터 레일은 10px 간격과 원본 반응형 열 너비를 따랐다.
- 원본 제목 옆에 `테스트 데이터`만 작은 보조 문구로 표시했다. 글자색은 `var(--muted)`를 사용한다.
- 포스터 이미지는 합성하지 않았다. 원본 `.poster`의 빈 포스터 배경과 비율을 그대로 사용했다.
- 월~일 버튼 7개가 동작했고, 실행 시 오늘 요일을 기본 선택했다. 합성 작품을 바꾸면서 5개 출처 상태를 모두 확인했다. `재생 가능`, `제공 확인`, `미제공`, `확인 중`, `확인 실패`는 구분해 한국어로 표시했다.
- 라이트·다크에서 원본 `body.light` 변수 상속을 확인했다. 요일 버튼과 글자색은 테마별 원본 CSS 변수에 따라 바뀌었다.
- 세 뷰포트에서 버튼이 컨테이너 안에 들어가고, 제목·요일·카드 순서가 겹치지 않았으며, 페이지 가로 넘침이 없었다. 각 뷰포트에서 작품 카드를 스크롤해 전체 카드가 화면에 들어오는 것도 통과했다.

원본 방영표의 기존 `#scheduleTabs`와 `#scheduleRail`은 Companion 표시 중에만 `hidden` 상태로 전환했다. 기존 노드와 내부 HTML은 변경하지 않았다. 이를 통해 제목이나 방영표가 두 번 보이지 않게 했다. 캡처 시 외부 네트워크를 차단했기 때문에 원본 방영표의 실제 일정은 로드되지 않았고, 비교 기준은 실제 원본 홈 화면과 원본 CSS 클래스로 만든 임시 스타일 샘플이다.

## 연결 해제와 회귀 확인

- Companion 자식 프로세스를 정상 종료했다.
- Companion DOM, 스타일 태그, 테스트 문구와 버튼 노드를 제거했다.
- 원래의 일정 탭·레일 노드 identity와 내부 HTML, 숨김 상태, 제목, 테마 클래스, 스크롤 위치를 복구했다. 모든 복구 검사가 통과했다.
- UI 제거를 확인한 뒤 CDP 연결을 분리했다.
- 제거 후 기존 검색 화면으로 이동하고 검색 입력 요소가 있는지, 설정 화면과 테마 설정 요소가 있는지, 상세 다이얼로그 열기·닫기와 콘텐츠 컨테이너가 있는지 확인했다. 창은 정상 유지됐다. 실제 검색 결과나 외부 콘텐츠는 요청하지 않았다.
- 브라우저 네트워크 요청은 0건이었다. 테스트 훅이 막은 main-process 네트워크 호출은 9건이었다.

## 테스트 결과 및 한계

- 런타임 렌더링: 통과
- 월~일 선택·출처 상태 표시: 7일 모두 통과, 합성 데이터
- 원본 스타일 계산값 비교: 9개 항목 모두 통과
- 테마 상속·세 뷰포트·카드 스크롤: 통과
- 제거 후 원본 DOM·검색/설정/상세 화면 점검: 통과
- `npm test`: 296/296 통과
- `node --check` 두 대상 파일 및 `git diff --check`: 통과
- 최종 런타임 로그: [runtime-attach-native-style-evidence-20261010T183201Z.jsonl](runtime-attach-native-style-evidence-20261010T183201Z.jsonl)

첫 런타임 시도에서 시험 훅의 요일 선택 변수가 상수로 선언된 오류를 발견해 수정했다. 수정 뒤 전체 화면 실험을 다시 실행했고 최종 결과는 통과했다.

실제 Re:Anime·Miruro·Animenosub·애니24·Linkkf 일정, 영상 재생, 별도 Companion의 무수정 설치본 연결은 시험하지 않았다. 데이터와 출처 상태는 전부 합성이다. 외부 공급원 접근과 원본 설치본 연결 가능성은 이 보고서의 판정 범위가 아니다.
