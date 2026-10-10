# LilacAnime v0.5.14 원본 무수정 Companion 연결 가능성

## 결론

**현재 공개된 LilacAnime v0.5.14 파일만 그대로 두고, 별도 Companion이 원본 창의 renderer에 직접 연결해 요일표 UI를 삽입하는 것은 지원되는 방법을 확인하지 못했다.**

따라서 이번 단계에서 연결 성공을 주장하지 않는다. Electron의 앱 내부 IPC는 renderer와 LilacAnime main process 사이에서만 동작한다. 외부 프로세스가 renderer의 DOM에 접근하는 공식 Companion API, 플러그인 로더, 외부 IPC 서버, 사용자 정의 프로토콜은 확인되지 않았다. 현재 직접 접근에 가까운 Electron CDP 경로는 원본 프로세스 안에서 앱이 보유한 `webContents` 핸들을 사용하거나 원격 디버깅 포트를 열어야 하는데, 전자는 원본 통합 코드가 필요하고 후자는 이번 작업에서 금지됐다.

이 결론은 v0.5.14 공개 소스와 허용된 안전 경로에 대한 조사 결과다. 모든 가능한 Windows 기법이 기술적으로 불가능하다는 주장은 아니다. 별도 오버레이를 원본 화면 위에 띄우는 방법은 원본 파일을 건드리지 않을 수 있지만, 원본 renderer에 삽입되는 기능과는 다르며 이번 작업의 대체 구현으로 사용하지 않았다.

## 확인 기준 및 원본 무결성

- 대상 저장소 브랜치: `codex/runtime-attach-unmodified-feasibility`
- 기준: `codex/runtime-attach-native-style`, `9dd99abb59ccd904e212aff315274f87b720840f`
- LilacAnime 소스: v0.5.14, `f095fc3d775451e144ed780e1fa081f739927652`
- Git 아카이브를 별도 `%TEMP%` 경로에 풀어 검사했다. `electron/main.cjs`, `electron/preload.cjs`, `src/index.html`, `src/app.js`, `package.json`의 `git hash-object` 결과가 원본 commit의 blob ID와 각각 일치했다. 즉, 검사 사본에서도 이 다섯 파일은 원본 바이트와 동일하다.

| 파일 | v0.5.14 blob ID | 사본 일치 |
| --- | --- | --- |
| `electron/main.cjs` | `9d5083560f38df1bb598e75f085d0388ffe5ea34` | 예 |
| `electron/preload.cjs` | `9f72d8c65c2d113f99444604be3cc6da07b9c889` | 예 |
| `src/index.html` | `f9a0f807233714b59baf2dfc7d2ae0962278e9b8` | 예 |
| `src/app.js` | `dcffc30795623bf17952acf7ff596266ada08a33` | 예 |
| `package.json` | `8d0e10a85595a0c4bda2846e37ff5d62e9110bee` | 예 |

검사 사본은 `%TEMP%\lilac-unmodified-feasibility-76c76789f9b64d308b5016f5e0003910\v0.5.14`에 있다. 검사 중 앱을 실행하거나 사본 파일을 수정하지 않았다. 실제 설치 경로 `D:\LilacAnime`, 기존 LilacAnime 프로필, 업데이트 캐시에는 접근하지 않았다.

## v0.5.14에서 확인한 연결 지점

- `electron/main.cjs:1996-2015`는 `BrowserWindow`를 만들고 `electron/preload.cjs`를 지정한 뒤 로컬 `src/index.html`을 로드한다. 외부 Companion 프로세스를 등록하거나 renderer DOM 접근을 위임하는 플러그인 지점은 없다.
- `electron/preload.cjs:6`의 `contextBridge.exposeInMainWorld('lilac', ...)`는 `window.lilac`을 renderer에 노출한다. 이 API는 renderer가 `ipcRenderer.invoke`로 앱 내부 핸들러를 부르는 용도다. 외부 프로세스가 호출할 IPC 서버나 DOM 접근 권한을 제공하지 않는다.
- `electron/main.cjs`에는 앱 내부 `ipcMain.handle` 핸들러와 단일 인스턴스의 `second-instance` 처리만 확인했다. Companion 플러그인 로더, 외부 프로토콜 등록, 이름 있는 파이프, Companion용 로컬 서버, `webContents.debugger` 연결 코드 또는 `remote-debugging-port` 설정은 확인하지 못했다.
- 확인된 loopback 기능은 용도가 제한돼 있다. `electron/flix-proxy.cjs`는 임의 포트의 `/__flix/` 영상 프록시이고, `electron/local-ai.cjs:3-4,350-387`은 번역 시 로컬 모델을 위해 `127.0.0.1`에 임시 inference 서버를 띄운다. 어느 쪽도 Companion 메시지나 UI를 제공하지 않는다. `device-sync`는 사용자가 지정한 LilacAnime 원격 동기화 서버에 로그인하는 HTTP 클라이언트로, 로컬 UI 삽입 브리지가 아니다.
- 앞 단계의 화면 삽입은 테스트 사본 `main.cjs`에 임시 연결 고리를 넣고 그 main process가 자신의 `webContents.debugger`를 호출한 결과다. 이 증거는 원본 무수정 외부 연결의 증거가 아니며 이번 검증에서 재사용하지 않았다. 이전 스타일 코드·테스트·캡처는 기준 커밋에 보존했다.

