// Windows Electron Picture-in-Picture capability smoke using generated local frames only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

const tempRoot = path.resolve(process.env.LILAC_PIP_NATIVE_ROOT || '');
const externalRequests = [];
let win = null;
let failureCode = 0;

if (!process.env.LILAC_PIP_NATIVE_ROOT || path.dirname(tempRoot) !== path.resolve(os.tmpdir())
  || !path.basename(tempRoot).startsWith('lilac-pip-native-') || !fs.statSync(tempRoot).isDirectory()) {
  console.error('Refusing an invalid isolated PIP test profile path.');
  app.exit(1);
}
app.setPath('userData', path.join(tempRoot, 'profile'));
app.setPath('sessionData', path.join(tempRoot, 'session'));
app.commandLine.appendSwitch('disable-background-networking');

async function waitFor(label, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function dispatchClick(selector) {
  const point = await win.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`);
  assert.ok(point, `visible control exists: ${selector}`);
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x, y: point.y, button: 'none'
  });
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1
  });
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1
  });
}

async function run() {
  assert.equal(process.platform, 'win32', 'this smoke verifies the Windows Electron runtime');
  await app.whenReady();
  fs.mkdirSync(path.join(tempRoot, 'profile'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'session'), { recursive: true });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    externalRequests.push(details.url);
    callback({ cancel: true });
  });

  win = new BrowserWindow({
    show: false,
    width: 440,
    height: 300,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>
    html,body{margin:0;width:100%;height:100%;background:#15111c;color:#fff;font:16px sans-serif}main{height:100%;display:grid;place-content:center;gap:12px;text-align:center}canvas{width:320px;height:180px;border-radius:8px}button{padding:10px 18px}
  </style></head><body><main><canvas id="picture" width="640" height="360"></canvas><button id="enter">PIP 열기</button></main><script>
    const canvas=document.querySelector('#picture'),ctx=canvas.getContext('2d'),video=document.createElement('video');
    video.muted=true;video.playsInline=true;const stream=canvas.captureStream(30);window.__pipStream=stream;video.srcObject=stream;
    let tick=0;const draw=()=>{ctx.fillStyle='#352447';ctx.fillRect(0,0,640,360);ctx.fillStyle='#c8a2c8';ctx.fillRect((tick++%80)*6,140,80,20);ctx.fillStyle='white';ctx.font='bold 30px sans-serif';ctx.textAlign='center';ctx.fillText('합성 한국어 자막',320,310)};
    draw();const timer=setInterval(draw,1000/30);
    document.querySelector('#enter').addEventListener('click',async()=>{try{await video.play();await video.requestPictureInPicture();document.body.dataset.state='entered'}catch(error){document.body.dataset.error=error?.message||String(error);document.body.dataset.state='failed'}});
    video.addEventListener('leavepictureinpicture',()=>{clearInterval(timer);video.pause();stream.getTracks().forEach(track=>track.stop());video.srcObject=null;document.body.dataset.state='left'});
  </script></body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const capability = await win.webContents.executeJavaScript(`({
    enabled: document.pictureInPictureEnabled,
    captureStream: typeof HTMLCanvasElement.prototype.captureStream === 'function',
    requestPictureInPicture: typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function'
  })`);
  assert.equal(capability.enabled, true, JSON.stringify(capability));
  assert.equal(capability.captureStream, true, JSON.stringify(capability));
  assert.equal(capability.requestPictureInPicture, true, JSON.stringify(capability));

  win.show();
  win.focus();
  await win.webContents.debugger.attach('1.3');
  await dispatchClick('#enter');
  const entered = await waitFor('native Picture-in-Picture entry', () => win.webContents.executeJavaScript(`(() => {
    const video=document.pictureInPictureElement;
    if (document.body.dataset.state === 'failed') return { error: document.body.dataset.error || 'unknown' };
    return video ? { entered: true, width: video.videoWidth, height: video.videoHeight, readyState: video.readyState } : null;
  })()`));
  assert.equal(entered.entered, true, JSON.stringify(entered));
  assert.ok(entered.width > 0 && entered.height > 0, JSON.stringify(entered));

  await win.webContents.executeJavaScript('document.exitPictureInPicture()');
  const left = await waitFor('native Picture-in-Picture cleanup', () => win.webContents.executeJavaScript(`(() => {
    if (document.body.dataset.state !== 'left') return null;
    return {
      state: document.body.dataset.state,
      active: document.pictureInPictureElement !== null,
      paused: [...document.querySelectorAll('video')].every(video => video.paused),
      sourceReleased: [...document.querySelectorAll('video')].every(video => video.srcObject === null),
      trackEnded: window.__pipStream?.getTracks().every(track => track.readyState === 'ended') || false
    };
  })()`));
  assert.equal(left.state, 'left', JSON.stringify(left));
  assert.equal(left.active, false, JSON.stringify(left));
  assert.equal(left.paused, true, JSON.stringify(left));
  assert.equal(left.sourceReleased, true, JSON.stringify(left));
  assert.equal(left.trackEnded, true, JSON.stringify(left));
  assert.deepEqual(externalRequests, [], 'the native PIP smoke must make no HTTP(S) requests');
  console.log(`Native Electron PIP passed: ${process.platform}, Electron ${process.versions.electron}; ${entered.width}x${entered.height} generated canvas stream; isolated userData; external requests: 0.`);
}

run().catch(error => {
  console.error(error?.stack || error);
  failureCode = 1;
}).finally(async () => {
  try {
    if (win && !win.isDestroyed()) {
      await win.webContents.executeJavaScript('document.pictureInPictureElement && document.exitPictureInPicture()').catch(() => {});
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
      win.destroy();
    }
  } catch {}
  try { app.exit(failureCode); } catch { process.exitCode = failureCode; }
});
