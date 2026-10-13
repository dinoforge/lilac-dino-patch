'use strict';

const MAX_PROMPT = 120_000;
const MAX_RESPONSE = 2_000_000;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_MS = 700;
const DEFAULT_STABLE_MS = 1_800;
const CHATGPT_HOSTS = new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']);

function failure(code, message, sent = false) {
  const error = new Error(message);
  error.code = code;
  error.sent = sent;
  return error;
}

function validateJob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('INVALID_REQUEST', '번역 요청 형식이 올바르지 않습니다.');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > MAX_PROMPT)
    throw failure('INVALID_REQUEST', '번역 요청이 비어 있거나 크기 제한을 넘었습니다.');
  if (typeof input.jobKey !== 'string' || !/^[a-zA-Z0-9_-]{8,96}$/.test(input.jobKey))
    throw failure('INVALID_REQUEST', '번역 작업 식별자가 올바르지 않습니다.');
  if (!Number.isInteger(input.batchIndex) || input.batchIndex < 0 || input.batchIndex > 1000)
    throw failure('INVALID_REQUEST', '번역 묶음 번호가 올바르지 않습니다.');
  return { prompt: input.prompt, jobKey: input.jobKey, batchIndex: input.batchIndex };
}

function inspectScript(expectedPrompt = '', includeAssistantText = false) {
  const expected = JSON.stringify(String(expectedPrompt));
  return `/* dino-chatgpt-auto:inspect */ (() => {
    const expected = ${expected};
    const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
    const firstVisible = selectors => {
      for (const selector of selectors) {
        const values = [...document.querySelectorAll(selector)].filter(visible);
        if (values.length) return { values, selector };
      }
      return { values: [], selector: '' };
    };
    const composerSet = firstVisible([
      '#prompt-textarea',
      '[data-testid="composer"] textarea',
      'main textarea',
      'main [role="textbox"][contenteditable="true"]',
      'main [contenteditable="true"]'
    ]);
    const composer = composerSet.values.length === 1 ? composerSet.values[0] : null;
    const composerText = element => element ? ('value' in element ? element.value : element.innerText || element.textContent || '') : '';
    const normalize = value => String(value || '').replace(/\\u00a0/g, ' ').replace(/\\r/g, '').replace(/[ \\t]+\\n/g, '\\n').trim();
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const sendButtons = buttons.filter(button => {
      const label = [button.getAttribute('aria-label'), button.getAttribute('data-testid'), button.getAttribute('title')].filter(Boolean).join(' ');
      return /send-button/i.test(label) || /^(send|전송|메시지 보내기)$/i.test(label.trim());
    });
    const stopButtons = buttons.filter(button => {
      const label = [button.getAttribute('aria-label'), button.getAttribute('data-testid'), button.getAttribute('title')].filter(Boolean).join(' ');
      return /stop-button/i.test(label) || /stop generating|생성 중지|응답 중지/i.test(label);
    });
    const users = [...document.querySelectorAll('[data-message-author-role="user"]')].filter(visible);
    const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(visible);
    const lastUserText = users.length ? composerText(users[users.length - 1]) : '';
    const loginFields = [...document.querySelectorAll('input[type="email"],input[type="password"],[autocomplete="username"]')].some(visible);
    const loginActions = [...document.querySelectorAll('a,button,[role="button"]')].filter(visible).some(element => {
      const label = [element.getAttribute('aria-label'),element.getAttribute('title'),element.getAttribute('data-testid'),element.innerText].filter(Boolean).join(' ');
      return /\\b(log in|sign in|sign up|login|register)\\b|로그인|가입/i.test(label);
    });
    const loginRequired = /(^|\\/)(auth|login)(\\/|$)/i.test(location.pathname) || loginFields || loginActions;
    const challengeSelector = 'iframe[src*="captcha" i],iframe[title*="challenge" i],[data-testid*="captcha" i],[data-testid*="challenge" i]';
    const challenge = [...document.querySelectorAll(challengeSelector)].some(visible) || [...document.querySelectorAll('[aria-label],[title]')].filter(visible)
      .some(element => /captcha|verify you are human|security check|사람인지 확인/i.test((element.getAttribute('aria-label') || '') + ' ' + (element.getAttribute('title') || '')));
    const latestAssistant = assistants.length ? assistants[assistants.length - 1] : null;
    const main = document.querySelector('main');
    const assistantText = ${includeAssistantText ? "latestAssistant ? String(latestAssistant.innerText || latestAssistant.textContent || '').trim() : ''" : "''"};
    return {
      host: location.hostname.toLowerCase(), pathname: location.pathname,
      loginRequired, challenge,
      composerCount: composerSet.values.length,
      composerEmpty: Boolean(composer && !composerText(composer).trim()),
      composerMatchesExpected: Boolean(composer && normalize(composerText(composer)) === normalize(expected)),
      sendButtonCount: sendButtons.length,
      sendButtonEnabled: sendButtons.length === 1 && !sendButtons[0].disabled,
      userCount: users.length,
      latestUserMatchesExpected: Boolean(users.length && normalize(lastUserText) === normalize(expected)),
      assistantCount: assistants.length,
      assistantText,
      generating: stopButtons.length > 0 || Boolean(main && main.getAttribute('aria-busy') === 'true')
    };
  })()`;
}

