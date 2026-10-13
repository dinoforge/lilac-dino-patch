'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_PROMPT = 120_000;
const MAX_RESPONSE = 2_000_000;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_MS = 700;
const DEFAULT_STABLE_MS = 1_800;
const CHATGPT_HOSTS = new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']);
const MAX_SUBTITLE_FILE_BYTES = 12_000_000;

function failure(code, message, sent = false, attached = false) {
  const error = new Error(message);
  error.code = code;
  error.sent = sent;
  error.attached = attached;
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

function validateFileJob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('INVALID_REQUEST', '전체 자막 파일 요청 형식이 올바르지 않습니다.');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > MAX_PROMPT)
    throw failure('INVALID_REQUEST', '번역 지침이 비어 있거나 크기 제한을 넘었습니다.');
  if (typeof input.jobKey !== 'string' || !/^[a-zA-Z0-9_-]{8,96}$/.test(input.jobKey))
    throw failure('INVALID_REQUEST', '번역 작업 식별자가 올바르지 않습니다.');
  if (input.fileName !== 'subtitle-to-translate.srt' || typeof input.filePath !== 'string' || !path.isAbsolute(input.filePath) ||
      path.extname(input.filePath).toLowerCase() !== '.srt' || typeof input.tempDir !== 'string' || !path.isAbsolute(input.tempDir))
    throw failure('INVALID_REQUEST', '첨부할 전체 SRT 파일 경로가 올바르지 않습니다.');
  let stat;
  try { stat = fs.statSync(input.filePath); }
  catch { throw failure('INVALID_REQUEST', '첨부할 전체 SRT 파일을 찾지 못했습니다.'); }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SUBTITLE_FILE_BYTES)
    throw failure('INVALID_REQUEST', '첨부할 전체 SRT 파일이 비어 있거나 크기 제한을 넘었습니다.');
  return { jobKey: input.jobKey, prompt: input.prompt, fileName: input.fileName, filePath: input.filePath, fileBytes: stat.size, tempDir: input.tempDir };
}

function inspectScript(expectedPrompt = '', includeAssistantText = false, expectedFileName = '', expectedFileBytes = 0, inspectResultFiles = includeAssistantText) {
  const expected = JSON.stringify(String(expectedPrompt));
  const expectedName = JSON.stringify(String(expectedFileName));
  const expectedBytes = Math.max(0, Number(expectedFileBytes) || 0);
  return `/* dino-chatgpt-auto:inspect */ (() => {
    const expected = ${expected};
    const expectedFileName = ${expectedName};
    const expectedFileBytes = ${expectedBytes};
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
    const lastUser = users.length ? users[users.length - 1] : null;
    const lastUserText = lastUser ? composerText(lastUser) : '';
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
    const composerRoot = composer ? (composer.closest('form') || composer.closest('[data-testid="composer"]') || composer.parentElement?.parentElement?.parentElement || main) : main;
    const selectedFiles = [...document.querySelectorAll('input[type="file"]')].flatMap(input => [...(input.files || [])]);
    const attachmentMarkers = composerRoot ? [...composerRoot.querySelectorAll('[data-testid*="file" i],[data-testid*="attachment" i],[aria-label*="remove file" i],[aria-label*="remove attachment" i]')].filter(visible) : [];
    const composerTextValue = composerRoot ? String(composerRoot.innerText || composerRoot.textContent || '') : '';
    const uploadBusy = Boolean(composerRoot && [...composerRoot.querySelectorAll('[role="progressbar"],[aria-busy="true"],[data-testid*="uploading" i],[data-testid*="upload-progress" i]')].some(visible));
    const fileInputMatches = selectedFiles.length === 1 && selectedFiles[0].name === expectedFileName && Number(selectedFiles[0].size) === expectedFileBytes;
    const resultFileCandidates = ${inspectResultFiles ? `latestAssistant ? [...latestAssistant.querySelectorAll('a[href]')].filter(visible).map(anchor => {
      const href = String(anchor.href || anchor.getAttribute('href') || '');
      const download = String(anchor.getAttribute('download') || '');
      const label = [anchor.innerText, anchor.textContent, anchor.getAttribute('aria-label'), anchor.getAttribute('title'), download,
        anchor.parentElement?.innerText, anchor.parentElement?.textContent].filter(Boolean).join(' ');
      const match = label.match(/[A-Za-z0-9._ -]+\\.srt\\b/i) || href.match(/[A-Za-z0-9._-]+\\.srt\\b/i);
      return { href, fileName: match ? match[0].trim() : '', label: label.slice(0, 500) };
    }).filter(item => item.fileName && item.href) : []` : '[]'};
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
      latestUserHasFileName: Boolean(lastUser && expectedFileName && (lastUser.innerText || lastUser.textContent || '').includes(expectedFileName)),
      assistantCount: assistants.length,
      assistantText,
      selectedFileCount: selectedFiles.length,
      expectedFileInputMatches: Boolean(expectedFileName && fileInputMatches),
      composerFileNameVisible: Boolean(expectedFileName && composerTextValue.includes(expectedFileName)),
      composerHasAttachmentMarker: attachmentMarkers.length > 0,
      uploadBusy,
      resultFileCount: resultFileCandidates.length,
      resultFileName: resultFileCandidates.length === 1 ? resultFileCandidates[0].fileName : '',
      resultFileHref: resultFileCandidates.length === 1 ? resultFileCandidates[0].href : '',
      generating: stopButtons.length > 0 || Boolean(main && main.getAttribute('aria-busy') === 'true')
    };
  })()`;
}

