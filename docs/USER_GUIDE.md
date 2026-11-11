# LilacAnime DinoPatch 사용법

LilacAnime DinoPatch는 **LilacAnime에 통합 검색 기능을 추가하는 Windows 프로그램**입니다.

## 설치하기

1. 배포 ZIP을 압축 해제합니다.
2. **DinoPatchManager** 폴더에서 **LilacAnime-DinoPatch.exe**를 실행합니다.
3. **원본 폴더 변경**에서 공식 **LilacAnime 설치 폴더**(`LilacAnime.exe`가 있는 폴더)를 선택합니다.
4. 관리자가 설치 폴더의 `resources/app.asar` 내부 파일과 호출 계약을 검사하고, 구조가 호환되면 원본을 백업한 뒤 패치를 자동 적용합니다.

**검증된 설치본:** 공식 Windows v0.5.54·v0.5.55·v0.5.63. 버전 번호로 고정 차단하지 않지만, 필수 연결 구조가 다르면 적용을 중단합니다. 설치 폴더 바깥에 `package.json`이 없어도 됩니다. 기존 소스 폴더 방식도 유지합니다.

## 패치 해제하기

관리자에 항상 표시되는 **디노 패치 해제** 버튼을 누르고 확인합니다. 원본 파일을 안전하게 복원합니다.

## 알아둘 점

- 먼저 LilacAnime를 종료하세요.
- 오류가 뜨면 파일을 직접 수정하지 말고 **진단 정보**를 확인하세요.
- 수동 해제 후에는 같은 원본에 자동으로 다시 적용되지 않습니다. 현재 버전에는 **다시 적용 버튼이 없습니다.**
- **[0.1.0 Beta 4 ZIP 다운로드](https://github.com/dinoforge/lilac-dino-patch/releases/tag/dino-v0.1.0-beta.4)** — 비공개 저장소에 접근 권한이 있어야 다운로드할 수 있습니다.

[공식 LilacAnime](https://github.com/whispelyn-byte/LilacAnime-desktop) · [LilacAnime DinoPatch GitHub](https://github.com/dinoforge/lilac-dino-patch)
