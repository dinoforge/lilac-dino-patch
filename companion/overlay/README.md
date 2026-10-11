# LilacAnime Companion — Windows Overlay (experimental)

이 프로토타입은 LilacAnime **내부 패치나 플러그인이 아닙니다.** 원본 소스/설치본/프로필을 고치지 않고, 원본 창 옆에 따라다니는 **별도 Electron 창**입니다.

## 준비·실행

작업 저장소 루트에서 이미 설치된 개발용 Electron을 이용하며, NSIS 빌드와 설치는 하지 않습니다.

```powershell
cd 'D:\Codex-Coding-Folder\LilacAnime-Player-companion-window-overlay'
& '.\node_modules\electron\dist\electron.exe' '.\companion\overlay'
```

별도의 작업 폴더에 `node_modules`가 없으면 *검증된 개발용 Electron 경로*를 절대 경로로 지정합니다. 기존 설치된 원본 LilacAnime 실행 파일을 Electron으로 사용하지 않습니다. 새로 패키징하거나 설치하지 않습니다.

실행 즉시 창 추적을 시작하지 않습니다. 명시적으로 **원본 창 따라가기** 버튼을 누를 때만 Windows API가 top-level 창의 프로세스명·제목·창 크기·전면 여부를 관찰합니다. 원본 사용자의 애니 목록/시청 기록/파일/세션/자막은 읽지 않습니다. `따라가기 해제`를 누르면 즉시 위치 추적과 항상 위 표시가 중단됩니다.

원본 창의 외부 좌/우 공간에 패널을 배치합니다. 그 공간이 없으면 자동 도킹 대신 수동 위치 모드로 전환하며 원본 창 내부에 삽입하지 않습니다. 다중 대상 창, Windows 탐색 명령 실패, DPI 변환 실패에도 안전하게 동작을 중단하거나 사용자의 수동 배치를 유지합니다.

## 현재 제공

- 원본 스타일을 참고한 작은 패널: 분기, 월~일 선택, 합성 애니메이션, 다섯 출처의 **합성 상태**
- 창 제목과 이름을 확인하는 Windows 창 검색은 사용자가 클릭한 뒤에만 진행
- 창 위치 관찰과 가용 모니터 작업 영역을 바탕으로 좌우 도킹
- 독립 앱 ID `com.dinoforge.animeplayer.companion.overlay.test` 및 전용 프로필
- renderer Node.js 통합 금지, 샌드박스, 외부 네트워크 요청 차단

## 미지원·미검증

- 실제 LilacAnime 설치본과 Windows UI에서 도킹/고배율 동작: **미검증**
- 실제 공급원 조회, 현재 회차 감지, 원본 영상 재생/원본 자막 자동 적용: **미구현**
- ChatGPT 수동 VTT 번역: 기존 `companion/` 프로그램에서만 파일 방식으로 제공. 이 작은 패널은 번역 UI를 포함하지 않음
- 원본 화면 내부 DOM 삽입: **지원하지 않음**
- Windows PowerShell 실행 정책상 .ps1 실행이 허용되지 않으면 기능은 실패로 표시하며 실행 정책을 우회하지 않음
- 디스플레이 배율과 다중 모니터의 Win32 픽셀→Electron DIP 변환은 실제 Windows 환경에서 별도 검증 필요

## 정적/순수 계산 테스트

```powershell
node --test companion/tests/overlay-geometry.test.cjs companion/tests/overlay-security.test.cjs
```

원본 `D:\LilacAnime`, `%APPDATA%\lilacanime-desktop`, `%LOCALAPPDATA%\lilacanime-desktop-updater`에는 접근하거나 파일을 쓰지 않습니다. 앱을 실행하면 **Companion 자신의 전용 프로필**은 새로 생성됩니다.
