// Real Electron smoke run for Patch 01 + official providerSchedule integration.
// Launch with the project's Electron binary: electron tests/season-schedule-live.electron.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-v0527-schedule-'));
const tracePath = path.join(tempRoot, 'trace.log');
const trace = (event, data = {}) => {
  try { fs.appendFileSync(tracePath, `${new Date().toISOString()} ${event} ${JSON.stringify(data)}\n`); } catch {}
};
trace('harness:entry', { pid: process.pid, execPath: process.execPath, electron: process.versions.electron, tempRoot });
process.on('uncaughtException', error => {
  trace('uncaught:early', { message: error?.message || String(error), stack: error?.stack || '' });
  console.error(error?.stack || error);
  try { app.exit(1); } catch {}
});
process.on('unhandledRejection', error => {
  trace('rejection:early', { message: error?.message || String(error), stack: error?.stack || '' });
  console.error(error?.stack || error);
  try { app.exit(1); } catch {}
});
const paths = Object.fromEntries(['appData', 'userData', 'sessionData'].map(name => [name, path.join(tempRoot, name)]));
for (const value of Object.values(paths)) fs.mkdirSync(value, { recursive: true });
for (const key of ['appData', 'userData', 'sessionData']) {
  trace('app-path:set-start', { key, value: paths[key] });
  app.setPath(key, paths[key]);
  trace('app-path:set-finished', { key });
}
trace('app:hardware-acceleration-disable-start');
app.disableHardwareAcceleration();
trace('app:hardware-acceleration-disable-finished');
for (const key of Object.keys(paths)) {
  trace('app-path:get-start', { key });
  const actual = app.getPath(key);
  trace('app-path:get-finished', { key, actual });
  assert.equal(path.resolve(actual), path.resolve(paths[key]), `${key} must use the isolated test path`);
}
assert.ok(path.resolve(app.getPath('userData')).startsWith(path.resolve(os.tmpdir())), 'userData is isolated under OS Temp');
assert.ok(path.resolve(app.getPath('sessionData')).startsWith(path.resolve(os.tmpdir())), 'sessionData is isolated under OS Temp');
trace('paths:isolated', Object.fromEntries(Object.keys(paths).map(key => [key, app.getPath(key)])));

let mainWindow = null, report = null;
let settled = false;
const fail = error => {
  if (settled) return;
  settled = true;
  trace('failure', { message: error?.message || String(error), stack: error?.stack || '' });
  console.error(error?.stack || error);
  try { mainWindow?.destroy(); } catch {}
  app.exit(1);
};
process.removeAllListeners('uncaughtException');
process.removeAllListeners('unhandledRejection');
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
process.on('exit', code => trace('process:exit', { code }));
app.on('ready', () => trace('app:ready-event', { isReady: app.isReady() }));
app.on('will-quit', () => trace('app:will-quit'));
const originalQuit = app.quit.bind(app);
app.quit = (...args) => {
  trace('app:quit-called', { stack: new Error().stack || '' });
  return originalQuit(...args);
};
app.on('browser-window-created', (_, win) => trace('window:created', { id: win.id, webContentsId: win.webContents.id }));

app.on('browser-window-created', (_, win) => {
  win.on('close', () => trace('window:close', { id: win.id, stack: new Error().stack || '' }));
  win.on('closed', () => trace('window:closed', { id: win.id }));
  win.webContents.on('render-process-gone', (_event, details) => trace('renderer:gone', details));
  win.on('unresponsive', () => trace('window:unresponsive', { id: win.id }));
  win.on('responsive', () => trace('window:responsive', { id: win.id }));
  win.webContents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
    if (isMainFrame) trace('window:navigate', { id: win.id, url });
  });
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => trace('renderer:console', { level, message, line, sourceId }));
  win.webContents.on('render-process-gone', (_event, details) => trace('renderer:gone', details));
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) trace('window:load-failed', { id: win.id, code, description, url });
  });
  win.webContents.on('did-finish-load', () => {
    const url = win.webContents.getURL();
    trace('window:load-finished', { id: win.id, url });
    if (/\/src\/index\.html(?:$|[?#])/.test(url)) {
      mainWindow = win;
      setTimeout(async () => {
        try {
          const png = await Promise.race([win.capturePage(), pause(8000).then(() => { throw new Error('capturePage timed out'); })]);
          const imagePath = path.join(tempRoot, 'initial-page.png');
          fs.writeFileSync(imagePath, png.toPNG());
          trace('window:initial-capture', { path: imagePath, size: png.getSize() });
        } catch (error) { trace('window:initial-capture-failed', { message: error.message }); }
      }, 500);
      setTimeout(async () => {
        try {
          const title = await evaluate('document.title', 'initial title probe', 5000);
          trace('renderer:initial-probe', { title });
        } catch (error) { trace('renderer:initial-probe-failed', { message: error.message }); }
      }, 750);
    }
  });
});

