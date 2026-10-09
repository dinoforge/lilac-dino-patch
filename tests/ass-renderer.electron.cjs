// Synthetic Electron/JASSUB smoke test; run with: node node_modules/electron/cli.js tests/ass-renderer.electron.cjs
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repo = path.resolve(__dirname, '..');
const dist = path.join(repo, 'dist');
fs.mkdirSync(dist, { recursive: true });
const dir = path.join(dist, 'ass-renderer-smoke');
fs.mkdirSync(dir, { recursive: true });
const userData = path.join(dir, 'profile');
const fontFile = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'malgun.ttf');
assert.ok(fs.existsSync(fontFile), 'Windows Korean fallback font is installed');
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

app.setPath('userData', userData);
app.disableHardwareAcceleration();
const blockedRequests = [];
function fail(error) { console.error(error.stack || error); process.exitCode = 1; app.exit(1); }

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^(?:file:|data:|blob:)/i.test(details.url)) callback({ cancel: false });
    else { blockedRequests.push(details.url); callback({ cancel: true }); }
  });

  const subtitle = path.join(dir, 'korean.ass');
  fs.writeFileSync(subtitle, [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 640', 'PlayResY: 360',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Malgun Gothic,42,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,30,30,22,1',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:00.00,0:00:30.00,Default,,0,0,0,,한국어 자막',
    ''
  ].join('\r\n'), 'utf8');

  const srcBase = pathToFileURL(path.join(repo, 'src') + path.sep).href;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><base href="${srcBase}">
    <style>html,body{margin:0;width:800px;height:500px;background:#000;overflow:hidden}video{position:absolute;left:80px;top:70px;width:640px;height:360px;object-fit:fill}</style>
    <script type="module" src="ass-renderer.js"></script></head><body><video id="video" muted playsinline></video></body></html>`;
  const htmlFile = path.join(dir, 'player.html');
  fs.writeFileSync(htmlFile, html, 'utf8');

  const win = new BrowserWindow({ show: false, width: 800, height: 500,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(htmlFile);
  let rendererReady = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    rendererReady = await win.webContents.executeJavaScript('Boolean(window.LilacAss)');
    if (rendererReady) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(rendererReady, true, 'the production ASS renderer module loaded');

  const videoReady = await win.webContents.executeJavaScript(`(async () => {
    const video = document.querySelector('#video');
    const frame = document.createElement('canvas'); frame.width = 640; frame.height = 360;
    const context = frame.getContext('2d'); context.fillStyle = '#000'; context.fillRect(0, 0, 640, 360);
    video.srcObject = frame.captureStream(15); await video.play();
    if (!video.videoWidth) await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Synthetic video metadata timed out')), 5000);
      video.addEventListener('loadedmetadata', () => { clearTimeout(timeout); resolve(); }, {once:true});
    });
    return {width: video.videoWidth, height: video.videoHeight};
  })()`);
  assert.deepEqual(videoReady, { width: 640, height: 360 });

  const attached = await win.webContents.executeJavaScript(`window.LilacAss.attach(
    document.querySelector('#video'),
    {subUrl:${JSON.stringify(pathToFileURL(subtitle).href)},fonts:[${JSON.stringify(pathToFileURL(fontFile).href)}],visible:true}
  )`);
  assert.equal(attached, true, 'JASSUB worker becomes ready and attaches to the synthetic video');
  await new Promise(resolve => setTimeout(resolve, 1200));
  await win.webContents.executeJavaScript(`window.LilacAss.frame(document.querySelector('#video'))`);
  await new Promise(resolve => setTimeout(resolve, 800));

  const shot = await win.webContents.capturePage();
  const size = shot.getSize(), pixels = shot.toBitmap();
  const rendererState = await win.webContents.executeJavaScript(`(() => {
    const canvas = document.querySelector('canvas.JASSUB'), rect = canvas?.getBoundingClientRect();
    const video = document.querySelector('#video');
    return {active:window.LilacAss.active, currentTime:video.currentTime, readyState:video.readyState,
      video:{width:video.videoWidth,height:video.videoHeight},
      canvas:canvas&&{width:canvas.width,height:canvas.height,visibility:canvas.style.visibility,
        rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}};
  })()`);
  console.log(`Renderer state: ${JSON.stringify(rendererState)}`);
  let brightSubtitlePixels = 0, minX = size.width, maxX = -1, minY = size.height, maxY = -1;
  for (let y = Math.floor(size.height * 0.55); y < size.height * 0.92; y++) {
    for (let x = Math.floor(size.width * 0.1); x < size.width * 0.9; x++) {
      const at = (y * size.width + x) * 4;
      if (pixels[at] > 190 && pixels[at + 1] > 190 && pixels[at + 2] > 190) {
        brightSubtitlePixels++; minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  assert.ok(brightSubtitlePixels > 100, `Korean ASS subtitle pixels are visible (${brightSubtitlePixels})`);
  assert.ok(minY > size.height * 0.55 && maxY < size.height * 0.92, `subtitle is in the lower video area (${minY}-${maxY})`);
  assert.deepEqual(blockedRequests, [], `external requests were blocked: ${blockedRequests.join(', ')}`);
  await win.webContents.executeJavaScript('window.LilacAss.destroy()');
  win.destroy(); app.quit();
  console.log(`JASSUB rendered Korean ASS subtitle: ${brightSubtitlePixels} bright pixels, bounds ${minX}-${maxX} x ${minY}-${maxY}`);
  console.log('External HTTP(S) attempts: 0');
}).catch(fail);
