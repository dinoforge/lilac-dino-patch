# DinoPatch: PARTIAL_OR_UNKNOWN 버전 기록 불일치 진단

오류 예시:

```text
자동 검사 · PARTIAL_OR_UNKNOWN · 이전 패치 버전 또는 설치본 버전 기록이 현재와 다릅니다
```

이는 사용자 프로필 손상 판정이 아닙니다. Rust 관리자는 공식 앱 ASAR의
내부 버전과 `state.json.version`, 관리자 패치 버전과
`state.json.patchVersion`이 다르면 자동 패치를 중단합니다.
기존 백업과 설치본에 대한 안전한 대응을 확정하기 전까지 상태 기록을
삭제하거나 현재 `app.asar`를 임의로 덮어쓰면 안 됩니다.

## 읽기 전용 진단

Windows PowerShell에서 실제 선택된 LilacAnime **설치 폴더** 경로를 넣습니다.
관리자 권한은 필요하지 않으며, 명령은 파일을 쓰지 않습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dino-read-only-diagnose.ps1 -InstalledRoot "D:\LilacAnime"
```

`D:\LilacAnime`은 예시일 뿐입니다. 실행 전에 스크립트 내용을 검토하고
실제 설치 경로로 변경하세요. 이 명령은 관리자 상태 기록의 버전 정보,
현재 ASAR가 기록된 원본/패치본과 일치하는지, 원본 백업 SHA-256이
상태 기록과 맞는지, 미완료 복구 기록이 존재하는지를 표시합니다.

`STATE_NOT_UNIQUE`면 경로가 상태 기록의 설치 위치와 다르거나
기록이 여러 개일 수 있습니다. 임의의 다른 기록을 연결하지 않습니다.

## 판독

- `RECORDED_PATCHED_ASAR`: 현재 설치 파일은 기록된 패치본과 바이트 단위로 같습니다. 구버전 패치 관리자의 검증된 해제 절차를 찾아야 하며, 새 관리자로 강제 덮어쓰지 않습니다.
- `RECORDED_ORIGINAL_ASAR`: 현재 설치 파일은 기록된 원본과 같습니다. 해당 앱 버전과 저장된 패치 버전 기록을 확인한 뒤 안전한 마이그레이션이 필요합니다.
- `DIFFERENT_FROM_BOTH_RECORDED_HASHES`: 설치 파일이 바뀌었거나 공식 앱이 업데이트된 것일 수 있습니다. 기존 백업이 현재 버전의 원본이라고 가정하지 않습니다.
- `originalBackupHashMatchesRecord: false`: 백업이 없거나 상태 기록과 다릅니다. 복원·적용을 시도하지 않습니다.
- `pendingRecoveryRecordPresent: true`: 복구 작업이 미완료 상태입니다. 기록을 삭제하지 말고 기존 버전 관리자에서 복구 상태를 먼저 확인합니다.

## 안전 원칙

`state.json`, `pending.json`, `original-app.asar`,
설치본 `resources/app.asar`, 공식 앱 사용자 데이터/SQLite DB를
임의 삭제·이동·초기화하지 않습니다. 현재 설치본의 앱 버전,
저장된 앱/패치 버전, 현재 ASAR와 기록된 SHA 일치 여부,
백업 무결성, pending 여부를 확인한 후 복구 절차를 고릅니다.

관리자 소스의 개선에서는 이 정보를 버전별로 표시하지만,
**기존에 다운로드한 PREVIEW EXE는 재빌드하기 전에는 변경되지 않습니다.**
이 문서의 검사 도구는 별도로 사용 가능하며 Windows 네이티브
실행/설치본 복구를 수행하거나 자동 승인하지 않습니다.