Electron 공식 문서는 `Debugger`가 main process API이며 Electron API에서 반환된 `webContents`의 `debugger` 인스턴스로만 제공된다고 설명한다. 외부 CDP 연결에 해당하는 `--remote-debugging-port`는 HTTP 원격 디버깅을 연다. 이 앱은 외부에 그 포트를 제공하지 않으며, 이번 작업에서는 포트를 열지 않았다. `contextBridge`와 IPC 역시 preload, renderer, main 사이에서 앱 제작자가 명시적으로 연결해야 하는 경로다. [Electron Debugger API](https://www.electronjs.org/docs/latest/api/debugger), [Electron command line switches](https://www.electronjs.org/docs/latest/api/command-line-switches), [Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation), [IPC](https://www.electronjs.org/docs/latest/tutorial/ipc)

## 실제 런타임 연결 시험을 하지 않은 이유

연결 성공을 증명할 수 있는 공식 endpoint가 없어 런타임 attach는 시도하지 않았다. 무수정 앱을 정상 실행하면 `src/app.js:init()`이 홈 카탈로그 로딩을 시작한다. 첫 실행은 선택된 공급원의 `providerSeason`, `providerAiring`, `providerCatalog` 또는 대체 카탈로그 API를 호출한다(`src/app.js:921-941`). 이를 그대로 실행하면 이번에 금지된 실제 공급원 요청이 발생할 수 있다.

원본 파일을 계측하거나 시스템 네트워크 설정을 바꾸지 않고 main-process 요청까지 완전히 차단할 수 있는 격리 경로를 이번 범위에서 확인하지 못했다. 따라서 앱 UI를 띄우고 실제 Companion이 연결된 것처럼 꾸미지 않았다. 결과 상태는 **소스 무결성 검사 통과 / 안전한 외부 연결점 미발견 / 실제 런타임 attach 미실시**다. 공급원 요청, 영상 재생, NSIS, Computer Use는 수행하지 않았다.

## 두 연동 선택지

| 선택지 | 원본 파일 변경 | 원본 renderer 안에 UI 삽입 | 상태·조작 연결 | 업데이트 호환성 |
| --- | --- | --- | --- | --- |
| 원본 제작자가 공식 Companion 브리지와 UI 슬롯을 추가 | 필요 | 가능 | 명시한 데이터와 허용 동작을 앱이 전달 | 버전이 지정된 계약과 호환성 검사를 두면 관리 가능 |
| 원본 무수정 Windows 오버레이 | 불필요 | 불가. 별도 top-level 창이 원본 위에 겹칠 뿐 | 내부 선택 작품·회차를 공식적으로 읽거나 앱 동작을 제어할 수 없음 | 창 위치, DPI, 배율, 테마, 타이틀바 및 UI 배치 변화에 취약 |
| TCP CDP·DLL/메모리 삽입 | 원본 런타임 설정 또는 프로세스 개입 필요 | 기술적으로 가능할 수 있음 | 권한이 과도하고 보안 경계를 우회할 수 있음 | 금지된 경로이므로 사용하지 않음 |

오버레이는 창 이동·최대화·모니터 변경·Windows 배율·테마 변경 때 좌표를 계속 맞춰야 한다. 접근성 트리에서 읽은 텍스트가 있어도 앱 내부의 시즌/회차 식별자나 클릭 핸들러를 공식적으로 얻는다는 뜻은 아니다. 사용자가 원한 원본 방영 일정의 확장과 같은 결과가 아니다.

## 원본 제작자에게 요청할 최소 공식 브리지

외부 프로그램이 원본 DOM에 임의 JavaScript를 주입하는 API는 만들지 않는 편이 안전하다. 원본 앱이 UI를 소유하고 Companion은 제한된 데이터와 명령만 교환하도록 요청한다.

1. **앱 안의 안정된 UI 슬롯**: `#scheduleSection`에 호스트가 만든 Companion 컨테이너를 두고, 원본 CSS 변수·컴포넌트로 렌더링한다. Companion을 끄면 이 슬롯을 숨기고 앱이 모든 노드를 소유한다.
2. **로컬 전용 프로세스 브리지**: Windows named pipe를 쓰되 기본 보안 설명자를 그대로 사용하지 않는다. 현재 로그온 SID에 한정한 DACL, `PIPE_REJECT_REMOTE_CLIENTS`, 짧은 수명의 난수 pipe 이름과 페어링 nonce를 사용하고, 사용자 설정에서 연결을 명시적으로 허용·해제한다. Microsoft 문서는 named pipe 기본 DACL이 Everyone과 anonymous에 읽기 권한을 줄 수 있다고 경고하며, 로컬 전용 pipe는 원격 접근을 거부하도록 보안 설정해야 한다고 설명한다. [Named pipe security and access rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights), [Named pipes](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes)
3. **버전이 지정된 최소 메시지**: `hello(protocolMajor, companionId)`/`capabilities` 협상, `contextChanged(view, quarter, weekday, workId, seasonId, episodeId, theme)`, `scheduleUpdated(year, quarter, sevenDayItems)`를 제공한다. 상태는 필요한 식별자와 한국어 제목만 전달하고 사용자 토큰·쿠키·파일 경로는 포함하지 않는다.
4. **좁은 명령 허용 목록**: `openWork(workId, seasonId)`와 `openEpisode(workId, episodeNumber)`처럼 식별자만 받는다. URL, 임의 IPC 채널, HTML/JavaScript, shell 명령, 영상 주소를 Companion에서 직접 지정하지 못하게 하고, 실제 출처 탐색과 재생 결정은 원본 앱이 검증한다.
5. **renderer API 제한**: preload가 `contextBridge`를 통해 위 계약만 감싼 함수와 이벤트를 공개한다. raw `ipcRenderer`나 범용 `send(channel, data)`를 노출하지 않는다. main process는 sender와 메시지 크기·빈도·schema·권한을 검사하고 불일치 버전 연결을 거부한다.
6. **UI 실행 경계**: 데이터를 보낸다고 외부 프로세스의 UI가 renderer에 생기는 것은 아니다. 화면을 원본 안에 넣으려면 앱이 신뢰한 Companion renderer 코드를 앱 업데이트에 포함하거나, 앱이 서명·버전 검증한 UI 번들을 제한된 sandbox에서 열어 슬롯에 장착하는 방식까지 원본 제작자가 공식 설계해야 한다.

이 계약이면 Companion은 요일표 데이터를 공급하고, 원본은 화면 스타일·탐색·재생 권한을 소유한다. 앱과 Companion은 protocol major를 명시하고 기능 협상을 해야 한다. 새 원본 버전이 API major를 올리면 Companion이 연결을 중단하고 호환 버전을 요구하게 한다. CSS 클래스 이름에 의존하지 않도록 안정된 슬롯과 theme token을 문서화하면 UI 리팩터링의 영향을 줄일 수 있다.

## 최종 상태

- **질문 답변**: 현재 LilacAnime v0.5.14에서 허용된 공식 경로만으로 원본 renderer에 직접 연결하는 방법은 확인되지 않았다.
- **성공 증거**: 없음. 연결 성공을 주장하지 않는다.
- **실패 원인**: 외부 프로세스에 노출된 Companion/API endpoint가 없고, 앱 내부 `webContents` 및 preload IPC는 외부 프로세스에 공개되지 않는다. 남는 직접 경로는 금지된 remote debugging 또는 프로세스 개입이다.
- **다음 선행조건**: 원본 제작자가 위의 버전 지정 bridge와 UI slot을 원본에 공식 추가해야 한다. 그 전에는 Companion UI를 원본 화면에 연결하는 코드를 구현하지 않는다.
- **보호 조건**: `D:\LilacAnime`, 사용자 프로필, 업데이트 캐시, 기존 31개 캡처와 5개 로그를 건드리지 않았다. 이전 미추적 산출물은 새 worktree에 없으며 신규 커밋에 포함하지 않는다.
