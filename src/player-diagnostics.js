(function exposePlayerDiagnostics(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LilacPlayerDiagnostics = api;
})(typeof window === 'undefined' ? globalThis : window, function createPlayerDiagnostics() {
  const PROVIDERS = new Set(['animenosub', 'linkani', 'linkkf', 'miruro', 'ohli24', 'reanime']);
  const STAGES = new Set(['stream-resolution', 'direct-playback', 'hls-playback', 'playback']);
  const MEDIA_TYPES = new Set(['native', 'hls', 'unknown']);
  const ERROR_CATEGORIES = new Set(['networkError', 'mediaError', 'otherError']);
  const VIDEO_ERROR_CODES = new Set([2, 3, 4]);

  function safeHost(value) {
    try {
      const url = new URL(String(value || ''));
      return ['http:', 'https:'].includes(url.protocol) ? url.hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  function safeTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
  }

  function createEntry({ context = {}, failure = {}, occurredAt = new Date() } = {}) {
    const providerCandidate = String(context.episode?.provider || context.anime?.provider || context.resolveKind || '').toLowerCase();
    const code = Number(failure.videoErrorCode);
    return {
      occurredAt: safeTimestamp(occurredAt),
      provider: PROVIDERS.has(providerCandidate) ? providerCandidate : 'unknown',
      stage: STAGES.has(failure.stage) ? failure.stage : 'playback',
      playback: context.offline === true ? 'offline' : 'online',
      mediaType: MEDIA_TYPES.has(failure.mediaType) ? failure.mediaType : context.hls ? 'hls' : 'native',
      serverHost: safeHost(context.currentUrl),
      videoErrorCode: VIDEO_ERROR_CODES.has(code) ? code : null,
      errorCategory: ERROR_CATEGORIES.has(failure.errorCategory) ? failure.errorCategory : null
    };
  }

  function safeLabel(value, fallback) {
    const safe = String(value || '').replace(/[^a-zA-Z0-9._+-]/g, '').slice(0, 40);
    return safe || fallback;
  }

  function formatReport({ app = {}, entries = [] } = {}) {
    const version = safeLabel(app.version, 'unknown');
    const platform = safeLabel(app.platform, 'unknown');
    const arch = safeLabel(app.arch, 'unknown');
    const recent = Array.isArray(entries) ? entries.slice(-5) : [];
    const lines = [
      'LilacAnime 재생 진단 정보',
      `앱 버전: ${version}`,
      `운영체제: ${platform} ${arch}`,
      '현재 실행 중 발생한 최근 재생 오류:'
    ];
    for (const [index, entry] of recent.entries()) {
      lines.push(
        `${index + 1}. ${safeTimestamp(entry.occurredAt)} | 공급원=${PROVIDERS.has(entry.provider) ? entry.provider : 'unknown'} | 단계=${STAGES.has(entry.stage) ? entry.stage : 'playback'} | 재생=${entry.playback === 'offline' ? 'offline' : 'online'} | 형식=${MEDIA_TYPES.has(entry.mediaType) ? entry.mediaType : 'unknown'} | 서버=${safeHost(entry.serverHost ? `https://${entry.serverHost}/` : '') || 'unknown'} | 영상 코드=${VIDEO_ERROR_CODES.has(Number(entry.videoErrorCode)) ? Number(entry.videoErrorCode) : '-'} | 오류 종류=${ERROR_CATEGORIES.has(entry.errorCategory) ? entry.errorCategory : '-'}`
      );
    }
    return lines.join('\n');
  }

  return Object.freeze({ createEntry, formatReport });
});
