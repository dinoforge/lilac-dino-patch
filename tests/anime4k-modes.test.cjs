const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

test('official Anime4K profiles are available in the player settings and map to installed shaders', async () => {
  const { profiles } = await import('../scripts/anime4k-entry.mjs');
  const expected = ['off', 'light', 'a', 'b', 'c', 'aa', 'bb', 'ca', 'hq'];
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../src/anime4k.js'), 'utf8');
  const advertised = [...html.matchAll(/data-anime4k="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(advertised, expected);
  for (const mode of expected.slice(1)) {
    assert.ok(Array.isArray(profiles[mode]) && profiles[mode].length > 0, `missing shader profile ${mode}`);
    assert.match(renderer, new RegExp(`\\b${mode}:`), `renderer does not accept ${mode}`);
  }
  assert.ok(!Object.hasOwn(profiles, 'off'), 'off must continue to bypass the upscaler');
});
