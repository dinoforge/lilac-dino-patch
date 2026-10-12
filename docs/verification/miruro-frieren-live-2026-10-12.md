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

403이 GitHub Actions 환경에서 발생한 HTTP 응답이라는 사실 외에 원인은 확정할 수 없다.
공급원 API 상태 및 사용 권한을 정상적으로 확인할 수 있는 환경에서 먼저 검색 API 호출을 다시 검사한다.
그 이후에만 HLS 영상 프레임을 측정할 수 있고, 실제 스피커 소리·화면 자막 표시·전체 회차 완주는 별도 검증해야 한다.
