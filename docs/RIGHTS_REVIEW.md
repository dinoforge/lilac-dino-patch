# 코드·영상·자막 이용 조건 점검

검토일: 2026-10-09

이 문서는 저장소의 코드와 현재 연결된 외부 공급원에 대해 공개적으로 확인 가능한 근거를 모은 기록이다. 법률 자문이나 권리자 허가가 아니며, 확인되지 않은 조건을 허용으로 간주하지 않는다. 사이트에 로그인하거나 권리자에게 연락하지 않았고, 실제 영상·자막 파일을 내려받지 않았다.

## 현재 판정

- 프로젝트를 비공개로 유지하고 로컬 개발을 계속할 수는 있지만, 공개 저장소 전환·설치 파일 배포·외부 서비스에 번들 업로드를 승인할 근거는 아직 충분하지 않다.
- 영상, 자막, 포스터를 앱이나 설치 파일에 넣지 않는다. 사용자의 로컬 재생·다운로드 기능도 실제 공급원 조건을 확인하기 전까지 배포 승인 근거로 보지 않는다.
- 업스트림 README에는 원작자 허락을 받아 데스크톱 포팅을 했다는 설명이 있다. 이는 포팅 저장소 관리자의 설명이다. 원작자의 허락 문서와 허락 범위(파생 코드, 에셋, 재배포, 상표)는 독립적으로 확인하지 않았다.

## 코드와 에셋

현재 프로젝트 `package.json`은 MIT를 선언하지만, 저장소에 `LICENSE`, `COPYING`, `NOTICE` 파일은 없다. 업스트림 `whispelyn-byte/LilacAnime-desktop` README는 `dream150/LilacAnime` 원작자의 허락을 받아 데스크톱으로 포팅했다고 적는다. 이 설명은 확인 근거로 기록하되, 별도 라이선스 파일이나 허락 범위가 확인된 것으로 확대 해석하지 않는다.

재배포 전에 확인할 항목:

1. 원작자 또는 권리를 가진 업스트림 관리자가 이 저장소의 파생 코드와 수정본을 어떤 조건으로 배포할 수 있는지 서면으로 확인한다.
2. 로고, 아이콘, 스크린샷, 폰트, 원본 앱 에셋의 별도 권리와 필수 크레딧을 확인한다.
3. 각 npm 종속성의 개별 라이선스 고지와 번들 요건을 확인한다.

## 2026-10-10 원본 저장소 공개 라이선스 재확인

