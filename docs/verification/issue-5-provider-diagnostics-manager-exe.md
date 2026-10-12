# GitHub issue #5 — 공급원 진단 및 DinoLilacPatch 포터블 EXE

## 기준과 안전 범위

- 작업 브랜치: `codex/issue-5-provider-diagnostics-exe-20261013`
- 기준 브랜치: `codex/issue-4-dinolilacpatch-mvp-20261012`
- 기준 커밋: `9e2c8bf6774426ed827aacf8e7c890d7d8358d58`
- 공급원 검증은 공식 LilacAnime v0.5.15 커밋 `16c9a3d1631061a72831e0657434003940daf531`의 새 임시 사본에서 수행했다.
- 실제 설치본, 사용자 프로필, 시청·다운로드 기록, 실제 `app.asar`는 열거나 수정하지 않았다. `main`과 공식 소스 사본도 수정하지 않았다.
- 공급원 검증은 검색 → 상세 → 회차 목록까지만 실행했다. 스트림 해석·영상 재생·다운로드는 호출하지 않았다.

## 다섯 TypeError의 공통 원인

이슈 #4에서 다섯 공급원이 모두 반환한 `TypeError`는 공급원 호출 결과가 아니었다. 테스트가 `electron/preload.cjs`에 추가한 probe는 Electron의 격리된 preload world에서 실행되면서, `contextBridge.exposeInMainWorld('lilac', ...)`가 페이지 main world에 노출하는 `window.lilac`를 읽었다. 격리된 world에는 `window.lilac`가 없으므로 공급원 IPC에 도달하기 전에 다섯 호출이 같은 속성 접근 TypeError로 끝났다.

probe를 preload bridge와 같은 `ipcRenderer.invoke` 채널(`provider:catalog`, `provider:detail`, `linkkf:search`, `linkkf:detail`, `linkkf:episodes`)을 호출하도록 수정했다. 이로써 실제 Electron main-process 경로를 검증하고 UI world와 preload world의 경계를 올바르게 처리한다. 다섯 TypeError가 공급원 다섯 곳의 공통 결함이었다는 증거는 없었다.

## 실제 공급원 결과

| 공급원 | 검색 | 상세·회차 | 결과 |
|---|---:|---:|---|
| Re:Anime | 성공, 30건 | 성공, 220회차 | 확인 |
| Miruro | 성공, 15건 | 성공, 220회차 | 확인 |
| Animenosub | 성공, 2건 | 성공, 500회차 | 확인 |
| 애니24 | 한국어 검색 성공, 19건 | 성공, 287회차 | 확인 |
| Linkkf | DNS `ENOTFOUND` | 검색 실패로 호출 안 함 | 미확인 |

초기 영문 검색어에서 애니24는 빈 결과였으나, 한국어 검색어를 사용한 단일 재검사에서 실제 작품과 회차를 확인했다. 검색어 자체는 JSON/문서에 저장하지 않았다.

Linkkf는 앱 코드에 고정된 API 호스트의 DNS 조회가 `ENOTFOUND`였다. main-process Node fetch에서 같은 원인 코드가 관측됐고 HTTP 응답은 없었다. 검색은 첫 카탈로그 묶음에서 멈췄으며 상세·회차 호출은 하지 않았다. 새 호스트로 우회하거나 프록시·헤더·쿠키를 바꾸지 않았다. 사용 가능한 공식 대체 API가 확인될 때까지 이 공급원은 미완료다.

세부 집계와 Electron·Chromium 런타임 정보는 [issue-5-provider-diagnostics.json](issue-5-provider-diagnostics.json)에 있다.

## DinoLilacPatch.exe

`npm run build:dino-lilac-patch:win`으로 Windows x64 포터블 EXE를 생성했다. electron-builder의 `portable` 타깃은 설치 과정 없이 실행되는 Windows 패키지로 문서화되어 있다 ([electron-builder portable documentation](https://www.electron.build/v26/docs/nsis/)). 빌드는 기존 로컬 Electron 38.8.6 배포판과 electron-builder 26.15.3을 사용했다.

- 파일: `dist/dino-lilac-patch-issue5/DinoLilacPatch.exe`
- 크기: 136,267,778 bytes
- SHA-256: `ebcbb6132deef35b0133d39fabaab753b22ff8c261038b833f51dd0903c0a2b6`
- 빌드 형식: Windows x64 portable, 관리자 권한 요청 없음
- ASAR 점검: 42개 파일, 진입점은 `dino-lilac-patch/manager/main.cjs`; LilacAnime의 `electron/main.cjs`는 포함하지 않음

실제 생성한 EXE를 저장소 체크아웃 밖의 작업 디렉터리에서 실행했다. 독립 실행 파일의 UI에서 세 패치를 각각 단독 ON으로 선택하고 적용한 뒤 복구했다. Patch 03 OFF일 때 unified-catalog payload가 들어오지 않아 기존 A 경로가 유지되는 것도 검사했다. 세 번의 복구마다 공식 소스 기준 파일 4개의 SHA-256이 복원됐다. 검증 타깃은 관리자 코드가 만든 공식 v0.5.15 OS 임시 사본뿐이었다.

## 검증과 남은 일

- 통과: 생성된 EXE 실행, 패치 01/02/03의 독립 ON 및 나머지 OFF, 각 적용·복구 3회, Patch 03 OFF의 A 경로 보존, 원본 기준 해시 복구.
- 통과: ASAR에 관리자 UI·어댑터·필요한 패치 payload가 들어가고 LilacAnime 앱 진입점은 제외된 것을 확인.
- 통과: Patch 03 격리 동작을 합성 장애로 확인 — Miruro 실패 상태를 표시하면서 통합 목록의 나머지 공급원 작품 4건과 정상 공급원의 회차 선택 2건을 유지했다. 이 항목은 mock 입력 검증이며 실시간 공급원 성공 근거는 아니다.
- Patch 03 ON은 EXE 첫 화면 기본값, 통합 payload 적용, `index.html` 연결로 확인했고 OFF는 payload 제외로 기존 A 경로 보존을 확인했다. 패치된 LilacAnime 앱 자체의 별도 시각 UI 실행은 이 검증에서 하지 않았다.
- 통과: 공급원 검색/상세/회차의 실제 IPC 검증 — Re:Anime, Miruro, Animenosub, 애니24.
- 제한: Linkkf API 도메인의 DNS 실패로 검색·상세·회차를 확인할 수 없었다.
- GitHub Actions는 실행하지 않았다. 테스트를 위해 생성한 임시 격리 사본과 포터블 런타임은 종료 후 정리했다.
