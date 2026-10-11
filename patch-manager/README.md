# LilacAnime 업데이트 지속 패치 매니저 — 안전성 기반 시제품

**목표:** 기존 LilacAnime의 공식 업데이트를 유지하면서 Patch 01(방영표·출처 상태)과 Patch 02(수동 ChatGPT 자막 번역)가 화면 안에 유지되도록, 업데이트 이후 호환성을 판단하고 안전할 때 재적용한다. 다른 통합판/오버레이를 최종 제품으로 삼지 않는다.

## 현재 구현

- `core.cjs`: 버전과 고정 SHA-256 기준 파일 검사, 고유 삽입점·기존 대상·Windows 경로 검증. 지원되지 않는 파일은 `incompatible`로 중단
- `staging.cjs`: OS 임시 폴더 안의 외부 표식이 있는 **합성 테스트 트리**만 허용. 신규 staging 사본에만 작업하고 링크·경로 이탈·과도한 파일을 차단
- `feature-payload.cjs`: 이 저장소의 패치 01·02 helper 모듈과 제공된 프롬프트 파일을 `0.5.9` 합성 fixture에 넣는 고정 fixture payload. 공식 LilacAnime용 adapter가 아님
- `persistent.cjs`: 격리 fixture에서만 적용, 두 번의 안정 지문과 명시적 업데이트 완료 신호를 요구하는 재적용, 백업 기반 롤백을 수행. 실행 중인 앱이면 중단
- `cli.cjs`: `--help`, `--demo`만 제공. demo는 새 합성 `0.5.9` fixture에 payload를 적용해 임시 경로를 출력하며, 설치본 경로를 받지 않음
- `test/manager.test.cjs`, `test/upstream-compatibility.test.cjs`: 적용·롤백·업데이트 경합 및 공식 소스 버전 차이를 검증

## 테스트

```powershell
node --test patch-manager/test/manager.test.cjs
node patch-manager/cli.cjs --help
```

`node patch-manager/cli.cjs --demo`를 사용자가 실행하면 고유한 합성 임시 fixture와 sidecar 백업이 만들어져 그대로 남는다. 실제 설치 경로를 지정하는 명령은 없다.

## 실사용 전 미구현 사항

- 공식 v0.5.14 소스에 패치 01·02를 맞춰 적용하는 버전별 adapter. 현재 알려진 통합 diff는 공식 v0.5.14에 적용되지 않음
- 실제 `app.asar` 또는 설치 리소스의 적용·백업·복구. 현 엔진은 마커가 있는 임시 fixture만 허용
- 공식 업데이터 완료 신호, 파일 잠금·서명 검사, 프로세스 감지 및 업데이트 경합 통합
- 사용자가 매번 명령을 내리지 않아도 되는 패키징/실행 자동화
- 공식 v0.5.14의 UI·공급원·영상·ChatGPT 왕복 검증

**현재 단계는 실제 helper 모듈과 원문 프롬프트를 합성 0.5.9 fixture에 적용하고, fixture 업데이트·재적용·복구 엔진을 검증한 시제품이다. 공식 v0.5.14와 사용자 설치본에 적용되거나 업데이트 후 유지된다는 증거는 없다.**

## 안전 경계

`D:\LilacAnime`, `%APPDATA%\lilacanime-desktop`, `%LOCALAPPDATA%\lilacanime-desktop-updater`를 읽거나 수정하지 않는다. 실제 설치·제거·업데이트 후킹·NSIS·프로세스 강제 종료·Computer Use·원격 디버깅을 수행하지 않는다.

원본에는 공식 외부 확장 API가 없으므로 최종적으로 원본 화면 안에 패치를 유지시키려면 원본 리소스 수정이 필요할 수 있다. 이는 사용자가 기존에 설정한 원본 무수정 조건과 충돌하므로, **실제 설치본 수정 기능을 개발·작동시키기 전 별도의 명시적인 승인과 충분한 격리 검증이 필요하다.** 검증하지 않은 신규 버전에서는 재적용을 멈추고 공식 업데이트를 방해하지 않는다.
