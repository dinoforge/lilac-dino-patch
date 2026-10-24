const assert = require('node:assert/strict');
const { test } = require('node:test');
const { installPopupBlocker } = require('../electron/popup-policy.cjs');

test('popup policy denies page-created windows without changing session permissions', () => {
  const handlers = new Map();
  const app = { on: (event, handler) => handlers.set(event, handler) };
  const contents = { setWindowOpenHandler(handler) { this.windowOpenHandler = handler; } };
  installPopupBlocker(app);
  handlers.get('web-contents-created')({}, contents);

  assert.deepEqual(contents.windowOpenHandler(), { action: 'deny' });
  assert.equal(handlers.has('session-created'), false, 'the policy does not replace session permission handling');
});

test('main installs the popup policy before creating application windows', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const installAt = source.indexOf('installPopupBlocker(app)');
  const windowAt = source.indexOf('new BrowserWindow');
  assert.ok(installAt >= 0 && windowAt > installAt);
});
