# Product

<!-- impeccable:product-schema 1 -->

## Platform

Windows desktop (Windows 10/11). Android is a later phase; macOS and Chrome are out of the current scope.

## Users

애니메이션을 검색하고, 작품별 회차와 자막을 선택해 Windows 데스크톱에서 감상하려는 사람. LilacAnime의 익숙한 정보 구조를 바탕으로 하되 Windows에서 불편한 탐색·재생 흐름은 개선한다.

## Product Purpose

한국어 제목 검색, 최신 회차·요일표·분기별 목록 탐색, 회차 선택, 한국어 자막 적용, 재생, 이어보기와 보관함 관리를 한 Windows 앱에서 제공한다. 다음 회차는 사용자가 직접 선택한다.

## Positioning

Linkkf, 애니24, Animenosub, RE:Anime, Miruro에서 작품과 회차를 찾고, 자막 출처를 선택해 재생하는 Windows 우선 LilacAnime 기반 앱이다. LinkAni는 제외한다.

## Operating Context

Windows 데스크톱에서 마우스와 키보드로 사용한다. 홈에는 이어보기, 최신 방영 회차, 요일별 방영표와 1~4분기 목록을 둔다. 외부 서비스의 가용성과 응답 구조는 바뀔 수 있으며 실제 응답·콘텐츠는 허가가 확인된 뒤 검증한다.

## Capabilities and Constraints

- 콘텐츠 소스: Linkkf, 애니24, Animenosub, RE:Anime, Miruro. LinkAni는 지원하지 않는다.
- 작품 검색·상세·회차와 최신 회차·요일·분기 목록, 보관함·시청 기록·이어보기.
- 제목 매칭은 TMDB(사용자 키 선택) → AniList → Wikidata 순으로 시도한다. 실제 매칭 정확도는 별도 확인이 필요하다.
- 자막 경로: 사이트 트랙, Linkkf, Kairan, Csora, Anissia, Jimaku, 사용자 파일 및 ChatGPT 수동 복사·붙여넣기 번역. 후보가 정확한 회차·시즌·영상판과 일치하는지는 실제 자료로 확인해야 한다.
- 번역 API와 로컬 AI는 선택 기능이다. API 키 없는 ChatGPT 수동 번역도 제공한다.
- 재생 속도·화질·자막 크기·위치·스타일·수동 싱크, 탐색 간격, OP/ED 도구, 다운로드와 이어보기를 지원한다. 다음 화는 자동 재생하지 않는다.
- 외부 서비스의 가용성·이용 조건은 앱이 통제하지 못한다. 코드와 콘텐츠 출처의 권한이 확인되지 않아 프로젝트를 비공개로 두고 공개 배포하지 않는다.
- 앱 업데이트 피드는 자체 릴리스 승인 전까지 비활성이다. 확인·다운로드·설치가 자동으로 진행되지 않는다.
- Android 앱과 기기 간 동기화는 현재 제공하지 않는다.

## Brand Commitments

개발 표시는 LilacAnime Player로 쓴다. 라일락 `#C8A2C8`을 주 강조색으로 사용하고 한국어 UI를 제공한다.

## Evidence on Hand

- Electron 앱: `electron/`, `src/`
- 자동 회귀 테스트: `tests/`
- 요구사항·권리·Phase 1 상태: `docs/`, `WORK_STATE.md`
- 원본 Android 소스는 이 저장소에 포함하지 않는다. 실제 외부 서비스 응답 외에 성능 또는 가용성에 대한 보장 자료는 없다.

## Product Principles

- Windows에서 핵심 탐색·재생 기능을 쉽게 찾을 수 있어야 한다.
- 외부 서버 장애가 앱 전체 장애가 되지 않아야 한다.
- 재생 중 인터페이스는 영상과 자막을 방해하지 않아야 한다.
- 사용자 기록과 설정은 로컬에 남고 다시 시작해도 복구되어야 한다.
- 권한과 출처가 분명한 콘텐츠만 사용하도록 상태와 책임 범위를 명확히 알린다.
- 실제 공급원과 이용 권한을 확인하기 전에는 콘텐츠를 내려받거나 프로젝트를 공개 배포하지 않는다.

## Accessibility & Inclusion

키보드와 마우스를 지원한다. 화면 읽기 도구·대비·축소 애니메이션은 별도 점검 항목으로 남긴다.
