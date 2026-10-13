'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_TRANSLATED_VTT_CHARS = 12_000_000;
const MAX_EPISODE_KEY_CHARS = 1200;

async function loadQuarter(provider, year, quarter, deps) {
  const { QUARTER_PROVIDERS, quarterPeriod, quarterQuery } = require('./quarter-catalog.cjs');
  const period = quarterPeriod(year, quarter);
  if (!QUARTER_PROVIDERS.includes(provider)) throw new Error('이 콘텐츠 소스는 분기별 목록을 제공하지 않습니다.');
  const data = [];

  if (provider === 'reanime') {
    const query = new URLSearchParams(quarterQuery(provider, period)).toString();
    const root = await deps.providerFetch(`${deps.REANIME_WEB}/api/v1/search?limit=100&offset=0&${query}`, {
      json: true, referer: `${deps.REANIME_WEB}/search`
    });
    data.push(...deps.reanimeItems(root).filter(item => Number(item.subbed) > 0 || Number(item.dubbed) > 0));
  } else if (provider === 'miruro') {
    let cursor;
    const candidates = [];
    for (let page = 0; page < 6 && candidates.length < 40; page++) {
      const root = await deps.miruroApi('anime', {
        ...quarterQuery(provider, period), sort: '-popularity', limit: 15, cursor
      });
      candidates.push(...(root.data || []).filter(raw => raw.status !== 'NOT_YET_RELEASED' &&
        Object.values(raw.episode_counts || {}).some(count => Number(count) > 0)));
      cursor = root.next_cursor;
      if (!root.has_more || !cursor) break;
    }
    let next = 0;
    const playable = new Set();
    await Promise.all(Array.from({ length: Math.min(6, candidates.length) }, async () => {
      while (next < candidates.length) {
        const raw = candidates[next++];
        try { if (await deps.miruroHasEpisodes(raw)) playable.add(raw.id); } catch { /* one candidate must not fail the catalog */ }
      }
    }));
    data.push(...candidates.filter(raw => playable.has(raw.id)).map(deps.miruroItem));
  } else if (provider === 'animenosub') {
    const season = quarterQuery(provider, period).season;
    const filter = new URLSearchParams({ 'season[0]': season }).toString();
    for (let page = 1; page <= 3; page++) {
      const url = `${deps.ANIMENOSUB_WEB}/anime/?${page > 1 ? `page=${page}&` : ''}${filter}&order=popular`;
      const $ = deps.cheerio.load(await deps.providerFetch(url, { referer: `${deps.ANIMENOSUB_WEB}/` }));
      const cards = $('article.bs');
      const html = cards.filter((_, node) => !/upcoming/i.test($(node).find('.ans-status-ribbon').text()))
        .map((_, node) => $.html(node)).get().join('');
      const items = deps.animenosubList(html);
      for (const item of items) {
        const key = String(item.mal_id || item.id || item.url || '');
        if (key && !data.some(known => String(known.mal_id || known.id || known.url || '') === key)) data.push(item);
      }
      if (!cards.length) break;
    }
  }
  return { data, label: period.label, year: period.year, quarter: period.quarter };
}

function registerPatch01Handlers(deps) {
  const { ipcMain } = deps || {};
  if (!ipcMain?.handle) throw new TypeError('Patch 01 IPC 의존성이 올바르지 않습니다.');
  const { fetchWeekdayEpisodes } = require('./weekday-episodes.cjs');
  const quarterDeps = {
    providerFetch: deps.providerFetch, REANIME_WEB: deps.REANIME_WEB, ANIMENOSUB_WEB: deps.ANIMENOSUB_WEB,
    reanimeItems: deps.reanimeItems, miruroApi: deps.miruroApi, miruroItem: deps.miruroItem,
    miruroHasEpisodes: deps.miruroHasEpisodes, animenosubList: deps.animenosubList, cheerio: deps.cheerio
  };
  ipcMain.handle('patch:quarter', (_, provider, year, quarter) => loadQuarter(String(provider || ''), year, quarter, quarterDeps));
  ipcMain.handle('patch:weekday-episodes', (_, provider, candidates, refresh) =>
    fetchWeekdayEpisodes(String(provider || ''), candidates, { refresh: refresh === true }));
  return ['patch:quarter', 'patch:weekday-episodes'];
}

