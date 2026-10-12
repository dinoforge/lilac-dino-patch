'use strict';

const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = path.resolve(process.env.LILAC_UNIFIED_CATALOG_TEMP_ROOT || '');
if (path.dirname(tempRoot) !== fs.realpathSync(os.tmpdir()) || !path.basename(tempRoot).startsWith('lilac-unified-catalog-electron-')) {
  throw new Error('Refusing unexpected isolated Electron test path.');
}
fs.mkdirSync(path.join(tempRoot, 'profile'), { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'session'), { recursive: true });
app.setPath('userData', path.join(tempRoot, 'profile'));
app.setPath('sessionData', path.join(tempRoot, 'session'));
app.disableHardwareAcceleration();
const blockedRequests = [];
let win;

function fail(error) {
  console.error(error?.stack || error);
  try { win?.destroy(); } catch {}
  app.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

function waitFor(label, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const result = await predicate();
        if (result) return resolve(result);
        if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${label}`));
        setTimeout(poll, 25);
      } catch (error) { reject(error); }
    };
    poll();
  });
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in actual-source fixture: ${entry.name}`);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
    else throw new Error(`Refusing unsupported actual-source entry: ${entry.name}`);
  }
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(path.join(tempRoot, 'profile'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'session'), { recursive: true });
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (/^(?:file:|data:|blob:)/i.test(details.url)) callback({ cancel: false });
      else { blockedRequests.push(details.url); callback({ cancel: true }); }
    });

    const repo = path.resolve(__dirname, '..'), assets = path.join(repo, 'src');
    for (const file of ['integrated-search.js', 'unified-catalog.js', 'unified-catalog.css']) fs.copyFileSync(path.join(assets, file), path.join(tempRoot, file));
    const mockScript = `window.__calls=[];window.__play=null;
      const record=(name,...args)=>window.__calls.push({name,args});
      const shared=(provider,id)=>({provider,id,mal_id:provider+':'+id,title:'통합 작품',title_english:'Unified Work',year:2026,type:'TV',anilistId:91,images:{webp:{large_image_url:''}}});
      const independent=(provider,id,title)=>({provider,id,mal_id:provider+':'+id,title,year:2025,type:'TV',images:{webp:{large_image_url:''}}});
      window.lilac={
        providerCatalog:async(provider,query)=>{record('catalog',provider,query);if(['ohli24','animenosub'].includes(provider))return{data:[independent(provider,provider+'-only',provider+' 별도 작품')]};if(query)return{data:[shared(provider,provider+'-search')]};return{data:[shared(provider,provider+'-home')]};},
        linkkfHome:async()=>{record('linkkf-home');return{data:[shared('linkkf','lk-home')]};},
        linkkfSearch:async query=>{record('linkkf-search',query);return[shared('linkkf','lk-search')]},
        catalogKoreanSearch:async()=>[],
        providerDetail:async anime=>{record('detail',anime.provider);if(anime.provider==='miruro')throw new Error('mock source offline');return{data:anime,episodes:[{name:'1화',title:'1화',number:1,token:anime.provider+'-1'},{name:'2화',title:'2화',number:2,token:anime.provider+'-2'}],unavailable:false}},
        linkkfDetail:async id=>{record('linkkf-detail',id);return{data:shared('linkkf',id)}},
        linkkfEpisodes:async id=>{record('linkkf-episodes',id);return[{name:'NR-HD',episodes:[{name:'1화',number:1,token:id+'-1',postId:id}]},{name:'Backup',episodes:[{name:'1화',number:1,token:id+'-1b',postId:id}]}]},
        providerResolve:async episode=>{record('provider-resolve',episode.token);return{url:'mock://provider'}},
        linkkfResolve:async episode=>{record('linkkf-resolve',episode.token);return{url:'mock://linkkf'}}
      };
      document.getElementById('seeAllSeason').addEventListener('click',()=>record('original-a-catalog'));
      document.querySelector('.nav[data-view="all"]').addEventListener('click',()=>record('original-a-catalog'));
      window.resolveIntoPlayer=async(resolver,name,context,title,episode)=>{const stream=await resolver();window.__play={name,context:{provider:context.episode.provider,token:context.episode.token,resolveKind:context.resolveKind},title,episode,stream};return true};
      `;
    fs.writeFileSync(path.join(tempRoot, 'unified-catalog-mocks.js'), mockScript, 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'patch-manager-feature-flags-off.js'), "window.DinoLilacPatchFeatures=Object.freeze({'patch-01':false,'patch-02':false,'patch-03':false});\n", 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'patch-manager-feature-flags-on.js'), "window.DinoLilacPatchFeatures=Object.freeze({'patch-01':false,'patch-02':false,'patch-03':true});\n", 'utf8');
    const actualSourceRoot = process.env.LILAC_UNIFIED_CATALOG_V0515_ROOT;
    let htmlPath, enabledHtmlPath;
    if (actualSourceRoot) {
      const officialRoot = path.resolve(actualSourceRoot);
      const revision = execFileSync('git', ['-C', officialRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      assert.equal(revision, '16c9a3d1631061a72831e0657434003940daf531', 'actual-source mode requires the verified official v0.5.15 commit');
      assert.equal(JSON.parse(fs.readFileSync(path.join(officialRoot, 'package.json'), 'utf8')).version, '0.5.15');
      const isolatedSrc = path.join(tempRoot, 'official-v0515-src');
      copyDirectory(path.join(officialRoot, 'src'), isolatedSrc);
      for (const file of ['integrated-search.js', 'unified-catalog.js', 'unified-catalog.css']) fs.copyFileSync(path.join(assets, file), path.join(isolatedSrc, file));
      fs.writeFileSync(path.join(isolatedSrc, 'unified-catalog-mocks.js'), mockScript, 'utf8');
      fs.writeFileSync(path.join(isolatedSrc, 'patch-manager-feature-flags-off.js'), "window.DinoLilacPatchFeatures=Object.freeze({'patch-01':false,'patch-02':false,'patch-03':false});\n", 'utf8');
      fs.writeFileSync(path.join(isolatedSrc, 'patch-manager-feature-flags-on.js'), "window.DinoLilacPatchFeatures=Object.freeze({'patch-01':false,'patch-02':false,'patch-03':true});\n", 'utf8');
      const actualIndex = fs.readFileSync(path.join(isolatedSrc, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      assert.match(actualIndex, /id="homeView"/);
      assert.match(actualIndex, /id="allView"/);
      const inject = flags => actualIndex.replace('</body>', `<script src="${flags}"></script><script src="unified-catalog-mocks.js"></script><script src="integrated-search.js"></script><script src="unified-catalog.js"></script></body>`);
      htmlPath = path.join(isolatedSrc, 'index.html'); enabledHtmlPath = htmlPath;
      fs.writeFileSync(htmlPath, inject('patch-manager-feature-flags-off.js'), 'utf8');
      var actualOnHtml = inject('patch-manager-feature-flags-on.js');
      process.env.LILAC_UNIFIED_CATALOG_ACTUAL_SOURCE = 'official-v0.5.15-src-index-html';
    } else {
      const html = flags => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'"></head><body><nav><button class="nav" data-view="all">전체</button></nav><main><section id="homeView" class="view active"><div id="sourceNotice"></div><button id="seeAllSeason">기존 공급원별 목록</button><div id="hero">기존 A 화면 콘텐츠</div></section><section id="allView" class="view">기존 공급원별 전체 카탈로그</section></main><script src="${flags}"></script><script src="unified-catalog-mocks.js"></script><script src="integrated-search.js"></script><script src="unified-catalog.js"></script></body></html>`;
      htmlPath = path.join(tempRoot, 'unified-catalog-off.html'); fs.writeFileSync(htmlPath, html('patch-manager-feature-flags-off.js'), 'utf8');
      enabledHtmlPath = path.join(tempRoot, 'unified-catalog-on.html'); fs.writeFileSync(enabledHtmlPath, html('patch-manager-feature-flags-on.js'), 'utf8');
    }
    win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    await win.loadFile(htmlPath);
    const absent = await waitFor('Patch 03 OFF UI', () => win.webContents.executeJavaScript('document.readyState!=="loading"').then(ready => ready && win.webContents.executeJavaScript('!document.querySelector("#unifiedCatalogView")')));
    assert.equal(absent, true, 'Patch 03 OFF does not replace the original A screen with the catalog UI');
    const originalAOff = await win.webContents.executeJavaScript('Boolean(document.querySelector("#homeView #seeAllSeason")&&document.querySelector("#allView"))');
    assert.equal(originalAOff, true, 'Patch 03 OFF retains original home and provider catalog screens');

    if (process.env.LILAC_UNIFIED_CATALOG_ACTUAL_SOURCE) fs.writeFileSync(enabledHtmlPath, actualOnHtml, 'utf8');
    await win.loadFile(enabledHtmlPath);
    await waitFor('Patch 03 ON default integrated home and first browse results', () => win.webContents.executeJavaScript('Boolean(document.querySelector("#homeView #unifiedCatalogView")&&document.querySelector("#unifiedCatalogStyles")&&document.querySelectorAll(".unified-catalog-card").length>=3)'));
    const isDefaultHome = await win.webContents.executeJavaScript('document.querySelector("#homeView").firstElementChild.id==="unifiedCatalogView"&&document.querySelector("#homeView #seeAllSeason")&&document.querySelector("#allView")&&!document.querySelector("#unifiedCatalogDialog")');
    assert.equal(isDefaultHome, true, 'Patch 03 ON opens B by default while retaining A navigation and the original catalog');
    const browse = await win.webContents.executeJavaScript('({providers:document.querySelectorAll(".unified-catalog-providers span").length, cards:document.querySelectorAll(".unified-catalog-card").length, calls:window.__calls.filter(call=>call.name==="catalog"||call.name==="linkkf-home").length})');
    assert.equal(browse.providers, 5);
    assert.equal(browse.calls, 5);
    assert.ok(browse.cards >= 3, 'deduplicated multi-provider browse groups produce catalog cards');
    await win.webContents.executeJavaScript('document.querySelector(".unified-catalog-original").click()');
    const originalAClick = await win.webContents.executeJavaScript('window.__calls.some(call=>call.name==="original-a-catalog")');
    assert.equal(originalAClick, true, 'the integrated home keeps a direct entry to the original provider-specific catalog');

    await win.webContents.executeJavaScript('document.querySelector("#unifiedCatalogQuery").value="search title";document.querySelector(".unified-catalog-search").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
    await waitFor('unified search cards', () => win.webContents.executeJavaScript('document.querySelectorAll(".unified-catalog-card").length>=3&&document.querySelector(".unified-catalog-status").textContent.includes("개 작품")'));
    const searched = await win.webContents.executeJavaScript('window.__calls.filter(call=>call.name==="catalog"||call.name==="linkkf-search").filter(call=>call.args.includes("search title")).length');
    assert.equal(searched, 5, 'search dispatches to all five providers');

    await win.webContents.executeJavaScript('document.querySelector(".unified-catalog-card").click()');
    await waitFor('episode detail rows', () => win.webContents.executeJavaScript('document.querySelectorAll(".unified-catalog-episodes li").length>=2'));
    const detail = await win.webContents.executeJavaScript('({providers:window.__calls.filter(call=>call.name==="detail"||call.name==="linkkf-detail").length, choices:document.querySelectorAll(".unified-catalog-episodes li:first-child .unified-catalog-play").length, failed:document.querySelector(".unified-catalog-status").textContent.includes("Miruro")})');
    assert.equal(detail.providers, 3, 'grouped work loads each of its three provider details');
    assert.ok(detail.choices >= 3, 'matching episodes expose per-provider and Linkkf server choices');
    assert.equal(detail.failed, true, 'a failed source is reported while healthy choices remain visible');
    await win.webContents.executeJavaScript('document.querySelector(".unified-catalog-episodes li:first-child .unified-catalog-play:nth-child(2)").click()');
    await waitFor('selected provider resolution', () => win.webContents.executeJavaScript('Boolean(window.__play)'));
    const play = await win.webContents.executeJavaScript('window.__play');
    assert.equal(play.context.provider, 'linkkf');
    assert.equal(play.stream.url, 'mock://linkkf');
    assert.deepEqual(blockedRequests, [], 'mock UI test makes no external requests');
    console.log('ISOLATED_UNIFIED_CATALOG_ELECTRON_RESULT=' + JSON.stringify({ source: process.env.LILAC_UNIFIED_CATALOG_ACTUAL_SOURCE || 'minimal-ui-fixture', offMode: 'A-flow UI retained', patch03On: 'integrated catalog default home', browse, searchProviders: searched, detail, play: play.context, externalRequests: blockedRequests.length }));
    win.destroy(); win = null; app.exit(0);
  } catch (error) { fail(error); }
}).catch(fail);
