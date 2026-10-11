'use strict';

const fs = require('node:fs');
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
  // The embedded page is opened by user action. Experimental translation
  // may read only the newly created assistant response, not prior conversations.
  let embeddedChatGPT = null, webDriver = null;
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
      const service = getWebService();
      webDriver = createWebAutoTranslation({
        open: service.open,
        getWindow: service.getWindow,
        ...deps.webDriverOptions
      });
    }
    return webDriver;
  }
  ipcMain.handle('patch:chatgpt-web:open', () => getWebService().open());
  // Explicit clicks only. The website itself may refuse automation or change
  // its DOM; never silently fall back to scraping account data.
  ipcMain.handle('patch:chatgpt-web:translate', (_, input) => getWebDriver().run(input));
  ipcMain.handle('patch:chatgpt-web:cancel', () => webDriver?.cancel() ?? true);
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
  ipcMain.handle('patch:manual-subtitle-save', (_, input = {}) => {
    const key = String(input.key || '').trim(), text = String(input.text || '');
    if (!key || key.length > MAX_EPISODE_KEY_CHARS) throw new Error('회차 식별 정보를 확인할 수 없습니다.');
    if (text.length > MAX_TRANSLATED_VTT_CHARS || !/^WEBVTT(?:[ \t].*)?(?:\r?\n|$)/i.test(text)) {
      throw new Error('번역 결과가 유효한 WebVTT 자막이 아닙니다.');
    }
    const directory = path.join(app.getPath('userData'), 'subtitles', 'translated');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `chatgpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.vtt`);
    const descriptor = fs.openSync(file, 'wx');
    try { fs.writeFileSync(descriptor, text, 'utf8'); } finally { fs.closeSync(descriptor); }
    try {
      const saved = subtitleStore.save(key, {
        source: 'chatgpt', label: input.mode === 'web-auto' ? 'ChatGPT 웹 자동 번역 (실험)' : 'ChatGPT 수동 번역', path: file,
        from: String(input.from || ''), fromName: String(input.fromName || '원본 자막')
      });
      if (!saved) throw new Error('번역 자막을 회차에 저장하지 못했습니다.');
      return saved;
    } catch (error) {
      try { fs.unlinkSync(file); } catch {}
      throw error;
    }
  });
  return [
    'patch:translation-prompt', 'patch:clipboard-copy', 'patch:clipboard-read', 'patch:manual-subtitle-save',
    'patch:chatgpt-web:open', 'patch:chatgpt-web:translate', 'patch:chatgpt-web:cancel',
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
