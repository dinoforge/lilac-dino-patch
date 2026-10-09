const HEADER_NAMES = new Set(['referer', 'origin', 'user-agent', 'cookie', 'authorization']);

function allowedHeaders(source) {
  const headers = {};
  for (const [name, value] of Object.entries(source || {})) {
    if (HEADER_NAMES.has(name.toLowerCase()) && value != null && String(value)) headers[name] = String(value);
  }
  return headers;
}

function isLoopback(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function createPlayerStreamHeaders() {
  let generation = 0, fallback = null;
  const byHost = new Map();

  function begin() {
    generation++;
    fallback = null;
    byHost.clear();
    return generation;
  }

  function complete(requestId, provider, stream) {
    if (requestId !== generation || !stream || typeof stream !== 'object') return false;

    if (['miruro', 'ohli24'].includes(provider)) {
      const headers = allowedHeaders(stream.headers);
      fallback = Object.keys(headers).length ? headers : null;
    }

    let url;
    try { url = new URL(String(stream.url || '')); } catch { return true; }
    if (!['http:', 'https:'].includes(url.protocol) || isLoopback(url.hostname)) return true;

    const headers = allowedHeaders(stream.headers);
    if (stream.referer && !Object.keys(headers).some(name => name.toLowerCase() === 'referer')) headers.Referer = String(stream.referer);
    if (Object.keys(headers).length) byHost.set(url.host.toLowerCase(), headers);
    return true;
  }

  function forRequest(host, useFallback = false) {
    return byHost.get(String(host || '').toLowerCase()) || (useFallback ? fallback : null);
  }

  return { begin, complete, forRequest, hasFallback: () => Boolean(fallback) };
}

module.exports = { createPlayerStreamHeaders };
