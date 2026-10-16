'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');
const { createFixtureAgentSpawnAllowlist, installNetworkGuard } = require('./network-guard.cjs');
const { stopOwnedChild } = require('./owned-child.cjs');

let appRef;
let mainWindow;
let fixtureAgent;
let runStarted = false;
let runFinished = false;
let runFailed = false;
let browserBlockedRequests = 0;
let mainBlockedRequests = 0;
let allowFixtureAgentSpawn;

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

function disableMainProcessNetwork(electronNet) {
  allowFixtureAgentSpawn = createFixtureAgentSpawnAllowlist({
    nodeExecutable: process.env.LILAC_RUNTIME_ATTACH_NODE,
    agentScript: process.env.LILAC_RUNTIME_ATTACH_AGENT,
    workingDirectory: process.env.LILAC_RUNTIME_ATTACH_REPO,
    environment: process.env
  });
  return installNetworkGuard({
    globalObject: globalThis,
    electronNet,
    modules: {
      http: require('node:http'),
      https: require('node:https'),
      net: require('node:net'),
      tls: require('node:tls'),
      dgram: require('node:dgram'),
      dns: require('node:dns'),
      dnsPromises: require('node:dns/promises')
    },
    childProcess,
    allowFixtureSpawn: allowFixtureAgentSpawn,
    onBlocked: failClosed,
    onAllowedSpawn: details => log('allowed-fixture-agent-spawn', details)
  });
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
  const networkGuard = disableMainProcessNetwork(net);

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
      nodeNetworkApisBlocked: networkGuard.blockedNodeApis,
      fixtureAgentSpawnAllowlisted: networkGuard.fixtureSpawnAllowlisted,
      chromiumHostResolutionBlocked: true,
      operatingSystemFirewallIsolation: false,
      debuggerTcpPort: false
    });
  }).catch(error => failTest(error));
  return networkGuard;
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
  fixtureAgent = childProcess.spawn(node, [script], {
    cwd: process.env.LILAC_RUNTIME_ATTACH_REPO,
    env: process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const output = readline.createInterface({ input: fixtureAgent.stdout, crlfDelay: Infinity });
  const errors = readline.createInterface({ input: fixtureAgent.stderr, crlfDelay: Infinity });
  fixtureAgent.stdin.on('error', error => log('fixture-agent-stdin-error', { message: String(error && error.message || error).slice(0, 200) }));
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
    fixtureAgent.once('exit', (code, signal) => log('fixture-agent-exit-observed', { pid: fixtureAgent.pid || null, code, signal }));
    fixtureAgent.once('error', error => {
      clearInterval(poll);
      reject(error);
    });
  });
}

async function requestAgentShutdown(reason = 'normal-completion') {
  return stopOwnedChild(fixtureAgent, {
    reason,
    shutdownMessage: JSON.stringify({ type: 'shutdown' }) + '\n',
    graceMs: 3000,
    terminationWaitMs: 3000,
    onEvent: (event, details) => log(event, details)
  });
}

