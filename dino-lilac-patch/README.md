# 디노 라일락 패치 — 구조 1차 확정 (2026-10-11)

## GitHub issue #2 — 패치 02 보강 및 패치 03 통합 카탈로그

- `codex/issue-2-patch-02-03`에서 Patch 02 수동 ChatGPT 번역 결과 저장·즉시 적용 오류 복구를 보강하고, 웹 자동 입력·응답 수집·대화 삭제는 계속 미지원·비활성 상태로 둔다.
- Patch 03은 RE:Anime, Miruro, Animenosub, 애니24(Ohli24), Linkkf의 목록과 검색 결과를 모아 작품으로 묶고, 작품 상세에서 공급원별 회차와 재생 선택지를 제공한다. 공급원 하나가 실패하면 다른 공급원은 계속 표시한다.
- Patch 01/02/03은 각기 독립 ON/OFF이며, 이전 두 키 설정은 Patch 03 OFF로 읽어 다음 저장 때 세 키 형식으로 기록한다. Patch 03 OFF이면 통합 카탈로그 UI와 payload를 삽입하지 않아 원래 A 방식 화면을 유지한다.
- 중복 작품은 일치하는 AniList/MAL ID를 우선 사용한다. 외부 ID가 없으면 정규화 제목·연도·형식·시즌이 모두 같은 경우에만 합친다. 회차는 번호와 정규화된 비어 있지 않은 제목이 일치할 때 공급원 선택지로 묶고, Linkkf 서버는 각각 남긴다.
- 검증은 별도 공식 소스 clone의 표식된 임시 복사본과 HTTP 차단 모의 Electron UI에서 수행한다. 실제 `D:\LilacAnime`, 설정/시청 기록/다운로드, 실 공급원 회차, 실제 영상 재생, ChatGPT 계정/번역은 대상이 아니다.

현재 범위와 상세 결과는 `WORK_STATE.md` 및 `docs/verification/DINO_LILAC_ISSUE_2_PATCH_02_03.md`를 참조한다.

## 후속 단계 — 내장 ChatGPT 웹 번역 창 (시험용)

`codex/dino-chatgpt-web-translation`에서는 Patch 02의 **새로 생성되는 적용 payload**에서 SIWC 연결을 제외하고, `electron/embedded-chatgpt-web.cjs` 전용 브라우저 창을 추가했다. `patchOpenChatGPTEmbedded` IPC는 사용자가 버튼을 클릭할 때만 창을 연다. 창은 독립 브라우저 세션과 Electron sandbox를 사용하며, 앱이 로그인 비밀번호·ChatGPT 쿠키 또는 기존 브라우저 프로필을 읽지 않는다.

ChatGPT 웹 화면은 앱 내부 창으로 열리지만, **ChatGPT 웹사이트의 DOM·버튼 위치·로그인 지원이나 페이지 버전은 고정할 수 없다**. 자막의 프롬프트 생성·복사와 결과 붙여넣기/클립보드 가져오기, WebVTT ID 검사·저장·적용은 기존 절차다. **완전 자동 전송·응답 추출·웹 채팅방 자동 삭제는 미구현**이고, 번역 웹 대화 삭제는 사용자가 직접 진행해야 한다. 기존 API/로컬 AI 번역은 계속 보존한다. 프로그램의 실계정 로그인/내장 창 렌더링은 별도 검증이 필요하다.

코드 변경은 격리 브랜치만 대상이며 `D:\LilacAnime`과 `main`은 수정하지 않는다. 자세한 내용은 `docs/verification/DINO_CHATGPT_EMBEDDED_WEB.md` 참조.

## 후속 단계 — 독립 적용 엔진

`codex/dino-lilac-patch-engine`에서는 Patch 01/02 payload와 삽입 지점을 분리했다. `patch-manager/adapters/lilacanime-independent.cjs`는 검토된 공식 v0.5.14·v0.5.15에는 정확한 파일 지문을 확인하고, 미검토 버전은 패치별 구조 검사를 통과한 경우 현재 파일 지문을 고정한 격리 적용 후보만 만든다. 새 후보는 임시 소스 복사본 테스트를 거쳐야 하며 설치본 적용을 허용하지 않는다. 이 브랜치에서 여덟 가지 ON/OFF 조합과 Patch 03 단독 UI payload 분리를 확인한다. main-process IPC와 renderer 초기화는 다른 패치 모듈을 요구하지 않도록 분리했다.

공식 소스 clone을 임시 테스트 복사본으로 만들어 각 조합을 적용·재적용 확인·롤백하는 테스트를 추가했다. **현재 적용 함수는 고유 표식이 있는 OS 임시 fixture만 허용한다.** 이는 실사용 설치 엔진이 아니다. `D:\LilacAnime`, 사용자 데이터, `app.asar`, 공식 업데이트는 이 코드의 적용 대상으로 사용할 수 없으며 GUI·EXE·실제 Electron UI 검증도 아직 없다. 자세한 결과: `docs/verification/DINO_LILAC_INDEPENDENT_PATCH_ENGINE.md`.

