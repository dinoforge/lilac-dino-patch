const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalAi, LOCAL_AI_MODELS } = require('../electron/local-ai.cjs');
const { createTranslator } = require('../electron/subtitle-translator.cjs');

const RESTRICTED_IDS = ['hy-mt-7b', 'hy-mt-1.8b'];
function temporaryUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-local-ai-license-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('HY-MT1.5 presets are visible as restricted and cannot download or run', async t => {
  const userData = temporaryUserData(t), local = createLocalAi(userData);
  for (const id of RESTRICTED_IDS) {
    const model = LOCAL_AI_MODELS.find(item => item.id === id);
    assert.equal(model?.licenseBlocked, true, `${id} must carry the regional license restriction`);
    assert.equal(local.models().find(item => item.id === id)?.licenseBlocked, true, `${id} must be visible as restricted`);
    await assert.rejects(local.installModel(id), /대한민국을 적용 지역에서 제외/);
    await assert.rejects(local.translateLines(['日本語'], { modelId: id }), /대한민국을 적용 지역에서 제외/);
    assert.equal(fs.existsSync(local.modelPath(model)), false, `${id} must not leave a download behind`);
  }
});

test('existing restricted model files are preserved and saved selection falls back safely', async t => {
  const userData = temporaryUserData(t), blocked = LOCAL_AI_MODELS.find(item => item.id === 'hy-mt-7b');
  const local = createLocalAi(userData), file = local.modelPath(blocked);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'existing user model');
  fs.writeFileSync(path.join(userData, 'translation.json'), JSON.stringify({ localModel: blocked.id }));

  const translator = createTranslator(userData), settings = translator.settings();
  assert.equal(settings.localModel, 'gemma-4-e4b');
  assert.equal(settings.localModels.find(item => item.id === blocked.id)?.installed, true);
  assert.equal(settings.localModels.find(item => item.id === blocked.id)?.licenseBlocked, true);
  await assert.rejects(translator.saveSettings({ localModel: blocked.id }), /대한민국을 적용 지역에서 제외/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing user model');
});
