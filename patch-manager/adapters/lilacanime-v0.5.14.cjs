'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateManifest, hashBytes } = require('../core.cjs');

const VERSION = '0.5.14';
const PATCH_SET = 'lilacanime-v0.5.14-patch-01-02';
const PROMPT_HASHES = Object.freeze({
  '영어 번역 프롬프트.txt': '582eaf421cabbcf89279579e5723aa07b070e5b1df2e28ee044994b2e951e37e',
  '일본어 번역 프롬프트.txt': '9ff7e860cf0c79396621c2ef65b364596ebb884aa5b3ce68e60ab0d4b42ec584',
  'Reazon_작품용_단어사전_예시.txt': '2dcb15b42d31bd6413d74e9a91303f0055574e030f875720cb1a1c07b814ccf8'
});

// These hashes pin this adapter to the released v0.5.14 source layout.
const EXPECTED_FILES = Object.freeze({
  'package.json': 'b51cbb52f74ed5b9a649fdf0dfc6db8a0ae8a3c9186695a10593266b6b82c57c',
  'src/index.html': '061c168f8645cbbe6f7055f1f872c3423a0c3d1eed2fb0b6a9bc7a039f613aff',
  'src/app.js': '1a2f5f3db6faf02790d25f1a29d43431bb594efcfec1e0ebc4280477459d8f75',
  'src/player.js': '1522aafbf3adf7de734c971a3c703cede6956cda053d9078b2803a95ccc4e66c',
  'src/ott.css': 'bf567bead0d6b494e2cabfb20bf7d6ed80071cd98e4975ab1e98372324328811',
  'electron/main.cjs': '2de2597f512c690aed7c3bb156fe2091f2852819bc15236c61c63f7c6e18bbd2',
  'electron/preload.cjs': 'ee1f6dfd17b8bc502d939dc8c21c8e452cb93d8f1cc05121aedd145673b374ce',
  'electron/subtitle-store.cjs': 'bfec7a17e735d63336e62b36fea3ed90412f821ec299591ffb71fcae7b3877be'
});

const SHARED_PAYLOAD_FILES = Object.freeze([
  ['src/patch-manager-stage2.js', 'src/patch-manager-stage2.js'],
  ['electron/patch-manager-stage2.cjs', 'electron/patch-manager-stage2.cjs']
]);
const PATCH_PAYLOAD_FILES = Object.freeze({
  'patch-01': Object.freeze([
    ['src/patch-manager-stage2-core.js', 'src/patch-manager-stage2-core.js'],
    ['src/weekday-schedule.js', 'src/weekday-schedule.js'],
    ['src/integrated-search.js', 'src/integrated-search.js'],
    ['electron/quarter-catalog.cjs', 'electron/quarter-catalog.cjs'],
    ['electron/anilist-client.cjs', 'electron/anilist-client.cjs'],
    ['electron/weekday-episodes.cjs', 'electron/weekday-episodes.cjs']
  ]),
  'patch-02': Object.freeze([
    ['src/manual-subtitle-translation.js', 'src/manual-subtitle-translation.js'],
    ['electron/embedded-chatgpt-web.cjs', 'electron/embedded-chatgpt-web.cjs'],
    ['electron/manual-translation-session.cjs', 'electron/manual-translation-session.cjs'],
    ['electron/patch-manager-stage2-prompts.cjs', 'electron/patch-manager-stage2-prompts.cjs'],
    ['docs/prompts/영어 번역 프롬프트.txt', 'electron/prompts/영어 번역 프롬프트.txt'],
    ['docs/prompts/일본어 번역 프롬프트.txt', 'electron/prompts/일본어 번역 프롬프트.txt'],
    ['docs/prompts/Reazon_작품용_단어사전_예시.txt', 'electron/prompts/Reazon_작품용_단어사전_예시.txt']
  ])
});
const PAYLOAD_FILES = Object.freeze([
  ...SHARED_PAYLOAD_FILES,
  ...PATCH_PAYLOAD_FILES['patch-01'],
  ...PATCH_PAYLOAD_FILES['patch-02']
]);

