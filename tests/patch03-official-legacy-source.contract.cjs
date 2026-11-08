const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createRequire } = require('node:module');
const test = require('node:test');

const sourceRoot = process.env.DINO_OFFICIAL_SOURCE_ROOT;
if (!sourceRoot || !path.isAbsolute(sourceRoot)) {
  throw new Error('Set DINO_OFFICIAL_SOURCE_ROOT to the verified, clean v0.5.58 source fixture.');
}

const root = path.resolve(sourceRoot);
function read(relativePath) {
  const file = path.resolve(root, relativePath);
  assert.ok(file.startsWith(`${root}${path.sep}`), `source path escaped fixture: ${relativePath}`);
  return fs.readFileSync(file, 'utf8');
}

const app = read('src/app.js');
const html = read('src/index.html');
const scheduleRenderer = read('src/weekly-schedule.js');
const main = read('electron/main.cjs');
const preload = read('electron/preload.cjs');
const providerScheduleSource = read('electron/provider-schedule.cjs');

const projectNodeModules = path.resolve(__dirname, '..', 'node_modules');
process.env.NODE_PATH = [projectNodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const requireFromOfficial = createRequire(path.join(root, 'electron', 'main.cjs'));
const { createProviderSchedule, weekDate } = requireFromOfficial(path.join(root, 'electron', 'provider-schedule.cjs'));

test('v0.5.58 defaults an absent source to reanime and does not list integrated as an official provider', () => {
  assert.match(app, /source:\s*localStorage\.getItem\('contentSource'\)\s*\|\|\s*'reanime'/);
  assert.match(app, /PROVIDER_SOURCES\s*=\s*\['reanime','animenosub','miruro','ohli24','linkani'\]/);
  assert.doesNotMatch(app.match(/const PROVIDER_SOURCES[^;]+;/)?.[0] || '', /integrated/);

  const version = JSON.parse(read('package.json')).version;
  assert.equal(version, '0.5.58');
});

test('the original home continues through its general season and top fallback for an unrecognized source', () => {
  assert.match(app, /if\(state\.source==='linkkf'\)[\s\S]*?else if\(PROVIDER_SOURCES\.includes\(state\.source\)\)[\s\S]*?else \[season,top\]=await Promise\.all\(\[window\.lilac\.season\(\),window\.lilac\.top\(\)\]\)/);
  assert.match(preload, /season:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('anime:season'\)/);
  assert.match(preload, /top:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('anime:top'\)/);
});

test('integrated falls back to the original generic search and generic detail routes, not Dino providers', () => {
  assert.match(app, /const search=text=>PROVIDER_SOURCES\.includes\(state\.source\)\?window\.lilac\.providerCatalog\(state\.source,text\):state\.source==='linkkf'\?window\.lilac\.linkkfSearch\(text\):window\.lilac\.search\(text\)/);
  assert.match(preload, /search:\s*query\s*=>\s*ipcRenderer\.invoke\('anime:search',\s*query\)/);
  assert.match(main, /ipcMain\.handle\('anime:search',[\s\S]*?=>\s*api\(`\/anime\?q=/);

  assert.match(app, /const isExternal=\/\^\(animenosub\|reanime\|miruro\|ohli24\|linkani\):\/\.test\(String\(id\)\)/);
  assert.match(app, /isExternal\?providerResult:await window\.lilac\.detail\(id\)/);
  assert.match(app, /if\(isExternal&&providerResult\.episodes\?\.length\)/);
});

test('the settings control has no integrated option but an explicit official-source choice persists and reloads', () => {
  const select = html.match(/<select id="contentSource"[\s\S]*?<\/select>/)?.[0];
  assert.ok(select, 'official content source select exists');
  const options = [...select.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
  assert.ok(options.includes('reanime'));
  assert.ok(options.includes('linkkf'));
  assert.equal(options.includes('integrated'), false);
  assert.match(app, /\$\('#contentSource'\)\.onchange=e=>\{localStorage\.setItem\('contentSource',e\.target\.value\);[\s\S]*?location\.reload\(\)/);
});

test('provider catalog and weekly schedule reject integrated while the weekly UI catches the error', async () => {
  assert.match(main, /if\s*\(provider\s*===\s*'miruro'\)[\s\S]*?throw new Error\('지원하지 않는 콘텐츠 소스입니다\.'\)/);
  assert.match(providerScheduleSource, /if\s*\(!Object\.hasOwn\(LABELS,\s*provider\)\s*\|\|\s*!Number\.isInteger\(day\)[\s\S]*?throw new Error\('올바른 소스와 방영 요일을 선택해 주세요\.'\)/);
  assert.match(scheduleRenderer, /window\.lilac\.providerSchedule\(state\.source,\s*dates\[index\]\.getUTCDay\(\)\)/);
  assert.match(scheduleRenderer, /catch \{[\s\S]*?방영 일정을 불러오지 못했어요\. 다시 시도해 주세요\./);

  let fallbackCalls = 0;
  const providerSchedule = createProviderSchedule({
    fallback: async () => { fallbackCalls += 1; return []; },
    now: () => Date.parse('2026-11-09T03:00:00Z'),
    reanimeBase: 'https://fixture.invalid',
    reanimeFetch: async () => ({ schedule: [{ date: '2026-11-09', episodes: [] }] }),
    reanimeItems: () => []
  });

  await assert.rejects(providerSchedule('integrated', 1), /올바른 소스와 방영 요일/);
  assert.equal(fallbackCalls, 0, 'unknown sources fail validation before a fallback is attempted');
  const official = await providerSchedule('reanime', 1);
  assert.equal(official.provider, 'reanime');
  assert.equal(official.native, true);
  assert.deepEqual(official.items, []);
  assert.equal(fallbackCalls, 0);
  assert.equal(weekDate(1, new Date('2026-11-09T03:00:00Z')), '2026-11-09');
});

test('explicitly selecting an official source is a narrow recovery route without clearing other settings', () => {
  const handler = app.match(/\$\('#contentSource'\)\.onchange=e=>\{([^}]*)\}/)?.[1] || '';
  assert.match(handler, /localStorage\.setItem\('contentSource',e\.target\.value\)/);
  assert.doesNotMatch(handler, /localStorage\.clear\(/);
  assert.doesNotMatch(handler, /removeItem\(/);
});
