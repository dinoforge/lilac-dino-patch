# Miruro 실회차 격리 검증 기록 — 2026-10-12

대상: Miruro, 《장송의 프리렌》 1기 1화 (Frieren: Beyond Journey's End, AniList 154587 / MAL 52991, 2023).
운영 환경: GitHub Actions windows-latest, Electron, 별도 임시 `userData` 및 `sessionData`.
테스트 브랜치: `codex/dino-chatgpt-logged-out-test`.
실행: https://github.com/dinoforge/anime-player/actions/runs/38229303564

## 결과

**실회차 결과: FAIL / BLOCKED BY UPSTREAM HTTP 403.**

실제 로그:

```text
miruro_live_test=failed: Error: Error invoking remote method 'provider:catalog': Error: Miruro HTTP 403
Miruro live episode probe outcome: failure
```

- 작품 검색 API (`provider:catalog`): 403 오류로 실패.
- 1화 선택, 실제 영상 주소 획득, HLS 플레이리스트 및 미디어 세그먼트 수신: 실행에 도달하지 못함.
- 실회차 영상 프레임, 음성 코덱, 청각적 출력, 실제 화면 자막, 회차 완주: 전부 미검증.
- 별도로 생성된 4초 WebM 영상의 실제 디코딩 검사는 통과.
- 기존 Node 전체 회귀 검사: 382/382 통과.
- 브랜치 CI가 녹색으로 표시된 이유: 라이브 외부 공급원 시험 단계는 `continue-on-error: true`로 구성되어, 외부 서비스 장애로 기존 회귀 테스트 판정이 영향을 받지 않도록 했기 때문. **라이브 시험 자체는 실패했다.**

## 재현 및 안전 범위

`DINO_MIRURO_LIVE_OPT_IN=1 node tests/run-miruro-live-episode.cjs` (Windows, `npm ci` 후 실행).
검사 코드는 앱의 기존 renderer/preload/IPC에서 실제 Miruro 공급원 로직을 사용한다.
`main` 및 실설치본, 실제 브라우저 프로필은 변경하지 않는다. 실회차 영상과 자막 내용/URL은 로그에 기록하지 않는다.
프로그램이 실행 중 직접 네트워크로 작품 API에 접근하므로, 대상 공급원의 이용 권한 및 조건을 별도로 확인해야 한다.
이 검사는 영상 및 자막의 전체 다운로드나 콘텐츠 보호 우회를 목적으로 하지 않는다.

## 후속 검증

## 2026-10-12 로컬 Windows 실회차 재현

현재 작업 브랜치의 기준 커밋 `c340e674afce9c7c083125ea2e21feddca152f0d`에서 기존 격리 Electron runner를 로컬 Windows에서 실행했다. 앱의 Miruro IPC와 요청/응답 파서는 수정하지 않은 상태였다.

- `provider:catalog('miruro', 'Frieren')` 성공. 앱은 `www.miruro.to`의 `/api/v1/anime`에 `q=Frieren`, `limit=15`, `sort=-popularity`를 보내고, 기존 gzip/XOR 응답을 파싱했다.
- 2023년 《장송의 프리렌》 1기 1화를 선택하고 `SOFT - kickassanime Vid` 서버에서 스트림 주소를 얻었다. 서명된 주소는 로그에 남기지 않았다.
- Electron/Hls.js가 실제 스트림을 재생했다. 프레임 37개, 재생 위치 1.45초, 640×360 프레임을 확인한 뒤 정지했다. 보고된 전체 길이는 약 25분 59.9초였지만 전체 회차 재생은 하지 않았다.
- 오디오 코덱 존재는 관찰했다. 검사는 영상을 음소거했으므로 **실제 청각 출력은 미검증**이다.
- 영어 WebVTT 파일을 받아 형식과 321개 cue 타임코드를 확인했다. 자막을 플레이어 위에 실제로 표시하는 동작은 이 검사에서 호출하지 않았으므로 **화면 자막은 미검증**이다.
- `userData`, `sessionData`, `videos`는 전용 `%TEMP%` 하위 폴더로 지정됐고 runner가 그 임시 폴더를 종료 후 정리했다. 실제 설치본/프로필/시청 기록/다운로드 폴더는 사용하지 않았다.

## 403 원인 판정

GitHub Actions run [38229821039](https://github.com/dinoforge/anime-player/actions/runs/38229821039)은 같은 브랜치와 같은 앱 코드에서 `provider:catalog` 단계가 HTTP 403을 반환해 회차 선택 전 중단됐다. 기존 로그에는 응답 헤더나 본문이 없어 거절을 만든 구체적 서버 정책까지는 알 수 없다. 같은 요청 코드가 로컬 Windows 네트워크에서는 성공했으므로, **요청 형식 오류나 전체 공급원 장애보다는 GitHub Actions 실행 환경에서의 네트워크/접근 거절이 가장 잘 맞는 설명**이다. IP 차단이나 특정 보안 제품을 확정한 것은 아니며, 이를 우회하는 요청 헤더·프록시·대체 중계 서버는 추가하지 않았다.

기존 workflow는 live 단계에 `continue-on-error: true`를 두어 해당 단계가 실패해도 전체 run은 성공으로 보일 수 있었다. 검증 workflow를 두 작업으로 나눠 Node 회귀 결과와 실회차 결과를 각각 표시하도록 바꿨다. 이제 403이면 `miruro-live-episode` job이 실패하고, 전체 Node 회귀 검사는 별도 job에서 독립적으로 결과를 낸다.

변경 커밋 `6487318cc16305713a9d1511f21566a39cd97b61`의 [Actions run 38232624403](https://github.com/dinoforge/anime-player/actions/runs/38232624403)에서 분리를 확인했다.

- `node-and-upstream`: 성공. 전체 Node 검사 382/382 통과, 실패 0, 건너뜀 0. 공식 v0.5.14/v0.5.15 적용 검증과 합성 4초 영상 디코딩 검사도 통과.
- `miruro-live-episode`: 실패로 명확히 표시. `provider:catalog`의 Miruro HTTP 403에서 멈췄고, 에피소드 선택이나 HLS 재생은 Actions에서 미검증. job summary에 `FAIL / BLOCKED`와 error annotation이 기록됐다.
- 전체 workflow 결론은 `failure`이며, 이는 라이브 공급원 접근 실패다. 별도 회귀 job은 녹색으로 완료됐다.

로컬에서 짧은 실회차 프레임과 자막 파일을 확인했으므로 해당 로컬 검증은 **PASS**다. GitHub Actions의 실회차 네트워크 검증은 **BLOCKED (HTTP 403)**으로 별도 기록한다. 실제 소리, 화면에 표시된 자막, 회차 완주는 어느 쪽에서도 통과로 주장하지 않는다.
