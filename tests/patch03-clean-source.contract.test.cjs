'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const sourceRoot = process.env.PATCH03_SOURCE_ROOT ? path.resolve(process.env.PATCH03_SOURCE_ROOT) : '';
const cleanSourceOnly = sourceRoot ? undefined : 'run through validate-patch03-clean-source.cjs with PATCH03_SOURCE_ROOT';
const read = relative => fs.readFileSync(path.join(sourceRoot, relative), 'utf8');

class FakeClassList {
  constructor(values = []) { this.values = new Set(values); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const next = force === undefined ? !this.values.has(value) : Boolean(force);
    if (next) this.values.add(value); else this.values.delete(value);
    return next;
  }
}

class FakeElement {
  constructor(tagName = 'div', register = () => {}) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.className = '';
    this.value = '';
    this.textContent = '';
    this.open = false;
    this.isConnected = true;
    this._id = '';
    this._register = register;
  }
  set id(value) { this._id = String(value); this._register(this); }
  get id() { return this._id; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  insertAdjacentElement(_where, node) { this.append(node); return node; }
  before(node) {
    if (!this.parentElement) return;
    node.parentElement = this.parentElement;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 0, node);
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this);
    this.isConnected = false;
  }
  click() { this.listeners.get('click')?.({ target: this, currentTarget: this }); }
  matches(selector) {
    if (selector === 'button') return this.tagName === 'BUTTON';
    if (selector === 'option[value="integrated"]') return this.tagName === 'OPTION' && this.value === 'integrated';
    if (selector === 'button[data-value="integrated"]') return this.tagName === 'BUTTON' && this.dataset.value === 'integrated';
    if (selector === '[data-provider-source][aria-pressed="true"]') return this.dataset.providerSource != null && this.attributes.get('aria-pressed') === 'true';
    if (selector === '[data-provider-source]') return this.dataset.providerSource != null;
    if (selector === '.detail-source-picker') return this.className.split(/\s+/).includes('detail-source-picker');
    if (selector === '.detail-actions') return this.className.split(/\s+/).includes('detail-actions');
    if (selector === '.detail-meta') return this.className.split(/\s+/).includes('detail-meta');
    return false;
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = parent => {
      for (const child of parent.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function makeBridgeContext(api, options = {}) {
  const byId = new Map();
  const register = element => { if (element.id) byId.set(element.id, element); };
  const element = (id, tag = 'div') => { const item = new FakeElement(tag, register); item.id = id; return item; };
  const sourceSelect = element('contentSource', 'select');
  const sourceChoices = element('sourceChoices');
  const searchStatus = element('searchStatus');
  const searchGrid = element('searchGrid');
  const detailContent = element('detailContent');
  const detailMeta = new FakeElement('div', register); detailMeta.className = 'detail-meta';
  const detailActions = new FakeElement('div', register); detailActions.className = 'detail-actions';
  detailContent.append(detailMeta, detailActions);
  const detailDialog = element('detailDialog'); detailDialog.open = true;
  const searchView = element('searchView'); searchView.classList.add('active');
  const pageSearch = element('pageSearch', 'input');
  const globalSearch = element('globalSearch', 'input');
  const elements = new Map([
    ['#contentSource', sourceSelect], ['#sourceChoices', sourceChoices], ['#searchStatus', searchStatus],
    ['#searchGrid', searchGrid], ['#detailContent', detailContent], ['#detailDialog', detailDialog],
    ['#searchView', searchView], ['#pageSearch', pageSearch], ['#globalSearch', globalSearch]
  ]);
  const calls = { catalog: [], originalSearch: [], details: [], cards: [], timers: [] };
  const storage = new Map([['contentSource', 'integrated'], ['contentSourceProvider', 'reanime']]);
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); }
  };
  let filterRoot = null;
  const document = {
    querySelector(selector) {
      if (elements.has(selector)) return elements.get(selector);
      if (selector === '#searchProviderFilters') return filterRoot;
      if (selector === '#filterMore' || selector === '#filterBar' || selector === '#filterPanel') return null;
      if (selector === '#detailContent .detail-actions') return detailContent.querySelector('.detail-actions');
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '#detailDialog') return byId.has('detailDialog') ? [byId.get('detailDialog')] : [];
      return [];
    },
    createElement(tag) { return new FakeElement(tag, el => { if (el.id === 'searchProviderFilters') filterRoot = el; }); }
  };
  const anime = provider => ({
    provider,
    id: `${provider}-frieren-s2`,
    mal_id: `${provider}:${provider}-frieren-s2`,
    anilistId: 182255,
    malId: 59978,
    title: 'Frieren Season 2',
    title_english: 'Frieren: Beyond Journey’s End Season 2',
    title_japanese: '葬送のフリーレン 第2期',
    year: 2026,
    type: 'TV',
    availableEpisodeCount: 24
  });
  const results = {
    reanime: [anime('reanime')],
    miruro: [anime('miruro')],
    animenosub: [], ohli24: [], linkani: []
  };
  const window = {
    LilacIntegratedSearch: api,
    lilac: {
      providerCatalog: async (provider, query) => { calls.catalog.push({ provider, query }); return results[provider] || []; },
      providerDetail: async item => ({ data: item, episodes: [] }),
      providerResolve: async episode => episode
    },
    doSearch: async query => { calls.originalSearch.push(query); return 'official-search'; },
    openDetail: async id => {
      calls.details.push(id);
      detailDialog.open = true;
      return options.openDetail ? options.openDetail(id) : id;
    },
    syncSettingChoices() {},
    renderCards(_selector, groups) { calls.cards.push(groups); },
    rememberAnime() {},
    titleOf: item => item.title,
    cancelPendingPlaybackLookups() {},
    saveRecentSearch() {},
    switchView(view) { searchView.classList.toggle('active', view === 'search'); },
    showHomeList(list) { this.switchView('search'); this.renderCards('#searchGrid', list); },
    toast() {},
    location: { reload() { calls.reloaded = (calls.reloaded || 0) + 1; } }
  };
  const context = vm.createContext({
    window,
    document,
    localStorage,
    setTimeout(callback, delay) { calls.timers.push({ callback, delay }); return calls.timers.length; }
  });
  vm.runInContext('this.window=window;', context);
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, 'src', 'patch03-bridge.js'), 'utf8'), context, { filename: 'src/patch03-bridge.js' });
  return { context, window, document, calls, storage, elements, sourceSelect, detailContent, detailDialog, searchView };
}

