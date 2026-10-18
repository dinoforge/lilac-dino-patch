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
app.on('browser-window-created', (_, win) => trace('window:created', { id: win.id, webContentsId: win.webContents.id }));

app.on('browser-window-created', (_, win) => {
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
  await pause(5000);
  const before = await evaluate(`(() => {
    const rail=document.querySelector('#seasonRail');
    return {
    source:document.querySelector('#contentSource')?.value||'',
    seasonCards:document.querySelectorAll('#seasonRail .anime-card').length,
    seasonLoading:rail?.classList.contains('loading-cards')||false,
    quarterStatus:document.querySelector('#quarterStatus')?.textContent||'',
    weeklyVisible:!document.querySelector('#scheduleSection')?.classList.contains('hidden'),
    weeklyTabs:document.querySelector('#scheduleTabs')?.children.length||0,
    weeklyStatus:document.querySelector('#scheduleStatus')?.textContent||'',
    allViewPreserved:Boolean(document.querySelector('#allView #catalogFilters'))
  }})()`, 'home state');
  trace('inspect:initial-home-state', before);
  if (before.weeklyTabs !== 7) {
    await evaluate(`window.LilacWeeklySchedule?.refresh()`, 'refresh weekly schedule');
  }
  await pause(26000);
  const homeAfterSchedule = await evaluate(`(() => ({
    source:document.querySelector('#contentSource')?.value||'',
    seasonCards:document.querySelectorAll('#seasonRail .anime-card').length,
    seasonLoading:document.querySelector('#seasonRail')?.classList.contains('loading-cards')||false,
    quarterStatus:document.querySelector('#quarterStatus')?.textContent||'',
    weeklyVisible:!document.querySelector('#scheduleSection')?.classList.contains('hidden'),
    weeklyTabs:document.querySelector('#scheduleTabs')?.children.length||0,
    weeklyStatus:document.querySelector('#scheduleStatus')?.textContent||'',
    weeklyCards:document.querySelectorAll('#scheduleRail .schedule-show').length,
    allViewPreserved:Boolean(document.querySelector('#allView #catalogFilters'))
  }))()`, 'home state after schedule');
  trace('inspect:home-after-schedule', homeAfterSchedule);
  const homeImage = await mainWindow.capturePage();
  const homeCapture = path.join(tempRoot, 'app-home.png'); fs.writeFileSync(homeCapture, homeImage.toPNG());
  await evaluate(`document.querySelector('#seasonRail')?.scrollIntoView({block:'center',behavior:'instant'})`, 'scroll to season rail');
  await pause(300);
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
  await waitFor(async () => await evaluate(`(() => {const d=window.LilacSeasonCalendarDiagnostics;return Boolean(d&&['complete','partial','failed','historical-not-supported'].includes(d.state))})()`, 'calendar completion probe'), 125000, 'provider-site week schedule requests to settle');
  const calendar = await evaluate(`(() => {
    const grid=document.querySelector('#seasonCalendarGrid'),diag=window.LilacSeasonCalendarDiagnostics||{};
    const columns=[...document.querySelectorAll('#seasonCalendarGrid .season-calendar-day')],card=document.querySelector('#seasonCalendarGrid .season-calendar-card'),poster=card?.querySelector('.season-calendar-poster');
    return {visible:!document.querySelector('#seasonCalendarView')?.classList.contains('hidden'),
      columns:grid?.querySelectorAll('.season-calendar-day').length||0,
      dayCounts:columns.map(column=>({day:column.querySelector('h2')?.textContent||'',count:column.querySelectorAll('.season-calendar-card').length})),
      unknownTitle:document.querySelector('#seasonCalendarUnknownTitle')?.textContent||'',
      unknownCount:Number(document.querySelector('#seasonCalendarUnknownCount')?.textContent?.match(/\\d+/)?.[0]||0),
      conflictCount:Number(document.querySelector('#seasonCalendarConflictCount')?.textContent?.match(/\\d+/)?.[0]||0),
      clientWidth:grid?.clientWidth||0,scrollWidth:grid?.scrollWidth||0,overflowX:grid?getComputedStyle(grid).overflowX:'',
      cardWidth:card?.getBoundingClientRect().width||0,posterRatio:poster?getComputedStyle(poster).aspectRatio:'',
      posterRadius:poster?getComputedStyle(poster).borderRadius:'',titleFontSize:card?getComputedStyle(card.querySelector('h3')).fontSize:'',
      cardRadius:card?getComputedStyle(card).borderRadius:'',cardGap:grid?getComputedStyle(grid).gap:'',
      openDialogs:[...document.querySelectorAll('dialog[open]')].map(dialog=>dialog.id||dialog.getAttribute('aria-label')||'unnamed'),
      status:document.querySelector('#seasonCalendarStatus')?.textContent||'',diagnostics:diag};
  })()`, 'calendar state');
  const providerScheduleResponseSuccess = Object.values(calendar.diagnostics.sources || {}).some(source => source.successfulDays > 0 && source.responseRows > 0);
  const catalogAccounting = calendar.diagnostics.assignedCount + calendar.diagnostics.unknownCount
    + calendar.diagnostics.conflictCount + calendar.diagnostics.multiDayUnresolvedCount === calendar.diagnostics.catalogCount;
  const liveChecks = {
    providerSiteBasis: calendar.diagnostics.scheduleBasis === 'provider-site'
      && document.querySelector('#seasonCalendarSubtitle')?.textContent.includes('공급 사이트 일정 기준') === true,
    providerScheduleResponseSuccess,
    actualWeekdayAssignment: calendar.diagnostics.assignedCount > 0,
    catalogAccounting,
    sourceEvidenceRecorded: Array.isArray(calendar.diagnostics.scheduleEvidence)
      && Array.isArray(calendar.diagnostics.unmatchedScheduleRows),
    detailOpened: false
  };
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
    mainWindow.setSize(900, 760);
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
  finally { if (!mainWindow.isDestroyed()) mainWindow.setSize(1440, 900); }
  const calendarCard = await evaluate(`(() => {const card=document.querySelector('#seasonCalendarGrid .season-calendar-card');if(!card)return null;const id=card.dataset.id;const anime=typeof animeById==='function'?animeById(id):null;const data={id,title:card.querySelector('h3')?.textContent?.trim()||'',provider:anime?.provider||'',sourceId:anime?.id||'',year:anime?.year||null,type:anime?.type||'',urlHost:anime?.url?new URL(anime.url).hostname:''};card.click();return data})()`, 'calendar poster click');
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
      await pause(500);
      const detailImage = await Promise.race([mainWindow.capturePage(), pause(8000).then(() => { throw new Error('detail capture timed out'); })]);
      detail.capture = path.join(tempRoot, 'season-calendar-detail.png'); fs.writeFileSync(detail.capture, detailImage.toPNG());
    } catch (error) { detail.error = error.message; }
    await evaluate(`document.querySelector('#detailDialog .dialog-close')?.click()`, 'close detail dialog');
  }
  liveChecks.detailOpened = detail.opened === true && Boolean(detail.heading) && detail.episodeRows > 0;
  await evaluate(`document.querySelector('#seasonCalendarBack')?.click()`, 'return home from calendar');
  const returnedHome = await evaluate(`document.querySelector('#homeView')?.classList.contains('active')===true`, 'home route after calendar back');
  await evaluate(`document.querySelector('[data-view="all"]')?.click()`, 'open all view');
  await pause(1000);
  const allView = await evaluate(`(() => ({visible:document.querySelector('#allView')?.classList.contains('active')===true,
    filters:Boolean(document.querySelector('#catalogFilters')),status:document.querySelector('#allStatus')?.textContent||''}))()`, 'all view state');
  const homeReady = Boolean(homeAfterSchedule.seasonCards && !homeAfterSchedule.seasonLoading && homeAfterSchedule.weeklyTabs === 7);
  report = { ok: homeReady && calendar.columns === 7 && liveChecks.providerSiteBasis && liveChecks.providerScheduleResponseSuccess
      && liveChecks.actualWeekdayAssignment && liveChecks.catalogAccounting && liveChecks.sourceEvidenceRecorded,
    liveChecks, electronVersion: process.versions.electron, chromeVersion: process.versions.chrome,
    mainPid: process.pid, rendererPid: mainWindow.webContents.getOSProcessId(), executable: process.execPath,
    sourceUrl: mainWindow.webContents.getURL(), windowId: mainWindow.id, webContentsId: mainWindow.webContents.id,
    paths, homeReady, before, initialDialogState, homeAfterSchedule, homeVisual, loadingState,
    interactionLog: await evaluate(`({clicks:window.__scheduleHarnessClicks||[],dialogEvents:window.__scheduleHarnessDialogEvents||[],detailCalls:window.__scheduleHarnessDetailCalls||[]})`, 'calendar interaction log'),
    calendar, scrollProbe, statusVisual, narrowCalendar, calendarCard, detail, returnedHome, allView,
    captures: { home: homeCapture, seasonRail: seasonRailCapture, loading: loadingCapture, calendar: calendarCapture, statusSections: statusCapture, narrowCalendar: narrowCapture, detail: detail.capture || '' }, tempRoot };
  fs.writeFileSync(path.join(tempRoot, 'report.json'), JSON.stringify(report, null, 2));
  trace('inspect:completed', { reportPath: path.join(tempRoot, 'report.json') });
  console.log(`LIVE_SCHEDULE_REPORT ${JSON.stringify(report)}`);
  settled = true;
  app.quit();
}
app.whenReady().then(() => {
  trace('app:whenReady-resolved', { isReady: app.isReady() });
  return inspect();
}).catch(fail);
setTimeout(() => { if (!settled) fail(new Error('Real Electron schedule smoke exceeded 240 seconds')); }, 240000);
