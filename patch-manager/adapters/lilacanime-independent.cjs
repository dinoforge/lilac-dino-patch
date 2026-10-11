'use strict';

const path = require('node:path');
const { hashBytes, readVerifiedFile, validateManifest } = require('../core.cjs');
const { assertSettings, loadSettings, PATCH_IDS, DEFAULT_SETTINGS } = require('../../dino-lilac-patch/settings.cjs');
const { evaluateStructure } = require('../../dino-lilac-patch/compatibility.cjs');
const {
  PROMPT_HASHES,
  SHARED_PAYLOAD_FILES,
  PATCH_PAYLOAD_FILES,
  readPayload
} = require('./lilacanime-v0.5.14.cjs');

const PROFILE_ANCHORS = Object.freeze([
  'package.json', 'src/index.html', 'electron/main.cjs', 'electron/preload.cjs'
]);

// These are fingerprints of reviewed official source snapshots, not version allowlists.
// Each candidate must also pass the feature-specific structure probes below.
const SOURCE_PROFILES = Object.freeze([
  Object.freeze({
    id: 'official-source-f095fc3d-v0514',
    version: '0.5.14',
    fingerprint: Object.freeze({
      'package.json': 'b51cbb52f74ed5b9a649fdf0dfc6db8a0ae8a3c9186695a10593266b6b82c57c',
      'src/index.html': '061c168f8645cbbe6f7055f1f872c3423a0c3d1eed2fb0b6a9bc7a039f613aff',
      'electron/main.cjs': '2de2597f512c690aed7c3bb156fe2091f2852819bc15236c61c63f7c6e18bbd2',
      'electron/preload.cjs': 'ee1f6dfd17b8bc502d939dc8c21c8e452cb93d8f1cc05121aedd145673b374ce'
    }),
    patch02Files: Object.freeze({
      'electron/subtitle-store.cjs': 'bfec7a17e735d63336e62b36fea3ed90412f821ec299591ffb71fcae7b3877be'
    })
  }),
  Object.freeze({
    id: 'official-source-16c9a3d1-v0515',
    version: '0.5.15',
    fingerprint: Object.freeze({
      'package.json': '531907d7c16eeef0a85fc12b1228db14086167d73f47e4e9226c924c51153119',
      'src/index.html': '2eb4c42a35f39a10cc877a0746de518e2e8b22a763dfa81ee9363064d5a39286',
      'electron/main.cjs': 'efc6b23be33cfa06c17834c3fd2da20eff58197af9e7f04149861bd7d48ff947',
      'electron/preload.cjs': '8b413e049cad7a66875c3a4158d4c6c6228f4cbf020b33348cd6d0f7b8984010'
    }),
    patch02Files: Object.freeze({
      'electron/subtitle-store.cjs': 'bfec7a17e735d63336e62b36fea3ed90412f821ec299591ffb71fcae7b3877be'
    })
  })
]);

const PRELOAD_ANCHOR = "  providerSeason: provider => ipcRenderer.invoke('provider:season', provider),";
const MAIN_ANCHOR = "  ipcMain.handle('provider:season', (_, provider) => homeShows(provider,'season'));";
const PATCH01_PRELOAD = Object.freeze([
  "  patchQuarter: (provider, year, quarter) => ipcRenderer.invoke('patch:quarter', provider, year, quarter),",
  "  patchWeekdayEpisodes: (provider, candidates, refresh = false) => ipcRenderer.invoke('patch:weekday-episodes', provider, candidates, refresh === true),"
]);
const PATCH02_PRELOAD = Object.freeze([
  "  patchTranslationPrompt: language => ipcRenderer.invoke('patch:translation-prompt', language),",
  "  patchCopyText: text => ipcRenderer.invoke('patch:clipboard-copy', text),",
  "  patchReadText: () => ipcRenderer.invoke('patch:clipboard-read'),",
  "  patchSIWCStatus: () => ipcRenderer.invoke('siwc:status'),",
  "  patchSIWCConnect: () => ipcRenderer.invoke('siwc:connect'),",
  "  patchSIWCDisconnect: () => ipcRenderer.invoke('siwc:disconnect'),",
  "  patchSIWCModels: () => ipcRenderer.invoke('siwc:models'),",
  "  patchSIWCTranslate: input => ipcRenderer.invoke('siwc:translate', input),",
  "  patchSIWCCancel: () => ipcRenderer.invoke('siwc:cancel'),",
  "  patchSaveManualSubtitle: input => ipcRenderer.invoke('patch:manual-subtitle-save', input),",
  "  patchManualTranslationSettings: () => ipcRenderer.invoke('manual-translation:settings:get'),",
  "  patchSaveManualTranslationSettings: value => ipcRenderer.invoke('manual-translation:settings:save', value),",
  "  patchManualTranslationSession: (key, fingerprint) => ipcRenderer.invoke('manual-translation:session:get', key, fingerprint),",
  "  patchSaveManualTranslationSession: (key, fingerprint, value) => ipcRenderer.invoke('manual-translation:session:save', key, fingerprint, value),",
  "  patchRemoveManualTranslationSession: (key, fingerprint) => ipcRenderer.invoke('manual-translation:session:remove', key, fingerprint),",
  "  patchHasManualTranslationForSource: (key, sourcePath) => ipcRenderer.invoke('manual-translation:translated-exists', key, sourcePath),",
  "  patchRevealManualSubtitle: file => ipcRenderer.invoke('manual-translation:subtitle:reveal', file),",
  "  patchManualTranslationSource: (key, file) => ipcRenderer.invoke('manual-translation:source:get', key, file),"
]);

