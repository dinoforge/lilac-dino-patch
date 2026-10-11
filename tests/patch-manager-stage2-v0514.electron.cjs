// Isolated renderer worker. Run the parent cleanup wrapper:
// $env:LILAC_UPSTREAM_SOURCE='<temporary official v0.5.14 clone>'; node tests/run-patch-manager-stage2-v0514-electron.cjs
'use strict';

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const upstreamRoot = process.env.LILAC_UPSTREAM_SOURCE || '';
if (!upstreamRoot || !fs.existsSync(path.join(upstreamRoot, '.git'))) {
  throw new Error('Set LILAC_UPSTREAM_SOURCE to the isolated official v0.5.14 clone.');
}

const repo = path.resolve(__dirname, '..');
const { makeLilacAnimeV0514Manifest } = require(path.join(repo, 'patch-manager', 'adapters', 'lilacanime-v0.5.14.cjs'));
const { applyPersistent } = require(path.join(repo, 'patch-manager', 'persistent.cjs'));
const { cleanupSyntheticFixture } = require(path.join(repo, 'patch-manager', 'staging.cjs'));
const orchestratedTempRoot = process.env.LILAC_STAGE2_ELECTRON_TEMP_ROOT || '';
const tempRoot = orchestratedTempRoot ? path.resolve(orchestratedTempRoot) : fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-patch-stage2-electron-'));
if (path.dirname(tempRoot) !== fs.realpathSync(os.tmpdir()) || !path.basename(tempRoot).startsWith('lilac-patch-stage2-electron-')) {
  throw new Error('Refusing unexpected UI test temp root: ' + tempRoot);
}
const fixtureRoot = path.join(tempRoot, 'app');
const userData = path.join(tempRoot, 'userData');
const sessionData = path.join(tempRoot, 'sessionData');
const cachePath = path.join(tempRoot, 'cache');
const blockedRequests = [];
const providerCalls = [];
const patchCalls = [];
const savedTranslations = [];
const savedSubtitleEntries = [];
const copiedTexts = [];
const embeddedWindows = [];
const revealedFiles = [];
let win = null;
let finished = false;
const rendererErrors = [];

class MockEmbeddedChatGPTWindow {
  constructor(options) {
    this.options = options;
    this.loaded = [];
    this.destroyed = false;
    this.webContents = {
      session: { setPermissionRequestHandler() {} },
      on() {},
      setWindowOpenHandler() {}
    };
    embeddedWindows.push(this);
  }
  on() {}
  async loadURL(url) { this.loaded.push(url); }
  isDestroyed() { return this.destroyed; }
  show() {}
  focus() {}
  destroy() { this.destroyed = true; }
}

function fail(error) {
  if (finished) return;
  finished = true;
  process.exitCode = 1;
  console.error(error?.stack || error);
  if (rendererErrors.length) console.error(`Renderer errors:\n${rendererErrors.join('\n')}`);
  try { win?.destroy(); } catch {}
  app.exit(1);
}

function listTrackedFiles(root) {
  const result = require('node:child_process').spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'buffer' });
  if (result.status !== 0) throw new Error(`Cannot enumerate source fixture: ${result.stderr.toString('utf8')}`);
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function makeFixture() {
  const temp = fs.realpathSync(os.tmpdir()), source = fs.realpathSync(upstreamRoot);
  const relative = path.relative(temp, source);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'source clone must stay under OS temp');
  fs.mkdirSync(fixtureRoot);
  const files = listTrackedFiles(source);
  for (const file of files) {
    const from = path.join(source, ...file.split('/'));
    const stat = fs.lstatSync(from);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `unsupported source entry: ${file}`);
    const to = path.join(fixtureRoot, ...file.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  }
  const marker = { root: path.basename(fixtureRoot), kind: 'synthetic', safety: 'no-real-installation', nonce: crypto.randomBytes(16).toString('hex') };
  fs.writeFileSync(`${fixtureRoot}.lilac-patch-manager-synthetic-fixture.json`, JSON.stringify(marker), { flag: 'wx' });
  fs.writeFileSync(path.join(fixtureRoot, '.lilac-patch-manager-synthetic-fixture.json'), JSON.stringify(marker), { flag: 'wx' });
  const applied = applyPersistent(fixtureRoot, makeLilacAnimeV0514Manifest());
  assert.equal(applied.status, 'applied');
}

