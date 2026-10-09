# 의존성·실행파일·모델 라이선스 인벤토리

검토일: 2026-10-09<br>
기준 커밋: `859922ff816fff5c97c87d0060c90053206ab053`<br>
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

#### LGPL 대체 후보 스모크 (2026-10-09, 미채택)

- [BtbN/FFmpeg-Builds 고정 릴리스](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-10-08-13-05)의 `ffmpeg-n9.0.2-23-g27b46f0fbc-win64-lgpl-shared-9.0.zip`을 임시 폴더에서 조사했다. 아카이브는 77,229,825바이트이고 SHA-256 `a168ed7b315366354df532a755a93341b6e7e66b65834f56ce36b3ee8be0d6f0`이 GitHub 릴리스 API digest와 `checksums.sha256` 양쪽에 일치했다.
- `-version`, `-buildconf`, `-L` 출력은 FFmpeg `n9.0.2-23-g27b46f0fbc-20261008`, 공유 라이브러리 구성, LGPL 3 이상 문구를 보여 준다. 빌드 설정에는 `--disable-libx264`, `--disable-libx265`가 있고, 이 앱의 FFmpeg 호출은 인코딩 대신 remux와 오디오 디코딩을 사용한다. 이것은 후보 빌드의 기술 속성 기록이며 배포 적합성에 대한 법률 결론이 아니다.
- 같은 고정 릴리스의 `ffmpeg-n8.1.3-14-g330caae0c1-win64-lgpl-shared-8.1.zip`도 비교했다. 80,993,033바이트 아카이브의 SHA-256 `1af9562d002b8e2ab66817616e8a9211e77ab4b0fef58c5c345f467dc0213729`가 API digest와 릴리스 checksum에 일치했고, `-L`도 LGPL 3 이상, 빌드 설정도 x264/x265 비활성화를 표시했다. 같은 합성 HLS 입력을 remux하고 시작·끝 PCM을 얻었다.
- 두 후보 `ffprobe`는 8.021초 H.264/AAC MP4를 확인했다. 9.0.2의 시작·끝 `-ss 0`/`-sseof -1` 디코딩 결과는 mono 8 kHz `s16le` 15,670/16,000바이트였고, 8.1.3은 각각 16,000바이트였다. 이 차이는 합성 AAC 자료에서 관찰한 출력 길이 차이이며 실제 지문 품질이나 공급원 호환성을 증명하지 않는다.
- 별도 합성 오디오 7종(AAC ADTS, AC-3, E-AC-3, FLAC, MP3, Opus, Vorbis)도 두 후보에서 시작 `-ss 0.5`와 끝 `-sseof -1`을 사용해 1초 mono 8 kHz `s16le`로 디코딩했다. 28개 조합 모두 성공했고 각 출력은 대부분 16,000바이트였으며 끝 Opus는 15,896바이트였다. 입력은 현재 로컬 FFmpeg로 만든 사인파이며 실제 회차의 디코딩·지문 일치를 증명하지 않는다.
- 9.0.2의 전체 추출 폴더와 `bin`은 각각 191,013,197바이트와 176,381,440바이트였고, 8.1.3은 201,293,642바이트와 186,729,472바이트였다. 둘 다 `bin`에 10개 파일(7개 DLL, ffmpeg/ffplay/ffprobe)이 있고, 전체 아카이브에는 LGPL `LICENSE.txt`, 헤더, 라이브러리·문서·프리셋 폴더가 있으나 C/C++ 소스 파일은 없었다. 현재 정적 FFmpeg 실행 파일은 82,797,568바이트라 직접 비교는 아니며, 배포 최소 DLL 집합 크기도 측정하지 않았다.
- 정확한 대응 FFmpeg·외부 라이브러리 소스와 패치, 전체 빌드 입력, 구성요소별 재배포 고지는 아직 한 세트로 확인하지 않았다. 두 후보 모두 기능 스모크만 통과했고 미채택이다. 버전 차이, 실제 패키징 크기, 고지·소스와 배포 조건을 더 확인해야 한다.
- 기존 `ffmpeg-static` 의존성, 설정 및 앱 패키지는 그대로다. 앱이 실제 사용하는 두 작업을 후보로 검사했다는 뜻이지, 후보가 실제 다운로드·지문 경로 전체에 통합됐다는 뜻은 아니다.

