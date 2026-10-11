'use strict';

const fs = require('node:fs');
const path = require('node:path');
const subtitle = require('../../src/manual-subtitle-translation.js');
const { loadTranslationPrompt } = require('../../electron/translation-prompts.cjs');

const DEMO_VTT = Object.freeze({
  japanese: `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n駅前で待ってるね。\n\n00:00:03.400 --> 00:00:05.000\n本当に来てくれるの？\n\n00:00:05.500 --> 00:00:07.000\n約束したでしょう。\n\n00:00:08.000 --> 00:00:10.000\nじゃあ、行こう。\n`,
  english: `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nI'll wait by the station.\n\n00:00:03.400 --> 00:00:05.000\nYou really came?\n\n00:00:05.500 --> 00:00:07.000\nI promised, didn't I?\n\n00:00:08.000 --> 00:00:10.000\nThen, let's go.\n`
});

function cueRows(parsed) {
  let cueIndex = 0;
  return parsed.blocks.map(block => {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex(line => /\d{2}:\d{2}(?::\d{2})?\.\d{3}\s*-->\s*\d{2}:\d{2}(?::\d{2})?\.\d{3}/.test(line));
    if (timingIndex < 0) return null;
    const cue = parsed.cues[cueIndex++];
    return cue ? { ...cue, timing: lines[timingIndex] } : null;
  }).filter(Boolean);
}

function createWorkflow(fileName, text, sourcePath = null) {
  const parsed = subtitle.parseWebVtt(text);
  const batches = subtitle.makeBatches(parsed.cues);
  if (!batches.length) throw new Error('번역할 자막 문장을 찾지 못했습니다.');
  return {
    fileName: path.basename(String(fileName || 'subtitle.vtt')),
    sourcePath: sourcePath ? path.resolve(sourcePath) : null,
    parsed,
    batches,
    translations: Object.create(null),
    detectedLanguage: subtitle.detectSourceLanguage(parsed.cues)
  };
}

function createDemoWorkflow(language = 'japanese') {
  if (!Object.hasOwn(DEMO_VTT, language)) throw new Error('지원하지 않는 예시 자막입니다.');
  return createWorkflow(`합성-${language}.vtt`, DEMO_VTT[language]);
}

function summarizeWorkflow(workflow) {
  return {
    fileName: workflow.fileName,
    detectedLanguage: workflow.detectedLanguage,
    cues: cueRows(workflow.parsed),
    batches: workflow.batches.map((batch, index) => ({ index, ids: batch.map(cue => cue.id), size: batch.length })),
    translatedIds: Object.keys(workflow.translations).map(Number),
    requiredIds: workflow.parsed.cues.filter(cue => cue.text.trim()).map(cue => cue.id)
  };
}

function makeBatchPrompt(workflow, batchIndex, { sourceLanguage, title = '', episode = '' } = {}) {
  const batch = workflow.batches[Number(batchIndex)];
  if (!batch) throw new RangeError('자막 묶음 선택이 올바르지 않습니다.');
  if (!['english', 'japanese'].includes(sourceLanguage)) throw new Error('영어 또는 일본어를 선택해 주세요.');
  const firstId = batch[0].id, lastId = batch[batch.length - 1].id;
  const contextBefore = workflow.parsed.cues.filter(cue => cue.id < firstId).slice(-2).map(cue => ({ id: cue.id, text: cue.text }));
  const contextAfter = workflow.parsed.cues.filter(cue => cue.id > lastId).slice(0, 2).map(cue => ({ id: cue.id, text: cue.text }));
  return subtitle.makePrompt({
    title,
    episode,
    items: batch,
    contextBefore,
    contextAfter,
    translationInstructions: loadTranslationPrompt(sourceLanguage),
    sourceLanguage
  });
}

function applyBatchResponse(workflow, batchIndex, response) {
  const batch = workflow.batches[Number(batchIndex)];
  if (!batch) throw new RangeError('자막 묶음 선택이 올바르지 않습니다.');
  const parsed = subtitle.parseResponse(response, batch.map(cue => cue.id));
  Object.assign(workflow.translations, parsed);
  return summarizeWorkflow(workflow);
}

function renderCompleteTranslation(workflow) {
  const requiredIds = workflow.parsed.cues.filter(cue => cue.text.trim()).map(cue => cue.id);
  const missing = requiredIds.filter(id => !Object.hasOwn(workflow.translations, id));
  if (missing.length) throw new Error(`아직 번역되지 않은 자막이 있습니다: ${missing.join(', ')}`);
  return subtitle.renderWebVtt(workflow.parsed, workflow.translations);
}

function assertSafeOutputPath(sourcePath, targetPath) {
  if (!targetPath) throw new Error('저장할 파일 경로가 필요합니다.');
  if (path.extname(targetPath).toLocaleLowerCase('en-US') !== '.vtt') throw new Error('번역 결과는 .vtt 파일로 저장해 주세요.');
  const target = path.resolve(targetPath).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US');
  if (sourcePath && target === path.resolve(sourcePath).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')) {
    throw new Error('원본 자막 파일은 덮어쓰지 않습니다. 새 파일 이름을 선택해 주세요.');
  }
}

function writeNewSubtitle({ sourcePath, targetPath, contents }) {
  assertSafeOutputPath(sourcePath, targetPath);
  fs.writeFileSync(targetPath, String(contents), { encoding: 'utf8', flag: 'wx' });
  return path.resolve(targetPath);
}

module.exports = {
  DEMO_VTT,
  applyBatchResponse,
  assertSafeOutputPath,
  createDemoWorkflow,
  createWorkflow,
  makeBatchPrompt,
  renderCompleteTranslation,
  summarizeWorkflow,
  writeNewSubtitle
};