function focusComposerScript(expectedPath = '') {
  const expected = JSON.stringify(String(expectedPath));
  return `/* dino-chatgpt-auto:focus */ (() => {
    if (!['chatgpt.com','www.chatgpt.com','chat.openai.com'].includes(location.hostname.toLowerCase())) return false;
    const expectedPath = ${expected};
    if (expectedPath && location.pathname !== expectedPath) return false;
    const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
    let candidates = [];
    for (const selector of ['#prompt-textarea','[data-testid="composer"] textarea','main textarea','main [role="textbox"][contenteditable="true"]','main [contenteditable="true"]']) {
      candidates = [...document.querySelectorAll(selector)].filter(visible);
      if (candidates.length) break;
    }
    if (candidates.length !== 1 || candidates[0].disabled || candidates[0].getAttribute('aria-disabled') === 'true') return false;
    candidates[0].focus(); candidates[0].scrollIntoView({ block: 'nearest' }); return document.activeElement === candidates[0];
  })()`;
}

function clickSendScript(expectedPrompt, expectedPath = '') {
  const expected = JSON.stringify(String(expectedPrompt));
  const expectedRoute = JSON.stringify(String(expectedPath));
  return `/* dino-chatgpt-auto:send */ (() => {
    if (!['chatgpt.com','www.chatgpt.com','chat.openai.com'].includes(location.hostname.toLowerCase())) return false;
    const expectedPath = ${expectedRoute};
    if (expectedPath && location.pathname !== expectedPath) return false;
    if (/(^|\\/)(auth|login)(\\/|$)/i.test(location.pathname)) return false;
    const loginActions = [...document.querySelectorAll('a,button,[role="button"]')].filter(element => element.getClientRects().length)
      .some(element => /\\b(log in|sign in|sign up|login|register)\\b|로그인|가입/i.test([element.getAttribute('aria-label'),element.getAttribute('title'),element.getAttribute('data-testid'),element.innerText].filter(Boolean).join(' ')));
    if (loginActions) return false;
    if ([...document.querySelectorAll('input[type="email"],input[type="password"],[autocomplete="username"]')].some(element => element.getClientRects().length)) return false;
    const challengeSelector = 'iframe[src*="captcha" i],iframe[title*="challenge" i],[data-testid*="captcha" i],[data-testid*="challenge" i]';
    if ([...document.querySelectorAll(challengeSelector)].some(element => element.getClientRects().length) || [...document.querySelectorAll('[aria-label],[title]')].filter(element => element.getClientRects().length).some(element => /captcha|verify you are human|security check|사람인지 확인/i.test((element.getAttribute('aria-label') || '') + ' ' + (element.getAttribute('title') || '')))) return false;
    const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
    const selectors = ['#prompt-textarea','[data-testid="composer"] textarea','main textarea','main [role="textbox"][contenteditable="true"]','main [contenteditable="true"]'];
    let composers = [];
    for (const selector of selectors) { composers = [...document.querySelectorAll(selector)].filter(visible); if (composers.length) break; }
    const composer = composers.length === 1 ? composers[0] : null;
    const value = composer ? ('value' in composer ? composer.value : composer.innerText || composer.textContent || '') : '';
    const normalize = text => String(text || '').replace(/\\u00a0/g, ' ').replace(/\\r/g, '').replace(/[ \\t]+\\n/g, '\\n').trim();
    if (!composer || normalize(value) !== normalize(${expected}) || composer.disabled || composer.getAttribute('aria-disabled') === 'true') return false;
    const stopButtons = [...document.querySelectorAll('button')].filter(visible).filter(button => /stop-button|stop generating|응답 중지/i.test([button.getAttribute('aria-label'),button.getAttribute('data-testid'),button.getAttribute('title')].filter(Boolean).join(' ')));
    if (stopButtons.length || document.querySelector('main')?.getAttribute('aria-busy') === 'true') return false;
    const buttons = [...document.querySelectorAll('button')].filter(visible).filter(button => {
      const label = [button.getAttribute('aria-label'),button.getAttribute('data-testid'),button.getAttribute('title')].filter(Boolean).join(' ');
      return /send-button/i.test(label) || /^(send|전송|메시지 보내기)$/i.test(label.trim());
    });
    if (buttons.length !== 1 || buttons[0].disabled) return false;
    buttons[0].click(); return true;
  })()`;
}

