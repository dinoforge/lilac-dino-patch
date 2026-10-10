'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');

let appRef;
let mainWindow;
let fixtureAgent;
let runStarted = false;
let runFinished = false;
let runFailed = false;
let browserBlockedRequests = 0;
let mainBlockedRequests = 0;

function log(event, details = {}) {
  const target = process.env.LILAC_RUNTIME_ATTACH_LOG;
  if (!target) return;
  fs.appendFileSync(target, JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n', 'utf8');
}

function failClosed(api) {
  mainBlockedRequests += 1;
  log('blocked-main-network-api', { api });
  const error = new Error('Runtime attach test blocks all network access (' + api + ').');
  error.code = 'LILAC_RUNTIME_ATTACH_NETWORK_BLOCKED';
  return error;
}

function disableMainProcessNetwork(net) {
  const rejectFetch = api => (...args) => Promise.reject(failClosed(api));
  globalThis.fetch = rejectFetch('global.fetch');
  if (typeof net.fetch === 'function') net.fetch = rejectFetch('electron.net.fetch');
  if (typeof net.request === 'function') net.request = (...args) => { throw failClosed('electron.net.request'); };

  for (const moduleName of ['node:http', 'node:https']) {
    const client = require(moduleName);
    if (typeof client.request === 'function') client.request = (...args) => { throw failClosed(moduleName + '.request'); };
    if (typeof client.get === 'function') client.get = (...args) => { throw failClosed(moduleName + '.get'); };
  }
}

function configure(options) {
  const { app, session, net } = options;
  appRef = app;
  const tempRoot = path.resolve(process.env.LILAC_RUNTIME_ATTACH_TEMP || '');
  const profileRoot = path.resolve(process.env.LILAC_RUNTIME_ATTACH_PROFILE || '');
  const sourceRoot = path.resolve(process.env.LILAC_RUNTIME_ATTACH_SOURCE || '');
  if (!tempRoot || !profileRoot || !sourceRoot || !fs.existsSync(sourceRoot)) {
    throw new Error('The isolated test source/profile paths are not configured.');
  }
  if (!profileRoot.startsWith(tempRoot + path.sep) || !sourceRoot.startsWith(tempRoot + path.sep)) {
    throw new Error('Test source and profile must remain inside the unique temporary root.');
  }

  app.setName('LilacAnime Runtime Attach Test');
  for (const [key, suffix] of [
    ['userData', 'profile/userData'],
    ['sessionData', 'profile/sessionData'],
    ['cache', 'profile/cache'],
    ['logs', 'profile/logs'],
    ['crashDumps', 'profile/crashDumps']
  ]) {
    const value = path.join(tempRoot, suffix);
    fs.mkdirSync(value, { recursive: true });
    app.setPath(key, value);
  }

  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-sync');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
  disableMainProcessNetwork(net);

  app.whenReady().then(() => {
    const guard = session.defaultSession.webRequest;
    guard.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      let protocol = '';
      try { protocol = new URL(details.url).protocol; } catch {}
      if (['http:', 'https:', 'ws:', 'wss:', 'ftp:'].includes(protocol)) {
        browserBlockedRequests += 1;
        let host = '';
        try { host = new URL(details.url).hostname; } catch {}
        log('blocked-renderer-network-request', { protocol, host });
        callback({ cancel: true });
        return;
      }
      callback({});
    });
    log('network-guard-ready', {
      browserSchemesBlocked: ['http:', 'https:', 'ws:', 'wss:', 'ftp:'],
      mainFetchAndElectronNetBlocked: true,
      chromiumHostResolutionBlocked: true,
      debuggerTcpPort: false
    });
  }).catch(error => failTest(error));
}

function evaluate(expression) {
  return mainWindow.webContents.debugger.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  }).then(response => {
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text || 'Renderer evaluation failed.');
    }
    return response.result && response.result.value;
  });
}

function startFixtureAgent() {
  const node = process.env.LILAC_RUNTIME_ATTACH_NODE;
  const script = process.env.LILAC_RUNTIME_ATTACH_AGENT;
  if (!node || !script || !fs.existsSync(script)) throw new Error('Companion fixture agent is unavailable.');
  fixtureAgent = spawn(node, [script], {
    cwd: process.env.LILAC_RUNTIME_ATTACH_REPO,
    env: process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const output = readline.createInterface({ input: fixtureAgent.stdout, crlfDelay: Infinity });
  const errors = readline.createInterface({ input: fixtureAgent.stderr, crlfDelay: Infinity });
  errors.on('line', line => log('fixture-agent-stderr', { line: String(line).slice(0, 300) }));
  output.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { log('fixture-agent-invalid-output'); return; }
    if (message.type === 'fixture') fixtureAgent.fixture = message;
    else if (message.type === 'fixture-error') fixtureAgent.fixtureError = message.message;
    else if (message.type === 'stopped') fixtureAgent.stopped = message.graceful === true;
  });
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (fixtureAgent.fixture) {
        clearInterval(poll);
        resolve(fixtureAgent.fixture);
      } else if (fixtureAgent.fixtureError || fixtureAgent.exitCode !== null || Date.now() - started > 15000) {
        clearInterval(poll);
        reject(new Error(fixtureAgent.fixtureError || 'Timed out waiting for Companion fixture data.'));
      }
    }, 25);
    fixtureAgent.once('exit', (code, signal) => {
      fixtureAgent.exitCode = code;
      fixtureAgent.exitSignal = signal;
    });
    fixtureAgent.once('error', error => {
      clearInterval(poll);
      reject(error);
    });
  });
}

