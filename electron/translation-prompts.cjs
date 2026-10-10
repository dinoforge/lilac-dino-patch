const fs = require('fs');
const path = require('path');

const PROMPT_FILES = Object.freeze({
  english: '영어 번역 프롬프트.txt',
  japanese: '일본어 번역 프롬프트.txt'
});

function loadTranslationPrompt(language, promptDirectory = path.join(__dirname, '..', 'docs', 'prompts')) {
  const file = PROMPT_FILES[language];
  if (!file) throw new Error('지원하지 않는 번역 프롬프트입니다.');
  return fs.readFileSync(path.join(promptDirectory, file), 'utf8');
}

module.exports = { loadTranslationPrompt };
