# 의존성·실행파일·모델 라이선스 인벤토리

검토일: 2026-10-09<br>
기준 커밋: `5e5a3957433f75ed5389595cb966c70975f3ab10`<br>
범위: 현재 `package-lock.json`의 프로덕션 의존성 폐쇄, 직접 개발 의존성, 빌드에 포함되는 FFmpeg/JASSUB 자산, 로컬 AI 런타임과 모델, 추적 가능한 이미지 에셋

이 문서는 파일·패키지 메타데이터와 공개된 라이선스 문구를 정리한 기술 인벤토리다. 법률 자문이나 재배포 허가가 아니며, 선언된 SPDX 문자열만으로 바이너리·폰트·모델의 전체 조건이 해결됐다고 보지 않는다. 권리 범위가 불명확한 항목은 공개 배포 차단 상태로 둔다.

## 요약

- `package-lock.json`은 lockfile v3이며, 프로덕션 의존성 폐쇄는 45개 패키지다. 잠금 메타데이터 기준 29개 MIT, 10개 BSD-2-Clause, 2개 Apache-2.0, 2개 ISC, 1개 GPL-3.0-or-later, 1개는 라이선스 메타데이터가 없다.
- 직접 프로덕션 의존성은 `adm-zip@0.6.1`, `cheerio@1.1.2`, `ffmpeg-static@5.3.0`, `hls.js@1.7.3`이다. FFmpeg 실행 파일은 설치 앱에 실제 포함되므로 GPL 조건 검토가 배포 차단 항목이다.
- JASSUB는 개발 의존성이지만 빌드 전 JavaScript·WebAssembly·폰트를 `src/vendor/jassub`에 생성해 앱에 넣는다. 패키지의 라이선스 메타데이터는 복합 SPDX 식이고, 생성 스크립트는 메타데이터의 모든 구성요소 고지를 대조하지 않은 채 패키지의 MIT `LICENSE` 파일 하나만 복사한다.
- llama.cpp 실행 파일과 GGUF 모델은 설치 파일에 넣지 않고 첫 사용 때 사용자의 `userData/local-ai`에 내려받는다. 설치 번들 밖이라는 사실은 모델·실행 파일의 사용 조건을 면제하지 않는다. 선택 가능한 일부 정확한 모델 저장소에 비상업·지역 제한 또는 미확인 조건이 있다.
- 프로젝트 루트에 `LICENSE`/`NOTICE`가 없고 `package.json`의 `MIT` 선언만 있다. 프로젝트 원본 코드와 `src/logo.png`, `build/icon.png`, `build/icon.ico`의 출처·재배포 권리는 여전히 확인되지 않았다.

## 프로덕션 의존성 폐쇄

아래는 잠금 파일의 패키지 경로·버전·라이선스 메타데이터를 기준으로 묶었다. 중첩 경로는 중복 버전을 구분한다. 각 패키지의 고지·저작권 파일 유무와 바이너리 재배포 조건은 별도 확인 대상이다.

| 잠금 라이선스 메타데이터 | 수 | `package@version` |
|---|---:|---|
| MIT | 29 | `@derhuerst/http-basic@8.2.4`, `adm-zip@0.6.1`, `buffer-from@1.1.2`, `cheerio@1.1.2`, `cheerio/node_modules/undici@7.30.0`, `concat-stream@2.0.0`, `concat-stream/node_modules/readable-stream@3.6.2`, `debug@4.4.3`, `dom-serializer@2.0.0`, `encoding-sniffer@0.2.1`, `env-paths@2.2.1`, `ffmpeg-static/node_modules/agent-base@6.0.2`, `ffmpeg-static/node_modules/https-proxy-agent@5.0.1`, `htmlparser2@10.1.0`, `http-response-object@3.0.2`, `http-response-object/node_modules/@types/node@10.17.60`, `iconv-lite@0.6.3`, `ms@2.1.3`, `parse5@7.3.0`, `parse5-htmlparser2-tree-adapter@7.1.0`, `parse5-parser-stream@7.1.2`, `progress@2.0.3`, `safe-buffer@5.1.2`, `safer-buffer@2.1.2`, `string_decoder@1.1.1`, `typedarray@0.0.6`, `util-deprecate@1.0.2`, `whatwg-encoding@3.1.1`, `whatwg-mimetype@4.0.0` |
| BSD-2-Clause | 10 | `cheerio-select@2.1.0`, `css-select@5.2.2`, `css-what@6.2.2`, `domelementtype@2.3.0`, `domhandler@5.0.3`, `domutils@3.2.2`, `entities@4.5.0`, `htmlparser2/node_modules/entities@7.0.1`, `nth-check@2.1.1`, `parse5/node_modules/entities@6.0.1` |
| Apache-2.0 | 2 | `caseless@0.12.0`, `hls.js@1.7.3` |
| ISC | 2 | `boolbase@1.0.0`, `inherits@2.0.4` |
| GPL-3.0-or-later | 1 | `ffmpeg-static@5.3.0` |
| 메타데이터 없음 | 1 | `parse-cache-control@1.0.1` — 패키지에 `LICENSE` 파일은 있다. 그 텍스트는 3조건 BSD 계열 문구지만 `package.json`에 SPDX 식별자가 없어 목록에 임의로 채우지 않았다. |

