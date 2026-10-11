'use strict';
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {SIWC,newAttempt,acceptCallback,tokenExchange,canInvoke,translationRequest}=require('./siwc-contract.cjs');
const {verifyIdToken,parseModelCatalog,readResponseStream}=require('./siwc-oidc.cjs');

// Only an explicit user click starts OAuth or sends subtitle data. No ChatGPT web
// cookies, DOM, browser sessions or existing LilacAnime userData are inspected.
function createSIWCService({app,shell,safeStorage,fetchImpl=globalThis.fetch,now=Date.now}){
  if(!app?.getPath||!shell?.openExternal)throw new TypeError('SIWC requires Electron main process');
  const home=path.join(app.getPath('userData'),'siwc-account');
  const metaFile=path.join(home,'host.json'),tokenFile=path.join(home,'credential.enc');
  let account=null,loaded=false,pending=null,authError='',models=[];
  let authSerial=0;
  const available=()=>Boolean(safeStorage?.isEncryptionAvailable?.() && safeStorage?.encryptString && safeStorage?.decryptString);
  function ensureHome(){fs.mkdirSync(home,{recursive:true,mode:0o700});if(fs.lstatSync(home).isSymbolicLink())throw new Error('SIWC 폴더 링크는 지원하지 않습니다.');}
  function atomicFile(file,data){
    ensureHome();
    const tmp=file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
    try{
      fs.writeFileSync(tmp,data,{flag:'wx',mode:0o600});
      fs.renameSync(tmp,file);
    }finally{try{fs.unlinkSync(tmp)}catch{}}
  }
  function load(){
    if(loaded)return;loaded=true;
    if(!available())return;
    try{
      const encrypted=fs.readFileSync(tokenFile);
      const value=JSON.parse(safeStorage.decryptString(encrypted));
      if(typeof value?.access_token==='string' && /^oaiapp_[\w-]+$/.test(value.clientId) &&
         typeof value.subject==='string' && typeof value.refresh_token==='string'){
        account=value;
      }
    }catch(error){if(error.code!=='ENOENT')authError='이전에 저장한 ChatGPT 연결을 안전하게 읽지 못했습니다.';}
  }
  function save(record){
    if(!available())throw new Error('OS 보안 암호화를 사용할 수 없어 계정 연결을 저장하지 않습니다.');
    atomicFile(tokenFile,safeStorage.encryptString(JSON.stringify(record)));account=record;
  }
  function hostId(){
    let meta;
    try{meta=JSON.parse(fs.readFileSync(metaFile,'utf8'))}catch{}
    if(meta && /^urn:uuid:[0-9a-f-]{36}$/i.test(meta.id))return meta.id;
    const id='urn:uuid:'+crypto.randomUUID();
    atomicFile(metaFile,Buffer.from(JSON.stringify({id}),'utf8'));
    return id;
  }
  function status(){
    load();
    return {
      connected:Boolean(account),pending:Boolean(pending),available:available(),
      authorized:Boolean(account && canInvoke({access_token:account.access_token,scope:account.scope})),
      email:account?.email||'',models:models.slice(),error:authError,
      message:!available()?'OS 보안 암호화를 사용할 수 없어 ChatGPT 로그인을 시작할 수 없습니다.':
        pending?'브라우저에서 ChatGPT 계정 승인 중입니다.':
        account? 'ChatGPT 계정이 연결됐습니다.':authError||'ChatGPT 계정 연결 전입니다.'
    };
  }
  async function json(url,options={}){
    if(typeof fetchImpl!=='function')throw new Error('네트워크 요청을 사용할 수 없습니다.');
    const response=await fetchImpl(url,{...options,signal:AbortSignal.timeout(30_000)});
    if(!response.ok)throw new Error('ChatGPT 인증/모델 요청 실패 (HTTP '+response.status+'). 계정 권한과 이용 자격을 확인해 주세요.');
    const body=await response.json();
    if(!body||typeof body!=='object')throw new Error('ChatGPT 서버 응답을 확인할 수 없습니다.');
    return body;
  }
  async function exchange(auth,callback){
    const accepted=acceptCallback(callback,auth.attempt);
    const req=tokenExchange(accepted,auth.attempt);
    const tokens=await json(req.url,{method:'POST',headers:req.headers,body:req.body});
    if(!tokens?.id_token||!tokens?.access_token||typeof tokens?.scope!=='string')
      throw new Error('ChatGPT 인증 서버가 필수 토큰/권한을 반환하지 않았습니다.');
    const jwks=await json(SIWC.jwks);
    const identity=verifyIdToken(tokens.id_token,{clientId:accepted.clientId,nonce:auth.attempt.nonce,jwks,now:now()});
    if(account && auth.attempt.clientId!=='dynamic_agent_client' && account.subject!==identity.subject)
      throw new Error('기존 ChatGPT 연결과 다른 계정입니다. 기존 연결은 유지했습니다.');
    const record={
      clientId:accepted.clientId,hostId:auth.attempt.hostId,subject:identity.subject,email:identity.email,
      id_token:tokens.id_token,access_token:tokens.access_token,refresh_token:tokens.refresh_token||'',
      scope:tokens.scope,expiresAt:now()+Math.max(30,Number(tokens.expires_in)||3600)*1000
    };
    if(!record.refresh_token)throw new Error('재로그인용 권한이 없어 연결을 저장하지 않았습니다.');
    if(pending!==auth)throw new Error('취소된 계정 연결입니다.');
    save(record);models=[];authError='';
    return status();
  }
  async function connect(){
    if(!available())throw new Error('OS 보안 암호화가 비활성화되어 ChatGPT 계정을 안전하게 연결할 수 없습니다.');
    load();
    if(pending)return status();
    const current=account;
    const auth={server:null,timer:null,attempt:null,serial:++authSerial};
    pending=auth;authError='';
    try {
      const server=http.createServer(async(req,res)=>{
        if(req.method!=='GET'||!req.url||req.url.length>8192||!req.url.startsWith('/auth/callback?')){
          res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Not found');return;
        }
        try {
          // The OAuth response must bind to our exact attempt before any token exchange.
          const callback='http://127.0.0.1:'+server.address().port+req.url;
          await exchange(auth,callback);
          res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
          res.end('ChatGPT 계정이 연결됐습니다. LilacAnime로 돌아가세요.');
        }catch(error){
          authError=error.message||'ChatGPT 로그인에 실패했습니다.';
          res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
          res.end('ChatGPT 계정 연결을 완료하지 못했습니다. LilacAnime에서 상태를 확인해 주세요.');
        }finally{
          if(pending===auth){pending=null;clearTimeout(auth.timer);server.close();}
        }
      });
      auth.server=server;
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
      const redirectUri='http://127.0.0.1:'+server.address().port+'/auth/callback';
      const generated=newAttempt({hostId:current?.hostId||hostId(),redirectUri,issuedClientId:current?.clientId||null});
      auth.attempt=generated.attempt;
      if(current?.id_token) {
        const u=new URL(generated.authorizeUrl);
        u.searchParams.set('id_token_hint',current.id_token);
        generated.authorizeUrl=u.toString();
      }
      auth.timer=setTimeout(()=>{
        if(pending===auth){pending=null;authError='계정 승인 대기 시간이 끝났습니다.';server.close();}
      },180_000);
      auth.timer.unref?.();
      await shell.openExternal(generated.authorizeUrl);
      return status();
    }catch(error){
      if(pending===auth)pending=null;
      clearTimeout(auth.timer);try{auth.server?.close()}catch{}
      authError='ChatGPT 로그인 시작 실패: '+error.message;
      throw new Error(authError);
    }
  }
  async function refreshIfNeeded(){
    load();if(!account)throw new Error('ChatGPT 계정을 먼저 연결해 주세요.');
    if(now()+60_000<account.expiresAt)return account;
    const current=account;
    const body=new URLSearchParams({grant_type:'refresh_token',client_id:current.clientId,refresh_token:current.refresh_token,resource:SIWC.resource});
    const next=await json(SIWC.token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()});
    if(!next?.access_token || typeof next.scope!=='string')throw new Error('ChatGPT 권한 갱신에 실패했습니다. 다시 로그인해 주세요.');
    if(account!==current)throw new Error('계정이 변경돼 이전 갱신은 무시했습니다.');
    save({...current,access_token:next.access_token,refresh_token:next.refresh_token||current.refresh_token,
      scope:next.scope,expiresAt:now()+Math.max(30,Number(next.expires_in)||3600)*1000});
    return account;
  }
  async function listModels(){
    const current=await refreshIfNeeded();
    if(!canInvoke({access_token:current.access_token,scope:current.scope}))
      throw new Error('이 계정은 ChatGPT 플랜 AI 요청 권한이 없습니다.');
    const result=await json(SIWC.resource+'/models',{headers:{Authorization:'Bearer '+current.access_token}});
    if(account!==current)throw new Error('계정이 변경됐습니다.');
    models=parseModelCatalog(result);
    return models.slice();
  }
  async function translate({model,prompt}={}){
    const current=await refreshIfNeeded();
    if(!canInvoke({access_token:current.access_token,scope:current.scope}))
      throw new Error('ChatGPT AI 요청 권한이 승인되지 않았습니다.');
    if(!models.some(m=>m.id===model)) await listModels();
    const input=translationRequest(model,prompt,models.map(m=>m.id));
    const response=await fetchImpl(SIWC.responses,{
      method:'POST',headers:{Authorization:'Bearer '+account.access_token,'Content-Type':'application/json'},
      body:JSON.stringify(input),signal:AbortSignal.timeout(180_000)
    });
    if(!response.ok)throw new Error('ChatGPT 번역 서버 오류 (HTTP '+response.status+'). 계정 사용량을 확인해 주세요.');
    const translated=await readResponseStream(response.body);
    if(account!==current)throw new Error('계정이 변경돼 번역 결과를 폐기했습니다.');
    return translated;
  }
  function disconnect(){
    if(pending){clearTimeout(pending.timer);pending.server?.close();pending=null;}
    load();account=null;models=[];authError='';
    // Only explicitly delete the credential file owned by this SIWC option.
    try{fs.unlinkSync(tokenFile)}catch(error){if(error.code!=='ENOENT')throw error;}
    return status();
  }
  function close(){if(pending){clearTimeout(pending.timer);pending.server?.close();pending=null;}}
  return {status,connect,disconnect,listModels,translate,close};
}
function registerSIWCHandlers({ipcMain,app,shell,safeStorage,fetchImpl}){
  const service=createSIWCService({app,shell,safeStorage,fetchImpl});
  ipcMain.handle('siwc:status',()=>service.status());
  ipcMain.handle('siwc:connect',()=>service.connect());
  ipcMain.handle('siwc:disconnect',()=>service.disconnect());
  ipcMain.handle('siwc:models',()=>service.listModels());
  ipcMain.handle('siwc:translate',(_,value)=>service.translate(value));
  if(typeof app.once==='function')app.once('before-quit',()=>service.close());
  return service;
}
module.exports={createSIWCService,registerSIWCHandlers};