- GitHub 저장소 API의 `license.spdx_id`는 [LilacAnime Desktop](https://github.com/whispelyn-byte/LilacAnime-desktop)과 [Android 원본](https://github.com/dream150/LilacAnime) 모두 `null`이다. 데스크톱 `upstream/main`의 현재 트리와 Android 원본의 공개 루트 파일 목록에서 `LICENSE`, `COPYING`, `NOTICE`를 찾지 못했다.
- 데스크톱 업스트림 README에는 원작자의 허락을 받아 Electron 데스크톱으로 포팅했다고 적혀 있다. 이는 포크 관리자의 공개 설명으로 기록한다. 허락의 원문·대상 코드와 에셋·파생 수정본·재배포·상표 범위는 저장소에 공개돼 있지 않으며, 이번 확인으로 독립 검증하지 못했다.
- GitHub의 공개 라이선스 파일·메타데이터가 없다는 사실만으로 별도 서면 허락의 존재 여부를 판정할 수는 없다. 반대로 `package.json`의 `MIT` 표기만으로 upstream 원본과 에셋을 다시 배포할 권리가 생기지도 않는다. 범위가 확인되기 전까지 저장소 비공개와 설치 파일 미배포를 유지한다.

## 영상·작품 공급원

저장소의 활성 공급원 어댑터는 RE:Anime, Miruro, Animenosub, Linkkf, 애니24다. 아래의 사이트 소개나 도메인 확인 페이지는 사이트가 존재하거나 해당 주소가 공식이라는 근거일 뿐, 이 앱이 콘텐츠를 요청·재생·저장·재배포할 권리를 주는 자료는 아니다.

| 공급원 | 코드에서 확인한 주소·동작 | 공개 근거와 남은 확인 |
|---|---|---|
| RE:Anime | `reanime.to`에서 카탈로그·회차·영상 트랙을 조회한다. | 작품 페이지는 자체 서버가 파일을 저장하지 않고 제3자 호스트를 연결한다고 표시하며, Privacy·Terms 버튼도 있다. 이번 검토에서 약관 본문과 앱 연동 허용 범위는 확인하지 못했다. |
| Miruro | `www.miruro.to`에서 카탈로그·회차·서버 및 자막 트랙을 조회한다. | 공식 허브가 `miruro.to` 등 공식 도메인을 나열한다. 도메인 확인만으로 데이터 수집·스트림 재생·오프라인 저장 권한을 확인할 수 없다. |
| Animenosub | `animenosub.to`에서 카탈로그·회차·서버를 조회한다. | 공식 도메인 페이지는 `animenosub.to`를 공식 사이트로 표시하고, 사이트 파일을 저장하지 않으며 콘텐츠는 비계열 제3자가 제공한다고 적는다. 이는 앱 사용·복제 허가가 아니다. |
| Linkkf | `linkkf.app`과 별도 `5imgdarr.top` API 호스트를 통해 목록·회차·스트림을 요청한다. | 이번 검토에서 앱 연동이나 API 사용 조건을 확인하지 못했다. API 호스트와 웹사이트 운영 주체·관계도 별도 확인이 필요하다. |
| 애니24 | `ohli24.net`에서 목록·회차·플레이어 페이지를 요청한다. | 이번 검토에서 앱 연동, 스트림 사용, 오프라인 저장 조건을 확인하지 못했다. |

## 자막 공급원

| 공급원 | 코드에서 확인한 동작 | 공개 근거와 남은 확인 |
|---|---|---|
| Re:Anime·Miruro·Linkkf 자막 트랙 | 공급원이 영상과 함께 제공하는 트랙을 읽고 선택·저장한다. | 영상 공급원 권리 상태와 별개로 각 자막의 재사용·저장 허용 범위가 확인되지 않았다. |
| Kairan·Csora | Blogger 게시물에서 회차별 링크를 찾아 외부 파일과 이미지 기반 자막을 검색해 로컬에 저장한다. | 공개 안내는 확인했다. Csora 프로필은 자막으로 돈을 벌거나 제작자를 사칭하지 말라고 당부한다. Kairan 게시물에는 작업을 언제든 그만둘 수 있다는 설명과 Google Drive 링크가 보인다. 두 안내는 앱의 자동 수집·저장·변환·재배포 권한이나 개별 파일 라이선스를 명시하지 않는다. 출처 표시는 허가를 대체하지 않는다. |
| Anissia | `api.anissia.net` 편성·제작자 정보를 이용하고 등록된 제작자의 외부 블로그를 찾는다. | API 이용 조건 및 개별 제작자 자막 허가를 확인하지 못했다. 검토 당일 공식 사이트 일부 페이지가 서버 연결 실패를 표시했다. |
| Jimaku | `jimaku.cc`에서 일본어 자막 목록을 보여 주고 사용자가 고른 파일을 내려받는다. | 공식 도움말은 업로드·파일명 지침과 Kitsunekko에서 자동 수집한 일부 파일을 언급한다. 도움말은 콘텐츠 재배포 라이선스가 아니다. 파일별 권리와 번역·저장·공유 허가는 확인되지 않았다. |

앱이 외부 자막을 로컬에 저장하고 오프라인 사용을 지원한다는 제품 동작은 그 파일의 복제·배포 허가를 의미하지 않는다. 허가가 확인되지 않은 자막을 저장소, 설치 파일, 릴리스에 포함하지 않는다.

## 배포 전 확인 절차

1. 원본 코드·에셋의 재배포 범위를 확인하고 저장소에 적절한 라이선스·고지를 둔다.
2. 각 영상 공급원에 대해 공식 약관/API 조건, 자동 요청 허용, 캐시·오프라인 저장 허용을 확인한다. 확인되지 않으면 해당 공급원과 기능을 배포 범위에서 제외한다.
3. 자막 제작자 또는 권리자가 명시한 다운로드·개인 이용·번역·재배포 범위를 따로 확인한다. 권한이 없는 자막은 번들하지 않는다.
4. Jikan·AniSkip 등 작품 정보·보조 API의 별도 이용 조건을 공개 배포 전에 검토한다. TMDB의 현재 API 조건, 크레딧 요건, 캐시 한도는 2026-10-09에 확인했고 아래에 기록했다. AniList는 홈의 최신 방영 회차를 표시할 때 현재 RE:Anime·Miruro 목록에 있는 AniList ID를 보내 최근 방영 일정을 조회한다. 콘텐츠 파일은 요청하지 않는다. 본 앱이 AniList의 보완 서비스 조건에 해당하는지는 불명확하므로 공개 전에 확인하거나 해당 연동을 제외한다.
5. 권리 확인 전에는 저장소를 비공개로 유지하고 설치 파일을 외부에 배포하지 않는다. 권리자에게 문의할 때는 사용자가 별도로 승인해야 한다.

## 확인한 1차 자료

- [LilacAnime 데스크톱 업스트림 저장소](https://github.com/whispelyn-byte/LilacAnime-desktop) 및 [README의 포팅 허락·크레딧 설명](https://github.com/whispelyn-byte/LilacAnime-desktop/blob/main/README.md)
- [RE:Anime 작품 페이지 예시](https://reanime.to/anime/smoking-behind-the-supermarket-with-you-skykax)
- [Miruro 공식 도메인 안내](https://www.miruro.com/)
- [Animenosub 공식 도메인 안내](https://animenosub.com/)
- [Anissia](https://anissia.net/)
- [Jimaku 도움말과 업로드 지침](https://jimaku.cc/help)
- [Kairan](https://kairan03.blogspot.com/), [Csora](https://csora556.blogspot.com/)

## 2026-10-09 추가 확인

- Re:Anime 작품 페이지는 서버에 파일을 저장하지 않고 제3자 서비스가 호스팅하는 미디어로 연결한다고 표시한다. 페이지에 Privacy·Terms 버튼은 있으나, 이번 확인에서는 약관 본문과 외부 앱 연동·재생·다운로드 허용 범위를 읽을 수 있는 자료를 확보하지 못했다. 사이트가 외부 호스트를 연결한다는 설명은 이 앱에 대한 허가로 보지 않는다.
- Miruro 공식 안내는 공식 도메인 목록과 팬이 만든 무료 스트리밍 허브라는 소개를 제공한다. 앱 연동, 자동 요청, 저장 또는 재배포를 허용한다는 조항은 해당 안내에서 확인되지 않았다.
- Animenosub 공식 도메인 안내는 `animenosub.to`만 공식 사이트라고 하고, 다른 도메인·앱·이름으로 운영하지 않는다고 명시한다. 또한 자체 서버에 파일을 저장하지 않고 콘텐츠는 비계열 제3자가 제공한다고 설명한다. 이 내용은 본 프로젝트 앱에 대한 승인을 뜻하지 않는다.
- 애니24 현재 홈페이지를 확인했으나, 이번 확인에서 앱 연동이나 저장을 허용하는 약관·라이선스 문구를 찾지 못했다. 이전에 파악한 제3자 링크 안내도 앱 사용 허가로 확대 해석하지 않는다.
- 업스트림 GitHub 저장소의 현재 루트 페이지에서 LICENSE 항목을 확인하지 못했다. README의 포팅 허락 설명만으로 소스 코드·수정본·에셋의 재배포 권한이 명확해지지는 않는다.
- AniList API 공식 이용 조건은 비상업적 사용을 허용하지만 대량 수집을 금지하고, 같은 성격의 비보완적 서비스(예: 애니·만화 목록/트래커)에 쓰는 것을 제한한다고 설명한다. 이 앱은 플레이어에 더해 작품 목록과 시청 기록 기능도 가지므로, 현재의 방영 일정 조회가 허용 범위인지 문서만으로 확정할 수 없다. 현재 구현은 전체 카탈로그 수집 대신 선택된 작품의 최근 방영 정보를 조회하는 범위로 제한하고, 공개 전에는 해당 사용의 보완성 여부를 추가 확인하거나 해당 연동을 제외한다.
- AniList 공식 제한 안내는 검토 당시 일시적인 저하 상태에서 분당 30회 제한(정상 기준은 90회)과 별도의 버스트 제한을 함께 명시한다. 모든 앱 내 GraphQL 호출은 한 요청 경로를 공유하며 시작 간격을 2.1초로 직렬화해 약 29회/60.9초로 유지한다. 어느 경로에서든 429를 받으면 `Retry-After`까지 다른 호출도 보류하고, 헤더가 없거나 잘못됐을 때는 60초를 기다린다. 최신 회차 화면은 저장된 결과가 있으면 계속 보여 준다. 문서는 버스트 제한 임계값을 공개하지 않으므로 이 간격이 모든 서버 정책에 맞는다고 보장할 수 없다. 대기 관리는 한 Electron 프로세스 안에서만 공유되며, 실제 공개 트래픽이나 별도 AniList 허가는 확인하지 않았다.
- TMDB 공식 FAQ는 비상업적 사용에 출처 표시를 요구하고 상업적 이용은 별도 라이선스 문의 대상으로 안내한다. 현재 API 약관은 TMDB 또는 API에서 얻은 정보를 6개월 넘게 캐시하지 못하게 하고, TMDB 공식 로고와 앱의 다음 고지를 요구한다: `This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.` 상업적 이용에는 별도 서면 계약이 필요하다. 약관은 TMDB API·콘텐츠를 AI 기반 애플리케이션과 연결해 사용하는 것도 제한한다. 본 앱에는 선택형 AI 자막 번역 기능이 있지만 번역 문맥은 별도 AniList 정보를 쓰며, TMDB 정보는 작품 화면에서 표시한다. 본 앱과 같은 결합이 허용되는지는 문서만으로 확정할 수 없어 공개 전에 TMDB의 서면 확인이 필요하다.
- 프로젝트의 공개·수익 사용은 결정하거나 허가받지 않았다. 이 캐시 만료·크레딧 변경은 API 조건 일부를 반영한 것이며, TMDB 또는 AniList의 앱별 사용 허가나 영상·자막 권리를 뜻하지 않는다.
- 코드의 작품 정보 캐시를 API 약관의 6개월 한도보다 짧게 제한했다. 한국어 제목 후보 30일, 일반 표시 제목 7일, 작품 목록의 한국어 제목 30일, 한국어 줄거리 최대 30일(미발견은 7일), 다운로드 작업에 덧붙인 한국어·영어 표시 제목 30일이다. 만료·날짜 없는 이전 제목 캐시와 다운로드 작업의 제목 메타데이터는 다시 조회하도록 정리하지만, 다운로드 항목·영상·자막 경로 등 기록의 나머지는 유지한다.
- 이전에는 TMDB 사용 고지가 한국어 제목 설정 안에만 있고 더 오래된 문구였으며 공식 로고는 없었다. 이제 TMDB의 공식 승인 SVG를 수정 없이 포함하고, Settings > About에 로고와 현재 약관 문구를 표시한다. TMDB 출처 표시만으로 작품·영상·자막의 권리 문제가 해결되지는 않는다.

이번 추가 확인에서도 외부 영상·자막·작품 공급원, 원본 에셋, AniList 사용에 대한 프로젝트별 허가를 확보하지 않았다. 저장소와 설치 파일은 계속 비공개·미배포로 둔다. 권리자에게 문의하지 않았다.

추가로 확인한 1차 자료:

- [Re:Anime 작품 페이지 예시](https://reanime.to/anime/marriagetoxin-6m8dw5)
- [Miruro 공식 도메인·소개 페이지](https://www.miruro.com/)
- [Animenosub 공식 도메인 안내](https://animenosub.com/)
- [애니24 홈페이지](https://www.ohli24.net/)
- [LilacAnime 데스크톱 업스트림 저장소](https://github.com/whispelyn-byte/LilacAnime-desktop)
- [AniList API 이용 조건](https://anilist.gitbook.io/anilist-apiv2-docs/docs/guide/terms-of-use)
- [AniList API 요청 제한 안내](https://anilist.gitbook.io/anilist-apiv2-docs/docs/guide/rate-limiting)
- [TMDB API 이용 약관](https://www.themoviedb.org/api-terms-of-use)
- [TMDB 개발자 FAQ — attribution 및 상업적 이용](https://developer.themoviedb.org/docs/faq)
- [TMDB 공식 로고 및 크레딧 지침](https://www.themoviedb.org/about/logos-attribution)
- [TMDB 공식 승인 primary full blue SVG](https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg)

## 2026-10-09 공식 조건 재확인 및 코드 대조

- Re:Anime의 [Terms and Conditions](https://reanime.to/terms)를 사이트 작품 페이지의 Terms 버튼을 통해 직접 열어 읽었다. 2항은 개인·비상업적·일시적 시청을 위한 임시 1부 다운로드만 허용한다고 적고, 자료의 수정·복사, 상업적 이용·공개 전시, 사이트 소프트웨어 역공학, 권리 표시 제거, 다른 사람에게 이전하거나 다른 서버에 미러링하는 것을 금지한다. 약관은 사이트가 사전 통지 없이 변경할 수 있다고 적는다. 별도 앱 연동·자동 조회·캐시·오프라인 보관의 허용 범위는 명시적으로 확인되지 않았다. 페이지가 제3자 미디어를 링크한다는 안내도 이 프로젝트의 앱 사용 권한을 주지 않는다.
- AniList의 [API 이용 조건](https://anilist.gitbook.io/anilist-apiv2-docs/docs/guide/terms-of-use)을 다시 열어 확인했다. 비상업적 이용은 허용한다고 설명하지만, API 데이터의 보관·대량 수집과 AniList가 보완적이지 않다고 판단하는 동종 서비스(예: 애니·만화 목록/추적 서비스)에서의 이용을 제한한다. 월 수익 150달러 초과 상업 서비스는 상업 라이선스가 필요하다고 적는다. 현재 앱은 작품 목록·시청 기록도 제공하고 선택 작품의 방영 정보를 조회하므로, 보완 서비스인지 약관만으로 확정하지 않는다.
- AniList의 [요청 제한 안내](https://anilist.gitbook.io/anilist-apiv2-docs/docs/guide/rate-limiting)는 현재 일시 제한 30회/분, 정상 기준 90회/분, 별도 버스트 제한과 `Retry-After`를 안내한다. 코드의 공통 요청 간격 2.1초는 시작 간격상 약 29회/분으로 제한하지만, 실제 서버의 버스트 정책·실사용 부하는 확인하지 않았다.
- TMDB 공식 API 약관 URL은 이번 브라우저 열기에서 robots 정책으로 직접 읽을 수 없었다. 검색 가능한 TMDB 공식 약관 본문은 6개월을 넘는 캐시와 AI/ML 기반 애플리케이션과 연결한 API·콘텐츠 사용을 금지한다고 표시한다. 공식 [개발자 FAQ](https://developer.themoviedb.org/docs/faq)는 비상업적 사용의 출처 표시, 승인된 TMDB 로고와 About/Credits 고지, 상업 사용 라이선스를 안내한다. FAQ의 고지 예문과 API 약관에 표시된 문구는 서로 다르게 나타나므로 현재 앱에는 API 약관의 더 구체적인 문구를 유지한다. 약관 본문을 직접 다시 읽지 못한 한계는 남긴다.
- 코드 대조: `electron/main.cjs`의 `tmdbOverview()`는 TMDB 줄거리를 조회·캐시한다. 별도 `translationContext()`는 공급원 작품 제목과 AniList의 인물·장르·줄거리를 사용하며 TMDB 응답을 조회하거나 포함하지 않는다. 이 경로 확인은 TMDB 데이터를 번역 프롬프트로 직접 넘기지 않는다는 점만 보여 준다. 약관의 “AI 기반 애플리케이션과 연결” 제한이 같은 앱 안의 별도 기능에도 적용되는지는 문서와 코드만으로 확정할 수 없으므로, TMDB 또는 AI 번역 중 하나를 공개 빌드에서 제외하거나 TMDB의 서면 확인을 받기 전에는 공개 배포하지 않는다.
- 이번 재확인에서도 권리자에게 연락하거나 실제 영상·자막 파일을 요청·저장하지 않았다. 공급원·업스트림 코드·에셋·자막의 프로젝트별 허가를 받지 않았으므로 비공개 개발만 계속한다.

## 2026-10-09 의존성·내장 자산 확인

- 잠금 파일의 프로덕션 의존성 폐쇄 45개를 조사했다. `parse-cache-control@1.0.1`은 라이선스 메타데이터가 없지만 로컬 `LICENSE` 파일이 있다. 상세 패키지 목록은 [`DEPENDENCY_LICENSE_INVENTORY.md`](DEPENDENCY_LICENSE_INVENTORY.md)에 기록했다. 이 목록은 메타데이터 인벤토리이며 법률 검토 완료나 전체 개발 도구 감사가 아니다.
- `ffmpeg-static@5.3.0` 바이너리는 앱 패키지에서 `asarUnpack`되며, 현재 Windows README는 Gyan.dev FFmpeg 6.1.1 essentials, GPL v3 및 소스 커밋을 명시한다. 코드에서 다운로드 remux와 OP/ED 지문 생성에 사용한다. 정확한 대응 소스·고지·배포 의무를 검토하기 전에는 설치 파일을 공개하지 않는다. 이 사실만으로 앱 전체의 라이선스 결론을 내리지는 않는다.
- 동봉 README는 정확한 FFmpeg 커밋 `e38092ef93`, 정적 GPLv3 구성, 외부 라이브러리 버전 목록과 `libx264`·`libx265`를 기록한다. 현재 `node_modules`와 unpacked 앱의 FFmpeg 실행 파일은 SHA-256이 같고, 실행 파일·README·GPL 고지 파일이 함께 들어 있다. 앱 패키지에는 대응 소스 아카이브와 전체 Gyan 빌드 레시피 및 외부 라이브러리 source snapshot/patch가 없으므로 이 자료만으로 완전한 재현 빌드나 재배포 조건을 확정할 수 없다. Gyan 공식 안내는 Windows 빌드를 정적 GPLv3로 표시하고, FFmpeg 공식 안내는 GPL 구성요소가 포함된 FFmpeg 전체에 GPL이 적용된다고 설명한다. 이는 별도 FFmpeg 프로세스를 포함한 Electron 앱 전체의 라이선스 결론을 대신하지 않는다.
- BtbN의 2026-10-08 Windows x64 LGPL shared FFmpeg 9.0.2와 8.1.3 후보를 임시 폴더에서 확인했다. 두 고정 릴리스 아카이브 모두 SHA-256이 GitHub API digest와 릴리스 checksum에 일치했고, `-L`은 LGPL 3 이상을, 빌드 설정은 `libx264`·`libx265` 비활성화를 표시했다. 합성 HLS→MP4 remux와 시작·끝 오디오 PCM 디코딩은 동작했다. 9.0.2와 8.1.3의 전체 `bin`은 각각 176,381,440바이트와 186,729,472바이트로 기존 정적 실행 파일보다 크며 최소 DLL 집합은 산정하지 않았다. 두 아카이브는 LGPL 문구와 헤더·라이브러리를 담지만 C/C++ 소스는 없어, 정확한 본체·외부 라이브러리 소스·패치·고지와 빌드 입력은 여전히 별도 확인 대상이다. 후보는 프로젝트 의존성으로 채택하지 않았고, 실제 공급원이나 설치 앱에서 시험하지 않았다. 상세 기록은 [`DEPENDENCY_LICENSE_INVENTORY.md`](DEPENDENCY_LICENSE_INVENTORY.md)에 있다.
- JASSUB npm `2.5.16`의 복합 SPDX metadata와 MIT `LICENSE`만으로 번들에 포함된 libass/WASM 구성요소의 전체 고지를 확인할 수 없다. blob 비교는 `656371a`를 TypeScript·README·LICENSE와 WASM/font 내용의 강한 출처 후보로 지지하며 그 커밋의 다섯 submodule SHA도 식별했다. 그러나 npm `gitHead`/provenance attestation은 없고, upstream license generator가 포함 목록에 넣은 Expat은 해당 commit의 `.gitmodules`에 없다. 추가 대조에서 upstream Makefile은 `expat` submodule metadata를 요구하지만 `.gitmodules`와 `license_defaults` 양쪽에 Expat 정의가 없는 것을 확인했다. 추출 script도 source directory와 `licensecheck`가 필요하므로 선언된 submodule만으로는 재현 가능한 고지 생성 경로가 없다. 이는 Expat 코드가 WASM에 들어 있다는 증거가 아니다. JASSUB vendor build는 MIT `LICENSE`를 `app.asar`에 넣고 `package.json`은 Liberation Fonts OFL 1.1 notice를 사용자 열람이 쉬운 `resources/licenses`에 별도 텍스트로 넣도록 한다. 실제 JS/worker에는 법적 주석이 없으며 집계된 COPYRIGHT 파일도 없다. main/worker bundle에 포함되는 `abslink@1.3.0`, `throughput@1.0.2`, `lfa-ponyfill@1.1.1`은 로컬 npm 패키지에 SPDX metadata만 있고 별도 LICENSE/COPYING/NOTICE 본문이 없다. JASSUB의 기본 font는 WOFF2 메타데이터와 공식 Liberation Fonts 2.00.5 release의 TTF를 대조해 Liberation Sans 2.00.5로 식별했고, 저작권 표시 및 OFL 1.1 고지를 app resources에 별도 배치한다. 추가로 JASSUB entrypoint가 GPL-3.0 `rvfc-polyfill@1.0.8`을 import해 이전 번들에 포함했다. 앱은 Electron 38.8.6/Chromium 140에서 native API를 사용하도록 그 fallback을 alias하고 출력 bundle을 검사한다. 이 수정으로 해당 GPL 코드만 제외했으며 전체 JASSUB/전이 JS notice와 Expat 입력 출처는 여전히 미해결이므로 배포 전 차단 항목이다. 상세 SHA·비교·한계는 [`DEPENDENCY_LICENSE_INVENTORY.md`](DEPENDENCY_LICENSE_INVENTORY.md)에 기록했다.
- 로컬 AI 모델은 설치 파일에 포함되지 않고 사용자 데이터 폴더로 내려받는다. 정확한 HY-MT1.5 1.8B·7B 저장소의 `License.txt`는 EU·영국·대한민국을 적용 지역에서 제외한다. 두 모델은 앱의 기본 preset에서 다운로드와 실행을 차단하고, 이전에 내려받은 파일은 보존한다. 기존 설정이 해당 모델을 가리키면 앱에서 허용된 기본 모델로 대체해 사용하고 다음 설정 저장 때 반영한다. 사용자 임의 GGUF는 앱이 라이선스를 검증하지 않는다.
- Tencent 공식 Hy-MT2 1.8B·7B·30B-A3B GGUF snapshot에는 Apache-2.0 `LICENSE.txt`가 있고, Google Gemma 4 공식 모델 카드는 Apache 2.0을 표시한다. 앱의 8개 다운로드 가능 GGUF preset은 저장소 전체 commit SHA와 파일 SHA-256을 고정하며, 다운로드 바이트가 다르면 `.part`를 최종 파일로 설치하지 않는다. Aya Expanse GGUF는 고정 snapshot에서 CC-BY-NC-4.0을 선언한다. 앱 설정은 비상업 조건과 Cohere 약관 링크를 보여 주고 다운로드 전에 사용자의 확인을 받는다. 앱은 약관 열람·법적 동의나 사용 적격성을 확인·기록하지 않는다. `ja-ko-vn` GGUF와 두 기반 모델은 저장소 metadata/model card에서 Apache-2.0을 선언하지만 학습 대화 데이터 출처·권리는 공개 자료에서 확인하지 못했다. 기존에 설치된 모델 파일은 재해시하거나 교체하지 않는다.
- `src/logo.png`, `build/icon.png`, `build/icon.ico`의 SHA-256을 기록했지만 출처와 재배포 권한은 찾지 못했다. TMDB 공식 로고는 기존 크레딧 안내에 따라 별도로 기록돼 있다.
- 현재 unpacked 패키지에 Electron 및 Chromium 라이선스 파일이 존재하는 것을 확인했다. 향후 패키지마다 고지가 들어가는지는 빌드 산출물에서 재확인해야 한다.

이 권리 확인에 따른 변경은 `HY-MT1.5` 두 preset의 앱 내 다운로드·실행 차단과 지역 제한 안내, 나머지 preset 다운로드의 revision·SHA-256 고정이다. 사용자 데이터 폴더의 기존 모델 파일은 읽거나 수정·삭제하지 않았다. 로컬 실행 검증은 synthetic userData만 사용하며 실제 작품 영상·자막은 요청하거나 저장하지 않는다. 외부 배포와 공개 저장소 전환은 계속 보류한다.

## 2026-10-10 Anissia 공식 API 문서 확인

- 기존 `anissia-net/document` 주소는 현재 공식 [`anissia-net/anissia`](https://github.com/anissia-net/anissia) 저장소로 이동한다. 저장소 README는 애니시아 문서 프로젝트와 편성표 API 문서를 안내하고 서드파티 프로젝트 하나를 참고 사례로 연결하지만, 이 설명은 API 또는 자막 콘텐츠의 사용 허가로 적혀 있지 않다.
- 공식 [편성표 API 문서](https://github.com/anissia-net/anissia/blob/master/docs/anime_schdule.md)는 편성 목록 경로와 `animeNo`를 이용한 회차 자막 정보 경로를 정의한다. 자막 정보 항목은 회차, 등록 시각, 외부 웹사이트 주소, 제작자 이름이다. 브라우저에서 CORS로 JavaScript 직접 요청을 권장한다고 설명한다.
- 같은 문서는 편성 응답의 `captionCount`가 약 5분 단위로 캐시되어 실시간 자막 정보와 차이가 날 수 있고 사용을 권장하지 않는다고 명시한다. 앱에서 회차별 자막 존재 여부를 이 캐시된 집계값으로 판단하지 않고, 자막 정보 응답의 실제 항목을 조회한다.
- 검토한 README와 API 문서에는 API 사용 조건, 자막 파일의 다운로드·보관·번역·재배포 허가가 명시돼 있지 않다. CORS 허용과 직접 요청 안내는 기술적 접근 방법이지 이용 허가로 간주하지 않는다. 제작자 블로그에 연결되는 각 자막의 권리도 별도 확인 대상이다.
- 이번 확인은 공개 공식 문서만 읽었고 API를 호출하거나 자막을 내려받지 않았다. 앱 연동과 개별 자막 사용 권리는 미확인 상태로 유지하며 비공개 개발·미배포 방침을 바꾸지 않는다.

## 2026-10-10 Kairan·Csora 공개 안내 확인

- [Kairan의 공개 게시물](https://kairan03.blogspot.com/2026/10/1.html)은 회차 게시물에 Google Drive 링크를 제공하고, 제작자가 작업을 언제든 그만둘 수 있다고 적는다. 해당 글에서 앱 연동·자동 수집·파일 보관·변환·재배포 허가를 확인하지 못했다.
- [Csora의 자막 게시물](https://csora556.blogspot.com/2026/10/blog-post_07.html)은 회차 자막과 폰트의 Google Drive 링크를 제공한다. 블로그 프로필은 자막으로 수익을 얻거나 제작자를 사칭하지 말라고 요청한다. [2026년 4분기 공지](https://csora556.blogspot.com/2026/09/20264.html)는 작업 목록만 안내하며 앱 연동이나 파일 사용 라이선스를 제시하지 않는다.
- 블로그에 링크가 공개돼 있고 개인 시청자에게 자막을 나눈다는 표현이 있더라도, 이 앱의 자동 검색·다운로드·오프라인 저장·동기화·번역·재배포 권한으로 확장 해석하지 않는다. 사용자·제작자에게 연락하거나 외부 Drive 파일을 열거나 내려받지 않았다. 공개 배포 전 개별 제작자와 파일의 허용 범위를 확인해야 한다.