async function runProbe(win) {
  if (runStarted) return;
  runStarted = true;
  mainWindow = win;
  const expectedHtml = path.join(path.resolve(process.env.LILAC_RUNTIME_ATTACH_SOURCE), 'src', 'index.html');
  const expectedUrl = pathToFileURL(expectedHtml).href;
  const actualUrl = win.webContents.getURL();
  if (actualUrl !== expectedUrl) throw new Error('Renderer URL does not point at the isolated v0.5.14 source copy.');

  win.showInactive();
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Runtime.enable');
  await win.webContents.debugger.sendCommand('Page.enable');
  const baseline = await evaluate(`(() => {
    const changelog = document.getElementById('changelogDialog');
    const startupChangelogWasOpen = Boolean(changelog && changelog.open);
    if (startupChangelogWasOpen) document.getElementById('changelogClose')?.click();
    const ids = ['homeView', 'searchView', 'settingsView', 'detailDialog'];
    const nodes = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
    const ok = ids.every(id => nodes[id]) && window.lilac && typeof window.lilac.season === 'function';
    if (ok) window.__lilacRuntimeAttachRefs = nodes;
    return { ok: Boolean(ok), title: document.title, protocol: location.protocol,
      homeActive: Boolean(nodes.homeView && nodes.homeView.classList.contains('active')),
      originalIds: ids.filter(id => nodes[id]), preloadBridge: Boolean(window.lilac),
      startupChangelogWasOpen, startupChangelogClosed: !changelog || !changelog.open };
  })()`);
  if (!baseline || baseline.ok !== true || baseline.protocol !== 'file:' || !baseline.startupChangelogClosed) {
    throw new Error('Original v0.5.14 renderer anchors or preload bridge were not present.');
  }
  log('original-startup-dialog-handled', {
    dialogWasOpen: baseline.startupChangelogWasOpen,
    closedThroughOriginalControl: baseline.startupChangelogClosed,
    originalHomeActive: baseline.homeActive
  });
  log('original-renderer-confirmed', {
    version: '0.5.14',
    renderer: 'isolated-source/src/index.html',
    title: baseline.title,
    originalIds: baseline.originalIds,
    preloadBridge: baseline.preloadBridge,
    startupChangelogWasOpen: baseline.startupChangelogWasOpen,
    startupChangelogClosed: baseline.startupChangelogClosed,
    debuggerTransport: 'webContents.debugger in-process CDP'
  });

  const fixtureMessage = await startFixtureAgent();
  const days = fixtureMessage.days;
  if (fixtureMessage.synthetic !== true || fixtureMessage.source !== 'companion/core/catalog.cjs' || days.length !== 7) {
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
  const dataJson = JSON.stringify(days);
  const labelsJson = JSON.stringify(labels);
  const insertExpression = '(() => {\n' +
    'const days = ' + dataJson + '; const labels = ' + labelsJson + ';\n' +
    'const home = document.getElementById("homeView"); if (!home || document.getElementById("lilac-companion-weekday-probe")) return { ok: false };\n' +
    'const section = document.createElement("section"); section.id = "lilac-companion-weekday-probe"; section.setAttribute("role", "region"); section.setAttribute("aria-label", "Companion 요일표 테스트");\n' +
    'section.style.cssText = "margin:28px auto;max-width:1080px;padding:24px 28px;background:linear-gradient(135deg,#241e31,#17151d);border:1px solid #76628e;border-radius:18px;color:#f7f3ff;font:14px/1.5 system-ui,sans-serif;box-shadow:0 12px 36px #0005";\n' +
    'const header = document.createElement("div"); header.style.cssText = "display:flex;align-items:baseline;gap:12px;margin-bottom:14px";\n' +
    'const heading = document.createElement("h2"); heading.textContent = "Companion 요일표"; heading.style.cssText = "margin:0;font-size:20px"; header.append(heading);\n' +
    'const badge = document.createElement("span"); badge.textContent = "격리 실험 · 합성 데이터"; badge.style.cssText = "color:#c6afd9;font-size:12px"; header.append(badge); section.append(header);\n' +
    'const tabs = document.createElement("div"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "요일 선택"); tabs.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 16px"; section.append(tabs);\n' +
    'const panel = document.createElement("div"); panel.setAttribute("role", "tabpanel"); panel.style.cssText = "padding:16px;background:#ffffff0b;border-radius:12px;min-height:86px"; section.append(panel);\n' +
    'let selected = 0;\n' +
    'function render() { tabs.querySelectorAll("button").forEach((button,index) => { button.setAttribute("aria-selected", String(index === selected)); button.style.cssText = "border:1px solid " + (index === selected ? "#bd91ed" : "#5c5367") + ";background:" + (index === selected ? "#6d4b86" : "#28242f") + ";color:#fff;border-radius:999px;padding:7px 14px;cursor:pointer"; }); panel.replaceChildren(); panel.dataset.selectedWeekday = String(selected); const works = days[selected] || []; if (!works.length) { const empty = document.createElement("p"); empty.textContent = "방영 작품 없음"; panel.append(empty); return; } for (const work of works) { const card = document.createElement("article"); card.setAttribute("role", "listitem"); card.style.cssText = "display:grid;gap:5px"; const title = document.createElement("strong"); title.className = "companion-probe-title"; title.textContent = String(work.title || "제목 없음"); title.style.cssText = "font-size:17px"; card.append(title); const meta = document.createElement("span"); meta.textContent = String(work.airingTime || "시간 미정") + " · " + String(work.weekdayEpisodeNumber || "-") + "화 · " + String(work.season || ""); meta.style.cssText = "color:#d0c8d9"; card.append(meta); const sources = document.createElement("span"); sources.className = "companion-probe-sources"; sources.textContent = (work.sources || []).map(item => item.name + ": " + item.status).join("  ·  "); sources.style.cssText = "color:#b8aeca;font-size:12px"; card.append(sources); panel.append(card); } }\n' +
    'labels.forEach((label,index) => { const button = document.createElement("button"); button.type = "button"; button.id = "lilac-companion-weekday-" + index; button.dataset.weekday = String(index); button.textContent = label; button.setAttribute("role", "tab"); button.setAttribute("aria-controls", "lilac-companion-weekday-panel"); button.addEventListener("click", () => { selected = index; render(); }); tabs.append(button); });\n' +
    'panel.id = "lilac-companion-weekday-panel"; home.insertBefore(section, document.getElementById("scheduleSection")); render(); section.scrollIntoView({ block: "center" });\n' +
    'const rect = section.getBoundingClientRect(); const style = getComputedStyle(section); const changelog = document.getElementById("changelogDialog");\n' +
    'const visible = rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && !(changelog && changelog.open);\n' +
    'return { ok: true, count: tabs.children.length, selected: selected, title: panel.querySelector(".companion-probe-title")?.textContent || "", sourceCount: (days[0][0]?.sources || []).length, homeContains: home.contains(section), visible, bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight } };\n' +
    '})()';
  const inserted = await evaluate(insertExpression);
  if (!inserted || inserted.ok !== true || inserted.count !== 7 || inserted.sourceCount !== 5 || !inserted.homeContains || !inserted.visible) {
    throw new Error('The Companion weekday section was not inserted into the original home view.');
  }
  log('weekday-ui-inserted', {
    actualRenderer: true,
    anchor: '#homeView before #scheduleSection',
    buttons: inserted.count,
    selectedLabel: labels[inserted.selected],
    selectedTitle: inserted.title,
    providerRows: inserted.sourceCount,
    actuallyVisibleInViewport: inserted.visible,
    bounds: inserted.bounds,
    originalChangelogBlocking: false
  });

  const selectionResults = [];
  for (let index = 0; index < labels.length; index += 1) {
    const state = await evaluate('(() => { const button = document.getElementById("lilac-companion-weekday-' + index + '"); if (!button) return null; button.click(); const panel = document.getElementById("lilac-companion-weekday-panel"); return { selected: Number(panel.dataset.selectedWeekday), title: panel.querySelector(".companion-probe-title")?.textContent || "", pressed: button.getAttribute("aria-selected") }; })()');
    if (!state || state.selected !== index || state.pressed !== 'true' || !state.title) {
      throw new Error('Weekday button interaction failed for ' + labels[index] + '.');
    }
    selectionResults.push({ day: labels[index], title: state.title });
  }
  log('weekday-selection-verified', { choices: selectionResults });

  const screenshot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true
  });
  const png = Buffer.from(screenshot.data || '', 'base64');
  if (png.length < 100 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('CDP did not return a valid PNG of the actual renderer.');
  }
  const screenshotPath = process.env.LILAC_RUNTIME_ATTACH_SCREENSHOT;
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, png, { flag: 'wx' });
  log('renderer-screenshot-captured', {
    artifact: process.env.LILAC_RUNTIME_ATTACH_SCREENSHOT_RELATIVE,
    bytes: png.length,
    capture: 'Page.captureScreenshot on the original app webContents'
  });

  const stopped = await requestAgentShutdown();
  if (!stopped.graceful || stopped.exitCode !== 0) throw new Error('Companion fixture process did not shut down cleanly.');
  log('companion-shutdown', { exitCode: stopped.exitCode, graceful: true });

  const removed = await evaluate('(() => { const section = document.getElementById("lilac-companion-weekday-probe"); if (section) section.remove(); const refs = window.__lilacRuntimeAttachRefs || {}; const retained = ["homeView", "searchView", "settingsView", "detailDialog"].every(id => refs[id] && refs[id] === document.getElementById(id)); delete window.__lilacRuntimeAttachRefs; return { removed: !document.getElementById("lilac-companion-weekday-probe"), retained }; })()');
  if (!removed || removed.removed !== true || removed.retained !== true) {
    throw new Error('The temporary UI was not removed or original DOM nodes changed.');
  }
  if (!win.webContents.debugger.isAttached()) throw new Error('UI removal was not verified before the debugger detached.');
  log('ui-removed-before-debugger-detach', { removed: true, originalDomIdentityRetained: true, debuggerStillAttached: true });
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
  log('result', { status: 'passed', uiInsertedIntoActualRenderer: true, companionDataConnected: true, playbackControlTested: false });
  appRef.quit();
}

async function failTest(error) {
  if (runFailed || runFinished) return;
  runFailed = true;
  clearTimeout(watchdog);
  log('result', { status: 'failed', message: String(error && error.message || error).slice(0, 500) });
  const stopped = await requestAgentShutdown('probe-failure');
  log('fixture-agent-failure-cleanup', { ...stopped });
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.debugger.isAttached()) mainWindow.webContents.debugger.detach();
  } catch {}
  try { appRef.quit(); } catch {}
}

const watchdog = setTimeout(() => { void failTest(new Error('Runtime attach probe timed out.')); }, 90000);
watchdog.unref();

function attachWindow(win) {
  win.webContents.once('did-finish-load', () => {
    runProbe(win).catch(error => { void failTest(error); });
  });
}

module.exports = { attachWindow, configure };
