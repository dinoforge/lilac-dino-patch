const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { SubtitleStore } = require('../electron/subtitle-store.cjs');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const converterStart = mainSource.indexOf('// Korean SRT/SMI files are often CP949 or UTF-16 rather than UTF-8.');
const converterEnd = mainSource.indexOf('// Korean titles for Re:ANIME entries', converterStart);
assert.ok(converterStart >= 0 && converterEnd > converterStart, 'Subtitle decoding and format converters exist');
const subtitleResultStart = mainSource.indexOf('function subtitleResult(');
const subtitleResultEnd = mainSource.indexOf('\n// Downloads a remote VTT/SRT/ASS subtitle', subtitleResultStart);
assert.ok(subtitleResultStart >= 0 && subtitleResultEnd > subtitleResultStart, 'Subtitle result dispatch exists');

const converters = vm.createContext({ fs, path, pathToFileURL: require('node:url').pathToFileURL, TextDecoder });
vm.runInContext(mainSource.slice(converterStart, converterEnd), converters);
vm.runInContext(mainSource.slice(subtitleResultStart, subtitleResultEnd), converters);

function withFixtureDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-subtitle-formats-'));
  try { run(directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('SRT with a UTF-8 BOM keeps Korean cue text and converts comma timestamps', () => {
  withFixtureDirectory(directory => {
    const file = path.join(directory, 'episode.srt');
    fs.writeFileSync(file, Buffer.from('\uFEFF1\r\n00:00:01,250 --> 00:00:02,500\r\n안녕하세요\r\n', 'utf8'));

    const result = converters.subtitleResult(file);
    const vtt = fs.readFileSync(result.path, 'utf8');
    assert.equal(result.assPath, null);
    assert.match(vtt, /^WEBVTT\n\n1\r\n00:00:01\.250 --> 00:00:02\.500\r\n안녕하세요/);
  });
});

test('CP949 SMI becomes WebVTT with Korean text and the following SYNC end time', () => {
  withFixtureDirectory(directory => {
    const file = path.join(directory, 'episode.smi');
    const cp949 = Buffer.from('3C53594E432053746172743D303E3C5020436C6173733D4B5243433EC7D1B1B9BEEE20C0DAB8B73C53594E432053746172743D313235303E3C5020436C6173733D4B5243433E', 'hex');
    fs.writeFileSync(file, cp949);

    const result = converters.subtitleResult(file);
    const vtt = fs.readFileSync(result.path, 'utf8');
    assert.match(vtt, /00:00:00\.000 --> 00:00:01\.250\n한국어 자막/);
  });
});

test('ASS UTF-16 and SSA CP949 keep Korean dialogue in WebVTT fallback', () => {
  withFixtureDirectory(directory => {
    const ass = path.join(directory, 'episode.ass');
    const assText = '[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\nDialogue: 0,0:00:01.20,0:00:02.45,Default,,0,0,0,,{\\i1}첫째\\N둘째, 쉼표\r\n';
    fs.writeFileSync(ass, Buffer.from(`\uFEFF${assText}`, 'utf16le'));

    const assResult = converters.subtitleResult(ass);
    const assVtt = fs.readFileSync(assResult.path, 'utf8');
    assert.equal(assResult.assPath, ass);
    assert.match(assVtt, /00:00:01\.200 --> 00:00:02\.450\n첫째\n둘째, 쉼표/);

    const ssa = path.join(directory, 'episode.ssa');
    const cp949Korean = Buffer.from('C7D1B1B9BEEE20C0DAB8B7', 'hex');
    const marker = Buffer.from('Dialogue: 0:00:03.00,0:00:04.00,', 'ascii');
    fs.writeFileSync(ssa, Buffer.concat([Buffer.from('[Events]\nFormat: Start, End, Text\n', 'ascii'), marker, cp949Korean, Buffer.from('\n', 'ascii')]));

    const ssaResult = converters.subtitleResult(ssa);
    const ssaVtt = fs.readFileSync(ssaResult.path, 'utf8');
    assert.equal(ssaResult.assPath, ssa);
    assert.match(ssaVtt, /00:00:03\.000 --> 00:00:04\.000\n한국어 자막/);
  });
});

test('VTT remains the selected file without an unnecessary conversion', () => {
  withFixtureDirectory(directory => {
    const file = path.join(directory, 'episode.vtt');
    fs.writeFileSync(file, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n한국어 자막\n', 'utf8');

    const result = converters.subtitleResult(file);
    assert.equal(result.path, file);
    assert.equal(result.assPath, null);
    assert.equal(fs.readFileSync(result.path, 'utf8').includes('한국어 자막'), true);
  });
});

test('SMI keeps lines after br and decodes text references without creating cue-breaking markup', () => {
  withFixtureDirectory(directory => {
    const file = path.join(directory, 'episode.smi');
    fs.writeFileSync(file, '<SAMI><BODY>\r\n<SYNC Start=1000><P Class=KRCC>\r\n첫 줄<br>\r\n둘째 줄\r\n'
      + '<SYNC Start=2000><P Class=KRCC>&nbsp;\r\n<SYNC Start=3000><P Class=KRCC>&lt;3 사랑해 &amp; a &lt; b<br>&#39;인용&#39; &#12354; --&gt; 끝\r\n'
      + '<SYNC Start=4000><P Class=KRCC>&nbsp;\r\n</BODY></SAMI>');
    const vtt = fs.readFileSync(converters.smiToVtt(file), 'utf8');
    assert.match(vtt, /00:00:01\.000 --> 00:00:02\.000\n첫 줄\n둘째 줄\n\n3\n/);
    assert.match(vtt, /&lt;3 사랑해 &amp; a &lt; b\n'인용' あ → 끝/);
  });
});

test('SRT converts br to a safe line break and keeps literal less-than signs and arrows', () => {
  withFixtureDirectory(directory => {
    const file = path.join(directory, 'episode.srt');
    fs.writeFileSync(file, '1\r\n00:00:01,000 --> 00:00:02,000\r\n첫 줄<br>\r\n둘째 줄\r\n\r\n'
      + '2\r\n00:00:03,000 --> 00:00:04,000\r\n<3 사랑해 a < b\r\n화살표 --> 끝\r\n');
    const vtt = fs.readFileSync(converters.srtToVtt(file), 'utf8');
    assert.match(vtt, /첫 줄\r?\n둘째 줄/);
    assert.match(vtt, /&lt;3 사랑해 a &lt; b/);
    assert.match(vtt, /화살표 → 끝/);
    assert.match(vtt, /00:00:01\.000 --> 00:00:02\.000/);
  });
});

test('ASS keeps literal text and line breaks while dropping vector drawing commands', () => {
  withFixtureDirectory(directory => {
    const file = path.join(directory, 'episode.ass');
    fs.writeFileSync(file, '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
      + 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,첫 줄\\N\\N둘째 줄\n'
      + 'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,<3 사랑해, a < b --> 끝\n'
      + 'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}글자만\n');
    const vtt = fs.readFileSync(converters.assToVtt(file), 'utf8');
    assert.match(vtt, /첫 줄\n둘째 줄/);
    assert.match(vtt, /&lt;3 사랑해, a &lt; b → 끝/);
    assert.match(vtt, /글자만/);
    assert.doesNotMatch(vtt, /m 0 0 l 100/);
  });
});

test('legacy subtitle migration preserves the old file and retries only inside managed subtitle storage', () => {
  withFixtureDirectory(directory => {
    const userData = path.join(directory, 'app-data'), managed = path.join(userData, 'subtitles', 'episode');
    const outside = path.join(directory, 'external'); fs.mkdirSync(managed, { recursive: true }); fs.mkdirSync(outside);
    const oldVtt = path.join(managed, 'episode.vtt'), sourceSrt = path.join(managed, 'episode.srt');
    const oldBytes = Buffer.from('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n첫 줄<br>\n둘째 줄\n');
    const sourceBytes = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n첫 줄<br>\n둘째 줄\n');
    fs.writeFileSync(oldVtt, oldBytes); fs.writeFileSync(sourceSrt, sourceBytes);
    const externalVtt = path.join(outside, 'episode.vtt'), externalSrt = path.join(outside, 'episode.srt');
    fs.writeFileSync(externalVtt, oldBytes); fs.writeFileSync(externalSrt, sourceBytes);
    const storeFile = path.join(userData, 'subtitle-store.json');
    fs.mkdirSync(userData, { recursive: true });
    const data = {
      inside: [{ id: 'managed-old', source: 'kairan', label: 'Kairan', path: oldVtt }],
      outside: [{ id: 'external-old', source: 'user', label: 'User', path: externalVtt }]
    };
    let redirectedVtt = null;
    if (process.platform === 'win32') {
      const junction = path.join(managed, 'redirected'); fs.symlinkSync(outside, junction, 'junction');
      redirectedVtt = path.join(junction, 'episode.vtt');
      data.redirected = [{ id: 'redirected-old', source: 'user', label: 'Redirected', path: redirectedVtt }];
    }
    fs.writeFileSync(storeFile, JSON.stringify(data));
    const app = { getPath: name => name === 'userData' ? userData : directory };
    const context = vm.createContext({ fs, path, TextDecoder, app });
    vm.runInContext(mainSource.slice(converterStart, converterEnd), context);
    const store = new SubtitleStore({ app, reconvert: context.reconvertSubtitle });
    const [migrated] = store.list('inside'), [keptExternal] = store.list('outside');
    assert.notEqual(migrated.path, oldVtt);
    assert.equal(fs.readFileSync(migrated.path, 'utf8').includes('첫 줄\n둘째 줄'), true);
    assert.deepEqual(fs.readFileSync(oldVtt), oldBytes, 'the legacy converted file remains untouched');
    assert.deepEqual(fs.readFileSync(sourceSrt), sourceBytes, 'the original subtitle remains untouched');
    assert.equal(keptExternal.path, externalVtt, 'files outside managed storage are not migrated');
    assert.deepEqual(fs.readFileSync(externalVtt), oldBytes);
    if (redirectedVtt) {
      const [keptRedirected] = store.list('redirected');
      assert.equal(keptRedirected.path, redirectedVtt, 'a junction cannot redirect migration outside managed storage');
      assert.deepEqual(fs.readdirSync(outside).sort(), ['episode.srt', 'episode.vtt']);
    }
    const saved = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    assert.equal(saved.inside[0].converter, 2);
    assert.equal(saved.inside[0].id, 'managed-old');
    assert.equal(saved.outside[0].converter, 2);
    const second = new SubtitleStore({ app, reconvert: context.reconvertSubtitle }).list('inside')[0];
    assert.equal(second.path, migrated.path, 'a restart reuses the converted file');
    assert.equal(fs.readdirSync(managed).filter(name => name.includes('.lilac-v2-')).length, 1);
  });
});

test('a failed saved-subtitle conversion remains eligible for migration on the next list call', () => {
  withFixtureDirectory(directory => {
    const userData = path.join(directory, 'app-data'), managed = path.join(userData, 'subtitles');
    const oldVtt = path.join(managed, 'episode.vtt'), upgraded = path.join(managed, 'episode.v2.vtt');
    fs.mkdirSync(managed, { recursive: true }); fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(oldVtt, 'WEBVTT\n\nold');
    const storeFile = path.join(userData, 'subtitle-store.json');
    fs.writeFileSync(storeFile, JSON.stringify({ episode: [{ id: 'old', source: 'kairan', path: oldVtt }] }));
    const app = { getPath: name => name === 'userData' ? userData : directory };
    let attempts = 0;
    const store = new SubtitleStore({ app, reconvert: () => {
      if (++attempts === 1) throw new Error('temporary conversion failure');
      fs.writeFileSync(upgraded, 'WEBVTT\n\nnew');
      return upgraded;
    } });
    assert.equal(store.list('episode')[0].path, oldVtt);
    assert.equal(store.data.episode[0].converter, undefined);
    assert.equal(attempts, 1);
    assert.equal(store.list('episode')[0].path, upgraded);
    assert.equal(store.data.episode[0].converter, 2);
    assert.deepEqual(fs.readFileSync(oldVtt), Buffer.from('WEBVTT\n\nold'));
    assert.equal(attempts, 2);
  });
});

test('removing saved subtitles preserves similarly prefixed user files and cleans only unused managed files', () => {
  withFixtureDirectory(directory => {
    const userData = path.join(directory, 'app-data');
    const managed = path.join(userData, 'subtitles'), backup = path.join(userData, 'subtitles-backup');
    fs.mkdirSync(managed, { recursive: true }); fs.mkdirSync(backup, { recursive: true });
    const app = { getPath: name => name === 'userData' ? userData : directory };
    const store = new SubtitleStore({ app });
    const userFile = path.join(backup, 'keep.vtt'); fs.writeFileSync(userFile, 'user data');
    const userEntry = store.save('user-episode', { source: 'user', label: 'Picked file', path: userFile });
    assert.equal(store.remove('user-episode', userEntry.id), true);
    assert.equal(fs.readFileSync(userFile, 'utf8'), 'user data', 'a sibling prefix is outside managed storage');
    if (process.platform === 'win32') {
      const junction = path.join(managed, 'redirected'); fs.symlinkSync(backup, junction, 'junction');
      const redirectedEntry = store.save('redirected-user', { source: 'user', path: path.join(junction, path.basename(userFile)) });
      assert.equal(store.remove('redirected-user', redirectedEntry.id), true);
      assert.equal(fs.readFileSync(userFile, 'utf8'), 'user data', 'a junction cannot redirect deletion outside managed storage');
    }

    const managedFile = path.join(managed, 'download.vtt'); fs.writeFileSync(managedFile, 'managed data');
    const first = store.save('episode-one', { source: 'kairan', path: managedFile });
    const second = store.save('episode-two', { source: 'csora', path: managedFile });
    assert.equal(store.remove('episode-one', first.id), true);
    assert.equal(fs.existsSync(managedFile), true, 'a file still used by another episode is retained');
    assert.equal(store.remove('episode-two', second.id), true);
    assert.equal(fs.existsSync(managedFile), false, 'an unused app-managed file is removed');
    assert.equal(fs.readFileSync(userFile, 'utf8'), 'user data');
  });
});
