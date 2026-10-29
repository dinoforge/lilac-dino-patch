const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const translator = fs.readFileSync(path.join(root, 'electron/subtitle-translator.cjs'), 'utf8');

test('official subtitle translation controls are rendered and bound to saved settings', () => {
  for (const id of ['dropCaptions', 'promptExtra', 'promptRules', 'savePrompt', 'resetPrompt', 'loadDefaultRules']) {
    assert.ok(html.includes('id="' + id + '"'), `${id} is part of the official translation settings UI`);
    assert.ok(app.includes('#' + id), `${id} is connected by the renderer`);
  }
  assert.match(html, /id=["']prepareNextCloud["']/);
  assert.match(app, /#prepareNextCloud/);
  assert.match(html, /id=["']geminiDownloads["']/);
  assert.match(app, /#geminiDownloads/);
  assert.match(html, /id=["']jimakuTranslateChoices["']/);
  assert.match(app, /#jimakuTranslateChoices/);
  assert.match(translator, /if\s*\(settings\.dropCaptions\)/);
  assert.ok(app.includes('window.lilac.defaultTranslationRules()'));
});
