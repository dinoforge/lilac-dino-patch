'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeLilacAnimeV0514Manifest } = require('../adapters/lilacanime-v0.5.14.cjs');

test('SIWC is excluded from new Patch 02 output, with embedded ChatGPT web kept isolated', () => {
  const manifest = makeLilacAnimeV0514Manifest();
  const paths = new Set(manifest.actions.filter(action => action.kind === 'add-file').map(action => action.file));
  for (const filename of [
    'electron/embedded-chatgpt-web.cjs', 'src/manual-subtitle-translation.js',
    'electron/manual-translation-session.cjs', 'src/patch-manager-stage2.js'
  ]) assert.ok(paths.has(filename), filename);
  for (const filename of [
    'electron/siwc-contract.cjs', 'electron/siwc-oidc.cjs', 'electron/siwc-client.cjs',
    'src/siwc-subtitle-bridge.js'
  ]) assert.equal(paths.has(filename), false, filename);
  const codeFor = file => manifest.actions.find(action => action.file === file && action.kind === 'insert-before')?.content || '';
  const preload = codeFor('electron/preload.cjs');
  const main = codeFor('electron/main.cjs');
  const html = codeFor('src/index.html');
  assert.match(preload, /patchOpenChatGPTEmbedded/);
  assert.doesNotMatch(preload, /SIWC|siwc/);
  assert.match(main, /registerPatch0102Handlers/);
  assert.doesNotMatch(main, /safeStorage/);
  assert.match(html, /patch-manager-stage2\.js/);
  assert.doesNotMatch(html, /siwc/i);
  assert.ok(manifest.expectedFiles['electron/main.cjs']);
  assert.equal(manifest.version, '0.5.14');
});
