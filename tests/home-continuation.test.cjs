const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/ott.css'), 'utf8');

test('continue watching is the compact first home rail, ahead of hero and discovery rows', () => {
  const home = html.slice(html.indexOf('<section id="homeView"'), html.indexOf('<section id="searchView"'));
  const continueAt = home.indexOf('id="continueSection"');
  const heroAt = home.indexOf('id="hero"');
  const latestAt = home.indexOf('id="latestEpisodeSection"');
  const scheduleAt = home.indexOf('id="scheduleSection"');
  assert.ok(continueAt >= 0 && continueAt < heroAt && heroAt < latestAt && latestAt < scheduleAt);
  assert.ok(app.includes('hasContinue=latest.length>0;'));
  assert.ok(app.includes("classList.toggle('has-continue',hasContinue)"));
  assert.match(css, /#homeView\.has-continue\{padding-top:calc\(var\(--ott-head\) \+ 12px\)\}/);
  assert.match(css, /#homeView #continueSection \.continue-card\{flex:0 0 clamp\(150px,13vw,190px\)\}/);
});

test('continue history renders before awaiting the downloads IPC during startup', () => {
  const initAt = app.indexOf('async function init(){');
  const historyAt = app.indexOf("state.history=state.history.filter", initAt);
  const continueAt = app.indexOf('renderContinue(); renderLibrary();', initAt);
  const downloadsAt = app.indexOf('state.downloads=await window.lilac.downloads()', initAt);
  assert.ok(initAt >= 0 && historyAt > initAt && continueAt > historyAt && downloadsAt > continueAt);
});
