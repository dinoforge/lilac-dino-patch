# LilacAnime DinoPatch 사용법

LilacAnime DinoPatch는 **LilacAnime에 통합 검색 기능을 추가하는 Windows 프로그램**입니다.

## 설치하기

1. 배포 ZIP을 압축 해제합니다.
2. **DinoPatchManager** 폴더에서 **LilacAnime-DinoPatch.exe**를 실행합니다.
3. **원본 폴더 변경**에서 공식 **LilacAnime 설치 폴더**(`LilacAnime.exe`가 있는 폴더)를 선택합니다.
4. 관리자가 설치 폴더의 `resources/app.asar` 내부 파일과 호출 계약을 검사하고, 구조가 호환되면 원본을 백업한 뒤 패치를 자동 적용합니다.

**검증된 설치본:** 공식 Windows v0.5.54·v0.5.55·v0.5.63. 버전 번호로 고정 차단하지 않지만, 필수 연결 구조가 다르면 적용을 중단합니다. 설치 폴더 바깥에 `package.json`이 없어도 됩니다. 기존 소스 폴더 방식도 유지합니다.

## 수동 적용하기

자동 변경 감시가 실패했거나 패치를 직접 다시 적용하고 싶다면 **디노 패치 수동 적용** 버튼을 누릅니다. 관리자 엔진이 현재 원본의 파일·호환성·백업을 새로 검증한 뒤 안전한 경우에만 적용합니다. 이전에 직접 해제한 패치도 수동으로 다시 적용할 수 있습니다.

단, `PARTIAL_OR_UNKNOWN`, 원본 손상, 백업 불일치 또는 호출 계약 불일치를 버튼으로 강제 우회하지는 않습니다. 이때는 정확한 원인을 확인해야 합니다.

## 패치 해제하기

관리자에 항상 표시되는 **디노 패치 해제** 버튼을 누르고 확인합니다. 원본 파일을 안전하게 복원합니다.

## Beta 6로 업데이트하기

1. LilacAnime와 DinoPatch를 모두 종료합니다.
2. 기존 `DinoPatchManager/runtime` 폴더를 **반드시 보존**합니다. 이 폴더에 패치 상태 기록·원본 백업·관리자 데이터가 들어 있을 수 있습니다.
3. 새 ZIP의 `DinoPatchManager` 폴더에서 프로그램 파일을 교체하되, 기존 `runtime` 폴더를 삭제하거나 덮어쓰지 않습니다.
4. 관리자를 실행하고 **원본 다시 확인**을 선택해 상태를 읽습니다.

`INVALID_ARCHIVE`가 표시되면 설치 폴더의 `resources/app.asar`가 **일반 파일인지** 확인합니다. 폴더 또는 링크인 경우 정확한 유형과 위치가 진단에 표시됩니다. 자동 감시가 실패해도 수동 적용으로 독립 검사를 요청할 수 있지만, 실제 원본이 없거나 파일 형식이 잘못되었다면 안전을 위해 적용하지 않습니다. 파일을 강제로 복사하거나 원본 백업을 삭제하지 마세요.

## 알아둘 점

- 먼저 LilacAnime를 종료하세요.
- 오류가 뜨면 파일을 직접 수정하지 말고 **진단 정보**를 확인하세요.
- 수동 해제 후에는 같은 원본에 자동으로 다시 적용되지 않습니다. **디노 패치 수동 적용** 버튼을 누르면 새 안전 검사 후 다시 적용할 수 있습니다.
- **[0.1.0 Beta 6 ZIP 다운로드](https://github.com/dinoforge/lilac-dino-patch/releases/tag/dino-v0.1.0-beta.6)** — 비공개 저장소에 접근 권한이 있어야 다운로드할 수 있습니다.

[공식 LilacAnime](https://github.com/whispelyn-byte/LilacAnime-desktop) · [LilacAnime DinoPatch GitHub](https://github.com/dinoforge/lilac-dino-patch)
