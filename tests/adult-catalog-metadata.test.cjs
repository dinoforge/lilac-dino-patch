'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { lookupAdultCatalogMetadata } = require('../electron/adult-catalog-metadata.cjs');

const app = readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
function extractFunction(name, next, context = {}) {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf(`\nfunction ${next}(`, start);
  assert.ok(start >= 0 && end > start, `missing ${name}`);
  return vm.runInNewContext(`(${app.slice(start, end).trim()})`, context);
}

function identityFunction() {
  return extractFunction('adultCatalogIdentity', 'adultCatalogSnapshotUrl', {
    adultCatalogProviderLabels: { reanime: 'RE:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: 'Ohli24', linkkf: 'Linkkf' }
  });
}

const item = (overrides = {}) => ({
  provider: 'reanime', id: 'series-77', mal_id: 'reanime:series-77', title: 'Example Japanese Title',
  title_english: 'Example English Title', synonyms: ['Example Alias'], year: 2021, season: 'FALL 2021',
  type: 'TV', anilistId: 100, malId: 200, genres: [], ...overrides
});

test('AniList adapter queries only page-scoped numeric work IDs and emits explicit Hentai evidence', async () => {
  let received;
  const result = await lookupAdultCatalogMetadata([
    item(), item({ id: 'duplicate', mal_id: 'reanime:duplicate', title: 'Example English Title', anilistId: 101, malId: 201 }),
    item({ id: 'without-id', mal_id: 'reanime:without-id', anilistId: null, malId: null }),
    item({ provider: 'miruro', id: '77', mal_id: 'miruro:77' }),
    item({ id: 'already-tagged', mal_id: 'reanime:already-tagged', genres: [{ name: ' Hentai ' }] })
  ], async (query, variables, options) => {
    received = { query, variables, options };
    return {
      media0: { id: 100, idMal: 200, seasonYear: 2021, startDate: { year: 2020 }, format: 'TV', season: 'FALL',
        title: { romaji: 'Example Japanese Title', english: 'Example English Title', native: '日本語題名' },
        synonyms: ['Example Alias'], genres: ['Hentai'], isAdult: false },
      media1: { id: 101, idMal: 201, seasonYear: 2021, format: 'TV', season: 'FALL',
        title: { romaji: 'Example Japanese Title', english: 'Example English Title' }, synonyms: [], genres: ['Hentai'] }
    };
  });

  assert.equal(result.available, true);
  assert.equal(result.requested, 2);
  assert.equal(received.variables.media0Id, 100);
  assert.equal(received.variables.media1Id, 101);
  assert.match(received.query, /Media\(id: \$media0Id, type: ANIME\)/);
  assert.doesNotMatch(received.query, /isAdult/);
  assert.equal(received.options.maxWait, 8000);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].source, 'AniList GraphQL');
  assert.deepEqual(result.records[0].titles, ['Example Japanese Title', 'Example English Title', '日本語題名', 'Example Alias']);

  const identity = identityFunction();
  const classify = extractFunction('classifyAdultCatalogItem', 'updateAdultCatalogDecision', { adultCatalogIdentity: identity });
  const classified = classify(item(), { verifiedMetadata: result.records });
  assert.equal(classified.status, 'CONFIRMED_HENTAI');
  assert.equal(classified.evidence[0].source, 'AniList GraphQL');
});

test('adult rating, Ecchi, missing genres, unsafe identifiers, and overlarge pages never confirm Hentai', async () => {
  let calls = 0;
  const query = async () => {
    calls++;
    return {
      media0: { id: 100, idMal: 200, seasonYear: 2021, title: { romaji: 'Example Japanese Title' }, genres: ['Ecchi'], isAdult: true },
      media1: { id: 101, idMal: 201, seasonYear: 2021, title: { romaji: 'Another Title' }, genres: [], isAdult: true }
    };
  };
  const nonHentai = await lookupAdultCatalogMetadata([
    item({ anilistId: 100, malId: 200 }),
    item({ id: 'numeric-mal', mal_id: 'reanime:numeric-mal', anilistId: null, malId: 201 }),
    item({ id: 'not-safe', mal_id: 'reanime:not-safe', anilistId: '1 OR 1=1', malId: null })
  ], query);
  assert.equal(nonHentai.available, true);
  assert.deepEqual(nonHentai.records, []);
  assert.equal(calls, 1);

  const unavailable = await lookupAdultCatalogMetadata(Array(37).fill(item()), query);
  assert.deepEqual(unavailable, { available: false, requested: 0, records: [] });
  assert.equal(calls, 1);
});

test('AniList failures remain unavailable and do not become empty confirmed results', async () => {
  const result = await lookupAdultCatalogMetadata([item()], async () => { throw new Error('429'); });
  assert.equal(result.available, false);
  assert.equal(result.records.length, 0);
  assert.equal(result.requested, 1);
});

test('metadata records require exact Hentai genre plus stable identity, year, and title fields', async () => {
  const cases = [
    { genres: ['Ecchi'], isAdult: true },
    { genres: ['Hentai'], title: { romaji: 'Example Japanese Title' }, seasonYear: null },
    { genres: ['Hentai'], title: { romaji: '' }, seasonYear: 2021 },
    { genres: [' HENTAI '], title: { romaji: 'Example Japanese Title' }, seasonYear: 2021 }
  ];
  for (const [index, media] of cases.entries()) {
    const result = await lookupAdultCatalogMetadata([item()], async () => ({ media0: {
      id: 100, idMal: 200, seasonYear: 2021, title: { romaji: 'Example Japanese Title' }, ...media
    } }));
    if (index === 3) {
      assert.equal(result.records.length, 1);
    } else {
      assert.equal(result.records.length, 0);
    }
  }
});
