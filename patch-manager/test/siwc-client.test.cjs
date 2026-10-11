'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const crypto=require('node:crypto');
const {createSIWCService}=require('../../electron/siwc-client.cjs');

const {publicKey,privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'siwc-test-key',alg:'RS256',use:'sig'};
function jwt(nonce){
  const now=Math.floor(Date.now()/1000);
  const head=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:jwk.kid})).toString('base64url');
  const body=Buffer.from(JSON.stringify({
    iss:'https://auth.openai.com',aud:'oaiapp_mockclient',nonce,sub:'mock-user',
    email:'tester@example.invalid',iat:now-10,exp:now+3600
  })).toString('base64url');
  const signing=head+'.'+body;
  return signing+'.'+crypto.sign('RSA-SHA256',Buffer.from(signing),privateKey).toString('base64url');
}
function json(value){return{ok:true,json:async()=>value};}
function stream(value){
  const text='data: '+JSON.stringify({type:'response.output_text.delta',delta:value})+'\n\n'+
    'data: '+JSON.stringify({type:'response.completed'})+'\n\n';
  return new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(text));controller.close();}});
}
test('explicit SIWC OAuth start -> loopback -> signed identity -> model -> translation -> disconnect',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'siwc-bridge-test-'));
  const sentinel=path.join(root,'untouched.txt');fs.writeFileSync(sentinel,'preserve');
  let authUrl,callbackDone,tokenCalls=0,modelsCalls=0,translationRequests=[];
  const fetchImpl=async(url,options={})=>{
    if(url==='https://auth.openai.com/api/accounts/oauth/token'){
      tokenCalls++;
      const params=new URLSearchParams(options.body);
      assert.equal(params.get('code'),'mock-auth-code');
      assert.equal(params.get('client_id'),'oaiapp_mockclient');
      assert.equal(params.get('resource'),'https://api.openai.com/v1');
      assert.ok(params.get('code_verifier'));
      return json({id_token:jwt(new URL(authUrl).searchParams.get('nonce')),
        access_token:'mock-access-token',refresh_token:'mock-refresh-token',
        scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',expires_in:3600});
    }
    if(url==='https://auth.openai.com/.well-known/jwks.json')return json({keys:[jwk]});
    if(url==='https://api.openai.com/v1/models'){
      modelsCalls++;assert.equal(options.headers.Authorization,'Bearer mock-access-token');
      return json({models:[{slug:'test-model',display_name:'테스트 모델',visibility:'list'},
        {slug:'hidden-model',visibility:'hidden'}]});
    }
    if(url==='https://api.openai.com/v1/responses'){
      const request=JSON.parse(options.body);
      assert.equal(request.store,false);assert.equal(request.stream,true);
      assert.equal(request.model,'test-model');
      assert.equal(options.headers.Authorization,'Bearer mock-access-token');
      translationRequests.push(request);
      return {ok:true,body:stream('{"translations":[{"id":1,"text":"안녕하세요"}]}')};
    }
    throw Error('Unexpected external endpoint: '+url);
  };
  const safeStorage={
    isEncryptionAvailable:()=>true,
    encryptString:text=>Buffer.from(text,'utf8'),
    decryptString:data=>data.toString('utf8')
  };
  const shell={openExternal:async(url)=>{
    authUrl=url;
    const u=new URL(url);
    assert.equal(u.origin,'https://auth.openai.com');
    const callback=u.searchParams.get('redirect_uri')+'?code=mock-auth-code&state='+
      encodeURIComponent(u.searchParams.get('state'))+'&client_id=oaiapp_mockclient';
    callbackDone=new Promise((resolve,reject)=>{
      http.get(callback,res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');
        if(res.statusCode===200)resolve(text);else reject(Error(text));
      });}).on('error',reject);
    });
  }};
  const app={getPath(name){assert.equal(name,'userData');return root;}};
  const service=createSIWCService({app,shell,safeStorage,fetchImpl});
  try {
    assert.equal(service.status().connected,false);
    assert.equal(fs.existsSync(path.join(root,'siwc-account')),false);
    const pending=await service.connect();assert.equal(pending.pending,true);
    await callbackDone;
    assert.equal(service.status().connected,true);
    assert.equal(service.status().authorized,true);
    assert.equal(service.status().email,'tester@example.invalid');
    assert.equal(tokenCalls,1);
    const models=await service.listModels();
    assert.deepEqual(models,[{id:'test-model',name:'테스트 모델'}]);
    assert.equal(modelsCalls,1);
    assert.equal(await service.translate({model:'test-model',prompt:'한국어로 번역해 주세요'}),
      '{"translations":[{"id":1,"text":"안녕하세요"}]}');
    assert.equal(translationRequests.length,1);
    assert.equal(service.disconnect().connected,false);
    assert.equal(fs.readFileSync(sentinel,'utf8'),'preserve');
    assert.equal(fs.existsSync(path.join(root,'siwc-account','credential.enc')),false);
  } finally {service.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('no protected credential store means fail closed without browser or profile writes',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'siwc-disabled-test-'));
  let opened=0;
  const service=createSIWCService({
    app:{getPath:()=>root},
    shell:{openExternal:async()=>{opened++;}},
    safeStorage:{isEncryptionAvailable:()=>false},
    fetchImpl:async()=>{throw Error('Network must never run');}
  });
  try {
    assert.equal(service.status().available,false);
    await assert.rejects(service.connect(),/OS 보안 암호화/);
    assert.equal(opened,0);
    assert.equal(fs.readdirSync(root).length,0);
  }finally{service.close();fs.rmSync(root,{recursive:true,force:true});}
});
