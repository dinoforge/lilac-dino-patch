# 라일락 디노 패치

**Lilac Dino Patch**는 공식 LilacAnime Desktop에 통합 검색 기능을 추가하는 **비공식 Windows x64 패치 관리자**입니다. 원본 앱의 상세 화면, 회차 선택, 플레이어 흐름을 유지하면서 패치를 관리합니다.

## 주요 기능

- 여러 공급원 통합 검색 및 작품별 공급원 선택
- 지원되는 공식 소스에 패치 자동 적용
- 변경 파일 백업, 패치 해제 및 안전한 복원
- 공식 소스 변경 감지와 호환성 확인

## 설치 및 사용

1. 공식 LilacAnime를 종료합니다.
2. 배포 ZIP의 `DinoPatchManager` 폴더를 공식 **소스 폴더**에 넣습니다.
3. `디노패치관리자.exe`를 실행합니다.
4. 원본 경로를 확인하면, 호환되는 소스에 패치가 자동 적용됩니다.

**소스 폴더**에는 `package.json`, `src/`, `electron/`이 있어야 합니다. 일반 설치 폴더만으로는 사용할 수 없습니다.

자세한 사용법: **[간단한 사용자 설명서](docs/USER_GUIDE.md)**

## 현재 상태

- **GitHub 다운로드용 Windows ZIP은 아직 출시되지 않았습니다.**
- 공식 LilacAnime v0.5.58은 주요 검증 기준이며, 모든 버전과 공급원의 동작을 보장하지 않습니다.
- 현재 `main`에는 이전 앱 코드가 남아 있습니다. 최신 관리자 변경과 통합 검토 내용은 별도 개발 브랜치에 있으며, `main`의 빌드 워크플로는 디노 패치 관리자용이 아닙니다.
- 공개 배포는 코드·에셋·의존성의 재배포 조건 확인 후 진행합니다.

## 관련 링크

- [공식 LilacAnime Desktop](https://github.com/whispelyn-byte/LilacAnime-desktop)
- [사용자 설명서](docs/USER_GUIDE.md)
- [제품 소개](PRODUCT.md) · [UI 디자인](DESIGN.md) · [권리 검토](docs/RIGHTS_REVIEW.md)

> 이 프로젝트는 LilacAnime 공식 개발팀과 제휴하지 않은 독립 패치 관리자입니다.
