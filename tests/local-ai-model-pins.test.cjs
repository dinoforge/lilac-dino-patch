const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLocalAi, LOCAL_AI_MODELS, promptVersion } = require('../electron/local-ai.cjs');

function temporaryUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-local-ai-pins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('every downloadable preset has a fixed revision and SHA-256', () => {
  const presets = LOCAL_AI_MODELS.filter(model => !model.licenseBlocked);
  assert.equal(presets.length, 8);
  for (const model of presets) {
    assert.match(model.revision, /^[a-f0-9]{40}$/, `${model.id} revision`);
    assert.match(model.sha256, /^[a-f0-9]{64}$/, `${model.id} SHA-256`);
    assert.ok(model.size > 0, `${model.id} expected size`);
  }
});

test('Aya Expanse exposes its terms and asks before starting a download', () => {
  const model = LOCAL_AI_MODELS.find(item => item.id === 'aya-expanse-8b');
  assert.equal(model.licenseAcknowledgementRequired, true);
  assert.equal(model.licenseUrl, 'https://cohere.com/cohere-labs-cc-by-nc-license');

  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(renderer, /window\.lilac\.openExternal\(model\.licenseUrl\)/);
  const install = renderer.match(/async function installLocalModel\(id\)\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(install, 'installLocalModel function exists');
  assert.match(install, /licenseAcknowledgementRequired[\s\S]*?confirm\(/);
  assert.ok(install.indexOf('confirm(') < install.indexOf('localModelProgress[id]=0'), 'declining does not start download progress');
});

test('model download pins the URL and verifies fresh, resumed, and mismatched files', async t => {
  const userData = temporaryUserData(t);
  const model = LOCAL_AI_MODELS.find(item => item.id === 'hy-mt2-1.8b');
  const expectedSha256 = model.sha256;
  const originalFetch = global.fetch;
  const full = Buffer.from('synthetic pinned model bytes');
  const prefix = Buffer.from('synthetic pinned ');
  const suffix = full.subarray(prefix.length);
  const urlCalls = [];
  const local = createLocalAi(userData);
  const target = local.modelPath(model);

  t.after(() => {
    global.fetch = originalFetch;
    model.sha256 = expectedSha256;
  });

  try {
    model.sha256 = crypto.createHash('sha256').update(full).digest('hex');
    global.fetch = async url => {
      urlCalls.push(String(url));
      return new Response(full, { status: 200 });
    };
    await local.installModel(model.id);
    assert.match(urlCalls.at(-1), new RegExp(`/resolve/${model.revision}/`));
    assert.equal(fs.readFileSync(target).toString(), full.toString());

    fs.unlinkSync(target);
    fs.writeFileSync(`${target}.part`, prefix);
    global.fetch = async (url, options) => {
      urlCalls.push(String(url));
      assert.equal(options.headers.Range, `bytes=${prefix.length}-`);
      return new Response(suffix, { status: 206 });
    };
    await local.installModel(model.id);
    assert.equal(fs.readFileSync(target).toString(), full.toString());

    fs.unlinkSync(target);
    model.sha256 = '0'.repeat(64);
    global.fetch = async url => {
      urlCalls.push(String(url));
      return new Response(full, { status: 200 });
    };
    await assert.rejects(local.installModel(model.id), /SHA-256/);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(`${target}.part`), false);
  } finally {
    global.fetch = originalFetch;
    model.sha256 = expectedSha256;
  }
});

test('custom GGUF input options are validated, preserved, and version the translation cache', async t => {
  const userData = temporaryUserData(t), local = createLocalAi(userData);
  const root = path.join(userData, 'local-ai'), modelFile = path.join(userData, 'custom.gguf');
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(modelFile, 'test model bytes');
  fs.writeFileSync(path.join(root, 'added.json'), JSON.stringify([{ path: modelFile, size: fs.statSync(modelFile).size }]));

  const id = `file:${modelFile}`;
  const before = local.models().find(model => model.id === id);
  assert.equal(before.inputMode, 'auto');
  assert.equal(before.sourceLanguage, 'auto');
  local.setModelOptions(id, { inputMode: 'chat', sourceLanguage: 'ja', customPrompt: 'Translate {text} into {target_lang}.' });
  const after = local.models().find(model => model.id === id);
  assert.equal(after.inputMode, 'chat');
  assert.equal(after.sourceLanguage, 'ja');
  assert.equal(after.customPrompt, 'Translate {text} into {target_lang}.');
  assert.notEqual(promptVersion(before), promptVersion(after));
  assert.throws(() => local.setModelOptions(id, { inputMode: 'invalid', sourceLanguage: 'ja', customPrompt: '{text}' }), /입력 형식/);
  assert.throws(() => local.setModelOptions(id, { inputMode: 'chat', sourceLanguage: 'ja', customPrompt: 'missing text token' }), /\{text\}/);
  assert.equal(local.models().find(model => model.id === id).customPrompt, after.customPrompt, 'invalid options do not replace the saved configuration');
});
