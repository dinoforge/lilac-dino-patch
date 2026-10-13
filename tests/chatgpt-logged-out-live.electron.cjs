'use strict';

// Opt-in smoke test of chatgpt.com from a NEW anonymous Electron profile.
// No login, CAPTCHA interaction, prompts, output reading, cookies or saved
// browser profiles. Reports navigation only; not successful authentication.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { createEmbeddedChatGPTBrowser, SESSION_PARTITION } = require('../electron/embedded-chatgpt-web.cjs');
const { inspectScript, CHATGPT_HOSTS } = require('../electron/chatgpt-web-ui-driver.cjs');

const root = process.env.DINO_LOGGED_OUT_SMOKE_ROOT;
const temp = fs.realpathSync(os.tmpdir());
if (!root || path.dirname(path.resolve(root)) !== temp ||
    !/^dino-chatgpt-logged-out-smoke-[a-zA-Z0-9_-]+$/.test(path.basename(root))) {
  throw new Error('Refusing to run anonymous browser outside an isolated test root');
}
fs.mkdirSync(path.join(root, 'userData'), { recursive: true });
fs.mkdirSync(path.join(root, 'sessionData'), { recursive: true });
app.setPath('userData', path.join(root, 'userData'));
app.setPath('sessionData', path.join(root, 'sessionData'));
app.commandLine.appendSwitch('disable-gpu');

async function main() {
  const service = createEmbeddedChatGPTBrowser({ BrowserWindow });
  if (service.partition !== SESSION_PARTITION) throw new Error('Unexpected browser partition');
  let timer;
  try {
    const result = await Promise.race([
      service.open(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('anonymous navigation timeout')), 30000); })
    ]);
    const win = service.getWindow();
    if (!result?.opened || !win || win.isDestroyed()) throw new Error('Browser failed to open');
    const currentUrl = win.webContents.getURL();
    const origin = new URL(currentUrl).origin;
    if (!origin.startsWith('https://')) throw new Error('Unexpected insecure navigation');
    if (!CHATGPT_HOSTS.has(new URL(currentUrl).hostname.toLowerCase())) throw new Error('Unexpected ChatGPT host');
    // This checks only visible UI readiness booleans and counts. It does not
    // return input values, conversation text, cookies, clipboard or session data.
    const ui = await win.webContents.executeJavaScript(inspectScript('', false), true);
    if (!CHATGPT_HOSTS.has(ui?.host)) throw new Error('UI preflight ran outside an allowed ChatGPT host');
    console.log('anonymous_ui_preflight=' + JSON.stringify({
      loginRequired: ui.loginRequired === true, challengePresent: ui.challenge === true,
      composerCount: Number(ui.composerCount) || 0, sendButtonCount: Number(ui.sendButtonCount) || 0,
      generating: ui.generating === true
    }));
    console.log('anonymous_site_navigation=loaded');
    console.log('anonymous_site_origin=' + origin);
    console.log('authenticated=not_attempted');
    console.log('login_or_challenge_bypass=false');
    console.log('auto_submission=false');
    console.log('output_extraction=false');
    return 0;
  } finally {
    clearTimeout(timer);
    const win = service.getWindow();
    if (win && !win.isDestroyed()) win.destroy();
  }
}

app.whenReady().then(main).then(
  code => app.exit(code),
  error => {
    console.error('anonymous_site_navigation=failed: ' + error.message);
    console.error('authenticated=not_attempted');
    app.exit(1);
  }
);
