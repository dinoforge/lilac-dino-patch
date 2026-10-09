const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

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
