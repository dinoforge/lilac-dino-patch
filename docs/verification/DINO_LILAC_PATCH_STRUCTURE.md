# 디노 라일락 패치 구조 검증

작성일: 2026-10-11
작업 브랜치: `codex/dino-lilac-patch-structure`
기준 커밋: `e4ccddbd4a5e65acd565a1f69fc2a69b51016ccf`

## 구현 범위

- `dino-lilac-patch/settings.cjs`는 패치 01과 패치 02의 불리언 설정을 검증하고, 앱 설치 폴더 아래 `DinoLilacPatch/settings.json` 한 파일에서 읽고 쓴다.
- 설정 파일이 없으면 두 패치를 모두 OFF로 취급한다. JSON이 손상됐거나 예상한 키·값이 아니면 읽기와 변경을 실패 처리하고 기존 파일을 덮어쓰지 않는다.
- 저장은 같은 폴더의 고유 임시 파일에 먼저 기록한 뒤 `settings.json`으로 이름을 바꾼다. 코드에서 설치 폴더를 임의로 탐색하지 않으며, 호출자가 전달한 앱 경로만 사용한다.
- `dino-lilac-patch/compatibility.cjs`는 읽기 전용 소스 스냅샷을 패치별 연결 지점과 비교한다. 버전 문자열은 보고용이며 허용 목록으로 사용하지 않는다. 중복 삽입 표식, 연결점 누락, 모호한 중복은 해당 패치만 차단한다.
- 모든 패치가 OFF인 상태는 `disabled`, 구조에 문제가 있으면 `blocked`, 검사에 통과하면 격리 적용을 더 확인해야 하는 `structural-candidate`다. 구조 분석 결과는 설치 파일 쓰기나 자동 적용을 허가하지 않는다.

## 실제 원본 구조 확인

공식 저장소의 릴리스 페이지에서 최신 공개 릴리스가 v0.5.15임을 확인했다. [LilacAnime-desktop 공식 릴리스](https://github.com/whispelyn-byte/LilacAnime-desktop/releases)

v0.5.15 (`16c9a3d1631061a72831e0657434003940daf531`)를 `%TEMP%`에 별도 clone으로 받아 파일을 수정하지 않은 채 구조 테스트 입력으로 사용했다. 각 패치의 현재 연결 지점이 확인되어 둘 다 `structural-candidate`로 분류됐고, 실제 앱에 적용해도 된다는 뜻은 아니다.

테스트는 다음 경계도 합성 스냅샷으로 확인한다.

- 버전이 달라도 필수 코드 구조가 유지되면 후보가 된다.
- 같은 버전이라도 필수 코드가 사라지거나 연결점이 중복되면 차단한다.
- 패치 01의 연결점이 깨져도 패치 02의 결과는 독립적으로 평가한다.
- 기존 패치 표식이 있으면 중복 주입을 차단한다.
- 구조 분석 중 입력 스냅샷의 바이트 내용은 바뀌지 않는다.

## 실행 결과

- `node --check dino-lilac-patch/settings.cjs` 및 `node --check dino-lilac-patch/test/structure.test.cjs` 통과.
- `node --test dino-lilac-patch/test/structure.test.cjs`에 공식 v0.5.15 읽기 전용 clone을 `LILAC_UPSTREAM_SOURCE`로 지정: 10 통과, 0 실패, 0 건너뜀.
- 전체 `npm test`는 공식 v0.5.14 읽기 전용 clone을 지정해 362 통과, 0 실패, 0 건너뜀. v0.5.14 adapter 회귀 테스트와 실제 v0.5.15 구조 검사는 별도 테스트로 구분했다.
- 의존성은 설치하지 않았다. 새 worktree에 `node_modules`가 없어 첫 전체 실행은 `cheerio`·`electron` 미탐색으로 실패했다. 기존 프로젝트와 `package-lock.json` SHA-256이 같은 것을 확인한 뒤 기존 `node_modules`를 임시 `NODE_PATH`로 재사용해 통과시켰다. 공식 upstream fixture 없이 실행한 재검은 357 통과, 5 건너뜀(공식 소스 fixture 필요)이었다.

## 아직 구현되지 않은 기능

- `settings.json` 읽기·쓰기 코드는 만들었지만 관리자 GUI나 앱 런타임에 연결하지 않았다. 패치 01·02 기능의 실제 ON/OFF는 아직 제공되지 않는다.
- 기존 v0.5.14 어댑터는 두 패치 payload를 하나로 묶어 주입한다. 패치별 payload 분리와 각 네 조합의 실제 적용 검증은 이번 범위에 포함되지 않는다.
- `DinoLilacPatch.exe`, GUI, `app.asar` 읽기·쓰기, 설치본 백업·복구, 업데이트 감시 및 자동 재적용은 구현하지 않았다.
- v0.5.15는 정적 코드 구조만 검사했다. 격리 Electron UI, 실제 공급원, 영상 재생, SIWC 계정, 기존 사용자 설치본은 검증하지 않았다.

실제 LilacAnime 설치본, `%APPDATA%\lilacanime-desktop`, `%LOCALAPPDATA%\lilacanime-desktop-updater`에는 접근하거나 변경하지 않았다.
