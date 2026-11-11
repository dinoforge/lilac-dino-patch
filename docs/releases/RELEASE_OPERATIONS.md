# Lilac Dino Patch 0.1.0 Beta 1 — Windows 배포 실행 절차

> 미실행 운영 절차. 이 파일을 저장한 것만으로 빌드, 태그, ZIP, GitHub Release가 만들어지지 않습니다.

## 배포 전 차단 조건

사용자가 원본 수정·재배포 허가를 확보했다고 밝혔지만 이 작업에서 서면 증빙과 라이선스·내장 FFmpeg/JASSUB 등 전이 의존성 의무를 직접 확인하지는 못했습니다. 배포 범위가 실제 Windows ZIP 및 GitHub 업로드를 포함하고 의무 사항이 충족됐다는 검토가 끝나기 전에는 게시하지 않습니다. LILAC_RELEASE_RIGHTS_APPROVED 게이트를 우회·삭제·편의 설정하지 않습니다. 비공개 저장소 Release도 재배포에 해당합니다.

원본 앱용 루트 .github/workflows/build.yml은 디노 패치 관리자 빌드 도구가 아닙니다. 사용자 요청에 따라 반복 기능 테스트는 추가하지 않되, 아래 기존 빌드 스크립트의 자체 무결성·도구 버전·엔진 info 검사는 생략하지 않습니다.

## 후보와 버전

- 비공개 저장소: dinoforge/lilac-dino-patch
- 검토된 배포 후보 B: 12bec74abe089763e1e2b501dd7051dc53ad2e88
- 부모 A: 3546814faac89d13de54ce43db637259fb77535c
- 기존 Draft PR: #6, 아직 main 미병합
- 제안된 별도 태그: dino-v0.1.0-beta.1 (미생성)
- Electron 관리자 내부 패키지 버전: 1.2.4
- 기존 A35-final 바이너리와 미커밋 GUI 수동 재적용 실험본은 게시 후보에 포함하지 않습니다.

## Windows 격리 빌드

관리자 전용 스크립트:
tools/dino-patch-manager/build_electron_windows.ps1

실제 Windows x64, Node 24.14.1, npm 11.11.0, Python 3.14.7 및 잠금된 의존성이 필요합니다. 원래 dirty 개발 checkout과 기존 A35 배포 경로는 절대 사용하지 않습니다. clone은 OS Temp 밖에 생성합니다. 기존 경로가 있으면 덮어쓰지 않고 다른 빈 경로를 사용합니다.

~~~powershell
$ErrorActionPreference = 'Stop'
git clone --branch review/a35-lifecycle-settings --single-branch https://github.com/dinoforge/lilac-dino-patch.git D:\Codex-Coding-Folder\Dino-Release-Beta1
Set-Location D:\Codex-Coding-Folder\Dino-Release-Beta1
$expected = '12bec74abe089763e1e2b501dd7051dc53ad2e88'
$actual = (git rev-parse HEAD).Trim()
if ($actual -ne $expected) { throw "Unexpected source: $actual" }
if (git status --porcelain) { throw 'Build clone must be clean' }

py -3.14 -m venv .venv-dino-build
& .\.venv-dino-build\Scripts\python.exe -m pip install -r tools\dino-patch-manager\requirements-build.txt
if ($LASTEXITCODE -ne 0) { throw 'Pinned Python dependency install failed' }

powershell -NoProfile -ExecutionPolicy Bypass -File tools\dino-patch-manager\build_electron_windows.ps1 -PythonExe .\.venv-dino-build\Scripts\python.exe -BuildName dino-beta1-candidate
if ($LASTEXITCODE -ne 0) { throw 'Independent manager build failed' }
~~~

스크립트는 실제 Windows 관리자용 win-unpacked 출력을 만들며 자체적으로 npm ci, 격리 프로필 검사, PyInstaller 번들 자산, 패키지 엔진 info를 검사합니다. 성공 기본 경로:

tools/dino-patch-manager/release/DinoPatchManager-Electron-v1.2.4-dino-beta1-candidate/win-unpacked

