# LilacAnime DinoPatch

LilacAnime DinoPatch는 공식 LilacAnime 앱과 별도로 동작하는 **비공식 Windows x64 패치 관리자**입니다. 이 저장소에는 upstream LilacAnime 앱 소스도 포함되어 있으므로, DinoPatch 관리자 버전과 LilacAnime 앱 버전을 혼동하지 마세요.

## Beta 9 상태

- 관리자 버전: `0.2.0-beta.9`
- 검증 기준 앱: LilacAnime Desktop v0.5.65의 공식 `app.asar`
- 신규 설치 지원 조합: `01`, `02`, `01+02`
- 패치 03 신규 적용: 성능 개선이 입증되지 않아 일시 중지
- 기존 03 포함 설치: 기록과 실제 파일이 검증되는 경우 상태 확인, 안전한 해제 또는 지원 조합으로 전환 가능

01은 통합 검색 및 공급원 선택 기능이고, 02는 명시적인 분류 근거를 사용하는 야애니 전용 탭입니다. 실제 공급원별 검색·상세·회차·재생과 02의 실제 자동 분류 정확도는 아직 완전히 검증되지 않았습니다. 검증되지 않은 LilacAnime 구조나 충돌 상태에는 관리자가 변경을 거부합니다.

## 설치 및 사용

1. 배포 폴더에서 `dino-native-manager.exe`와 `dino-native-updater.exe`를 같은 폴더에 둡니다.
2. LilacAnime를 완전히 종료합니다.
3. 관리자를 실행하고 `LilacAnime.exe`와 `resources/app.asar`가 들어 있는 **설치 폴더**를 선택합니다. 저장소나 개발 소스 폴더를 선택하지 마세요.
4. 먼저 상태를 확인합니다. 원본·버전·기록이 검증되지 않으면 적용이 차단됩니다.
5. 지원되는 패치를 선택하고 적용합니다. 자동 상태 검사는 읽기 전용입니다. 자동 적용은 사용자가 켠 경우에도 지원되는 확정 구성과 안전 검사에 한해서만 동작합니다.
6. 복구가 필요하면 기존 백업 목록과 복원 확인 절차를 사용합니다. 파일을 직접 바꾸거나 백업을 삭제하지 마세요.

자세한 내용은 [Beta 9 사용자 설명서](docs/USER_GUIDE.md)를 확인하세요.

## 업데이트와 배포

업데이트 확인은 고정된 GitHub 저장소의 Releases 정보를 사용하고, 다운로드한 파일의 SHA-256을 확인한 뒤 사용자 승인을 요구합니다. SHA-256 대조는 GitHub 릴리스 증명이나 코드 서명과 같은 의미가 아닙니다. 현재 공개 Releases에는 Beta 9보다 높은 호환 관리자 자산이 확인되지 않았으므로 온라인 Beta 9 업데이트를 사용할 수 있다고 보장하지 않습니다.

이 문서 작성 시점의 Beta 9 산출물은 **로컬 RC 후보**이며, 공개 릴리스가 아닙니다. 검증된 호환성이나 영상 재생·성능을 보장하지 않습니다. 실제 GUI 및 재생 확인도 별도로 기록해야 합니다.

## 공식 프로젝트

- [LilacAnime Desktop](https://github.com/whispelyn-byte/LilacAnime-desktop)
- [LilacAnime DinoPatch](https://github.com/dinoforge/lilac-dino-patch)

LilacAnime와 DinoPatch는 서로 다른 프로젝트입니다. DinoPatch는 비공식 도구이며 LilacAnime의 공식 배포물로 표시하지 마세요.
