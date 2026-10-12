'use strict';

const bridge = window.dinoPatchManager;
const byId = id => document.getElementById(id);
const checks = {
  'patch-01': byId('patch01'),
  'patch-02': byId('patch02'),
  'patch-03': byId('patch03')
};
let hasTarget = false;
let canApply = false;
let canRestore = false;

function setMessage(message, detail = '', tone = '') {
  byId('message').textContent = message;
  byId('detail').textContent = detail;
  byId('message').dataset.tone = tone;
}

function setChip(element, label, tone = 'neutral') {
  element.textContent = label;
  element.className = `status-chip ${tone}`;
}

function setBusy(busy) {
  byId('chooseSource').disabled = busy;
  byId('openIsolated').disabled = busy;
  byId('apply').disabled = busy || !hasTarget || !canApply;
  byId('restore').disabled = busy || !hasTarget || !canRestore;
}

function patchLabel(patch) {
  if (patch?.selection === 'off' || patch?.status === 'disabled') return ['OFF', 'neutral'];
  if (patch?.status === 'applied') return ['적용됨', 'good'];
  if (patch?.status === 'structural-candidate') return ['격리 적용 후보', 'warn'];
  if (patch?.status === 'blocked') return ['차단됨', 'bad'];
  return [patch?.status || '확인 필요', 'warn'];
}

function renderTarget(payload) {
  if (!payload?.ok) {
    if (payload?.canceled) return;
    setMessage(payload?.error || '대상 상태를 읽지 못했습니다.', '잘못된 경로, 일반 설치본, 실행 중 앱, 변경된 소스는 거부됩니다.', 'error');
    return;
  }
  const state = payload.state;
  hasTarget = true;
  byId('targetPath').textContent = payload.targetRoot;
  byId('settingsPath').textContent = payload.settingsPath;
  setChip(byId('versionBadge'), `${state.version || '0.5.15'} · ${state.mode === 'applied' ? '적용 상태' : '격리 대상'}`, state.mode === 'modified-after-apply' ? 'bad' : 'good');

  const initial = { ...state.settings.patches };
  if (!state.settingsStored && state.mode === 'ready') initial['patch-03'] = true;
  for (const [id, checkbox] of Object.entries(checks)) checkbox.checked = initial[id];
  for (const id of ['patch-01', 'patch-02', 'patch-03']) {
    const [label, tone] = patchLabel(state.patches?.[id]);
    setChip(byId(`status${id.slice(-2)}`), label, tone);
  }

  canApply = state.mode !== 'modified-after-apply';
  canRestore = state.backupAvailable === true;
  byId('apply').disabled = !canApply;
  byId('restore').disabled = !canRestore;
  const latest = state.latest && state.latest !== 'not-applied' ? `최근 작업: ${state.latest}.` : '';
  const intro = state.mode === 'modified-after-apply'
    ? '적용 후 파일 변경이 감지되어 자동 덮어쓰기를 차단했습니다.'
    : state.mode === 'applied' ? '패치 적용 상태를 백업 지문과 대조했습니다.' : '격리 사본을 확인했습니다. 새 사본은 Patch 03 ON(B 화면)으로 시작합니다.';
  setMessage(intro, `${latest} Patch 03 OFF는 원본 A 화면을 유지합니다. 세 패치는 독립적으로 선택할 수 있습니다.`);
}

function selectedSettings() {
  return { patches: Object.fromEntries(Object.entries(checks).map(([id, checkbox]) => [id, checkbox.checked])) };
}

async function run(action, successLabel) {
  if (!hasTarget) return;
  setBusy(true);
  setMessage('격리 사본을 확인하고 있습니다…');
  try {
    const response = await action();
    if (!response?.ok) throw new Error(response?.error || '작업이 완료되지 않았습니다.');
    renderTarget(response);
    if (response.result) {
      const blocked = response.result.blocked?.length ? ` 차단된 패치: ${response.result.blocked.join(', ')}.` : '';
      setMessage(`${successLabel}: ${response.result.status}.`, `${blocked} 적용 대상은 OS 임시 폴더의 사본뿐입니다.`);
    }
  } catch (error) {
    setMessage(error.message, '실행 중인 앱, 변경된 파일, 안전 경계 오류가 있으면 작업이 중단됩니다.', 'error');
  } finally {
    setBusy(false);
  }
}

byId('chooseSource').addEventListener('click', async () => {
  setBusy(true);
  setMessage('공식 소스 체크아웃을 확인하고 격리 사본을 만드는 중입니다…');
  try { renderTarget(await bridge.chooseSource()); }
  finally { setBusy(false); }
});
byId('openIsolated').addEventListener('click', async () => {
  setBusy(true);
  try { renderTarget(await bridge.openIsolated()); }
  finally { setBusy(false); }
});
byId('apply').addEventListener('click', () => {
  const settings = selectedSettings();
  const summary = Object.entries(settings.patches).map(([id, enabled]) => `${id}: ${enabled ? 'ON' : 'OFF'}`).join('\n');
  if (!window.confirm(`선택한 기능을 격리 사본에 적용할까요?\n\n${summary}\n\n대상은 OS 임시 폴더의 사본입니다.`)) return;
  void run(() => bridge.apply(settings), '적용 결과');
});
byId('restore').addEventListener('click', () => {
  if (!window.confirm('백업 지문을 확인한 뒤 격리 사본을 원본 상태로 복구할까요?')) return;
  void run(() => bridge.restore(), '복구 결과');
});

bridge.inspect().then(renderTarget).catch(error => setMessage(error.message, '', 'error'));