test('clean-source contract suite requires an explicit official source root', { skip: cleanSourceOnly }, () => {
  assert.equal(fs.existsSync(path.join(sourceRoot, 'package.json')), true);
});
test('pinned official IPC signatures stay the boundary for catalog, detail, and resolve', { skip: cleanSourceOnly }, () => {
  const preload = read('electron/preload.cjs');
  const main = read('electron/main.cjs');
  const bridge = read('src/patch03-bridge.js');
  for (const [name, channel] of [['providerCatalog', 'provider:catalog'], ['providerDetail', 'provider:detail'], ['providerResolve', 'provider:resolve']]) {
    assert.match(preload, new RegExp(`${name}:[\\s\\S]{0,180}?ipcRenderer\\.invoke\\('${channel}'`));
    assert.ok(main.includes(`ipcMain.handle('${channel}'`), `${channel} remains in official main`);
    assert.ok(bridge.includes(name), `${name} remains in the Patch 03 bridge`);
  }
  assert.match(read('src/app.js'), /window\.lilac\.providerResolve\(ep\)/);
});

test('the patch preserves the official detail dialog and exposes one integrated setting', { skip: cleanSourceOnly }, () => {
  const html = read('src/index.html');
  const app = read('src/app.js');
  assert.equal((html.match(/id="detailDialog"/g) || []).length, 1);
  assert.equal((html.match(/option value="integrated"/g) || []).length, 1);
  assert.equal((html.match(/button data-value="integrated"/g) || []).length, 1);
  assert.match(html, /integrated-search\.js[\s\S]*app\.js[\s\S]*patch03-bridge\.js/);
  assert.match(app, /LilacIntegratedSearch\?\.initializeSourceSettings\(localStorage\)/);
  assert.match(app, /LilacIntegratedSearch\?\.officialSourceForState\?\.\(dinoSourceSettings, savedContentSource\)/);
  const bridge = read('src/patch03-bridge.js');
  assert.match(bridge, /saveSourceSelection\(localStorage, selected\)/);
  assert.doesNotMatch(bridge, /localStorage\.setItem\('contentSource', 'integrated'\)/);
});

