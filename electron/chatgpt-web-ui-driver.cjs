'use strict';

// OpenAI's Terms of Use prohibit automatic or programmatic extraction of
// service data and output. Keep this boundary fail-closed until an officially
// supported integration is available; the UI offers a manual copy/paste path.
const AUTOMATIC_OUTPUT_UNAVAILABLE = 'ChatGPT 웹 응답 자동 수집은 OpenAI 이용약관상 지원하지 않습니다. 수동 번역을 사용하세요.';
const MAX_PROMPT = 120000;

function validateJob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid web translation request');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > MAX_PROMPT)
    throw new Error('번역 요청이 비어 있거나 크기 제한을 넘었습니다.');
  if (typeof input.jobKey !== 'string' || !/^[a-zA-Z0-9_-]{8,96}$/.test(input.jobKey))
    throw new Error('번역 작업 식별자가 올바르지 않습니다.');
  return { prompt: input.prompt, jobKey: input.jobKey };
}

function createWebAutoTranslation() {
  return Object.freeze({
    async run(input) {
      validateJob(input);
      throw new Error(AUTOMATIC_OUTPUT_UNAVAILABLE);
    },
    cancel() { return true; },
    busy() { return false; }
  });
}

module.exports = { AUTOMATIC_OUTPUT_UNAVAILABLE, validateJob, createWebAutoTranslation };