function clearComposerScript(expectedPrompt, expectedPath = '') {
  const expected = JSON.stringify(String(expectedPrompt));
  const expectedRoute = JSON.stringify(String(expectedPath));
  return `/* dino-chatgpt-auto:clear */ (() => {
    if (!['chatgpt.com','www.chatgpt.com','chat.openai.com'].includes(location.hostname.toLowerCase())) return false;
    const expectedPath = ${expectedRoute};
    if (expectedPath && location.pathname !== expectedPath) return false;
    const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
    let composers = [];
    for (const selector of ['#prompt-textarea','[data-testid="composer"] textarea','main textarea','main [role="textbox"][contenteditable="true"]','main [contenteditable="true"]']) {
      composers = [...document.querySelectorAll(selector)].filter(visible); if (composers.length) break;
    }
    if (composers.length !== 1) return false;
    const element = composers[0], value = 'value' in element ? element.value : element.innerText || element.textContent || '';
    const normalize = text => String(text || '').replace(/\\u00a0/g, ' ').replace(/\\r/g, '').replace(/[ \\t]+\\n/g, '\\n').trim();
    if (normalize(value) !== normalize(${expected})) return false;
    if ('value' in element) element.value = ''; else element.textContent = '';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
    return true;
  })()`;
}

function clickStopScript(expectedPath = '') {
  const expected = JSON.stringify(String(expectedPath));
  return `/* dino-chatgpt-auto:stop */ (() => {
    if (!['chatgpt.com','www.chatgpt.com','chat.openai.com'].includes(location.hostname.toLowerCase())) return false;
    const expectedPath = ${expected};
    if (expectedPath && location.pathname !== expectedPath) return false;
    const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
    const buttons = [...document.querySelectorAll('button')].filter(visible).filter(button => {
      const label = [button.getAttribute('aria-label'),button.getAttribute('data-testid'),button.getAttribute('title')].filter(Boolean).join(' ');
      return /stop-button/i.test(label) || /stop generating|생성 중지|응답 중지/i.test(label);
    });
    if (buttons.length !== 1) return false;
    buttons[0].click(); return true;
  })()`;
}

