'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const translation = require('../../src/manual-subtitle-translation.js');
const { loadTranslationPrompt } = require('../../electron/translation-prompts.cjs');
const promptManifest = require('../prompt-hashes.json');
const workflow = require('../core/subtitle-workflow.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');

test('provided English, Japanese, and Reazon reference files remain byte-identical', () => {
  for (const [name, expected] of Object.entries(promptManifest.files)) {
    const bytes = fs.readFileSync(path.join(repoRoot, 'docs', 'prompts', name));
    assert.equal(bytes.length, expected.bytes, `${name} byte count`);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase(), expected.sha256, `${name} SHA-256`);
  }
  assert.equal(loadTranslationPrompt('english'), fs.readFileSync(path.join(repoRoot, 'docs', 'prompts', '영어 번역 프롬프트.txt'), 'utf8'));
  assert.equal(loadTranslationPrompt('japanese'), fs.readFileSync(path.join(repoRoot, 'docs', 'prompts', '일본어 번역 프롬프트.txt'), 'utf8'));
});

test('language selection uses the matching prompt and includes two nearby context cues', () => {
  const longJapanese = Array.from({ length: 26 }, (_, index) => `00:00:${String(index + 1).padStart(2, '0')}.000 --> 00:00:${String(index + 2).padStart(2, '0')}.000\n${index + 1}番目の台詞`).join('\n\n');
  const japanese = workflow.createWorkflow('context-sample.vtt', `WEBVTT\n\n${longJapanese}\n`);
  const japanesePrompt = workflow.makeBatchPrompt(japanese, 0, { sourceLanguage: 'japanese', title: '합성 작품', episode: '2' });
  assert.ok(japanesePrompt.includes(loadTranslationPrompt('japanese')));
  assert.match(japanesePrompt, /번역 원문 언어 판정: 일본어/);
  assert.match(japanesePrompt, /작품·회차: 합성 작품 · 2화/);
  assert.match(japanesePrompt, /뒤 문맥 \(번역 대상 아님\)/);
  assert.match(japanesePrompt, /25番目の台詞/);

  const english = workflow.createDemoWorkflow('english');
  const englishPrompt = workflow.makeBatchPrompt(english, 0, { sourceLanguage: 'english' });
  assert.ok(englishPrompt.includes(loadTranslationPrompt('english')));
  assert.match(englishPrompt, /번역 원문 언어 판정: 영어/);
  assert.throws(() => workflow.makeBatchPrompt(english, 0, { sourceLanguage: 'korean' }), /영어 또는 일본어/);
});

test('response validation rejects missing, duplicate, and extra cue IDs without mutating the workflow', () => {
  const current = workflow.createDemoWorkflow('english');
  const before = { ...current.translations };
  assert.throws(() => workflow.applyBatchResponse(current, 0, '{"translations":[{"id":1,"text":"하나"}]}'), /일부 자막이 빠졌습니다/);
  assert.throws(() => workflow.applyBatchResponse(current, 0, '{"translations":[{"id":1,"text":"하나"},{"id":1,"text":"둘"},{"id":2,"text":"둘"},{"id":3,"text":"셋"},{"id":4,"text":"넷"}]}'), /맞지 않습니다/);
  assert.throws(() => workflow.applyBatchResponse(current, 0, '{"translations":[{"id":1,"text":"하나"},{"id":2,"text":"둘"},{"id":3,"text":"셋"},{"id":4,"text":"넷"},{"id":99,"text":"추가"}]}'), /맞지 않습니다/);
  assert.deepEqual({ ...current.translations }, before);
});

test('translated WebVTT keeps cue order and timestamps and requires every non-empty cue', () => {
  const raw = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nFirst line\n\n00:00:03.000 --> 00:00:04.000\nSecond line\n';
  const current = workflow.createWorkflow('sample.vtt', raw);
  assert.throws(() => workflow.renderCompleteTranslation(current), /아직 번역되지 않은/);
  workflow.applyBatchResponse(current, 0, '{"translations":[{"id":1,"text":"첫 번째"},{"id":2,"text":"두 번째"}]}');
  const output = workflow.renderCompleteTranslation(current);
  assert.match(output, /00:00:01\.000 --> 00:00:02\.500\n첫 번째/);
  assert.match(output, /00:00:03\.000 --> 00:00:04\.000\n두 번째/);
  assert.ok(output.indexOf('첫 번째') < output.indexOf('두 번째'));
  assert.equal((output.match(/ --> /g) || []).length, 2);
  assert.equal(translation.parseWebVtt(output).cues.length, 2);
});

test('export never overwrites the selected source or any existing destination', t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-companion-export-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const sourcePath = path.join(temporaryRoot, 'original.vtt');
  const outputPath = path.join(temporaryRoot, 'original.ko.vtt');
  fs.writeFileSync(sourcePath, 'original', 'utf8');
  assert.throws(() => workflow.writeNewSubtitle({ sourcePath, targetPath: sourcePath, contents: 'changed' }), /원본 자막 파일은 덮어쓰지 않습니다/);
  assert.throws(() => workflow.writeNewSubtitle({ sourcePath, targetPath: path.join(temporaryRoot, 'translated.srt'), contents: 'translated' }), /\.vtt 파일로 저장/);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'original');
  assert.equal(workflow.writeNewSubtitle({ sourcePath, targetPath: outputPath, contents: 'translated' }), outputPath);
  assert.throws(() => workflow.writeNewSubtitle({ sourcePath, targetPath: outputPath, contents: 'overwrite' }), /EEXIST/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'translated');
});