## 이번 작업 범위

제품명: **디노 라일락 패치 (Dino Lilac Patch)**.

- 패치 01은 요일별 편성표·자동 분기·출처 확인이다.
- 패치 02는 한국어 자막 번역·내장 ChatGPT 웹 번역 보조 기능이다. SIWC는 새 적용 payload에서 제외한다.
- 패치 01, 패치 02, 패치 03은 각각 ON/OFF할 수 있으며, 여덟 가지 조합을 지원하도록 설계한다.
- ON/OFF 선택은 DinoLilacPatch 폴더의 **settings.json 한 파일**에만 저장한다. 기본값은 OFF/OFF/OFF로 안전하게 시작한다.
- LilacAnime 업데이트 이후 **버전 이름이나 미리 등록한 목록만으로 적용 여부를 결정하지 않는다**. 실제 내부 코드의 연결 지점·원본 UI·자막 구조를 각 패치별로 분석한다.
- 구조 검사 결과가 맞더라도 격리된 앱 복사본에서 시험 적용과 회귀 검증을 마치기 전에는 실제 설치본에 적용하지 않는다.
- 기존 LilacAnime의 업데이트·시청 기록·설정·자막과 사용자 폴더는 보존한다.

## 목표 배포 폴더

    D:\LilacAnime\
    ├─ LilacAnime.exe
    ├─ resources\
    │  └─ app.asar
    └─ DinoLilacPatch\
       ├─ DinoLilacPatch.exe       (추후 개발)
       ├─ settings.json
       ├─ patches\
       │  ├─ patch-01\
       │  ├─ patch-02\
       │  └─ patch-03\
       ├─ shared\
       └─ adapters\

이 구조는 **목표 설계**다. 아직 EXE나 실사용 설치 패키지는 없다. 원본 백업과 복구 기록의 안전한 저장 위치는 실제 적용 엔진 제작 때 결정한다. 불필요한 별도 설정 폴더를 사용자 PC에 만들지 않는다.

## 이번에 실제 구현한 내용

- settings.cjs: 세 패치 ON/OFF를 `DinoLilacPatch/settings.json` 한 파일에 저장한다. 앱 설치 폴더를 명시적으로 전달받고, 설정이 없으면 OFF/OFF/OFF로 시작한다. 이전 두 키 파일은 Patch 03을 OFF로 읽고, 손상되거나 예상 형식이 아닌 기존 설정은 덮어쓰지 않는다. 관리자 GUI나 설치본 적용 엔진에는 아직 연결되지 않았다.
- settings.json: 세 스위치를 OFF로 둔 간단한 설정 예시.
- compatibility.cjs: 각 패치의 필요 코드 지점을 독립 검증하는 **읽기 전용** 구조 분석기. 입력은 분리된 소스 스냅샷이며 설치 파일에 접근하지 않는다.
- test/structure.test.cjs: 네 조합 저장·복원, 손상된 설정 보존, 업데이트된 실제 소스의 구조 판정, 다른 버전의 동일 구조 후보, 같은 버전에서 필수 코드가 깨진 경우, 한쪽 패치만 막히는 경우, 중복 삽입 감지와 원본 불변성 테스트.

구조 판정은 disabled(사용자 OFF), blocked(필수 연결 지점 부족·중복·충돌), structural-candidate(시험 적용 후보)의 세 가지다. **structural-candidate는 실제 작동 보증이나 자동 적용 허가가 아니다.** 모든 분석에서 automaticApplyAuthorized는 false로 유지한다.

## 이 단계에서는 하지 않는 작업

1. 패치 관리자 GUI와 DinoLilacPatch.exe 패키징.
2. 실제 설치본에 패치 payload를 적용하는 작업. 세 패치별 manifest와 격리된 소스 복사본 적용은 검증하지만, 설치본에 독립 ON/OFF를 연결하지는 않았다.
3. app.asar 읽기·압축 해제·교체, 설치본 백업과 원상 복구, 공식 업데이터 후킹.
4. 새 버전의 실제 시험 적용·GUI 통합 검증, 실계정 ChatGPT 내장 브라우저 로그인.

위 기능들은 **사용자가 정한 현 작업 범위 밖**이므로 이 브랜치에서 진행하지 않는다.

## 안전 경계

이 내장 브라우저 변경은 GitHub의 codex/dino-chatgpt-web-translation 브랜치 안에만 있다. main, D:\LilacAnime, 사용자 프로필과 updater 캐시의 파일을 수정하지 않는다. 모든 코드는 사용자의 명령어 실행 없이 이후 GUI에 연결할 수 있도록 순수 모듈로 나눈다.