function createWebAutoTranslation({
  getWindow,
  allowedHosts = CHATGPT_HOSTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_MS,
  stableMs = DEFAULT_STABLE_MS,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (typeof getWindow !== 'function') throw new TypeError('내장 ChatGPT 창 조회 함수가 필요합니다.');
  let active = null, last = null;

  async function withTimeout(promise, timeout, message) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure('CHATGPT_PAGE_TIMEOUT', message)), timeout); })
      ]);
    } finally { clearTimeout(timer); }
  }

  async function evaluate(webContents, script, timeout = 5000) {
    return withTimeout(webContents.executeJavaScript(script, true), timeout, 'ChatGPT 화면 확인 시간이 초과되었습니다.');
  }

  function busy() { return Boolean(active); }
  function status() {
    return active
      ? { busy: true, jobKey: active.jobKey, batchIndex: active.batchIndex, phase: active.phase, sent: active.sent, startedAt: active.startedAt }
      : { busy: false, ...(last || {}) };
  }

  async function cancel(jobKey) {
    if (!active || jobKey && active.jobKey !== jobKey) {
      const previous = last && (!jobKey || last.jobKey === jobKey) ? last : null;
      return { cancelled: false, sent: Boolean(previous?.sent), stopRequested: Boolean(previous?.stopRequested), settled: true, phase: previous?.phase || null };
    }
    const job = active;
    job.cancelled = true;
    let stopRequested = false;
    if (job.sent) {
      try { stopRequested = Boolean(await evaluate(job.window.webContents, clickStopScript(job.conversationPath), 3000)); } catch {}
    }
    job.stopRequested = stopRequested;
    job.phase = 'cancelled';
    await job.finished;
    return { cancelled: true, sent: job.sent, stopRequested, settled: true };
  }

  async function run(rawInput) {
    const input = validateJob(rawInput);
    if (active) throw failure('WEB_TRANSLATION_BUSY', '이미 다른 ChatGPT 웹 번역 작업이 실행 중입니다.');
    const win = getWindow();
    if (!win || win.isDestroyed?.() || !win.webContents || win.webContents.isDestroyed?.())
      throw failure('CHATGPT_WINDOW_CLOSED', '내장 ChatGPT 창을 열지 못했습니다. 창을 열고 다시 시도해 주세요.');
    const webContents = win.webContents;
    let finishJob;
    const finished = new Promise(resolve => { finishJob = resolve; });
    const job = active = {
      jobKey: input.jobKey, batchIndex: input.batchIndex, window: win, phase: 'checking-page',
      sent: false, cancelled: false, startedAt: now(), conversationPath: null,
      finished, finish: finishJob
    };
    let outcome = 'failed';
    try {
      let initial;
      try { initial = await evaluate(webContents, inspectScript('', false)); }
      catch { throw failure('CHATGPT_PAGE_UNAVAILABLE', '내장 ChatGPT 화면을 읽지 못했습니다. 화면을 새로 연 뒤 다시 시도해 주세요.'); }
      if (job.cancelled) throw failure('CANCELLED', 'ChatGPT 웹 번역을 중단했습니다.', false);
      if (!allowedHosts.has(initial?.host)) throw failure('CHATGPT_HOST_UNSUPPORTED', '현재 내장 창이 ChatGPT가 아닙니다. ChatGPT 화면을 열고 다시 시도해 주세요.');
      if (initial?.challenge) throw failure('CHATGPT_CHALLENGE', '접근 확인 화면이 표시되어 자동 전송을 중단했습니다. 화면에서 직접 처리한 뒤 다시 시작해 주세요.');
      if (initial?.loginRequired) throw failure('CHATGPT_LOGIN_REQUIRED', '내장 ChatGPT 로그인이 필요합니다. 로그인은 화면에서 직접 완료해 주세요.');
      if (initial?.composerCount === 0) throw failure('CHATGPT_UI_UNSUPPORTED', '내장 ChatGPT 화면에서 번역 입력창을 찾지 못해 전송하지 않았습니다. 로그인 여부와 화면 상태를 직접 확인해 주세요.');
      if (initial?.composerCount !== 1 || !initial.composerEmpty || initial.generating)
        throw failure('CHATGPT_UI_UNSUPPORTED', 'ChatGPT 화면 구조가 예상과 달라 전송하지 않았습니다. 입력 내용을 지우거나 다른 버튼을 누르지 않았습니다.');
      job.conversationPath = initial.pathname || '/';
      const baseline = { users: Number(initial.userCount) || 0, assistants: Number(initial.assistantCount) || 0 };

      job.phase = 'preparing-input';
      const focused = await evaluate(webContents, focusComposerScript(job.conversationPath));
      if (!focused || job.cancelled) throw failure(job.cancelled ? 'CANCELLED' : 'CHATGPT_COMPOSER_FOCUS_FAILED', job.cancelled ? 'ChatGPT 웹 번역을 중단했습니다.' : 'ChatGPT 번역 입력창에 안전하게 초점을 맞추지 못했습니다.', false);
      try { await withTimeout(webContents.insertText(input.prompt), 10_000, 'ChatGPT 입력창에 요청을 준비하는 시간이 초과되었습니다.'); }
      catch (error) { throw failure('CHATGPT_INPUT_FAILED', 'ChatGPT 입력창에 요청을 준비하지 못했습니다. 전송하지 않았습니다.', false); }
      const prepared = await evaluate(webContents, inspectScript(input.prompt, false));
      if (!prepared || !allowedHosts.has(prepared.host) || prepared.challenge || prepared.loginRequired || prepared.pathname !== job.conversationPath ||
          prepared.composerCount !== 1 || !prepared.composerMatchesExpected || prepared.sendButtonCount !== 1 || !prepared.sendButtonEnabled) {
         try { await evaluate(webContents, clearComposerScript(input.prompt, job.conversationPath), 3000); } catch {}
        throw failure(prepared?.challenge ? 'CHATGPT_CHALLENGE' : 'CHATGPT_PROMPT_NOT_VERIFIED', '번역 요청 전체가 입력된 것을 확인하지 못해 전송하지 않았습니다. 입력창 상태를 확인해 주세요.', false);
      }
      if (job.cancelled) throw failure('CANCELLED', 'ChatGPT 웹 번역을 중단했습니다.', false);

      job.phase = 'sending';
      let clicked;
       try { clicked = await evaluate(webContents, clickSendScript(input.prompt, job.conversationPath), 5000); }
      catch { job.sent = true; throw failure('CHATGPT_SEND_UNCERTAIN', '전송 버튼 처리 결과를 확인할 수 없습니다. 새 요청을 자동으로 재전송하지 않았습니다.', true); }
      if (!clicked) throw failure('CHATGPT_SEND_NOT_CONFIRMED', '전송 버튼을 하나로 확인하지 못해 요청을 보내지 않았습니다.', false);
      job.sent = true;
      job.phase = 'waiting-response';
      const deadline = now() + Math.max(1000, Math.min(600_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
      let seenUser = false, responseText = '', stableSince = 0, acceptedPath = job.conversationPath;
      while (now() < deadline) {
        if (job.cancelled) throw failure('CANCELLED', 'ChatGPT 응답 대기를 중단했습니다. 진행 중인 요청은 웹에 남아 있을 수 있습니다.', true);
        if (win.isDestroyed?.() || webContents.isDestroyed?.()) throw failure('CHATGPT_WINDOW_CLOSED', '응답을 기다리는 동안 내장 ChatGPT 창이 닫혔습니다. 전송 여부를 확인해 주세요.', true);
        let state;
        try { state = await evaluate(webContents, inspectScript(input.prompt, true)); }
        catch { throw failure('CHATGPT_PAGE_UNAVAILABLE', '응답을 기다리는 동안 ChatGPT 화면을 읽지 못했습니다. 재전송 전에 대화를 확인해 주세요.', true); }
        if (state?.challenge) throw failure('CHATGPT_CHALLENGE', '응답 대기 중 접근 확인 화면이 나타났습니다. 자동 처리를 중단했습니다.', true);
        if (state?.loginRequired) throw failure('CHATGPT_LOGIN_REQUIRED', '응답 대기 중 로그인 화면이 나타나 자동 처리를 중단했습니다. 로그인은 직접 완료해 주세요.', true);
        if (!allowedHosts.has(state?.host)) throw failure('CHATGPT_HOST_CHANGED', '응답 대기 중 페이지가 ChatGPT를 벗어나 자동 처리를 중단했습니다.', true);
        const pathname = state.pathname || '/';
         if (acceptedPath === '/' && /^\/(?:c|g)\//.test(pathname)) { acceptedPath = pathname; job.conversationPath = pathname; }
        else if (pathname !== acceptedPath) throw failure('CHATGPT_CONVERSATION_CHANGED', '응답 대기 중 다른 ChatGPT 대화로 이동해 결과를 가져오지 않았습니다.', true);
        if (Number(state.userCount) > baseline.users) {
          if (!state.latestUserMatchesExpected) throw failure('CHATGPT_REQUEST_MISMATCH', '최근 사용자 메시지가 이번 자막 요청과 일치하지 않아 응답을 가져오지 않았습니다.', true);
          seenUser = true;
        }
        if (Number(state.userCount) > baseline.users + 1) throw failure('CHATGPT_CONVERSATION_CHANGED', '전송 후 대화에 다른 사용자 메시지가 추가되어 자동 처리를 중단했습니다.', true);
        if (seenUser && Number(state.assistantCount) > baseline.assistants) {
          const candidate = String(state.assistantText || '').trim();
          if (candidate.length > MAX_RESPONSE) throw failure('CHATGPT_RESPONSE_TOO_LARGE', 'ChatGPT 응답이 크기 제한을 넘어 결과를 가져오지 않았습니다.', true);
          if (candidate && !state.generating) {
            if (candidate === responseText) {
              if (now() - stableSince >= Math.max(500, Number(stableMs) || DEFAULT_STABLE_MS)) {
                outcome = 'completed'; job.phase = 'completed';
                return { ok: true, jobKey: input.jobKey, batchIndex: input.batchIndex, response: candidate, sent: true };
              }
            } else { responseText = candidate; stableSince = now(); job.phase = 'checking-response-stability'; }
          } else { responseText = candidate; stableSince = 0; job.phase = 'waiting-response'; }
        }
        await sleep(Math.max(100, Math.min(5000, Number(pollIntervalMs) || DEFAULT_POLL_MS)));
      }
      throw failure('CHATGPT_RESPONSE_TIMEOUT', 'ChatGPT 응답 시간 초과입니다. 묶음은 이미 전송되었을 수 있으므로 웹 대화를 확인하기 전에는 재전송하지 마세요.', true);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (!normalized.code) normalized.code = 'CHATGPT_WEB_FAILED';
      normalized.sent = Boolean(normalized.sent || job.sent);
      throw normalized;
    } finally {
      last = { jobKey: job.jobKey, batchIndex: job.batchIndex, phase: job.phase, sent: job.sent, stopRequested: Boolean(job.stopRequested), outcome, finishedAt: now() };
      if (active === job) active = null;
      job.finish();
    }
  }

  return Object.freeze({ run, cancel, busy, status });
}

module.exports = {
  MAX_PROMPT, MAX_RESPONSE, DEFAULT_TIMEOUT_MS, CHATGPT_HOSTS,
  validateJob, inspectScript, focusComposerScript, clickSendScript, clearComposerScript, clickStopScript,
  createWebAutoTranslation
};
