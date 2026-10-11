'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {SIWC, newAttempt, acceptCallback, tokenExchange, canInvoke, translationRequest} = require('../../electron/siwc-contract.cjs');

const hostId = 'urn:uuid:7e9a3dd1-55e2-4dfc-bdb7-735748fa9331';
const redirectUri = 'http://127.0.0.1:1455/auth/callback';

test('SIWC is a separate PKCE flow and does not touch any existing translation mode', () => {
  const first = newAttempt({hostId, redirectUri});
  const second = newAttempt({hostId, redirectUri});
  assert.equal(new URL(first.authorizeUrl).origin, 'https://auth.openai.com');
  assert.notEqual(first.attempt.state, second.attempt.state);
  assert.notEqual(first.attempt.verifier, second.attempt.verifier);
  const url = new URL(first.authorizeUrl);
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), 'LilacAnime Player');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('ext_agent_host_id'), hostId);
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(url.searchParams.get('resource'), SIWC.resource);
  assert.ok(url.searchParams.get('scope').includes('chatgpt.tokens.use.direct'));
});

test('SIWC callback fails closed on origin, state, missing issued client ID and denial', () => {
  const {attempt} = newAttempt({hostId,redirectUri});
  const base = redirectUri + '?state=' + encodeURIComponent(attempt.state) + '&code=abc';
  assert.throws(() => acceptCallback(base, attempt), /issued client ID/);
  assert.throws(() => acceptCallback(base + '&client_id=dynamic_agent_client', attempt), /issued client ID/);
  assert.throws(() => acceptCallback('http://localhost:1455/auth/callback?state=' + attempt.state + '&code=abc&client_id=oaiapp_valid', attempt), /origin or path/);
  assert.throws(() => acceptCallback(redirectUri + '?state=wrong&code=abc&client_id=oaiapp_valid', attempt), /state mismatch/);
  assert.throws(() => acceptCallback(redirectUri + '?state=' + attempt.state + '&error=access_denied', attempt), /rejected/);
  const callback = acceptCallback(base + '&client_id=oaiapp_valid', attempt);
  assert.deepEqual(callback, {code:'abc',clientId:'oaiapp_valid'});
});

test('SIWC token exchange uses exact loopback callback, verifier, and no client secret', () => {
  const {attempt} = newAttempt({hostId,redirectUri});
  const request = tokenExchange({code:'abc',clientId:'oaiapp_valid'},attempt);
  assert.equal(request.url, 'https://auth.openai.com/api/accounts/oauth/token');
  const body = new URLSearchParams(request.body);
  assert.equal(body.get('code_verifier'),attempt.verifier);
  assert.equal(body.get('redirect_uri'),redirectUri);
  assert.equal(body.get('client_id'),'oaiapp_valid');
  assert.equal(body.get('resource'), SIWC.resource);
  assert.equal(body.has('client_secret'),false);
});

test('SIWC inference only after explicit plan scope and account model list', () => {
  assert.equal(canInvoke({access_token:'token',scope:'openid profile email'}),false);
  assert.equal(canInvoke({access_token:'token',scope:'openid chatgpt.tokens.use.direct'}),false);
  assert.equal(canInvoke({access_token:'token',scope:'openid chatgpt.tokens.use.direct resource.invoke'}),true);
  const request = translationRequest('available-model','번역 대상', ['available-model']);
  assert.equal(request.store,false);
  assert.equal(request.stream,true);
  assert.equal(request.input[0].content,'번역 대상');
  assert.equal(Object.hasOwn(request,'conversation'),false);
  assert.equal(Object.hasOwn(request,'background'),false);
  assert.throws(()=>translationRequest('unknown','번역 대상',['available-model']), /not in this account/);
});

test('rejects non-loopback callbacks and malformed host identifiers', () => {
  for(const uri of ['https://127.0.0.1:1455/auth/callback','http://localhost:1455/auth/callback','http://127.0.0.1:1455/callback']){
    assert.throws(()=>newAttempt({hostId,redirectUri:uri}),/callback must/);
  }
  assert.throws(()=>newAttempt({hostId:'not-a-host',redirectUri}),/host ID/);
});