### JASSUB / libass WebAssembly — 고지 대조 필요

- 이 앱은 `package-lock.json`에서 `jassub@2.5.16` npm tarball과 SHA-512 무결성을 고정한다. SPDX 식은 `LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0`이고, npm 배포물의 `LICENSE`는 JASSUB 기여자의 MIT 문구다. 레지스트리 metadata에는 `gitHead`와 `dist.attestations`가 없다.
- npm 게시 시각은 `2026-09-05T18:49:36.487Z`다. 게시 4분 23초 전인 [`656371a`](https://github.com/ThaUnknown/jassub/commit/656371af1c904be59a1008dcdb93f18dfe5e23d0)은 `2026-09-05T18:45:13Z` 커밋이다. 해당 트리와 npm tarball의 파일 blob을 대조했다. `LICENSE`, README, 9개 TypeScript 원본은 같은 경로에서 일치하고, `dist/default.woff2` 및 두 `dist/wasm/*.wasm`은 해당 커밋의 `src/` 파일과 바이트 단위로 일치한다. package.json도 버전(커밋 `2.5.15`, npm `2.5.16`)을 제외한 모든 필드가 일치한다. 따라서 이 커밋은 npm 배포물의 강한 콘텐츠 출처 후보지만, 생성된 `dist` JavaScript는 그 커밋 트리에 같은 경로로 기록돼 있지 않고 npm provenance attestation도 없어 전체 tarball의 재현 빌드 증명으로 보지는 않는다. 이후 커밋 [`c369b0f`](https://github.com/ThaUnknown/jassub/commit/c369b0f6768a9719201ba1663a18e7f8d4367af1)는 게시 뒤인 10월 3일이므로 2.5.16의 출처로 삼지 않는다.
- 위 커밋의 Git submodule 고정값은 `lib/brotli=e61745a6b7add50d380cfd7d3883dd6c62fc2c71`, `lib/freetype=801cd842e27c85cb1d5000f6397f382ffe295daa`, `lib/fribidi=247fddc3599e3fe7b1b5cc21020c9eb51e662637`, `lib/harfbuzz=afcae83a064843d71d47624bc162e121cc56c08b`, `lib/libass=266b9831d7a7f513db48a02ade91c1f3e2fcd7a3`다. source tree의 [`Makefile_licence`](https://github.com/ThaUnknown/jassub/blob/656371af1c904be59a1008dcdb93f18dfe5e23d0/Makefile_licence)는 JASSUB와 Brotli·Expat·FreeType·FriBidi·HarfBuzz·libass의 고지를 모으도록 돼 있다. 같은 커밋의 `.gitmodules`에는 다섯 submodule만 있고 `lib/expat` 경로는 없어, 해당 generator가 Expat 자료를 어디서 얻는지도 아직 해소되지 않았다.
- 같은 고지 도구의 [`build/license_defaults`](https://github.com/ThaUnknown/jassub/blob/656371af1c904be59a1008dcdb93f18dfe5e23d0/build/license_defaults)는 JASSUB와 Brotli를 Expat(MIT), libass를 ISC, FriBidi를 LGPL-2.1+, HarfBuzz를 MIT~old, FreeType을 FTL로 분류한다. 고정된 라이선스 파일은 [Brotli](https://github.com/google/brotli/blob/e61745a6b7add50d380cfd7d3883dd6c62fc2c71/LICENSE), [FreeType](https://github.com/freetype/freetype/blob/801cd842e27c85cb1d5000f6397f382ffe295daa/LICENSE.TXT), [FriBidi](https://github.com/fribidi/fribidi/blob/247fddc3599e3fe7b1b5cc21020c9eb51e662637/COPYING), [HarfBuzz](https://github.com/harfbuzz/harfbuzz/blob/afcae83a064843d71d47624bc162e121cc56c08b/COPYING), [libass](https://github.com/libass/libass/blob/266b9831d7a7f513db48a02ade91c1f3e2fcd7a3/COPYING)다. 이는 소스 파일별 저작권자 추출 결과가 아니며, `Makefile_licence`에만 있는 Expat 항목으로 WASM에 Expat 코드가 포함됐다고 단정하지 않는다.
- 앱의 `scripts/build-jassub.cjs`는 JS/worker, WASM 두 개, font와 npm의 MIT `LICENSE`만 복사한다. 설정에 `legalComments: 'inline'`가 있어도 실제 생성된 JS/worker 파일에는 주석 블록이 없고 `app.asar`에도 집계된 `COPYRIGHT`/`THIRD-PARTY-NOTICES`가 없다. npm tarball은 upstream license generator의 `dist/license/all` 산출물을 포함하지 않는다. upstream `Makefile`에서도 해당 license target은 주석 처리돼 있다.
- JASSUB의 `dist/jassub.js`는 `rvfc-polyfill@1.0.8`을 import하며 해당 npm package metadata는 GPL-3.0이다. 이전 esbuild 설정은 이 코드를 실제 번들에 포함했다. 프로젝트의 Electron 38.8.6은 Chromium 140을 포함하며, JASSUB upstream은 Chrome 80 이상에서 필요한 video frame callback을 지원한다고 안내한다. 빌드는 이제 이 구형 브라우저용 fallback import를 native-only 빈 모듈로 바꾸고, 생성 bundle에 native API가 남고 polyfill marker가 빠졌는지 자체 검사한다. 이는 `rvfc-polyfill` 코드를 앱 runtime에서 제외하지만 다른 JASSUB/libass notice 및 font 권리를 해결하지 않는다.
- 같은 esbuild 입력 설정으로 수집한 metafile에서 브라우저 main bundle은 `abslink@1.3.0`(Apache-2.0)과 `throughput@1.0.2`(MIT)를 포함하고, worker는 `abslink@1.3.0`과 `lfa-ponyfill@1.1.1`(MIT)을 포함한다. `rvfc-polyfill@1.0.8`은 alias 모듈로 대체됐다. 이 패키지들은 JASSUB의 런타임 JavaScript 입력에 들어가며, 현재 빌드 스크립트는 JASSUB의 MIT `LICENSE`만 복사한다. 생성 JS/worker에는 별도 license 주석이 없어 세 패키지 고지를 패키지 산출물에 추가할 항목으로 남긴다.
- `default.woff2`는 145,972바이트, SHA-256 `886929903707C5BB28B07CD2EED69921B3D5EF5C49C73A0DD1E187EBF6546A4C`다. npm 패키지의 `dist/default.woff2`는 위 커밋의 [`src/default.woff2`](https://github.com/ThaUnknown/jassub/blob/656371af1c904be59a1008dcdb93f18dfe5e23d0/src/default.woff2)와 일치한다. JASSUB README는 기본 family 이름으로 `liberation sans`를 사용하지만, 폰트 바이너리의 메타데이터·원 저작권자·원본 다운로드 위치·적용 라이선스는 확인하지 못했다.
- 공개 전 조치: 고정 source/submodule의 각 저작권·라이선스 고지를 완전하게 생성·대조하고, Expat 출처와 font 권리를 해결한 뒤 이를 app/NSIS 패키지에 넣어 실제 산출물을 검사한다. 현재 Windows 환경에는 Docker와 WSL 배포판이 없어 upstream의 shell 기반 license generator는 실행하지 않았다. 라이선스 충족이나 재배포 허가를 결론 내리지 않는다.
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

다운로드 가능한 8개 preset은 Hugging Face 저장소의 현재 commit SHA와 파일별 SHA-256을 고정한다. 앱은 고정 commit URL에서 이어받고, `.part` 파일을 포함한 전체 바이트의 SHA-256이 일치할 때만 최종 모델 파일로 옮긴다. 불일치하면 해당 `.part`만 지우며 기존 설치 파일이나 임의 추가 파일은 검사·수정하지 않는다. 차단된 HY-MT1.5 2개 preset에는 다운로드 핀이 없다.

| 코드의 모델 저장소 | 상태·확인된 조건 | 남은 조치 |
|---|---|---|
| `google/gemma-4-E4B-it-qat-q4_0-gguf`, `google/gemma-4-26B-A4B-it-qat-q4_0-gguf`, `google/gemma-4-E2B-it-qat-q4_0-gguf` | Google Gemma 4 공식 모델 카드는 Apache-2.0을 표시하고 Google의 license 링크도 Apache License 2.0 본문으로 연결된다. 각 GGUF 파일의 저장소 commit과 SHA-256을 아래 목록에 고정했다. | 코드·패키지의 모델 출처 고지와 앱 전체 공개 배포 권리는 별도 확인 대상이다. |
| `tencent/Hy-MT2-1.8B-GGUF`, `tencent/Hy-MT2-7B-GGUF`, `tencent/Hy-MT2-30B-A3B-GGUF` | Tencent 공식 GGUF 저장소의 고정 snapshot에는 Apache-2.0 `LICENSE.txt`와 파일 해시가 있다. 세 파일을 해당 저장소 commit과 SHA-256으로 고정했다. | 기존 사용자 파일은 재해시하거나 교체하지 않는다. |
| `bartowski/aya-expanse-8b-GGUF` | 고정 GGUF snapshot은 CC-BY-NC-4.0이며 `base_model`은 Cohere Aya Expanse 8B다. 고정 README에는 Cohere license/privacy 안내와 비상업 사용 체크 항목이 있으나, Hugging Face API의 snapshot `gated` 값은 false다. 앱의 직접 파일 다운로드에는 이용 조건 동의 확인이 없다. | 모델 목록에 비상업 조건을 표시한다. 사용자는 Cohere License Agreement와 AUP를 확인해야 하며, 이 저장소·설치 파일의 공개 배포는 별도 권리 검토 전까지 막는다. |
| `tencent/HY-MT1.5-7B-GGUF` | 공식 `License.txt`는 EU·영국·대한민국을 적용 지역에서 제외한다. 해당 라이선스에 따른 한국 내 사용 권한을 확인할 수 없다. | 앱의 기본 카탈로그에서 사용·다운로드를 차단했다. 이미 설치된 사용자 파일은 건드리지 않고 설정에서 지역 제한을 표시한다. |
| `tencent/HY-MT1.5-1.8B-GGUF` | 공식 저장소의 `License.txt`도 EU·영국·대한민국을 적용 지역에서 제외한다. 이 저장소의 빈 `LICENSE` 파일은 별도 권리 허가를 제공하지 않는다. | 앱의 기본 카탈로그에서 사용·다운로드를 차단했다. 이미 설치된 사용자 파일은 건드리지 않고 설정에서 지역 제한을 표시한다. |
| `hell0ks/ja-ko-vn-7b-v1-gguf` | 고정 GGUF snapshot의 metadata와 README는 Apache-2.0을 선언한다. README는 `hell0ks/ja-ko-vn-7b-v1`에서 양자화했고 TrillionLabs Tri-7B-Base로 fine-tune했다고 설명한다. 두 기반 모델의 Hugging Face model card도 Apache-2.0을 표시한다. 학습 대화 데이터의 출처·권리 설명은 찾지 못했다. | 저작자·기반 모델 출처를 유지하고 학습 자료의 출처/권리는 불명확한 항목으로 기록한다. preset은 기존 설치 파일 호환용 legacy로 유지한다. |
| 사용자가 직접 고른 임의 GGUF | 앱에서 외부 모델 파일 선택을 지원한다. | 앱은 임의 GGUF의 라이선스·배포 권리를 검증하지 않는다. 사용자가 적법한 모델을 선택한다는 점과 모델 제공 약관을 분리해 안내해야 한다. |

### GGUF 다운로드 고정값

commit은 파일만의 변경점이 아니라 해당 저장소의 전체 snapshot을 가리킨다. SHA-256은 Hugging Face 파일 metadata의 LFS object hash이며, 각 고정 snapshot에서 같은 값과 파일 크기를 재확인했다.

| preset | 파일 | 저장소 commit | SHA-256 |
|---|---|---|---|
| `gemma-4-e4b` | `gemma-4-E4B_q4_0-it.gguf` | [4b4a2c1d](https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/commit/4b4a2c1d584be7264f87aac328a1bc739ce81b6c) | `676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee` |
| `aya-expanse-8b` | `aya-expanse-8b-Q4_K_M.gguf` | [f9d62ed0](https://huggingface.co/bartowski/aya-expanse-8b-GGUF/commit/f9d62ed0c58e6f2ae17975df990b1b8a4013b596) | `9592bad943fe56cf93200286a0a4b00a158cd84a408f227b9978ec5879002fb8` |
| `hy-mt2-7b` | `Hy-MT2-7B-Q4_K_M.gguf` | [ab847266](https://huggingface.co/tencent/Hy-MT2-7B-GGUF/commit/ab8472660ac61fac25f1af43fac2599d52a8a775) | `9f96256500f3fc1ab4d64336b58f52a949a95ad7516b0c229476eef782f9f77b` |
| `gemma-4-26b-a4b` | `gemma-4-26B_q4_0-it.gguf` | [d1c082be](https://huggingface.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf/commit/d1c082be9cf3c8a514acf63b8761f4b41935842e) | `3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d` |
| `ja-ko-vn-7b` | `model-Q4_K_M.gguf` | [5460b80a](https://huggingface.co/hell0ks/ja-ko-vn-7b-v1-gguf/commit/5460b80a6a6b64b01a862071875375ab40b049d3) | `2b781aa981bec4af64597a12ed51e15b8903da502a0378a13bec8126bd96ec12` |
| `hy-mt2-30b-a3b` | `Hy-MT2-30B-A3B-Q4_K_M.gguf` | [fd3dcbb6](https://huggingface.co/tencent/Hy-MT2-30B-A3B-GGUF/commit/fd3dcbb6b31e9e03923ef4f9f42500f74c3851c3) | `bb44b11bb0f7cd3d1321645b41e911cd3de2e473731227fc6bf37aa18b543f88` |
| `gemma-4-e2b` | `gemma-4-E2B_q4_0-it.gguf` | [675cff42](https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf/commit/675cff42a74c774d6cb76f76d8eacb49b48c9b93) | `fa401b55b07ee70a54c6dae3903c783a6e65064312529ea57175cb5f8dec6634` |
| `hy-mt2-1.8b` | `Hy-MT2-1.8B-Q4_K_M.gguf` | [a0c709d9](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/commit/a0c709d9fac510f2c807aa3af52872340dc37a4a) | `dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699` |

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
3. Aya Expanse GGUF는 CC-BY-NC-4.0과 Cohere 이용 안내를 목록에 표시한다. `ja-ko-vn` GGUF와 두 기반 모델은 Apache-2.0을 선언하지만 학습 대화 데이터 출처·권리는 확인하지 못했다. 임의 추가 GGUF의 사용 조건은 별도 확인 대상이다. 8개 preset의 새 다운로드는 고정 commit과 SHA-256을 확인하며, 기존 사용자 모델은 재해시하거나 교체하지 않는다. HY-MT1.5 1.8B·7B는 앱에서 다운로드·실행을 막고 기존 사용자 파일을 보존한다.
4. 다운로드되는 llama.cpp release와 지원되는 각 Windows 빌드의 네이티브 구성요소 고지를 추적 가능하도록 고정한다.
5. 프로젝트 원본 코드, 로고, 아이콘의 출처와 재배포 권한을 확인한다. 필요하면 정식 허가된 에셋으로 교체하되 사용자 작업과 기존 데이터는 보존한다.

## 확인 자료

- 로컬: `package.json`, `package-lock.json`, `node_modules/*/package.json` 및 각 패키지 고지 파일, `scripts/build-jassub.cjs`, `electron/local-ai.cjs`, `electron/download-manager.cjs`, `electron/oped-fingerprint.cjs`, 현재 `dist/win-unpacked`.
- [FFmpeg 법적 안내](https://www.ffmpeg.org/legal.html), [ffmpeg-static 저장소와 Windows 바이너리 출처 설명](https://github.com/eugeneware/ffmpeg-static), [Gyan FFmpeg Windows 빌드와 GPLv3·정적 구성 안내](https://www.gyan.dev/ffmpeg/builds/), [현재 바이너리가 가리키는 FFmpeg 원본 커밋](https://github.com/FFmpeg/FFmpeg/commit/e38092ef93).
- [JASSUB 저장소 및 태그](https://github.com/ThaUnknown/jassub), [JASSUB 2.5.16 npm package](https://www.npmjs.com/package/jassub/v/2.5.16), [pinned JASSUB license map](https://github.com/ThaUnknown/jassub/blob/656371af1c904be59a1008dcdb93f18dfe5e23d0/build/license_defaults), [abslink 1.3.0](https://www.npmjs.com/package/abslink/v/1.3.0), [lfa-ponyfill 1.1.1](https://www.npmjs.com/package/lfa-ponyfill/v/1.1.1), [throughput 1.0.2](https://www.npmjs.com/package/throughput/v/1.0.2), [rvfc-polyfill 1.0.8 package metadata](https://www.npmjs.com/package/rvfc-polyfill/v/1.0.8), [Electron 38.8.6 with Chromium 140](https://releases.electronjs.org/release/v38.8.6), [Electron 앱 배포 문서](https://www.electronjs.org/docs/latest/tutorial/application-distribution), [llama.cpp 저장소](https://github.com/ggml-org/llama.cpp).
- [Google Gemma 4 공식 모델 카드](https://ai.google.dev/gemma/docs/core/model_card_4), [Gemma 4 Apache 2.0 license](https://ai.google.dev/gemma/apache_2), [Google 26B QAT GGUF](https://huggingface.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf), [Tencent Hy-MT2 1.8B GGUF license](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/blob/main/LICENSE.txt), [Tencent Hy-MT2 7B GGUF license](https://huggingface.co/tencent/Hy-MT2-7B-GGUF/blob/main/LICENSE.txt), [Tencent Hy-MT2 30B GGUF license](https://huggingface.co/tencent/Hy-MT2-30B-A3B-GGUF/blob/main/LICENSE.txt), [Tencent HY-MT1.5 1.8B GGUF](https://huggingface.co/tencent/HY-MT1.5-1.8B-GGUF), [Tencent HY-MT1.5 7B license](https://huggingface.co/tencent/HY-MT1.5-7B-GGUF/blob/main/License.txt), [Aya Expanse GGUF 저장소](https://huggingface.co/bartowski/aya-expanse-8b-GGUF), [ja-ko-vn 기본 모델](https://huggingface.co/hell0ks/ja-ko-vn-7b-v1).

- 이번 model snapshot 검토: [Aya GGUF의 고정 README](https://huggingface.co/bartowski/aya-expanse-8b-GGUF/blob/f9d62ed0c58e6f2ae17975df990b1b8a4013b596/README.md), [Cohere Aya Expanse 8B model card](https://huggingface.co/CohereLabs/aya-expanse-8b), [Cohere usage policy](https://docs.cohere.com/docs/usage-policy/), [ja-ko-vn GGUF의 고정 README](https://huggingface.co/hell0ks/ja-ko-vn-7b-v1-gguf/blob/5460b80a6a6b64b01a862071875375ab40b049d3/README.md), [ja-ko-vn 기반 모델](https://huggingface.co/hell0ks/ja-ko-vn-7b-v1), [TrillionLabs Tri-7B-Base](https://huggingface.co/trillionlabs/Tri-7B-Base).

### 확인 범위의 한계

- 실제 설치 프로그램을 외부에 배포하거나 실제 공급원에서 영상·자막을 요청하지 않았다.
- 이 인벤토리 변경에서는 다운로드 코드, 의존성 버전, 모델 파일, 사용자 프로필, 생성된 JASSUB 자산을 수정하지 않았다.
- SPDX 집계는 현재 잠금 메타데이터의 분류이며, 라이선스 적합성 판정·취약점 점검·모든 개발 도구 전이 의존성 감사는 아니다.