function normalizeSettings(input) {
  if (input == null) return assertSettings(DEFAULT_SETTINGS);
  return typeof input === 'string' ? loadSettings(input) : assertSettings(input);
}

function readSnapshot(root) {
  const files = Object.create(null);
  const hashes = Object.create(null);
  const requested = new Set([
    ...PROFILE_ANCHORS,
    'src/app.js',
    'electron/subtitle-store.cjs'
  ]);
  for (const relative of requested) {
    try {
      const bytes = readVerifiedFile(root, relative);
      files[relative] = bytes.toString('utf8');
      hashes[relative] = hashBytes(bytes);
    } catch {
      files[relative] = '';
      hashes[relative] = null;
    }
  }
  return { files, hashes };
}

function matchSourceProfile(hashes) {
  return SOURCE_PROFILES.find(profile => Object.entries(profile.fingerprint)
    .every(([file, expected]) => hashes[file] === expected)) || null;
}

function makeStructuralCandidate(hashes, version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  const fingerprint = Object.fromEntries(PROFILE_ANCHORS.map(file => [file, hashes[file]]));
  if (Object.values(fingerprint).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) return null;
  const id = `isolated-structure-${hashBytes(JSON.stringify(fingerprint)).slice(0, 12)}`;
  return {
    id,
    version,
    fingerprint,
    patch02Files: { 'electron/subtitle-store.cjs': hashes['electron/subtitle-store.cjs'] }
  };
}

function setBlocked(patches, id, issue) {
  const current = patches[id];
  if (current.selection !== 'on') return;
  patches[id] = {
    ...current,
    status: 'blocked',
    needsIsolatedValidation: false,
    issues: [...current.issues, issue]
  };
}

function featureFlags(settings) {
  return Object.freeze({
    'patch-01': settings.patches['patch-01'],
    'patch-02': settings.patches['patch-02']
  });
}

function mainBridgeSource(flags) {
  const deps = [`ipcMain`];
  if (flags['patch-01']) deps.push(
    'providerFetch', 'REANIME_WEB', 'ANIMENOSUB_WEB', 'reanimeItems',
    'miruroApi', 'miruroItem', 'miruroHasEpisodes', 'animenosubList', 'cheerio'
  );
  if (flags['patch-02']) deps.push('app', 'subtitleStore', 'clipboard: require("electron").clipboard', 'shell: require("electron").shell', 'safeStorage: require("electron").safeStorage');
  const dependencyObject = deps.map(value => `    ${value}`).join(',\n');
  return [
    "  const { registerPatch0102Handlers } = require('./patch-manager-stage2.cjs');",
    '  registerPatch0102Handlers({',
    dependencyObject,
    `  }, ${JSON.stringify(flags)});`,
    ''
  ].join('\n');
}

