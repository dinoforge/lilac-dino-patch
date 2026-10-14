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
    }),
    patch04Files: Object.freeze({
      'src/player.js': '73bcb05bdadbc49806987126fc43969305d1a26fb49981766e178144dab9ecf2'
    }),
    patch03Files: Object.freeze({
      'src/app.js': '2e1e54b6dd54af3f6fbd4066f602d559e6327d8f6be9159b5d1a17f700a227e1',
      'src/player.js': '73bcb05bdadbc49806987126fc43969305d1a26fb49981766e178144dab9ecf2'
    })
  }),
  Object.freeze({
    id: 'official-source-bf801196-v0521',
    version: '0.5.21',
    fingerprint: Object.freeze({
      'package.json': '233c293386c7f285815cf99579f3556263584dc7fcb7ab1a80d532d8c58f888d',
      'src/index.html': 'cf55be8e8cc92c851c4c871f73cb58ec53258fae76aab59b5547ad8ebab7f560',
      'electron/main.cjs': '64154e5fdb0a4a7e72203f22fad4e14099d32f4897838baffcbd63ace944495c',
      'electron/preload.cjs': '8b413e049cad7a66875c3a4158d4c6c6228f4cbf020b33348cd6d0f7b8984010'
    }),
    patch02Files: Object.freeze({
      'electron/subtitle-store.cjs': 'bfec7a17e735d63336e62b36fea3ed90412f821ec299591ffb71fcae7b3877be'
    }),
    patch04Files: Object.freeze({
      'src/player.js': '5f8876f77cff34cfbc990a3fa5383388947b47d88ee0501c43b1cb5a186ecdd7'
    }),
    patch03Files: Object.freeze({
      'src/app.js': 'dc82917c7bcb020e695a4c894c1fbc49d4f48c9d648992e6654bf518842cb433',
      'src/player.js': '5f8876f77cff34cfbc990a3fa5383388947b47d88ee0501c43b1cb5a186ecdd7'
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
  "  patchOpenChatGPTEmbedded: () => ipcRenderer.invoke('patch:chatgpt-web:open'),",
  "  patchChatGPTWebTranslate: input => ipcRenderer.invoke('patch:chatgpt-web:translate', input),",
  "  patchChatGPTWebTranslateFile: input => ipcRenderer.invoke('patch:chatgpt-web:translate-file', input),",
  "  patchCancelChatGPTWebTranslation: jobKey => ipcRenderer.invoke('patch:chatgpt-web:cancel', jobKey),",
  "  patchStartChatGPTWebBackgroundTranslation: input => ipcRenderer.invoke('patch:chatgpt-web:background:start', input),",
  "  patchChatGPTWebBackgroundStatus: jobKey => ipcRenderer.invoke('patch:chatgpt-web:background:status', jobKey),",
  "  patchCancelChatGPTWebBackgroundTranslation: jobKey => ipcRenderer.invoke('patch:chatgpt-web:background:cancel', jobKey),",
  "  patchAcknowledgeChatGPTWebBackgroundTranslation: (jobKey, confirmed) => ipcRenderer.invoke('patch:chatgpt-web:background:acknowledge', jobKey, confirmed),",
  "  patchDiscardChatGPTWebBackgroundTranslation: jobKey => ipcRenderer.invoke('patch:chatgpt-web:background:discard', jobKey),",
  "  onPatchChatGPTWebBackgroundUpdate: callback => { const listener = (_event, value) => callback?.(value); ipcRenderer.on('patch:chatgpt-web:background-update', listener); return () => ipcRenderer.removeListener('patch:chatgpt-web:background-update', listener); },",
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
const PATCH05_PRELOAD = Object.freeze([
  "  patchEpisodeQuality: episode => ipcRenderer.invoke('patch:episode-quality', episode),"
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
    'src/player.js',
    'src/player-android.css',
    'electron/subtitle-store.cjs',
    'src/patch-manager-feature-flags.js'
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
    'patch-02': settings.patches['patch-02'],
    'patch-03': settings.patches['patch-03'],
    'patch-04': settings.patches['patch-04']
  });
}

function mainBridgeSource(flags) {
  const lines = [];
  if (flags['patch-01'] || flags['patch-02']) {
    const stage2Flags = { 'patch-01': flags['patch-01'], 'patch-02': flags['patch-02'] };
    const deps = [`ipcMain`];
    if (flags['patch-01']) deps.push(
      'providerFetch', 'REANIME_WEB', 'ANIMENOSUB_WEB', 'reanimeItems',
      'miruroApi', 'miruroItem', 'miruroHasEpisodes', 'animenosubList', 'cheerio'
    );
    if (flags['patch-02']) deps.push('app', 'subtitleStore', 'clipboard: require("electron").clipboard', 'shell: require("electron").shell');
    lines.push(
      "  const { registerPatch0102Handlers } = require('./patch-manager-stage2.cjs');",
      '  registerPatch0102Handlers({',
      deps.map(value => `    ${value}`).join(',\n'),
      `  }, ${JSON.stringify(stage2Flags)});`
    );
  }
  if (flags['patch-03']) {
    lines.push(
      "  const { registerPatch05Handlers } = require('./patch-manager-stage5.cjs');",
      '  registerPatch05Handlers({',
      [
        '    ipcMain', '    providerFetch', '    resolveStreamPage', '    resolveProviderEpisode',
        '    reanimeServers', '    animenosubServers', '    miruroApi', '    MIRURO_KINDS',
        '    linkkfFetch', '    REANIME_WEB', '    ANIMENOSUB_WEB', '    LINKKF_WEB', '    OHLI24_WEB', '    LINKANI_WEB'
      ].join(',\n'),
      '  });',
      '  const resolveProviderEpisodeBeforePatch05 = resolveProviderEpisode;',
      '  resolveProviderEpisode = async episode => {',
      "    if (episode?.provider === 'reanime' && episode.patch05Server) {",
      '      const servers = await reanimeServers(episode);',
      '      const selected = servers.find(server => String(server.name || "") === String(episode.patch05Server));',
      "      if (!selected) throw new Error('선택한 Re:Anime 서버가 더 이상 제공되지 않습니다.');",
      '      return resolveStreamPage(selected.url, `${REANIME_WEB}/`, 30000);',
      '    }',
      '    return resolveProviderEpisodeBeforePatch05(episode);',
      '  };',
      "  ipcMain.removeHandler('linkkf:resolve');",
      "  ipcMain.handle('linkkf:resolve', async (_, episode) => {",
      '    playerStreamHeaders = null;',
      '    let playerUrl = "";',
      '    try {',
      '      const root = await linkkfFetch(`https://emdlinkkf.5imgdarr.top/apilink2.php?data=${encodeURIComponent(episode.token)}`);',
      '      const links = Array.isArray(root.data) ? root.data : [];',
      '      const chosen = episode.patch05Server ? links.find(item => String(item.server || "") === String(episode.patch05Server)) : null;',
      '      if (episode.patch05Server && !chosen) throw new Error("선택한 Linkkf 서버가 더 이상 제공되지 않습니다.");',
      '      playerUrl = (chosen || links.find(item => String(item.server).toUpperCase() === "NR-HD") || links[0] || {}).link || "";',
      '    } catch (error) { if (episode.patch05Server) throw error; }',
      '    if (!playerUrl) playerUrl = `${LINKKF_WEB}/up/${encodeURIComponent(episode.postId)}/watch/?slug=${encodeURIComponent(episode.slug)}`;',
      '    return resolveStreamPage(playerUrl, `${LINKKF_WEB}/`, 15000);',
      '  });'
    );
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function preloadBridgeSource(flags) {
  const lines = [];
  if (flags['patch-01']) lines.push(...PATCH01_PRELOAD);
  if (flags['patch-02']) lines.push(...PATCH02_PRELOAD);
  if (flags['patch-03']) lines.push(...PATCH05_PRELOAD);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function htmlBridgeSource(flags) {
  const scripts = new Set();
  scripts.add('patch-manager-feature-flags.js');
  if (flags['patch-01']) { scripts.add('patch-manager-stage2-core.js'); scripts.add('weekday-schedule.js'); scripts.add('integrated-search.js'); }
  if (flags['patch-02']) scripts.add('manual-subtitle-translation.js');
  if (flags['patch-03']) { scripts.add('integrated-search.js'); scripts.add('unified-catalog.js'); }
  if (flags['patch-04']) scripts.add('patch04-playback-stats.js');
  if (flags['patch-03']) scripts.add('patch05-episode-quality.js');
  if (flags['patch-01'] || flags['patch-02']) scripts.add('patch-manager-stage2.js');
  return `  ${[...scripts].map(file => `  <script src="${file}"></script>`).join('\n')}\n`;
}

function selectedPayloads(flags) {
  const selected = new Set();
  if (flags['patch-01'] || flags['patch-02']) for (const [, target] of SHARED_PAYLOAD_FILES) selected.add(target);
  for (const id of PATCH_IDS) {
    if (!flags[id]) continue;
    for (const [, target] of PATCH_PAYLOAD_FILES[id]) selected.add(target);
  }
  return [...selected].map(target => {
    const entry = [...SHARED_PAYLOAD_FILES, ...PATCH_IDS.flatMap(id => PATCH_PAYLOAD_FILES[id])]
      .find(([, candidate]) => candidate === target);
    if (!entry) throw new Error(`Missing payload mapping: ${target}`);
    return entry;
  });
}

function buildManifest(payloadRoot, profile, flags) {
  const expectedFiles = { ...profile.fingerprint };
  const actions = [{ kind: 'insert-before', file: 'src/index.html', anchor: '</body>', content: htmlBridgeSource(flags) }];
  const featureFlags = `window.DinoLilacPatchFeatures = Object.freeze(${JSON.stringify(flags)});\n`;
  actions.push({ kind: 'add-file', file: 'src/patch-manager-feature-flags.js', contentBase64: Buffer.from(featureFlags, 'utf8').toString('base64') });
  if (flags['patch-01'] || flags['patch-02'] || flags['patch-03']) actions.unshift(
    { kind: 'insert-before', file: 'electron/main.cjs', anchor: MAIN_ANCHOR, content: mainBridgeSource(flags) },
    { kind: 'insert-before', file: 'electron/preload.cjs', anchor: PRELOAD_ANCHOR, content: preloadBridgeSource(flags) }
  );
  if (flags['patch-02']) {
    expectedFiles['electron/subtitle-store.cjs'] = profile.patch02Files['electron/subtitle-store.cjs'];
    actions.push({ kind: 'insert-before', file: 'electron/subtitle-store.cjs', anchor: "'gemini'];", content: "'chatgpt', " });
  }
  if (flags['patch-04']) expectedFiles['src/player.js'] = profile.patch04Files['src/player.js'];
  if (flags['patch-03']) {
    expectedFiles['src/app.js'] = profile.patch03Files['src/app.js'];
    expectedFiles['src/player.js'] = profile.patch03Files['src/player.js'];
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
  for (const [id, filesKey] of [['patch-03', 'patch03Files'], ['patch-04', 'patch04Files']]) {
    if (!flags[id]) continue;
    const reviewedFiles = knownProfile?.[filesKey];
    if (!reviewedFiles) {
      setBlocked(patches, id, { kind: 'unreviewed-source-version', file: id === 'patch-04' ? 'src/player.js' : 'src/app.js' });
      continue;
    }
    for (const [file, expected] of Object.entries(reviewedFiles)) {
      if (hashes[file] !== expected) setBlocked(patches, id, { kind: 'target-fingerprint-mismatch', file });
    }
  }

  const enabled = PATCH_IDS.filter(id => patches[id]?.status === 'structural-candidate');
  const manifest = profile && enabled.length ? buildManifest(payloadRoot, profile, featureFlags({ patches: {
    'patch-01': enabled.includes('patch-01'),
    'patch-02': enabled.includes('patch-02'),
    'patch-03': enabled.includes('patch-03'),
    'patch-04': enabled.includes('patch-04')
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