function readPayload(projectRoot, source, target) {
  const bytes = fs.readFileSync(path.join(projectRoot, ...source.split('/')));
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error(`Payload size is not supported: ${source}`);
  const expectedPromptHash = PROMPT_HASHES[path.posix.basename(source)];
  if (expectedPromptHash && hashBytes(bytes) !== expectedPromptHash) throw new Error(`User prompt bytes changed: ${source}`);
  return { kind: 'add-file', file: target, contentBase64: bytes.toString('base64') };
}

function makeLilacAnimeV0514Manifest(projectRoot = path.resolve(__dirname, '../..')) {
  const actions = [
    {
      kind: 'insert-before',
      file: 'electron/main.cjs',
      anchor: "  ipcMain.handle('provider:season', (_, provider) => homeShows(provider,'season'));",
      content: `  const { registerPatch0102Handlers } = require('./patch-manager-stage2.cjs');\n  registerPatch0102Handlers({\n    ipcMain, app, subtitleStore, clipboard: require('electron').clipboard, shell: require('electron').shell,\n    providerFetch, REANIME_WEB, ANIMENOSUB_WEB, reanimeItems, miruroApi, miruroItem,\n    miruroHasEpisodes, animenosubList, cheerio\n  });\n`
    },
    {
      kind: 'insert-before',
      file: 'electron/preload.cjs',
      anchor: "  providerSeason: provider => ipcRenderer.invoke('provider:season', provider),",
      content: `  patchQuarter: (provider, year, quarter) => ipcRenderer.invoke('patch:quarter', provider, year, quarter),\n  patchWeekdayEpisodes: (provider, candidates, refresh = false) => ipcRenderer.invoke('patch:weekday-episodes', provider, candidates, refresh),\n  patchTranslationPrompt: language => ipcRenderer.invoke('patch:translation-prompt', language),\n  patchCopyText: text => ipcRenderer.invoke('patch:clipboard-copy', text),
  patchReadText: () => ipcRenderer.invoke('patch:clipboard-read'),
  patchOpenChatGPTEmbedded: () => ipcRenderer.invoke('patch:chatgpt-web:open'),
  patchSaveManualSubtitle: input => ipcRenderer.invoke('patch:manual-subtitle-save', input),\n  patchManualTranslationSettings: () => ipcRenderer.invoke('manual-translation:settings:get'),\n  patchSaveManualTranslationSettings: value => ipcRenderer.invoke('manual-translation:settings:save', value),\n  patchManualTranslationSession: (key, fingerprint) => ipcRenderer.invoke('manual-translation:session:get', key, fingerprint),\n  patchSaveManualTranslationSession: (key, fingerprint, value) => ipcRenderer.invoke('manual-translation:session:save', key, fingerprint, value),\n  patchRemoveManualTranslationSession: (key, fingerprint) => ipcRenderer.invoke('manual-translation:session:remove', key, fingerprint),\n  patchHasManualTranslationForSource: (key, sourcePath) => ipcRenderer.invoke('manual-translation:translated-exists', key, sourcePath),\n  patchRevealManualSubtitle: file => ipcRenderer.invoke('manual-translation:subtitle:reveal', file),\n  patchManualTranslationSource: (key, file) => ipcRenderer.invoke('manual-translation:source:get', key, file),\n`
    },
    {
      kind: 'insert-before',
      file: 'electron/subtitle-store.cjs',
      anchor: "'gemini'];",
      content: "'chatgpt', "
    },
    {
      kind: 'insert-before',
      file: 'src/index.html',
      anchor: '</body>',
      content: `  <script src="patch-manager-stage2-core.js"></script>\n  <script src="weekday-schedule.js"></script>\n  <script src="integrated-search.js"></script>\n  <script src="manual-subtitle-translation.js"></script>\n  <script src="patch-manager-stage2.js"></script>\n`
    }
  ];
  for (const [source, target] of PAYLOAD_FILES) actions.push(readPayload(projectRoot, source, target));
  const manifest = { schema: 2, purpose: 'isolated-patch-set', patchSet: PATCH_SET, version: VERSION, expectedFiles: EXPECTED_FILES, actions };
  validateManifest(manifest);
  return manifest;
}

module.exports = {
  VERSION,
  PATCH_SET,
  PROMPT_HASHES,
  EXPECTED_FILES,
  SHARED_PAYLOAD_FILES,
  PATCH_PAYLOAD_FILES,
  PAYLOAD_FILES,
  readPayload,
  makeLilacAnimeV0514Manifest
};