function preloadBridgeSource(flags) {
  const lines = [];
  if (flags['patch-01']) lines.push(...PATCH01_PRELOAD);
  if (flags['patch-02']) lines.push(...PATCH02_PRELOAD);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function htmlBridgeSource(flags) {
  const scripts = [];
  if (flags['patch-01']) scripts.push('patch-manager-stage2-core.js', 'weekday-schedule.js', 'integrated-search.js');
  if (flags['patch-02']) scripts.push('manual-subtitle-translation.js');
  scripts.push('patch-manager-stage2.js');
  if (flags['patch-02']) scripts.push('siwc-subtitle-bridge.js');
  const config = `<script>window.DinoLilacPatchFeatures = Object.freeze(${JSON.stringify(flags)});</script>`;
  return `  ${config}\n${scripts.map(file => `  <script src="${file}"></script>`).join('\n')}\n`;
}

function selectedPayloads(flags) {
  const selected = new Set(SHARED_PAYLOAD_FILES.map(([, target]) => target));
  for (const id of PATCH_IDS) {
    if (!flags[id]) continue;
    for (const [, target] of PATCH_PAYLOAD_FILES[id]) selected.add(target);
  }
  return [...selected].map(target => {
    const entry = [...SHARED_PAYLOAD_FILES, ...PATCH_PAYLOAD_FILES['patch-01'], ...PATCH_PAYLOAD_FILES['patch-02']]
      .find(([, candidate]) => candidate === target);
    if (!entry) throw new Error(`Missing payload mapping: ${target}`);
    return entry;
  });
}

function buildManifest(payloadRoot, profile, flags) {
  const expectedFiles = { ...profile.fingerprint };
  const actions = [
    { kind: 'insert-before', file: 'electron/main.cjs', anchor: MAIN_ANCHOR, content: mainBridgeSource(flags) },
    { kind: 'insert-before', file: 'electron/preload.cjs', anchor: PRELOAD_ANCHOR, content: preloadBridgeSource(flags) },
    { kind: 'insert-before', file: 'src/index.html', anchor: '</body>', content: htmlBridgeSource(flags) }
  ];
  if (flags['patch-02']) {
    expectedFiles['electron/subtitle-store.cjs'] = profile.patch02Files['electron/subtitle-store.cjs'];
    actions.push({ kind: 'insert-before', file: 'electron/subtitle-store.cjs', anchor: "'gemini'];", content: "'chatgpt', " });
  }
  for (const [source, target] of selectedPayloads(flags)) actions.push(readPayload(payloadRoot, source, target));

  const ids = PATCH_IDS.filter(id => flags[id]);
  const manifest = {
    schema: 2,
    purpose: 'isolated-patch-set',
    patchSet: `lilacanime-${profile.version}-${ids.join('+')}`,
    version: profile.version,
    expectedFiles,
    actions
  };
  validateManifest(manifest);
  return manifest;
}

function makeLilacAnimePatchPlan(targetRoot, rawSettings, { payloadRoot = path.resolve(__dirname, '../..') } = {}) {
  const settings = normalizeSettings(rawSettings);
  const flags = featureFlags(settings);
  const selected = PATCH_IDS.filter(id => flags[id]);
  if (!selected.length) {
    return {
      status: 'disabled',
      version: null,
      profile: null,
      patches: Object.fromEntries(PATCH_IDS.map(id => [id, { selection: 'off', status: 'disabled', issues: [], needsIsolatedValidation: false }])),
      manifest: null,
      writes: false
    };
  }

  const { files, hashes } = readSnapshot(targetRoot);
  const structure = evaluateStructure(files, settings);
  const patches = { ...structure.patches };
  const knownProfile = matchSourceProfile(hashes);
  const profile = knownProfile || makeStructuralCandidate(hashes, structure.version);
  if (!profile) {
    for (const id of selected) setBlocked(patches, id, { kind: 'unreadable-source-profile', files: [...PROFILE_ANCHORS] });
  } else if (!knownProfile) {
    for (const id of selected) {
      if (patches[id]?.status === 'structural-candidate') {
        patches[id] = {
          ...patches[id],
          issues: [...patches[id].issues, { kind: 'unreviewed-source-fingerprint', files: [...PROFILE_ANCHORS] }]
        };
      }
    }
  }
  if (knownProfile && flags['patch-02']) {
    const actual = hashes['electron/subtitle-store.cjs'];
    const expected = knownProfile.patch02Files['electron/subtitle-store.cjs'];
    if (actual !== expected) setBlocked(patches, 'patch-02', {
      kind: 'target-fingerprint-mismatch', file: 'electron/subtitle-store.cjs'
    });
  }

  const enabled = PATCH_IDS.filter(id => patches[id]?.status === 'structural-candidate');
  const manifest = profile && enabled.length ? buildManifest(payloadRoot, profile, featureFlags({ patches: {
    'patch-01': enabled.includes('patch-01'),
    'patch-02': enabled.includes('patch-02')
  } })) : null;
  const blocked = selected.filter(id => patches[id]?.status === 'blocked');
  return {
    status: manifest ? (blocked.length ? 'partially-blocked' : 'ready-for-isolated-application') : 'blocked',
    version: profile?.version || structure.version,
    profile: profile?.id || null,
    patches,
    manifest,
    writes: false,
    structureStatus: structure.status
  };
}

module.exports = {
  SOURCE_PROFILES,
  PROFILE_ANCHORS,
  makeLilacAnimePatchPlan,
  normalizeSettings,
  matchSourceProfile,
  makeStructuralCandidate,
  mainBridgeSource,
  preloadBridgeSource,
  htmlBridgeSource,
  selectedPayloads
};