function clickAttachButtonScript(expectedPath = '') {
  const expected = JSON.stringify(String(expectedPath));
  return `/* dino-chatgpt-auto:attach-button */ (() => {
    if (!['chatgpt.com','www.chatgpt.com','chat.openai.com'].includes(location.hostname.toLowerCase())) return false;
    const expectedPath = ${expected}; if (expectedPath && location.pathname !== expectedPath) return false;
    const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
    const composers = [...document.querySelectorAll('#prompt-textarea,[data-testid="composer"] textarea,main textarea,main [role="textbox"][contenteditable="true"],main [contenteditable="true"]')].filter(visible);
    if (composers.length !== 1) return false;
    const composer = composers[0], value = 'value' in composer ? composer.value : composer.innerText || composer.textContent || '';
    if (String(value || '').trim()) return false;
    const root = composer.closest('form') || composer.closest('[data-testid="composer"]') || composer.parentElement?.parentElement?.parentElement || document.querySelector('main');
    const buttons = [...(root?.querySelectorAll('button') || [])].filter(visible).filter(button => {
      const label = [button.getAttribute('aria-label'),button.getAttribute('data-testid'),button.getAttribute('title')].filter(Boolean).join(' ');
      return /composer-plus-btn|add files and more|attach (?:a )?file|upload file|파일 (?:첨부|추가)/i.test(label);
    });
    if (buttons.length !== 1 || buttons[0].disabled) return false;
    buttons[0].click(); return true;
  })()`;
}

async function findFileInputs(debuggerClient) {
  const document = await debuggerClient.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
  if (!Number.isInteger(document?.root?.nodeId)) throw failure('CHATGPT_FILE_INPUT_UNAVAILABLE', 'ChatGPT 파일 선택 입력을 찾지 못했습니다.');
  const found = await debuggerClient.sendCommand('DOM.querySelectorAll', { nodeId: document.root.nodeId, selector: 'input[type="file"]' });
  const inputs = [];
  for (const nodeId of found?.nodeIds || []) {
    const described = await debuggerClient.sendCommand('DOM.describeNode', { nodeId });
    const attributes = described?.node?.attributes || [];
    const values = Object.create(null);
    for (let index = 0; index + 1 < attributes.length; index += 2) values[String(attributes[index]).toLowerCase()] = String(attributes[index + 1]);
    inputs.push({ nodeId, accept: values.accept || '' });
  }
  return inputs;
}

function safeResultFileUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return CHATGPT_HOSTS.has(host) || host.endsWith('.openai.com') || host === 'oaiusercontent.com' || host.endsWith('.oaiusercontent.com');
}

