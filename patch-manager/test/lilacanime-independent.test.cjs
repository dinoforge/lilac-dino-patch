'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { makeLilacAnimePatchPlan } = require('../adapters/lilacanime-independent.cjs');
const { applyPersistent, rollbackPersistent } = require('../persistent.cjs');
const { cleanupSyntheticFixture } = require('../staging.cjs');
const { registerPatch0102Handlers } = require('../../electron/patch-manager-stage2.cjs');

const sourceSets = [
  { version: '0.5.15', root: process.env.LILAC_UPSTREAM_V0515_SOURCE || '' },
  { version: '0.5.21', root: process.env.LILAC_UPSTREAM_V0521_SOURCE || '' }
].map(item => ({ ...item, available: Boolean(item.root && fs.existsSync(path.join(item.root, '.git'))) }));

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function trackedFiles(root) {
  const result = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'buffer' });
  if (result.status !== 0) throw new Error(`Cannot enumerate isolated official source: ${result.stderr.toString('utf8')}`);
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function snapshot(root, files) {
  return Object.fromEntries(files.map(file => [file, sha256(fs.readFileSync(path.join(root, ...file.split('/'))))]));
}

function assertPatchedJavaScriptSyntax(root, manifest) {
  const files = new Set(manifest.actions
    .map(action => action.file)
    .filter(file => /\.(?:cjs|js)$/.test(file)));
  for (const relative of files) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, ...relative.split('/'))], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${relative} syntax check failed:\n${result.stderr || result.stdout}`);
  }
}

function createMarkedSourceCopy(sourceRoot) {
  const temp = fs.realpathSync(os.tmpdir());
  const source = fs.realpathSync(sourceRoot);
  const relativeSource = path.relative(temp, source);
  assert.ok(relativeSource && !relativeSource.startsWith('..') && !path.isAbsolute(relativeSource),
    'official source must be an isolated copy under the OS temp folder');
  assert.notEqual(path.resolve(source), path.resolve('D:\\LilacAnime'));

  const files = trackedFiles(source);
  const root = fs.mkdtempSync(path.join(temp, 'dino-lilac-independent-fixture-'));
  const marker = {
    root: path.basename(root),
    kind: 'synthetic',
    safety: 'no-real-installation',
    nonce: crypto.randomBytes(16).toString('hex')
  };
  try {
    for (const relative of files) {
      const from = path.join(source, ...relative.split('/'));
      const stat = fs.lstatSync(from);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `unsupported official source entry: ${relative}`);
      const to = path.join(root, ...relative.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    }
    fs.writeFileSync(`${root}.lilac-patch-manager-synthetic-fixture.json`, JSON.stringify(marker), { flag: 'wx' });
    fs.writeFileSync(path.join(root, '.lilac-patch-manager-synthetic-fixture.json'), JSON.stringify(marker), { flag: 'wx' });
    return { root, files, sourceRoot: source };
  } catch (error) {
    if (fs.existsSync(`${root}.lilac-patch-manager-synthetic-fixture.json`)) cleanupSyntheticFixture(root);
    else fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function withOfficialFixture(sourceRoot, callback) {
  const fixture = createMarkedSourceCopy(sourceRoot);
  try { return callback(fixture); }
  finally { cleanupSyntheticFixture(fixture.root); }
}

function settings(patch01, patch02, patch03 = false, patch04 = false) {
  return { patches: { 'patch-01': patch01, 'patch-02': patch02, 'patch-03': patch03, 'patch-04': patch04 } };
}

function assertOnlyPatch(plan, id) {
  assert.ok(plan.manifest, 'selected compatible patch must produce a manifest');
  assert.equal(plan.patches[id].status, 'structural-candidate');
  for (const other of ['patch-01', 'patch-02', 'patch-03', 'patch-04']) if (other !== id) assert.equal(plan.patches[other].status, 'disabled');
  const files = plan.manifest.actions.filter(action => action.kind === 'add-file').map(action => action.file);
  const html = plan.manifest.actions.find(action => action.file === 'src/index.html').content;
  const flagsContent = Buffer.from(plan.manifest.actions.find(action => action.file === 'src/patch-manager-feature-flags.js').contentBase64, 'base64').toString('utf8');
  const main = plan.manifest.actions.find(action => action.file === 'electron/main.cjs')?.content || '';
  const preload = plan.manifest.actions.find(action => action.file === 'electron/preload.cjs')?.content || '';
  if (id === 'patch-01') {
    assert.ok(files.includes('src/weekday-schedule.js'));
    assert.ok(files.includes('electron/weekday-episodes.cjs'));
    assert.ok(files.includes('src/patch-manager-stage2.js'));
    assert.ok(!files.includes('src/manual-subtitle-translation.js'));
    assert.ok(!files.includes('electron/embedded-chatgpt-web.cjs'));
    assert.match(flagsContent, /"patch-01":true,"patch-02":false,"patch-03":false,"patch-04":false/);
    assert.match(html, /weekday-schedule\.js/);
    assert.doesNotMatch(html, /manual-subtitle-translation\.js|siwc-subtitle-bridge\.js/);
    assert.match(main, /\{"patch-01":true,"patch-02":false\}/);
    assert.match(preload, /patchWeekdayEpisodes/);
    assert.doesNotMatch(preload, /patchSIWC|patchManualTranslation/);
  } else if (id === 'patch-02') {
    assert.ok(!files.includes('src/weekday-schedule.js'));
    assert.ok(files.includes('src/manual-subtitle-translation.js'));
    assert.ok(files.includes('electron/embedded-chatgpt-web.cjs'));
    assert.ok(!files.includes('electron/siwc-client.cjs'));
    assert.ok(files.includes('electron/prompts/영어 번역 프롬프트.txt'));
    assert.match(flagsContent, /"patch-01":false,"patch-02":true,"patch-03":false,"patch-04":false/);
    assert.doesNotMatch(html, /weekday-schedule\.js|patch-manager-stage2-core\.js/);
    assert.match(html, /manual-subtitle-translation\.js[\s\S]*patch-manager-stage2\.js/);
    assert.doesNotMatch(html, /siwc-subtitle-bridge\.js/);
    assert.match(main, /\{"patch-01":false,"patch-02":true\}/);
    assert.doesNotMatch(main, /providerFetch|REANIME_WEB/);
    assert.match(preload, /patchTranslationPrompt/);
    assert.match(preload, /patchOpenChatGPTEmbedded/);
    assert.doesNotMatch(preload, /patchSIWC/);
    assert.doesNotMatch(preload, /patchQuarter|patchWeekdayEpisodes/);
  }
  if (id === 'patch-03') {
    assert.ok(files.includes('src/integrated-search.js'));
    assert.ok(files.includes('src/unified-catalog.js'));
    assert.ok(files.includes('src/unified-catalog.css'));
    assert.ok(files.includes('src/patch05-episode-quality.js'));
    assert.ok(files.includes('src/patch05-episode-quality.css'));
    assert.ok(files.includes('electron/patch-manager-stage5.cjs'));
    assert.ok(!files.includes('src/patch-manager-stage2.js'));
    assert.ok(!files.includes('electron/patch-manager-stage2.cjs'));
    assert.match(html, /integrated-search\.js[\s\S]*unified-catalog\.js/);
    assert.match(html, /unified-catalog\.js[\s\S]*patch05-episode-quality\.js/);
    assert.match(flagsContent, /"patch-01":false,"patch-02":false,"patch-03":true,"patch-04":false/);
    assert.match(html, /patch-manager-feature-flags\.js/);
    assert.doesNotMatch(html, /patch-manager-stage2\.js/);
    assert.match(main, /registerPatch05Handlers/);
    assert.match(main, /episode\.patch05Server/);
    assert.match(preload, /patchEpisodeQuality/);
  } else if (id === 'patch-04') {
    assert.ok(files.includes('src/patch04-playback-stats.js'));
    assert.ok(files.includes('src/patch04-playback-stats.css'));
    assert.match(html, /patch04-playback-stats\.js/);
    assert.match(flagsContent, /"patch-04":true/);
    assert.doesNotMatch(html, /manual-subtitle-translation\.js|patch05-episode-quality\.js/);
    assert.equal(plan.manifest.actions.some(action => ['electron/main.cjs', 'electron/preload.cjs'].includes(action.file)), false);
  } else {
    assert.equal(files.filter(file => file === 'src/patch-manager-stage2.js').length, 1, 'shared renderer bridge is copied once');
    assert.equal(files.filter(file => file === 'electron/patch-manager-stage2.cjs').length, 1, 'shared IPC bridge is copied once');
    assert.doesNotMatch(html, /unified-catalog\.js|unified-catalog\.css/);
  }
  assert.ok(files.includes('src/patch-manager-feature-flags.js'));
  assert.match(html, /<script src="patch-manager-feature-flags\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>window\.DinoLilacPatchFeatures/);
}

test('shared renderer bridge starts with Patch 01 or Patch 02 dependencies independently', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/patch-manager-stage2.js'), 'utf8');
  const run = flags => {
    const context = {
      DinoLilacPatchFeatures: flags,
      lilac: {},
      document: { readyState: 'loading', addEventListener() {}, querySelector() { return null; } },
      localStorage: { getItem() { return null; }, setItem() {} },
      addEventListener() {},
      setInterval() {}
    };
    context.window = context;
    if (flags['patch-01']) {
      context.LilacPatchStage2Core = { readQuarterSelection: () => ({ year: 2026, quarter: 4 }) };
      context.LilacWeekdaySchedule = {};
      context.LilacIntegratedSearch = {};
      context.renderCards = () => {};
      context.openDetail = () => {};
      context.animeById = () => null;
    }
    if (flags['patch-02']) context.LilacManualSubtitle = {};
    vm.runInNewContext(source, context, { filename: 'src/patch-manager-stage2.js' });
    return context.LilacPersistentPatch0102;
  };
  for (const flags of [
    { 'patch-01': true, 'patch-02': false },
    { 'patch-01': false, 'patch-02': true },
    { 'patch-01': true, 'patch-02': true }
  ]) {
    const result = run(flags);
    assert.equal(result.enabled['patch-01'], flags['patch-01']);
    assert.equal(result.enabled['patch-02'], flags['patch-02']);
  }
  assert.equal(run({ 'patch-01': false, 'patch-02': false }), undefined);
});

test('main IPC registration loads only the selected patch handlers', () => {
  const createDeps = () => {
    const handlers = new Map();
    return {
      handlers,
      deps: {
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        app: { getPath: () => os.tmpdir() },
        subtitleStore: { save: () => ({}) },
        clipboard: { writeText() {}, readText() { return ''; } },
        shell: {}
      }
    };
  };

  const patch01 = createDeps();
  assert.deepEqual(registerPatch0102Handlers(patch01.deps, { 'patch-01': true, 'patch-02': false }).registered, [
    'patch:quarter', 'patch:weekday-episodes'
  ]);
  assert.deepEqual([...patch01.handlers.keys()], ['patch:quarter', 'patch:weekday-episodes']);

  const patch02 = createDeps();
  const patch02Routes = registerPatch0102Handlers(patch02.deps, { 'patch-01': false, 'patch-02': true }).registered;
  assert.ok(patch02Routes.includes('patch:translation-prompt'));
  assert.ok(patch02Routes.includes('manual-translation:session:get'));
  assert.ok(!patch02Routes.includes('patch:quarter'));
  assert.ok(!patch02.handlers.has('patch:weekday-episodes'));

  assert.deepEqual(registerPatch0102Handlers(undefined, { 'patch-01': false, 'patch-02': false }), { registered: [] });
});

for (const source of sourceSets) {
test(`official LilacAnime ${source.version}: all 16 Patch 01-04 combinations apply and roll back`, {
    skip: !source.available && `Set LILAC_UPSTREAM_V${source.version.replaceAll('.', '')}_SOURCE to the isolated official source clone`
  }, () => withOfficialFixture(source.root, ({ root, files, sourceRoot }) => {
    const officialBefore = snapshot(sourceRoot, files);
    const fixtureBefore = snapshot(root, files);

    const offOff = makeLilacAnimePatchPlan(root, settings(false, false));
    assert.equal(offOff.status, 'disabled');
    assert.equal(offOff.manifest, null);
    assert.deepEqual(snapshot(root, files), fixtureBefore, 'OFF/OFF must leave every source file untouched');

    const combinations = [];
    for (const p1 of [false, true]) for (const p2 of [false, true]) for (const p3 of [false, true]) for (const p4 of [false, true]) {
      if (!p1 && !p2 && !p3 && !p4) continue;
      combinations.push([settings(p1, p2, p3, p4), [p1 && 'patch-01', p2 && 'patch-02', p3 && 'patch-03', p4 && 'patch-04'].filter(Boolean).join('+')]);
    }
    for (const [flags, id] of combinations) {
      const plan = makeLilacAnimePatchPlan(root, flags);
      assert.equal(plan.status, 'ready-for-isolated-application', JSON.stringify(plan.patches));
      assert.equal(plan.version, source.version);
      assert.ok(plan.profile);
      const enabledCount = Object.values(flags.patches).filter(Boolean).length;
      if (enabledCount === 1) assertOnlyPatch(plan, id);
      else {
        assert.deepEqual(Object.keys(plan.manifest.expectedFiles).sort(), [
          'electron/main.cjs', 'electron/preload.cjs',
          ...(flags.patches['patch-02'] ? ['electron/subtitle-store.cjs'] : []),
          ...(flags.patches['patch-04'] || flags.patches['patch-03'] ? ['src/player.js'] : []),
          ...(flags.patches['patch-03'] ? ['src/app.js'] : []),
          'package.json', 'src/index.html'
        ].sort());
        const additions = plan.manifest.actions.filter(action => action.kind === 'add-file').map(action => action.file);
        assert.equal(additions.includes('src/weekday-schedule.js'), flags.patches['patch-01']);
        assert.equal(additions.includes('src/manual-subtitle-translation.js'), flags.patches['patch-02']);
        assert.equal(additions.includes('src/unified-catalog.js'), flags.patches['patch-03']);
        assert.equal(additions.includes('src/patch04-playback-stats.js'), flags.patches['patch-04']);
        assert.equal(additions.includes('src/patch05-episode-quality.js'), flags.patches['patch-03']);
        assert.equal(additions.includes('src/patch05-episode-quality.css'), flags.patches['patch-03']);
        assert.equal(additions.includes('electron/patch-manager-stage5.cjs'), flags.patches['patch-03']);
        assert.equal(additions.filter(file => file === 'src/patch-manager-stage2.js').length, flags.patches['patch-01'] || flags.patches['patch-02'] ? 1 : 0);
        assert.equal(additions.filter(file => file === 'electron/patch-manager-stage2.cjs').length, flags.patches['patch-01'] || flags.patches['patch-02'] ? 1 : 0);
      }

      const applied = applyPersistent(root, plan.manifest);
      assert.equal(applied.status, 'applied');
      assertPatchedJavaScriptSyntax(root, plan.manifest);
      const duplicate = applyPersistent(root, plan.manifest);
      assert.equal(duplicate.status, 'already-applied');
      const rolled = rollbackPersistent(root);
      assert.equal(rolled.status, 'rolled-back');
      assert.deepEqual(snapshot(root, files), fixtureBefore, `${id} rollback restores all official source bytes`);
      for (const action of plan.manifest.actions.filter(item => item.kind === 'add-file')) {
        assert.equal(fs.existsSync(path.join(root, ...action.file.split('/'))), false, `removed ${action.file}`);
      }
      assert.deepEqual(snapshot(sourceRoot, files), officialBefore, 'application must not modify the read-only official source clone');
    }
  }));

  test(`official LilacAnime ${source.version}: one incompatible patch does not block the other`, {
    skip: !source.available && `Set LILAC_UPSTREAM_V${source.version.replaceAll('.', '')}_SOURCE to the isolated official source clone`
  }, () => withOfficialFixture(source.root, ({ root, files, sourceRoot }) => {
    const officialBefore = snapshot(sourceRoot, files);
    const appFile = path.join(root, 'src', 'app.js');
    const originalApp = fs.readFileSync(appFile);
    fs.writeFileSync(appFile, originalApp.toString('utf8').replace('function animeById(', 'function renamedAnimeLookup('));
    const plan01Blocked = makeLilacAnimePatchPlan(root, settings(true, true));
    assert.equal(plan01Blocked.status, 'partially-blocked');
    assert.equal(plan01Blocked.patches['patch-01'].status, 'blocked');
    assert.equal(plan01Blocked.patches['patch-02'].status, 'structural-candidate');
    assert.ok(plan01Blocked.manifest);
    assert.doesNotMatch(plan01Blocked.manifest.actions.find(action => action.file === 'src/index.html').content, /weekday-schedule\.js/);
    assert.equal(applyPersistent(root, plan01Blocked.manifest).status, 'applied');
    assert.equal(rollbackPersistent(root).status, 'rolled-back');

    fs.writeFileSync(appFile, originalApp);
    const storeFile = path.join(root, 'electron', 'subtitle-store.cjs');
    const originalStore = fs.readFileSync(storeFile);
    fs.writeFileSync(storeFile, originalStore.toString('utf8').replace("'gemini'];", "'gemini']; // changed"));
    const plan02Blocked = makeLilacAnimePatchPlan(root, settings(true, true));
    assert.equal(plan02Blocked.status, 'partially-blocked');
    assert.equal(plan02Blocked.patches['patch-01'].status, 'structural-candidate');
    assert.equal(plan02Blocked.patches['patch-02'].status, 'blocked');
    assert.ok(plan02Blocked.manifest);
    assert.match(plan02Blocked.manifest.actions.find(action => action.file === 'src/index.html').content, /weekday-schedule\.js/);
    assert.doesNotMatch(plan02Blocked.manifest.actions.find(action => action.file === 'src/index.html').content, /manual-subtitle-translation\.js|siwc-subtitle-bridge\.js/);
    assert.equal(applyPersistent(root, plan02Blocked.manifest).status, 'applied');
    assert.equal(rollbackPersistent(root).status, 'rolled-back');

    assert.deepEqual(snapshot(sourceRoot, files), officialBefore, 'incompatibility probes do not modify the official source');
  }));

  test(`official LilacAnime ${source.version}: failed staging leaves its source copy unchanged`, {
    skip: !source.available && `Set LILAC_UPSTREAM_V${source.version.replaceAll('.', '')}_SOURCE to the isolated official source clone`
  }, () => withOfficialFixture(source.root, ({ root, files, sourceRoot }) => {
    const plan = makeLilacAnimePatchPlan(root, settings(false, true));
    assert.ok(plan.manifest);
    const before = snapshot(root, files);
    const officialBefore = snapshot(sourceRoot, files);
    const blocker = path.join(root, 'electron', 'prompts');
    fs.writeFileSync(blocker, 'synthetic staging obstruction');
    assert.throws(() => applyPersistent(root, plan.manifest));
    const after = snapshot(root, files);
    assert.deepEqual(after, before, 'a failed staging operation must not modify the copied application files');
    assert.deepEqual(snapshot(sourceRoot, files), officialBefore, 'a failed test must not modify the official source clone');
  }));
}

test('an unseen fingerprint with compatible structure is eligible only for isolated application', {
  skip: !sourceSets[0].available && 'Set LILAC_UPSTREAM_V0514_SOURCE to the isolated official source clone'
}, () => withOfficialFixture(sourceSets[0].root, ({ root, files, sourceRoot }) => {
  const packageFile = path.join(root, 'package.json');
  const original = fs.readFileSync(packageFile);
  const sourceBefore = snapshot(sourceRoot, files);
  for (const bytes of [
    Buffer.concat([original, Buffer.from('\n')]),
    Buffer.from(`${JSON.stringify({ ...JSON.parse(original.toString('utf8')), version: '0.5.16' }, null, 2)}\n`)
  ]) {
    fs.writeFileSync(packageFile, bytes);
    const plan = makeLilacAnimePatchPlan(root, settings(true, false));
    assert.equal(plan.status, 'ready-for-isolated-application');
    assert.equal(plan.manifest.version, JSON.parse(bytes.toString('utf8')).version);
    assert.ok(plan.patches['patch-01'].issues.some(issue => issue.kind === 'unreviewed-source-fingerprint'));
    assert.equal(applyPersistent(root, plan.manifest).status, 'applied');
    assertPatchedJavaScriptSyntax(root, plan.manifest);
    assert.equal(rollbackPersistent(root).status, 'rolled-back');
    fs.writeFileSync(packageFile, original);
  }
  assert.deepEqual(snapshot(root, files), snapshot(sourceRoot, files), 'each isolated candidate returns to the untouched source bytes');
  assert.deepEqual(snapshot(sourceRoot, files), sourceBefore, 'the official source clone remains unchanged');
}));
