# 디노 패치 관리자

관리자는 A번에서 승인된 Electron HTML/CSS 화면을 사용하고, 패치 적용은 기존 `manager_core.py` 엔진에 위임합니다. 렌더러는 파일 경로를 직접 다루거나 셸 명령을 실행하지 않습니다. Electron main은 allowlist된 JSON 요청만 Python 엔진에 전달합니다.

## Windows 배포 폴더

관리자 빌드는 기존 Node.js, Electron 38.8.6, electron-builder와 Python/PyInstaller를 재사용합니다. 빌드 스크립트는 npm 설치를 실행하지 않습니다.

```text
LilacAnime/
└─ DinoPatchManager/
   ├─ 디노패치관리자.exe
   ├─ resources/
   │  ├─ app.asar
   │  ├─ manager-engine/       # PyInstaller Python 엔진과 Patch 03 자산
   │  └─ manager-node/node.exe # 공식 원본 계약 검사에 사용
   └─ runtime/                 # 관리자 전용 appData/userData/sessionData/cache/logs
```

공식 원본 폴더 아래 `DinoPatchManager`에 배치하고 실행하면 경로 상위에서 소스형 LilacAnime를 자동 검색합니다. 원본을 찾지 못하면 사용자가 선택한 폴더만 검사합니다. 설치된 `app.asar` 구조는 패치 대상이 아닙니다.

## 작업 흐름

관리자 시작 시 공식 버전·파일 지문·패치 상태를 검사합니다. 지원되는 미적용 원본이면 기존 엔진이 변경 파일을 백업한 뒤 적용하고, 이미 적용된 원본이면 파일을 다시 쓰지 않습니다. 지원 버전이 아니거나 사용자 수정이 감지되면 중단하고 원인을 표시합니다.

패치 해제와 백업 복원은 버튼으로 명시적으로 실행합니다. 공식 업데이트 조회는 최신 태그를 비교할 뿐이며, 공식 원본 다운로드나 업데이트 설치는 현재 지원하지 않습니다. 새 버전의 기준 지문과 마이그레이션 계약이 준비되지 않았다면 승인 후에도 업데이트를 거부합니다.

## 테마와 프로필

관리자 Electron의 `appData`, `userData`, `sessionData`, 캐시, 로그 및 크래시 자료는 관리자 전용 경로에 분리합니다. 개발 및 검증 실행은 OS Temp의 서로 다른 경로를 사용합니다.

공식 테마는 기존 엔진의 read-only `read_official_theme` 경로로 확인합니다. 읽을 수 없으면 Windows 앱 테마 또는 안전한 다크 기본값을 적용하고 실패를 표시합니다. 원본 설정 파일은 변경하지 않습니다.

## 개발 및 빌드

개발 UI는 `tools\dino-patch-manager\run.bat`으로 실행합니다. Windows 배포본은 다음으로 생성합니다.

```powershell
powershell -ExecutionPolicy Bypass -File tools\dino-patch-manager\build_windows.ps1
```

빌드는 기존 저장소 Electron/PyInstaller 도구만 사용하며 `npm`, `pip`, `npm ci`를 실행하지 않습니다. 앱 조립본과 빌드 작업은 새 OS Temp 폴더에서 만들고 기존 릴리스는 덮어쓰지 않습니다. A4, A5, A6는 보존하고, UTF-8 브리지, 오류 상태 구분, 백업 조회 중 동시 작업 차단을 담은 새 검증 결과는 `release\DinoPatchManager-Electron-v1.2.4-A7\win-unpacked` 아래에 저장됩니다.

패치 엔진 테스트:

```text
python -m unittest discover -s tools\dino-patch-manager\tests -p "test_*.py" -v
```

실제 테스트는 OS Temp의 합성 원본과 격리 프로필만 사용합니다. 실제 설치 앱, 사용자 프로필, 시청 기록, 자막 저장소는 사용하지 않습니다.

## 기존 Tkinter 구현

`manager_gui.py`와 기존 PyInstaller spec은 기존 검증 기록 보존을 위해 그대로 유지합니다. 기본 런처와 배포 빌드는 Electron UI만 제공합니다. 두 UI는 하나의 `manager_core.py` 패치 엔진을 공유합니다.
