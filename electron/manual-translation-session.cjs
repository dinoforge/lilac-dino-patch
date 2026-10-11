'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_SESSION_BYTES = 24 * 1024 * 1024;
const MAX_ANSWER_CHARS = 2_000_000;
const MAX_TRANSLATIONS = 20_000;
const CLEANUP_TIMINGS = new Set(['immediate', 'five-minutes', 'on-close']);
const SESSION_STATES = new Set(['ready', 'awaiting-response', 'validating', 'error', 'cancelled', 'saving', 'completed']);

function safeKey(value, name) {
  const result = String(value ?? '').trim();
  if (!result || result.length > 1200) throw new Error(`${name} 값이 비어 있거나 너무 깁니다.`);
  return result;
}

function safeHash(value) {
  const result = String(value ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('자막 원본 지문이 올바르지 않습니다.');
  return result;
}

function defaultSettings(value = {}) {
  return {
    autoCleanup: value.autoCleanup !== false,
    cleanupTiming: CLEANUP_TIMINGS.has(value.cleanupTiming) ? value.cleanupTiming : 'immediate'
  };
}

function sanitizeSession(key, fingerprint, value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('번역 작업 데이터가 올바르지 않습니다.');
  const status = SESSION_STATES.has(value.status) ? value.status : 'ready';
  const index = Number(value.index), batchCount = Number(value.batchCount), totalCueCount = Number(value.totalCueCount);
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(batchCount) || batchCount < 1 || batchCount > 1000 || index > batchCount ||
      !Number.isInteger(totalCueCount) || totalCueCount < 1 || totalCueCount > MAX_TRANSLATIONS) {
    throw new Error('번역 진행 정보가 올바르지 않습니다.');
  }
  const language = value.language === 'english' ? 'english' : value.language === 'japanese' ? 'japanese' : '';
  if (!language) throw new Error('지원하지 않는 번역 언어입니다.');
  const rawTranslations = value.translations && typeof value.translations === 'object' && !Array.isArray(value.translations) ? value.translations : {};
  const entries = Object.entries(rawTranslations);
  if (entries.length > totalCueCount || entries.length > MAX_TRANSLATIONS) throw new Error('번역 완료 문장 수가 올바르지 않습니다.');
  const translations = Object.create(null);
  for (const [id, text] of entries) {
    if (!/^\d{1,7}$/.test(id) || Number(id) < 1 || typeof text !== 'string' || text.length > 50_000) throw new Error('번역된 문장 데이터가 올바르지 않습니다.');
    translations[id] = text;
  }
  const answer = String(value.answer ?? '');
  if (answer.length > MAX_ANSWER_CHARS) throw new Error('임시 응답이 너무 큽니다.');
  const record = {
    schema: 1,
    episodeKey: key,
    sourceFingerprint: fingerprint,
    sourcePath: String(value.sourcePath ?? '').slice(0, 16_384),
    sourceLabel: String(value.sourceLabel ?? '원본 자막').slice(0, 500),
    title: String(value.title ?? '').slice(0, 1000),
    episode: Math.max(1, Math.min(99999, Number(value.episode) || 1)),
    language,
    index,
    batchCount,
    totalCueCount,
    translations,
    answer,
    status,
    message: String(value.message ?? '').slice(0, 2000),
    cleanupAt: Number.isFinite(Number(value.cleanupAt)) && Number(value.cleanupAt) > 0 ? Number(value.cleanupAt) : null,
    updatedAt: now()
  };
  const encoded = Buffer.from(JSON.stringify(record), 'utf8');
  if (encoded.length > MAX_SESSION_BYTES) throw new Error('임시 번역 작업이 저장 한도를 넘었습니다.');
  return record;
}

