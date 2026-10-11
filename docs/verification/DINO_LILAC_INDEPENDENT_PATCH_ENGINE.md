# 디노 라일락 패치 독립 적용 엔진 검증

날짜: 2026-10-11
작업 브랜치: `codex/dino-lilac-patch-engine`
기준 브랜치: `codex/dino-lilac-patch-structure`
기준 커밋: `28793984b4dbb7d30a57d722789ff67ffc5f60ec`

## 결과

선택된 패치만 적용하는 manifest 생성, 격리된 공식 소스 복사본에서의 적용, 중복 적용 방지 및 롤백을 구현하고 검증했다. Patch 01 또는 Patch 02가 구조 검사에서 차단되면 다른 호환 패치의 적용은 계속 가능하다.

이 결과는 소스 파일 수준의 격리 실험이다. Electron 앱을 실행하거나 화면·IPC와 실제 서비스 연결을 검증한 것은 아니다. 적용 API는 명시적으로 표시된 OS 임시 fixture만 허용하며 실제 설치본과 `app.asar`에는 적용할 수 없다.

## 구현

- `patch-manager/adapters/lilacanime-v0.5.14.cjs`: payload를 `patch-01`, `patch-02`, 공유 payload로 분리했다. 기존 통합 adapter API와 두 프롬프트 및 Reazon 예시의 원문 해시 검사는 보존했다.
- `patch-manager/adapters/lilacanime-independent.cjs`: LilacAnime 공식 소스 v0.5.14·v0.5.15의 검토된 파일 지문을 확인하고, 패치별 구조 상태를 받아 해당 payload만 가진 manifest를 구성한다. 알려지지 않은 바이트 지문도 패치별 구조 검사가 통과하면 현재 파일 지문으로 제한한 격리 적용 후보로 만든다. 설치본 적용을 허용하지 않는다.
- `electron/patch-manager-stage2.cjs`: Patch 01과 Patch 02 IPC 등록을 분리하고 패치별 코드만 지연 로드한다. 기존 양쪽 등록 함수는 호환 래퍼로 보존한다.
- `src/patch-manager-stage2.js`: Patch 01과 Patch 02의 의존성 확인·UI·초기화를 독립시켰다. Patch 01 단독 상태에서 번역 모듈을 요구하지 않고, Patch 02 단독 상태에서 분기·요일표 모듈을 요구하지 않는다.
- `dino-lilac-patch/compatibility.cjs`: Patch 01의 실제 공급원 어댑터 연결 지점과 Patch 02의 앱·subtitle store 연결 지점을 별도로 검사한다.
- `patch-manager/test/lilacanime-independent.test.cjs`: 공식 소스 clone을 OS 임시 디렉터리의 신규 복사본으로 만들고 적용·검증·복구한다. 공식 원본 clone은 전후 추적 파일 SHA-256 비교로 불변성을 검사한다.

## 공식 소스 복사본 실험

출처는 별도 OS 임시 디렉터리에 둔 읽기 전용 clone이다.

| 대상 | 공식 소스 커밋 | OFF/OFF | ON/OFF | OFF/ON | ON/ON | 비호환 독립성 | 실패 복구 |
|---|---|---|---|---|---|---|---|
| v0.5.14 | `f095fc3d775451e144ed780e1fa081f739927652` | 통과 | 적용·중복 확인·롤백 통과 | 적용·중복 확인·롤백 통과 | 적용·중복 확인·롤백 통과 | 통과 | 통과 |
| v0.5.15 | `16c9a3d1631061a72831e0657434003940daf531` | 통과 | 적용·중복 확인·롤백 통과 | 적용·중복 확인·롤백 통과 | 적용·중복 확인·롤백 통과 | 통과 | 통과 |

- OFF/OFF는 manifest를 만들지 않고 `writes: false`를 반환한다. fixture의 모든 추적 파일 해시는 그대로 유지됐다.
- ON/OFF에서는 Patch 01의 분기·요일표 모듈 및 IPC만 추가됐고, OFF인 Patch 02의 UI·payload·IPC는 삽입되지 않았다. OFF/ON은 반대 조합을 확인했다. ON/ON은 공유 브리지 각각 한 파일을 포함했다.
- 각 적용 뒤 같은 manifest를 다시 실행하면 `already-applied`가 반환됐다. 롤백 후 공식 소스 복사본의 추적 파일 해시가 적용 전 값으로 돌아오고 추가 payload 파일이 제거됐다.
- `animeById` 연결 지점을 바꾼 경우 Patch 01은 차단되고 Patch 02는 적용됐다. `subtitle-store.cjs`의 검증 지문이 달라진 경우 Patch 02는 차단되고 Patch 01은 적용됐다.
- 충돌하는 `electron/prompts` 파일을 둬 payload 쓰기를 실패시킨 경우, fixture의 기존 추적 파일과 원본 공식 clone의 추적 파일 해시는 보존됐다.
- 검토되지 않은 바이트 지문은 버전 문자열만으로 승인하지 않는다. 바이트가 달라져도 구조 검사를 통과하면 현재 지문을 고정한 격리 후보로 만들고, 격리 적용·구문 검사 후 롤백했다. 구조 검사를 통과하지 못한 항목은 패치별로 차단된다.
- 적용된 `main.cjs`, `preload.cjs` 및 JS/CJS action 파일은 `node --check`를 통과했다.

## 테스트

- 전체 `npm test`: **371 통과, 0 실패, 0 skip**.
- `node --test patch-manager/test/manager.test.cjs`: **16 통과, 0 실패**.
- `node --test patch-manager/test/lilacanime-independent.test.cjs`: **9 통과, 0 실패, 0 skip**. 각 공식 버전에 대해 네 설정 조합, 한 패치 비호환 시 독립 적용, 쓰기 실패 복구, 미검토 지문 차단, main IPC 선택 등록을 포함한다.
- 변경 JavaScript/CJS 파일 `node --check`: 통과.
- `git diff --check`: 통과.

## 아직 확인하지 않은 범위

- 격리 Electron 앱의 실제 실행, 원본 홈 화면 및 실제 사용자 조작은 미검증이다. 이번 범위에서는 GUI/EXE와 NSIS를 만들거나 실행하지 않았다.
- 실제 공급원 요청, 회차 재생, ChatGPT 계정 연결 및 번역 요청은 하지 않았다.
- 공식 v0.5.14/v0.5.15 **소스 복사본**에서 패치 파일 쓰기와 되돌리기는 확인했지만, 패치된 앱이 런타임에서 작동한다고 확인한 것은 아니다.
- 설치본 적용, `app.asar` 처리, 자동 업데이트 뒤 재적용은 미구현이다. `patch-manager/persistent.cjs`는 의도적으로 OS 임시 폴더 아래의 안전 표식 fixture만 허용한다.

## 보호 범위

실제 `D:\LilacAnime`, `%APPDATA%\lilacanime-desktop`, `%LOCALAPPDATA%\lilacanime-desktop-updater`, 원본 LilacAnime 저장소 및 사용자 데이터는 접근하거나 수정하지 않았다. 원본 v0.5.14/v0.5.15 clone은 읽기 전용 비교 대상으로만 사용했고, 모든 변경은 임시 복사본에만 적용했다.
