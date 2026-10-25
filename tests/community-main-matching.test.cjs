const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cheerio = require('cheerio');
const { communityEpisodes, communityFileEpisode, communityLinkEpisodes, planCommunityLinks, pickCommunityFile, selectCommunityFile, COMMUNITY_FONT } = require('../electron/community-matching.cjs');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

function communityLinkPicker() {
  const start = mainSource.indexOf('const COMMUNITY_TRAILING_EPISODE=');
  const end = mainSource.indexOf('// "S02E05" counts as episode 5 only', start);
  assert.ok(start >= 0 && end > start, 'Missing community post/link helpers');
  const context = vm.createContext({
    cheerio,
    communityEpisodes,
    communityLinkEpisodes,
    communityLinkEpisodes,
    planCommunityLinks,
    pickCommunityFile,
    absoluteUrl: (href, base) => new URL(href, base).href
  });
  vm.runInContext(`${mainSource.slice(start, end)}\nthis.pickCommunityLinks = communityLinks;`, context);
  return context.pickCommunityLinks;
}

function communityDownloader(userData) {
  const start = mainSource.indexOf('async function downloadCommunityMatch(');
  const end = mainSource.indexOf('// Some makers pack their subtitles into the post', start);
  assert.ok(start >= 0 && end > start, 'Missing community downloader');
  const context = vm.createContext({
    app: { getPath: () => userData }, fs, path, Buffer, URL,
    simpleTitle: value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    driveId: () => null,
    driveFolderId: () => null,
    driveFolderFiles: async () => [],
    downloadDriveBuffer: async url => Buffer.from(url),
    extractCommunityArchive: async () => null,
    communitySubtitleExt: () => '.ass',
    communityFileName: value => path.basename(String(value).replace(/\\/g, '/')).replace(/[^\p{L}\p{N}._ -]/gu, '_'),
    communityFileEpisode, pickCommunityFile, selectCommunityFile, COMMUNITY_FONT,
    subtitleNotFoundError: message => Object.assign(new Error(message), { code: 'SUBTITLE_NOT_FOUND' }),
    subtitleResult: file => ({ path: file, exists: fs.existsSync(file) })
  });
  vm.runInContext(`${mainSource.slice(start, end)}\nthis.downloadCommunityMatch = downloadCommunityMatch;`, context);
  return context.downloadCommunityMatch;
}

function communityFinder({ communityPosts, rankCommunityPosts, downloadCommunityMatch }) {
  const start = mainSource.indexOf('async function findCommunitySubtitle(');
  const end = mainSource.indexOf('// Downloads a ranked post', start);
  assert.ok(start >= 0 && end > start, 'Missing community subtitle lookup');
  const context = vm.createContext({ communityPosts, rankCommunityPosts, downloadCommunityMatch });
  vm.runInContext(`${mainSource.slice(start, end)}\nthis.findCommunitySubtitle = findCommunitySubtitle;`, context);
  return context.findCommunitySubtitle;
}

test('community links distinguish bundles and use only verified season offsets', () => {
  const pick = communityLinkPicker();
  const base = 'https://blog.example/post';
  const range = pick({
    title: 'My Series', url: base,
    html: '<a href="https://drive.google.com/file/d/range">1 ~ 12화 자막</a>'
  }, 7);
  assert.equal(range.episode, 7);
  assert.equal(range.strict, true);
  assert.equal(range.bundle, true);
  assert.equal(range.linkInfo[0].tier, 0);
  assert.equal(range.links.length, 1);

  const shifted = pick({
    title: 'My Series', url: base,
    html: '<a href="https://drive.google.com/file/d/season">13화</a>'
  }, 1, { offsets: [12], allowOffset: true });
  assert.equal(shifted.episode, 13);
  assert.equal(shifted.bundle, false);
  assert.equal(shifted.linkInfo[0].href.endsWith('/season'), true);
  assert.equal(shifted.links.length, 1);
  const unverified = pick({ title: 'My Series', url: base, html: '<a href="https://drive.google.com/file/d/season">13화</a>' }, 1);
  assert.equal(unverified.links.length, 0);
  assert.equal(unverified.linkInfo, undefined);
});

test('community downloads preserve episode filenames and isolate concurrent extraction folders', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-community-main-'));
  try {
    const download = communityDownloader(userData);
    const makeMatch = (url, title = 'Show') => ({
      links: [url], episode: 2, strict: true, bundle: false, season: 2,
      post: { url: 'https://blog.example/post', title }
    });
    const first = await download(makeMatch('https://files.example/Show.S02E02.ass'), 'kairan', 'Show', 2);
    assert.equal(first.exists, true);
    assert.match(path.basename(first.path), /0_Show\.S02E02\.ass$/i);

    await assert.rejects(download({
      ...makeMatch('https://files.example/Show.S02E03.ass'),
      links: ['https://files.example/Show.S02E03.ass', 'https://files.example/main.ass'], strict: false
    }, 'kairan', 'Show', 2), error => error.code === 'SUBTITLE_NOT_FOUND');

    const pair = await Promise.all([
      download(makeMatch('https://files.example/Show.S02E02-A.ass'), 'kairan', 'Show', 2),
      download(makeMatch('https://files.example/Show.S02E02-B.ass'), 'csora', 'Show', 2)
    ]);
    assert.ok(pair.every(result => result.exists));
    assert.notEqual(pair[0].path, pair[1].path);
    const episodeDir = path.dirname(first.path);
    const children = fs.readdirSync(episodeDir);
    assert.equal(children.length, 3);
    assert.ok(children.every(name => name.endsWith('.ass')));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('community lookup tries five ranked posts and refreshes once after broken attachments', async () => {
  const posts = Array.from({ length: 6 }, (_, index) => ({
    post: { url: `https://blog.example/${index}`, title: `Show ${index + 1}화` },
    links: [`https://files.example/${index}.ass`], episode: index + 1
  }));
  const feedCalls = [], downloadCalls = [];
  const find = communityFinder({
    communityPosts: async (_blog, { force }) => { feedCalls.push(force); return posts; },
    rankCommunityPosts: entries => entries,
    downloadCommunityMatch: async match => {
      downloadCalls.push(match.post.url);
      if (match.post.url.endsWith('/5')) return { path: 'sixth subtitle' };
      throw new Error('attempt limit exceeded');
    }
  });
  assert.deepEqual(await find('kairan', 'Show', 1), { path: 'sixth subtitle' });
  assert.deepEqual(feedCalls, [false, true]);
  assert.deepEqual(downloadCalls, posts.map(post => post.post.url));
});
