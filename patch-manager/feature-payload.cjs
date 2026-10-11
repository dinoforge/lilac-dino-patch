'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hashBytes, readVerifiedFile } = require('./core.cjs');

const PATCH_SET_ID = 'test-fixture-patch-01+02-payloads';
const FIXTURE_VERSION = '0.5.9';
const FIXTURE_BASELINE = Object.freeze({
  'package.json': '37071d6c841f1684c1144eb0fc6cb762a132770c1849fc6e03c399eba5456aaf',
  'src/index.html': 'a7e33a93bdf80750cbe1f6026756beae9aa0098f8e9384e58bd2f6256330d12a'
});
const FILES = Object.freeze([
  ['src/quarter-selection.js', 'src/quarter-selection.js'],
  ['src/weekday-schedule.js', 'src/weekday-schedule.js'],
  ['src/manual-subtitle-translation.js', 'src/manual-subtitle-translation.js'],
  ['electron/anilist-client.cjs', 'electron/anilist-client.cjs'],
  ['electron/weekday-episodes.cjs', 'electron/weekday-episodes.cjs'],
  ['electron/quarter-catalog.cjs', 'electron/quarter-catalog.cjs'],
  ['electron/translation-prompts.cjs', 'electron/translation-prompts.cjs'],
  ['docs/prompts/README.md', 'docs/prompts/README.md'],
  ['docs/prompts/영어 번역 프롬프트.txt', 'docs/prompts/영어 번역 프롬프트.txt'],
  ['docs/prompts/일본어 번역 프롬프트.txt', 'docs/prompts/일본어 번역 프롬프트.txt'],
  ['docs/prompts/Reazon_작품용_단어사전_예시.txt', 'docs/prompts/Reazon_작품용_단어사전_예시.txt']
]);

function makePatch0102Manifest(targetRoot, { sourceRoot = path.resolve(__dirname, '..'), version = FIXTURE_VERSION } = {}) {
  if (version !== FIXTURE_VERSION) throw new Error('No reviewed Patch 01/02 payload fixture exists for this version');
  const pkg = JSON.parse(readVerifiedFile(targetRoot, 'package.json').toString('utf8'));
  if (String(pkg.version) !== version) throw new Error(`Patch bundle targets ${version}, not ${pkg.version}`);
  const expectedFiles = { ...FIXTURE_BASELINE };
  const actions = [{
    kind: 'insert-before',
    file: 'src/index.html',
    anchor: '<!--PATCH_FEATURE_SCRIPTS-->',
    content: [
      '<script src="quarter-selection.js"></script>',
      '<script src="weekday-schedule.js"></script>',
      '<script src="manual-subtitle-translation.js"></script>',
      ''
    ].join('\n')
  }];
  for (const [source, target] of FILES) {
    const bytes = fs.readFileSync(path.join(sourceRoot, ...source.split('/')));
    actions.push({ kind: 'add-file', file: target, contentBase64: bytes.toString('base64') });
  }
  return {
    schema: 2,
    purpose: 'isolated-patch-set',
    patchSet: PATCH_SET_ID,
    version,
    expectedFiles,
    actions
  };
}

module.exports = { PATCH_SET_ID, FIXTURE_VERSION, FIXTURE_BASELINE, FILES, makePatch0102Manifest };
