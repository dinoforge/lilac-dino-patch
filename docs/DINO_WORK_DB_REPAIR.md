# DinoPatch 작품 DB 공급원 연결 수정 (개발 브랜치)

SQLite 작품 인덱스는 공식 LilacAnime의 제목 캐시/설정 파일과 별도로 Electron userData의 `dino-work-index.sqlite`에 저장됩니다. 스키마 버전 2에서 수동 분리 기록이 추가되었고, 버전 3에는 연결 변경 및 수동 한국어 제목 이력·DB 검사 API가 추가되었습니다. 이전 스키마는 최초 시작 시 기존 작품 데이터를 보존하며 업그레이드합니다.

## 사용

1. 통합 검색에서 작품 상세 창을 열고 `공급원 연결 수정`을 선택합니다. SQLite가 동작하지 않는 구버전 환경에서는 수정 메뉴가 표시되지 않습니다.
2. 잘못 연결된 공급원에서 `이 작품에서 분리`를 누릅니다. 한 작품에서 마지막 한 공급원은 분리할 수 없습니다.
3. 다시 연결할 때는 수정하려는 공급원이 **먼저 작품 DB에 등록돼 있어야** 합니다. 다른 공급원을 통합 검색으로 조회한 뒤 해당 공급원과 검색 원본 ID(`mal_id`)를 지정해 연결합니다.
4. 연결 전에는 DB에 저장된 후보 작품을 제목으로 검색하고, 연결 미리보기에서 원본 제목·연도·형식을 확인합니다. 수정 후 화면을 새로 불러오며, 원래 사용자가 입력한 공통 한국어 작품명은 유지됩니다.
5. 제목 수정 창에서는 이전 제목을 불러올 수 있고, 연결 편집 화면에서 최근 수동 변경 이력을 확인할 수 있습니다.

연결 변경은 한 번의 SQLite 트랜잭션으로 처리됩니다. 원본 동영상·공식 실행 파일·ASAR·패치 백업은 수정하지 않습니다. 자동 검색 캐시가 과거의 잘못된 공급원 묶음을 다시 쓰려고 해도 수동 분리를 우선합니다. 다른 방영 연도, AniList ID, 작품 형식이 명확히 충돌하면 수동 연결도 거절합니다.

SQLite 이용 중에는 로컬 캐시의 1,000/1,600개 수집 상한을 전체 SQLite DB 상한으로 취급하지 않습니다. 기존 `localStorage`는 호환용 최신 캐시로 유지하며 더 오래된 작품은 SQLite에서 필요할 때 불러옵니다.

## 로컬 테스트

```bash
node --check patches/patch03/dino-work-db.cjs
node --check patches/patch03/patch03-bridge.js
node --check src/integrated-search.js
node --check src/dino-sqlite-sync.js
node --test tests/dino-manual-link.test.cjs tests/dino-sqlite-compat.test.cjs
```

Windows Rust 실행 파일 빌드와 GUI 서브시스템 검사 워크플로는 `workflow_dispatch`로만 실행됩니다. 개발 브랜치 코드 수정만으로 Windows CI를 실행하지 않습니다.
