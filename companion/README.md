# LilacAnime Companion Prototype

이 폴더는 `codex/runtime-companion-prototype` 브랜치에서만 사용하는 별도 창 프로토타입입니다. 원본 LilacAnime에 코드를 넣거나 설치 파일을 덮어쓰지 않습니다.

## 현재 동작

- 현지 날짜에서 현재 연도·분기를 계산하고 월~일 가운데 오늘을 기본 선택합니다. 분기를 직접 바꿀 수 있으며 분기 경계가 지나면 현재 분기로 돌아옵니다.
- 방영표와 다섯 출처 상태는 합성 예시로만 표시합니다. 원본 패치 01의 분기·요일·보수적 작품 매칭·정확 회차 상태 헬퍼를 재사용합니다. 실제 공급원 요청이나 영상 재생은 없습니다.
- 영어·일본어 WebVTT를 선택하고, 기존 수동 번역 프롬프트/검증 로직으로 ChatGPT 복사-붙여넣기 번역을 보조합니다. 프롬프트 자동 전송은 하지 않고 결과는 새 `.ko.vtt` 파일로만 내보냅니다.
- 실행 시 고유 앱 이름·앱 ID·`userData`·`sessionData`·캐시 경로를 사용합니다. 별도 창, 격리 preload, 외부 네트워크 차단으로 구성했습니다.

## 개발용 실행

화면 실행은 별도 승인 전까지 수행하지 않습니다. 개발 실행이 승인된 경우에만 아래처럼 기존 저장소의 Electron 실행 파일을 지정하고, Companion 전용 프로필 경로를 사용합니다.

```powershell
$electron = 'D:\Codex-Coding-Folder\LilacAnime-Player\node_modules\electron\dist\electron.exe'
& $electron 'D:\Codex-Coding-Folder\LilacAnime-Player-runtime-companion-prototype\companion'
```

이 명령은 `D:\LilacAnime`, `%APPDATA%\lilacanime-desktop`, 원본 업데이트 캐시를 인자로 전달하지 않습니다. NSIS 빌드/설치가 아닙니다.

## 검증

```powershell
node --test companion/tests/*.test.cjs
```

전체 저장소 테스트는 프로젝트 루트에서 `npm test`로 실행합니다. 이 폴더는 루트 Electron 패키저의 포함 목록에 추가되지 않았고 별도 설치 파일도 만들지 않습니다.

## 연결 제한

원본 v0.5.14 공개 소스에서 외부 애드온 API, Companion IPC 또는 재생 딥링크를 확인하지 못했습니다. 원본 안에 UI를 표시하거나 현재 재생 회차를 자동 전달하는 기능은 구현하지 않았습니다. 사용자는 원본 앱에서 내보낸 자막 파일을 직접 선택해야 합니다. 자세한 근거는 `docs/verification/RUNTIME_COMPANION_PROTOTYPE.md`에 기록합니다.
