'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UPDATE_CHANNEL = 'patch:chatgpt-web:background-update';
const JOB_KEY = /^[a-zA-Z0-9_-]{8,96}$/;
const MAX_FILE_BYTES = 12_000_000;
const MAX_PROMPT_CHARS = 120_000;
const PROGRESS = Object.freeze({
  'checking-page': 5, authenticated: 12, 'opening-attachment-menu': 18,
  'attaching-source-file': 22, 'waiting-attachment': 32, 'preparing-instructions': 40,
  'sending-instructions': 48, 'waiting-full-file-response': 55,
  'checking-response-stability': 66, 'downloading-result-file': 82,
  validating: 90, saving: 96, completed: 100
});

function error(code, message) {
  const value = new Error(message);
  value.code = code;
  return value;
}

function atomicWrite(file, value) {
  const temp = `${file}.pending-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, value);
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } catch (cause) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
    throw cause;
  }
}

function createChatGPTBackgroundTranslation({
  app, driver, getWindow, saveSubtitle, Notification,
  rootDir, manual = require('../src/manual-subtitle-translation.js'), now = Date.now
} = {}) {
  if (!app?.getPath || !driver?.runFile || !driver?.cancel || typeof getWindow !== 'function' || typeof saveSubtitle !== 'function')
    throw new TypeError('Patch 02 백그라운드 번역 의존성이 올바르지 않습니다.');

  const root = path.resolve(rootDir || path.join(app.getPath('temp') || os.tmpdir(), 'dino-lilac-patch02-chatgpt'));
  fs.mkdirSync(root, { recursive: true });
  const latestPath = path.join(root, 'latest-job.json');
  let latest = loadLatest();
  let active = null;
  let shutdownRequested = false;
  let allowQuit = false;
  let quitting = false;

  function directoryFor(jobKey) { return path.join(root, jobKey); }
  function statePath(jobKey) { return path.join(directoryFor(jobKey), 'job-state.json'); }
  function isInsideRoot(candidate) {
    const resolved = path.resolve(candidate);
    return resolved !== root && resolved.startsWith(root + path.sep);
  }
  function loadLatest() {
    try {
      const index = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
      if (!JOB_KEY.test(String(index?.jobKey || ''))) return null;
      const stateFile = path.join(root, index.jobKey, 'job-state.json');
      const record = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (record?.schema !== 1 || record.jobKey !== index.jobKey) return null;
      return record;
    } catch { return null; }
  }
  function persist(record) {
    record.updatedAt = now();
    const dir = directoryFor(record.jobKey);
    if (!isInsideRoot(dir)) throw error('JOB_STORAGE_PATH_INVALID', '임시 번역 작업 경로를 확인하지 못했습니다.');
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(statePath(record.jobKey), Buffer.from(JSON.stringify(record), 'utf8'));
    atomicWrite(latestPath, Buffer.from(JSON.stringify({ jobKey: record.jobKey }), 'utf8'));
    latest = record;
  }
  function snapshot(record = latest) {
    if (!record) return null;
    return {
      jobKey: record.jobKey, status: record.status, phase: record.phase,
      progress: Number(record.progress) || 0, cueCount: Number(record.cueCount) || 0,
      attached: record.attached === true, sendAttempted: record.sendAttempted === true,
      sent: record.sent === true, message: String(record.message || ''),
      errorCode: record.errorCode || null, episodeKey: record.episodeKey,
      sourcePath: record.sourcePath, sourceFingerprint: record.sourceFingerprint,
      playbackId: Number(record.playbackId) || 0, sourceLabel: record.sourceLabel,
      savedSubtitle: record.savedSubtitle || null, updatedAt: record.updatedAt || null,
      responseAvailable: Boolean(record.responseFilePath && fs.existsSync(record.responseFilePath))
    };
  }
  function sendTo(sender, record) {
    try {
      if (sender && !sender.isDestroyed?.()) sender.send(UPDATE_CHANNEL, snapshot(record));
    } catch {}
  }
  function notify(title, body) {
    try {
      if (!Notification || Notification.isSupported?.() === false) return;
      const notification = new Notification({ title, body });
      notification.show();
    } catch {}
  }
  function publish(sender, record, notification) {
    sendTo(sender, record);
    if (notification) notify(notification.title, notification.body);
  }
  async function update(context, values, notification) {
    Object.assign(context.record, values);
    persist(context.record);
    publish(context.sender, context.record, notification);
  }
  function getStatus(jobKey) {
    if (active && (!jobKey || active.record.jobKey === jobKey)) return snapshot(active.record);
    if (latest && (!jobKey || latest.jobKey === jobKey)) return snapshot(latest);
    return null;
  }
  function validateInput(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('INVALID_REQUEST', '전체 자막 번역 요청 형식이 올바르지 않습니다.');
    const jobKey = String(input.jobKey || ''), prompt = String(input.prompt || ''), content = String(input.content || '');
    const episodeKey = String(input.episodeKey || ''), sourcePath = String(input.sourcePath || ''), sourceFingerprint = String(input.sourceFingerprint || '');
    if (!JOB_KEY.test(jobKey)) throw error('INVALID_REQUEST', '번역 작업 식별자가 올바르지 않습니다.');
    if (!prompt.trim() || prompt.length > MAX_PROMPT_CHARS || /JSON\s*(?:만|only)|JSON\s*형식|\{"translations"/i.test(prompt))
      throw error('INVALID_REQUEST', '전체 SRT 파일 번역 지침이 올바르지 않습니다.');
    if (!content.trim() || content.includes('\0') || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES)
      throw error('INVALID_REQUEST', '첨부할 전체 SRT 파일이 비어 있거나 크기 제한을 넘었습니다.');
    if (!episodeKey || episodeKey.length > 512 || episodeKey.includes('\0') || !sourcePath || sourcePath.length > 16_384 || sourcePath.includes('\0') ||
        !sourceFingerprint || sourceFingerprint.length > 512)
      throw error('INVALID_REQUEST', '원본 자막 또는 회차 식별 정보가 올바르지 않습니다.');
    const parsed = manual.parseSrt(content);
    if (!parsed.cues.length) throw error('INVALID_REQUEST', '번역할 SRT 자막이 없습니다.');
    return {
      jobKey, prompt, content, parsed, episodeKey, sourcePath, sourceFingerprint,
      sourceLabel: String(input.sourceLabel || '원본 자막').slice(0, 500),
      title: String(input.title || '').slice(0, 500), episode: Math.max(1, Number(input.episode) || 1),
      language: String(input.language || '').slice(0, 20), sourceKind: String(input.sourceKind || '').slice(0, 100),
      playbackId: Number(input.playbackId) || 0, repeatConfirmed: input.repeatConfirmed === true,
      reviewConfirmed: input.reviewConfirmed === true
    };
  }
  function sameSource(record, input) {
    return Boolean(record && record.episodeKey === input.episodeKey && record.sourceFingerprint === input.sourceFingerprint);
  }
  function ambiguous(record) {
    return Boolean(record && (record.sendAttempted || record.attached) && !record.completed);
  }
  function createRecord(input, dir) {
    return {
      schema: 1, jobKey: input.jobKey, status: 'running', phase: 'checking-page', progress: 2,
      message: '로그인한 앱 소유 ChatGPT 창과 입력창을 확인하고 있습니다.',
      episodeKey: input.episodeKey, sourcePath: input.sourcePath, sourceFingerprint: input.sourceFingerprint,
      sourceLabel: input.sourceLabel, title: input.title, episode: input.episode, language: input.language,
      sourceKind: input.sourceKind, playbackId: input.playbackId, cueCount: input.parsed.cues.length,
      directory: dir, sourceFilePath: path.join(dir, 'source.srt'), promptFilePath: path.join(dir, 'instruction.txt'),
      responseFilePath: path.join(dir, `${input.jobKey}-translated.srt`),
      attached: false, sendAttempted: false, sent: false, completed: false,
      conversationPath: null, savedSubtitle: null, errorCode: null, createdAt: now(), updatedAt: now()
    };
  }
  function authPause(code) { return code === 'CHATGPT_LOGIN_REQUIRED' || code === 'CHATGPT_CHALLENGE' || code === 'CHATGPT_USER_CONFIRMATION_REQUIRED'; }

  async function finalize(record, content, sender) {
    await update({ record, sender }, {
      status: 'running', phase: 'validating', progress: PROGRESS.validating,
      message: '완성 SRT 전체의 자막 수·번호·순서·시간을 원본과 대조하고 있습니다.', errorCode: null
    });
    let source, checked, vtt;
    try {
      source = manual.parseSrt(fs.readFileSync(record.sourceFilePath, 'utf8'));
      checked = manual.validateWholeFileResult(content, source.cues);
      vtt = manual.renderTranslatedWebVtt(source, checked.translations);
      manual.validateRenderedWebVtt(source, vtt);
    } catch (cause) {
      const e = cause instanceof Error ? cause : new Error(String(cause));
      e.code ||= 'WHOLE_FILE_VALIDATION_FAILED';
      throw e;
    }
    await update({ record, sender }, {
      phase: 'saving', progress: PROGRESS.saving,
      message: '검증에 성공했습니다. 한국어 WebVTT를 저장하고 있습니다.'
    });
    const savedSubtitle = await saveSubtitle({
      key: record.episodeKey, text: vtt, from: record.sourcePath,
      fromName: record.sourceLabel, mode: 'web-auto', jobKey: record.jobKey
    });
    if (!savedSubtitle?.url || !savedSubtitle?.path) throw error('SUBTITLE_SAVE_FAILED', '검증된 WebVTT를 저장하지 못했습니다. 완성 SRT와 복구 상태를 보존했습니다.');
    await update({ record, sender }, {
      status: 'completed', phase: 'completed', progress: PROGRESS.completed,
      completed: true, sent: record.sent || record.sendAttempted,
      message: '전체 자막 검증과 한국어 WebVTT 저장이 완료됐습니다. 재생 중인 영상이 원본과 같으면 자동 적용합니다.',
      savedSubtitle: {
        path: savedSubtitle.path, url: savedSubtitle.url,
        episodeKey: record.episodeKey, sourcePath: record.sourcePath,
        sourceFingerprint: record.sourceFingerprint, sourceLabel: record.sourceLabel,
        sourceKind: record.sourceKind
      }, errorCode: null
    }, { title: '한국어 자막 번역 완료', body: `${record.cueCount}개 자막을 검증하고 저장했습니다.` });
    cleanupCompletedFiles(record);
    return snapshot(record);
  }
  function cleanupCompletedFiles(record) {
    for (const file of [record.sourceFilePath, record.promptFilePath, record.responseFilePath]) {
      if (!file || !isInsideRoot(file)) continue;
      try { fs.unlinkSync(file); } catch {}
    }
  }

  async function execute(context) {
    const { record, input } = context;
    try {
      const response = await driver.runFile({
        jobKey: record.jobKey, prompt: input.prompt, fileName: 'subtitle-to-translate.srt',
        filePath: record.sourceFilePath, tempDir: record.directory
      }, { onProgress: async progress => {
          const phase = String(progress?.phase || '');
          if (progress?.conversationPath) record.conversationPath = progress.conversationPath;
          const values = {
            phase: phase || record.phase,
            progress: PROGRESS[phase] ?? record.progress,
            attached: progress?.attached === true || record.attached,
            sendAttempted: typeof progress?.sendAttempted === 'boolean' ? progress.sendAttempted : record.sendAttempted,
            sent: progress?.sent === true || record.sent,
            conversationPath: record.conversationPath
          };
          if (phase === 'authenticated') {
            const win = getWindow();
            if (!win || win.isDestroyed?.() || typeof win.hide !== 'function')
              throw error('BACKGROUND_WINDOW_UNAVAILABLE', '내장 ChatGPT 창을 백그라운드로 숨길 수 없어 번역을 보내지 않았습니다.');
            win.hide();
            values.message = '로그인된 내장 ChatGPT 창을 확인했습니다. 전체 SRT를 첨부하고 백그라운드 번역을 시작합니다.';
          } else if (phase === 'attaching-source-file') values.message = '전체 SRT 파일 하나를 첨부하고 있습니다.';
          else if (phase === 'waiting-attachment') values.message = 'ChatGPT가 전체 SRT 업로드를 마치는지 확인하고 있습니다.';
          else if (phase === 'preparing-instructions') values.message = '전체 파일 번역 지침 한 번을 준비하고 있습니다.';
          else if (phase === 'sending-instructions') values.message = '전송 시도를 기록했습니다. 같은 파일과 지침은 다시 보내지 않습니다.';
          else if (phase === 'waiting-full-file-response') values.message = '전체 번역 응답을 기다립니다. LilacAnime와 다른 앱을 계속 사용할 수 있습니다.';
          else if (phase === 'downloading-result-file') values.message = '완성 SRT 파일을 회수하고 있습니다.';
          const statusNotification = phase === 'waiting-full-file-response'
            ? { title: '자막 백그라운드 번역 중', body: '전체 파일 첨부를 확인했습니다. 번역 응답을 기다립니다.' }
            : null;
          await update(context, values, statusNotification);
        }
      });
      if (!response?.ok || response.jobKey !== record.jobKey || typeof response.responseFile?.content !== 'string' || !/\.srt$/i.test(response.responseFile.name))
        throw error(response?.code || 'CHATGPT_RESULT_UNAVAILABLE', response?.error || '완성된 전체 SRT 파일을 회수하지 못했습니다. 일부 결과는 적용하지 않았습니다.');
      const resultBytes = Buffer.byteLength(response.responseFile.content, 'utf8');
      if (!resultBytes || resultBytes > MAX_FILE_BYTES) throw error('CHATGPT_RESULT_FILE_INVALID', '회수한 완성 SRT 파일이 비어 있거나 크기 제한을 넘었습니다.');
      atomicWrite(record.responseFilePath, Buffer.from(response.responseFile.content, 'utf8'));
      await update(context, {
        sent: response.sent === true, attached: response.attached === true,
        phase: 'validating', progress: PROGRESS.validating,
        message: '완성 SRT를 복구용으로 보존했습니다. 전체 자막 검증을 시작합니다.'
      });
      await finalize(record, response.responseFile.content, context.sender);
    } catch (cause) {
      const e = cause instanceof Error ? cause : new Error(String(cause));
      const code = String(e.code || 'CHATGPT_WEB_FAILED');
      record.attached = e.attached === true || record.attached;
      record.sent = e.sent === true || record.sent;
      record.sendAttempted = record.sendAttempted || e.sendAttempted === true || ['sending-instructions', 'waiting-full-file-response', 'checking-response-stability', 'downloading-result-file'].includes(record.phase) || record.sent;
      const status = context.shutdownRequested ? 'interrupted' : code === 'CANCELLED' ? 'cancelled' : authPause(code) ? 'needs-user' : 'error';
      const message = context.shutdownRequested
        ? (record.sendAttempted ? '앱 종료로 작업을 안전하게 멈췄습니다. 요청이 전송됐을 수 있어 다시 보내지 않습니다. 원본 SRT와 작업 상태를 보존했습니다.' : '앱 종료로 작업을 안전하게 멈췄습니다. 전송 전에 중단했으며 원본 SRT와 작업 상태를 보존했습니다.')
        : status === 'needs-user'
          ? `${e.message} 내장 ChatGPT 창에서 직접 확인한 뒤 작업을 다시 시작해 주세요.`
          : status === 'cancelled'
            ? (record.sendAttempted ? '백그라운드 작업을 중단했습니다. 이미 전송됐을 수 있는 요청은 자동 재전송하지 않습니다.' : '백그라운드 작업을 중단했습니다. 완료된 파일과 작업 상태를 보존했습니다.')
            : `${e.message}${record.sendAttempted || record.attached ? ' 첨부 또는 전송 상태를 보존했으며 자동 재시도하지 않습니다.' : ''}`;
      try {
        await update(context, {
          status, phase: status, message, errorCode: code,
          attached: record.attached, sent: record.sent, sendAttempted: record.sendAttempted
        }, status === 'needs-user'
          ? { title: 'ChatGPT 확인이 필요합니다', body: message }
          : status === 'cancelled' || status === 'interrupted'
            ? { title: '자막 번역 작업이 중단됐습니다', body: message }
            : { title: '자막 번역 오류', body: message });
      } catch {}
    } finally {
      context.settled = true;
      if (active === context) active = null;
      context.resolveDone?.();
    }
  }

  async function start(rawInput, sender) {
    const input = validateInput(rawInput);
    if (active) return { ok: false, code: 'WEB_TRANSLATION_BUSY', message: '이미 백그라운드 자막 번역이 진행 중입니다.', task: snapshot(active.record) };
    if (latest && sameSource(latest, input) && latest.status === 'completed' && !input.repeatConfirmed)
      return { ok: false, code: 'CHATGPT_TRANSLATION_ALREADY_COMPLETED', message: '이 원본 자막의 번역은 이미 저장됐습니다.', task: snapshot(latest) };
    if (ambiguous(latest) && !input.reviewConfirmed)
      return { ok: false, code: 'CHATGPT_PREVIOUS_REQUEST_UNCERTAIN', requiresUserReview: true,
        message: '이전 ChatGPT 요청이 첨부 또는 전송됐을 수 있습니다. 같은 대화에서 다른 요청을 보내기 전에 입력창과 대화를 직접 확인해 주세요.', task: snapshot(latest) };
    const win = getWindow();
    if (!win || win.isDestroyed?.() || !win.webContents || win.webContents.isDestroyed?.())
      return { ok: false, code: 'CHATGPT_WINDOW_CLOSED', message: '로그인한 앱 소유 ChatGPT 창이 없습니다. 내장 창을 직접 열고 로그인 상태를 확인한 뒤 다시 시작하세요.' };
    const dir = directoryFor(input.jobKey);
    if (!isInsideRoot(dir)) throw error('JOB_STORAGE_PATH_INVALID', '임시 번역 작업 경로를 확인하지 못했습니다.');
    if (fs.existsSync(dir)) throw error('DUPLICATE_JOB_KEY', '이미 저장된 번역 작업 식별자를 재사용하지 않았습니다.');
    fs.mkdirSync(dir, { recursive: true });
    const record = createRecord(input, dir);
    atomicWrite(record.sourceFilePath, Buffer.from(input.content, 'utf8'));
    atomicWrite(record.promptFilePath, Buffer.from(input.prompt, 'utf8'));
    const context = { record, input, sender, shutdownRequested: false, settled: false };
    context.done = new Promise(resolve => { context.resolveDone = resolve; });
    active = context;
    try { persist(record); }
    catch (cause) {
      active = null;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      throw cause;
    }
    publish(sender, record, { title: '자막 백그라운드 번역 시작', body: `${record.cueCount}개 자막을 전체 파일 하나로 처리합니다.` });
    void execute(context);
    return { ok: true, task: snapshot(record) };
  }
  async function cancel(jobKey) {
    const context = active;
    if (!context || context.record.jobKey !== String(jobKey || ''))
      return { cancelled: false, task: getStatus(jobKey) };
    try { await update(context, { status: 'cancelling', phase: 'cancelling', message: '백그라운드 번역을 안전하게 중단하고 있습니다.' }); } catch {}
    try { await driver.cancel(context.record.jobKey); } catch {}
    await context.done;
    return { cancelled: context.record.status !== 'completed', task: snapshot(context.record) };
  }
  function acknowledge(jobKey, confirmed) {
    if (confirmed !== true || active) return { ok: false, message: '활성 작업 중에는 이전 요청을 확인 처리할 수 없습니다.' };
    if (!latest || latest.jobKey !== String(jobKey || '') || !ambiguous(latest)) return { ok: false, message: '확인이 필요한 이전 요청을 찾지 못했습니다.' };
    latest.reviewConfirmed = true;
    latest.reviewedAt = now();
    latest.message = '사용자가 ChatGPT 입력창과 대화를 확인했습니다. 명시적으로 다시 시작할 수 있습니다.';
    persist(latest);
    return { ok: true, task: snapshot(latest) };
  }
  function discard(jobKey) {
    const context = active;
    if (context?.record.jobKey === String(jobKey || '')) return { ok: false, message: '실행 중인 작업은 삭제할 수 없습니다.' };
    const record = latest;
    if (!record || record.jobKey !== String(jobKey || '')) return { ok: false, message: '삭제할 작업을 찾지 못했습니다.' };
    const dir = directoryFor(record.jobKey);
    if (!isInsideRoot(dir)) return { ok: false, message: '임시 번역 작업 경로가 올바르지 않습니다.' };
    fs.rmSync(dir, { recursive: true, force: true });
    try { fs.unlinkSync(latestPath); } catch {}
    latest = null;
    return { ok: true };
  }
  function handleBeforeQuit(event) {
    if (allowQuit || !active || quitting) return;
    event?.preventDefault?.();
    quitting = true;
    const context = active;
    context.shutdownRequested = true;
    context.record.status = 'interrupted';
    context.record.message = '앱 종료 요청을 받아 번역을 중단하고 복구 상태를 저장합니다.';
    try { persist(context.record); publish(context.sender, context.record); } catch {}
    void (async () => {
      try { await driver.cancel(context.record.jobKey); } catch {}
      await context.done;
      allowQuit = true;
      try { app.quit?.(); } catch {}
    })();
  }
  if (typeof app.on === 'function') app.on('before-quit', handleBeforeQuit);

  if (latest && !latest.completed && ['running', 'cancelling'].includes(latest.status)) {
    latest.status = 'interrupted'; latest.phase = 'interrupted';
    latest.message = latest.sendAttempted
      ? '앱이 이전 작업 중 종료됐습니다. 요청이 전송됐을 수 있어 자동 재전송하지 않습니다. 입력창과 대화를 확인해 주세요.'
      : '앱이 이전 작업 중 종료됐습니다. 전송 전 상태와 원본 SRT를 보존했습니다.';
    try { persist(latest); } catch {}
  }

  if (latest && !latest.completed && ['running', 'interrupted'].includes(latest.status) &&
      latest.responseFilePath && fs.existsSync(latest.responseFilePath) && fs.existsSync(latest.sourceFilePath)) {
    const recovery = latest;
    const ready = app.isReady?.() ? Promise.resolve() : app.whenReady?.() || Promise.resolve();
    void Promise.resolve(ready).then(async () => {
      try {
        const bytes = fs.readFileSync(recovery.responseFilePath);
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        await finalize(recovery, content, null);
      } catch (cause) {
        const e = cause instanceof Error ? cause : new Error(String(cause));
        try {
          const context = { record: recovery, sender: null };
          await update(context, { status: 'error', phase: 'error', errorCode: e.code || 'RECOVERY_FAILED',
            message: `저장된 완성 SRT 복구에 실패했습니다. 파일과 작업 상태를 보존하고 재전송하지 않았습니다. ${e.message}` });
        } catch {}
      }
    });
  }

  return Object.freeze({ start, getStatus, cancel, acknowledge, discard, snapshot: () => snapshot(), updateChannel: UPDATE_CHANNEL });
}

module.exports = { UPDATE_CHANNEL, createChatGPTBackgroundTranslation };