이미 출력 폴더가 있으면 빌드 스크립트가 중단하는 것이 정상입니다. 새 이름을 사용하세요. 빌드가 실패하거나 고정 도구 버전이 맞지 않으면 배포하지 않습니다.

## ZIP 및 체크섬

최종 ZIP은 하위에 DinoPatchManager 폴더와 그 안에 디노패치관리자.exe, resources/app.asar, resources/manager-engine 및 manager-node를 포함해야 합니다. 숨김 파일을 누락하지 않는 압축 수단을 사용하세요. EXE, app.asar, 번들 엔진의 파일 존재와 버전·해시, ZIP 내부의 모든 상대 경로, 사용자 캐시·로그·임시 자료 및 포함 금지 콘텐츠의 부재를 확인하세요.

실제 ZIP 생성 후 아래처럼 파일 크기·SHA-256을 측정해 릴리즈 노트에 기록합니다. 이전 A35 ZIP 해시나 실험 패키지 해시를 새로운 바이너리의 해시로 적지 않습니다.

~~~powershell
$zip = 'Lilac-Dino-Patch-0.1.0-beta.1-win-x64.zip'
if (!(Test-Path -LiteralPath $zip -PathType Leaf)) { throw 'Release ZIP not found' }
Get-Item -LiteralPath $zip | Select-Object FullName, Length
Get-FileHash -LiteralPath $zip -Algorithm SHA256
~~~

## GitHub 실제 프리릴리즈

권리 승인·의무 고지, 올바른 Windows 관리자 산출물, ZIP 검사, 승인된 릴리즈 설명이 모두 확보된 경우에만 아래 단계를 수행합니다. 기존 태그·릴리즈가 있으면 덮어쓰지 않습니다. 태그 dino-v0.1.0-beta.1은 기존 v* 원본 앱 워크플로와 구분되지만, **이 자체가 권리 게이트를 우회할 허가가 되지 않습니다.**

GitHub CLI를 인증한 실행 환경에서 먼저 중복 여부와 GitHub 권한, 정확한 후보 SHA를 확인합니다. 예시 명령:

~~~powershell
gh auth status
gh repo view dinoforge/lilac-dino-patch
gh release view dino-v0.1.0-beta.1 --repo dinoforge/lilac-dino-patch

# 기존 태그/릴리즈가 없고 위 승인 조건을 모두 충족할 때에만:
git tag -a dino-v0.1.0-beta.1 12bec74abe089763e1e2b501dd7051dc53ad2e88 -m "Lilac Dino Patch 0.1.0 Beta 1"
git push origin refs/tags/dino-v0.1.0-beta.1
~~~

릴리즈 설명은 docs/releases/dino-v0.1.0-beta.1.md 초안을 실제 게시 시점에 맞게 수정한 별도 승인된 텍스트 파일을 사용하세요. **현재 초안의 '미게시/ZIP 없음' 상태 문장을 그대로 릴리즈 설명에 쓰지 마세요.**

~~~powershell
gh release create dino-v0.1.0-beta.1 .\Lilac-Dino-Patch-0.1.0-beta.1-win-x64.zip --repo dinoforge/lilac-dino-patch --verify-tag --prerelease --title "Lilac Dino Patch 0.1.0 Beta 1" --notes-file .\RELEASE_NOTES_APPROVED.md
~~~

비공개 저장소에 게시된 Release와 파일은 일반 공개 다운로드가 아니라 접근 권한을 가진 계정에만 제공됩니다. 공개 배포가 승인됐다는 뜻으로 저장소 visibility를 바꾸지 마세요. GitHub Release URL, 실제 태그 SHA, ZIP 자산의 크기·체크섬을 확인한 경우에만 RELEASED로 보고하세요.

## 변경 불가 사항

기존 A35-final, 원래 LilacAnime-Player dirty checkout, 실제 사용자 AppData 및 프로필, Draft PR #6, main, 미커밋 GUI 실험 소스는 보존합니다. 테스트 코드 삭제, 원본 소스 지문 검사 비활성화, 무단 자동 병합, 공개 저장소 전환, 기존 태그 강제 이동은 하지 않습니다.