trace('main:require-start');
try {
  require('../electron/main.cjs');
  trace('main:require-finished');
} catch (error) {
  trace('main:require-threw', { message: error?.message || String(error), stack: error?.stack || '' });
  throw error;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(source, label = 'renderer evaluation', timeoutMs = 8000) {
  let timer;
  try {
    return await Promise.race([
      mainWindow.webContents.executeJavaScript(source),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}
async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let timer;
    const probe = Promise.resolve().then(predicate);
    try {
      if (await Promise.race([probe, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: renderer probe stalled`)), 8000); })])) return true;
    } finally { clearTimeout(timer); }
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function inspect() {
  trace('inspect:start');
  await waitFor(() => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL().includes('/src/index.html'), 20000, 'the LilacAnime main window');
  await waitFor(() => mainWindow.webContents.isLoading() === false, 20000, 'main document load');
  trace('inspect:document-ready');
  const initialDialogState = await evaluate(`(() => {
    window.__scheduleHarnessClicks=[];window.__scheduleHarnessDialogEvents=[];window.__scheduleHarnessDetailCalls=[];
    document.addEventListener('click',event=>{const target=event.target.closest('button,a,[role=button]');if(target)window.__scheduleHarnessClicks.push({id:target.id||'',className:String(target.className||''),text:target.textContent?.trim().slice(0,90)||'',time:Date.now()})},true);
    const dialog=document.querySelector('#detailDialog');dialog?.addEventListener('toggle',()=>window.__scheduleHarnessDialogEvents.push({open:dialog.open,time:Date.now()}));
    if(typeof window.openDetail==='function'){const original=window.openDetail;window.openDetail=(...args)=>{window.__scheduleHarnessDetailCalls.push({args,stack:new Error().stack});return original(...args)}}
    return {detailOpen:dialog?.open||false,detailHeading:dialog?.querySelector('.detail-info h1')?.textContent?.trim()||'',openDetailType:typeof window.openDetail,
      seeAllHandler:document.querySelector('#seeAllSeason')?.onclick?.toString().slice(0,220)||''};
  })()`, 'detail dialog initial state and click instrumentation');
  const homeReadyProbeStarted = Date.now();
  await waitFor(async () => await evaluate(`(() => {
    const rail=document.querySelector('#seasonRail'),status=document.querySelector('#quarterStatus')?.textContent||'';
    return Boolean(rail&&((rail.querySelector('.anime-card')&&!rail.classList.contains('loading-cards'))||status&&!/불러오는 중/.test(status)));
  })()`, 'home season content readiness'), 45000, 'season rail or completed quarter status');
  const homeReadyProbeMs = Date.now() - homeReadyProbeStarted;
  const before = await evaluate(`(() => {
    const rail=document.querySelector('#seasonRail');
    return {
    source:document.querySelector('#contentSource')?.value||'',
    seasonCards:document.querySelectorAll('#seasonRail .anime-card').length,
    seasonLoading:rail?.classList.contains('loading-cards')||false,
    quarterStatus:document.querySelector('#quarterStatus')?.textContent||'',
    scheduleAnchorEmpty:document.querySelector('#scheduleSection')?.children.length===0,
    homeScheduleController:Boolean(window.LilacWeeklySchedule),
    providerScheduleRequests:window.LilacProviderScheduleClient?.diagnostics?.().requests||0,
    homeSeasonSeeAll:Boolean(document.querySelector('#seeAllSeason')),
    allViewPreserved:Boolean(document.querySelector('#allView #catalogFilters'))
  }})()`, 'home state');
  trace('inspect:initial-home-state', before);
  const homeAfterSchedule = await evaluate(`(() => ({
    source:document.querySelector('#contentSource')?.value||'',
    seasonCards:document.querySelectorAll('#seasonRail .anime-card').length,
    seasonLoading:document.querySelector('#seasonRail')?.classList.contains('loading-cards')||false,
    quarterStatus:document.querySelector('#quarterStatus')?.textContent||'',
    scheduleAnchorEmpty:document.querySelector('#scheduleSection')?.children.length===0,
    scheduleRailPresent:Boolean(document.querySelector('#scheduleRail')),
    weekdayTabsPresent:Boolean(document.querySelector('#scheduleTabs')),
    homeScheduleController:Boolean(window.LilacWeeklySchedule),
    scheduleClient:window.LilacProviderScheduleClient?.diagnostics?.()||null,
    homeSeasonSeeAll:Boolean(document.querySelector('#seeAllSeason')),
    allViewPreserved:Boolean(document.querySelector('#allView #catalogFilters')),
    titleDisplay:{
      pageAgeMs:Math.round(performance.now()),
      cards:[...document.querySelectorAll('#seasonRail .anime-card [data-title-for]')].length,
      korean:[...document.querySelectorAll('#seasonRail .anime-card [data-title-for]')].filter(node=>/[가-힣]/.test(node.textContent||'')).length,
      lookupEligible:[...document.querySelectorAll('#seasonRail .anime-card [data-title-for]')].filter(node=>{const a=titleAnime.get(node.dataset.titleFor),known=displayTitles.get(node.dataset.titleFor)||{};return a&&!LilacTitleDisplay.providerKoreanTitle(a)&&!LilacTitleDisplay.hasKorean(known.ko)}).length,
      lookupStarted:[...titleLookupStarted].filter(key=>[...document.querySelectorAll('#seasonRail [data-title-for]')].some(node=>node.dataset.titleFor===key)).length,
      active:activeTitleLookups,pending:pendingTitles.size
    }
  }))()`, 'home state after schedule');
  trace('inspect:home-after-schedule', homeAfterSchedule);
  const homeImage = await mainWindow.capturePage();
  const homeCapture = path.join(tempRoot, 'app-home.png'); fs.writeFileSync(homeCapture, homeImage.toPNG());
  await evaluate(`document.querySelector('#seasonRail')?.scrollIntoView({block:'center',behavior:'instant'})`, 'scroll to season rail');
  await pause(300);
  const homeTitleVisible = await evaluate(`(() => {
    const nodes=[...document.querySelectorAll('#seasonRail .anime-card [data-title-for]')];
    return {visible:nodes.length>0&&nodes.some(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.height>0}),
      cards:nodes.length,korean:nodes.filter(node=>/[가-힣]/.test(node.textContent||'')).length,
      originalFallback:nodes.filter(node=>{const text=(node.textContent||'').trim();return text&&text!=='제목 없음'}).length,
      lookupEligible:nodes.filter(node=>{const a=titleAnime.get(node.dataset.titleFor),known=displayTitles.get(node.dataset.titleFor)||{};return a&&!LilacTitleDisplay.providerKoreanTitle(a)&&!LilacTitleDisplay.hasKorean(known.ko)}).length,
      lookupStarted:[...titleLookupStarted].filter(key=>nodes.some(node=>node.dataset.titleFor===key)).length,
      active:activeTitleLookups,pending:pendingTitles.size,
      titles:nodes.slice(0,8).map(node=>node.textContent?.trim()||'')};
  })()`, 'season rail title state after scrolling into view');
  const seasonRailImage = await mainWindow.capturePage();
  const seasonRailCapture = path.join(tempRoot, 'app-season-rail.png'); fs.writeFileSync(seasonRailCapture, seasonRailImage.toPNG());
  const homeVisual = await evaluate(`(() => {
    const card=document.querySelector('#seasonRail .anime-card'),poster=card?.querySelector('.poster');
    return {viewport:{width:innerWidth,height:innerHeight},cardRadius:card?getComputedStyle(card).borderRadius:'',
      posterRatio:poster?getComputedStyle(poster).aspectRatio:'',posterRadius:poster?getComputedStyle(poster).borderRadius:'',
      cardWidth:card?Math.round(card.getBoundingClientRect().width):0,titleFontSize:card?getComputedStyle(card.querySelector('h3')).fontSize:'',
      posterRailGap:document.querySelector('#seasonRail')?getComputedStyle(document.querySelector('#seasonRail')).gap:''};
  })()`, 'home visual metrics');
  await evaluate(`document.querySelector('main')?.scrollTo({top:0,behavior:'instant'})`, 'restore home scroll');
  await evaluate(`document.querySelector('#seeAllSeason')?.click()`, 'open season calendar');
  await pause(100);
  const loadingState = await evaluate(`(() => ({status:document.querySelector('#seasonCalendarStatus')?.textContent||'',openDialogs:[...document.querySelectorAll('dialog[open]')].map(dialog=>({id:dialog.id||'unnamed',heading:dialog.querySelector('.detail-info h1')?.textContent?.trim()||'',error:dialog.querySelector('.empty-state p')?.textContent?.trim()||''}))}))()`, 'calendar loading state');
  const loadingImage = await mainWindow.capturePage();
  const loadingCapture = path.join(tempRoot, 'season-calendar-loading.png'); fs.writeFileSync(loadingCapture, loadingImage.toPNG());
  await waitFor(async () => await evaluate(`(() => {const d=window.LilacSeasonCalendarDiagnostics;return Boolean(d&&['complete','partial','failed'].includes(d.state))})()`, 'calendar completion probe'), 180000, 'provider and airing schedule requests to settle');
  const calendar = await evaluate(`(() => {
    const grid=document.querySelector('#seasonCalendarGrid'),diag=window.LilacSeasonCalendarDiagnostics||{};
    const columns=[...document.querySelectorAll('#seasonCalendarGrid .season-calendar-day')],card=document.querySelector('#seasonCalendarGrid .season-calendar-card'),poster=card?.querySelector('.season-calendar-poster');
    return {visible:!document.querySelector('#seasonCalendarView')?.classList.contains('hidden'),
      columns:grid?.querySelectorAll('.season-calendar-day').length||0,
      dayCounts:columns.map(column=>({day:column.querySelector('h2')?.textContent||'',count:column.querySelectorAll('.season-calendar-card').length})),
      unknownTitle:document.querySelector('#seasonCalendarUnknownTitle')?.textContent||'',
      subtitle:document.querySelector('#seasonCalendarSubtitle')?.textContent||'',
      unknownCount:Number(document.querySelector('#seasonCalendarUnknownCount')?.textContent?.match(/\\d+/)?.[0]||0),
      unknownCards:[...document.querySelectorAll('#seasonCalendarUnknown .season-calendar-card')].map(card=>{
        const id=card.dataset.id||'',anime=typeof animeById==='function'?animeById(id):null;
        return {catalogId:id,title:card.querySelector('h3')?.textContent?.trim()||'',
          titleEnglish:anime?.title_english||anime?.titleEnglish||'',titleJapanese:anime?.title_japanese||anime?.titleJapanese||anime?.title_native||'',
          titleRomaji:anime?.title_romaji||anime?.romaji||'',synonyms:Array.isArray(anime?.synonyms)?anime.synonyms:[],
          anilistId:anime?.anilistId||anime?.anilist_id||null,malId:anime?.mal_id||anime?.malId||null,
          year:anime?.year||anime?.season_year||null,season:anime?.season||'',type:anime?.type||anime?.format||'',
          status:anime?.status||'',reason:anime?.weeklyStatusReason||''};
      }),
      conflictCount:Number(document.querySelector('#seasonCalendarConflictCount')?.textContent?.match(/\\d+/)?.[0]||0),
      duplicateCardIds:(()=>{const entries=[];for(const column of columns)for(const card of column.querySelectorAll('.season-calendar-card')){
        const id=card.dataset.id||'',meta=card.querySelector('.season-calendar-meta')?.textContent||'';
        const episodes=[...new Set([...meta.matchAll(/(\d+)\s*화/g)].map(match=>Number(match[1])).filter(Number.isInteger))];
        for(const episode of episodes)entries.push({id,episode,day:column.dataset.day||''});
      }
        const daysByEpisode=new Map();for(const entry of entries){const key=entry.id+'|'+entry.episode;if(!daysByEpisode.has(key))daysByEpisode.set(key,{id:entry.id,episode:entry.episode,days:new Set()});daysByEpisode.get(key).days.add(entry.day)}
        return [...daysByEpisode.values()].filter(entry=>entry.days.size>1).map(entry=>({id:entry.id,episode:entry.episode,days:[...entry.days],count:entry.days.size}))})(),
      clientWidth:grid?.clientWidth||0,scrollWidth:grid?.scrollWidth||0,overflowX:grid?getComputedStyle(grid).overflowX:'',
      cardWidth:card?.getBoundingClientRect().width||0,posterRatio:poster?getComputedStyle(poster).aspectRatio:'',
      posterRadius:poster?getComputedStyle(poster).borderRadius:'',titleFontSize:card?getComputedStyle(card.querySelector('h3')).fontSize:'',
      titleLineClamp:card?getComputedStyle(card.querySelector('h3')).webkitLineClamp:'',
      titleWhiteSpace:card?getComputedStyle(card.querySelector('h3')).whiteSpace:'',
      cardRadius:card?getComputedStyle(card).borderRadius:'',cardGap:grid?getComputedStyle(grid).gap:'',
      titleDisplay:{cards:[...document.querySelectorAll('#seasonCalendarView [data-title-for]')].length,
        tooltipMatches:[...document.querySelectorAll('#seasonCalendarView [data-title-for]')].filter(node=>node.title===node.textContent.trim()).length,
        tooltipCount:[...document.querySelectorAll('#seasonCalendarView [data-title-for]')].length,
        korean:[...document.querySelectorAll('#seasonCalendarView [data-title-for]')].filter(node=>/[가-힣]/.test(node.textContent||'')).length,
        lookupEligible:[...document.querySelectorAll('#seasonCalendarView [data-title-for]')].filter(node=>{const a=titleAnime.get(node.dataset.titleFor),known=displayTitles.get(node.dataset.titleFor)||{};return a&&!LilacTitleDisplay.providerKoreanTitle(a)&&!LilacTitleDisplay.hasKorean(known.ko)}).length,
        lookupStarted:[...titleLookupStarted].filter(key=>[...document.querySelectorAll('#seasonCalendarView [data-title-for]')].some(node=>node.dataset.titleFor===key)).length,
        active:activeTitleLookups,pending:pendingTitles.size},
      openDialogs:[...document.querySelectorAll('dialog[open]')].map(dialog=>dialog.id||dialog.getAttribute('aria-label')||'unnamed'),
      status:document.querySelector('#seasonCalendarStatus')?.textContent||'',diagnostics:diag};
  })()`, 'calendar state');
  const airingScheduleResponseSuccess = Object.values(calendar.diagnostics.sources || {}).some(source =>
    ['complete', 'partial'].includes(source.state) && source.requestStarted === true && source.responseRows > 0);
  const providerScheduleResponseSuccess = Object.values(calendar.diagnostics.providerSchedules || {}).some(source =>
    ['complete', 'partial'].includes(source.state) && (source.nativeRows > 0 || source.dayResults?.some(day => day.native && day.state === 'complete')));
  const exactProviderVoteRows = Object.values(calendar.diagnostics.providerEvidenceCounts || {})
    .reduce((sum, source) => sum + (Number(source.eligibleVoteRows) || 0), 0);
  const catalogAccounting = calendar.diagnostics.weeklyReleaseCount + calendar.diagnostics.unverifiedWeeklyCount
    + calendar.diagnostics.excludedCatalogCount === calendar.diagnostics.catalogCount;
  const liveChecks = {
    noDuplicateHomeScheduleUI: homeAfterSchedule.scheduleAnchorEmpty && !homeAfterSchedule.scheduleRailPresent
      && !homeAfterSchedule.weekdayTabsPresent && !homeAfterSchedule.homeScheduleController,
    homeSeasonAndAllViewPreserved: homeAfterSchedule.seasonCards > 0 && homeAfterSchedule.homeSeasonSeeAll
      && homeAfterSchedule.allViewPreserved,
    noScheduleFetchOnHome: Number(homeAfterSchedule.scheduleClient?.requests || 0) === 0,
    homeTitleFallbackDoesNotWait: homeTitleVisible.cards > 0 && homeTitleVisible.visible
      && homeTitleVisible.originalFallback === homeTitleVisible.cards,
    titleLookupsAreBounded: homeTitleVisible.active <= 4 && calendar.titleDisplay.active <= 4
      && homeTitleVisible.lookupStarted <= homeTitleVisible.lookupEligible
      && calendar.titleDisplay.lookupStarted <= calendar.titleDisplay.lookupEligible,
    providerReleaseBasis: calendar.diagnostics.scheduleBasis === 'provider-release-vote'
      && String(calendar.subtitle || '').includes('공급 사이트 공개 일정 기준 · AniList/Jikan 별도 근거'),
    airingScheduleResponseSuccess,
    providerScheduleResponseSuccess,
    exactProviderVoteEvidence: exactProviderVoteRows > 0,
    voteEvidenceRecorded: Array.isArray(calendar.diagnostics.voteResults) && calendar.diagnostics.voteResults.length > 0,
    actualWeekdayAssignment: calendar.diagnostics.assignedCount > 0,
    catalogDuplicateCards: Array.isArray(calendar.duplicateCardIds) && calendar.duplicateCardIds.length === 0,
    catalogAccounting,
    sourceEvidenceRecorded: Array.isArray(calendar.diagnostics.scheduleEvidence)
      && Array.isArray(calendar.diagnostics.unmatchedScheduleRows),
    detailOpened: false,
    actualPlayback10Seconds: false,
    actualQualityReadout: false
  };
  const hoverPoint = await evaluate(`(() => {const card=document.querySelector('#seasonCalendarGrid .season-calendar-card');const rect=card?.getBoundingClientRect();return rect?{x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+Math.min(90,rect.height/2))}:null})()`, 'calendar card hover point');
  if (hoverPoint) mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: hoverPoint.x, y: hoverPoint.y });
  await pause(100);
  const hoverState = await evaluate(`(() => {const card=document.querySelector('#seasonCalendarGrid .season-calendar-card'),poster=card?.querySelector('.season-calendar-poster');return {
    hovered:Boolean(card?.matches(':hover')),posterTransform:poster?getComputedStyle(poster).transform:'none',titleColor:card?getComputedStyle(card.querySelector('h3')).color:''
  }})()`, 'calendar card hover style');
  mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: 3, y: 3 });
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  const focusState = await evaluate(`(() => {const card=document.querySelector('#seasonCalendarGrid .season-calendar-card');card?.focus();return {
    focused:document.activeElement===card,focusVisible:Boolean(card?.matches(':focus-visible')),
    outlineStyle:card?getComputedStyle(card).outlineStyle:'none',outlineColor:card?getComputedStyle(card).outlineColor:''
  }})()`, 'calendar card keyboard focus style');
  await evaluate(`document.activeElement?.blur?.()`, 'clear calendar card focus');
  liveChecks.cardHoverStyle = hoverState.hovered && hoverState.posterTransform !== 'none';
  liveChecks.keyboardFocusStyle = focusState.focused && focusState.focusVisible && focusState.outlineStyle !== 'none';
  const scrollProbe = await evaluate(`(() => {const grid=document.querySelector('#seasonCalendarGrid');if(!grid)return null;const before=grid.scrollLeft;grid.scrollLeft=grid.scrollWidth;const after=grid.scrollLeft;grid.scrollLeft=before;return {before,after,max:grid.scrollWidth-grid.clientWidth}})()`, 'calendar scroll interaction');
  let calendarCapture = '';
  await pause(500);
  try {
    const calendarImage = await Promise.race([mainWindow.capturePage(), pause(8000).then(() => { throw new Error('calendar capture timed out'); })]);
    calendarCapture = path.join(tempRoot, 'season-calendar.png'); fs.writeFileSync(calendarCapture, calendarImage.toPNG());
  } catch (error) { trace('calendar:capture-failed', { message: error.message }); }
  await evaluate(`document.querySelector('#seasonCalendarUnknownSection')?.scrollIntoView({block:'start',behavior:'instant'})`, 'scroll to unknown and conflict sections');
  await pause(300);
  const statusVisual = await evaluate(`(() => {
    const unknown=document.querySelector('#seasonCalendarUnknown .season-calendar-card'),conflict=document.querySelector('#seasonCalendarConflicts .season-calendar-card');
    const inspect=card=>card?{background:getComputedStyle(card).backgroundColor,border:getComputedStyle(card).borderTopWidth,
      posterRadius:getComputedStyle(card.querySelector('.poster')).borderRadius,posterRatio:getComputedStyle(card.querySelector('.poster')).aspectRatio,
      titleSize:getComputedStyle(card.querySelector('h3')).fontSize}:null;
    return {unknown:inspect(unknown),conflict:inspect(conflict),unknownHeading:document.querySelector('#seasonCalendarUnknownTitle')?.textContent||'',
      conflictHeading:document.querySelector('#seasonCalendarConflictTitle')?.textContent||''};
  })()`, 'unknown and conflict card styles');
  const statusImage = await mainWindow.capturePage();
  const statusCapture = path.join(tempRoot, 'season-calendar-status-sections.png'); fs.writeFileSync(statusCapture, statusImage.toPNG());
  await evaluate(`document.querySelector('main')?.scrollTo({top:0,behavior:'instant'})`, 'restore calendar scroll');
  let narrowCalendar = null, narrowCapture = '';
  try {
    mainWindow.setContentSize(980, 760);
    await pause(500);
    narrowCalendar = await evaluate(`(() => {
      const grid=document.querySelector('#seasonCalendarGrid'),columns=[...document.querySelectorAll('#seasonCalendarGrid .season-calendar-day')];
      return {viewport:{width:innerWidth,height:innerHeight},clientWidth:grid?.clientWidth||0,scrollWidth:grid?.scrollWidth||0,
        overflowX:grid?getComputedStyle(grid).overflowX:'',columnWidths:columns.map(column=>Math.round(column.getBoundingClientRect().width)),
        titleOverflow:columns.flatMap(column=>[...column.querySelectorAll('.season-calendar-card h3')]).filter(title=>title.scrollWidth>title.clientWidth).length,
        horizontalScroll:grid?grid.scrollWidth>grid.clientWidth:false};
    })()`, 'narrow calendar layout');
    const narrowImage = await Promise.race([mainWindow.capturePage(), pause(8000).then(() => { throw new Error('narrow calendar capture timed out'); })]);
    narrowCapture = path.join(tempRoot, 'season-calendar-narrow.png'); fs.writeFileSync(narrowCapture, narrowImage.toPNG());
  } catch (error) { trace('calendar:narrow-check-failed', { message: error.message }); }
  finally { if (!mainWindow.isDestroyed()) mainWindow.setContentSize(1440, 900); }
  const calendarCard = await evaluate(`(() => {const diag=window.LilacSeasonCalendarDiagnostics||{};const officialIds=new Set((diag.officialScheduleEvidence||[]).filter(item=>item.outcome==='assigned').map(item=>String(item.catalogId)));const cards=[...document.querySelectorAll('#seasonCalendarGrid .season-calendar-card')];const card=cards.find(item=>officialIds.has(String(item.dataset.id||'')))||cards[0];if(!card)return null;const id=card.dataset.id;const anime=typeof animeById==='function'?animeById(id):null;const evidence=(diag.officialScheduleEvidence||[]).find(item=>String(item.catalogId)===String(id));const data={id,title:card.querySelector('h3')?.textContent?.trim()||'',provider:anime?.provider||'',sourceId:anime?.id||'',year:anime?.year||null,type:anime?.type||'',urlHost:anime?.url?new URL(anime.url).hostname:'',officialScheduleEvidence:evidence||null};card.click();return data})()`, 'newly verified calendar poster click');
  let detail = { opened: false, heading: '', errorMessage: '', textLength: 0, episodeRows: 0 };
  if (calendarCard) {
    try {
      await waitFor(async () => await evaluate(`(() => {const c=document.querySelector('#detailContent');return Boolean(c&&c.querySelector('.detail-body h1,.empty-state h3'))})()`, 'detail completion probe'), 30000, 'detail content or error');
      detail = await evaluate(`(() => ({opened:document.querySelector('#detailDialog')?.open===true,
        heading:document.querySelector('#detailContent .detail-info h1')?.textContent?.trim()||'',
        errorTitle:document.querySelector('#detailContent .empty-state h3')?.textContent?.trim()||'',
        errorMessage:document.querySelector('#detailContent .empty-state p')?.textContent?.trim()||'',
        textLength:document.querySelector('#detailContent')?.textContent?.length||0,
        episodeRows:document.querySelectorAll('#detailContent #episodeBlock .episode-card,#detailContent #episodeBlock [data-episode-number],#detailContent #episodeBlock .episode-row').length,
        episodeText:document.querySelector('#detailContent #episodeBlock')?.textContent?.trim().slice(0,500)||''}))()`, 'detail state');
      detail.sourceSearchSettled = await waitFor(async () => await evaluate(`!document.querySelector('#detailContent .source-search-note')?.textContent?.includes('공급원을 확인 중')`, 'detail source-search completion'), 95000, 'bounded same-work provider search');
      detail.sourceSearch = await evaluate(`(() => {const group=searchGroupsByKey.get(openDetail.currentGroupKey);return {
        source:document.querySelector('#contentSource')?.value||'',
        pickerCount:document.querySelectorAll('#detailContent .detail-source-picker').length,
        pending:Boolean(group?.sourceSearchPending),
        statuses:group?.sourceSearchStatuses||[],
        choices:[...document.querySelectorAll('#detailContent [data-detail-source]')].map(button=>({id:button.dataset.detailSource,provider:button.dataset.detailSource.split(':')[0],selected:button.getAttribute('aria-pressed')==='true'}))
      }})()`, 'detail source options');
      const miruroChoice = detail.sourceSearch.choices.find(choice => choice.provider === 'miruro');
      if (miruroChoice) {
        await evaluate(`(() => {const button=[...document.querySelectorAll('#detailContent [data-detail-source]')].find(item=>item.dataset.detailSource===${JSON.stringify(miruroChoice.id)});button?.click()})()`, 'select matched Miruro source');
        await waitFor(async () => await evaluate(`(() => {const block=document.querySelector('#detailContent #episodeBlock');return Boolean(block&&!block.textContent.includes('작품 정보를 불러오는 중...')&&(block.querySelector('.episode-card,[data-episode-number],.episode-row')||/회차|불러오지|제공하지|없습니다/.test(block.textContent)))})()`, 'Miruro detail episodes settled'), 45000, 'matched Miruro detail and episodes');
        detail.miruroSwitch = await evaluate(`(() => ({
          globalDefault:document.querySelector('#contentSource')?.value||'',
          selectedId:openDetail.currentSourceId||'',
          selectedProvider:(openDetail.currentSourceId||'').split(':')[0],
          heading:document.querySelector('#detailContent .detail-info h1')?.textContent?.trim()||'',
          selectedChoices:[...document.querySelectorAll('#detailContent [data-detail-source]')].filter(button=>button.getAttribute('aria-pressed')==='true').map(button=>button.dataset.detailSource),
          episodeRows:document.querySelectorAll('#detailContent #episodeBlock .episode-card,#detailContent #episodeBlock [data-episode-number],#detailContent #episodeBlock .episode-row').length,
          episodeText:document.querySelector('#detailContent #episodeBlock')?.textContent?.trim().slice(0,500)||''
        }))()`, 'Miruro selected detail');
      } else detail.miruroSwitch = { attempted: false, reason: 'exactly matched Miruro item not present in live provider search' };
      await pause(500);
      const detailImage = await Promise.race([mainWindow.capturePage(), pause(8000).then(() => { throw new Error('detail capture timed out'); })]);
      detail.capture = path.join(tempRoot, 'season-calendar-detail.png'); fs.writeFileSync(detail.capture, detailImage.toPNG());
      if (miruroChoice && detail.miruroSwitch?.episodeRows > 0 && detail.miruroSwitch?.selectedProvider === 'miruro'
        && process.env.SEASON_CALENDAR_SKIP_PLAYBACK !== '1') {
        detail.playback = await evaluate(`(() => {
          localStorage.setItem('defaultQuality','Auto');
          const button=document.querySelector('#detailContent #episodeBlock .episode-btn:not([disabled])');
          const episode=button?.querySelector('.episode-number')?.textContent?.trim()||'';
          button?.click();return {attempted:Boolean(button),episode};
        })()`, 'play one matched Miruro episode');
        if (detail.playback.attempted) {
          try {
            await waitFor(async () => await evaluate(`(() => {const video=document.querySelector('#video');return Boolean(video&&video.currentTime>=10&&video.videoWidth>0&&video.videoHeight>0)})()`, 'actual video playback probe'), 90000, 'at least 10 seconds of actual Miruro playback');
            await evaluate(`document.querySelector('#playerSettingsButton')?.click()`, 'open player quality status');
            detail.playback.metrics = await evaluate(`(() => {const video=document.querySelector('#video'),levels=hlsPlayer?.levels||[],index=hlsPlayer?.currentLevel??-1;return {
              provider:currentPlaybackContext?.episode?.provider||'',
              currentTime:video?.currentTime||0,paused:video?.paused??true,readyState:video?.readyState||0,
              outputWidth:video?.videoWidth||0,outputHeight:video?.videoHeight||0,
              levelCount:levels.length,currentLevel:index>=0?{height:levels[index]?.height||0,bitrate:levels[index]?.bitrate||0}:null,
              automatic:Boolean(hlsPlayer?.autoLevelEnabled),qualityStatus:document.querySelector('#psQualityActual')?.textContent||'',
              qualityMatchesOutput:(document.querySelector('#psQualityActual')?.textContent||'').includes((video?.videoWidth||0)+' × '+(video?.videoHeight||0)),
              streamHost:(()=>{try{return new URL(video?.currentSrc||'').hostname}catch{return ''}})()
            }})()`, 'actual playback quality metrics');
            detail.playback.tenSeconds = detail.playback.metrics.currentTime >= 10;
            liveChecks.actualPlayback10Seconds = detail.playback.tenSeconds;
            liveChecks.actualQualityReadout = detail.playback.metrics.qualityMatchesOutput;
          } catch (error) {
            detail.playback.error = error.message;
            detail.playback.lastState = await evaluate(`(() => {const video=document.querySelector('#video');return {
              playerVisible:document.querySelector('#playerView')?.classList.contains('active')||false,
              currentTime:video?.currentTime||0,paused:video?.paused??true,readyState:video?.readyState||0,
              outputWidth:video?.videoWidth||0,outputHeight:video?.videoHeight||0,
              playerMessage:document.querySelector('#playerEmpty p')?.textContent||'',
              status:document.querySelector('#downloadStatus')?.textContent||''
            }})()`, 'failed playback state');
          }
          await evaluate(`document.querySelector('#playerBack')?.click()`, 'return from player');
          await pause(250);
        }
      }
    } catch (error) { detail.error = error.message; }
    await evaluate(`document.querySelector('#detailDialog .dialog-close')?.click()`, 'close detail dialog');
    await waitFor(async () => await evaluate(`document.querySelector('#detailDialog')?.open!==true`, 'detail dialog closed'), 5000, 'detail dialog close transition');
  }
  liveChecks.detailOpened = detail.opened === true && Boolean(detail.heading) && detail.episodeRows > 0;
  await evaluate(`document.querySelector('#seasonCalendarBack')?.click()`, 'return home from calendar');
  const returnedHome = await evaluate(`document.querySelector('#homeView')?.classList.contains('active')===true`, 'home route after calendar back');
  await evaluate(`document.querySelector('#seeAllSeason')?.click()`, 'reopen season calendar');
  await waitFor(async () => await evaluate(`(() => {const d=window.LilacSeasonCalendarDiagnostics;return Boolean(d&&['complete','partial','failed'].includes(d.state)&&document.querySelectorAll('#seasonCalendarGrid .season-calendar-day').length===7)})()`, 'calendar reentry completion'), 180000, 'calendar data after returning from home');
  let reentry = null, reentryCapture = '';
  await mainWindow.setContentSize(980, 760);
  await pause(350);
  const scrollBeforeBack = await evaluate(`(() => {const grid=document.querySelector('#seasonCalendarGrid');const max=Math.max(0,grid.scrollWidth-grid.clientWidth);grid.scrollLeft=Math.min(180,max);return {scrollLeft:grid.scrollLeft,max,viewport:innerWidth}})()`, 'set narrow calendar scroll before leaving');
  await evaluate(`document.querySelector('#seasonCalendarBack')?.click()`, 'return home from narrow calendar');
  await evaluate(`document.querySelector('#seeAllSeason')?.click()`, 'reopen narrow season calendar');
  await waitFor(async () => await evaluate(`(() => {const d=window.LilacSeasonCalendarDiagnostics;return Boolean(d&&['complete','partial','failed'].includes(d.state)&&document.querySelectorAll('#seasonCalendarGrid .season-calendar-day').length===7)})()`, 'calendar reentry completion'), 180000, 'calendar data after narrow return from home');
  reentry = await evaluate(`(() => ({viewport:innerWidth,scrollLeft:document.querySelector('#seasonCalendarGrid')?.scrollLeft||0,
    columns:document.querySelectorAll('#seasonCalendarGrid .season-calendar-day').length,
    cardCount:document.querySelectorAll('#seasonCalendarGrid .season-calendar-card').length,
    openDialogs:[...document.querySelectorAll('dialog[open]')].map(dialog=>dialog.id),
    playerMode:document.body.classList.contains('player-mode'),
    activeViews:[...document.querySelectorAll('.view.active')].map(view=>view.id),
    titleTooltipMatches:[...document.querySelectorAll('#seasonCalendarView [data-title-for]')].filter(node=>node.title===node.textContent.trim()).length,
    titleTooltipCount:document.querySelectorAll('#seasonCalendarView [data-title-for]').length}))()`, 'calendar reentry state');
  await pause(350);
  const reentryImage = await mainWindow.capturePage();
  reentryCapture = path.join(tempRoot, 'season-calendar-reentry-980.png'); fs.writeFileSync(reentryCapture, reentryImage.toPNG());
  await mainWindow.setContentSize(1440, 900);
  await evaluate(`document.querySelector('[data-view="all"]')?.click()`, 'open all view');
  await pause(1000);
  const allView = await evaluate(`(() => ({visible:document.querySelector('#allView')?.classList.contains('active')===true,
    filters:Boolean(document.querySelector('#catalogFilters')),status:document.querySelector('#allStatus')?.textContent||''}))()`, 'all view state');
  const targetProvider = homeAfterSchedule.source === 'miruro' ? 'reanime' : 'miruro';
  await evaluate(`(() => {const select=document.querySelector('#contentSource');select.value=${JSON.stringify(targetProvider)};select.dispatchEvent(new Event('change'))})()`, 'change the app content provider');
  await pause(1600);
  await waitFor(() => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.isLoading() === false,
    30000, 'app reload after changing the selected content provider');
  const sourceSwitch = await evaluate(`(() => ({
    selectedSource:document.querySelector('#contentSource')?.value||'',
    scheduleAnchorEmpty:document.querySelector('#scheduleSection')?.children.length===0,
    scheduleRailPresent:Boolean(document.querySelector('#scheduleRail')),
    weekdayTabsPresent:Boolean(document.querySelector('#scheduleTabs')),
    controllerPresent:Boolean(window.LilacWeeklySchedule),
    scheduleRequests:window.LilacProviderScheduleClient?.diagnostics?.().requests||0
  }))()`, 'selected-source schedule after app reload');
  liveChecks.sourceSwitchKeepsHomeClean = sourceSwitch.selectedSource === targetProvider && sourceSwitch.scheduleAnchorEmpty
    && !sourceSwitch.scheduleRailPresent && !sourceSwitch.weekdayTabsPresent && !sourceSwitch.controllerPresent
    && sourceSwitch.scheduleRequests === 0;
  const homeReady = Boolean(homeAfterSchedule.seasonCards && !homeAfterSchedule.seasonLoading
    && liveChecks.noDuplicateHomeScheduleUI && liveChecks.homeSeasonAndAllViewPreserved && liveChecks.noScheduleFetchOnHome);
  liveChecks.scrollPositionSurvivesRerender = scrollBeforeBack.scrollLeft > 0 && reentry.scrollLeft === scrollBeforeBack.scrollLeft;
  liveChecks.calendarReentryAt980 = reentry.viewport === 980 && reentry.columns === 7 && reentry.cardCount > 0;
  liveChecks.calendarReentryScreenSettled = reentry.openDialogs.length === 0 && !reentry.playerMode
    && reentry.activeViews.includes('searchView');
  liveChecks.calendarTitleTooltips = calendar.titleDisplay.tooltipMatches === calendar.titleDisplay.tooltipCount
    && reentry.titleTooltipMatches === reentry.titleTooltipCount;
  report = { ok: homeReady && calendar.columns === 7 && liveChecks.sourceSwitchKeepsHomeClean && liveChecks.providerReleaseBasis
      && liveChecks.providerScheduleResponseSuccess && liveChecks.voteEvidenceRecorded
      && liveChecks.actualWeekdayAssignment && liveChecks.catalogAccounting && liveChecks.catalogDuplicateCards
      && liveChecks.sourceEvidenceRecorded && liveChecks.scrollPositionSurvivesRerender && liveChecks.calendarReentryAt980
      && liveChecks.calendarReentryScreenSettled && liveChecks.calendarTitleTooltips
      && liveChecks.cardHoverStyle && liveChecks.keyboardFocusStyle,
    liveChecks, electronVersion: process.versions.electron, chromeVersion: process.versions.chrome,
    mainPid: process.pid, rendererPid: mainWindow.webContents.getOSProcessId(), executable: process.execPath,
    sourceUrl: mainWindow.webContents.getURL(), windowId: mainWindow.id, webContentsId: mainWindow.webContents.id,
    paths, homeReady, homeReadyProbeMs, before, initialDialogState, homeAfterSchedule, homeTitleVisible, homeVisual, sourceSwitch, loadingState,
    interactionLog: await evaluate(`({clicks:window.__scheduleHarnessClicks||[],dialogEvents:window.__scheduleHarnessDialogEvents||[],detailCalls:window.__scheduleHarnessDetailCalls||[]})`, 'calendar interaction log'),
    calendar, hoverState, focusState, scrollProbe, statusVisual, narrowCalendar, calendarCard, detail, returnedHome, reentry, scrollBeforeBack, allView,
    captures: { home: homeCapture, seasonRail: seasonRailCapture, loading: loadingCapture, calendar: calendarCapture,
      statusSections: statusCapture, narrowCalendar: narrowCapture, reentry: reentryCapture, detail: detail.capture || '' }, tempRoot };
  fs.writeFileSync(path.join(tempRoot, 'report.json'), JSON.stringify(report, null, 2));
  trace('inspect:completed', { reportPath: path.join(tempRoot, 'report.json') });
  console.log(`LIVE_SCHEDULE_REPORT ${JSON.stringify({
    ok: report.ok, liveChecks: report.liveChecks, electronVersion: report.electronVersion,
    window: { pid: report.mainPid, rendererPid: report.rendererPid, id: report.windowId, webContentsId: report.webContentsId },
    paths: report.paths, homeReady: report.homeReady, homeReadyProbeMs: report.homeReadyProbeMs,
    titles: { homeBeforeScroll: report.homeAfterSchedule.titleDisplay, homeVisible: report.homeTitleVisible, calendar: report.calendar.titleDisplay },
    calendarStyle: { cardWidth: report.calendar.cardWidth, posterRatio: report.calendar.posterRatio,
      titleFontSize: report.calendar.titleFontSize, titleLineClamp: report.calendar.titleLineClamp,
      titleWhiteSpace: report.calendar.titleWhiteSpace, overflowX: report.calendar.overflowX },
    schedule: { catalogCount: report.calendar.diagnostics.catalogCount, dayCounts: report.calendar.dayCounts,
      scheduleBasis: report.calendar.diagnostics.scheduleBasis,
      finalDayCounts: report.calendar.diagnostics.finalDayCounts,
      weeklyReleaseCount: report.calendar.diagnostics.weeklyReleaseCount,
      assignedCount: report.calendar.diagnostics.assignedCount, assignedCardCount: report.calendar.diagnostics.assignedCardCount,
      unverifiedWeeklyCount: report.calendar.diagnostics.unverifiedWeeklyCount,
      excludedCatalogCount: report.calendar.diagnostics.excludedCatalogCount,
      exclusionCounts: report.calendar.diagnostics.exclusionCounts,
      excludedScheduleRows: report.calendar.diagnostics.excludedScheduleRows?.length || 0,
      excludedBatchRows: report.calendar.diagnostics.excludedBatchRows?.length || 0,
      conflictCount: report.calendar.diagnostics.conflictCount, multiDayUnresolvedCount: report.calendar.diagnostics.multiDayUnresolvedCount,
      tieCount: report.calendar.diagnostics.tieCount,
      voteResults: (report.calendar.diagnostics.voteResults || []).map(result => ({ catalogId: result.catalogId, title: result.title,
        season: result.season, episode: result.episode, dayVotes: result.dayVotes, winnerDay: result.winnerDay,
        tie: result.tie, sourceVotes: result.sourceVotes, sourceConflicts: result.sourceConflicts })),
      sourceScheduleConflicts: report.calendar.diagnostics.sourceScheduleConflicts,
      sourceRelationships: report.calendar.diagnostics.sourceRelationships,
      providerEvidenceCounts: report.calendar.diagnostics.providerEvidenceCounts,
      providerSchedules: Object.fromEntries(Object.entries(report.calendar.diagnostics.providerSchedules || {}).map(([provider, source]) => [provider, {
        state: source.state, responseRows: source.responseRows, nativeRows: source.nativeRows,
        exactEpisodeRows: source.exactEpisodeRows, rowsWithoutEpisode: source.rowsWithoutEpisode,
        fallbackRows: source.fallbackRows, failedDays: source.failedDays, dayResults: source.dayResults
      }])),
      officialScheduleSupplementalCount: report.calendar.diagnostics.officialScheduleEvidence?.length || 0,
      duplicateCardIds: report.calendar.duplicateCardIds,
      duplicateRows: report.calendar.diagnostics.duplicateRows, unmatchedRows: report.calendar.diagnostics.unmatchedScheduleCount,
      sources: Object.fromEntries(Object.entries(report.calendar.diagnostics.sources || {}).map(([provider, source]) => [provider, {
        state: source.state, requestStarted: source.requestStarted, requestCount: source.requestCount,
        pageCount: source.pageCount, elapsedMs: source.elapsedMs, stage: source.stage,
        requestBodyBytes: source.requestBodyBytes, responseRows: source.responseRows,
        httpStatus: source.httpStatus, errorCode: source.errorCode, failureStage: source.failureStage,
        networkErrorCode: source.networkErrorCode
      }])) },
    detail: report.detail, returnedHome: report.returnedHome, allView: report.allView, tempRoot: report.tempRoot
  })}`);
  settled = true;
  app.quit();
}
app.whenReady().then(() => {
  trace('app:whenReady-resolved', { isReady: app.isReady() });
  return inspect();
}).catch(fail);
setTimeout(() => { if (!settled) fail(new Error('Real Electron schedule smoke exceeded 240 seconds')); }, 240000);
