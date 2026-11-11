# 공식 LilacAnime Desktop와의 업스트림 연결

## 관계

- 공식 원본: [whispelyn-byte/LilacAnime-desktop](https://github.com/whispelyn-byte/LilacAnime-desktop) (Public)
- 디노 패치: [dinoforge/lilac-dino-patch](https://github.com/dinoforge/lilac-dino-patch) (Private)
- 디노 패치는 독립적인 **비공식 소스 패치 관리자**입니다. 원본 프로젝트의 공식 릴리즈, 협력 제품 또는 대체 애플리케이션이라는 뜻이 아닙니다.
- 원본의 홈·주간표·상세·회차·재생 흐름을 최대한 유지한 기능적 연동을 추구합니다. 원본 저장소와 Git 이력을 합치는 작업은 아닙니다.

## 로컬 Git remote 연결 (선택)

원본 코드에 대한 접근을 추적하려는 *새 격리 clone*에서만 다음을 실행합니다.

```powershell
git remote -v
git remote add upstream https://github.com/whispelyn-byte/LilacAnime-desktop.git
git remote -v
```

이미 `upstream`이 있다면 주소를 먼저 비교하고 무조건 덮어쓰지 않습니다. `upstream` remote는 로컬 Git 설정이므로 GitHub 저장소 화면에 공식 Fork 배지를 만들지 않습니다. GitHub의 기존 독립 저장소를 공식 Fork처럼 표시하거나 강제로 Git 이력을 합치지 않습니다.

원본 변경을 확인할 때에는 별도 격리 작업공간에서 `git fetch upstream` 후 upstream 커밋/태그의 Git blob, root tree, 공식 앱 API 계약을 검사합니다. 원본 HEAD가 바뀌었다는 이유만으로 디노 패치를 자동 적용하거나 안전 검사를 완화하지 않습니다. 실제 사용자 checkout에서 `fetch`, `merge`, `rebase` 또는 `reset`을 자동 실행하지 않습니다.

## 검증에 사용한 원본

- 공식 LilacAnime Desktop v0.5.58 커밋: [`e2a28266b0ee9c9391bdf41801e39fd5342c7b3c`](https://github.com/whispelyn-byte/LilacAnime-desktop/commit/e2a28266b0ee9c9391bdf41801e39fd5342c7b3c)
- 공식 root tree: `638476606f3d4a2712c5cfbe4c1013cbcb78c14e`
- Git 객체에서 추출한 공식 파일 170개를 기준으로 한 엔진 적용·복원 계약이 검증됐습니다. 이 검증은 모든 공식 최신 버전 또는 실제 사용자 설치본에 대한 호환성 보장을 뜻하지 않습니다.
- `core.autocrlf=true`인 Windows checkout에서는 공식 blob과 작업 파일의 LF/CRLF 바이트가 달라질 수 있습니다. 임의로 지문 검사를 비활성화하지 말고 정확한 Git 객체를 기준으로 구분합니다.

## 외부 배포와 권리

원본 링크를 추가하는 것은 수정·재배포·상표·에셋·외부 콘텐츠에 대한 허가가 아닙니다. 별도의 배포 승인을 확인하고 [권리 검토](RIGHTS_REVIEW.md)와 [베타 릴리즈 설명 초안](releases/dino-v0.1.0-beta.1.md)을 따릅니다. GitHub에서 실제 Release가 게시되기 전에는 다운로드 URL을 주장하지 않습니다.