test('the same official identity is grouped while different seasons remain separate', { skip: cleanSourceOnly }, () => {
  const { PROVIDERS, groupResults } = require(path.join(sourceRoot, 'src', 'integrated-search.js'));
  assert.deepEqual(PROVIDERS, ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani']);
  assert.equal(PROVIDERS.includes('linkkf'), false);
  const grouped = groupResults([
    { provider: 'reanime', id: 'r-s2', mal_id: 'reanime:r-s2', anilistId: 182255, malId: 59978, title: 'Frieren S2', year: 2026, type: 'TV' },
    { provider: 'miruro', id: 'm-s2', mal_id: 'miruro:m-s2', anilistId: 182255, malId: 59978, title: 'Frieren Season 2', year: 2026, type: 'TV' },
    { provider: 'reanime', id: 'r-s1', mal_id: 'reanime:r-s1', anilistId: 154587, malId: 52991, title: 'Frieren', year: 2023, type: 'TV' }
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped.find(item => item.sourceItems.length === 2).sourceItems.length, 2);
});

test('bridge performs integrated search through the five official catalog calls and keeps individual mode delegated', { skip: cleanSourceOnly }, async () => {
  const app = makeBridgeContext(require(path.join(sourceRoot, 'src', 'integrated-search.js')));
  await app.window.doSearch('Frieren Season 2');
  assert.equal(app.storage.get('contentSource'), 'reanime', 'legacy integrated mode is restored to its original provider');
  assert.equal(app.storage.get('lilacDinoPatch.searchMode'), 'integrated');
  assert.deepEqual([...new Set(app.calls.catalog.map(call => call.provider))].sort(), ['animenosub', 'linkani', 'miruro', 'ohli24', 'reanime']);
  assert.equal(app.calls.catalog.some(call => call.provider === 'linkkf'), false);
  const snapshot = app.window.__dinoPatch03Bridge.getSearchSnapshot();
  assert.equal(snapshot.length, 1);
  assert.deepEqual(snapshot[0].sourceItems.map(item => item.provider).sort(), ['miruro', 'reanime']);
  app.sourceSelect.onchange({ target: { value: 'ohli24' } });
  assert.equal(app.storage.get('contentSource'), 'ohli24');
  assert.equal(app.storage.get('contentSourceProvider'), 'ohli24');
  const callsBeforeIndividualSearch = app.calls.catalog.length;
  await app.window.doSearch('individual query');
  assert.deepEqual(app.calls.originalSearch, ['individual query']);
  assert.equal(app.calls.catalog.length, callsBeforeIndividualSearch);
  app.sourceSelect.onchange({ target: { value: 'integrated' } });
  assert.equal(app.storage.get('contentSource'), 'ohli24', 'integrated mode must not overwrite the official provider setting');
  assert.equal(app.storage.get('lilacDinoPatch.searchMode'), 'integrated');
  assert.equal(app.storage.get('contentSourceProvider'), 'ohli24');
  assert.equal(app.calls.timers.at(-1).delay, 600);
});

test('group source selection calls the original detail entry point and renders one picker in the same dialog', { skip: cleanSourceOnly }, async () => {
  const app = makeBridgeContext(require(path.join(sourceRoot, 'src', 'integrated-search.js')));
  await app.window.doSearch('Frieren Season 2');
  await app.window.openDetail('reanime:reanime-frieren-s2');
  assert.equal(app.calls.details.length, 1);
  assert.equal(app.document.querySelectorAll('#detailDialog').length, 1);
  const pickers = app.detailContent.querySelectorAll('.detail-source-picker');
  assert.equal(pickers.length, 1);
  const choices = pickers[0].querySelectorAll('[data-provider-source]');
  assert.equal(choices.length, 2);
  assert.ok(choices.every(button => !/\d+화/.test(button.textContent)), 'catalog episode estimates must not be shown as loaded episode counts');
  choices.find(button => button.dataset.providerSource === 'miruro:miruro-frieren-s2').click();
  await Promise.resolve();
  assert.equal(app.calls.details.at(-1), 'miruro:miruro-frieren-s2');
  assert.equal(app.detailContent.querySelectorAll('.detail-source-picker').length, 1);
  assert.equal(app.detailDialog.open, true);
});

test('a provider filter selects that provider as the initial detail source', { skip: cleanSourceOnly }, async () => {
  const app = makeBridgeContext(require(path.join(sourceRoot, 'src', 'integrated-search.js')));
  await app.window.doSearch('Frieren Season 2');
  app.document.querySelector('#searchProviderFilters').querySelectorAll('button')
    .find(button => button.dataset.provider === 'miruro').click();

  await app.window.openDetail('reanime:reanime-frieren-s2');

  assert.equal(app.calls.details.at(-1), 'miruro:miruro-frieren-s2');
  assert.equal(app.detailContent.querySelector('[data-provider-source][aria-pressed="true"]')?.dataset.providerSource,
    'miruro:miruro-frieren-s2');
});

test('provider failures remain distinct from empty results and do not suppress healthy providers', { skip: cleanSourceOnly }, async () => {
  const api = require(path.join(sourceRoot, 'src', 'integrated-search.js'));
  const app = makeBridgeContext(api);
  const reanime = {
    provider: 'reanime', id: 'known-title', mal_id: 'reanime:known-title', anilistId: 999001,
    title: 'Independent result', year: 2025, type: 'TV'
  };
  app.window.lilac.providerCatalog = async (provider, query) => {
    app.calls.catalog.push({ provider, query });
    if (provider === 'miruro') throw new Error('test-only provider failure');
    if (provider === 'reanime') return [reanime];
    return [];
  };
  await app.window.doSearch('Independent result');
  assert.ok(app.window.__dinoPatch03Bridge.getSearchSnapshot().some(group => group.title === 'Independent result'));
  const statuses = app.document.querySelector('#searchProviderFilters').querySelectorAll('button');
  assert.ok(statuses.some(button => button.dataset.provider === 'miruro' && button.dataset.state === 'failed'));
  assert.ok(statuses.some(button => button.dataset.provider === 'animenosub' && button.dataset.state === 'ready'));
  assert.match(app.document.querySelector('#searchStatus').textContent, /응답 오류: Miruro/);
});

test('title variants query ready-empty and skipped providers, avoid failed providers, and remain capped at three terms', { skip: cleanSourceOnly }, async () => {
  const api = require(path.join(sourceRoot, 'src', 'integrated-search.js'));
  const app = makeBridgeContext(api);
  const calls = [];
  const anchor = { provider: 'reanime', id: 'anchor', mal_id: 'reanime:anchor', anilistId: 888001,
    title: 'Frieren', year: 2025, type: 'TV' };
  app.window.lilac.providerCatalog = async (provider, query) => {
    calls.push({ provider, query });
    if (provider === 'ohli24') throw new Error('test-only failed provider');
    if (provider === 'reanime') return [anchor];
    return [];
  };
  app.window.lilac.titleVariants = async () => ['Frieren EN', '葬送のフリーレン', 'Frieren Japanese', 'extra term ignored'];
  await app.window.doSearch('Frieren Season 2');
  const variantCalls = calls.filter(call => call.query !== 'Frieren Season 2');
  assert.ok(variantCalls.length > 0);
  assert.ok(variantCalls.every(call => ['miruro', 'animenosub', 'linkani'].includes(call.provider)));
  assert.ok(!variantCalls.some(call => call.query === 'extra term ignored'));
  assert.ok(calls.some(call => call.provider === 'reanime' && call.query === 'Frieren Season 2'));
  assert.ok(calls.some(call => call.provider === 'ohli24' && call.query === 'Frieren Season 2'));
  assert.ok(!variantCalls.some(call => call.provider === 'ohli24'));
});

test('Korean integrated searches retry providers skipped for the original query with safe title variants', { skip: cleanSourceOnly }, async () => {
  const api = require(path.join(sourceRoot, 'src', 'integrated-search.js'));
  const app = makeBridgeContext(api);
  const anchor = { provider: 'reanime', id: 'ko-anchor', mal_id: 'reanime:ko-anchor', anilistId: 1888001,
    title: '한국어 작품', year: 2025, type: 'TV' };
  const variants = ['miruro', 'animenosub'].map(provider => ({ ...anchor, provider, id: `${provider}-anchor`, mal_id: `${provider}:${provider}-anchor` }));
  const calls = [];
  app.window.lilac.providerCatalog = async (provider, query) => {
    calls.push({ provider, query });
    if (query === '한국어 작품') return provider === 'reanime' ? [anchor] : [];
    if (query === 'Korean Work') return variants.filter(item => item.provider === provider);
    return [];
  };
  app.window.lilac.titleVariants = async () => ['Korean Work'];

  await app.window.doSearch('한국어 작품');

  assert.equal(calls.some(call => ['miruro', 'animenosub'].includes(call.provider) && /[가-힣]/.test(call.query)), false,
    'providers that skip Korean catalog queries remain skipped for the original query');
  assert.deepEqual(calls.filter(call => call.query === 'Korean Work').map(call => call.provider).sort(), ['animenosub', 'linkani', 'miruro', 'ohli24']);
  const grouped = app.window.__dinoPatch03Bridge.getSearchSnapshot();
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].sourceItems.map(item => item.provider).sort(), ['animenosub', 'miruro', 'reanime']);
});

