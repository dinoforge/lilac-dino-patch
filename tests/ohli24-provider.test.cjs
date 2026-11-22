const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cheerio = require('cheerio');

const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const start = source.indexOf('const OHLI24_WEB=');
const end = source.indexOf('\n// LinkAni uses the same source-site pages', start);
assert.ok(start >= 0 && end > start, 'Ani24 provider implementation is present');

function createContext(respond) {
  const requests = [];
  const context = vm.createContext({
    cheerio,
    LINKKF_UA: 'test-agent',
    net: { fetch: async (url, options) => { requests.push({ url: String(url), options }); return respond(String(url)); } },
    URL,
    URLSearchParams,
    AbortSignal,
    absoluteUrl: (value, base) => { try { return new URL(value, base).href; } catch { return ''; } },
    imageOfMain: () => '',
    spaceKey: value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ''),
    titleCompareKey: value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''),
    hasHangul: value => /[\uac00-\ud7af]/.test(String(value || ''))
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, requests };
}

function appPage(props) {
  return `<script data-page="app" type="application/json">${JSON.stringify({ props })}</script>`;
}

test('Ani24 catalog search uses the current airing, finished and movie boards', async () => {
  const h = createContext(url => {
    const parsed = new URL(url), pathname = decodeURIComponent(parsed.pathname);
    if (pathname === '/방영중') return { ok: true, status: 200, text: async () => appPage({ items: [
      { slug: 'airing-series', title: '검색 대상 작품 · 현재 방영작', original_title: '현재 원제', eps: '4화', thumbnail: 'airing.jpg', published_at: '2026-10-01' }
    ] }) };
    if (pathname === '/완결' || pathname === '/극장판') return { ok: true, status: 200, text: async () => appPage({ comics: { data: [
      { slug: pathname === '/완결' ? 'finished-series' : 'movie-work', title: '검색 대상 작품', category: pathname === '/극장판' ? '극장판' : 'TV', episodes_count: 12 }
    ] } }) };
    throw new Error(`Unexpected Ani24 request: ${url}`);
  });

  const results = await h.context.ohliSearch('검색 대상 작품');
  assert.deepEqual([...results].map(item => item.id), ['airing-series', 'finished-series', 'movie-work']);
  assert.deepEqual(new Set(h.requests.map(request => decodeURIComponent(new URL(request.url).pathname))), new Set(['/방영중', '/완결', '/극장판']));
  assert.equal(results[1].url, 'https://ani.ohli24.com/c/finished-series');
  assert.equal(results[2].type, 'Movie');
});

test('Ani24 current detail loads its native episode pages and retains special labels', async () => {
  const h = createContext(url => {
    const parsed = new URL(url), pathname = decodeURIComponent(parsed.pathname);
    if (pathname === '/c/test-series' && !parsed.search) return { ok: true, status: 200, text: async () => appPage({
      comic: { slug: 'test-series', title: '검증 대상 작품', original_title: '검증 대상 원제', thumbnail: 'poster.jpg', category: 'TV',
        metadata: { info_rows: [['방영일', '2026년 10월'], ['총화수', '12화'], ['장르', '액션, 모험']] } },
      episodes: { data: [{ title: '1화', slug: 'episode-1', sort: 1, published_at: '2026-10-02T00:00:00+09:00' }], last_page: 2 }
    }) };
    if (pathname === '/c/test-series' && parsed.searchParams.get('page') === '2') return { ok: true, status: 200, text: async () => appPage({
      comic: { slug: 'test-series' }, episodes: { data: [{ title: 'OVA 1화', slug: 'ova-one', sort: 2 }], last_page: 2 }
    }) };
    throw new Error(`Unexpected Ani24 request: ${url}`);
  });

  const detail = await h.context.ohliDetail({ provider: 'ohli24', id: 'test-series', title: '검증 대상 작품', year: '2026', type: 'TV', url: 'https://ani.ohli24.com/c/test-series' });
  assert.equal(detail.data.title, '검증 대상 작품');
  assert.equal(detail.data.year, '2026');
  assert.equal(detail.unavailable, false);
  assert.deepEqual([...detail.episodes].map(episode => episode.number), [1, null]);
  assert.deepEqual([...detail.episodes].map(episode => episode.url), ['https://ani.ohli24.com/e/episode-1', 'https://ani.ohli24.com/e/ova-one']);
  assert.ok(h.requests.some(request => new URL(request.url).searchParams.get('page') === '2'));
});

test('saved legacy Ani24 details still parse through the old URL path', async () => {
  const html = '<!doctype html><meta property="og:title" content="Legacy Ani24 title"><ul class="article-box-meta"><li><span>원제</span><span>기존 합성작</span></li><li><span>총화수</span><span>2화</span></li></ul><div class="eps-item"><a href="/81002/episode-1.html">1화</a><a href="/81002/episode-2.html">2화</a></div>';
  const h = createContext(url => ({ ok: true, status: 200, text: async () => html }));
  const detail = await h.context.ohliDetail({ provider: 'ohli24', id: '81002', title: 'Legacy Ani24 title', url: 'https://www.ohli24.net/81002/series.html' });
  assert.equal(detail.episodes.length, 2);
  assert.equal(detail.episodes[0].url, 'https://www.ohli24.net/81002/episode-1.html');
});