function waitForDownload(webContents, url, targetPath, job, timeoutMs = 60_000) {
  const session = webContents.session;
  if (!session?.on || !session?.removeListener || typeof webContents.downloadURL !== 'function')
    return Promise.reject(failure('CHATGPT_RESULT_DOWNLOAD_UNAVAILABLE', '내장 ChatGPT의 완성 자막 파일을 내려받는 기능을 사용할 수 없습니다.', true, true));
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); session.removeListener('will-download', onWillDownload);
      if (job.downloadItem) job.downloadItem = null;
      error ? reject(error) : resolve(value);
    };
    const onWillDownload = (event, item, owner) => {
      if (owner !== webContents) return;
      let itemUrl = '';
      try { itemUrl = new URL(String(item.getURL())).href; } catch {}
      let expectedUrl = '';
      try { expectedUrl = new URL(url).href; } catch {}
      if (!itemUrl || itemUrl !== expectedUrl) return;
      job.downloadItem = item;
      try { item.setSavePath(targetPath); }
      catch { try { item.cancel(); } catch {} finish(failure('CHATGPT_RESULT_DOWNLOAD_FAILED', 'ChatGPT 완성 자막 파일을 저장할 위치를 준비하지 못했습니다.', true, true)); return; }
      item.once('done', (_, state) => {
        if (state !== 'completed') { finish(failure('CHATGPT_RESULT_DOWNLOAD_FAILED', 'ChatGPT 완성 자막 파일 내려받기에 실패했습니다.', true, true)); return; }
        finish(null, { path: targetPath, fileName: String(item.getFilename() || '') });
      });
    };
    session.on('will-download', onWillDownload);
    timer = setTimeout(() => {
      try { job.downloadItem?.cancel(); } catch {}
      finish(failure('CHATGPT_RESULT_DOWNLOAD_TIMEOUT', 'ChatGPT 완성 자막 파일을 제한 시간 안에 내려받지 못했습니다. 다시 전송하지 않았습니다.', true, true));
    }, Math.max(1000, timeoutMs));
    try { webContents.downloadURL(url); }
    catch { finish(failure('CHATGPT_RESULT_DOWNLOAD_FAILED', 'ChatGPT 완성 자막 파일 다운로드를 시작하지 못했습니다.', true, true)); }
  });
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