test('a delayed old detail cannot replace the most recently selected source picker', { skip: cleanSourceOnly }, async () => {
  const api = require(path.join(sourceRoot, 'src', 'integrated-search.js'));
  const pending = new Map();
  const app = makeBridgeContext(api, { openDetail: id => new Promise(resolve => pending.set(id, resolve)) });
  await app.window.doSearch('Frieren Season 2');
  const oldDetail = app.window.openDetail('reanime:reanime-frieren-s2');
  const newestDetail = app.window.openDetail('miruro:miruro-frieren-s2');
  pending.get('miruro:miruro-frieren-s2')('newest detail');
  await newestDetail;
  assert.equal(app.detailContent.querySelectorAll('.detail-source-picker').length, 1);
  assert.equal(app.detailContent.querySelector('[data-provider-source][aria-pressed="true"]')?.dataset.providerSource, 'miruro:miruro-frieren-s2');
  pending.get('reanime:reanime-frieren-s2')('late detail');
  await oldDetail;
  assert.equal(app.detailContent.querySelectorAll('.detail-source-picker').length, 1);
  assert.equal(app.detailContent.querySelector('[data-provider-source][aria-pressed="true"]')?.dataset.providerSource, 'miruro:miruro-frieren-s2');
});

test('Linkkf stays on the official individual search path and is not aggregated', { skip: cleanSourceOnly }, async () => {
  const app = makeBridgeContext(require(path.join(sourceRoot, 'src', 'integrated-search.js')));
  app.sourceSelect.onchange({ target: { value: 'linkkf' } });
  assert.equal(app.storage.get('contentSource'), 'linkkf');
  assert.equal(app.storage.get('contentSourceProvider'), 'linkkf');
  await app.window.doSearch('Linkkf query');
  assert.deepEqual(app.calls.originalSearch, ['Linkkf query']);
  assert.equal(app.calls.catalog.length, 0);
  assert.equal(app.window.__dinoPatch03Bridge.providers.includes('linkkf'), false);
});

test('late integrated results cannot overwrite an original home list', { skip: cleanSourceOnly }, async () => {
  const api = require(path.join(sourceRoot, 'src', 'integrated-search.js'));
  const app = makeBridgeContext(api);
  const pending = [];
  app.window.lilac.providerCatalog = (provider, query) => new Promise(resolve => pending.push({ provider, query, resolve }));

  const searching = app.window.doSearch('slow integrated query');
  for (let attempt = 0; attempt < 10 && pending.length < api.PROVIDERS.length; attempt++) await Promise.resolve();
  assert.equal(pending.length, api.PROVIDERS.length);

  const homeItems = [{ provider: 'reanime', mal_id: 'home:1', title: 'Home item' }];
  app.window.showHomeList(homeItems, 'All titles');
  for (const request of pending) request.resolve([]);
  await searching;

  assert.deepEqual(app.calls.cards.at(-1), homeItems);
});