이 표는 현재 잠금 파일의 프로덕션 폐쇄만 다룬다. 개발 도구 전체의 전이 의존성 목록은 포함하지 않는다. 개발 직접 의존성은 Electron, electron-builder, esbuild, JASSUB이며, 아래처럼 앱 실행 파일 또는 번들에 들어가는 결과물은 별도 검토한다.

## 실행 파일·번들 자산

### FFmpeg — 공개 배포 차단

- `ffmpeg-static@5.3.0`은 직접 프로덕션 의존성이고 `package.json`에서 `node_modules/ffmpeg-static/**`를 `asarUnpack` 대상으로 지정한다. 코드에서는 HLS 다운로드 remux 및 OP/ED 오디오 지문 계산에 실행한다.
- 동봉 README와 `ffmpeg -version`, `-buildconf`, `-L` 결과는 `www.gyan.dev` FFmpeg 6.1.1 essentials, GPL v3 및 정적 구성과 일치한다. README는 FFmpeg 커밋 `e38092ef93`, 구성 옵션, 외부 라이브러리 버전 목록을 적고 `libx264`, `libx265`, `libass` 등을 열거한다. 바이너리는 82,797,568바이트이며 SHA-256은 `04E1307997530F9CF2FE35CBA2CA7E8875CA91DA02F89D6C7243DF819C94AD00`이다.
- 현재 unpacked 앱에는 `ffmpeg.exe.LICENSE`와 `ffmpeg.exe.README`가 있고, `node_modules`의 실행 파일과 unpacked 앱의 실행 파일은 SHA-256이 같다. 이로써 현재 로컬 패키지가 같은 빌드 바이너리와 고지 파일을 담았음을 확인했다. README의 FFmpeg 커밋은 FFmpeg 본체의 출처를 식별하고 외부 라이브러리 버전 문자열도 제공하지만, 앱 패키지에는 대응 소스 아카이브, 모든 외부 라이브러리의 source snapshot/patch 및 전체 Gyan 빌드 레시피가 없다. 따라서 현재 패키지로 완전한 재현 빌드까지 확인한 것은 아니다.
- Gyan의 공식 빌드 안내는 Windows 빌드가 정적이며 GPLv3라고 밝히고 essentials 구성요소에 `libx264`, `libx265`를 열거한다. `ffmpeg-static`은 Windows x64 바이너리 출처로 Gyan을 지목하며 각 바이너리 README의 정확한 원본 버전을 확인하도록 한다. FFmpeg의 법적 안내는 GPL 대상 선택 구성요소를 쓰면 FFmpeg 전체에 GPL이 적용된다고 설명한다. 그 페이지의 세부 체크리스트는 LGPL 동적 링크 사례를 다루므로, 이를 이 별도 실행 파일과 앱의 결합에 대한 법률 결론으로 확대하지 않는다.
- 패키지 메타데이터 `GPL-3.0-or-later`와 바이너리 README의 `GPL v3`를 함께 기록한다. 이 자료만으로 앱 전체의 라이선스가 어떻게 되는지 결론 내리지 않는다. 실제 바이너리 빌드 구성에 맞는 완전한 대응 소스, 저작권·라이선스 고지, 재배포 방법과 앱 결합 조건을 해결하기 전에는 설치 파일 배포를 승인하지 않는다.
- 대체 또는 재빌드가 필요하면 FFmpeg 의존 기능 두 곳을 모두 추적하고, 배포용 빌드 구성·해당 소스·고지를 한 세트로 고정한다. 이 인벤토리 작업에서는 런타임이나 기능을 바꾸지 않았다.

### JASSUB / libass WebAssembly — 고지 대조 필요

