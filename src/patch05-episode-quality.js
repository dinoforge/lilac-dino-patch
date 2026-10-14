'use strict';
(() => {
  if (window.DinoLilacPatchFeatures?.['patch-05'] !== true) return;
  const api = window.lilac;
  if (typeof api?.patchEpisodeQuality !== 'function') return;
  if (!document.querySelector('#patch05EpisodeQualityStyle')) {
    const link = document.createElement('link');
    link.id = 'patch05EpisodeQualityStyle';
    link.rel = 'stylesheet';
    link.href = 'patch05-episode-quality.css';
    document.head.append(link);
  }
  const selections = new WeakMap();
  let requestToken = 0;
  let oneShotQuality = null;

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const labelProvider = provider => ({ reanime: 'Re:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', ani24: '애니24', linkkf: 'Linkkf', linkani: 'Linkani' })[provider] || provider || '공급원';
  const setStatus = (node, text, state = '') => { node.textContent = text; node.dataset.state = state; };
  const renderResults = (host, episode, response, token) => {
    if (token !== requestToken || !host.isConnected) return;
    const list = element('div', 'patch05-quality-results');
    const providers = Array.isArray(response?.providers) ? response.providers : [];
    if (!providers.length) {
      list.append(element('small', 'patch05-quality-unknown', response?.message || '확인 불가'));
    }
    for (const provider of providers) {
      const serverBlock = element('div', 'patch05-quality-server');
      const serverTitle = element('b', '', `${labelProvider(episode.provider)} · ${String(provider.server || '서버').slice(0, 100)}`);
      serverBlock.append(serverTitle);
      if (provider.state !== 'ready' || !Array.isArray(provider.qualities) || !provider.qualities.length) {
        const status = provider.state === 'rate-limited' ? '요청 제한' : provider.state === 'timeout' ? '시간 초과' : '확인 불가';
        serverBlock.append(element('small', 'patch05-quality-unknown', `${status}${provider.message ? ` · ${provider.message}` : ''}`));
      } else {
        const options = element('div', 'patch05-quality-options');
        for (const quality of provider.qualities) {
          if (quality?.playable !== true || typeof quality.id !== 'string') continue;
          const button = element('button', 'patch05-quality-option', quality.label || '화질 확인 불가');
          button.type = 'button';
          button.setAttribute('aria-pressed', 'false');
          button.addEventListener('click', () => {
            selections.set(episode, {
              server: String(provider.server || ''),
              height: Number.isInteger(quality.height) && quality.height > 0 ? quality.height : null,
              quality: Number.isInteger(quality.height) && quality.height > 0 ? `${quality.height}p` : 'Auto'
            });
            options.querySelectorAll('button').forEach(item => {
              const selected = item === button;
              item.classList.toggle('selected', selected);
              item.setAttribute('aria-pressed', String(selected));
            });
            host.querySelector('.patch05-quality-status').textContent = `${provider.server || '공급원'} · ${quality.label} 선택됨. 회차 재생 시 기존 화질 설정에 적용합니다.`;
          });
          options.append(button);
        }
        if (!options.childElementCount) serverBlock.append(element('small', 'patch05-quality-unknown', '확인된 재생 화질이 없습니다.'));
        else serverBlock.append(options);
      }
      list.append(serverBlock);
    }
    const old = host.querySelector('.patch05-quality-results');
    if (old) old.replaceWith(list); else host.append(list);
    setStatus(host.querySelector('.patch05-quality-status'), response?.message || (response?.state === 'ready' ? '실제 HLS 재생 목록에서 확인했습니다.' : '화질 확인을 완료하지 못했습니다.'), response?.state || 'unknown');
  };

  function mountQualityControl(host, episode) {
    if (!host || !episode || host.querySelector(':scope > .patch05-quality-control')) return;
    const control = element('div', 'patch05-quality-control');
    const inspect = element('button', 'patch05-quality-check', '화질 확인');
    inspect.type = 'button';
    const status = element('small', 'patch05-quality-status', '회차를 선택한 뒤 실제 지원 화질을 확인할 수 있습니다.');
    control.append(inspect, status);
    host.append(control);
    inspect.addEventListener('click', async () => {
      if (inspect.disabled) return;
      const token = ++requestToken;
      inspect.disabled = true;
      setStatus(status, '확인 중…', 'loading');
      const stale = control.querySelector('.patch05-quality-results');
      stale?.remove();
      try {
        const response = await api.patchEpisodeQuality(episode);
        renderResults(control, episode, response, token);
      } catch (error) {
        if (token === requestToken && control.isConnected) setStatus(status, error?.message?.includes('429') ? '요청 제한 · 잠시 후 다시 확인해 주세요.' : '공급원 응답을 확인할 수 없습니다.', 'unknown');
      } finally {
        inspect.disabled = false;
      }
    });
  }

  function preparePlayback(episode) {
    if (!episode || typeof episode !== 'object') { oneShotQuality = null; return episode; }
    const selection = selections.get(episode);
    if (!selection) { oneShotQuality = null; return episode; }
    oneShotQuality = { quality: selection.quality, expiresAt: Date.now() + 30000 };
    return { ...episode, server: selection.server, patch05Server: selection.server, patch05Height: selection.height };
  }

  function takePendingQuality() {
    const pending = oneShotQuality;
    oneShotQuality = null;
    return pending && pending.expiresAt >= Date.now() ? pending.quality : null;
  }

  function installQualityHook() {
    if (typeof window.applyDefaultQuality !== 'function' || window.applyDefaultQuality.__patch05) return;
    const original = window.applyDefaultQuality;
    const wrapped = function (...args) {
      const requested = takePendingQuality();
      if (!requested) return original.apply(this, args);
      let previous = null;
      try {
        previous = localStorage.getItem('defaultQuality');
        localStorage.setItem('defaultQuality', requested);
        return original.apply(this, args);
      } finally {
        if (previous == null) localStorage.removeItem('defaultQuality');
        else localStorage.setItem('defaultQuality', previous);
      }
    };
    wrapped.__patch05 = true;
    window.applyDefaultQuality = wrapped;
  }

  function installEpisodeListHook() {
    if (typeof window.mountEpisodeList !== 'function' || window.mountEpisodeList.__patch05) return;
    const original = window.mountEpisodeList;
    const wrapped = function (container, options) {
      const before = container?.childElementCount || 0;
      const originalPlay = options?.onPlay;
      const nextOptions = originalPlay ? { ...options, onPlay: episode => originalPlay(preparePlayback(episode)) } : options;
      const result = original.call(this, container, nextOptions);
      const section = container?.children?.[before];
      if (section) {
        const attach = () => {
          for (const row of section.querySelectorAll('.episode-row.rich')) {
            const button = row.querySelector('.episode-btn[data-index]');
            const episode = button ? options?.episodes?.[Number(button.dataset.index)] : null;
            if (episode) mountQualityControl(row, episode);
          }
        };
        attach();
        new MutationObserver(attach).observe(section, { childList: true, subtree: true });
      }
      return result;
    };
    wrapped.__patch05 = true;
    window.mountEpisodeList = wrapped;
  }

  window.DinoPatch05 = Object.freeze({ mountChoice: mountQualityControl, preparePlayback, takePendingQuality });
  installQualityHook();
  installEpisodeListHook();
})();
