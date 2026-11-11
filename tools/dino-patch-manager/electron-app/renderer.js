(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const elements = {
    managerVersion: $('managerVersion'), patchBadge: $('patchBadge'),
    safetyCard: $('safetyCard'), safetyTitle: $('safetyTitle'), safetyMessage: $('safetyMessage'),
    targetPath: $('targetPath'), officialVersion: $('officialVersion'), targetPatchVersion: $('targetPatchVersion'),
    autoManageStatus: $('autoManageStatus'),
    apply: $('apply'), uninstall: $('uninstall'), restore: $('restore'), inspect: $('inspect'), history: $('history'),
    chooseRoot: $('chooseRoot'), diagnostics: $('diagnostics'), backupSelect: $('backupSelect'),
    checkUpdates: $('checkUpdates'), updateStatus: $('updateStatus'),
    message: $('message'), detail: $('detail'), activityStatus: $('activityStatus'), busyBadge: $('busyBadge'), log: $('log'), themeStatus: $('themeStatus'),
    resultCard: document.querySelector('.result-card'),
  };

  const state = { root: null, info: null, status: 'UNKNOWN', busy: false, backups: [], update: null, logItems: [], pendingSourceChange: false };
  const labelByStatus = {
    APPLIED: ['적용됨 · 호환', 'good'], ALREADY_APPLIED: ['적용됨 · 호환', 'good'],
    UNPATCHED: ['호환 · 미적용', 'warn'], NO_SOURCE: ['원본 미발견', 'neutral'],
    CONFLICT: ['파일 충돌', 'bad'], PARTIAL_OR_UNKNOWN: ['상태 확인 필요', 'bad'],
    UNSUPPORTED: ['소스 비호환', 'bad'], COMPATIBILITY_UNKNOWN: ['호환성 확인 필요', 'bad'], SOURCE_FOUND: ['원본 확인', 'neutral'],
  };
  const safetyByStatus = {
    APPLIED: ['원본 보호 상태 정상', '기록된 변경만 관리하며, 예상하지 못한 파일 수정은 감지 시 작업을 멈춥니다.', false],
    ALREADY_APPLIED: ['원본 보호 상태 정상', '기록된 변경만 관리하며, 예상하지 못한 파일 수정은 감지 시 작업을 멈춥니다.', false],
    UNPATCHED: ['호환성을 확인한 뒤 필요한 파일만 백업합니다', '백업이나 파일 구조를 안전하게 확인할 수 없으면 원본은 변경하지 않습니다.', false],
    NO_SOURCE: ['공식 원본 확인이 필요합니다', '원본 폴더를 찾지 못해 적용을 진행하지 않았습니다. 경로를 확인하거나 직접 선택해 주세요.', true],
    CONFLICT: ['사용자 수정 파일을 보호했습니다', '충돌한 파일에는 패치나 복원을 적용하지 않았습니다. 아래 사유와 작업 기록을 확인하세요.', true],
    PARTIAL_OR_UNKNOWN: ['패치 상태를 확인할 수 없습니다', '상태가 불확실한 동안에는 파일을 변경하지 않습니다. 상세 원인을 확인하세요.', true],
    UNSUPPORTED: ['디노 패치와 호환되지 않는 소스입니다', '필수 연결 또는 호출 계약이 달라 적용을 차단했습니다. 원본 파일은 변경하지 않았습니다.', true],
    COMPATIBILITY_UNKNOWN: ['호환성을 확인할 수 없습니다', '공식 출처나 전체 구조를 확인하지 못해 적용을 차단했습니다. 네트워크와 원본 파일 상태를 확인하세요.', true],
    SOURCE_FOUND: ['공식 원본 구조를 확인했습니다', '호환성 및 파일 지문 확인이 끝난 경우에만 패치 작업을 진행합니다.', false],
  };
  const managementSummaryByStatus = {
    APPLIED: ['적용됨', 'good'], ALREADY_APPLIED: ['적용됨', 'good'],
    UNPATCHED: ['호환 확인 · 미적용', 'warn'], NO_SOURCE: ['원본 선택 필요', 'neutral'],
    CONFLICT: ['변경 충돌 · 적용 중단', 'bad'], PARTIAL_OR_UNKNOWN: ['상태 확인 필요', 'bad'],
    UNSUPPORTED: ['소스 비호환 · 적용 중단', 'bad'], COMPATIBILITY_UNKNOWN: ['호환성 확인 필요 · 적용 중단', 'bad'], SOURCE_FOUND: ['원본 구조 확인', 'neutral'],
  };

  function setAutoManageStatus(label, tone = 'neutral') {
    elements.autoManageStatus.textContent = label;
    elements.autoManageStatus.dataset.state = tone;
  }

  function setDetail(value) {
    const detail = String(value || '');
    elements.detail.textContent = detail;
    elements.detail.hidden = !detail;
  }

  function renderSafety(status, errorMessage = '') {
    if (errorMessage) {
      elements.safetyCard.hidden = false;
      elements.safetyTitle.textContent = '관리자 작업 결과 확인이 필요합니다';
      elements.safetyMessage.textContent = '오류 내용을 확인하고 작업 기록으로 원본 파일의 최종 상태를 확인하세요.';
      elements.safetyCard.classList.add('is-expanded');
      return;
    }
    const [title, message, expanded] = safetyByStatus[status] || ['패치 상태를 확인할 수 없습니다', '상태가 불확실한 동안에는 파일을 변경하지 않습니다. 상세 원인을 확인하세요.', true];
    elements.safetyCard.hidden = !expanded;
    elements.safetyTitle.textContent = title;
    elements.safetyMessage.textContent = message;
    elements.safetyCard.classList.toggle('is-expanded', expanded);
  }

  function recentMessage(status, operation = '') {
    if (operation.includes('복원')) return '백업 복원 완료';
    if (operation.includes('해제')) return '패치 해제 완료';
    if (operation.includes('적용') && status === 'APPLIED') return '패치 적용 완료';
    if (operation.includes('적용') && status === 'ALREADY_APPLIED') return '이미 패치가 적용되어 있습니다.';
    const message = {
      APPLIED: '패치 적용 완료',
      ALREADY_APPLIED: '이미 최신 패치가 적용되어 있습니다.',
      UNPATCHED: '호환성 검사 완료',
      NO_SOURCE: '원본 폴더를 찾지 못했습니다.',
      CONFLICT: '파일 충돌로 작업을 중단했습니다.',
      PARTIAL_OR_UNKNOWN: '패치 상태 확인에 실패했습니다.',
      UNSUPPORTED: '필수 연결 구조가 달라 적용하지 않았습니다.',
      COMPATIBILITY_UNKNOWN: '공식 출처 또는 구조를 확인할 수 없어 적용을 중단했습니다.',
      SOURCE_FOUND: '원본 구조 확인 완료',
    };
    return message[status] || (operation ? `${operation} 완료` : '상태 확인을 완료했습니다.');
  }

  function addLog(message) {
    const stamp = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    state.logItems.push(`[${stamp}] ${String(message || '').slice(0, 1600)}`);
    if (state.logItems.length > 250) state.logItems.splice(0, state.logItems.length - 250);
    elements.log.textContent = state.logItems.join('\n');
    elements.log.scrollTop = elements.log.scrollHeight;
  }

  function setBusy(busy, message = '') {
    state.busy = Boolean(busy);
    document.body.classList.toggle('is-busy', state.busy);
    elements.resultCard.setAttribute('aria-busy', String(state.busy));
    elements.activityStatus.hidden = !state.busy;
    elements.busyBadge.textContent = state.busy ? '진행 중' : '대기';
    elements.busyBadge.className = `status-chip ${state.busy ? 'warn' : 'neutral'}`;
    if (message) elements.message.textContent = message;
    if (state.busy && (message.includes('원본 확인') || message.includes('자동 적용'))) {
      setAutoManageStatus('자동 검사 중', 'busy');
    }
    for (const button of [elements.apply, elements.uninstall, elements.restore, elements.inspect, elements.history, elements.chooseRoot, elements.checkUpdates, elements.diagnostics]) {
      if (button) button.disabled = state.busy || button.dataset.disabledByState === 'true';
    }
    updateActionButtons();
    if (!state.busy && state.pendingSourceChange) {
      setTimeout(() => {
        if (state.busy || !state.pendingSourceChange) return;
        state.pendingSourceChange = false;
        void runSourceChangeRecheck();
      }, 0);
    }
  }

  function updateActionButtons() {
    const hasRoot = Boolean(state.root);
    const applied = state.status === 'APPLIED' || state.status === 'ALREADY_APPLIED';
    const restoreAllowedForState = ['APPLIED', 'ALREADY_APPLIED', 'UNPATCHED'].includes(state.status);
    const selectedBackup = state.backups.find((item) => item.id === elements.backupSelect.value && item.restorable === true);
    elements.inspect.disabled = state.busy || !hasRoot;
    elements.history.disabled = state.busy || !hasRoot;
    // Keep the explicit action available even if the monitor flagged an
    // uncertain state: the engine independently re-checks before any write.
    // This button does not bypass ASAR validity, contracts, backup or locks.
    elements.apply.disabled = state.busy || !hasRoot || applied;
    elements.uninstall.disabled = state.busy || !applied;
    elements.backupSelect.disabled = state.busy || !hasRoot || state.backups.length === 0;
    elements.restore.disabled = state.busy || !hasRoot || !restoreAllowedForState || !selectedBackup;
  }

  function setChip(element, label, tone = 'neutral') {
    element.textContent = label;
    element.className = `status-chip ${tone}`;
  }

  function renderState(result, operation = '') {
    if (!result || typeof result !== 'object') throw new Error('관리자 엔진에서 상태 데이터를 받지 못했습니다.');
    state.status = String(result.status || 'UNKNOWN');
    if (result.path) state.root = result.path;
    const structural = result.compatibilityMode === 'STRUCTURAL';
    let [label, tone] = labelByStatus[state.status] || [state.status, 'bad'];
    if (structural && (state.status === 'APPLIED' || state.status === 'ALREADY_APPLIED')) label = '적용됨 · 구조 확인';
    if (structural && state.status === 'UNPATCHED') label = '구조 호환 · 미적용';
    if (state.status === 'UNPATCHED' && result.manualUninstall) label = '수동 해제 · 미적용';
    setChip(elements.patchBadge, label, tone);
    renderSafety(state.status);
    const targetPath = state.root || result.reason || '원본 폴더를 선택하세요.';
    elements.targetPath.textContent = targetPath;
    elements.targetPath.title = targetPath;
    elements.targetPath.setAttribute('aria-label', `인식된 원본 폴더: ${targetPath}`);
    elements.officialVersion.textContent = result.version ? `v${result.version}` : (state.info ? `v${state.info.officialVersion} 기준` : '확인 불가');
    elements.targetPatchVersion.textContent = result.patchVersion ? `v${result.patchVersion}` : (state.info ? `v${state.info.patchVersion}` : '확인 불가');
    elements.message.textContent = recentMessage(state.status, operation);
    const [defaultManagementSummary, defaultManagementTone] = managementSummaryByStatus[state.status] || ['결과 확인 필요', 'bad'];
    const managementSummary = state.status === 'UNPATCHED' && result.manualUninstall
      ? '수동 해제 유지 · 공식 소스 변경까지 미적용'
      : defaultManagementSummary;
    const managementTone = state.status === 'UNPATCHED' && result.manualUninstall ? 'warn' : defaultManagementTone;
    const prefix = result.sourceUpdateDetected
      ? '공식 원본 변경 · 자동 재적용 완료'
      : operation.includes('자동') || operation.includes('감지') ? '자동 검사 완료' : operation.includes('검사') || operation.includes('확인') ? '검사 완료' : '현재 상태';
    setAutoManageStatus(`${prefix} · ${managementSummary}`, managementTone);
    const evidenceNote = structural && result.sourceIdentityVerified
      ? `v${result.version} 공식 태그와 파일 트리 및 연결 계약을 검사했습니다. 정적 패치 검증은 완료했으며 실제 Electron 동작·영상 재생 검증은 포함하지 않습니다.`
      : '';
    const sourceUpdateNote = result.sourceUpdateDetected
      ? `이전 v${result.previousOfficialVersion || '확인 불가'}에서 v${result.version || '확인 불가'}로 바뀐 공식 소스를 확인하고, 호환성 검사 후 디노 패치를 자동 적용했습니다.`
      : '';
    const manualUninstallNote = result.manualUninstall
      ? '사용자가 디노 패치를 직접 해제했습니다. 현재 공식 소스가 변경될 때까지 자동으로 다시 적용하지 않습니다.'
      : '';
    if (result.manualUninstall && state.status === 'UNPATCHED') {
      elements.message.textContent = '디노 패치 수동 해제됨 · 공식 소스 변경까지 미적용 상태를 유지합니다.';
    }
    if (result.sourceUpdateDetected && ['APPLIED', 'ALREADY_APPLIED'].includes(state.status)) {
      elements.message.textContent = `공식 원본 변경 확인 · v${result.version} 디노 패치 자동 적용 완료`;
    }
    setDetail([manualUninstallNote, sourceUpdateNote, result.reason ? String(result.reason) : '', evidenceNote].filter(Boolean).join('\n\n'));
    addLog(`${operation || '상태'} · ${state.status}${result.reason ? ` · ${result.reason}` : ''}`);
    updateActionButtons();
  }

  function renderUpdate(result) {
    state.update = result;
    const status = result.status;
    if (status === 'UP_TO_DATE') {
      elements.updateStatus.textContent = `공식 최신 버전 · 현재 ${result.currentVersion} / 최신 ${result.latestVersion}`;
      elements.message.textContent = '공식 업데이트 확인 완료 · 현재 최신 버전입니다.';
      setDetail('');
    } else if (status === 'UPDATE_AVAILABLE_UNSUPPORTED') {
      const changes = result.sourceChangeSummary;
      const changeLabel = changes
        ? ` · 변경 파일 ${changes.changedCount}개 (+${changes.addedCount} / ~${changes.modifiedCount} / −${changes.deletedCount})`
        : '';
      const commitLabel = result.releaseCommit ? ` · ${String(result.releaseCommit).slice(0, 7)}` : '';
      elements.updateStatus.textContent = `공식 새 버전 ${result.latestVersion} 발견${commitLabel}${changeLabel} · 설치 미지원`;
      elements.message.textContent = `새 공식 버전 ${result.latestVersion} 발견 · 호환성 검토가 필요합니다.`;
      const details = [
        result.reason || '공식 업데이트 설치는 지원되지 않아 원본 파일을 변경하지 않았습니다.',
        result.releaseTag ? `공식 태그: ${result.releaseTag}` : '',
        result.releaseCommit ? `공식 커밋: ${result.releaseCommit}` : '',
        result.releaseTreeSha ? `공식 Git 트리: ${result.releaseTreeSha}` : '',
        result.currentSourceState ? `현재 원본·패치 상태: ${result.currentSourceState}` : '',
        result.patchCompatibility ? `디노 패치 호환성: ${result.patchCompatibility}` : '',
        result.rollbackCapability ? `전체 소스 복원 가능성: ${result.rollbackCapability}` : '',
        result.sourceArchiveDownloaded === false ? '공식 소스 아카이브: 다운로드하지 않음' : '',
        result.officialArchiveChecksumPublished === true ? '공식 소스 아카이브 SHA-256: 게시됨 · 아직 내려받거나 검증하지 않음' : '',
        result.officialArchiveChecksumPublished === false ? '공식 소스 아카이브 SHA-256: 릴리스 자산에 게시되지 않음' : '',
        result.officialArchiveChecksumPublished === null ? '체크섬 자산은 있으나 내용은 조회하지 않음' : '',
      ].filter(Boolean);
      setDetail(details.join('\n'));
    } else if (status === 'UPDATE_PREFLIGHT_BLOCKED') {
      elements.updateStatus.textContent = result.latestVersion
        ? `공식 ${result.latestVersion} 발견 · 소스 사전검사 중단`
        : '공식 소스 업데이트 사전검사 중단';
      elements.message.textContent = '원본 파일은 변경되지 않았습니다 · 사전검사 실패';
      setDetail(String(result.reason || '사전검사를 완료할 수 없어 업데이트를 차단했습니다.'));
    } else {
      const reason = result.reason || '패치 상태에는 영향을 주지 않았습니다.';
      elements.updateStatus.textContent = `공식 업데이트 조회 실패 · ${reason}`;
      elements.message.textContent = '공식 업데이트 조회에 실패했습니다.';
      setDetail(reason);
    }
    addLog(`공식 업데이트 조회 · ${status}${result.latestVersion ? ` · ${result.latestVersion}` : ''}`);
    updateActionButtons();
  }

  function renderTheme(result) {
    const theme = result && result.theme === 'light' ? 'light' : 'dark';
    document.body.classList.toggle('theme-light', theme === 'light');
    if (result && result.status === 'READ') {
      elements.themeStatus.textContent = `LilacAnime 테마 자동 연동 · ${result.setting || theme}`;
      elements.themeStatus.hidden = true;
    } else {
      elements.themeStatus.textContent = `LilacAnime 테마 읽기 불가 · ${result && result.source ? result.source : '시스템'} 적용 · ${result && result.reason ? result.reason : '기본 테마 사용'}`;
      elements.themeStatus.hidden = false;
    }
  }

  async function withUiOperation(label, work) {
    if (state.busy) return;
    setDetail('');
    setBusy(true, `${label} 작업을 진행합니다…`);
    if (label.includes('원본 확인') || label.includes('자동 적용')) setAutoManageStatus('자동 검사 중', 'busy');
    addLog(`${label} 시작`);
    try {
      const result = await work();
      const updateOperation = label.includes('업데이트');
      if (result && ['APPLIED', 'ALREADY_APPLIED', 'UNPATCHED', 'NO_SOURCE', 'CONFLICT', 'PARTIAL_OR_UNKNOWN', 'UNSUPPORTED', 'COMPATIBILITY_UNKNOWN'].includes(result.status) && !(updateOperation && result.status === 'UNSUPPORTED')) renderState(result, label);
      else if (result && ['UPDATE_AVAILABLE_UNSUPPORTED', 'UPDATE_PREFLIGHT_BLOCKED', 'UP_TO_DATE', 'CHECK_FAILED'].includes(result.status)) renderUpdate(result);
      else if (result && ['UNSUPPORTED', 'NO_UPDATE', 'NOT_AVAILABLE'].includes(result.status)) {
        const messages = {
          UNSUPPORTED: '공식 업데이트 적용은 지원되지 않아 원본을 변경하지 않았습니다.',
          NO_UPDATE: '공식 최신 버전이 이미 적용되어 있습니다.',
          NOT_AVAILABLE: '공식 업데이트를 적용할 수 없습니다.',
        };
        elements.message.textContent = messages[result.status];
        setDetail('');
        addLog(`${label} 완료 · ${result.status}${result.reason ? ` · ${result.reason}` : ''}`);
      }
      else if (result && result.status === 'RESTORED' || (result && result.status === 'ALREADY_UNPATCHED')) {
        addLog(`${label} 완료 · ${result.status}`);
        const fresh = await window.dinoManager.inspect();
        renderState(fresh, '복원 후 상태 확인');
      } else if (result && result.items) {
        elements.message.textContent = `${label} 완료`;
        return result;
      } else if (result) {
        elements.message.textContent = `${label} 완료`;
        if (result.reason) setDetail(String(result.reason));
        addLog(`${label} 완료 · ${JSON.stringify(result)}`);
      } else {
        elements.message.textContent = `${label} 완료`;
        addLog(`${label} 완료`);
      }
      return result;
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      const updateOperation = label.includes('업데이트');
      const sourceStateOperation = !updateOperation && /원본 확인|검사|적용|해제|복원/.test(label);
      if (sourceStateOperation) {
        try {
          const fresh = await window.dinoManager.inspect();
          renderState(fresh, `${label} 실패 후 상태 재검사`);
          const currentState = labelByStatus[state.status] ? labelByStatus[state.status][0] : state.status;
          elements.message.textContent = `${label} 실패 · 원본 상태 재확인`;
          setDetail(`${message}\n\n읽기 전용 재검사 결과: ${currentState}${fresh.reason ? ` · ${String(fresh.reason)}` : ''}`);
          renderSafety('ERROR', message);
          setAutoManageStatus('작업 실패 · 원본 상태 재확인', 'warn');
          addLog(`${label} 실패 · ${message} · 읽기 전용 재검사 ${state.status}`);
        } catch (inspectionError) {
          const inspectionMessage = String(inspectionError && inspectionError.message ? inspectionError.message : inspectionError);
          state.status = 'PARTIAL_OR_UNKNOWN';
          elements.message.textContent = `${label} 실패 · 원본 상태 확인 필요`;
          setDetail(`${message}\n\n읽기 전용 재검사 실패: ${inspectionMessage}\n상태를 다시 확인하기 전까지 파일 변경 작업은 잠깁니다.`);
          setChip(elements.patchBadge, ...labelByStatus.PARTIAL_OR_UNKNOWN);
          renderSafety('ERROR', inspectionMessage);
          setAutoManageStatus('상태 확인 실패 · 변경 작업 중단', 'bad');
          addLog(`${label} 실패 · ${message} · 읽기 전용 재검사 실패 · ${inspectionMessage}`);
          updateActionButtons();
        }
      } else if (updateOperation) {
        elements.message.textContent = `${label} 실패`;
        renderUpdate({ status: 'CHECK_FAILED', reason: message });
        addLog(`${label} 실패 · ${message}`);
      } else {
        // A history, diagnostics, or backup-list failure says nothing about
        // whether the patch itself is applied; keep the verified patch status.
        elements.message.textContent = `${label} 실패`;
        setDetail(message);
        addLog(`${label} 실패 · ${message}`);
      }
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function loadBackups() {
    if (!state.root) {
      state.backups = [];
      elements.backupSelect.replaceChildren(new Option('복원 가능한 백업 없음', ''));
      updateActionButtons();
      return;
    }
    const wasBusy = state.busy;
    const messageBeforeLoad = elements.message.textContent;
    state.backups = [];
    elements.backupSelect.replaceChildren(new Option('백업 목록 확인 중…', ''));
    updateActionButtons();
    if (!wasBusy) setBusy(true, '백업 목록을 불러오는 중…');
    try {
      const result = await window.dinoManager.backups();
      // Backups that have already been restored remain in the engine's history,
      // but must not be offered as another restore target.
      state.backups = Array.isArray(result.items)
        ? result.items.filter((item) => item && typeof item.id === 'string' && item.id && item.restorable === true)
        : [];
      elements.backupSelect.replaceChildren();
      if (!state.backups.length) {
        elements.backupSelect.add(new Option('복원 가능한 백업 없음', ''));
      } else {
        for (const backup of state.backups) {
          const label = `${backup.id} · 복원 가능`;
          elements.backupSelect.add(new Option(label, backup.id));
        }
        elements.backupSelect.selectedIndex = 0;
      }
      updateActionButtons();
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      state.backups = [];
      elements.backupSelect.replaceChildren(new Option('백업 목록 확인 실패', ''));
      updateActionButtons();
      elements.message.textContent = '백업 목록을 불러오지 못했습니다.';
      setDetail(message);
      addLog(`백업 목록 조회 실패 · ${message}`);
      throw error;
    } finally {
      if (!wasBusy) {
        setBusy(false);
        if (elements.message.textContent === '백업 목록을 불러오는 중…') {
          elements.message.textContent = messageBeforeLoad || recentMessage(state.status);
        }
      }
    }
  }

  let sourceRetryCount = 0;
  let sourceRetryTimer = null;

  function scheduleSourceRetry() {
    if (sourceRetryTimer || sourceRetryCount >= 3) return;
    const delay = [5000, 15000, 30000][sourceRetryCount];
    sourceRetryCount += 1;
    setAutoManageStatus('LilacAnime 종료 대기 · 안전 재검사 예약', 'warn');
    addLog(`LilacAnime 실행 중 · ${Math.round(delay / 1000)}초 뒤 다시 확인합니다.`);
    sourceRetryTimer = setTimeout(() => {
      sourceRetryTimer = null;
      void runSourceChangeRecheck();
    }, delay);
  }

  async function runSourceChangeRecheck() {
    if (state.busy) {
      state.pendingSourceChange = true;
      return;
    }
    state.pendingSourceChange = false;
    try {
      await withUiOperation('공식 원본 변경 감지 · 호환성 검사 및 자동 적용', () => window.dinoManager.startup());
      await loadBackups();
      sourceRetryCount = 0;
      if (sourceRetryTimer) clearTimeout(sourceRetryTimer);
      sourceRetryTimer = null;
    } catch (error) {
      const reason = String(error && error.message ? error.message : error);
      if (/LilacAnime가 실행 중|앱을 완전히 종료한 뒤/i.test(reason)) scheduleSourceRetry();
    }
  }

  async function refreshTarget(operation) {
    const result = await withUiOperation(operation, () => window.dinoManager.startup());
    await loadBackups();
    return result;
  }

  elements.chooseRoot.addEventListener('click', async () => {
    try {
      const selected = await window.dinoManager.chooseRoot();
      if (!selected) return;
      state.root = selected;
      state.backups = [];
      elements.backupSelect.replaceChildren(new Option('복원 가능한 백업 없음', ''));
      updateActionButtons();
      elements.targetPath.textContent = selected;
      elements.targetPath.title = selected;
      elements.targetPath.setAttribute('aria-label', `인식된 원본 폴더: ${selected}`);
      const result = await withUiOperation('원본 호환성 검사 및 자동 적용', () => window.dinoManager.startup());
      await loadBackups();
      if (result && result.status === 'NO_SOURCE') renderState({ ...result, path: selected }, '원본 검색');
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      elements.message.textContent = '원본 폴더를 확인하지 못했습니다.';
      setDetail(message);
      addLog('폴더 선택 실패 · ' + message);
    }
  });

  elements.inspect.addEventListener('click', async () => { try { await refreshTarget('원본 다시 확인 및 필요한 경우 자동 적용'); } catch {} });
  elements.apply.addEventListener('click', async () => {
    // Manual apply is not a second automatic startup: it runs a standalone
    // engine preflight and may explicitly re-enable a previously uninstalled
    // patch. Even UNKNOWN/CONFLICT statuses can request a fresh safety check,
    // but the backend refuses all unverified modifications.
    if (state.busy || !state.root || ['APPLIED', 'ALREADY_APPLIED'].includes(state.status)) return;
    const confirmed = await window.dinoManager.confirm('apply');
    if (!confirmed) return;
    try {
      await withUiOperation('수동 패치 적용', () => window.dinoManager.apply());
      await loadBackups();
    } catch { /* withUiOperation reports the independent inspection failure */ }
  });
  elements.uninstall.addEventListener('click', async () => {
    const confirmed = await window.dinoManager.confirm('uninstall');
    if (!confirmed) return;
    try { await withUiOperation('패치 해제', () => window.dinoManager.uninstall()); await loadBackups(); } catch {}
  });
  elements.restore.addEventListener('click', async () => {
    const backupId = elements.backupSelect.value;
    const selectedBackup = state.backups.find((item) => item.id === backupId && item.restorable === true);
    if (state.busy || !selectedBackup || !['APPLIED', 'ALREADY_APPLIED', 'UNPATCHED'].includes(state.status)) return;
    const confirmed = await window.dinoManager.confirm('restore');
    if (!confirmed) return;
    try { await withUiOperation('백업 복원', () => window.dinoManager.restore(backupId)); await loadBackups(); } catch {}
  });
  elements.history.addEventListener('click', async () => {
    try {
      const result = await withUiOperation('작업 기록 조회', () => window.dinoManager.history());
      if (result && Array.isArray(result.items)) {
        elements.log.textContent = result.items.map((item) => JSON.stringify(item, null, 2)).join('\n\n') || '작업 기록이 없습니다.';
        document.querySelector('.log-details').open = true;
      }
    } catch {}
  });
  elements.diagnostics.addEventListener('click', async () => {
    try {
      const result = await withUiOperation('상세 진단', () => window.dinoManager.diagnostics());
      if (result && Array.isArray(result.items)) {
        elements.log.textContent = result.items.join('\n') || '상세 진단 기록이 없습니다.';
        document.querySelector('.log-details').open = true;
      }
    } catch {}
  });
  elements.backupSelect.addEventListener('change', updateActionButtons);
  elements.checkUpdates.addEventListener('click', async () => {
    try { await withUiOperation('공식 최신 버전 확인', () => window.dinoManager.checkUpdates()); } catch {}
  });
  window.dinoManager.onProgress((message) => {
    elements.message.textContent = String(message || '작업을 진행하고 있습니다.');
    addLog(message);
  });
  window.dinoManager.onSourceChange((change) => {
    if (change && change.root && state.root && change.root.toLocaleLowerCase() !== state.root.toLocaleLowerCase()) return;
    if (sourceRetryTimer) {
      clearTimeout(sourceRetryTimer);
      sourceRetryTimer = null;
    }
    sourceRetryCount = 0;
    elements.message.textContent = '공식 원본 변경 감지 · 파일이 안정된 것을 확인했습니다.';
    setAutoManageStatus('공식 원본 변경 · 호환성 재검사 중', 'busy');
    addLog(`공식 원본 변경 감지${change && change.version ? ` · v${change.version}` : ''} · 호환성 재검사 및 필요한 경우 자동 적용`);
    if (state.busy) {
      state.pendingSourceChange = true;
      return;
    }
    void runSourceChangeRecheck();
  });
  window.dinoManager.onTheme(renderTheme);

  async function initialize() {
    try {
      state.info = await window.dinoManager.getInfo();
      elements.managerVersion.textContent = `관리자 v${state.info.managerVersion}`;
      elements.officialVersion.textContent = `v${state.info.officialVersion} 기준`;
      elements.targetPatchVersion.textContent = `v${state.info.patchVersion}`;
      addLog(`LilacAnime DinoPatch v${state.info.managerVersion} · 공식 기준 v${state.info.officialVersion}`);
      const result = await withUiOperation('원본 확인 및 필요한 경우 자동 적용', () => window.dinoManager.startup());
      if (result && result.status === 'NO_SOURCE') {
        renderState(result, '원본 검색');
        elements.message.textContent = '공식 원본 폴더를 자동으로 찾지 못했습니다.';
        setDetail('LilacAnime 원본 폴더 안에서 실행하거나 ‘원본 폴더 변경’을 눌러 소스 폴더를 지정하세요.');
      }
      if (state.root) await loadBackups();
      await window.dinoManager.refreshTheme();
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (state.info) {
        elements.message.textContent = '원본 호환성 검사 또는 안전한 적용을 완료하지 못했습니다.';
        setDetail(`${message}\n\n관리자 엔진 연결은 확인되었습니다. 적용 여부는 원본 파일 지문과 작업 기록으로 확인하세요.`);
        renderSafety('ERROR', message);
        setChip(elements.patchBadge, '적용 중단', 'bad');
        addLog(`원본 검사/자동 적용 중단 · ${message}`);
      } else {
        elements.message.textContent = '관리자 엔진을 시작하지 못했습니다.';
        setDetail(message);
        renderSafety('ERROR', message);
        setChip(elements.patchBadge, '확인 불가', 'bad');
        addLog(`초기화 실패 · ${message}`);
      }
    } finally {
      setBusy(false);
    }
  }

  void initialize();
})();