function createManualTranslationSessionStore({ userDataPath, fsImpl = fs, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (!userDataPath || typeof userDataPath !== 'string') throw new TypeError('격리된 userData 경로가 필요합니다.');
  const root = path.resolve(userDataPath);
  const sessionRoot = path.join(root, 'subtitles', 'manual-translation-sessions');
  const settingsFile = path.join(root, 'subtitle-translation-settings.json');
  const sourceRoot = path.join(root, 'subtitles', 'translated');
  const cleanupTimers = new Map();
  const fileFor = (episodeKey, sourceFingerprint) => path.join(sessionRoot, `${crypto.createHash('sha256').update(`${episodeKey}\0${sourceFingerprint}`).digest('hex')}.json`);

  function clearCleanupTimer(file) {
    const timer = cleanupTimers.get(file);
    if (!timer) return;
    clearTimeoutImpl(timer);
    cleanupTimers.delete(file);
  }

  function clearAllCleanupTimers() {
    for (const timer of cleanupTimers.values()) clearTimeoutImpl(timer);
    cleanupTimers.clear();
  }

  function scheduleCleanup(episodeKey, sourceFingerprint, cleanupAt) {
    const file = fileFor(episodeKey, sourceFingerprint);
    clearCleanupTimer(file);
    const delay = Math.max(0, Math.min(2_147_483_647, cleanupAt - now()));
    const timer = setTimeoutImpl(() => {
      cleanupTimers.delete(file);
      try {
        const settings = getSettings(), record = readJson(file, MAX_SESSION_BYTES);
        if (settings.autoCleanup && settings.cleanupTiming === 'five-minutes' &&
            record?.status === 'completed' && Number(record.cleanupAt) <= now()) remove(episodeKey, sourceFingerprint);
      } catch { /* Keep the work if its state cannot be read safely. */ }
    }, delay);
    timer?.unref?.();
    cleanupTimers.set(file, timer);
  }

  function refreshCleanupTimers() {
    clearAllCleanupTimers();
    const settings = getSettings();
    if (!settings.autoCleanup || settings.cleanupTiming !== 'five-minutes') return;
    let entries = [];
    try { entries = fsImpl.readdirSync(sessionRoot, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
      const file = path.join(sessionRoot, entry.name);
      try {
        const record = readJson(file, MAX_SESSION_BYTES);
        if (record?.schema !== 1 || record.status !== 'completed' || !record.cleanupAt) continue;
        const key = safeKey(record.episodeKey, '회차 식별 정보'), fingerprint = safeHash(record.sourceFingerprint);
        if (fileFor(key, fingerprint) !== file || record.cleanupAt <= now()) continue;
        scheduleCleanup(key, fingerprint, record.cleanupAt);
      } catch { /* Preserve unreadable work and do not schedule it for deletion. */ }
    }
  }

  function atomicWrite(file, content) {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const temp = path.join(path.dirname(file), `.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
    let descriptor;
    try {
      descriptor = fsImpl.openSync(temp, 'wx', 0o600);
      fsImpl.writeFileSync(descriptor, content, 'utf8');
      try { fsImpl.fsyncSync(descriptor); } catch {}
      fsImpl.closeSync(descriptor); descriptor = undefined;
      fsImpl.renameSync(temp, file);
    } catch (error) {
      if (descriptor !== undefined) try { fsImpl.closeSync(descriptor); } catch {}
      try { fsImpl.unlinkSync(temp); } catch {}
      throw error;
    }
  }

  function readJson(file, maxBytes) {
    let stat;
    try { stat = fsImpl.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('저장된 번역 작업 파일을 안전하게 읽을 수 없습니다.');
    return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  }

  function getSettings() {
    try { return defaultSettings(readJson(settingsFile, 16_384) || {}); }
    catch { return defaultSettings(); }
  }

  function saveSettings(value) {
    const settings = defaultSettings(value);
    atomicWrite(settingsFile, JSON.stringify({ schema: 1, ...settings }, null, 2));
    refreshCleanupTimers();
    return settings;
  }

  function load(episodeKey, sourceFingerprint) {
    const key = safeKey(episodeKey, '회차 식별 정보'), fingerprint = safeHash(sourceFingerprint), file = fileFor(key, fingerprint);
    const record = readJson(file, MAX_SESSION_BYTES);
    if (!record) return null;
    if (record.schema !== 1 || record.episodeKey !== key || record.sourceFingerprint !== fingerprint) throw new Error('저장된 번역 작업의 회차 또는 원본 자막이 일치하지 않습니다.');
    const normalized = sanitizeSession(key, fingerprint, record, now);
    const settings = getSettings();
    if (normalized.status === 'completed' && settings.autoCleanup &&
        (settings.cleanupTiming === 'immediate' || normalized.cleanupAt && normalized.cleanupAt <= now())) {
      remove(key, fingerprint);
      return null;
    }
    return normalized;
  }

  function save(episodeKey, sourceFingerprint, value) {
    const key = safeKey(episodeKey, '회차 식별 정보'), fingerprint = safeHash(sourceFingerprint);
    const normalized = sanitizeSession(key, fingerprint, value, now), settings = getSettings();
    if (normalized.status === 'completed' && settings.autoCleanup) {
      if (settings.cleanupTiming === 'immediate') normalized.cleanupAt = now();
      else if (settings.cleanupTiming === 'five-minutes') normalized.cleanupAt = now() + 300_000;
      else normalized.cleanupAt = null;
    }
    const file = fileFor(key, fingerprint);
    atomicWrite(file, JSON.stringify(normalized));
    clearCleanupTimer(file);
    if (normalized.status === 'completed' && settings.autoCleanup && settings.cleanupTiming === 'immediate') remove(key, fingerprint);
    else if (normalized.status === 'completed' && settings.autoCleanup && settings.cleanupTiming === 'five-minutes') scheduleCleanup(key, fingerprint, normalized.cleanupAt);
    return { saved: true, updatedAt: normalized.updatedAt };
  }

  function remove(episodeKey, sourceFingerprint) {
    const file = fileFor(safeKey(episodeKey, '회차 식별 정보'), safeHash(sourceFingerprint));
    clearCleanupTimer(file);
    let stat;
    try { stat = fsImpl.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('번역 작업 파일 형식이 올바르지 않습니다.');
    fsImpl.unlinkSync(file);
    return true;
  }

  function cleanupOnClose() {
    const settings = getSettings();
    if (!settings.autoCleanup || settings.cleanupTiming !== 'on-close') return 0;
    let removed = 0, entries = [];
    try { entries = fsImpl.readdirSync(sessionRoot, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
      const file = path.join(sessionRoot, entry.name);
      try {
        const record = readJson(file, MAX_SESSION_BYTES);
        if (record?.schema === 1 && record.status === 'completed') { fsImpl.unlinkSync(file); removed++; }
      } catch { /* Preserve unreadable work so it can be recovered manually. */ }
    }
    return removed;
  }

  function cleanupExpiredCompleted() {
    const settings = getSettings();
    if (!settings.autoCleanup) { clearAllCleanupTimers(); return 0; }
    let removed = 0, entries = [];
    try { entries = fsImpl.readdirSync(sessionRoot, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
      const file = path.join(sessionRoot, entry.name);
      try {
        const record = readJson(file, MAX_SESSION_BYTES);
        if (record?.schema !== 1 || record.status !== 'completed') continue;
        const key = safeKey(record.episodeKey, '회차 식별 정보'), fingerprint = safeHash(record.sourceFingerprint);
        if (fileFor(key, fingerprint) !== file) continue;
        const expired = settings.cleanupTiming === 'immediate' ||
          settings.cleanupTiming === 'five-minutes' && Number(record.cleanupAt) > 0 && Number(record.cleanupAt) <= now();
        if (expired && remove(key, fingerprint)) removed++;
        else if (settings.cleanupTiming === 'five-minutes' && Number(record.cleanupAt) > now()) scheduleCleanup(key, fingerprint, Number(record.cleanupAt));
      } catch { /* Preserve unreadable work so it can be recovered manually. */ }
    }
    return removed;
  }

  function revealSavedSubtitle(filePath, shell) {
    if (!shell || typeof shell.showItemInFolder !== 'function') throw new Error('파일 위치 열기를 지원하지 않습니다.');
    const candidate = path.resolve(String(filePath || ''));
    const relative = path.relative(sourceRoot, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('앱이 저장한 번역 자막만 열 수 있습니다.');
    const realRoot = fsImpl.realpathSync(sourceRoot), realFile = fsImpl.realpathSync(candidate);
    const realRelative = path.relative(realRoot, realFile);
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative) || !fsImpl.statSync(realFile).isFile()) throw new Error('번역 자막 경로가 올바르지 않습니다.');
    shell.showItemInFolder(realFile);
    return true;
  }

  return Object.freeze({ getSettings, saveSettings, load, save, remove, cleanupOnClose, cleanupExpiredCompleted, refreshCleanupTimers, revealSavedSubtitle, sessionRoot, settingsFile });
}

function registerManualTranslationSessionIpc({ ipcMain, app, shell, subtitleStore }) {
  if (!ipcMain?.handle || !app?.getPath) throw new TypeError('자막 번역 저장소 IPC 의존성이 올바르지 않습니다.');
  const store = createManualTranslationSessionStore({ userDataPath: app.getPath('userData') });
  ipcMain.handle('manual-translation:settings:get', () => store.getSettings());
  ipcMain.handle('manual-translation:settings:save', (_, value) => store.saveSettings(value));
  ipcMain.handle('manual-translation:session:get', (_, key, fingerprint) => store.load(key, fingerprint));
  ipcMain.handle('manual-translation:session:save', (_, key, fingerprint, value) => store.save(key, fingerprint, value));
  ipcMain.handle('manual-translation:session:remove', (_, key, fingerprint) => store.remove(key, fingerprint));
  ipcMain.handle('manual-translation:subtitle:reveal', (_, file) => store.revealSavedSubtitle(file, shell));
  if (subtitleStore?.list) ipcMain.handle('manual-translation:translated-exists', (_, key, sourcePath) => {
    const episodeKey = safeKey(key, '회차 식별 정보'), originalPath = String(sourcePath || '');
    if (!originalPath || originalPath.length > 16_384) return false;
    return subtitleStore.list(episodeKey).some(item => item.source === 'chatgpt' && item.from === originalPath);
  });
  if (subtitleStore?.list) ipcMain.handle('manual-translation:source:get', (_, key, file) => {
    const episodeKey = safeKey(key, '회차 식별 정보'), sourcePath = String(file || '');
    if (!sourcePath || sourcePath.length > 16_384) return null;
    return subtitleStore.list(episodeKey).find(item => item.path === sourcePath) || null;
  });
  try { store.cleanupExpiredCompleted(); } catch {}
  if (typeof app.once === 'function') app.once('before-quit', () => { try { store.cleanupOnClose(); } catch {} });
  return store;
}

module.exports = {
  MAX_SESSION_BYTES,
  createManualTranslationSessionStore,
  registerManualTranslationSessionIpc,
  sanitizeSession
};
