# 디노 패치 관리자

공식 LilacAnime v0.5.54 원본을 확인하고, Patch 03만 별도의 새 출력 폴더에 적용하는 Windows GUI입니다. 기존 원본 폴더를 수정하지 않으며, 기존 출력 폴더를 덮어쓰지 않습니다.

## 실행

프로젝트 폴더에서 `tools\dino-patch-manager\run.bat`을 실행하거나 다음 명령을 사용합니다.

```powershell
python tools\dino-patch-manager\manager_gui.py
```

Python 3.10 이상과 Tkinter가 필요합니다. 런처는 `npm`, `pip`, `npm ci`를 실행하거나 패키지를 설치하지 않습니다.

## 기본 흐름

1. 공식 v0.5.54 ZIP 또는 정확한 SHA로 확인 가능한 원본 폴더를 선택합니다.
2. 패치 구성 경로는 이 프로젝트 루트로 둡니다. manifest와 세 런타임 모듈의 SHA-256을 확인합니다.
3. **호환성 검사**를 실행합니다. 압축 해제 폴더는 OS Temp의 일회용 검증 사본에서 연결 변경·allowlist·IPC 계약·Node 구문 및 계약 테스트를 확인합니다. 아카이브는 기존 `scripts/validate-patch03-clean-source.cjs`를 재사용합니다.
4. 통과 후 **변경 내용 미리보기**에서 `src/app.js`, `src/index.html` 연결부와 추가될 세 모듈을 확인합니다.
5. **새 출력 폴더에 적용**을 누르면 확인 대화상자를 거친 뒤, 빈 신규 폴더에서만 원본 사본을 만들고 검증합니다. 성공한 경우에만 최종 폴더 이름으로 확정합니다.

적용 범위는 공식 연결 파일 두 개(`src/app.js`, `src/index.html`)와 Patch 03 모듈 세 개(`src/integrated-search.js`, `src/integrated-search.css`, `src/patch03-bridge.js`)로 제한됩니다. 공식 원본의 파일 트리 지문, 파일 수, IPC 계약이 manifest와 다르면 작업을 중단합니다. 기존 설치본, 개발 프로젝트, 사용자 프로필, 기존 출력 폴더는 출력 대상으로 허용하지 않습니다.

## 안전 경계

- 원본 입력은 읽기 전용입니다. 적용은 선택한 경로와 분리된 **아직 존재하지 않는 출력 폴더**에서만 진행됩니다.
- OS Temp는 검증 임시 사본에만 사용됩니다. 실제 출력은 사용자가 지정하며, 시스템·사용자 프로필·설치 경로·개발 프로젝트와 겹치면 거부됩니다.
- 기본 검사와 적용 과정은 네트워크 검색이나 의존성 설치를 수행하지 않습니다.
- Electron 외부 공급원 검증은 별도의 선택 동작입니다. 이를 위해서는 사용자가 명시적으로 체크하고 기존 검증기를 선택한 OS Temp 의존성 폴더와 함께 실행하도록 승인해야 합니다. 이 경로도 `npm ci`를 실행하지 않습니다.
- 작업 도중 실패한 임시 적용 사본은 자동 삭제하지 않습니다. GUI는 보존된 경로를 로그에 표시하므로, 내용을 확인한 뒤 별도로 처리해야 합니다.
- 적용 결과에는 공식 원본 식별값, 변경 파일 목록 및 트리 해시가 담긴 JSON sidecar 보고서가 출력 폴더 옆에 생성됩니다. 보고서는 LilacAnime 런타임 파일에 포함되지 않습니다.

## 검증

관리자 자체 안전·적용 테스트:

```powershell
python -m unittest discover -s tools\dino-patch-manager\tests -v
```

공식 원본 아카이브 검증기는 기본적으로 설치나 Electron 실행을 하지 않습니다. 도움말은 `node scripts\validate-patch03-clean-source.cjs --help`로 확인할 수 있습니다. GUI의 선택적 Electron 경로는 실제 공급원 요청을 보낼 수 있으므로 기본 검사와 분리되어 있습니다.
