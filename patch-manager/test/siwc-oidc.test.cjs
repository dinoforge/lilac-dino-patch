'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {verifyIdToken,parseModelCatalog,readResponseStream}=require('../../electron/siwc-oidc.cjs');

function signedToken(privateKey,claims) {
  const header=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:'unit-key'})).toString('base64url');
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signed=header+'.'+payload;
  return signed+'.'+crypto.sign('RSA-SHA256',Buffer.from(signed),privateKey).toString('base64url');
}
test('verify ID token RSA signature, issuer, audience, exp and nonce',()=>{
  const {publicKey,privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const jwks={keys:[{...publicKey.export({format:'jwk'}),kid:'unit-key',alg:'RS256',use:'sig'}]};
  const base={iss:'https://auth.openai.com',aud:'oaiapp_sample',sub:'mock-subject',email:'mock@example.invalid',
    nonce:'random-nonce',iat:Math.floor(Date.now()/1000)-30,exp:Math.floor(Date.now()/1000)+300};
  const verify=payload=>verifyIdToken(signedToken(privateKey,payload),{clientId:'oaiapp_sample',nonce:'random-nonce',jwks});
  assert.equal(verify(base).subject,'mock-subject');
  for(const change of [{nonce:'wrong'},{aud:'oaiapp_other'},{iss:'https://not-openai.invalid'},
    {exp:0},{iat:Math.floor(Date.now()/1000)+600}]){
    assert.throws(()=>verify({...base,...change}));
  }
  const {privateKey:rogue}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  assert.throws(()=>verifyIdToken(signedToken(rogue,base),{clientId:'oaiapp_sample',nonce:'random-nonce',jwks}),/signature/);
});
test('only listed account-specific models are returned',()=>{
  assert.deepEqual(parseModelCatalog({models:[
    {slug:'model-1',display_name:'첫 모델',visibility:'list'},
    {slug:'hidden',display_name:'비공개 모델',visibility:'hidden'},
    {slug:'model-2',visibility:'list'}
  ]}),[{id:'model-1',name:'첫 모델'},{id:'model-2',name:'model-2'}]);
  assert.throws(()=>parseModelCatalog({data:[]}),/model list/);
});
function sse(content,chunks=1){
  const encoded=new TextEncoder().encode(content);
  return new ReadableStream({start(controller){
    for(let i=0;i<chunks;i++)controller.enqueue(encoded.slice(Math.floor(i*encoded.length/chunks),Math.floor((i+1)*encoded.length/chunks)));
    controller.close();
  }});
}
test('SSE translates only after response.completed and combines fragmented chunks',async()=>{
  const input='data: '+JSON.stringify({type:'response.output_text.delta',delta:'{"translations":[{"id":1,'})+'\n\n'+
    'data: '+JSON.stringify({type:'response.output_text.delta',delta:'"text":"안녕"}]}'})+'\n\n'+
    'data: '+JSON.stringify({type:'response.completed'})+'\n\n';
  const result=await readResponseStream(sse(input,15));
  assert.deepEqual(JSON.parse(result),{translations:[{id:1,text:'안녕'}]});
  await assert.rejects(readResponseStream(sse('data: '+JSON.stringify({type:'response.output_text.delta',delta:'Hello'})+'\n\n')),/정상 완료/);
  await assert.rejects(readResponseStream(sse('data: '+JSON.stringify({type:'response.failed'})+'\n\n')),/완료되지/);
});
