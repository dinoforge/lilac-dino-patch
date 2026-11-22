const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

function artworkMain(userData) {
  const start = mainSource.indexOf('let artworkDisk=null;');
  const end = mainSource.indexOf("ipcMain.handle('anime:overview'", start);
  assert.ok(start >= 0 && end > start, 'Missing official artwork lookup');
  let bannerLookups = 0;
  const context = vm.createContext({
    fs, path, Buffer, AbortSignal, app: { getPath: () => userData }, tmdbKey: () => '',
    tmdbQueries: () => [], tmdbPick: async () => null, tmdbFetch: async () => null,
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
    hasHangul: value => /[가-힣]/.test(String(value)),
    requestAniListGraphQL: async (_query, variables, options) => { bannerLookups++; assert.equal(variables.id, 182255); assert.equal(options.timeoutMs, 20000); return { ok: true, json: async () => ({ data: { Media: { bannerImage: 'https://img.example/banner.jpg' } } }) }; }
  });
  vm.runInContext(`${mainSource.slice(start, end)}\nthis.lookupArtwork=animeArtwork;`, context);
  return { lookup: context.lookupArtwork, bannerLookups: () => bannerLookups };
}

function artworkRenderer() {
  const start = appSource.indexOf('const detailArtworkCache=new Map();');
  const end = appSource.indexOf('// Home spotlight', start);
  assert.ok(start >= 0 && end > start, 'Missing detail artwork renderer');
  const classes = () => {
    const values = new Set();
    return { add: value => values.add(value), contains: value => values.has(value), toggle: (value, enabled) => enabled ? values.add(value) : values.delete(value) };
  };
  const hero = { style: {}, classList: classes() };
  const title = { previousElementSibling: null, classList: classes(), before(element) { this.previousElementSibling = element; } };
  const logo = { className: '', classList: classes(), alt: '', src: '' };
  class TestImage { set src(value) { this.value = value; this.onload?.(); } }
  const calls = [];
  const context = vm.createContext({
    window: { lilac: { animeArtwork: async anime => { calls.push(anime); return { banner: 'banner.png', logos: [{ url: 'logo.png', light: 0.9 }] }; } } },
    document: { body: { classList: { contains: () => false } }, createElement: () => logo },
    Image: TestImage, displayImage: async url => `resolved:${url}`,
    $: selector => selector.endsWith('.detail-hero') ? hero : title,
    openDetail: function openDetail() { openDetail.token = null; }
  });
  vm.runInContext(`${appSource.slice(start, end)}\nthis.artwork={detailArtworkFor,applyDetailArtwork};`, context);
  return { context, calls, hero, title, logo };
}

test('official artwork lookup uses the isolated user cache and reuses its cached banner', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-artwork-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = artworkMain(dir);
  const anime = { provider: 'miruro', id: '182255', mal_id: 59978, title: 'Frieren', anilistId: 182255 };
  const first = await main.lookup(anime);
  const second = await main.lookup(anime);
  assert.equal(first.banner, 'https://img.example/banner.jpg');
  assert.equal(first.logos.length, 0);
  assert.equal(second.banner, first.banner);
  assert.equal(main.bannerLookups(), 1);
  assert.equal(fs.existsSync(path.join(dir, 'artwork-cache.json')), true);
});

test('detail artwork uses the preload API and ignores a result after another detail opens', async () => {
  assert.match(preloadSource, /animeArtwork:\s*anime\s*=>\s*ipcRenderer\.invoke\('anime:artwork',\s*anime\)/);
  assert.match(mainSource, /ipcMain\.handle\('anime:artwork'/);
  const renderer = artworkRenderer(), token = Symbol('current detail');
  const result = await renderer.context.artwork.detailArtworkFor({ provider: 'reanime', id: 'series-1', mal_id: 1, title: '작품', anilistId: 9 });
  assert.equal(renderer.calls.length, 1);
  assert.equal(renderer.calls[0].id, 'series-1');
  assert.equal(renderer.calls[0].anilistId, 9);
  assert.equal(result.banner, 'resolved:banner.png');
  assert.equal(result.logo.url, 'resolved:logo.png');

  renderer.context.openDetail.token = Symbol('newer detail');
  renderer.context.artwork.applyDetailArtwork(result, token);
  assert.equal(renderer.hero.style.backgroundImage, undefined);
  renderer.context.openDetail.token = token;
  renderer.context.artwork.applyDetailArtwork(result, token);
  assert.equal(renderer.hero.style.backgroundImage, 'url("resolved:banner.png")');
  assert.equal(renderer.hero.classList.contains('banner'), true);
  assert.equal(renderer.title.previousElementSibling, renderer.logo);
  assert.equal(renderer.title.classList.contains('under-logo'), true);
  assert.equal(renderer.logo.src, 'resolved:logo.png');
});
