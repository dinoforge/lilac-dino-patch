# Companion Windows 도킹 오버레이 초기 구현

날짜: 2026-10-11
브랜치: `codex/companion-window-overlay`
기준: `c8b180bff0d36d7b523d0ae2f74b34d42a0ee994`

## 현재 판정

- Windows 오버레이 **코드 작성 완료**, 실제 Windows UI 실행/원본 근접 배치 동작은 **미검증**.
- `companion/overlay/`는 기존 `companion/` 전체 창과 별도의 실행 엔트리이다.
- 원본 LilacAnime 수정/업데이트 변경: **없음**. 원본 설치 경로, 사용자 프로필, 업데이트 캐시를 조회하지 않음.
- 합성 일정: 기존 `companion/core/catalog.cjs`의 7일짜리 fixture를 그대로 재사용. 실제 공급원 검색/재생/자막 자동 적용은 없음.
- 원본 화면 내부 삽입: **불가/미지원**. 오버레이는 별도의 Windows 창이다.

## 구현

- `geometry.cjs`: Electron DIP 기준 창 바깥 좌우 배치, 여백/작업영역 확인, 공간 부족 시 수동 모드.
- `windows-probe.ps1`: 사용자가 활성화한 경우에만 프로세스 이름이 LilacAnime이고 MainWindowTitle이 LilacAnime인 가시 top-level 창의 HWND/PID/rect/전면 여부 반환; 사용자 파일·세션·메모리는 읽지 않음.
- `main.cjs`: 명시적인 따라가기 시작/중단, 한 번에 하나의 일치 대상만 허용, 1.5초 간격 점검, powershell 실패 시 중단, 외부 요청 차단, 별도 앱 데이터 경계.
- `index.html`/`overlay.css`/`renderer.js`: 원본 다크/라이트 색상 및 칩 스타일을 참고한 소형 창에서 월~일 예시 선택, 5개 공급원 상태 표시, 따라가기 토글.

## 검증 경계

- JavaScript 6개 파일 V8 파서 검사 통과(코드 수준, Electron/Node 런타임 시험과 다름).
- 순수 기하 로직의 오른쪽/왼쪽/공간 부족/유효하지 않은 입력/멀티 모니터 음수 좌표 등 5개 사례 수동 함수 실행 통과.
- 저장소의 새 Node `--test` 테스트 파일 2개는 작성했으나 **Node 테스트 실행은 아직 수행하지 않음**.
- Windows PowerShell/Win32 창 프로브, Electron renderer, 실제 DPI, 최소화/전면감지, 창 이동 및 앱 종료 회귀 시험은 **실행되지 않음**.
- 다른 앱 전면 상태에서 1.5초 폴링 사이에 잠시 항상 위 표시가 남는지 여부 등 사용성 문제는 Windows 실제 실행으로 검증해야 함.
- 원본 설치본과 메타데이터 연결 시험은 사용자 환경에서 수행하지 않음. 원본 창 메타데이터 접근은 UI 클릭 후에만 시작하도록 설계.

## 필수 다음 검증

1. 로컬 개발 PC에서 `node --test companion/tests/overlay-geometry.test.cjs companion/tests/overlay-security.test.cjs`와 `npm test` 실행, 회귀 오류 수정.
2. 원본 실행본 대신 완전히 격리된 **합성 Windows 타깃 창**으로 창 추적기 동작을 검증. 필요하다면 probe에서 프로세스명·제목만 테스트 전용으로 구성하되 실제 원본 자동 탐색 우회나 가짜 성공 보고 금지.
3. 100%/150% 배율, 모니터 음수 좌표, 창 이동/최대화/최소화/닫기, alt-tab, 작은 화면과 여러 타깃 창을 검증. 다른 앱을 가리거나 포커스를 탈취하는 경우 fail-closed.
4. 원본 실제 앱을 조회/실행/재시작하거나 설치/패키징하지 않음. 기존 Computer Use 감사 중단을 유지.
5. 최종 실행 로그 및 화면 캡처를 보유하기 전에는 '오버레이가 작동한다'고 보고하지 않음.
