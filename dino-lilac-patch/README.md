# 디노 라일락 패치 — 구조 1차 확정 (2026-10-11)

## 후속 단계 — 독립 적용 엔진

`codex/dino-lilac-patch-engine`에서는 Patch 01/02 payload와 삽입 지점을 분리했다. `patch-manager/adapters/lilacanime-independent.cjs`는 검토된 공식 v0.5.14·v0.5.15에는 정확한 파일 지문을 확인하고, 미검토 버전은 패치별 구조 검사를 통과한 경우 현재 파일 지문을 고정한 격리 적용 후보만 만든다. 새 후보는 임시 소스 복사본 테스트를 거쳐야 하며 설치본 적용을 허용하지 않는다. 네 가지 ON/OFF 조합을 지원하며 공유 브리지 파일은 한 번만 추가한다. main-process IPC와 renderer 초기화는 다른 패치 모듈을 요구하지 않도록 분리했다.

공식 소스 clone을 임시 테스트 복사본으로 만들어 각 조합을 적용·재적용 확인·롤백하는 테스트를 추가했다. **현재 적용 함수는 고유 표식이 있는 OS 임시 fixture만 허용한다.** 이는 실사용 설치 엔진이 아니다. `D:\LilacAnime`, 사용자 데이터, `app.asar`, 공식 업데이트는 이 코드의 적용 대상으로 사용할 수 없으며 GUI·EXE·실제 Electron UI 검증도 아직 없다. 자세한 결과: `docs/verification/DINO_LILAC_INDEPENDENT_PATCH_ENGINE.md`.

## 이번 작업 범위

제품명: **디노 라일락 패치 (Dino Lilac Patch)**.

- 패치 01은 요일별 편성표·자동 분기·출처 확인이다.
- 패치 02는 한국어 자막 번역·ChatGPT 수동·SIWC 계정 연결 기능이다.
- 패치 01과 패치 02는 각각 ON/OFF할 수 있으며, 네 가지 조합을 지원하도록 설계한다.
- ON/OFF 선택은 DinoLilacPatch 폴더의 **settings.json 한 파일**에만 저장한다. 기본값은 OFF/OFF로 안전하게 시작한다.
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
       │  └─ patch-02\
       ├─ shared\
       └─ adapters\

이 구조는 **목표 설계**다. 아직 EXE나 실사용 설치 패키지는 없다. 원본 백업과 복구 기록의 안전한 저장 위치는 실제 적용 엔진 제작 때 결정한다. 불필요한 별도 설정 폴더를 사용자 PC에 만들지 않는다.

## 이번에 실제 구현한 내용

- settings.cjs: 패치별 ON/OFF의 엄격한 검증과 `DinoLilacPatch/settings.json` 한 파일 저장. 앱 설치 폴더를 명시적으로 전달받고, 설정이 없으면 OFF/OFF로 시작한다. 손상되거나 예상 형식이 아닌 기존 설정은 덮어쓰지 않고 실패 처리한다. 저장은 임시 파일을 같은 폴더에 쓴 뒤 `settings.json`으로 바꾸며, 관리자 GUI나 패치 적용 엔진에는 아직 연결되지 않았다.
- settings.json: 두 스위치만 포함하는 간단한 설정 예시.
- compatibility.cjs: 각 패치의 필요 코드 지점을 독립 검증하는 **읽기 전용** 구조 분석기. 입력은 분리된 소스 스냅샷이며 설치 파일에 접근하지 않는다.
- test/structure.test.cjs: 네 조합 저장·복원, 손상된 설정 보존, 업데이트된 실제 소스의 구조 판정, 다른 버전의 동일 구조 후보, 같은 버전에서 필수 코드가 깨진 경우, 한쪽 패치만 막히는 경우, 중복 삽입 감지와 원본 불변성 테스트.

구조 판정은 disabled(사용자 OFF), blocked(필수 연결 지점 부족·중복·충돌), structural-candidate(시험 적용 후보)의 세 가지다. **structural-candidate는 실제 작동 보증이나 자동 적용 허가가 아니다.** 모든 분석에서 automaticApplyAuthorized는 false로 유지한다.

## 이 단계에서는 하지 않는 작업

1. 패치 관리자 GUI와 DinoLilacPatch.exe 패키징.
2. 실제 설치본에 패치 payload를 적용하는 작업. 후속 단계에서 두 패치별 manifest와 격리된 소스 복사본 적용은 검증했지만, 설치 앱에 독립 ON/OFF를 연결하지는 않았다.
3. app.asar 읽기·압축 해제·교체, 설치본 백업과 원상 복구, 공식 업데이터 후킹.
4. 새 버전의 실제 시험 적용·GUI 통합 검증, 실계정 SIWC 인증.

위 기능들은 **사용자가 정한 현 작업 범위 밖**이므로 이 브랜치에서 진행하지 않는다.

## 안전 경계

작업은 GitHub의 codex/dino-lilac-patch-structure 브랜치 안에만 있다. main, D:\LilacAnime, 사용자 프로필과 updater 캐시의 파일을 수정하지 않는다. 모든 코드는 사용자의 명령어 실행 없이 이후 GUI에 연결할 수 있도록 순수 모듈로 나눈다.