function clickSendScript(expectedPrompt, expectedPath = '', expectedFileName = '', expectedFileBytes = 0) {
  const expected = JSON.stringify(String(expectedPrompt));
  const expectedRoute = JSON.stringify(String(expectedPath));
  const expectedName = JSON.stringify(String(expectedFileName));
  const expectedBytes = Math.max(0, Number(expectedFileBytes) || 0);
  return `/* dino-chatgpt-auto:send */ (() => {
    if (!['chatgpt.com','www.chatgpt.com','chat.openai.com'].includes(location.hostname.toLowerCase())) return false;
    const expectedPath = ${expectedRoute};
    const expectedFileName = ${expectedName};
    const expectedFileBytes = ${expectedBytes};
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
    if (expectedFileName) {
      const selected = [...document.querySelectorAll('input[type="file"]')].flatMap(input => [...(input.files || [])]);
      const root = composer.closest('form') || composer.closest('[data-testid="composer"]') || composer.parentElement?.parentElement?.parentElement || document.querySelector('main');
      const rootText = String(root?.innerText || root?.textContent || '');
      const attachmentMarkers = root ? [...root.querySelectorAll('[data-testid*="file" i],[data-testid*="attachment" i],[aria-label*="remove file" i],[aria-label*="remove attachment" i]')].filter(element => element.getClientRects().length) : [];
      const uploadBusy = Boolean(root && [...root.querySelectorAll('[role="progressbar"],[aria-busy="true"],[data-testid*="uploading" i],[data-testid*="upload-progress" i]')].some(element => element.getClientRects().length));
      const selectedFileMatches = selected.length === 1 && selected[0].name === expectedFileName && Number(selected[0].size) === expectedFileBytes;
      const visibleAttachmentMatches = rootText.includes(expectedFileName) && attachmentMarkers.length > 0;
      if ((!selectedFileMatches && !visibleAttachmentMatches) || !rootText.includes(expectedFileName) || uploadBusy) return false;
    }
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
      ? { busy: true, jobKey: active.jobKey, batchIndex: active.batchIndex, phase: active.phase, sent: active.sent, startedAt: active.startedAt,
          ...(active.fileMode ? { fileMode: true, attached: active.attached } : {}) }
      : { busy: false, ...(last || {}) };
  }

  async function cancel(jobKey) {
    if (!active || jobKey && active.jobKey !== jobKey) {
      const previous = last && (!jobKey || last.jobKey === jobKey) ? last : null;
      return { cancelled: false, sent: Boolean(previous?.sent), stopRequested: Boolean(previous?.stopRequested), settled: true, phase: previous?.phase || null,
        ...(previous?.fileMode ? { attached: Boolean(previous.attached) } : {}) };
    }
    const job = active;
    job.cancelled = true;
    let stopRequested = false;
    if (job.sent) {
      try { stopRequested = Boolean(await evaluate(job.window.webContents, clickStopScript(job.conversationPath), 3000)); } catch {}
    }
    if (job.downloadItem) try { job.downloadItem.cancel(); } catch {}
    job.stopRequested = stopRequested;
    job.phase = 'cancelled';
    await job.finished;
    return { cancelled: true, sent: job.sent, stopRequested, settled: true, ...(job.fileMode ? { attached: Boolean(job.attached) } : {}) };
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

  async function runFile(rawInput) {
    const input = validateFileJob(rawInput);
    if (active) throw failure('WEB_TRANSLATION_BUSY', '이미 다른 ChatGPT 웹 번역 작업이 실행 중입니다.');
    const win = getWindow();
    if (!win || win.isDestroyed?.() || !win.webContents || win.webContents.isDestroyed?.())
      throw failure('CHATGPT_WINDOW_CLOSED', '로그인한 내장 ChatGPT 창을 찾지 못했습니다. 창을 열고 로그인 상태를 확인해 주세요.');
    const webContents = win.webContents;
    let finishJob;
    const finished = new Promise(resolve => { finishJob = resolve; });
    const job = active = {
      jobKey: input.jobKey, batchIndex: 0, window: win, phase: 'checking-page', fileMode: true,
      sent: false, attached: false, cancelled: false, startedAt: now(), conversationPath: null,
      downloadItem: null, finished, finish: finishJob
    };
    let outcome = 'failed';
    try {
      let initial;
      try { initial = await evaluate(webContents, inspectScript('', false)); }
      catch { throw failure('CHATGPT_PAGE_UNAVAILABLE', '내장 ChatGPT 화면을 읽지 못했습니다. 화면을 새로 연 뒤 다시 시도해 주세요.'); }
      if (job.cancelled) throw failure('CANCELLED', 'ChatGPT 웹 번역을 중단했습니다.');
      if (!allowedHosts.has(initial?.host)) throw failure('CHATGPT_HOST_UNSUPPORTED', '현재 내장 창이 ChatGPT가 아닙니다. 파일을 전송하지 않았습니다.');
      if (initial?.challenge) throw failure('CHATGPT_CHALLENGE', '접근 확인 화면이 표시되어 파일을 전송하지 않았습니다. 화면에서 직접 처리해 주세요.');
      if (initial?.loginRequired) throw failure('CHATGPT_LOGIN_REQUIRED', '내장 ChatGPT 로그인이 필요합니다. 로그인은 화면에서 직접 완료해 주세요.');
      if (initial?.composerCount !== 1 || !initial.composerEmpty || initial.generating)
        throw failure('CHATGPT_UI_UNSUPPORTED', 'ChatGPT 입력창이 비어 있지 않거나 화면 구조가 예상과 달라 파일을 첨부하지 않았습니다.');
      if (Number(initial.selectedFileCount) > 0 || initial.composerHasAttachmentMarker)
        throw failure('CHATGPT_COMPOSER_NOT_EMPTY', '현재 대화 입력창에 다른 파일이 이미 첨부되어 있습니다. 기존 첨부를 보존하고 중단했습니다.');
      job.conversationPath = initial.pathname || '/';
      const baseline = { users: Number(initial.userCount) || 0, assistants: Number(initial.assistantCount) || 0 };
      const debuggerClient = webContents.debugger;
      if (!debuggerClient?.sendCommand || typeof debuggerClient.attach !== 'function')
        throw failure('CHATGPT_FILE_UPLOAD_UNAVAILABLE', '내장 ChatGPT에 실제 파일을 첨부하는 Electron 기능을 사용할 수 없습니다.');
      let debuggerAttachedByUs = false;
      try {
        if (!debuggerClient.isAttached?.()) { debuggerClient.attach('1.3'); debuggerAttachedByUs = true; }
        await debuggerClient.sendCommand('DOM.enable');
        let inputs = await findFileInputs(debuggerClient);
        if (!inputs.length) {
          job.phase = 'opening-attachment-menu';
          const opened = await evaluate(webContents, clickAttachButtonScript(job.conversationPath));
          if (!opened) throw failure('CHATGPT_FILE_UPLOAD_UNAVAILABLE', 'ChatGPT 화면에서 파일 첨부 버튼을 하나로 확인하지 못했습니다. 파일을 선택하지 않았습니다.');
          await sleep(200);
          inputs = await findFileInputs(debuggerClient);
        }
        if (inputs.length !== 1) throw failure('CHATGPT_FILE_INPUT_AMBIGUOUS', 'ChatGPT 파일 입력을 하나로 확인하지 못했습니다. 파일을 첨부하지 않았습니다.');
        const accept = inputs[0].accept.trim().toLowerCase();
        if (accept && !/(^|[,\s])(?:\.srt|text\/plain|\*\/\*)(?=$|[,\s;])/i.test(accept))
          throw failure('CHATGPT_FILE_TYPE_UNSUPPORTED', 'ChatGPT 파일 선택기가 SRT 자막을 받지 않아 업로드를 중단했습니다.');
        if (job.cancelled) throw failure('CANCELLED', '파일 첨부 전에 번역을 중단했습니다.');
        job.phase = 'attaching-source-file';
        await debuggerClient.sendCommand('DOM.setFileInputFiles', { nodeId: inputs[0].nodeId, files: [input.filePath] });
        job.attached = true;
      } catch (error) {
        if (error?.code) throw error;
        throw failure('CHATGPT_FILE_UPLOAD_FAILED', '선택한 전체 SRT 파일을 ChatGPT 입력창에 첨부하지 못했습니다. 번역 지침은 보내지 않았습니다.', false, job.attached);
      } finally {
        if (debuggerAttachedByUs) try { debuggerClient.detach(); } catch {}
      }

      let attachmentConfirmed = false;
      const attachDeadline = now() + 45_000;
      while (now() < attachDeadline && !job.cancelled) {
        let state;
        try { state = await evaluate(webContents, inspectScript('', false, input.fileName, input.fileBytes)); }
        catch { throw failure('CHATGPT_FILE_ATTACHMENT_UNCONFIRMED', '파일 첨부 상태를 읽지 못해 번역 지침을 보내지 않았습니다.', false, true); }
        if (!allowedHosts.has(state?.host) || state.pathname !== job.conversationPath || state.loginRequired || state.challenge)
          throw failure(state?.loginRequired ? 'CHATGPT_LOGIN_REQUIRED' : 'CHATGPT_FILE_ATTACHMENT_UNCONFIRMED', '파일을 첨부하는 동안 ChatGPT 화면 상태가 바뀌어 번역 지침을 보내지 않았습니다.', false, true);
        if (Number(state.selectedFileCount) > 1) throw failure('CHATGPT_FILE_ATTACHMENT_AMBIGUOUS', '입력창에 파일이 하나보다 많이 선택되어 번역 지침을 보내지 않았습니다.', false, true);
        if ((state.expectedFileInputMatches || state.composerHasAttachmentMarker) && state.composerFileNameVisible && !state.uploadBusy) { attachmentConfirmed = true; break; }
        await sleep(Math.max(100, Math.min(1000, Number(pollIntervalMs) || DEFAULT_POLL_MS)));
      }
      if (job.cancelled) throw failure('CANCELLED', '파일 첨부 후 번역 지침 전송 전에 중단했습니다.', false, true);
      if (!attachmentConfirmed) throw failure('CHATGPT_FILE_ATTACHMENT_UNCONFIRMED', 'ChatGPT 입력창에서 전체 SRT 첨부 완료를 확인하지 못했습니다. 번역 지침은 보내지 않았습니다.', false, true);

      job.phase = 'preparing-instructions';
      const focused = await evaluate(webContents, focusComposerScript(job.conversationPath));
      if (!focused || job.cancelled) throw failure(job.cancelled ? 'CANCELLED' : 'CHATGPT_COMPOSER_FOCUS_FAILED', '번역 지침을 입력창에 안전하게 준비하지 못했습니다.', false, true);
      try { await withTimeout(webContents.insertText(input.prompt), 10_000, 'ChatGPT 입력창에 번역 지침을 준비하는 시간이 초과되었습니다.'); }
      catch { throw failure('CHATGPT_INPUT_FAILED', '번역 지침을 입력하지 못했습니다. 전송하지 않았습니다.', false, true); }
      const prepared = await evaluate(webContents, inspectScript(input.prompt, false, input.fileName, input.fileBytes));
      if (!prepared || !allowedHosts.has(prepared.host) || prepared.challenge || prepared.loginRequired || prepared.pathname !== job.conversationPath ||
          prepared.composerCount !== 1 || !prepared.composerMatchesExpected || prepared.sendButtonCount !== 1 || !prepared.sendButtonEnabled ||
          !prepared.expectedFileInputMatches || !prepared.composerFileNameVisible || prepared.uploadBusy) {
        try { await evaluate(webContents, clearComposerScript(input.prompt, job.conversationPath), 3000); } catch {}
        throw failure(prepared?.challenge ? 'CHATGPT_CHALLENGE' : 'CHATGPT_PROMPT_NOT_VERIFIED', '전체 파일 첨부와 번역 지침을 함께 확인하지 못해 전송하지 않았습니다.', false, true);
      }
      if (job.cancelled) throw failure('CANCELLED', '번역 지침 전송 전에 중단했습니다.', false, true);

      job.phase = 'sending-instructions';
      let clicked;
      try { clicked = await evaluate(webContents, clickSendScript(input.prompt, job.conversationPath, input.fileName, input.fileBytes), 5000); }
      catch { job.sent = true; throw failure('CHATGPT_SEND_UNCERTAIN', '전송 버튼 처리 결과를 확인할 수 없습니다. 같은 파일과 지침을 자동 재전송하지 않았습니다.', true, true); }
      if (!clicked) throw failure('CHATGPT_SEND_NOT_CONFIRMED', '첨부 파일과 전송 버튼을 함께 확인하지 못해 지침을 보내지 않았습니다.', false, true);
      job.sent = true;
      job.phase = 'waiting-full-file-response';
      const deadline = now() + Math.max(1000, Math.min(600_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
      let seenUser = false, previousFileSignature = '', stableSince = 0, acceptedPath = job.conversationPath;
      while (now() < deadline) {
        if (job.cancelled) throw failure('CANCELLED', 'ChatGPT 완성 자막 파일 대기를 중단했습니다. 요청은 웹에 남아 있을 수 있습니다.', true, true);
        if (win.isDestroyed?.() || webContents.isDestroyed?.()) throw failure('CHATGPT_WINDOW_CLOSED', '완성 자막 파일을 기다리는 동안 내장 ChatGPT 창이 닫혔습니다. 재전송 전에 대화를 확인해 주세요.', true, true);
        let state;
        try { state = await evaluate(webContents, inspectScript(input.prompt, false, input.fileName, input.fileBytes, true)); }
        catch { throw failure('CHATGPT_PAGE_UNAVAILABLE', '응답을 기다리는 동안 ChatGPT 화면을 읽지 못했습니다. 재전송 전에 대화를 확인해 주세요.', true, true); }
        if (state?.challenge) throw failure('CHATGPT_CHALLENGE', '응답 대기 중 접근 확인 화면이 표시되어 자동 처리를 중단했습니다.', true, true);
        if (state?.loginRequired) throw failure('CHATGPT_LOGIN_REQUIRED', '응답 대기 중 로그인 화면이 나타나 자동 처리를 중단했습니다.', true, true);
        if (!allowedHosts.has(state?.host)) throw failure('CHATGPT_HOST_CHANGED', '응답 대기 중 ChatGPT 화면을 벗어나 결과를 가져오지 않았습니다.', true, true);
        const pathname = state.pathname || '/';
        if (acceptedPath === '/' && /^\/(?:c|g)\//.test(pathname)) { acceptedPath = pathname; job.conversationPath = pathname; }
        else if (pathname !== acceptedPath) throw failure('CHATGPT_CONVERSATION_CHANGED', '응답 대기 중 다른 ChatGPT 대화로 이동해 결과 파일을 가져오지 않았습니다.', true, true);
        if (Number(state.userCount) > baseline.users) {
          if (!state.latestUserMatchesExpected || !state.latestUserHasFileName)
            throw failure('CHATGPT_REQUEST_MISMATCH', '전송된 메시지에서 이번 지침과 첨부 파일을 확인하지 못했습니다. 중복 전송하지 않았습니다.', true, true);
          seenUser = true;
        }
        if (Number(state.userCount) > baseline.users + 1) throw failure('CHATGPT_CONVERSATION_CHANGED', '전송 후 대화에 다른 사용자 메시지가 추가되어 결과 수집을 중단했습니다.', true, true);
        if (seenUser && Number(state.assistantCount) > baseline.assistants && !state.generating) {
          if (Number(state.resultFileCount) > 1) throw failure('CHATGPT_RESULT_FILE_AMBIGUOUS', '새 ChatGPT 응답에 SRT 파일이 여러 개 있어 임의로 선택하지 않았습니다.', true, true);
          if (Number(state.resultFileCount) === 1 && state.resultFileName && state.resultFileHref) {
            const signature = `${state.resultFileName}\0${state.resultFileHref}`;
            if (signature === previousFileSignature) {
              if (now() - stableSince >= Math.max(500, Number(stableMs) || DEFAULT_STABLE_MS)) {
                if (!/\.srt$/i.test(state.resultFileName)) throw failure('CHATGPT_RESULT_FILE_TYPE_UNSUPPORTED', 'ChatGPT 응답 파일이 SRT 형식이 아니어서 가져오지 않았습니다.', true, true);
                if (!safeResultFileUrl(state.resultFileHref)) throw failure('CHATGPT_RESULT_FILE_URL_UNSUPPORTED', 'ChatGPT 결과 파일 주소를 안전하게 확인하지 못해 내려받지 않았습니다.', true, true);
                job.phase = 'downloading-result-file';
                const targetPath = path.join(input.tempDir, `${input.jobKey}-translated.srt`);
                const downloaded = await waitForDownload(webContents, state.resultFileHref, targetPath, job);
                if (job.cancelled) throw failure('CANCELLED', '완성 자막 파일 내려받기를 중단했습니다.', true, true);
                const stat = fs.statSync(downloaded.path);
                if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SUBTITLE_FILE_BYTES)
                  throw failure('CHATGPT_RESULT_FILE_INVALID', '내려받은 완성 자막 파일이 비어 있거나 크기 제한을 넘었습니다.', true, true);
                const bytes = fs.readFileSync(downloaded.path);
                let content;
                try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
                catch { throw failure('CHATGPT_RESULT_FILE_ENCODING', '완성 자막 파일이 UTF-8 텍스트가 아니어서 가져오지 않았습니다.', true, true); }
                outcome = 'completed'; job.phase = 'completed';
                return { ok: true, jobKey: input.jobKey, responseFile: { name: downloaded.fileName, content }, sent: true, attached: true };
              }
            } else { previousFileSignature = signature; stableSince = now(); job.phase = 'checking-result-file-stability'; }
          } else {
            previousFileSignature = ''; stableSince = 0;
            if (String(state.assistantText || '').length > MAX_RESPONSE)
              throw failure('CHATGPT_RESPONSE_TOO_LARGE', 'ChatGPT 응답이 크기 제한을 넘어 완성 자막 파일을 확인하지 못했습니다.', true, true);
          }
        }
        await sleep(Math.max(100, Math.min(5000, Number(pollIntervalMs) || DEFAULT_POLL_MS)));
      }
      throw failure('CHATGPT_RESULT_FILE_TIMEOUT', 'ChatGPT가 완성 SRT 파일을 제공하지 않았거나 제한 시간 안에 확인하지 못했습니다. 부분 번역은 저장하지 않았고 요청을 자동 재전송하지 않았습니다.', true, true);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (!normalized.code) normalized.code = 'CHATGPT_WEB_FAILED';
      normalized.sent = Boolean(normalized.sent || job.sent);
      normalized.attached = Boolean(normalized.attached || job.attached);
      throw normalized;
    } finally {
      last = { jobKey: job.jobKey, batchIndex: 0, phase: job.phase, sent: job.sent, attached: job.attached,
        fileMode: true, stopRequested: Boolean(job.stopRequested), outcome, finishedAt: now() };
      if (active === job) active = null;
      job.finish();
    }
  }

  return Object.freeze({ run, runFile, cancel, busy, status });
}

module.exports = {
  MAX_PROMPT, MAX_RESPONSE, MAX_SUBTITLE_FILE_BYTES, DEFAULT_TIMEOUT_MS, CHATGPT_HOSTS,
  validateJob, validateFileJob, inspectScript, focusComposerScript, clickAttachButtonScript, clickSendScript, clearComposerScript, clickStopScript,
  findFileInputs, safeResultFileUrl,
  createWebAutoTranslation
};
