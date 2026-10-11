'use strict';

const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
const STATUS_LABELS = { playable: '재생 가능', provided: '제공 확인', missing: '미제공', checking: '확인 중', failed: '확인 실패' };
const PROVIDER_LABELS = { reanime: 'Re:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', linkkf: 'Linkkf' };
const state = { calendar: null, activeDay: 0, selectedWorkKey: null, subtitle: null, batchIndex: 0, prompt: '' };
let promptRequest = 0;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function setStatus(message) { $('#app-status').textContent = message; }

function setView(name) {
  const views = { schedule: ['#schedule-view', '방영표', '이번 주 방영'], subtitles: ['#subtitles-view', '자막 번역', '자막 번역 보조'], connection: ['#connection-view', '연동 안내', '원본 연동 상태'] };
  for (const [key, [selector]] of Object.entries(views)) $(selector).classList.toggle('is-hidden', key !== name);
  for (const button of $$('.nav-item')) button.classList.toggle('is-active', button.dataset.view === name);
  $('#breadcrumb').textContent = views[name][1];
  $('#page-title').textContent = views[name][2];
  if (name === 'subtitles' && state.subtitle) refreshPrompt().catch(error => setStatus(error.message));
}

function renderWeekdayTabs() {
  const container = $('#weekday-tabs');
  container.replaceChildren();
  DAYS.forEach((day, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `weekday-tab${index === state.activeDay ? ' is-active' : ''}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(index === state.activeDay));
    button.textContent = day + '요일';
    if (index === state.calendar.todayIndex) {
      const small = document.createElement('small');
      small.textContent = '오늘';
      button.append(small);
    }
    button.addEventListener('click', () => { state.activeDay = index; renderSchedule(); });
    container.append(button);
  });
}

function selectedWork() {
  const rows = state.calendar?.schedule?.[state.activeDay] || [];
  return rows.find(work => work.demoKey === state.selectedWorkKey) || rows[0] || null;
}

function renderSchedule() {
  if (!state.calendar) return;
  const selected = selectedWork();
  if (selected) state.selectedWorkKey = selected.demoKey;
  $('#calendar-date').textContent = `오늘 · ${state.calendar.today} · 현지 날짜 기준`;
  $('#quarter-label').textContent = state.calendar.selectedQuarter.label;
  $('#quarter-year').value = state.calendar.selectedQuarter.year;
  $('#quarter-year').max = state.calendar.currentQuarter.year;
  $('#quarter-number').value = String(state.calendar.selectedQuarter.quarter);
  $('#schedule-day-title').textContent = `${DAYS[state.activeDay]}요일`;
  renderWeekdayTabs();

  const rows = state.calendar.schedule[state.activeDay] || [];
  $('#schedule-count').textContent = `${rows.length}개 합성 예시`;
  const list = $('#schedule-list');
  list.replaceChildren();
  for (const work of rows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `schedule-item${work.demoKey === selected?.demoKey ? ' is-selected' : ''}`;
    const time = document.createElement('span');
    time.className = 'schedule-time';
    time.textContent = work.airingTime;
    const title = document.createElement('span');
    title.className = 'schedule-title';
    title.textContent = work.title;
    const meta = document.createElement('span');
    meta.className = 'schedule-meta';
    meta.textContent = `${work.season} · ${work.weekdayEpisodeNumber}화`;
    const titleGroup = document.createElement('span');
    titleGroup.append(title, meta);
    const episode = document.createElement('span');
    episode.className = 'schedule-episode';
    episode.textContent = '예시';
    button.append(time, titleGroup, episode);
    button.addEventListener('click', () => { state.selectedWorkKey = work.demoKey; renderSchedule(); });
    list.append(button);
  }
  renderWorkDetail(selected);
}

function renderWorkDetail(work) {
  const container = $('#work-detail');
  container.replaceChildren();
  if (!work) {
    const empty = document.createElement('div');
    empty.className = 'detail-empty';
    const caption = document.createElement('p');
    caption.className = 'section-caption';
    caption.textContent = '작품 선택';
    const title = document.createElement('h3');
    title.textContent = '선택한 요일에 합성 예시가 없습니다';
    const note = document.createElement('p');
    note.textContent = '실제 방영표 또는 공급원 연결은 아직 없습니다.';
    empty.append(caption, title, note);
    container.append(empty);
    return;
  }

  const header = document.createElement('div');
  header.className = 'detail-header';
  const copy = document.createElement('div');
  const title = document.createElement('h3');
  title.id = 'detail-title';
  title.textContent = work.title;
  const meta = document.createElement('p');
  meta.textContent = `${work.title_english} · ${work.year}년 ${work.season} · ${work.weekdayEpisodeNumber}화`;
  copy.append(title, meta);
  const episode = document.createElement('span');
  episode.className = 'detail-index';
  episode.textContent = `AniList 예시 ID ${work.anilistId}`;
  header.append(copy, episode);

  const sourceHeading = document.createElement('div');
  sourceHeading.className = 'source-heading';
  const heading = document.createElement('h4');
  heading.textContent = '정확한 회차 출처 상태';
  const stateNote = document.createElement('span');
  stateNote.textContent = `합성 · ${work.weekdayEpisodeNumber}화`;
  sourceHeading.append(heading, stateNote);

  const sourceList = document.createElement('div');
  sourceList.className = 'source-list';
  for (const source of work.sources) {
    const row = document.createElement('div');
    row.className = 'source-row';
    const name = document.createElement('span');
    name.className = 'source-name';
    name.textContent = PROVIDER_LABELS[source.provider];
    const status = document.createElement('span');
    status.className = 'source-status';
    status.dataset.state = source.status;
    status.textContent = STATUS_LABELS[source.status] || '확인 실패';
    row.append(name, status);
    sourceList.append(row);
  }
  const note = document.createElement('p');
  note.className = 'source-explanation';
  note.textContent = '이 상태는 테스트 화면을 위한 가상값입니다. 공급원 요청, 영상 주소 확인, 재생은 수행하지 않습니다. 실제 원본 재생은 LilacAnime에서 직접 선택해야 합니다.';
  container.append(header, sourceHeading, sourceList, note);
}

async function refreshCalendar(resetDay = false) {
  const previousDate = state.calendar?.today;
  const previousQuarter = state.calendar?.currentQuarter?.label;
  state.calendar = await window.lilacCompanion.calendarState();
  if (resetDay || !previousDate || previousDate !== state.calendar.today || previousQuarter !== state.calendar.currentQuarter.label) {
    state.activeDay = state.calendar.todayIndex;
  }
  renderSchedule();
}

async function changeQuarter() {
  const year = Number($('#quarter-year').value);
  const quarter = Number($('#quarter-number').value);
  try {
    state.calendar = await window.lilacCompanion.selectQuarter(year, quarter);
    state.activeDay = state.calendar.todayIndex;
    renderSchedule();
    setStatus(`${state.calendar.selectedQuarter.label}을 선택했습니다. 저장된 선택은 Companion 전용 설정입니다.`);
  } catch (error) {
    setStatus(error.message || '분기를 바꾸지 못했습니다.');
  }
}

function renderSubtitle() {
  const workflow = state.subtitle;
  const fileName = $('#subtitle-file-name');
  const languageDetected = $('#subtitle-language-detected');
  const batchSelect = $('#batch-select');
  const preview = $('#cue-preview');
  const response = $('#response-input');
  if (!workflow) {
    fileName.textContent = '파일을 선택하거나 합성 예시를 불러오세요.';
    languageDetected.textContent = '대기 중';
    batchSelect.disabled = true;
    batchSelect.replaceChildren(new Option('자막을 먼저 불러오세요', '0'));
    preview.textContent = '선택된 자막의 문장이 여기에 표시됩니다.';
    $('#prompt-preview').value = '';
    $('#copy-prompt').disabled = true;
    $('#apply-response').disabled = true;
    $('#export-vtt').disabled = true;
    return;
  }
  fileName.textContent = workflow.fileName;
  languageDetected.textContent = `감지: ${workflow.detectedLanguage === 'japanese' ? '일본어' : '영어'}`;
  $('#source-language').value = workflow.detectedLanguage;
  batchSelect.replaceChildren(...workflow.batches.map(batch => new Option(`${batch.index + 1}묶음 · ${batch.size}개`, String(batch.index))));
  batchSelect.disabled = workflow.batches.length <= 1;
  batchSelect.value = String(state.batchIndex);
  const current = workflow.batches[state.batchIndex];
  const cues = workflow.cues.filter(cue => current.ids.includes(cue.id));
  preview.textContent = cues.map(cue => `${cue.id}  ${cue.timing}\n${cue.text}`).join('\n\n');
  response.value = '';
  $('#apply-response').disabled = false;
  $('#translation-progress').textContent = `${workflow.translatedIds.length}/${workflow.requiredIds.length}개 자막 문장 적용됨`;
  $('#export-vtt').disabled = workflow.requiredIds.some(id => !workflow.translatedIds.includes(id));
  refreshPrompt().catch(error => setStatus(error.message || '프롬프트를 만들지 못했습니다.'));
}

async function refreshPrompt() {
  if (!state.subtitle) return;
  const request = ++promptRequest;
  const prompt = await window.lilacCompanion.makePrompt(state.batchIndex, {
    sourceLanguage: $('#source-language').value,
    title: $('#work-title-input').value.trim(),
    episode: $('#episode-input').value.trim()
  });
  if (request !== promptRequest) return;
  state.prompt = prompt;
  $('#prompt-preview').value = state.prompt;
  $('#prompt-source-note').textContent = `사용 원문: ${$('#source-language').value === 'japanese' ? '일본어' : '영어'} 프롬프트 · 앞뒤 문맥 포함`;
  $('#copy-prompt').disabled = false;
}

async function loadSubtitle(promise) {
  try {
    const workflow = await promise;
    if (!workflow) return;
    state.subtitle = workflow;
    state.batchIndex = 0;
    $('#response-input').value = '';
    renderSubtitle();
    setStatus(`${workflow.fileName}을 불러왔습니다. 자동 전송은 하지 않습니다.`);
  } catch (error) {
    setStatus(error.message || '자막을 불러오지 못했습니다.');
  }
}

async function validateResponse() {
  if (!state.subtitle) return;
  try {
    state.subtitle = await window.lilacCompanion.applyResponse(state.batchIndex, $('#response-input').value);
    renderSubtitle();
    setStatus('응답 ID를 검증하고 현재 묶음에 적용했습니다.');
  } catch (error) {
    setStatus(error.message || '번역 결과가 원문과 맞지 않습니다.');
  }
}

function bindEvents() {
  for (const button of $$('.nav-item')) button.addEventListener('click', () => setView(button.dataset.view));
  $('#theme-toggle').addEventListener('click', () => {
    const next = document.body.dataset.theme === 'light' ? 'dark' : 'light';
    document.body.dataset.theme = next;
    localStorage.setItem('companion-theme', next);
    $('#theme-toggle').textContent = next === 'light' ? '다크 테마' : '라이트 테마';
  });
  $('#quarter-year').addEventListener('change', changeQuarter);
  $('#quarter-number').addEventListener('change', changeQuarter);
  $('#current-quarter').addEventListener('click', async () => {
    state.calendar = await window.lilacCompanion.resetQuarter();
    state.activeDay = state.calendar.todayIndex;
    renderSchedule();
  });
  $('#refresh-schedule').addEventListener('click', () => refreshCalendar(true).then(() => setStatus('합성 방영표를 새로 표시했습니다.')));
  $('#demo-ja').addEventListener('click', () => loadSubtitle(window.lilacCompanion.loadDemoSubtitle('japanese')));
  $('#demo-en').addEventListener('click', () => loadSubtitle(window.lilacCompanion.loadDemoSubtitle('english')));
  $('#choose-vtt').addEventListener('click', () => loadSubtitle(window.lilacCompanion.chooseSubtitle()));
  $('#source-language').addEventListener('change', () => refreshPrompt().catch(error => setStatus(error.message)));
  $('#batch-select').addEventListener('change', () => { state.batchIndex = Number($('#batch-select').value); renderSubtitle(); });
  for (const selector of ['#work-title-input', '#episode-input']) $(selector).addEventListener('input', () => refreshPrompt().catch(error => setStatus(error.message)));
  $('#copy-prompt').addEventListener('click', async () => {
    try { await window.lilacCompanion.copyText(state.prompt); setStatus('프롬프트를 클립보드에 복사했습니다. ChatGPT에 직접 붙여넣으세요.'); }
    catch (error) { setStatus(error.message || '복사하지 못했습니다.'); }
  });
  $('#open-chatgpt').addEventListener('click', async () => {
    try { await window.lilacCompanion.openChatGPT(); setStatus('ChatGPT를 브라우저에서 열었습니다. 프롬프트와 자막은 자동 전송하지 않았습니다.'); }
    catch (error) { setStatus(error.message || '브라우저를 열지 못했습니다.'); }
  });
  $('#apply-response').addEventListener('click', validateResponse);
  $('#export-vtt').addEventListener('click', async () => {
    try {
      const result = await window.lilacCompanion.exportSubtitle();
      if (result) setStatus(`${result.fileName}을 새 파일로 저장했습니다.`);
    } catch (error) { setStatus(error.message || '새 자막 파일을 저장하지 못했습니다.'); }
  });
  window.addEventListener('focus', () => refreshCalendar().catch(error => setStatus(error.message)));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshCalendar().catch(error => setStatus(error.message));
  });
}

async function start() {
  const theme = localStorage.getItem('companion-theme');
  if (theme === 'light') document.body.dataset.theme = 'light';
  $('#theme-toggle').textContent = theme === 'light' ? '다크 테마' : '라이트 테마';
  bindEvents();
  renderSubtitle();
  await refreshCalendar(true);
  setInterval(() => refreshCalendar().catch(error => setStatus(error.message)), 5 * 60 * 1000);
}

start().catch(error => setStatus(error.message || 'Companion을 시작하지 못했습니다.'));
