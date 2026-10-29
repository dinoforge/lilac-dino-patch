# 디노 패치 관리자

Windows용 관리자는 하나의 프로그램으로 배포합니다. 최종 폴더는 실행 파일과 PyInstaller 보조 런타임, 패치 데이터로 구성되며 사용자의 Python 설치가 필요하지 않습니다.

LilacAnime/
└─ DinoPatchManager/
   ├─ 디노패치관리자.exe
   ├─ _internal/                 # EXE 실행에 필요한 런타임과 지원 파일
   └─ manager.log                # 읽기 전용 테마 감지 실패 등 진단 기록

개발 저장소에서는 소스를 tools/dino-patch-manager/에 유지합니다. 패치 데이터는 실행 파일에 포함됩니다. 관리자는 EXE 위치의 상위 폴더에서 소스형 LilacAnime 구조를 찾아 지원 여부를 검사합니다. 설치된 ASAR 패키지 구조는 지원하지 않습니다.

## 사용 흐름

1. 배포 폴더를 공식 LilacAnime 소스 폴더 바로 아래 DinoPatchManager로 둡니다.
2. 디노패치관리자.exe를 실행하면 실행 경로에서 원본을 찾습니다.
3. 고정 버전·원본 파일 트리·필수 연결 지점·공식 IPC·관리 패치 상태를 확인합니다.
4. 미적용 상태이며 검증을 통과하면 변경 파일 백업 후 자동으로 적용합니다. 이미 적용됐으면 파일을 다시 쓰지 않습니다.
5. 자동 검색이 실패하면 폴더 선택으로 소스 폴더를 지정할 수 있습니다.

지원 기준은 공식 v0.5.54 (e4ac62214f5c4863eebae5052633e7f9f33dcbaa)입니다. 패치는 공식 src/app.js, src/index.html 연결부 두 파일과 통합 검색 모듈 세 개만 수정·추가합니다. electron/main.cjs, preload, 플레이어, 공급원 어댑터, 자막 및 Whisper는 교체하지 않습니다. 예상하지 못한 공식 변경이나 기존 사용자 수정이 감지되면 적용을 중단합니다.

## 복원 및 업데이트

- 패치 해제는 관리자 기록과 현재 전체 파일 지문이 적용 결과와 일치할 때만 패치가 변경한 파일을 백업 내용으로 되돌립니다.
- 백업 복원은 선택한 백업의 원본 버전, manifest 허용 파일 집합, 해시 및 현재 적용 트리를 다시 확인합니다. 사용자 변경을 덮어쓰지 않습니다.
- 관리자 파일과 백업 자료는 LilacAnime/DinoPatchManager에 저장합니다. 패치 해제는 관리자·기록·백업을 제거하지 않습니다.
- 관리자 시작 시 앱 프로세스 실행 여부를 확인합니다. 확인할 수 없거나 LilacAnime가 실행 중이면 파일 작업을 중단합니다.
- 공식 GitHub 릴리스 조회는 별도로 수행합니다. 새 버전은 표시하지만 새로운 기준 지문과 호환성 계약을 이 관리자에 추가하기 전까지 자동 공식 업데이트는 지원하지 않습니다. 승인 요청만으로 원본 파일을 교체하지 않습니다.

## 테마

관리자는 공식 원본의 localStorage.theme를 읽기 전용으로 확인하고, 창 활성화와 주기 확인 때 화면 테마를 갱신합니다. 과거 SQLite localStorage 형식은 읽을 수 있습니다. 현재 Chromium LevelDB 형식은 직접 해석하지 않으므로 해당 경우 진단을 남기고 Windows 앱 테마 또는 다크 기본값으로 표시합니다. 이 경우 LilacAnime 테마 자동 연동이 성공한 것처럼 표시하지 않습니다. 원본 설정을 변경하지 않습니다.

## 개발 및 빌드

개발 모드는 저장소 루트에서만 실행됩니다.

    python tools\dino-patch-manager\manager_gui.py

Python 3.10 이상과 Tkinter가 필요합니다. 런처는 패키지를 설치하지 않습니다.

관리자 Windows 배포본은 DinoPatchManager.spec로 onedir/windowed 형태를 만듭니다. 빌드 시 PyInstaller가 이미 설치되어 있어야 하며, 빌드 스크립트는 pip, npm, npm ci를 실행하지 않습니다. 결과 폴더는 기존 경로를 덮어쓰지 않습니다.

관리자 엔진 테스트:

    python -m unittest discover -s tools\dino-patch-manager\tests -v

테스트는 OS Temp의 합성 소스와 가짜 테마 저장소만 사용합니다. 실제 LilacAnime 설치·사용자 프로필·시청 기록은 사용하지 않습니다.
