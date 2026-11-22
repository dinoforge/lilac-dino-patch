// The Claude translation controls added by the official desktop v0.5.54 UI.
// Build them before app.js binds the shared cloud-provider settings controls.
(() => {
  const choices = document.getElementById('cloudChoices');
  const qwen = document.querySelector('.cloud-block[data-cloud="qwen"]');
  if (!choices || !qwen || choices.querySelector('[data-value="claude"]') || document.querySelector('.cloud-block[data-cloud="claude"]')) return;

  const choice = document.createElement('button');
  choice.type = 'button';
  choice.dataset.value = 'claude';
  choice.textContent = 'Claude';
  choices.append(choice);

  const block = document.createElement('div');
  block.className = 'cloud-block hidden';
  block.dataset.cloud = 'claude';
  block.innerHTML = '<div class="setting-block"><b>Anthropic API 키</b><div class="tmdb-row"><input id="claudeKey" type="password" autocomplete="off" spellcheck="false" placeholder="console.anthropic.com에서 발급한 API 키"><button id="saveClaudeKey" type="button">저장</button></div><p id="claudeKeyState"></p></div><div class="setting-block"><b>Claude 모델</b><div class="tmdb-row"><select id="claudeModel" disabled></select></div><p>키를 저장하면 쓸 수 있는 모델을 불러옵니다. Claude 구독과 별개로 API 크레딧 충전이 필요합니다.</p></div>';
  qwen.after(block);
})();
