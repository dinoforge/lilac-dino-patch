const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const html = read('src/index.html');
const app = read('src/app.js');
const main = read('electron/main.cjs');
const preload = read('electron/preload.cjs');
const store = read('electron/subtitle-store.cjs');

test('player has an explicit ChatGPT copy and paste workflow', () => {
  for (const id of ['translateChatgpt', 'manualChatgptCopyOpen', 'manualChatgptAnswer', 'manualChatgptApply', 'manualChatgptCancel']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /manual-subtitle-translation\.js[\s\S]*app\.js/);
  assert.match(app, /copyText\(prompt\)/);
  assert.match(app, /openExternal\('https:\/\/chatgpt\.com\/'\)/);
  assert.match(app, /saveManualSubtitle\(/);
  assert.match(app, /'gemini','chatgpt','user','jimaku'\]\.includes\(source\)\|\|currentPlaybackContext\.siteKorean/);
  assert.match(app, /'gemini','chatgpt'/);
});

test('ChatGPT workflow writes only to the clipboard and never submits or calls a translation API', () => {
  assert.match(preload, /copyText:\s*text\s*=>\s*ipcRenderer\.invoke\('clipboard:copy-text',\s*text\)/);
  assert.match(main, /ipcMain\.handle\('clipboard:copy-text'/);
  assert.match(main, /clipboard\.writeText\(text\)/);
  assert.doesNotMatch(main, /clipboard\.readText/);
  assert.doesNotMatch(app, /generativelanguage\.googleapis\.com|api\.openai\.com/);
});

test('manual results are validated as WebVTT and saved under the ChatGPT subtitle source', () => {
  assert.match(main, /subtitle:manual-save/);
  assert.match(main, /WEBVTT/);
  assert.match(main, /subtitles','translated'/);
  assert.match(main, /source:'chatgpt'/);
  assert.match(preload, /saveManualSubtitle:\s*input\s*=>\s*ipcRenderer\.invoke\('subtitle:manual-save',\s*input\)/);
  assert.match(store, /'chatgpt'/);
  assert.match(app, /chatgpt:'ChatGPT 번역'/);
});
