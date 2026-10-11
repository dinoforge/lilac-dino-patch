'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROMPT_FILES = Object.freeze({
  english: '영어 번역 프롬프트.txt',
  japanese: '일본어 번역 프롬프트.txt'
});

function loadTranslationPrompt(language, promptDirectory = path.join(__dirname, 'prompts')) {
  const file = PROMPT_FILES[language];
  if (!file) throw new Error('지원하지 않는 번역 프롬프트입니다.');
  return fs.readFileSync(path.join(promptDirectory, file), 'utf8');
}

module.exports = { PROMPT_FILES, loadTranslationPrompt };