function anime(provider, id, extra = {}) {
  return {
    provider, id, mal_id: `${provider}:${id}`, title: '시범 방영작', title_english: 'Synthetic Airing Work',
    anilistId: 777, malId: 9001, year: 2026, type: 'TV', subbed: 3, availableEpisodeCount: 3,
    ...extra
  };
}

function fakeCheerio() {
  return {
    load(source) {
      const nodes = String(source).includes('page=2') ? [] : [{
        status: 'Ongoing', html: '<article-fixture>Current</article-fixture>'
      }, { status: 'Upcoming', html: '<article-upcoming>Upcoming</article-upcoming>' }];
      const collection = values => ({
        length: values.length,
        filter(callback) { return collection(values.filter((node, index) => callback(index, node))); },
        map(callback) { return { get: () => values.map((node, index) => callback(index, node)) }; }
      });
      const $ = value => typeof value === 'string'
        ? collection(value === 'article.bs' ? nodes : [])
        : { find: () => ({ text: () => value.status }) };
      $.html = node => node.html;
      return $;
    }
  };
}

function writeHarness() {
  const htmlPath = path.join(fixtureRoot, 'src', 'patch-manager-stage2-harness.html');
  const preloadPath = path.join(fixtureRoot, 'patch-manager-stage2-harness-preload.cjs');
  const subtitlePathValue = JSON.stringify(path.join(userData, 'source-ja.vtt'));
  const subtitleUrlValue = JSON.stringify(pathToFileURL(path.join(userData, 'source-ja.vtt')).href);
  const scripts = [
    'patch-manager-stage2-core.js', 'weekday-schedule.js', 'integrated-search.js',
    'manual-subtitle-translation.js', 'patch-manager-stage2.js'
  ];
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{--bg:#101016;--panel:#1a1a24;--text:#f4f2fa;--muted:#aaa5b8;--line:#383342;--lilac:#b48cff;--ott-radius:10px}
    body{background:var(--bg);color:var(--text);font:14px Arial,sans-serif;margin:20px}.hidden{display:none!important}
    .content-section{margin:20px 0}.section-title{display:flex;gap:10px}.chip-row{display:flex;gap:6px}.chip-row button{padding:7px 12px}
    .poster-rail{display:flex;gap:10px;min-height:56px}.anime-card{border:1px solid var(--line);padding:10px;min-width:150px;cursor:pointer}
    #detailDialog{background:var(--panel);color:var(--text);border:1px solid var(--line);min-width:420px}
  </style></head><body>
    <section id="seasonSection" class="content-section"><div class="section-title"><h2 id="seasonTitle">신작</h2></div><div id="seasonRail" class="poster-rail"><p>기존 시즌 카드</p></div></section>
    <section id="scheduleSection" class="content-section hidden"><div class="section-title"><h2>방영 일정</h2></div><div id="scheduleTabs" class="chip-row" role="tablist"></div><div id="scheduleRail" class="poster-rail"></div></section>
    <dialog id="detailDialog"><div id="detailContent"><div id="episodeBlock"></div></div></dialog>
    <section data-settings-pane="translate"><div id="jimakuTranslateChoices" class="choice-row"><button type="button" data-value="off">끄기</button><button type="button" data-value="cloud">번역 API</button><button type="button" data-value="local">로컬 AI</button></div></section>
    <div id="subtitleTranslateRow"></div><p id="subtitleState"></p><input id="skipTitle" value="시범 방영작"><input id="skipEpisode" value="2"><p id="playerTitle">시범 방영작</p>
    <script>
      const knownAnime=new Map(); let currentSubtitle={path:${subtitlePathValue},src:${subtitleUrlValue},label:'Japanese'};
      let currentSubtitlePath='',playbackRequestId=1,currentPlaybackContext={subtitleTitle:'시범 방영작',episode:{number:2}};
      window.patchFixtureState={episodeSelected:false,errors:[]};
      window.patchFixtureState.confirmMessages=[];window.confirm=message=>{window.patchFixtureState.confirmMessages.push(String(message));return false};
      window.addEventListener('error',event=>window.patchFixtureState.errors.push({stack:event.error?.stack||'',message:event.message||''}));
      window.addEventListener('unhandledrejection',event=>window.patchFixtureState.errors.push({stack:event.reason?.stack||'',message:String(event.reason)}));
      function subtitleStoreKey(){return 'synthetic-show|season-1|episode-2'}
      function attachSubtitle(src,label,meta){currentSubtitle={src,path:meta.path,label,...meta};currentSubtitlePath=meta.path}
      function clearSubtitle(){currentSubtitle=null;currentSubtitlePath=''}
      function animeById(id){return knownAnime.get(String(id))||null}
      function renderCards(target,items){const rail=document.querySelector(target);if(!rail)return;rail.replaceChildren(...items.map(item=>{const card=document.createElement('article');card.className='anime-card';card.tabIndex=0;const title=document.createElement('h3');title.textContent=item.title||'제목 없음';const info=document.createElement('p');info.textContent=item.title_english||'';card.append(title,info);return card}))}
      async function openDetail(id){const item=animeById(id);const dialog=document.querySelector('#detailDialog'),content=document.querySelector('#detailContent');content.replaceChildren();const title=document.createElement('h2');title.textContent=item?.title||'상세';const block=document.createElement('div');block.id='episodeBlock';const episode=document.createElement('button');episode.className='fixture-episode';episode.textContent='2화';episode.addEventListener('click',()=>window.patchFixtureState.episodeSelected=true);block.append(episode);content.append(title,block);dialog.setAttribute('open','');return true}
    </script>
    ${scripts.map(file => `<script src="${file}"></script>`).join('\n')}
  </body></html>`;
  fs.writeFileSync(htmlPath, html, 'utf8');
  const preload = `'use strict';\nconst {contextBridge,ipcRenderer}=require('electron');\ncontextBridge.exposeInMainWorld('lilac',{
    patchQuarter:(...args)=>ipcRenderer.invoke('patch:quarter',...args),
    patchWeekdayEpisodes:(...args)=>ipcRenderer.invoke('fixture:weekday-episodes',...args),
    patchTranslationPrompt:(...args)=>ipcRenderer.invoke('patch:translation-prompt',...args),
    patchCopyText:(...args)=>ipcRenderer.invoke('patch:clipboard-copy',...args),
    patchOpenChatGPTEmbedded:(...args)=>ipcRenderer.invoke('patch:chatgpt-web:open',...args),
    patchSaveManualSubtitle:(...args)=>ipcRenderer.invoke('patch:manual-subtitle-save',...args),
    patchManualTranslationSettings:(...args)=>ipcRenderer.invoke('manual-translation:settings:get',...args),
    patchSaveManualTranslationSettings:(...args)=>ipcRenderer.invoke('manual-translation:settings:save',...args),
    patchManualTranslationSession:(...args)=>ipcRenderer.invoke('manual-translation:session:get',...args),
    patchSaveManualTranslationSession:(...args)=>ipcRenderer.invoke('manual-translation:session:save',...args),
    patchRemoveManualTranslationSession:(...args)=>ipcRenderer.invoke('manual-translation:session:remove',...args),
    patchHasManualTranslationForSource:(...args)=>ipcRenderer.invoke('manual-translation:translated-exists',...args),
    patchRevealManualSubtitle:(...args)=>ipcRenderer.invoke('manual-translation:subtitle:reveal',...args),
    patchManualTranslationSource:(...args)=>ipcRenderer.invoke('manual-translation:source:get',...args),
    openExternal:(...args)=>ipcRenderer.invoke('fixture:external',...args),
    linkkfSchedule:(...args)=>ipcRenderer.invoke('fixture:linkkf-schedule',...args),
    providerAiring:(...args)=>ipcRenderer.invoke('fixture:provider-airing',...args),
    providerCatalog:(...args)=>ipcRenderer.invoke('fixture:provider-catalog',...args),
    catalogKoreanSearch:(...args)=>ipcRenderer.invoke('fixture:korean-search',...args),
    linkkfSearch:(...args)=>ipcRenderer.invoke('fixture:linkkf-search',...args),
    linkkfEpisodes:(...args)=>ipcRenderer.invoke('fixture:linkkf-episodes',...args),
    providerDetail:(...args)=>ipcRenderer.invoke('fixture:provider-detail',...args)
});\n`;
  fs.writeFileSync(preloadPath, preload, 'utf8');
  return { htmlPath, preloadPath };
}

function waitFor(label, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      try { if (await predicate()) return resolve(); }
      catch (error) {
        win?.webContents.executeJavaScript('window.patchFixtureState?.errors || null').then(value => console.error('renderer debug state:', JSON.stringify(value))).catch(() => {});
        return reject(new Error(`${label}: ${error?.stack || error}`));
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function run() {
  const sourcePath = path.join(userData, 'source-ja.vtt'), episodeKey = 'synthetic-show|season-1|episode-2';
  const sourceVtt = `WEBVTT\n\n${Array.from({ length: 30 }, (_, index) => `00:00:${String(index + 1).padStart(2, '0')}.000 --> 00:00:${String(index + 1).padStart(2, '0')}.800\n日本語の台詞 ${index + 1}`).join('\n\n')}\n`;
  fs.writeFileSync(sourcePath, sourceVtt);
  savedSubtitleEntries.push({ key: episodeKey, source: 'reanime', label: 'Japanese', path: sourcePath, url: pathToFileURL(sourcePath).href });
  const { loadTranslationPrompt } = require(path.join(fixtureRoot, 'electron', 'patch-manager-stage2-prompts.cjs'));
  const { registerPatch0102Handlers } = require(path.join(fixtureRoot, 'electron', 'patch-manager-stage2.cjs'));
  const quarterShow = anime('reanime', 're-quarter');
  const quarterMiruro = anime('miruro', 'mi-quarter');
  const quarterAnimenosub = anime('animenosub', 'as-quarter');
  const quarterMovie = anime('miruro', 'mi-film', { title: '시범 방영작', title_english: 'Synthetic Airing Work', anilistId: 778, type: 'MOVIE', season: 'MOVIE' });
  const sourceItems = Object.fromEntries([
    anime('reanime', 're-source'), anime('miruro', 'mi-source'),
    anime('animenosub', 'as-source'), anime('linkkf', 'lk-source')
  ].map(item => [item.provider, item]));
  const linkkfAnime = anime('linkkf', 'lk-schedule');
  const today = new Date(); today.setHours(20, 0, 0, 0);

  registerPatch0102Handlers({
    ipcMain, app,
    electron: { BrowserWindow: MockEmbeddedChatGPTWindow },
    shell: { showItemInFolder: file => revealedFiles.push(file) },
    subtitleStore: {
      list: key => savedSubtitleEntries.filter(item => item.key === key),
      save: (key, value) => { const saved = { id: `synthetic-${savedTranslations.length + 1}`, key, ...value, url: pathToFileURL(value.path).href }; savedTranslations.push(saved); savedSubtitleEntries.unshift(saved); return saved; }
    },
    clipboard: { writeText: text => { copiedTexts.push(String(text)); } },
    REANIME_WEB: 'https://reanime.invalid', ANIMENOSUB_WEB: 'https://animenosub.invalid',
    providerFetch: async (url, options = {}) => {
      providerCalls.push({ url, kind: options.json ? 'reanime' : 'animenosub' });
      return options.json ? { rows: [quarterShow] } : url;
    },
    reanimeItems: root => root.rows,
    miruroApi: async () => ({ data: [
      { id: 'mi-quarter', status: 'RELEASING', episode_counts: { sub: 12 } },
      { id: 'mi-film', status: 'RELEASING', episode_counts: { sub: 1 } }
    ], has_more: false }),
    miruroHasEpisodes: async () => true,
    miruroItem: raw => raw.id === 'mi-film' ? quarterMovie : quarterMiruro,
    animenosubList: html => html.includes('article-fixture') ? [quarterAnimenosub] : [],
    cheerio: fakeCheerio()
  });

  ipcMain.handle('fixture:weekday-episodes', (_event, provider, candidates) => {
    patchCalls.push({ provider, candidates: candidates.length });
    const target = candidates.find(item => item.provider === provider);
    return { supported: true, data: target ? [{ provider, anime: target, episode: 2, airingAt: Math.floor(today.getTime() / 1000) }] : [] };
  });
  ipcMain.handle('fixture:linkkf-schedule', () => Array.from({ length: 7 }, (_, day) => day === (new Date().getDay() + 6) % 7 ? [linkkfAnime] : []));
  ipcMain.handle('fixture:provider-airing', () => ({ data: [] }));
  ipcMain.handle('fixture:provider-catalog', (_event, provider) => {
    if (provider === 'ohli24') return [];
    return sourceItems[provider] ? [{ ...sourceItems[provider] }] : [];
  });
  ipcMain.handle('fixture:korean-search', (_event, provider) => sourceItems[provider] ? [{ ...sourceItems[provider] }] : []);
  ipcMain.handle('fixture:linkkf-search', () => [{ ...sourceItems.linkkf }]);
  ipcMain.handle('fixture:linkkf-episodes', () => [{ episodes: [{ id: 'lk-ep-2', number: 2, title: '2화' }] }]);
  ipcMain.handle('fixture:provider-detail', (_event, item) => ({ data: item, episodes: [{ id: `${item.provider}-ep-2`, number: 2, title: '2화', playable: false }] }));
  ipcMain.handle('fixture:external', () => true);

  const realPromptHandler = loadTranslationPrompt;
  assert.equal(typeof realPromptHandler('japanese'), 'string');

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/i.test(details.url)) { blockedRequests.push(details.url); callback({ cancel: true }); }
    else callback({});
  });
  session.defaultSession.setSpellCheckerEnabled(false);
  const { htmlPath, preloadPath } = writeHarness();
  win = new BrowserWindow({
    show: false, width: 1280, height: 720,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(`render-process-gone:${details.reason}`));
  win.webContents.on('console-message', event => { if (event.level >= 2) rendererErrors.push(event.message); });
  win.webContents.on('did-fail-load', (_event, code, description, url) => rendererErrors.push(`did-fail-load:${code}:${description}:${url}`));
  await win.loadFile(htmlPath);
  console.log('fixture renderer loaded');
  await waitFor('quarter catalog and weekday cards', async () => win.webContents.executeJavaScript(
    `Boolean(document.querySelector('#patch0102QuarterControls') && document.querySelectorAll('#seasonRail .anime-card').length===2 && document.querySelectorAll('#scheduleRail .anime-card').length===1)`
  ));
  console.log('quarter and weekday fixture rendered');
  const accountStatus = await win.webContents.executeJavaScript("document.querySelector('#patch0102ChatGPTAccountState').textContent");
  assert.match(accountStatus, /브라우저 로그인은 사용자가 직접 합니다/);
  const chatGPTModes = await win.webContents.executeJavaScript(`(()=>{const choice=document.querySelector('#patch0102ChatGPTAutoUnavailable');const manual=document.querySelector('#patch0102ChatGPTManual');const auto=document.querySelector('#patch0102ChatGPTAutoStart');const deletion=document.querySelector('#patch0102ChatGPTDeleteUnavailable');return {choiceDisabled:choice?.disabled===true,choiceInAutoModes:choice?.parentElement?.id==='jimakuTranslateChoices',choiceHasNoPersistedValue:!choice?.hasAttribute('data-value'),translationModes:[...document.querySelectorAll('#jimakuTranslateChoices button[data-value]')].map(button=>button.dataset.value),manualEnabled:manual?.disabled===false,autoEnabled:auto?.disabled===false,deletionDisabled:deletion?.disabled===true,reason:document.querySelector('#patch0102ChatGPTAutoReason')?.textContent||''}})()`);
  assert.equal(chatGPTModes.choiceDisabled, false);
  assert.equal(chatGPTModes.choiceInAutoModes, true);
  assert.equal(chatGPTModes.choiceHasNoPersistedValue, true, 'unsupported choice cannot overwrite the existing off/cloud/local setting');
  assert.deepEqual(chatGPTModes.translationModes, ['off', 'cloud', 'local']);
  assert.equal(chatGPTModes.manualEnabled, true);
  assert.equal(chatGPTModes.autoEnabled, true);
  assert.equal(chatGPTModes.deletionDisabled, true);
  assert.match(chatGPTModes.reason, /자동 전송하거나 응답을 자동 수집하는 기능은 지원하지 않습니다/);

  const overview = await win.webContents.executeJavaScript(`({
    quarterTitle:document.querySelector('#seasonTitle').textContent,
    quarterCards:[...document.querySelectorAll('#seasonRail .anime-card')].map(x=>x.innerText),
    days:[...document.querySelectorAll('#scheduleTabs button')].map((x,i)=>({label:x.textContent,selected:x.getAttribute('aria-selected'),today:x.dataset.today==='true',i})),
    scheduleCards:[...document.querySelectorAll('#scheduleRail .anime-card')].map(x=>x.innerText),
    autoPlay:localStorage.getItem('playerAutoPlay')
  })`);
  assert.match(overview.quarterTitle, /년 [1-4]분기 신작/);
  assert.equal(overview.quarterCards.length, 2, 'the sequel and movie stay separate');
  assert.ok(overview.quarterCards.some(text => text.includes('3개 출처')));
  assert.equal(overview.days.filter(day => day.selected === 'true').length, 1);
  assert.ok(overview.days.find(day => day.i === (new Date().getDay() + 6) % 7)?.today);
  assert.equal(overview.scheduleCards.length, 1);
  assert.equal(overview.autoPlay, 'false', 'fresh profiles keep next-episode autoplay off');

  await win.webContents.executeJavaScript(`document.querySelector('#scheduleRail .anime-card').click()`);
  console.log('weekday card clicked; checking five providers');
  await waitFor('all five automatic provider rows', async () => win.webContents.executeJavaScript(
    `document.querySelectorAll('#patch0102SourcePicker .patch0102-source-rows>*').length===5 && ![...document.querySelectorAll('#patch0102SourcePicker small')].some(x=>x.textContent==='확인 중')`
  ));
  const sourceStatus = await win.webContents.executeJavaScript(`({
    rows:[...document.querySelectorAll('#patch0102SourcePicker .patch0102-source-rows>*')].map(x=>({provider:x.dataset.provider||x.textContent.split(' ')[0],text:x.innerText})),
    note:document.querySelector('#patch0102SourcePicker>small')?.textContent||''
  })`);
  console.log('provider rows:', JSON.stringify(sourceStatus));
  assert.equal(sourceStatus.rows.length, 5);
  assert.ok(sourceStatus.rows.some(row => row.text.includes('애니24') && row.text.includes('미제공')));
  assert.ok(sourceStatus.rows.filter(row => row.text.includes('제공 확인')).length >= 3);
  assert.match(sourceStatus.note, /실제 영상 주소 검증은 아직 하지 않았습니다/);
  const sourceClick = await win.webContents.executeJavaScript(`(()=>{const button=document.querySelector('#patch0102SourcePicker button[data-provider="reanime"]');if(!button)throw new Error('Re:Anime source button missing');button.click();return {clicked:true,title:document.querySelector('#detailContent h2')?.textContent}})()`);
  console.log('source selection click:', JSON.stringify(sourceClick));
  await waitFor('selected source remains visible in updated detail', async () => win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('#patch0102SourcePicker button')).some(button=>button.dataset.provider==='reanime'&&button.getAttribute('aria-pressed')==='true')`
  ));
  assert.ok(patchCalls.some(call => call.provider === 'reanime') && patchCalls.some(call => call.provider === 'miruro'));
  assert.ok(providerCalls.some(call => call.kind === 'reanime') && providerCalls.some(call => call.kind === 'animenosub'));

  await win.webContents.executeJavaScript(`document.querySelector('#patch0102WebAutoStart').click()`);
  console.log('experimental request preparation clicked');
  await waitFor('experimental Japanese request prepared in the manual translation panel', async () => win.webContents.executeJavaScript(
    `Boolean(document.querySelector('#patch0102ManualPanel') && !document.querySelector('#patch0102ManualPanel').classList.contains('hidden'))`
  ));
  await waitFor('experimental request copied and the isolated embedded window opened', () =>
    copiedTexts.length === 1 && embeddedWindows.length === 1 && embeddedWindows[0].loaded.length === 1);
  assert.match(copiedTexts[0], /일본어/);
  assert.deepEqual(embeddedWindows[0].loaded, ['https://chatgpt.com/']);
  assert.equal(embeddedWindows[0].options.webPreferences.partition, 'persist:dino-lilac-chatgpt-web');
  assert.equal(embeddedWindows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(embeddedWindows[0].options.webPreferences.sandbox, true);
  assert.equal(blockedRequests.length, 0, 'the mock embedded window made no ChatGPT network request');
  await win.webContents.executeJavaScript(`document.querySelector('#patch0102WebAutoStart').click()`);
  await waitFor('uncertain experimental batch is held without duplicate preparation', async () => win.webContents.executeJavaScript(
    `document.querySelector('#patch0102ManualStatus').textContent.includes('중복 전송을 막기 위해 새 요청 준비를 보류했습니다')`
  ));
  assert.equal(copiedTexts.length, 1, 'an uncertain batch is not copied or sent again automatically');
  const expectedPrompt = realPromptHandler('japanese');
  assert.ok(copiedTexts[0].includes(expectedPrompt));
  assert.ok(copiedTexts[0].includes('앞 문맥') || copiedTexts[0].includes('작품·회차'));
  const firstResponse = JSON.stringify({ translations: Array.from({ length: 24 }, (_, index) => ({ id: index + 1, text: `한국어 번역 ${index + 1}` })) });
  await win.webContents.executeJavaScript(`document.querySelector('#patch0102ManualAnswer').value=${JSON.stringify(firstResponse)};document.querySelector('#patch0102ManualAnswer').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#patch0102ManualApply').click()`);
  await waitFor('validated cue count and current batch progress', async () => win.webContents.executeJavaScript("document.querySelector('#patch0102ManualProgress').textContent.startsWith('24/30문장 (80%) · 묶음 2/2 · 일본어')"));
  const lastResponse = JSON.stringify({ translations: Array.from({ length: 6 }, (_, index) => ({ id: index + 25, text: `한국어 번역 ${index + 25}` })) });
  await win.webContents.executeJavaScript(`document.querySelector('#patch0102ManualCopy').click()`);
  await waitFor('second ChatGPT request copied', () => copiedTexts.length === 2);
  await win.webContents.executeJavaScript(`document.querySelector('#patch0102ManualAnswer').value=${JSON.stringify(lastResponse)};document.querySelector('#patch0102ManualAnswer').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#patch0102ManualStop').click()`);
  await waitFor('stop preserved an answer and completed batch', () => fs.existsSync(path.join(userData, 'subtitles', 'manual-translation-sessions')) && fs.readdirSync(path.join(userData, 'subtitles', 'manual-translation-sessions')).some(file => file.endsWith('.json')));
  await win.webContents.reload();
  await waitFor('unpacked app reloaded with translation UI', async () => win.webContents.executeJavaScript("Boolean(document.querySelector('#patch0102ManualStart'))"));
  await win.webContents.executeJavaScript("document.querySelector('#patch0102ManualStart').click()");
  await waitFor('saved translation work resumed after renderer reload', async () => win.webContents.executeJavaScript("document.querySelector('#patch0102ManualProgress')?.textContent.startsWith('24/30문장 (80%) · 묶음 2/2') && document.querySelector('#patch0102ManualAnswer')?.value.length > 0"));
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#patch0102ManualAnswer').value"), lastResponse);
  await win.webContents.executeJavaScript("document.querySelector('#patch0102ManualApply').click()");
  await waitFor('translated VTT stored to isolated profile', () => savedTranslations.length === 1);
  const saved = savedTranslations[0];
  const translatedVtt = fs.readFileSync(saved.path, 'utf8');
  assert.equal(saved.source, 'chatgpt');
  assert.match(translatedVtt, /00:00:30\.000 --> 00:00:30\.800/);
  assert.match(translatedVtt, /한국어 번역 1/); assert.match(translatedVtt, /한국어 번역 30/);
  assert.equal((translatedVtt.match(/--> /g) || []).length, 30, 'all original cue timecodes remain present');
  await waitFor('immediate cleanup removed only the temporary job', () => fs.readdirSync(path.join(userData, 'subtitles', 'manual-translation-sessions')).length === 0);
  await win.webContents.executeJavaScript("document.querySelector('#patch0102ManualReveal').click()");
  assert.equal(revealedFiles[0], fs.realpathSync(saved.path));
  await win.webContents.executeJavaScript("document.querySelector('#patch0102ManualRestore').click()");
  await waitFor('original subtitle can be restored', async () => win.webContents.executeJavaScript(`currentSubtitle?.path === ${JSON.stringify(sourcePath)} && currentSubtitle?.source === 'reanime'`));
  await win.webContents.executeJavaScript("document.querySelector('#patch0102ManualStart').click()");
  await waitFor('retranslation confirmation detects a saved subtitle after immediate cleanup', async () => win.webContents.executeJavaScript("window.patchFixtureState.confirmMessages.some(message=>message.includes('이미 번역되어 저장됐습니다'))"));
  assert.equal(await win.webContents.executeJavaScript("window.patchFixtureState.confirmMessages.length"), 1);
  assert.equal(savedTranslations.length, 1, 'declining retranslation keeps the saved Korean subtitle');
  assert.equal(savedTranslations[0].from, sourcePath, 'the saved translation remains linked to its original subtitle');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#patch0102ManualPanel').classList.contains('hidden')"), true, 'declining does not open another translation session');
  assert.equal(blockedRequests.length, 0, 'the UI test made no external HTTP requests');
  assert.equal(rendererErrors.length, 0, rendererErrors.join('\n'));
  console.log(`v0.5.14 isolated renderer: quarter ${overview.quarterTitle}; today tab ${overview.days.find(day => day.today).label}; 5 source states checked; manual subtitle saved under isolated profile; HTTP requests blocked=${blockedRequests.length}.`);
  finished = true;
  win.destroy();
  app.quit();
}

process.on('exit', () => {
  if (orchestratedTempRoot) return;
  try { if (fs.existsSync(`${fixtureRoot}.lilac-patch-manager-synthetic-fixture.json`)) cleanupSyntheticFixture(fixtureRoot); } catch (error) { console.error(error.message); process.exitCode = 1; }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (error) { console.error(error.message); process.exitCode = 1; }
});

try {
  makeFixture();
  fs.mkdirSync(userData); fs.mkdirSync(sessionData); fs.mkdirSync(cachePath);
  app.setName('LilacAnime Patch Stage 2 Fixture');
  app.setAppUserModelId('org.codex.synthetic.lilac');
  app.setPath('userData', userData);
  app.setPath('sessionData', sessionData);
  app.setPath('cache', cachePath);
  app.commandLine.appendSwitch('disable-background-networking');
  app.disableHardwareAcceleration();
  app.whenReady().then(run).catch(fail);
} catch (error) { fail(error); }
