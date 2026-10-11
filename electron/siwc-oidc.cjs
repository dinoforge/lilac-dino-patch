'use strict';
const crypto = require('node:crypto');
const { SIWC } = require('./siwc-contract.cjs');

function verifyIdToken(jwt, {clientId, nonce, jwks, now = Date.now()} = {}) {
  if (typeof jwt !== 'string' || jwt.length > 24_000 || !/^oaiapp_[\w-]+$/.test(clientId || '') || !nonce) {
    throw new Error('SIWC ID token verification parameters are invalid');
  }
  const segments = jwt.split('.');
  if (segments.length !== 3 || segments.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Invalid SIWC ID token format');
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch { throw new Error('Invalid SIWC ID token data'); }
  if (header.alg !== 'RS256' || !header.kid || typeof header.kid !== 'string' || header.typ && header.typ !== 'JWT') {
    throw new Error('Unexpected SIWC ID token algorithm');
  }
  const key = Array.isArray(jwks?.keys) && jwks.keys.find(item =>
    item.kid === header.kid && item.kty === 'RSA' && item.alg !== 'HS256' &&
    (!item.use || item.use === 'sig') && typeof item.n === 'string' && typeof item.e === 'string');
  if (!key) throw new Error('Trusted SIWC signing key not found');
  let verified = false;
  try {
    verified = crypto.verify('RSA-SHA256', Buffer.from(segments[0] + '.' + segments[1]),
      crypto.createPublicKey({key,format:'jwk'}),Buffer.from(segments[2],'base64url'));
  } catch { verified = false; }
  if (!verified) throw new Error('SIWC ID token signature invalid');
  const seconds = Math.floor(now / 1000);
  if (payload.iss !== SIWC.issuer || !(payload.aud === clientId ||
    Array.isArray(payload.aud) && payload.aud.includes(clientId)) ||
    !Number.isFinite(payload.exp) || payload.exp <= seconds ||
    !Number.isFinite(payload.iat) || payload.iat > seconds + 60 ||
    payload.nonce !== nonce || typeof payload.sub !== 'string' || !payload.sub ||
    payload.sub.length > 1024) {
    throw new Error('SIWC ID token issuer, audience, lifetime or nonce mismatch');
  }
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) {
    throw new Error('SIWC authorized party mismatch');
  }
  return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email.slice(0,320) : '' };
}

function parseModelCatalog(body) {
  if (!Array.isArray(body?.models)) throw new Error('SIWC model list response is invalid');
  return body.models.filter(m => m && m.visibility === 'list' &&
    typeof m.slug === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/.test(m.slug))
    .map(m => ({id:m.slug,name:typeof m.display_name === 'string' ? m.display_name.slice(0,120) : m.slug}))
    .slice(0,100);
}

function parseEventBlock(block) {
  const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return null;
  try { return JSON.parse(data); } catch { throw new Error('Invalid SIWC streaming JSON'); }
}

async function readResponseStream(stream, {limit=2_000_000} = {}) {
  if (!stream || typeof stream.getReader !== 'function') throw new Error('SIWC response is not streaming');
  const reader=stream.getReader(),decoder=new TextDecoder();
  let buffer='',output='',completed=false,failed=false,bytes=0;
  try {
    while(true) {
      const {value,done}=await reader.read();if(done) break;
      bytes+=value.byteLength;if(bytes>limit*2) throw new Error('SIWC response exceeded maximum size');
      // Normalize after concatenation so CRLF pairs split across network chunks work.
      buffer+=decoder.decode(value,{stream:true});
      buffer=buffer.replace(/\r\n/g,'\n');
      if(buffer.length>limit*2) throw new Error('SIWC event buffer exceeded maximum size');
      let split;
      while((split=buffer.indexOf('\n\n'))!==-1){
        const block=buffer.slice(0,split);buffer=buffer.slice(split+2);
        const event=parseEventBlock(block);
        if (!event) continue;
        const type=event.type;
        if(type==='response.output_text.delta'){
          if(typeof event.delta!=='string') throw new Error('Invalid SIWC text delta');
          output+=event.delta;
          if(output.length>limit)throw new Error('SIWC translated text exceeded maximum size');
        } else if (type==='response.failed'||type==='response.incomplete'||type==='error'){
          failed=true;
          throw new Error('ChatGPT 번역 요청이 완료되지 않았습니다. 사용량·권한 또는 네트워크 상태를 확인해 주세요.');
        } else if(type==='response.completed') completed=true;
      }
    }
    if(failed||!completed||!output.trim())throw new Error('ChatGPT 응답이 정상 완료되지 않았습니다.');
    return output;
  } finally { try{await reader.cancel()}catch{} }
}

module.exports={verifyIdToken,parseModelCatalog,readResponseStream};
