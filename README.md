# LilacAnime DinoPatch

**LilacAnime DinoPatch**는 LilacAnime에 통합 검색 기능을 추가하는 **비공식 Windows x64 패치**입니다.

## 주요 기능

- 여러 공급원 통합 검색 및 선택
- 호환성 확인 후 패치 자동 적용 및 독립적인 수동 적용
- 패치 해제 및 백업 복원

## 사용 방법

1. LilacAnime를 종료합니다.
2. ZIP을 압축 해제하고 `DinoPatchManager` 폴더의 `LilacAnime-DinoPatch.exe`를 실행합니다.
3. **원본 폴더 변경**에서 `LilacAnime.exe`와 `resources/app.asar`가 있는 **공식 설치 폴더**를 선택합니다.

**호환성:** 특정 버전 번호만으로 차단하지 않습니다. 설치본의 `app.asar` 내부 실제 파일·호출 계약을 검사한 뒤 호환성이 확인되면 백업 후 적용합니다. 공식 Windows **v0.5.54·v0.5.55·v0.5.63**에서 패치·원복·실행 검사를 통과했습니다. 검증되지 않은 변경 구조에는 적용하지 않습니다. 기존 소스 폴더 방식도 지원합니다.

> **Beta 7:** `app.asar`가 폴더처럼 잘못 배치된 경우 반복 감시 경고를 멈추고, 원본 파일이 아닌 이유를 표시합니다. 중단된 패치 기록은 정상 ASAR와 보존된 원본 백업의 SHA-256이 모두 일치할 때만 **복구 기록 확인**으로 정리할 수 있습니다. 원본 앱과 백업을 강제로 수정하지 않습니다.

[간단한 사용자 설명서](docs/USER_GUIDE.md) · [공식 LilacAnime Desktop](https://github.com/whispelyn-byte/LilacAnime-desktop)

> **[LilacAnime DinoPatch 0.1.0 Beta 7 다운로드](https://github.com/dinoforge/lilac-dino-patch/releases/tag/dino-v0.1.0-beta.7)** · 비공식 독립 패치입니다. 현재 비공개 저장소이므로 접근 권한이 있는 GitHub 계정만 파일을 받을 수 있습니다.
