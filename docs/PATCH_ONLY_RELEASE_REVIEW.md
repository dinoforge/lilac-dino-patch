# LilacAnime DinoPatch — 관리자 ZIP 전용 배포 검토

검토일: 2026-11-11. 범위: Windows x64 **패치 관리자만** 포함한 GitHub Actions ZIP. 공식 LilacAnime Desktop 전체 앱이나 기존 루트 `build.yml`의 원본 앱 배포는 검토 대상이 아니다.

## 검증한 사실

- [성공한 최초 이름 변경 빌드](https://github.com/dinoforge/lilac-dino-patch/actions/runs/43002889119)의 ZIP `LilacAnime-DinoPatch-Windows-x64.zip` (SHA-256 `08E76611E94B98D3302A150DEFDC48A74487DE38B1C79BBCC646050FC27DC4C8`)을 내려받아 실제 압축 내용을 검사했다.
- ZIP에는 `DinoPatchManager/` 아래 Windows 관리자, 별도 Python 패치 엔진, `integrated-search.js`, `integrated-search.css`, `patch03-bridge.js`, 패치 매니페스트, Electron/Node/Python 실행 환경이 포함된다.
- **공식 LilacAnime Desktop의 전체 소스 트리, `src/app.js` 원본 파일, `src/index.html` 원본 파일, 공식 로고, 포스터, 영상 및 자막 파일은 ZIP 안에서 확인되지 않았다.** 공식 원본 소스는 사용자 PC에 따로 있어야 하며, 관리자가 그 소스를 검사·백업하고 수정한다.
- 공식 업스트림 저장소 트리에는 위 3개 디노 패치 모듈 이름이 존재하지 않는다. 단, 이것만으로 작성자·소유권을 증명하는 것은 아니다.
- 배포된 `patches/patch03/manifest.json`의 `before`/`after` 연결 조건에는 공식 `src/app.js` 및 `src/index.html`에서 복사한 **짧은 코드·HTML 맥락 문자열**이 포함된다. 공식 앱 전체가 없어도 이 문자열의 용도·범위는 별도 확인이 필요하다.
- **첫 ZIP에는 불필요한 빌드용 npm 의존성**(`electron-builder`, Electron 추가 복제본 등)이 함께 들어 있었다. 이는 원본 LilacAnime 앱 복제가 아니라 패키징 설정 문제다. 정리 빌드에서는 실행에 필요한 프로덕션 의존성만 포함해야 한다.

## 배포할 프로덕션 Node 패키지

기존 ZIP에 포함된 `classic-level@3.0.0`의 npm 패키지 메타데이터를 따라 프로덕션 의존성 12개를 직접 열어 확인했다.

| 패키지 | 버전 | 라이선스 |
| --- | --- | --- |
| classic-level | 3.0.0 | MIT |
| abstract-level | 3.1.1 | MIT |
| module-error | 1.0.2 | MIT |
| napi-macros | 2.2.2 | MIT |
| node-gyp-build | 4.8.4 | MIT |
| buffer | 6.0.3 | MIT |
| is-buffer | 2.0.5 | MIT |
| level-supports | 6.2.0 | MIT |
| level-transcoder | 1.0.1 | MIT |
| maybe-combine-errors | 1.0.0 | MIT |
| base64-js | 1.5.1 | MIT |
| ieee754 | 1.2.1 | BSD-3-Clause |

기존 ZIP에서 이 12개 패키지 모두 개별 LICENSE 파일을 확인했다. Electron에는 `LICENSE.electron.txt`, `LICENSES.chromium.html`이 포함되어 있다. 별도 Node 실행 파일, Python/PyInstaller 런타임의 고지와 새 압축본에 실제로 포함된 파일은 **새 빌드 결과로 다시 확인해야 한다**.

## 배포 범위 판단

공식 앱 저장소에 LICENSE가 없는 사실은 **그 공식 앱의 복제·수정본 배포를 자동으로 허락하지 않는다는 뜻**이다. 그러나 공식 앱 전체를 포함하지 않는 독립 패치 관리자 ZIP의 모든 코드에 그 금지가 자동으로 적용된다는 뜻도 아니다.

게시 전에는 (1) 새 ZIP에 원본 앱 코드·에셋이 추가되지 않았는지, (2) 배포하는 자체 코드·패치 스니펫에 대한 작성자 권한이 있는지, (3) 내장 실행 환경과 라이브러리의 라이선스 고지를 충족하는지, (4) 릴리즈 설명에서 비공식 패치임을 명확히 하는지를 확인한다. 외부 서비스에 접근하는 기능의 이용 조건은 실제 데이터·영상 배포 권한과 분리해 취급하며, 제3자 영상·자막은 ZIP에 포함하지 않는다.

**결론:** 원본 LilacAnime Desktop **전체 앱 재배포 허가를 필수 요건으로 일괄 적용하는 것은 과도하다.** 다만 새 ZIP의 제3자 라이선스 고지 및 패치 코드 출처를 확인하기 전까지 자동 게시를 승인했다고 표기하지 않는다.

이 문서는 공식 권리자 허가를 대신하거나 사용자의 저작권 보유를 독립적으로 증명하지 않는다.

## 2026-11-11 최종 패치 전용 프리릴리즈

- [Actions Windows 빌드 #43012176628](https://github.com/dinoforge/lilac-dino-patch/actions/runs/43012176628)에서 패치 관리자 Windows x64 빌드, 패키징 후 LevelDB 읽기·쓰기 기본 검사, ZIP 압축·파일 수 검사 및 필수 라이선스 파일 확인을 통과했다.
- 최종 아티팩트 소스 커밋: `ec440df476d4fc47738d0d3f3497c148339a6fcc`.
- 최종 ZIP: `LilacAnime-DinoPatch-Windows-x64.zip`, 크기 192,178,346바이트, SHA-256 `90C56F620ED1BFA0F4692866AFE4921DC1FBC2DEDC69E635558E829FC016E3CF`.
- 프로덕션 npm 패키지만 남겨 개발용 Electron/electron-builder 중복 폴더를 제외했다. 각 패키지 LICENSE와 Electron/Chromium 고지, `THIRD_PARTY_LICENSES/Node.js-LICENSE.txt`, `THIRD_PARTY_LICENSES/Python-LICENSE.txt`를 ZIP에 포함시켰다.
- [프리릴리즈 dino-v0.1.0-beta.1](https://github.com/dinoforge/lilac-dino-patch/releases/tag/dino-v0.1.0-beta.1)에 ZIP과 `SHA256SUMS.txt`를 게시했다. 릴리즈 워크플로 #43012865575는 동일 소스 커밋, 압축 검사, 원본 앱 소스·영상·자막 부재, 필수 고지 파일 존재를 검증했다.
- 기존 `.github/workflows/build.yml`의 원본 앱 빌드용 `LILAC_RELEASE_RIGHTS_APPROVED` 게이트를 수정·설정하지 않았다. 별도 패치 전용 릴리즈만 게시했다.
- 이 기록은 원본 앱의 재배포 허가가 생겼다는 뜻도, 개별 패치 스니펫·서비스 이용 조건에 대한 법률적 판정도 아니다. 릴리즈는 현재 **비공개 저장소의 프리릴리즈**이며 접근 권한 없는 계정에는 제공되지 않는다.

## 2026-11-11 Beta 2 경량판 검증 및 게시

- 빌드: [Windows Actions #43015434982](https://github.com/dinoforge/lilac-dino-patch/actions/runs/43015434982), 입력 소스 커밋 `b159eb7f02b29f52b68f85a61ebc758b6f455eb5`.
- 실제 ZIP: `LilacAnime-DinoPatch-Windows-x64.zip`, 140,994,541바이트, SHA-256 `3A1B2C94765A020BA10D0D654ED9A9834F70332635E92146C70A7B2725F2B599`. ZIP 압축 내용과 해시를 별도로 재확인했다.
- Electron의 Node.js 22.22.0 실행 모드를 Python 패치 엔진의 개별 검증 프로세스에서 재사용하도록 변경하여 별도 `node.exe`를 포함하지 않았다. `--check`, `--test`, LevelDB 읽기·쓰기와 Python 브리지 실행 검사가 통과했다.
- `locales`에는 `ko.pak`과 `en-US.pak`만 남겼다. 중복 `app.asar.unpacked/node_modules`와 Windows x64 이외의 LevelDB 네이티브 모듈을 제외했다. Electron·Chromium·Node·Python 및 npm 패키지 고지는 유지했다.
- [프리릴리즈 dino-v0.1.0-beta.2](https://github.com/dinoforge/lilac-dino-patch/releases/tag/dino-v0.1.0-beta.2)로 경량판과 `SHA256SUMS.txt`를 게시했다. 릴리즈 검증 작업 #43016363836은 성공했다. 기존 Beta 1은 변경·삭제하지 않았다.
- 공식 LilacAnime 앱 전체, 공식 설치본, 영상·자막 파일은 포함하지 않는다. 비공식 독립 프로젝트이며 저장소는 비공개이다. 코드 출처 및 제3자 서비스의 이용 조건을 명시적으로 보증한다는 뜻은 아니다.
