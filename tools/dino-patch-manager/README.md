# 디노 패치 관리자

관리자는 승인된 A Electron HTML/CSS 화면을 사용하고, 패치 적용은 기존 manager_core.py 엔진에 위임합니다. 렌더러는 파일 경로를 직접 다루거나 셸 명령을 실행하지 않습니다. Electron main은 allowlist된 JSON 요청만 Python 엔진에 전달합니다.

## Windows 배포 폴더

~~~text
LilacAnime/
└─ DinoPatchManager/
   ├─ 디노패치관리자.exe
   ├─ resources/
   │  ├─ app.asar
   │  ├─ manager-engine/       # PyInstaller Python 엔진과 패치 데이터
   │  └─ manager-node/         # 계약 검사에 쓰는 Node 런타임
   └─ runtime/                 # 관리자 전용 프로필과 로그
~~~

관리자 폴더를 공식 LilacAnime 소스 폴더 아래 배치하고 실행하면 상위 경로에서 소스형 원본을 자동 검색합니다. 원본을 찾지 못하면 사용자가 선택한 폴더만 검사합니다. 설치된 app.asar 구조는 패치 대상이 아닙니다.

## 작업 흐름

관리자 시작 시 공식 버전·파일 지문·패치 상태를 검사합니다. 지원되는 미적용 원본이면 기존 엔진이 변경 파일을 백업한 뒤 적용하고, 이미 적용된 원본이면 파일을 다시 쓰지 않습니다. 지원 버전이 아니거나 사용자 수정이 감지되면 중단하고 원인을 표시합니다.

패치 해제와 백업 복원은 버튼으로 명시적으로 실행합니다. 공식 업데이트 조회는 최신 태그를 비교할 뿐이며, 공식 원본 다운로드나 업데이트 설치는 현재 지원하지 않습니다. 새 버전의 기준 지문과 마이그레이션 계약이 준비되지 않았다면 승인 후에도 업데이트를 거부합니다.

## 테마와 프로필

관리자 Electron의 appData, userData, sessionData, 캐시, 로그 및 크래시 자료는 관리자 전용 경로에 분리합니다. 테스트 프로필과 공식 앱 프로필은 별도 격리 경로를 사용합니다.

공식 테마는 엔진의 read-only read_official_theme 경로로 확인합니다. 읽을 수 없으면 Windows 앱 테마 또는 안전한 다크 기본값을 적용하고 실패를 표시합니다. 원본 설정 파일은 변경하지 않습니다.

## 독립 Windows 빌드

빌드는 이 저장소의 루트 node_modules나 개발자 PC의 고정 경로를 사용하지 않습니다. Node.js/npm은 build-toolchain.json에 기록된 버전을 사용하고, Python/PyInstaller는 잠긴 전용 venv를 지정해야 합니다. 빌드 스크립트는 관리자 Electron 의존성을 짧은 OS Temp staging에 npm ci로 설치하며, Python 빌드 도구·Electron 캐시도 같은 실행 전용 staging과 별도 venv에 격리합니다. 프로젝트 루트는 스크립트 위치에서 계산합니다.

Python 3.14.7을 준비한 뒤 저장소 복제본에서 전용 venv를 만들고 고정된 빌드 패키지를 설치합니다.

~~~powershell
py -3.14 -m venv .venv-dino-build
& .\.venv-dino-build\Scripts\python.exe -m pip install -r tools\dino-patch-manager\requirements-build.txt
~~~

독립 패키지는 다음과 같이 새 이름으로 생성합니다. 기본 출력은 이번 checkout의 tools/dino-patch-manager/release 아래에 놓이며, 대상 경로가 이미 있으면 덮어쓰지 않습니다.

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\dino-patch-manager\build_electron_windows.ps1 -PythonExe .\.venv-dino-build\Scripts\python.exe -BuildName independent-repro
~~~

Node/npm/Python/PyInstaller 또는 Python 빌드 패키지 버전이 잠금값과 다르면 빌드를 시작하지 않습니다. PyInstaller가 만든 번들에 manifest와 필수 패치 자산이 있는지 확인하고, Electron 패키징 전후에 읽기 전용 info 요청이 모두 성공해야 빌드를 완료합니다. 빌드 실패 시 OS Temp staging을 진단용으로 보존합니다. 이 절차는 ZIP이나 정식 릴리스를 만들지 않습니다.

버전과 의존성 잠금은 build-toolchain.json, requirements-build.txt, electron-app/package-lock.json에 기록합니다.

## 관리자 테스트

~~~powershell
python -m unittest discover -s tools\dino-patch-manager\tests -p "test_*.py" -v
node --test tests\dino-manager-ui.test.cjs
~~~

실제 테스트는 OS Temp의 합성 원본과 격리 프로필만 사용합니다. 실제 설치 앱, 사용자 프로필, 시청 기록, 자막 저장소는 사용하지 않습니다. 테스트를 위해 checkout 자체를 OS Temp 안에 두면 엔진의 Temp 겹침 안전검사에 차단되므로, 독립 checkout은 OS Temp 밖에 두고 빌드 staging·프로필만 OS Temp로 분리합니다.

## 기존 Tkinter 구현

legacy_tk GUI와 빌드 fixture는 기존 검증 기록 보존을 위해 그대로 유지합니다. 기본 런처와 배포 빌드는 Electron UI만 제공합니다. 두 UI는 하나의 manager_core.py 패치 엔진을 공유합니다.
