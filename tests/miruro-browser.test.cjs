const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),vm=require('node:vm');
const {createMiruroBrowser}=require('../electron/miruro-browser.cjs');

test('document transport shares bootstrap and preserves binary bytes and error status',async()=>{
 let windows=0,loads=0;const requests=[];
 const binary=Buffer.from([0,255,128,13,10,42]);
 class Window extends EventEmitter{
  constructor(options){super();windows++;assert.equal(options.show,false);assert.equal(options.webPreferences.nodeIntegration,false);this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};this.webContents.mainFrame={executeJavaScript:async script=>vm.runInNewContext(script,{location:{origin:'https://www.miruro.to'},fetch:async(url,options)=>{requests.push(url);assert.equal(options.credentials,'include');const status=Number(new URL(url).searchParams.get('status'))||200;return new Response(binary,{status,headers:{'content-type':'application/octet-stream'}})},AbortSignal,Uint8Array,String,Array,btoa})};}
  async loadURL(){loads++;setImmediate(()=>this.webContents.emit('dom-ready'))}
  isDestroyed(){return Boolean(this.dead)}
  destroy(){this.dead=true;this.emit('closed')}
 }
 const request=createMiruroBrowser({BrowserWindow:Window});
 const urls=['https://www.miruro.to/api/v1/anime?limit=15','https://www.miruro.to/api/v1/schedule'];
 const results=await Promise.all(urls.map(request));
 assert.equal(windows,1);assert.equal(loads,1);
 results.forEach(result=>{assert.equal(result.response.status,200);assert.deepEqual(result.body,binary)});
 for(const status of [403,429]){
  const denied=await request(`https://www.miruro.to/api/v1/anime?status=${status}`);
  assert.equal(denied.response.ok,false);assert.equal(denied.response.status,status);
 }
 await assert.rejects(request('https://example.com/api/v1/anime'),/허용되지/);
 assert.equal(windows,1,'access-denied responses do not open a verification window or retry on another host');
 request.close();
 await request(urls[0]);assert.equal(windows,2);request.close();
});

test('failed page bootstrap is removed so the next attempt can reconnect',async()=>{
 let attempts=0,destroyed=0;
 class Window extends EventEmitter{
  constructor(){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};}
  isDestroyed(){return Boolean(this.dead)}
  destroy(){this.dead=true;destroyed++;this.emit('closed')}
  async loadURL(){attempts++;throw Error('ERR_NAME_NOT_RESOLVED')}
 }
 const request=createMiruroBrowser({BrowserWindow:Window});
 for(let i=0;i<2;i++)await assert.rejects(request('https://www.miruro.to/api/v1/anime'),/ERR_NAME_NOT_RESOLVED/);
 assert.equal(attempts,2);assert.equal(destroyed,2);
});

test('closing a Miruro window during page bootstrap does not access destroyed webContents',async()=>{
 let destroyed=0;
 class Window extends EventEmitter{
  constructor(){
   super();
   this.dead=false;
   this.contents=new EventEmitter();
   this.contents.dead=false;
   this.contents.isDestroyed=()=>this.contents.dead;
   this.contents.setWindowOpenHandler=()=>{};
   Object.defineProperty(this,'webContents',{get:()=>{
    if(this.dead)throw new TypeError('Object has been destroyed');
    return this.contents;
   }});
  }
  isDestroyed(){return this.dead}
  destroy(){this.dead=true;this.contents.dead=true;destroyed++;this.emit('closed')}
  loadURL(){return new Promise(()=>{})}
 }
 const request=createMiruroBrowser({BrowserWindow:Window});
 const pending=request('https://www.miruro.to/api/v1/anime');
 request.close();
 await assert.rejects(pending,/Miruro 요청 창이 닫혔습니다/);
 assert.equal(destroyed,1);
});