function registerPatch02Handlers(deps) {
  const { ipcMain, app, subtitleStore, clipboard } = deps || {};
  if (!ipcMain?.handle || !app?.getPath || !subtitleStore?.save || !clipboard?.writeText) {
    throw new TypeError('Patch 02 IPC 의존성이 올바르지 않습니다.');
  }
  const { loadTranslationPrompt } = require('./patch-manager-stage2-prompts.cjs');
  const { registerManualTranslationSessionIpc } = require('./manual-translation-session.cjs');
  registerManualTranslationSessionIpc({ ipcMain, app, shell: deps.shell || require('electron').shell, subtitleStore });
  // The embedded page is opened only by explicit user action. The Patch 02
  // driver is bound to that isolated window and never reads cookies or storage.
  let embeddedChatGPT = null, webDriver = null, backgroundTranslation = null;
  function getWebService() {
    if (!embeddedChatGPT) {
      const native = deps.electron || require('electron');
      const { createEmbeddedChatGPTBrowser } = require('./embedded-chatgpt-web.cjs');
      embeddedChatGPT = createEmbeddedChatGPTBrowser({
        BrowserWindow: deps.BrowserWindow || native.BrowserWindow,
        shell: deps.shell || native.shell
      });
    }
    return embeddedChatGPT;
  }
  function getWebDriver() {
    if (!webDriver) {
      const { createWebAutoTranslation } = require('./chatgpt-web-ui-driver.cjs');
      webDriver = createWebAutoTranslation({ getWindow: () => getWebService().getWindow() });
    }
    return webDriver;
  }
  function saveManualSubtitle(input = {}) {
    const key = String(input.key || '').trim(), text = String(input.text || '');
    if (!key || key.length > MAX_EPISODE_KEY_CHARS) throw new Error('회차 식별 정보를 확인할 수 없습니다.');
    if (text.length > MAX_TRANSLATED_VTT_CHARS || !/^WEBVTT(?:[ \t].*)?(?:\r?\n|$)/i.test(text)) {
      throw new Error('번역 결과가 유효한 WebVTT 자막이 아닙니다.');
    }
    const deterministicName = input.mode === 'web-auto' && /^[a-zA-Z0-9_-]{8,96}$/.test(String(input.jobKey || ''))
      ? `chatgpt_web_${input.jobKey}.vtt` : '';
    const directory = path.join(app.getPath('userData'), 'subtitles', 'translated');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, deterministicName || `chatgpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.vtt`);
    const existing = deterministicName && subtitleStore.list?.(key)?.find(item => item.path === file && item.source === 'chatgpt');
    if (existing) return existing;
    if (fs.existsSync(file)) {
      if (fs.readFileSync(file, 'utf8') !== text) throw new Error('이전 저장 결과와 다른 번역 내용이 발견되어 기존 파일을 덮어쓰지 않았습니다.');
    } else {
      let descriptor;
      try {
        descriptor = fs.openSync(file, 'wx');
        fs.writeFileSync(descriptor, text, 'utf8');
        try { fs.fsyncSync(descriptor); } catch {}
        fs.closeSync(descriptor); descriptor = undefined;
      } catch (error) {
        if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
        try { fs.unlinkSync(file); } catch {}
        throw error;
      }
    }
    try {
      const mode = input.mode === 'web-auto' ? 'web-auto' : 'manual';
      const label = mode === 'web-auto' ? 'ChatGPT 웹 자동 번역' : 'ChatGPT 수동 번역';
      const saved = subtitleStore.save(key, {
        source: 'chatgpt', label, path: file,
        from: String(input.from || ''), fromName: String(input.fromName || '원본 자막')
      });
      if (!saved) throw new Error('번역 자막을 회차에 저장하지 못했습니다.');
      return saved;
    } catch (error) {
      try { fs.unlinkSync(file); } catch {}
      throw error;
    }
  }
  function getBackgroundTranslation() {
    if (!backgroundTranslation) {
      const native = deps.electron || require('electron');
      const { createChatGPTBackgroundTranslation } = require('./chatgpt-background-translation.cjs');
      backgroundTranslation = createChatGPTBackgroundTranslation({
        app, driver: getWebDriver(), getWindow: () => getWebService().getWindow(),
        saveSubtitle: saveManualSubtitle, Notification: native.Notification
      });
    }
    return backgroundTranslation;
  }
  ipcMain.handle('patch:chatgpt-web:open', () => getWebService().open());
  ipcMain.handle('patch:chatgpt-web:translate', async (_, input) => {
    try { return await getWebDriver().run(input); }
    catch (error) {
      return {
        ok: false,
        code: typeof error?.code === 'string' ? error.code : 'CHATGPT_WEB_FAILED',
        error: String(error?.message || 'ChatGPT 웹 번역에 실패했습니다.').slice(0, 1000),
        sent: error?.sent === true
      };
    }
  });
  ipcMain.handle('patch:chatgpt-web:translate-file', async (_, input = {}) => {
    let tempDir = '';
    try {
      const jobKey = String(input.jobKey || ''), prompt = String(input.prompt || ''), content = String(input.content || '');
      if (!/^[a-zA-Z0-9_-]{8,96}$/.test(jobKey)) throw new Error('번역 작업 식별자가 올바르지 않습니다.');
      if (!prompt.trim() || prompt.length > 120_000) throw new Error('번역 지침이 비어 있거나 크기 제한을 넘었습니다.');
      const bytes = Buffer.byteLength(content, 'utf8');
      if (!content.trim() || content.includes('\0') || bytes > 12_000_000 || !/\d{1,}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,}:\d{2}:\d{2}[,.]\d{1,3}/.test(content))
        throw new Error('첨부할 전체 SRT 파일이 비어 있거나 올바른 자막 파일이 아닙니다.');
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-chatgpt-whole-'));
      const fileName = 'subtitle-to-translate.srt', filePath = path.join(tempDir, fileName);
      fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' });
      return await getWebDriver().runFile({ jobKey, prompt, fileName, filePath, tempDir });
    } catch (error) {
      return {
        ok: false,
        code: typeof error?.code === 'string' ? error.code : 'CHATGPT_WEB_FAILED',
        error: String(error?.message || 'ChatGPT 전체 자막 파일 번역에 실패했습니다.').slice(0, 1000),
        sent: error?.sent === true,
        attached: error?.attached === true
      };
    } finally {
      if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });
  ipcMain.handle('patch:chatgpt-web:cancel', (_, jobKey) => webDriver?.cancel(String(jobKey || '')) ?? { cancelled: false, sent: false });
  ipcMain.handle('patch:chatgpt-web:background:start', (event, input = {}) => getBackgroundTranslation().start(input, event?.sender));
  ipcMain.handle('patch:chatgpt-web:background:status', (_, jobKey) => getBackgroundTranslation().getStatus(String(jobKey || '')));
  ipcMain.handle('patch:chatgpt-web:background:cancel', (_, jobKey) => getBackgroundTranslation().cancel(String(jobKey || '')));
  ipcMain.handle('patch:chatgpt-web:background:acknowledge', (_, jobKey, confirmed) => getBackgroundTranslation().acknowledge(String(jobKey || ''), confirmed === true));
  ipcMain.handle('patch:chatgpt-web:background:discard', (_, jobKey) => getBackgroundTranslation().discard(String(jobKey || '')));
  ipcMain.handle('patch:translation-prompt', (_, language) => loadTranslationPrompt(String(language || '')));
  ipcMain.handle('patch:clipboard-copy', (_, value) => {
    const text = String(value ?? '');
    if (!text.trim() || text.length > 2_000_000) throw new Error('복사할 내용이 비어 있거나 너무 큽니다.');
    clipboard.writeText(text);
    return true;
  });
  // Clipboard access is opt-in: the renderer invokes this only after a user clicks Import.
  // Never observe the clipboard in the background or access any ChatGPT browser session.
  ipcMain.handle('patch:clipboard-read', () => {
    if (typeof clipboard.readText !== 'function') throw new Error('이 환경에서는 클립보드를 읽을 수 없습니다.');
    const text = clipboard.readText();
    if (!text.trim()) throw new Error('클립보드가 비어 있습니다. ChatGPT 번역 결과를 먼저 복사해 주세요.');
    if (text.length > 2_000_000) throw new Error('클립보드 내용이 너무 큽니다. 번역 결과 JSON만 복사해 주세요.');
    return text;
  });
  ipcMain.handle('patch:manual-subtitle-save', (_, input = {}) => saveManualSubtitle(input));
  return [
    'patch:translation-prompt', 'patch:clipboard-copy', 'patch:clipboard-read', 'patch:manual-subtitle-save',
    'patch:chatgpt-web:open', 'patch:chatgpt-web:translate', 'patch:chatgpt-web:translate-file', 'patch:chatgpt-web:cancel',
    'patch:chatgpt-web:background:start', 'patch:chatgpt-web:background:status', 'patch:chatgpt-web:background:cancel',
    'patch:chatgpt-web:background:acknowledge', 'patch:chatgpt-web:background:discard',
    'manual-translation:settings:get', 'manual-translation:settings:save',
    'manual-translation:session:get', 'manual-translation:session:save', 'manual-translation:session:remove',
    'manual-translation:translated-exists', 'manual-translation:subtitle:reveal', 'manual-translation:source:get'
  ];
}

function registerPatch0102Handlers(deps, patches = { 'patch-01': true, 'patch-02': true }) {
  if (!patches || typeof patches !== 'object' || Array.isArray(patches) ||
      Object.keys(patches).length !== 2 || typeof patches['patch-01'] !== 'boolean' || typeof patches['patch-02'] !== 'boolean') {
    throw new TypeError('Patch 01·02 선택 설정이 올바르지 않습니다.');
  }
  const registered = [];
  if (patches['patch-01']) registered.push(...registerPatch01Handlers(deps));
  if (patches['patch-02']) registered.push(...registerPatch02Handlers(deps));
  return { registered };
}

module.exports = {
  MAX_EPISODE_KEY_CHARS,
  MAX_TRANSLATED_VTT_CHARS,
  loadQuarter,
  registerPatch01Handlers,
  registerPatch02Handlers,
  registerPatch0102Handlers
};