- 이 앱은 `package-lock.json`에서 `jassub@2.5.16` npm tarball과 SHA-512 무결성을 고정한다. 잠금 정보에는 upstream Git commit이 없다. 해당 패키지의 SPDX 식은 `LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0`이고, 패키지 `LICENSE` 파일은 JASSUB 기여자의 MIT 문구다.
- 2026-10-09 npm 레지스트리 조회에서 2.5.16 게시 시각은 `2026-09-05T18:49:36.487Z`였고, package metadata에 `gitHead`가 없다. upstream 태그 조회에는 `1.8.8`만 나왔다. 저장소의 [`c369b0f`](https://github.com/ThaUnknown/jassub/commit/c369b0f6768a9719201ba1663a18e7f8d4367af1)는 package version을 2.5.16으로 표시하지만 10월 3일 커밋이며, 설치된 2.5.16 tarball의 `src/jassub.ts`·worker·WebGL renderer 파일과 일치하지 않는다. 이 커밋의 submodule gitlink를 npm 산출물의 revision으로 간주할 수 없으므로, 해당 tarball의 정확한 source commit과 submodule revisions는 여전히 식별되지 않았다.
- `scripts/build-jassub.cjs`는 JavaScript와 worker를 `legalComments: 'inline'`로 묶고 worker WASM 두 개, `default.woff2`, 단일 `LICENSE`를 복사한다. 실제 생성된 두 JavaScript 파일에는 `/*! ... */` 법적 배너가 없고, 현재 `app.asar`의 JASSUB 파일 목록에도 집계된 `COPYRIGHT`나 `THIRD-PARTY-NOTICES`가 없다. 기존 설정만 보고 인라인 고지가 포함됐다고 판단할 수 없다.
- `default.woff2`는 145,972바이트, SHA-256 `886929903707C5BB28B07CD2EED69921B3D5EF5C49C73A0DD1E187EBF6546A4C`다. npm 패키지의 `dist/default.woff2`는 upstream의 [`src/default.woff2`](https://github.com/ThaUnknown/jassub/blob/b032ce1ea11211360d946f512892159391cba19a/src/default.woff2)와 바이트 단위로 일치하며, JASSUB 소스는 이를 기본 `liberation sans`로 사용한다. 저장소의 해당 글꼴 추가 커밋과 파일은 확인됐지만, 글꼴의 원 저작권자·원본 다운로드 위치·적용 라이선스는 여전히 확인되지 않았다.
- 참고한 upstream `main`은 검사 시 `2.5.18`이며 commit은 `b78bc67194d4b63fab8bf82db54be8cec31fa207`이다. 그 고정 소스의 [`Makefile_licence`](https://github.com/ThaUnknown/jassub/blob/b78bc67194d4b63fab8bf82db54be8cec31fa207/Makefile_licence)는 JASSUB와 Brotli·Expat·FreeType·FriBidi·HarfBuzz·libass의 저작권·라이선스를 모아 `dist/license/all`을 만들고 `dist/js/COPYRIGHT`에 복사한다. [`.gitmodules`](https://github.com/ThaUnknown/jassub/blob/b78bc67194d4b63fab8bf82db54be8cec31fa207/.gitmodules)는 일부 소스 저장소를 열거한다. 이는 2.5.16 npm tarball의 정확한 소스·submodule revision이나 폰트 권리를 증명하지 않으므로, 이 파일을 그대로 2.5.16의 고지로 대체하지 않는다. upstream package metadata도 [복합 SPDX 식](https://github.com/ThaUnknown/jassub/blob/b78bc67194d4b63fab8bf82db54be8cec31fa207/package.json)을 표시한다.
- 공개 전 조치: 2.5.16 산출물에 대응하는 source commit과 각 submodule revision을 확정하거나, 재현 가능한 고지·빌드가 포함된 버전을 선택한다. 글꼴 출처를 확인하고, 검증한 전체 고지를 생성 및 NSIS 패키지에 포함한 뒤 내용을 검사한다. 지금은 라이선스 충족이나 재배포 허가를 결론 내리지 않는다.
- 현재 `dist/win-unpacked`에는 Electron의 `LICENSE.electron.txt`와 Chromium `LICENSES.chromium.html`이 있다. 이는 해당 로컬 빌드 산출물에서 확인한 사실이며 향후 빌드 산출물까지 자동 보장하는 결과는 아니다.

### 개발 직접 의존성

| 패키지 | 잠금 버전 | 확인한 라이선스 정보 | 비고 |
|---|---:|---|---|
| `electron` | 38.8.6 | MIT | 앱 런타임. 현재 unpacked 패키지에 Electron·Chromium 고지 파일이 존재한다. |
| `electron-builder` | 26.15.3 | MIT | 빌드 도구. 개발 도구 전이 의존성 전체는 이번 표에 포함하지 않았다. |
| `esbuild` | 0.28.2 | MIT | JASSUB 브라우저 번들 생성에 사용한다. |
| `jassub` | 2.5.16 | 복합 SPDX 식 | 실제 생성물은 위 JASSUB 절의 검토 대상이다. |

## 첫 사용 때 내려받는 AI 런타임과 모델

`electron/local-ai.cjs`는 llama.cpp Windows 빌드와 GGUF를 첫 사용 때 받아 사용자 프로필의 `userData/local-ai`에 저장한다. llama.cpp 저장소는 MIT를 표방하지만, 앱은 GitHub Releases의 최신 적합 자산을 조회해 받으므로 구체적인 release tag·바이너리·포함된 네이티브 라이브러리 고지를 빌드별로 고정·검토하지 않았다. 릴리스 자산별 라이선스 파일과 출처 코드를 확인하고, 업데이트 시에도 같은 검토가 필요하다.

현재 모델 카탈로그는 기본 목록과 기존 설치 모델 호환용 legacy 항목을 함께 보유한다. 모델 가중치는 설치 파일에 번들되지 않지만, 앱이 특정 모델 저장소에서 내려받도록 연결되어 있다.

| 코드의 모델 저장소 | 상태·확인된 조건 | 남은 조치 |
|---|---|---|
| `google/gemma-4-E4B-it-qat-q4_0-gguf` | 저장소 카드에는 Apache-2.0으로 표시되지만 Google 공식 Gemma 4 안내는 별도 Gemma 4 라이선스를 가리킨다. | 해당 GGUF 파일의 배포 조건과 공식 Gemma 4 조건의 관계를 확인할 때까지 미확정으로 둔다. E2B·26B GGUF는 저장소별로 별도 확인한다. |
| `tencent/Hy-MT2-1.8B-GGUF` | 정확한 GGUF 저장소는 Apache-2.0으로 표시된다. | 사용하는 정확한 파일·리비전·고지를 기록한다. 7B·30B GGUF를 같은 조건으로 간주하지 않는다. |
| `bartowski/aya-expanse-8b-GGUF` | 저장소는 CC-BY-NC-4.0 및 gated accept를 표시한다. 비상업 조건을 일반 배포 허가로 확대 해석하지 않는다. | 비상업 조건의 사용자 기능·배포 모델 적용 범위를 확인하고, 필요한 접근 조건·출처 고지를 처리한다. |
| `tencent/HY-MT1.5-7B-GGUF` | 라이선스 문구는 EU, 영국, 대한민국을 적용 지역에서 제외한다. 현재 사용 지역이 대한민국이므로 이 모델을 한국에서 사용·배포할 수 있다는 허가를 확인하지 못했다. 코드는 기존 설치 모델 호환용 legacy 항목으로 남긴다. | 사용을 제공하려면 별도 권한을 확인하거나 한국 환경에서 해당 legacy 모델을 차단하는 결정을 내려야 한다. 기존 사용자 모델 파일은 이 문서 작업에서 열거나 변경하지 않았다. |
| `tencent/HY-MT1.5-1.8B-GGUF` | 코드가 legacy 저장소로 가리키나 정확한 저장소의 조건을 이번 검토에서 확인하지 못했다. | 정확한 라이선스·지역 적용을 확인한다. |
| `hell0ks/ja-ko-vn-7b-v1-gguf` | 코드가 양자화 저장소를 가리킨다. 기본 모델 저장소의 Apache-2.0만으로 GGUF 파일의 조건을 증명할 수 없다. | 정확한 양자화 저장소의 라이선스와 필수 고지를 확인한다. |
| `tencent/Hy-MT2-7B-GGUF`, `tencent/Hy-MT2-30B-A3B-GGUF`, `google/gemma-4-26B-A4B-it-qat-q4_0-gguf` | legacy 항목. 정확한 GGUF 저장소별 조건을 이 인벤토리에서 확정하지 않았다. | 각 정확한 저장소·파일을 별도 조사한다. |
| 사용자가 직접 고른 임의 GGUF | 앱에서 외부 모델 파일 선택을 지원한다. | 앱은 임의 GGUF의 라이선스·배포 권리를 검증하지 않는다. 사용자가 적법한 모델을 선택한다는 점과 모델 제공 약관을 분리해 안내해야 한다. |

## 이미지 에셋과 프로젝트 라이선스

| 저장소 경로 | 현재 SHA-256 | 출처·권리 상태 |
|---|---|---|
| `src/logo.png` | `EE1FA521925ED94E206584CB9DDD33F851187421E36504DDFFD294F47CA7C74C` | 출처·재배포 허가 미확인 |
| `build/icon.png` | `3F5AF33FF58380942AD60B1D8053398BB3A34F38F5A51721D2D6178FFD7E0757` | 출처·재배포 허가 미확인 |
| `build/icon.ico` | `0F9572E9C58ADA34E67C8A01BAAA2F3520BF21C65F01467A520C340704F748D4` | 출처·재배포 허가 미확인 |
| `src/assets/tmdb-logo-primary-blue.svg` | 이번 표에서 해시를 기록하지 않음 | TMDB 공식 승인 로고로 확인해 `docs/RIGHTS_REVIEW.md`에 사용 조건·About 크레딧을 기록했다. |

`package.json`의 프로젝트 `MIT` 필드만으로 루트 코드·업스트림 코드·브랜드·이미지의 권리가 증명되지 않는다. 업스트림 저장소의 LICENSE 부재와 허가 범위 미확인 사항은 `docs/RIGHTS_REVIEW.md`의 배포 차단 상태를 유지한다.

## 배포 전에 끝낼 일

1. FFmpeg 현재 Windows 바이너리의 구성 요소·대응 소스·고지·재배포 조건을 실제 배포 방안과 함께 검토한다. 해결 전 설치 파일·릴리스 공개를 보류한다.
2. JASSUB의 JS, WASM, worker, 글꼴과 전이 구성요소를 패키지 출처까지 추적하고 필요한 LICENSE/NOTICE 파일을 생성 스크립트와 최종 패키지에 포함한다.
3. AI 모델의 정확한 GGUF 저장소·파일 리비전마다 라이선스를 확인한다. 한국에서 사용할 수 없는 HY-MT1.5 7B legacy 항목은 권리 확인 또는 지역 제한 결정을 하기 전까지 사용 가능하다고 표시하지 않는다.
4. 다운로드되는 llama.cpp release와 지원되는 각 Windows 빌드의 네이티브 구성요소 고지를 추적 가능하도록 고정한다.
5. 프로젝트 원본 코드, 로고, 아이콘의 출처와 재배포 권한을 확인한다. 필요하면 정식 허가된 에셋으로 교체하되 사용자 작업과 기존 데이터는 보존한다.

## 확인 자료

- 로컬: `package.json`, `package-lock.json`, `node_modules/*/package.json` 및 각 패키지 고지 파일, `scripts/build-jassub.cjs`, `electron/local-ai.cjs`, `electron/download-manager.cjs`, `electron/oped-fingerprint.cjs`, 현재 `dist/win-unpacked`.
- [FFmpeg 법적 안내](https://www.ffmpeg.org/legal.html), [ffmpeg-static 저장소와 Windows 바이너리 출처 설명](https://github.com/eugeneware/ffmpeg-static), [Gyan FFmpeg Windows 빌드와 GPLv3·정적 구성 안내](https://www.gyan.dev/ffmpeg/builds/), [현재 바이너리가 가리키는 FFmpeg 원본 커밋](https://github.com/FFmpeg/FFmpeg/commit/e38092ef93).
- [JASSUB 저장소 및 태그](https://github.com/ThaUnknown/jassub), [JASSUB 2.5.16 npm package](https://www.npmjs.com/package/jassub/v/2.5.16), [JASSUB tags](https://github.com/ThaUnknown/jassub/tags), [Electron 앱 배포 문서](https://www.electronjs.org/docs/latest/tutorial/application-distribution), [llama.cpp 저장소](https://github.com/ggml-org/llama.cpp).
- [Gemma 4 QAT GGUF 카드](https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf), [Google Gemma 조건](https://ai.google.dev/gemma/terms), [Tencent Hy-MT2 1.8B 저장소](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF), [Aya Expanse GGUF 저장소](https://huggingface.co/bartowski/aya-expanse-8b-GGUF), [Tencent HY-MT1.5 라이선스](https://huggingface.co/tencent/HY-MT1.5-7B-GGUF/blob/main/License.txt), [ja-ko-vn 기본 모델](https://huggingface.co/hell0ks/ja-ko-vn-7b-v1).

### 확인 범위의 한계

- 실제 설치 프로그램을 외부에 배포하거나 실제 공급원에서 영상·자막을 요청하지 않았다.
- 이 인벤토리 변경에서는 다운로드 코드, 의존성 버전, 모델 파일, 사용자 프로필, 생성된 JASSUB 자산을 수정하지 않았다.
- SPDX 집계는 현재 잠금 메타데이터의 분류이며, 라이선스 적합성 판정·취약점 점검·모든 개발 도구 전이 의존성 감사는 아니다.