function requestAgentShutdown() {
  if (!fixtureAgent || fixtureAgent.exitCode !== null) return Promise.resolve({ exitCode: fixtureAgent && fixtureAgent.exitCode, graceful: true });
  fixtureAgent.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Companion fixture agent did not exit gracefully.')), 10000);
    fixtureAgent.once('exit', (code, signal) => {
      clearTimeout(timeout);
      fixtureAgent.exitCode = code;
      fixtureAgent.exitSignal = signal;
      resolve({ exitCode: code, signal, graceful: code === 0 });
    });
  });
}

async function setViewport(width, height) {
  await mainWindow.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height
  });
  const viewport = await evaluate('({ width: window.innerWidth, height: window.innerHeight })');
  if (!viewport || viewport.width !== width || viewport.height !== height) throw new Error('CDP viewport mismatch: ' + width + 'x' + height);
}

async function waitForPaint() {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

async function alignScheduleForCapture() {
  await evaluate('(() => {const main=document.querySelector("main"),section=document.getElementById("scheduleSection");if(!main||!section)return false;main.scrollTop=Math.max(0,main.scrollTop+section.getBoundingClientRect().top-92);return true;})()');
  await waitForPaint();
}

async function verifyCompanionCardCanScrollIntoView(viewportName) {
  await evaluate('document.querySelector("#lilac-companion-weekday-cards .anime-card")?.scrollIntoView({block:"center",inline:"nearest"})');
  await waitForPaint();
  const visible = await evaluate('(() => {const card=document.querySelector("#lilac-companion-weekday-cards .anime-card"),poster=card?.querySelector(".poster"),heading=card?.querySelector("h3"),header=document.querySelector(".topbar");if(!card||!poster||!heading)return {ok:false};const r=card.getBoundingClientRect(),p=poster.getBoundingClientRect(),h=header?.getBoundingClientRect();return {ok:r.height>0&&r.top>=(h?.bottom||0)-1&&r.bottom<=innerHeight+1,card:{top:Math.round(r.top),bottom:Math.round(r.bottom),height:Math.round(r.height)},poster:{top:Math.round(p.top),bottom:Math.round(p.bottom),height:Math.round(p.height)},title:heading.textContent};})()');
  if (!visible || visible.ok !== true) throw new Error('The Companion card could not be scrolled fully into view at ' + viewportName + '.');
  log('companion-card-scroll-reveal-verified', { viewport: viewportName, ...visible });
}

async function captureScreenshot(name) {
  const paths = JSON.parse(process.env.LILAC_RUNTIME_ATTACH_SCREENSHOTS || '{}');
  const relatives = JSON.parse(process.env.LILAC_RUNTIME_ATTACH_SCREENSHOT_RELATIVES || '{}');
  const target = paths[name];
  const repoRoot = path.resolve(process.env.LILAC_RUNTIME_ATTACH_REPO || '');
  if (!target || !repoRoot || !path.resolve(target).startsWith(repoRoot + path.sep)) throw new Error('Screenshot destination is missing or outside the experiment checkout: ' + name);
  const response = await mainWindow.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const png = Buffer.from(response.data || '', 'base64');
  if (png.length < 100 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('CDP did not return a valid PNG for ' + name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, png, { flag: 'wx' });
  const details = { path: relatives[name], width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length };
  log('renderer-screenshot-captured', { variant: name, ...details, capture: 'Page.captureScreenshot on isolated v0.5.14 renderer' });
  return details;
}

async function runProbe(win) {
  if (runStarted) return;
  runStarted = true;
  mainWindow = win;
  const expectedHtml = path.join(path.resolve(process.env.LILAC_RUNTIME_ATTACH_SOURCE), 'src', 'index.html');
  if (win.webContents.getURL() !== pathToFileURL(expectedHtml).href) throw new Error('Renderer URL does not point at the isolated v0.5.14 source copy.');

  win.showInactive();
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Runtime.enable');
  await win.webContents.debugger.sendCommand('Page.enable');
  const baseline = await evaluate('(() => { const changelog=document.getElementById("changelogDialog"); const startupChangelogWasOpen=Boolean(changelog&&changelog.open); if(startupChangelogWasOpen)document.getElementById("changelogClose")?.click(); const ids=["homeView","searchView","settingsView","detailDialog"]; const nodes=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)])); const section=document.getElementById("scheduleSection"),tabs=document.getElementById("scheduleTabs"),rail=document.getElementById("scheduleRail"),title=section?.querySelector(".section-title h2"),main=document.querySelector("main"); const ok=ids.every(id=>nodes[id])&&window.lilac&&typeof window.lilac.season==="function"&&section&&tabs&&rail&&title&&title.textContent.trim()==="방영 일정"; if(ok){window.__lilacRuntimeAttachRefs=nodes;window.__lilacRuntimeAttachNativeStyleState={home:nodes.homeView,section,tabs,rail,title,main,sectionWasHidden:section.classList.contains("hidden"),tabsWereHidden:tabs.classList.contains("hidden"),railWasHidden:rail.classList.contains("hidden"),originalThemeWasLight:document.body.classList.contains("light"),originalScrollTop:main?main.scrollTop:0,originalTabsHtml:tabs.innerHTML,originalRailHtml:rail.innerHTML,originalTitleText:title.textContent};document.body.classList.remove("light");section.classList.remove("hidden")} return {ok:Boolean(ok),title:document.title,protocol:location.protocol,homeActive:Boolean(nodes.homeView&&nodes.homeView.classList.contains("active")),originalIds:ids.filter(id=>nodes[id]),preloadBridge:Boolean(window.lilac),startupChangelogWasOpen,startupChangelogClosed:!changelog||!changelog.open,scheduleTitleReused:Boolean(title&&title.textContent.trim()==="방영 일정")}; })()');
  if (!baseline || baseline.ok !== true || baseline.protocol !== 'file:' || !baseline.startupChangelogClosed || !baseline.scheduleTitleReused) {
    throw new Error('Original v0.5.14 renderer anchors or schedule title were not present.');
  }
  log('original-startup-dialog-handled', { dialogWasOpen: baseline.startupChangelogWasOpen, closedThroughOriginalControl: baseline.startupChangelogClosed, originalHomeActive: baseline.homeActive });
  log('original-renderer-confirmed', {
    version: '0.5.14',
    renderer: 'isolated-source/src/index.html',
    originalIds: baseline.originalIds,
    preloadBridge: baseline.preloadBridge,
    originalScheduleTitle: '방영 일정',
    startupChangelogWasOpen: baseline.startupChangelogWasOpen,
    startupChangelogClosed: baseline.startupChangelogClosed,
    debuggerTransport: 'webContents.debugger in-process CDP'
  });

  const viewportSizes = [
    { name: '1440x900', width: 1440, height: 900, original: 'original-dark-1440x900', companion: 'companion-dark-1440x900' },
    { name: '1280x720', width: 1280, height: 720, original: 'original-dark-1280x720', companion: 'companion-dark-1280x720' },
    { name: '760x700', width: 760, height: 700, original: 'original-dark-760x700', companion: 'companion-dark-760x700' }
  ];
  const layoutExpression = '(() => { const section=document.getElementById("scheduleSection"),tabs=document.getElementById("scheduleTabs"),root=document.getElementById("lilac-companion-weekday-probe"),compTabs=document.getElementById("lilac-companion-weekday-tabs"),main=document.querySelector("main"); const rect=e=>{const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),right:Math.round(r.right),bottom:Math.round(r.bottom),width:Math.round(r.width),height:Math.round(r.height)}}; const sr=rect(section),hr=rect(section.closest("#homeView")),tabNode=root?compTabs:tabs,tr=rect(tabNode); const header=section.querySelector(".section-title").getBoundingClientRect(),cards=document.getElementById("lilac-companion-weekday-cards"); return {viewport:{width:innerWidth,height:innerHeight},section:sr,home:hr,tabs:tr,mainScrollTop:main?main.scrollTop:null,sectionInsideViewport:sr.x>=-1&&sr.right<=innerWidth+1,sectionInsideHome:sr.x>=hr.x-1&&sr.right<=hr.right+1,tabsFit:tabNode.scrollWidth<=tabNode.clientWidth+1,headerBeforeTabs:!root||header.bottom<=tabNode.getBoundingClientRect().top+1,tabsBeforeCards:!root||tabNode.getBoundingClientRect().bottom<=cards.getBoundingClientRect().top+1,pageHorizontalOverflow:document.documentElement.scrollWidth>innerWidth+1}; })()';
  const originalLayouts = {};
  for (const viewport of viewportSizes) {
    await setViewport(viewport.width, viewport.height);
    await alignScheduleForCapture();
    const layout = await evaluate(layoutExpression);
    if (!layout.sectionInsideViewport || !layout.sectionInsideHome || !layout.tabsFit) throw new Error('Original schedule layout did not fit at ' + viewport.name);
    originalLayouts[viewport.name] = layout;
    const screenshot = await captureScreenshot(viewport.original);
    log('original-schedule-layout-captured', { viewport: viewport.name, title: '방영 일정', companionPresent: false, layout, screenshot });
  }

  await setViewport(1440, 900);
  await alignScheduleForCapture();
  const nativeStyle = await evaluate('(() => { const home=document.getElementById("homeView"),section=document.getElementById("scheduleSection"),title=section.querySelector(".section-title h2"); const probe=document.createElement("div");probe.setAttribute("aria-hidden","true");probe.style.cssText="position:absolute;left:-10000px;top:0;visibility:hidden;width:"+Math.max(240,section.clientWidth-2*parseFloat(getComputedStyle(section).paddingLeft||0))+"px"; const tabs=document.createElement("div");tabs.className="chip-row";const idle=document.createElement("button");idle.type="button";idle.textContent="화";const selected=document.createElement("button");selected.type="button";selected.className="selected";selected.textContent="월";tabs.append(idle,selected); const rail=document.createElement("div");rail.className="poster-rail";const card=document.createElement("article");card.className="anime-card";const poster=document.createElement("div");poster.className="poster";const heading=document.createElement("h3");heading.textContent="테스트 작품";const meta=document.createElement("p");meta.textContent="월요일 · 1화";card.append(poster,heading,meta);rail.append(card);probe.append(tabs,rail);home.append(probe);const take=(el,names)=>{const s=getComputedStyle(el);return Object.fromEntries(names.map(name=>[name,s.getPropertyValue(name).trim()]))};const result={heading:take(title,["font-family","font-size","font-weight","color","margin","letter-spacing"]),tabRow:take(tabs,["display","flex-wrap","gap"]),tabIdle:take(idle,["font-family","font-size","font-weight","color","background-color","border-color","border-radius","min-height","padding"]),tabSelected:take(selected,["font-family","font-size","font-weight","color","background-color","border-color","border-radius","min-height","padding"]),rail:take(rail,["display","grid-auto-columns","gap","padding","overflow-x"]),card:take(card,["display","min-width","position"]),poster:take(poster,["aspect-ratio","border-radius","background-color","background-image"]),cardTitle:take(heading,["font-family","font-size","font-weight","color","margin"]),cardMeta:take(meta,["font-family","font-size","font-weight","color","margin"])};probe.remove();return result; })()');
  if (!nativeStyle) throw new Error('Native v0.5.14 computed style sampling failed.');
  log('original-native-style-baseline', {
    viewport: '1440x900',
    sourceSelectors: ['.content-section', '.section-title', '.chip-row button', '.poster-rail', '.anime-card', '.poster'],
    styleProbe: 'temporary offscreen sample using original classes; removed before screenshots',
    computedStyle: nativeStyle
  });

  const fixtureMessage = await startFixtureAgent();
  const days = fixtureMessage.days;
  if (fixtureMessage.synthetic !== true || fixtureMessage.source !== 'companion/core/catalog.cjs' || !Array.isArray(days) || days.length !== 7) {
    throw new Error('Companion did not supply the expected seven-day synthetic fixture.');
  }
  log('companion-data-received', {
    transport: 'local child-process stdio IPC',
    source: 'companion/core/catalog.cjs',
    synthetic: true,
    weekdays: days.length,
    works: days.reduce((sum, day) => sum + day.length, 0)
  });

  const labels = ['월', '화', '수', '목', '금', '토', '일'];
  const insertExpression = '(() => { const days=' + JSON.stringify(days) + ';const labels=' + JSON.stringify(labels) + ';' +
    'const state=window.__lilacRuntimeAttachNativeStyleState,section=document.getElementById("scheduleSection");if(!state||!section||document.getElementById("lilac-companion-weekday-probe"))return {ok:false};' +
    'const nativeTabs=document.getElementById("scheduleTabs"),nativeRail=document.getElementById("scheduleRail");' +
    'if(nativeTabs!==state.tabs||nativeRail!==state.rail||nativeTabs.innerHTML!==state.originalTabsHtml||nativeRail.innerHTML!==state.originalRailHtml)return {ok:false,reason:"original-schedule-changed"};' +
    'const style=document.createElement("style");style.id="lilac-companion-native-style";style.textContent=".lilac-companion-test-note{margin-left:8px;color:var(--muted);font-size:12px;font-weight:400}";document.head.append(style);' +
    'const titleArea=section.querySelector(".section-title>div"),title=section.querySelector(".section-title h2");if(!titleArea||!title||title.textContent.trim()!=="방영 일정")return {ok:false,reason:"native-title-missing"};' +
    'const note=document.createElement("small");note.className="lilac-companion-test-note";note.textContent="테스트 데이터";titleArea.append(note);' +
    'const root=document.createElement("div");root.id="lilac-companion-weekday-probe";root.setAttribute("role","region");root.setAttribute("aria-label","방영 일정 테스트 데이터");' +
    'const tabs=document.createElement("div");tabs.id="lilac-companion-weekday-tabs";tabs.className="chip-row";tabs.setAttribute("role","tablist");tabs.setAttribute("aria-label","요일 선택");' +
    'const cards=document.createElement("div");cards.id="lilac-companion-weekday-cards";cards.className="poster-rail";cards.setAttribute("role","list");cards.setAttribute("aria-live","polite");' +
    'let selected=(new Date().getDay()+6)%7;const statusLabels={playable:"재생 가능",provided:"제공 확인",missing:"미제공",checking:"확인 중",searching:"확인 중",failed:"확인 실패"};' +
    'function render(){tabs.querySelectorAll("button").forEach((button,index)=>{button.classList.toggle("selected",index===selected);button.setAttribute("aria-selected",String(index===selected))});cards.replaceChildren();cards.dataset.selectedWeekday=String(selected);const works=days[selected]||[];' +
    'if(!works.length){const empty=document.createElement("p");empty.className="rail-empty";empty.textContent="이 요일에 등록된 작품이 없습니다.";cards.append(empty);return}' +
    'for(const work of works){const card=document.createElement("article");card.className="anime-card";card.setAttribute("role","listitem");const poster=document.createElement("div");poster.className="poster";poster.setAttribute("role","img");poster.setAttribute("aria-label","포스터 이미지 없음");' +
    'const heading=document.createElement("h3");heading.className="companion-probe-title";heading.textContent=String(work.title||"제목 없음");' +
    'const meta=document.createElement("p");meta.textContent=[work.airingTime||"시간 미정",work.weekdayEpisodeNumber?String(work.weekdayEpisodeNumber)+"화":"회차 미정",work.season||""].filter(Boolean).join(" · ");' +
    'const sources=document.createElement("p");sources.className="companion-probe-sources";sources.textContent=(work.sources||[]).map(source=>String(source.name||"출처")+" "+(statusLabels[String(source.status)]||String(source.status||"상태 미정"))).join(" · ");card.append(poster,heading,meta,sources);cards.append(card)}}' +
    'labels.forEach((label,index)=>{const button=document.createElement("button");button.type="button";button.id="lilac-companion-weekday-"+index;button.dataset.weekday=String(index);button.dataset.today=String(index===selected);button.textContent=label;button.setAttribute("role","tab");button.setAttribute("aria-label",label+(index===selected?" (오늘)":""));button.setAttribute("aria-controls",cards.id);button.addEventListener("click",()=>{selected=index;render()});tabs.append(button)});' +
    'state.section.classList.remove("hidden");nativeTabs.classList.add("hidden");nativeRail.classList.add("hidden");root.append(tabs,cards);section.insertBefore(root,nativeTabs);state.root=root;state.note=note;state.style=style;render();' +
    'const rect=root.getBoundingClientRect(),visible=rect.width>0&&rect.height>0&&rect.top<innerHeight&&rect.bottom>0;' +
    'return {ok:true,count:tabs.children.length,selected,selectedTitle:cards.querySelector(".companion-probe-title")?.textContent||"",sourceCount:(days.flat().find(work=>work.sources?.length)?.sources||[]).length,homeContains:state.home.contains(root),insideOriginalSchedule:section.contains(root),title:title.textContent.trim(),' +
    'nativeTabsSame:nativeTabs===state.tabs,nativeRailSame:nativeRail===state.rail,nativeMarkupUnchanged:nativeTabs.innerHTML===state.originalTabsHtml&&nativeRail.innerHTML===state.originalRailHtml,' +
    'nativeScheduleHidden:getComputedStyle(nativeTabs).display==="none"&&getComputedStyle(nativeRail).display==="none",' +
    'noFakePoster:!cards.querySelector(".poster").style.backgroundImage&&getComputedStyle(cards.querySelector(".poster")).backgroundImage==="none",visible,bounds:{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height),viewportWidth:innerWidth,viewportHeight:innerHeight}}; })()';
  const inserted = await evaluate(insertExpression);
  if (!inserted || inserted.ok !== true || inserted.count !== 7 || inserted.sourceCount !== 5 || !inserted.homeContains ||
      !inserted.insideOriginalSchedule || !inserted.nativeMarkupUnchanged || !inserted.nativeScheduleHidden ||
      !inserted.noFakePoster || !inserted.visible || inserted.title !== '방영 일정') {
    throw new Error('The native-style Companion schedule was not inserted into the original schedule without replacing its nodes.');
  }
  log('weekday-ui-inserted', {
    actualRenderer: true,
    anchor: '#homeView #scheduleSection, after its existing .section-title',
    reusedNativeHeading: inserted.title,
    buttons: inserted.count,
    selectedDay: labels[inserted.selected],
    selectedTitle: inserted.selectedTitle,
    providerRows: inserted.sourceCount,
    nativeNodesRetained: inserted.nativeTabsSame && inserted.nativeRailSame,
    nativeMarkupUnchanged: inserted.nativeMarkupUnchanged,
    nativeScheduleTemporarilyHiddenToPreventDuplicates: inserted.nativeScheduleHidden,
    syntheticPosterHasNoFabricatedImage: inserted.noFakePoster,
    actuallyVisibleInViewport: inserted.visible,
    bounds: inserted.bounds
  });

  const selectionResults = [];
  for (let index = 0; index < labels.length; index += 1) {
    const state = await evaluate('(() => { const button=document.getElementById("lilac-companion-weekday-' + index + '");if(!button)return null;button.click();const panel=document.getElementById("lilac-companion-weekday-cards");const sources=panel.querySelector(".companion-probe-sources")?.textContent||"";return {selected:Number(panel.dataset.selectedWeekday),title:panel.querySelector(".companion-probe-title")?.textContent||"",pressed:button.getAttribute("aria-selected"),sourceText:sources};})()');
    if (!state || state.selected !== index || state.pressed !== 'true' || !state.title || state.sourceText.split(' · ').length !== 5) {
      throw new Error('Weekday or synthetic provider-status interaction failed for ' + labels[index] + '.');
    }
    selectionResults.push({ day: labels[index], title: state.title, providerStatuses: state.sourceText.split(' · ') });
  }
  const todayIndex = (new Date().getDay() + 6) % 7;
  const todayState = await evaluate('(() => { const button=document.getElementById("lilac-companion-weekday-' + todayIndex + '");button?.click();const panel=document.getElementById("lilac-companion-weekday-cards");return {selected:Number(panel.dataset.selectedWeekday),pressed:button?.getAttribute("aria-selected")};})()');
  if (!todayState || todayState.selected !== todayIndex || todayState.pressed !== 'true') throw new Error('Today was not selected by default and restored after interaction.');
  log('weekday-selection-verified', { choices: selectionResults, todaySelectedByDefault: labels[inserted.selected] === labels[todayIndex] });

  const actualStyle = await evaluate('(() => {const section=document.getElementById("scheduleSection"),tabs=document.getElementById("lilac-companion-weekday-tabs"),rail=document.getElementById("lilac-companion-weekday-cards");const idle=[...tabs.querySelectorAll("button")].find(button=>!button.classList.contains("selected")),selected=tabs.querySelector(".selected");const card=rail.querySelector(".anime-card"),poster=card?.querySelector(".poster"),title=card?.querySelector("h3"),meta=card?.querySelector("p");const take=(el,names)=>{const s=getComputedStyle(el);return Object.fromEntries(names.map(name=>[name,s.getPropertyValue(name).trim()]))};const root=rail.closest("#lilac-companion-weekday-probe");return {heading:take(section.querySelector(".section-title h2"),["font-family","font-size","font-weight","color","margin","letter-spacing"]),tabRow:take(tabs,["display","flex-wrap","gap"]),tabIdle:take(idle,["font-family","font-size","font-weight","color","background-color","border-color","border-radius","min-height","padding"]),tabSelected:take(selected,["font-family","font-size","font-weight","color","background-color","border-color","border-radius","min-height","padding"]),rail:take(rail,["display","grid-auto-columns","gap","padding","overflow-x"]),card:take(card,["display","min-width","position"]),poster:take(poster,["aspect-ratio","border-radius","background-color","background-image"]),cardTitle:take(title,["font-family","font-size","font-weight","color","margin"]),cardMeta:take(meta,["font-family","font-size","font-weight","color","margin"]),inlineStyleCount:[root,tabs,rail,card,poster,title,meta].filter(element=>element?.hasAttribute("style")).length};})()');
  const equalFields = (left, right, fields) => fields.every(field => left && right && left[field] === right[field]);
  const styleComparison = {
    heading: equalFields(nativeStyle.heading, actualStyle.heading, ['font-family', 'font-size', 'font-weight', 'color', 'margin', 'letter-spacing']),
    weekdayRow: equalFields(nativeStyle.tabRow, actualStyle.tabRow, ['display', 'flex-wrap', 'gap']),
    weekdayButtonIdle: equalFields(nativeStyle.tabIdle, actualStyle.tabIdle, ['font-family', 'font-size', 'font-weight', 'color', 'background-color', 'border-color', 'border-radius', 'min-height', 'padding']),
    weekdayButtonSelected: equalFields(nativeStyle.tabSelected, actualStyle.tabSelected, ['font-family', 'font-size', 'font-weight', 'color', 'background-color', 'border-color', 'border-radius', 'min-height', 'padding']),
    posterRail: equalFields(nativeStyle.rail, actualStyle.rail, ['display', 'grid-auto-columns', 'gap', 'padding', 'overflow-x']),
    animeCard: equalFields(nativeStyle.card, actualStyle.card, ['display', 'min-width', 'position']),
    poster: equalFields(nativeStyle.poster, actualStyle.poster, ['aspect-ratio', 'border-radius', 'background-color', 'background-image']),
    cardTitle: equalFields(nativeStyle.cardTitle, actualStyle.cardTitle, ['font-family', 'font-size', 'font-weight', 'color', 'margin']),
    cardMeta: equalFields(nativeStyle.cardMeta, actualStyle.cardMeta, ['font-family', 'font-size', 'font-weight', 'color', 'margin']),
    noInlineWidgetStyles: actualStyle.inlineStyleCount === 0
  };
  log('native-style-comparison', { originalSelectors: ['.chip-row', '.poster-rail', '.anime-card', '.poster'], computedStyle: actualStyle, comparison: styleComparison });
  if (Object.values(styleComparison).some(matches => !matches)) throw new Error('Companion computed styles differ from original v0.5.14 classes.');

  const themeExpression = '(() => {const body=getComputedStyle(document.body),button=getComputedStyle(document.querySelector("#lilac-companion-weekday-tabs button:not(.selected)"));return {mode:document.body.classList.contains("light")?"light":"dark",variables:Object.fromEntries(["--bg","--panel","--text","--muted","--line","--lilac"].map(key=>[key,body.getPropertyValue(key).trim()])),button:{color:button.color,backgroundColor:button.backgroundColor,borderColor:button.borderColor}};})()';
  const darkTheme = await evaluate(themeExpression);
  const companionLayouts = {};
  for (const viewport of viewportSizes) {
    await setViewport(viewport.width, viewport.height);
    const baselineScrollTop = originalLayouts[viewport.name].mainScrollTop;
    await evaluate('(() => {const main=document.querySelector("main");if(main)main.scrollTop=' + Number(baselineScrollTop) + ';return main?.scrollTop;})()');
    await waitForPaint();
    const layout = await evaluate(layoutExpression);
    const originalLayout = originalLayouts[viewport.name];
    if (!layout.sectionInsideViewport || !layout.sectionInsideHome || !layout.tabsFit || !layout.headerBeforeTabs || !layout.tabsBeforeCards ||
        (originalLayout && !originalLayout.pageHorizontalOverflow && layout.pageHorizontalOverflow)) {
      throw new Error('Companion schedule overlaps or overflows at ' + viewport.name);
    }
    companionLayouts[viewport.name] = layout;
    const screenshot = await captureScreenshot(viewport.companion);
    log('companion-layout-verified', {
      viewport: viewport.name,
      layout,
      originalLayout,
      noNewPageHorizontalOverflow: !layout.pageHorizontalOverflow || Boolean(originalLayout.pageHorizontalOverflow),
      screenshot
    });
    await verifyCompanionCardCanScrollIntoView(viewport.name);
  }

  await setViewport(1440, 900);
  await evaluate('(() => {const main=document.querySelector("main");if(main)main.scrollTop=' + Number(originalLayouts['1440x900'].mainScrollTop) + ';return main?.scrollTop;})()');
  await waitForPaint();
  await evaluate('document.body.classList.add("light")');
  await waitForPaint();
  const lightTheme = await evaluate(themeExpression);
  if (lightTheme.mode !== 'light' || darkTheme.mode !== 'dark' ||
      lightTheme.variables['--bg'] === darkTheme.variables['--bg'] ||
      lightTheme.variables['--panel'] === darkTheme.variables['--panel'] ||
      lightTheme.variables['--text'] === darkTheme.variables['--text'] ||
      lightTheme.variables['--line'] === darkTheme.variables['--line']) {
    throw new Error('Original light/dark CSS variables did not flow into the Companion area.');
  }
  const lightScreenshot = await captureScreenshot('companion-light-1440x900');
  log('native-theme-inheritance-verified', { darkTheme, lightTheme, screenshot: lightScreenshot });

  const stopped = await requestAgentShutdown();
  if (!stopped.graceful || stopped.exitCode !== 0) throw new Error('Companion fixture process did not shut down cleanly.');
  log('companion-shutdown', { exitCode: stopped.exitCode, graceful: true });

  const removed = await evaluate('(() => {const state=window.__lilacRuntimeAttachNativeStyleState;if(!state)return {ok:false};const root=state.root,note=state.note,style=state.style,buttons=root?[...root.querySelectorAll("button")]:[];root?.remove();note?.remove();style?.remove();for(const [node,wasHidden] of [[state.section,state.sectionWasHidden],[state.tabs,state.tabsWereHidden],[state.rail,state.railWasHidden]])node.classList.toggle("hidden",wasHidden);document.body.classList.toggle("light",state.originalThemeWasLight);if(state.main)state.main.scrollTop=state.originalScrollTop;const refs=window.__lilacRuntimeAttachRefs||{};const sameOriginalNodes=refs.homeView===document.getElementById("homeView")&&refs.searchView===document.getElementById("searchView")&&refs.settingsView===document.getElementById("settingsView")&&refs.detailDialog===document.getElementById("detailDialog")&&state.section===document.getElementById("scheduleSection")&&state.tabs===document.getElementById("scheduleTabs")&&state.rail===document.getElementById("scheduleRail")&&state.title===document.querySelector("#scheduleSection .section-title h2");const originalMarkupRestored=state.tabs.innerHTML===state.originalTabsHtml&&state.rail.innerHTML===state.originalRailHtml;const originalVisibilityRestored=state.section.classList.contains("hidden")===state.sectionWasHidden&&state.tabs.classList.contains("hidden")===state.tabsWereHidden&&state.rail.classList.contains("hidden")===state.railWasHidden;const companionDetached=!document.getElementById("lilac-companion-weekday-probe")&&!document.getElementById("lilac-companion-native-style")&&!document.querySelector(".lilac-companion-test-note")&&buttons.every(button=>!document.documentElement.contains(button));const themeRestored=document.body.classList.contains("light")===state.originalThemeWasLight;const scrollRestored=!state.main||Math.abs(state.main.scrollTop-state.originalScrollTop)<2;const headingRestored=state.title.textContent.trim()===state.originalTitleText;const result={ok:sameOriginalNodes&&originalMarkupRestored&&originalVisibilityRestored&&companionDetached&&themeRestored&&scrollRestored&&headingRestored,sameOriginalNodes,originalMarkupRestored,originalVisibilityRestored,companionDetached,themeRestored,scrollRestored,headingRestored,sectionWasHidden:state.sectionWasHidden,tabsWereHidden:state.tabsWereHidden,railWasHidden:state.railWasHidden,scrollTop:state.main?.scrollTop};delete window.__lilacRuntimeAttachRefs;delete window.__lilacRuntimeAttachNativeStyleState;return result;})()');
  if (!removed || removed.ok !== true) throw new Error('Companion UI or temporary host display changes were not completely restored.');
  await win.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
  if (!win.webContents.debugger.isAttached()) throw new Error('Debugger detached before UI removal was verified.');
  log('companion-ui-removed-and-host-restored', { ...removed, debuggerStillAttached: true });
  win.webContents.debugger.detach();
  if (win.webContents.debugger.isAttached()) throw new Error('The in-process debugging attachment remained active.');
  log('debugger-detached-after-ui-removal', { removed: true, debuggerAttached: false });

  const search = await win.webContents.executeJavaScript('(() => { document.querySelector("nav .nav[data-view=search]").click(); return { active: document.getElementById("searchView").classList.contains("active"), input: Boolean(document.querySelector("#searchView input, #searchView [type=search]")) }; })()');
  const settings = await win.webContents.executeJavaScript('(() => { document.querySelector("nav .nav[data-view=settings]").click(); return { active: document.getElementById("settingsView").classList.contains("active"), theme: Boolean(document.getElementById("themeChoices")) }; })()');
  const detail = await win.webContents.executeJavaScript('(() => { const dialog = document.getElementById("detailDialog"); dialog.showModal(); const opened = dialog.open; dialog.close(); return { opened, closed: !dialog.open, content: Boolean(document.getElementById("detailContent")) }; })()');
  await win.webContents.executeJavaScript('document.querySelector("nav .nav[data-view=home]").click()');
  if (!search.active || !search.input || !settings.active || !settings.theme || !detail.opened || !detail.closed || !detail.content) {
    throw new Error('One or more original search/detail/settings UI checks failed after detaching.');
  }
  if (win.isDestroyed() || win.webContents.isLoadingMainFrame()) throw new Error('The original app window did not remain healthy after detaching.');
  log('original-ui-and-app-health-verified', {
    searchNavigation: search.active,
    searchInputPresent: search.input,
    settingsNavigation: settings.active,
    settingsControlsPresent: settings.theme,
    detailDialogOpenedAndClosed: detail.opened && detail.closed,
    appWindowAlive: !win.isDestroyed(),
    blockedBrowserRequests: browserBlockedRequests,
    blockedMainRequests: mainBlockedRequests
  });

  runFinished = true;
  clearTimeout(watchdog);
  log('result', {
    status: 'passed',
    companionInsertedIntoExistingSchedule: true,
    nativeStylesMatchedComputedSamples: true,
    daySelectionVerified: labels.length,
    lightAndDarkInheritanceVerified: true,
    multipleViewportsVerified: Object.keys(companionLayouts),
    uiInsertedIntoActualRenderer: true,
    companionDataConnected: true,
    playbackControlTested: false
  });
  appRef.quit();
}
function failTest(error) {
  if (runFailed || runFinished) return;
  runFailed = true;
  clearTimeout(watchdog);
  log('result', { status: 'failed', message: String(error && error.message || error).slice(0, 500) });
  if (fixtureAgent && fixtureAgent.exitCode === null && fixtureAgent.stdin.writable) {
    try { fixtureAgent.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n'); } catch {}
  }
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.debugger.isAttached()) mainWindow.webContents.debugger.detach();
  } catch {}
  try { appRef.quit(); } catch {}
}

const watchdog = setTimeout(() => failTest(new Error('Runtime attach probe timed out.')), 90000);
watchdog.unref();

function attachWindow(win) {
  win.webContents.once('did-finish-load', () => {
    runProbe(win).catch(error => failTest(error));
  });
}

module.exports = { attachWindow, configure };
