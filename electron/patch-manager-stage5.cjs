'use strict';

const crypto = require('node:crypto');

const MAX_PLAYLIST_BYTES = 1024 * 1024;
const MAX_SERVERS = 5;
const MAX_VARIANTS = 8;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 8000;

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
    const privateIpv4 = ipv4 && (ipv4.some(octet => octet > 255) || ipv4[0] === 0 || ipv4[0] === 10 ||
      ipv4[0] === 127 || ipv4[0] >= 224 || ipv4[0] === 169 && ipv4[1] === 254 ||
      ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31 ||
      ipv4[0] === 192 && ipv4[1] === 168 || ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127);
    const ipv6 = host.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || privateIpv4 ||
        /^::(?:1)?$/i.test(ipv6) || /^(?:fc|fd|fe80|ff)/i.test(ipv6)) return null;
    return url;
  } catch { return null; }
}

function safeHeaders(input) {
  const output = Object.create(null);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return output;
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (!['referer', 'origin', 'user-agent'].includes(lower) || typeof value !== 'string' || value.length > 2048) continue;
    if (/\r|\n/.test(value)) continue;
    output[lower === 'user-agent' ? 'User-Agent' : lower === 'referer' ? 'Referer' : 'Origin'] = value;
  }
  return output;
}

function parseAttributeList(line) {
  const values = Object.create(null);
  const source = String(line || '').replace(/^#EXT-X-STREAM-INF:/i, '');
  const pattern = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
  for (const match of source.matchAll(pattern)) values[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  return values;
}

function parseMasterPlaylist(text, masterUrl) {
  if (typeof text !== 'string' || text.length > MAX_PLAYLIST_BYTES || !text.trimStart().startsWith('#EXTM3U')) return [];
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const variants = [];
  for (let index = 0; index < lines.length; index++) {
    if (!/^#EXT-X-STREAM-INF:/i.test(lines[index])) continue;
    const attributes = parseAttributeList(lines[index]);
    let uri = '';
    for (let next = index + 1; next < lines.length; next++) {
      if (!lines[next]) continue;
      if (lines[next].startsWith('#')) break;
      uri = lines[next]; break;
    }
    if (!uri) continue;
    let url;
    try { url = new URL(uri, masterUrl).href; } catch { continue; }
    const safe = safeHttpsUrl(url);
    if (!safe) continue;
    const resolution = String(attributes.RESOLUTION || '').match(/^(\d+)x(\d+)$/i);
    const height = resolution ? Number(resolution[2]) : null;
    const width = resolution ? Number(resolution[1]) : null;
    const bandwidth = Number(attributes['AVERAGE-BANDWIDTH'] || attributes.BANDWIDTH);
    variants.push({
      url: safe.href,
      width: Number.isInteger(width) && width > 0 ? width : null,
      height: Number.isInteger(height) && height > 0 ? height : null,
      bitrate: Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : null
    });
    if (variants.length >= MAX_VARIANTS) break;
  }
  return variants;
}

async function fetchText(url, headers, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let parsed = safeHttpsUrl(url);
  if (!parsed) return { state: 'unknown', reason: '안전한 HTTPS 주소가 아닙니다.' };
  const deadline = Date.now() + Math.min(15000, Math.max(500, timeoutMs));
  let response = null;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { state: 'timeout', reason: '재생 목록 응답 시간 초과' };
    try {
      response = await fetchImpl(parsed.href, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(15000, Math.max(1, remaining))),
        headers: { ...safeHeaders(headers), Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain;q=0.9, */*;q=0.1' }
      });
    } catch (error) {
      return { state: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'unknown', reason: '재생 목록에 연결하지 못했습니다.' };
    }
    if (response.status === 429) return { state: 'rate-limited', reason: '공급원이 요청을 제한했습니다. 잠시 후 회차 화면에서 다시 확인해 주세요.' };
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers?.get?.('location') || response.headers?.location;
    let next;
    try { next = location ? safeHttpsUrl(new URL(location, parsed.href).href) : null; } catch { next = null; }
    if (!next) return { state: 'unknown', reason: '안전하지 않거나 확인할 수 없는 재생 목록 리디렉션을 차단했습니다.' };
    if (redirects === MAX_REDIRECTS) return { state: 'unknown', reason: '재생 목록 리디렉션 한도를 넘었습니다.' };
    parsed = next;
  }
  if (!response) return { state: 'unknown', reason: '재생 목록에 연결하지 못했습니다.' };
  if (!response.ok) return { state: 'unknown', reason: `HTTP ${response.status}` };
  const finalUrl = safeHttpsUrl(response.url || parsed.href);
  if (!finalUrl) return { state: 'unknown', reason: '안전하지 않은 리디렉션을 차단했습니다.' };
  let text;
  try { text = await response.text(); } catch { return { state: 'unknown', reason: '재생 목록을 읽지 못했습니다.' }; }
  if (text.length > MAX_PLAYLIST_BYTES) return { state: 'unknown', reason: '재생 목록 크기가 제한을 넘었습니다.' };
  if (!text.trimStart().startsWith('#EXTM3U')) return { state: 'unknown', reason: 'HLS 재생 목록이 아닙니다.' };
  return { state: 'ok', text, url: finalUrl.href };
}

async function validateMediaPlaylist(variant, headers, options) {
  const result = await fetchText(variant.url, headers, options);
  if (result.state !== 'ok') return { state: result.state };
  const media = /#EXTINF:/i.test(result.text) || /#EXT-X-TARGETDURATION:/i.test(result.text) || /#EXT-X-PART:/i.test(result.text);
  if (!media || /#EXT-X-STREAM-INF:/i.test(result.text)) return { state: 'unknown' };
  return { state: 'ready', width: variant.width, height: variant.height, bitrate: variant.bitrate };
}

async function mapLimit(values, limit, task) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await task(values[index], index);
    }
  }));
  return results;
}

function classifyError(error) {
  if (error?.status === 429 || error?.statusCode === 429 || error?.code === 'HTTP_429' || /\b429\b/.test(String(error?.message || ''))) return 'rate-limited';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timeout|시간 초과/i.test(String(error?.message || ''))) return 'timeout';
  return 'unknown';
}

async function inspectHlsCandidate(candidate, options = {}) {
  const server = String(candidate?.server || '공급원').slice(0, 120);
  const headers = safeHeaders(candidate?.headers);
  const master = await fetchText(candidate?.url, headers, options);
  if (master.state !== 'ok') return { server, state: master.state, message: master.reason, qualities: [] };
  const variants = parseMasterPlaylist(master.text, master.url);
  if (!variants.length) {
    if (/#EXTINF:|#EXT-X-TARGETDURATION:|#EXT-X-PART:/i.test(master.text)) {
      return { server, state: 'ready', message: '재생 목록을 확인했습니다. 화질 정보는 확인할 수 없습니다.', qualities: [{ id: 'auto', height: null, bitrate: null, label: 'Auto · 화질 확인 불가', playable: true }] };
    }
    return { server, state: 'unknown', message: '확인된 화질 variant가 없습니다.', qualities: [] };
  }
  const checked = await mapLimit(variants, 2, variant => validateMediaPlaylist(variant, headers, options));
  const playable = checked.filter(variant => variant?.state === 'ready');
  const qualities = playable.map(variant => {
    const height = variant.height;
    const bitrate = variant.bitrate;
    const id = crypto.createHash('sha256').update(`${server}\0${height || ''}\0${bitrate || ''}`).digest('hex').slice(0, 16);
    return {
      id,
      height,
      bitrate,
      label: height ? `${height}p${bitrate ? ` · ${Math.round(bitrate / 1000)} kbps` : ''}` : `화질 확인 불가${bitrate ? ` · ${Math.round(bitrate / 1000)} kbps` : ''}`,
      playable: true
    };
  });
  return qualities.length
    ? { server, state: 'ready', message: checked.some(variant => variant?.state === 'rate-limited') ? '일부 화질 확인은 요청 제한으로 끝났습니다.' : '', qualities }
    : checked.some(variant => variant?.state === 'rate-limited')
      ? { server, state: 'rate-limited', message: '공급원이 요청을 제한했습니다. 잠시 후 다시 확인해 주세요.', qualities: [] }
      : { server, state: 'unknown', message: '재생 가능한 variant를 검증하지 못했습니다.', qualities: [] };
}

function assertProviderEpisode(episode) {
  if (!episode || typeof episode !== 'object' || Array.isArray(episode)) throw new TypeError('회차 정보가 필요합니다.');
  const provider = String(episode.provider || '').toLowerCase();
  if (!['reanime', 'miruro', 'animenosub', 'ohli24', 'ani24', 'linkani', 'linkkf'].includes(provider)) throw new Error('지원하지 않는 공급원입니다.');
  const number = Number(episode.number ?? String(episode.name || '').match(/\d+/)?.[0]);
  if (!Number.isInteger(number) || number < 1 || number > 10000) throw new Error('회차 번호를 확인할 수 없습니다.');
  return { ...episode, provider, number };
}

function isSameOrSubdomain(url, base) {
  try {
    const target = safeHttpsUrl(url), allowed = new URL(base);
    return Boolean(target && target.hostname.toLowerCase().endsWith(`.${allowed.hostname.toLowerCase()}`) ||
      target && target.hostname.toLowerCase() === allowed.hostname.toLowerCase());
  } catch { return false; }
}

function resolverOptions(deps, provider, index) {
  return { partition: `lilac-patch05-${provider}-${index}`, waitSubtitle: false };
}

async function getCandidates(episode, deps) {
  const { provider } = episode;
  if (provider === 'miruro') {
    const animeId = Number(episode.animeId || episode.anime_id || episode.id);
    if (!Number.isInteger(animeId) || animeId < 1) throw new Error('Miruro 작품 ID를 확인할 수 없습니다.');
    const root = await deps.miruroApi(`anime/${animeId}/episodes/${episode.number}/play`);
    const candidates = [];
    for (const track of root?.tracks || []) {
      const kind = deps.MIRURO_KINDS?.[track.track];
      if (!kind) continue;
      for (const item of track.providers || []) for (const server of item.servers || []) {
        const stream = (server.streams || []).find(value => value.format === 'hls' && safeHttpsUrl(value.url));
        if (!stream) continue;
        const headers = { ...(server.headers || {}) };
        if (headers.Referer && !headers.Origin) try { headers.Origin = new URL(headers.Referer).origin; } catch {}
        candidates.push({ server: `${String(kind).toUpperCase()} - ${item.provider} ${server.server}`, url: stream.url, headers, direct: true });
      }
    }
    return candidates.slice(0, MAX_SERVERS);
  }
  if (provider === 'reanime') {
    if (!isSameOrSubdomain(episode.url, deps.REANIME_WEB)) throw new Error('Re:Anime 회차 주소가 공식 공급원과 일치하지 않습니다.');
    const servers = await deps.reanimeServers(episode);
    return (Array.isArray(servers) ? servers : []).slice(0, MAX_SERVERS).map(server => ({ server: server.name || '서버', url: server.url, referer: `${deps.REANIME_WEB}/` }));
  }
  if (provider === 'animenosub') {
    if (!isSameOrSubdomain(episode.url, deps.ANIMENOSUB_WEB)) throw new Error('Animenosub 회차 주소가 공식 공급원과 일치하지 않습니다.');
    const html = await deps.providerFetch(episode.url, { referer: `${deps.ANIMENOSUB_WEB}/` });
    const servers = deps.animenosubServers(html, episode.url);
    return (Array.isArray(servers) ? servers : []).slice(0, MAX_SERVERS).map(server => ({ server: server.label || '서버', url: server.url, referer: episode.url }));
  }
  if (provider === 'linkkf') {
    const token = String(episode.token || '');
    const postId = String(episode.postId || '');
    const slug = String(episode.slug || '');
    if (!token || !postId) throw new Error('Linkkf 회차 정보가 불완전합니다.');
    const root = await deps.linkkfFetch(`https://emdlinkkf.5imgdarr.top/apilink2.php?data=${encodeURIComponent(token)}`);
    const links = Array.isArray(root?.data) ? root.data : [];
    const candidates = links.filter(link => safeHttpsUrl(link.link)).slice(0, MAX_SERVERS).map(link => ({ server: String(link.server || '서버'), url: link.link, referer: `${deps.LINKKF_WEB}/` }));
    if (candidates.length) return candidates;
    return [{ server: '기본 서버', url: `${deps.LINKKF_WEB}/up/${encodeURIComponent(postId)}/watch/?slug=${encodeURIComponent(slug)}`, referer: `${deps.LINKKF_WEB}/` }];
  }
  const mappedProvider = provider === 'ani24' ? 'ohli24' : provider;
  const base = mappedProvider === 'ohli24' ? deps.OHLI24_WEB : mappedProvider === 'linkani' ? deps.LINKANI_WEB : null;
  if (!base || !isSameOrSubdomain(episode.url, base)) throw new Error('회차 주소를 허용된 공급원에서 확인하지 못했습니다.');
  const stream = await deps.resolveProviderEpisode({ ...episode, provider: mappedProvider, download: false });
  return stream?.url ? [{ server: stream.server || episode.server || '기본 서버', url: stream.url, headers: stream.headers, direct: true }] : [];
}

function registerPatch05Handlers(deps) {
  if (!deps?.ipcMain?.handle) throw new TypeError('Patch 05 IPC dependencies are required.');
  deps.ipcMain.handle('patch:episode-quality', async (_event, rawEpisode) => {
    const episode = assertProviderEpisode(rawEpisode);
    let candidates;
    try { candidates = await getCandidates(episode, deps); }
    catch (error) {
      const state = classifyError(error);
      return { state, providers: [{ server: '공급원', state, message: state === 'rate-limited' ? '공급원이 요청을 제한했습니다. 다시 시도하기 전 잠시 기다려 주세요.' : state === 'timeout' ? '공급원 응답 시간 초과' : '공급원 서버를 확인할 수 없습니다.', qualities: [] }], message: '' };
    }
    if (!candidates.length) return { state: 'unknown', providers: [], message: '확인할 수 있는 영상 서버가 없습니다.' };
    const results = await mapLimit(candidates, 2, async (candidate, index) => {
      let stream = candidate;
      if (!candidate.direct) {
        try {
          stream = await deps.resolveStreamPage(candidate.url, candidate.referer, 10000, resolverOptions(deps, episode.provider, index));
        } catch (error) {
          const state = classifyError(error);
          return { server: candidate.server, state, message: state === 'rate-limited' ? '공급원이 요청을 제한했습니다.' : state === 'timeout' ? '영상 서버 응답 시간 초과' : '영상 서버 연결 실패', qualities: [] };
        }
      }
      const url = safeHttpsUrl(stream?.url);
      if (!url) return { server: candidate.server, state: 'unknown', message: '검증된 외부 HLS 주소를 확인할 수 없습니다.', qualities: [] };
      return inspectHlsCandidate({ server: candidate.server || stream.server, url: url.href, headers: stream.headers || candidate.headers }, { timeoutMs: DEFAULT_TIMEOUT_MS, fetchImpl: deps.fetchImpl || fetch });
    });
    const valid = results.some(result => result.state === 'ready');
    const limited = results.some(result => result.state === 'rate-limited');
    return { state: valid ? 'ready' : limited ? 'rate-limited' : 'unknown', providers: results, message: valid ? '' : limited ? '일부 공급원이 요청을 제한했습니다.' : '공급원별 화질을 확인할 수 없습니다.' };
  });
}

module.exports = {
  MAX_PLAYLIST_BYTES, MAX_SERVERS, MAX_REDIRECTS, DEFAULT_TIMEOUT_MS,
  safeHttpsUrl, safeHeaders, parseAttributeList, parseMasterPlaylist,
  inspectHlsCandidate, assertProviderEpisode, getCandidates, registerPatch05Handlers
};
