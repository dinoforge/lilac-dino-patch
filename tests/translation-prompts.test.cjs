const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadTranslationPrompt } = require('../electron/translation-prompts.cjs');

const prompts = path.join(__dirname, '..', 'docs', 'prompts');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(prompts, file))).digest('hex').toUpperCase();

test('ships the two supplied translation prompts byte-for-byte and loads them by fixed language key', () => {
  assert.equal(digest('영어 번역 프롬프트.txt'), '582EAF421CABBCF89279579E5723AA07B070E5B1DF2E28EE044994B2E951E37E');
  assert.equal(digest('일본어 번역 프롬프트.txt'), '9FF7E860CF0C79396621C2EF65B364596EBB884AA5B3CE68E60AB0D4B42EC584');
  assert.equal(loadTranslationPrompt('english'), fs.readFileSync(path.join(prompts, '영어 번역 프롬프트.txt'), 'utf8'));
  assert.equal(loadTranslationPrompt('japanese'), fs.readFileSync(path.join(prompts, '일본어 번역 프롬프트.txt'), 'utf8'));
  assert.throws(() => loadTranslationPrompt('../secret'), /지원하지 않는 번역 프롬프트/);
});

test('keeps the ReazonSpeech example marked as ASR hotwords rather than a translation glossary', () => {
  const example = fs.readFileSync(path.join(prompts, 'Reazon_작품용_단어사전_예시.txt'), 'utf8');
  assert.match(example, /ReazonSpeech 작품용 고유명사 사전 사용법/);
  assert.match(example, /한글 번역이나 문장 전체를 넣지 마십시오/);
  assert.match(example, /실제 작품에 맞게 전부 바꾸십시오/);
});

test('manual ChatGPT flow fetches the prompt through a language-restricted preload bridge', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(main, /ipcMain\.handle\('subtitle:translation-prompt'.*loadTranslationPrompt\(language\)/);
  assert.match(preload, /translationPrompt:\s*language\s*=>\s*ipcRenderer\.invoke\('subtitle:translation-prompt',\s*language\)/);
  assert.match(app, /translationPrompt\(sourceLanguage\)/);
  assert.ok(packageJson.build.files.includes('docs/prompts/**/*'));
});
