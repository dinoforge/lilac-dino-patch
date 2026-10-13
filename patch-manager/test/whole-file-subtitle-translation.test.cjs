'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const subtitle = require('../../src/manual-subtitle-translation.js');

test('whole-file SRT path preserves non-consecutive source numbers, order, and exact times', () => {
  const source = [
    '7', '00:00:01,120 --> 00:00:02,345', 'こんにちは', '',
    '12', '00:00:04.010 --> 00:00:05.900', 'ありがとう'
  ].join('\n');
  const parsed = subtitle.parseSubtitleFile(source, 'srt');
  const upload = subtitle.toSrt(parsed);
  const uploaded = subtitle.parseSrt(upload);
  assert.deepEqual(uploaded.cues.map(cue => [cue.sourceNumber, cue.startMs, cue.endMs]), [
    ['7', 1120, 2345], ['12', 4010, 5900]
  ]);

  const result = [
    '7', '00:00:01,120 --> 00:00:02,345', '안녕', '',
    '12', '00:00:04,010 --> 00:00:05,900', '고마워'
  ].join('\n');
  const checked = subtitle.validateWholeFileResult(result, uploaded.cues);
  assert.deepEqual(Object.keys(checked.translations), ['1', '2']);
  assert.deepEqual(Object.values(checked.translations), ['안녕', '고마워']);
  assert.throws(() => subtitle.validateWholeFileResult(result.replace('12\n', '13\n'), uploaded.cues), /번호 또는 순서/);
  assert.throws(() => subtitle.validateWholeFileResult(result.replace('00:00:05,900', '00:00:05,901'), uploaded.cues), /시작·종료 시간/);
  assert.throws(() => subtitle.validateWholeFileResult(result.slice(0, result.indexOf('\n\n')), uploaded.cues), /개수/);
});

test('whole-file VTT conversion keeps all cue times and renders the checked translations back to WebVTT', () => {
  const source = 'WEBVTT\n\nintro\n00:00:01.000 --> 00:00:02.250 align:start\nこんにちは\n\n00:00:05.000 --> 00:00:06.100\nありがとう\n';
  const parsed = subtitle.parseSubtitleFile(source, 'vtt');
  const uploaded = subtitle.parseSrt(subtitle.toSrt(parsed));
  assert.equal(uploaded.cues.length, 2);
  const checked = subtitle.validateWholeFileResult([
    '1', '00:00:01,000 --> 00:00:02,250', '안녕', '',
    '2', '00:00:05,000 --> 00:00:06,100', '고마워'
  ].join('\n'), uploaded.cues);
  const output = subtitle.renderTranslatedWebVtt(parsed, checked.translations);
  const verified = subtitle.validateRenderedWebVtt(parsed, output);
  assert.equal(verified.cues.length, 2);
  assert.match(output, /00:00:01\.000 --> 00:00:02\.250 align:start/);
  assert.match(output, /안녕/);
  assert.match(output, /고마워/);
});

test('whole-file ASS conversion preserves dialogue order, timing, commas, and line breaks', () => {
  const source = [
    '[Script Info]', 'Title: fixture', '', '[Events]', 'Format: Layer, Start, End, Style, Text',
    'Dialogue: 0,0:00:01.25,0:00:02.00,Default,こんにちは、世界',
    'Dialogue: 0,0:00:04.00,0:00:05.50,Default,ありがとう\\Nまたね'
  ].join('\n');
  const parsed = subtitle.parseSubtitleFile(source, 'ass');
  assert.deepEqual(parsed.cues.map(cue => [cue.id, cue.startMs, cue.endMs, cue.text]), [
    [1, 1250, 2000, 'こんにちは、世界'], [2, 4000, 5500, 'ありがとう\nまたね']
  ]);
  const uploaded = subtitle.parseSrt(subtitle.toSrt(parsed));
  const checked = subtitle.validateWholeFileResult([
    '1', '00:00:01,250 --> 00:00:02,000', '안녕, 세계', '',
    '2', '00:00:04,000 --> 00:00:05,500', '고마워\n또 보자'
  ].join('\n'), uploaded.cues);
  const output = subtitle.renderTranslatedWebVtt(parsed, checked.translations);
  assert.equal(subtitle.validateRenderedWebVtt(parsed, output).cues.length, 2);
  assert.match(output, /00:00:04\.000 --> 00:00:05\.500/);
});

test('whole-file validation rejects JSON, ignored blocks, reordered cues, and changed count', () => {
  const source = subtitle.parseSrt('1\n00:00:01,000 --> 00:00:02,000\n一\n\n2\n00:00:03,000 --> 00:00:04,000\n二');
  const expected = subtitle.parseSrt(subtitle.toSrt(source)).cues;
  assert.throws(() => subtitle.validateWholeFileResult('{"translations":[]}', expected), /SRT/);
  assert.throws(() => subtitle.validateWholeFileResult('설명\n\n1\n00:00:01,000 --> 00:00:02,000\n하나\n\n2\n00:00:03,000 --> 00:00:04,000\n둘', expected), /SRT 블록/);
  assert.throws(() => subtitle.validateWholeFileResult('2\n00:00:03,000 --> 00:00:04,000\n둘\n\n1\n00:00:01,000 --> 00:00:02,000\n하나', expected), /번호 또는 순서/);
});
