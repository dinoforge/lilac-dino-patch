'use strict';

// Experimental, explicitly initiated ChatGPT web UI automation. It may stop
// working when the website changes. Never inspect cookies, credentials, other
// conversations, or bypass CAPTCHA, rate limits or access restrictions.
const HOME = 'https://chatgpt.com/';
const MAX_PROMPT = 120000;
const MAX_RESULT = 2000000;
const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));

function validateJob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid web translation request');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > MAX_PROMPT)
    throw new Error('번역 요청이 비어 있거나 크기 제한을 넘었습니다.');
  if (typeof input.jobKey !== 'string' || !/^[a-zA-Z0-9_-]{8,96}$/.test(input.jobKey))
    throw new Error('번역 작업 식별자가 올바르지 않습니다.');
  return { prompt: input.prompt, jobKey: input.jobKey };
}
const composerSelector = '#prompt-textarea[contenteditable="true"], [data-testid="prompt-textarea"][contenteditable="true"]';
const checkComposer = '(() => { if (location.origin !== "https://chatgpt.com") return {error:"wrong origin"}; const el=document.querySelector(' + JSON.stringify(composerSelector) + '); return el ? {ready:true, assistants:document.querySelectorAll("[data-message-author-role=assistant]").length}: {error:"composer missing"}; })()';
const focusComposer = '(() => { if (location.origin !== "https://chatgpt.com") return false; const el=document.querySelector(' + JSON.stringify(composerSelector) + '); if (!el || el.textContent.trim()) return false; el.focus(); return document.activeElement===el; })()';
function verifyComposer(prompt) {
  return '(() => { const el=document.querySelector(' + JSON.stringify(composerSelector) + '); return location.origin==="https://chatgpt.com" && Boolean(el && el.textContent.trim()===' + JSON.stringify(prompt.trim()) + '); })()';
}
const clickSend = '(() => { if(location.origin!=="https://chatgpt.com") return false; const button=document.querySelector("button[data-testid=send-button]"); if(!button||button.disabled||button.getAttribute("aria-disabled")==="true") return false; button.click(); return true; })()';
const readResponse = '(() => { if(location.origin!=="https://chatgpt.com") return {error:"wrong origin"}; const nodes=[...document.querySelectorAll("[data-message-author-role=assistant]")]; const last=nodes[nodes.length-1]; const content=last?.querySelector(".markdown")||last; return {assistants:nodes.length,text:(content?.innerText||"").slice(0,' + (MAX_RESULT + 1) + '),generating:Boolean(document.querySelector("button[data-testid=stop-button]"))}; })()';

function createWebAutoTranslation({ open, getWindow, sleep = sleepDefault, now = Date.now, timeoutMs = 150000 }) {
  if (typeof open !== 'function' || typeof getWindow !== 'function') throw new TypeError('Web browser access is required');
  let active = null;
  let job = null;
  function cancel() {
    if (active) active.cancelled = true;
    return true; // Does not undo an already submitted message.
  }
  async function run(input) {
    const { prompt, jobKey } = validateJob(input);
    if (active) throw new Error('다른 ChatGPT 웹 번역이 진행 중입니다.');
    const task = { cancelled: false };
    active = task;
    const check = () => {
      if (task.cancelled) throw new Error('ChatGPT 웹 번역을 중단했습니다. 이미 보낸 메시지는 웹에 남을 수 있습니다.');
    };
    try {
      await open();
      const win = getWindow();
      if (!win || win.isDestroyed?.() || !win.webContents?.executeJavaScript || !win.webContents?.insertText)
        throw new Error('ChatGPT 내장 브라우저가 자동 번역을 지원하지 않습니다.');
      if (job !== jobKey) {
        await win.loadURL(HOME); // a fresh conversation, never an existing chat
        job = jobKey;
      }
      const wc = win.webContents;
      const call = async script => {
        check();
        const url = typeof wc.getURL === 'function' ? wc.getURL() : '';
        if (!/^https:\/\/chatgpt\.com(?:\/|$)/.test(url))
          throw new Error('ChatGPT 외부 페이지에서는 번역을 수행하지 않습니다.');
        return wc.executeJavaScript(script);
      };
      const readyDeadline = now() + 25000;
      let state;
      do {
        state = await call(checkComposer);
        if (state?.ready) break;
        if (now() >= readyDeadline)
          throw new Error('ChatGPT 입력창을 찾지 못했습니다. 로그인 상태나 변경된 페이지를 확인하세요.');
        await sleep(1000);
      } while (true);
      if (!await call(focusComposer)) throw new Error('ChatGPT 입력창을 비워 둔 뒤 다시 시도하세요.');
      check();
      await wc.insertText(prompt);
      if (!await call(verifyComposer(prompt)))
        throw new Error('프롬프트가 정확히 입력됐는지 확인할 수 없어 전송하지 않았습니다.');
      if (!await call(clickSend))
        throw new Error('ChatGPT 전송 버튼을 확인할 수 없어 전송하지 않았습니다.');
      const baseline = Number(state.assistants) || 0;
      const deadline = now() + timeoutMs;
      let previous = '', stable = 0;
      while (now() < deadline) {
        await sleep(1000);
        const result = await call(readResponse);
        if (result?.error) throw new Error('ChatGPT 응답 화면이 변경됐습니다.');
        if (result?.text?.length > MAX_RESULT) throw new Error('ChatGPT 응답이 너무 큽니다.');
        const text = result.assistants > baseline ? String(result.text || '').trim() : '';
        stable = text && !result.generating && text === previous ? stable + 1 : 0;
        previous = text;
        if (stable >= 2) return { text, source: 'chatgpt-web-experimental' };
      }
      throw new Error('응답을 확인하지 못했습니다. 다시 전송하기 전에 ChatGPT 내장 창을 확인하세요.');
    } finally {
      if (active === task) active = null;
    }
  }
  return { run, cancel, busy: () => Boolean(active) };
}

module.exports = { validateJob, checkComposer, focusComposer, verifyComposer, clickSend, readResponse, createWebAutoTranslation };
