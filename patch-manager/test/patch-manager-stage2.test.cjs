'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { currentQuarter, readQuarterSelection, saveQuarterSelection } = require('../../src/patch-manager-stage2-core.js');
const { loadQuarter, registerPatch0102Handlers } = require('../../electron/patch-manager-stage2.cjs');

test('local quarter selection updates only when the calendar quarter changes', () => {
  const boundaries = [
    [new Date(2026, 2, 31), new Date(2026, 3, 1), 2],
    [new Date(2026, 5, 30), new Date(2026, 6, 1), 3],
    [new Date(2026, 8, 30), new Date(2026, 9, 1), 4],
    [new Date(2026, 11, 31), new Date(2027, 0, 1), 1]
  ];
  for (const [before, after, quarter] of boundaries) {
    const current = currentQuarter(before);
    assert.equal(currentQuarter(after).quarter, quarter);
    const past = saveQuarterSelection(current.year - 1, 4, before);
    assert.equal(readQuarterSelection(past, before).year, current.year - 1);
    assert.deepEqual(readQuarterSelection(past, after), { ...currentQuarter(after), calendarYear: after.getFullYear(), calendarQuarter: quarter });
  }
  const legacyCurrent = { year: 2026, quarter: 4 };
  assert.deepEqual(readQuarterSelection(legacyCurrent, new Date(2026, 10, 1)), {
    year: 2026, quarter: 4, calendarYear: 2026, calendarQuarter: 4
  });
  assert.equal(readQuarterSelection({ year: 2026, quarter: 3 }, new Date(2026, 10, 1)).quarter, 4);
});

test('quarter catalog fetchers use only supported providers and exclude unconfirmed titles', async () => {
  const calls = [];
  const reanime = await loadQuarter('reanime', 2026, 4, {
    REANIME_WEB: 'https://reanime.example',
    ANIMENOSUB_WEB: 'https://animenosub.example',
    providerFetch: async (url, options) => { calls.push({ url, options }); return { rows: [{ provider: 'reanime', id: 'subbed', subbed: 1 }, { provider: 'reanime', id: 'none', subbed: 0, dubbed: 0 }] }; },
    reanimeItems: result => result.rows
  });
  assert.equal(new URL(calls[0].url).searchParams.get('season'), 'FALL');
  assert.equal(new URL(calls[0].url).searchParams.get('year'), '2026');
  assert.deepEqual(reanime.data.map(item => item.id), ['subbed']);

  const miruro = await loadQuarter('miruro', 2026, 4, {
    miruroApi: async (_path, query) => {
      calls.push({ query });
      return { data: [
        { id: 1, status: 'RELEASING', episode_counts: { sub: 12 } },
        { id: 2, status: 'RELEASING', episode_counts: {} },
        { id: 3, status: 'NOT_YET_RELEASED', episode_counts: { sub: 12 } }
      ], has_more: false };
    },
    miruroHasEpisodes: async item => item.id === 1,
    miruroItem: item => ({ provider: 'miruro', id: String(item.id) })
  });
  assert.equal(calls[1].query.season, 'FALL');
  assert.equal(calls[1].query.season_year, 2026);
  assert.deepEqual(miruro.data.map(item => item.id), ['1']);

  const cheerio = {
    load(source) {
      const nodes = source.includes('page=2') ? [] : [
        { status: 'Ongoing', html: '<current>Current</current>' },
        { status: 'Upcoming', html: '<upcoming>Upcoming</upcoming>' }
      ];
      const collection = values => ({
        length: values.length,
        filter(callback) { return collection(values.filter((node, index) => callback(index, node))); },
        map(callback) { return { get: () => values.map((node, index) => callback(index, node)) }; }
      });
      const $ = value => typeof value === 'string'
        ? collection(value === 'article.bs' ? nodes : [])
        : { find: () => ({ text: () => value.status }) };
      $.html = node => node.html;
      return $;
    }
  };
  const animenosubCalls = [];
  const animenosub = await loadQuarter('animenosub', 2026, 4, {
    ANIMENOSUB_WEB: 'https://animenosub.example',
    providerFetch: async url => { animenosubCalls.push(url); return url; },
    cheerio,
    animenosubList: html => html.includes('<current>') ? [{ provider: 'animenosub', id: 'current' }] : []
  });
  assert.equal(new URL(animenosubCalls[0]).searchParams.get('season[0]'), 'fall-2026');
  assert.deepEqual(animenosub.data.map(item => item.id), ['current']);
  assert.equal(animenosubCalls.length, 2, 'pagination stops when a page has no cards');
  await assert.rejects(loadQuarter('linkani', 2026, 4, {}), /제공하지 않습니다/);
});

test('manual translation save is limited to the supplied temporary profile and registers ChatGPT source', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-patch-manual-save-'));
  const handlers = new Map();
  let saved;
  try {
    registerPatch0102Handlers({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      app: { getPath: name => { assert.equal(name, 'userData'); return userData; } },
      subtitleStore: { save: (key, value) => { saved = { key, ...value }; return { path: value.path, url: `file://${value.path}` }; } },
      clipboard: { writeText: () => {} },
      providerFetch: async () => ({}), REANIME_WEB: '', ANIMENOSUB_WEB: '', reanimeItems: () => [],
      miruroApi: async () => ({}), miruroItem: () => ({}), miruroHasEpisodes: async () => false,
      animenosubList: () => [], cheerio: { load: () => () => ({}) }
    });
    const text = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n안녕하세요\n';
    const result = handlers.get('patch:manual-subtitle-save')({}, { key: 'show|season-1|episode-2', text, from: 'source.vtt', fromName: 'English' });
    assert.equal(saved.source, 'chatgpt');
    assert.equal(saved.key, 'show|season-1|episode-2');
    assert.ok(saved.path.startsWith(path.join(userData, 'subtitles', 'translated')));
    assert.equal(fs.readFileSync(saved.path, 'utf8'), text);
    assert.equal(result.path, saved.path);
    assert.throws(() => handlers.get('patch:manual-subtitle-save')({}, { key: 'show|1|2', text: 'not VTT' }), /WebVTT/);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
