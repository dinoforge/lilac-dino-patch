# DinoPatch 작품 DB·최신 회차 안정화

이 변경은 기존 `feature/dino-manual-source-repair`을 기준으로 합니다.

## SQLite

- Electron `userData/dino-work-index.sqlite`는 계속 공식 LilacAnime 프로필 및 제목 파일과 분리됩니다.
- 작품 하나에 서로 다른 방영 연도, 작품 형식 또는 AniList/MAL ID가 명확히 충돌하는 공급원은 자동 연결하지 않습니다. 같은 공급원의 서로 다른 두 링크도 거절합니다.
- 저장된 상세 정보보다 정보가 적은 검색 카드는 기존 회차·방영상태 메타데이터를 지우지 않습니다.
- 기존 v1 메모리 캐시가 수동 분리 전의 묶음을 보유하더라도, 앱 재실행 시 SQLite의 최근 작품별 **정확한 공급원 소유권**으로 메모리 상태를 복원합니다. v1 캐시는 최초 동기화 중 즉시 덮어쓰지 않고 일반 지연 저장 절차를 따릅니다.
- 메모리의 1,800개 한도는 여전히 빠른 조회를 위한 캐시 용량입니다. SQLite 테이블의 전체 작품 한도는 아닙니다.

## 최신 회차

- 자동 확인은 방영 중인 작품에 대해서만 공급원 상세 응답을 사용합니다. 검색 목록의 추정 회차는 집계에 포함하지 않습니다.
- 같은 번호의 더빙/자막 회차는 하나로 계산하며, 특별편과 재생 불가 항목은 회차 수에서 제외합니다.
- 한국어 `제 12화`, 영어 `Episode 12`, 일본어 `第12話` 형식도 인식합니다. 번호가 없는 실제 재생 항목은 총편수에는 포함하되 최신 번호를 추정하지 않습니다.
- 세션당 8회/하루 18회 요청, 정상 상태 12시간 재확인, 오류 6시간 재시도 정책을 유지합니다. 하루 기준은 사용자 컴퓨터의 현지 날짜입니다.
- 다른 공급원의 기록과 수동 한국어 제목은 최신 회차 업데이트로 수정되지 않습니다.

## CI를 아끼는 로컬 테스트

```bash
node --check patches/patch03/dino-work-db.cjs
node --check patches/patch03/patch03-bridge.js
node --check src/integrated-search.js
node --check src/dino-sqlite-sync.js
node --test tests/dino-sqlite-compat.test.cjs tests/dino-manual-link.test.cjs tests/dino-episode-refresh.test.cjs
```

GitHub Actions는 자동 실행하지 않습니다. 통합 테스트를 수동 실행할 때는 기존 `test-dino-integrated-global.yml`을 사용할 수 있습니다.
