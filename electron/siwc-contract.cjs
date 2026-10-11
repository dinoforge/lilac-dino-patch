'use strict';

// SIWC protocol contract only. This module NEVER starts OAuth, opens a browser,
// stores a token, or issues a request. Production connectivity requires the
// app's eligibility, user consent, loopback listener and secured credential
// lifecycle to be separately implemented and end-to-end verified.
const crypto = require('node:crypto');

const SIWC = Object.freeze({
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  jwks: 'https://auth.openai.com/.well-known/jwks.json',
  issuer: 'https://auth.openai.com',
  resource: 'https://api.openai.com/v1',
  responses: 'https://api.openai.com/v1/responses',
  scopes: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
});

function validateCallbackUri(uri) {
  const parsed = new URL(String(uri));
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
      !parsed.port || parsed.pathname !== '/auth/callback' ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('SIWC callback must be http://127.0.0.1:<port>/auth/callback');
  }
  return parsed.origin + parsed.pathname;
}

function newAttempt({hostId, redirectUri, issuedClientId = null, agentName = 'LilacAnime Player'} = {}) {
  const host = String(hostId || '');
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(host)) {
    throw new Error('Stable SIWC host ID is required');
  }
  const callback = validateCallbackUri(redirectUri);
  if (issuedClientId !== null && !/^oaiapp_[a-zA-Z0-9_-]+$/.test(issuedClientId)) throw new Error('Issued client ID is invalid');
  const clientId = issuedClientId || 'dynamic_agent_client';
  const state = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(SIWC.authorize);
  for (const [key,value] of Object.entries({
    client_id: clientId,
    ext_agent_host_id: host,
    response_type: 'code',
    redirect_uri: callback,
    scope: SIWC.scopes,
    resource: SIWC.resource,
    state, nonce,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge
  })) url.searchParams.set(key, value);
  if (!issuedClientId) url.searchParams.set('agent_name_hint', agentName);
  return { authorizeUrl: url.toString(), attempt: { clientId, hostId: host, redirectUri: callback, state, nonce, verifier } };
}

function acceptCallback(callbackUrl, attempt) {
  if (!attempt || !attempt.state || !attempt.redirectUri) throw new Error('No active SIWC attempt');
  const incoming = new URL(String(callbackUrl));
  if (incoming.origin + incoming.pathname !== attempt.redirectUri || incoming.hash ||
      incoming.protocol !== 'http:' || incoming.hostname !== '127.0.0.1') {
    throw new Error('Unexpected SIWC callback origin or path');
  }
  const providedState = Buffer.from(incoming.searchParams.get('state') || '');
  const expectedState = Buffer.from(attempt.state);
  if (providedState.length !== expectedState.length || !crypto.timingSafeEqual(providedState, expectedState)) {
    throw new Error('SIWC state mismatch');
  }
  const error = incoming.searchParams.get('error');
  if (error) throw new Error('SIWC authorization rejected: ' + error);
  const code = incoming.searchParams.get('code');
  if (!code || code.length > 4096) throw new Error('Missing SIWC authorization code');
  const returned = incoming.searchParams.get('client_id');
  if (attempt.clientId === 'dynamic_agent_client') {
    if (!returned || !/^oaiapp_[a-zA-Z0-9_-]+$/.test(returned)) throw new Error('SIWC dynamic registration did not return an issued client ID');
  } else if (returned && returned !== attempt.clientId) {
    throw new Error('SIWC client ID changed during authorization');
  }
  return { code, clientId: attempt.clientId === 'dynamic_agent_client' ? returned : attempt.clientId };
}

function tokenExchange({code, clientId}, attempt) {
  if (!attempt?.verifier || !attempt.redirectUri || !code ||
      !/^oaiapp_[a-zA-Z0-9_-]+$/.test(clientId || '')) throw new Error('SIWC token exchange cannot proceed');
  return {
    url: SIWC.token,
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: clientId, code,
      code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: SIWC.resource
    }).toString()
  };
}

function grantedScopes(response) {
  return new Set(String(response?.scope || '').split(/\s+/).filter(Boolean));
}

function canInvoke(response) {
  const scopes = grantedScopes(response);
  return Boolean(response?.access_token && scopes.has('chatgpt.tokens.use.direct') && scopes.has('resource.invoke'));
}

function translationRequest(model, prompt, permittedModels) {
  if (typeof model !== 'string' || !Array.isArray(permittedModels) ||
      !permittedModels.includes(model)) throw new Error('Selected model is not in this account catalog');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 150000) {
    throw new Error('Translation prompt is invalid');
  }
  // SIWC preview requires both store:false and stream:true and rejects
  // background and conversation fields. Do not connect web ChatGPT sessions.
  return {
    model,
    input: [{role:'user', content: prompt}],
    store: false,
    stream: true
  };
}

module.exports = { SIWC, validateCallbackUri, newAttempt, acceptCallback, tokenExchange, grantedScopes, canInvoke, translationRequest };
