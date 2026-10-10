#!/usr/bin/env node
'use strict';

/**
 * Read-only upstream acquisition and fail-closed patch preparation.
 * Run ONLY from the dedicated integration branch/worktree, never main or installed app.
 * --check: fetch upstream tags, compare and test a three-way apply without writes to source.
 * --apply: only if --check is conflict-free, apply upstream v0.5.9->v0.5.14 diff
 *          on the clean integration worktree. No commit, build, install or reset.
 *
 * Note: the private fork has no Git ancestry with the original tagged upstream,
 * so a direct 'git merge upstream/main' must NOT be assumed possible.
 */
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_BRANCH = 'codex/inapp-upstream-v0.5.14-patch01-02';
const EXPECTED_BASE = '4610a45f52e9a076b67a6774bcf3887dc390e485';
const UPSTREAM_URL = 'https://github.com/whispelyn-byte/LilacAnime-desktop.git';
const FROM = 'refs/codex/upstream/v0.5.9';
const TO = 'refs/codex/upstream/v0.5.14';
const EXPECTED_LATEST = 'f095fc3d775451e144ed780e1fa081f739927652';
const EXPECTED_PREVIOUS = '4550d61725a8b57e6e890e97bd0f25244a8cf164';
const SOURCE_FILES = [
  'electron/main.cjs', 'electron/preload.cjs', 'src/app.js', 'src/index.html',
  'src/player.js', 'package.json', 'package-lock.json'
];
const PROMPT_HASHES = {
  '영어 번역 프롬프트.txt': '582eaf421cabbcf89279579e5723aa07b070e5b1df2e28ee044994b2e951e37e',
  '일본어 번역 프롬프트.txt': '9ff7e860cf0c79396621c2ef65b364596ebb884aa5b3ce68e60ab0d4b42ec584',
  'Reazon_작품용_단어사전_예시.txt': '2dcb15b42d31bd6413d74e9a91303f0055574e030f875720cb1a1c07b814ccf8'
};

const cwd = process.cwd();
function run(args, options={}) {
  const r = spawnSync('git', args, {
    cwd, input: options.input, encoding: 'utf8',
    windowsHide: true, maxBuffer: 64*1024*1024, timeout: 120000
  });
  if (r.error || r.status !== 0) {
    const error = r.error?.message || (r.stderr || r.stdout || '').trim();
    throw new Error('git ' + args.join(' ') + ': ' + error.slice(0, 1800));
  }
  return r.stdout;
}
function reject(message) { console.error('STOP: ' + message); process.exitCode = 1; }
function hash(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function ensureSafeCwd() {
  const root = path.resolve(run(['rev-parse', '--show-toplevel']).trim());
  if (path.resolve(cwd).toLowerCase() !== root.toLowerCase())
    throw new Error('프로젝트 루트에서만 실행하세요.');
  const branch = run(['branch', '--show-current']).trim();
  if (branch !== EXPECTED_BRANCH)
    throw new Error('허용되지 않은 브랜치: ' + branch + ' (필요: ' + EXPECTED_BRANCH + ')');
  const rootNorm = root.toLowerCase().replace(/\\/g, '/');
  if (rootNorm === 'd:/lilacanime' || rootNorm.includes('/appdata/roaming/lilacanime-desktop') ||
      rootNorm.includes('/appdata/local/lilacanime-desktop-updater'))
    throw new Error('설치본/사용자 프로필에서는 실행할 수 없습니다.');
  if (run(['status', '--porcelain', '--untracked-files=all']).trim())
    throw new Error('작업 트리가 깨끗하지 않습니다. 파일을 삭제하거나 초기화하지 마세요.');
  if (run(['merge-base', '--is-ancestor', EXPECTED_BASE, 'HEAD']) !== '')
    throw new Error('integration base validation failed');
  for(const [name, expected] of Object.entries(PROMPT_HASHES)) {
    const file = path.join(root, 'docs', 'prompts', name);
    if (!fs.existsSync(file) || hash(file) !== expected)
      throw new Error('사용자 프롬프트 원문 해시 불일치: ' + name);
  }
  return root;
}
function diffOptions() {
  // Exclude upstream JPEG guide images: they are not required for code integration.
  // Do not exclude source code or tests. LinkAni functionality is separately rejected
  // in acceptance gates, never introduced blindly by this script.
  return ['--', '.', ':(exclude)docs/screenshots/**'];
}
function main() {
  const mode = process.argv[2] || '--check';
  if (!['--check', '--apply'].includes(mode) || process.argv.length > 3)
    throw new Error('사용법: node scripts/prepare-upstream-inapp-v0514.cjs [--check|--apply]');
  const root = ensureSafeCwd();
  console.log('Integration branch:', EXPECTED_BRANCH, 'Worktree:', root);
  console.log('Fetching upstream release tags only; main and installed app untouched.');
  run(['fetch', '--no-tags', UPSTREAM_URL,
    '+refs/tags/v0.5.9:' + FROM,
    '+refs/tags/v0.5.14:' + TO]);
  const oldCommit = run(['rev-parse', FROM + '^{}']).trim();
  const newCommit = run(['rev-parse', TO + '^{}']).trim();
  if (oldCommit !== EXPECTED_PREVIOUS || newCommit !== EXPECTED_LATEST)
    throw new Error('상류 태그의 SHA가 예상과 다릅니다. 적용을 중단합니다.');
  const patch = run(['diff', '--binary', FROM, TO, ...diffOptions()]);
  const changed = run(['diff', '--name-only', FROM, TO, ...diffOptions()]).trim().split(/\r?\n/).filter(Boolean);
  console.log('Upstream patch candidates ('+changed.length+'):', changed.join(', '));
  console.log('High-risk overlap: ' + SOURCE_FILES.filter(x=>changed.includes(x)).join(', '));
  console.log('Patch SHA-256:', createHash('sha256').update(patch).digest('hex'));
  const check = spawnSync('git', ['apply', '--3way', '--check', '-'], {
    cwd, input:patch, encoding:'utf8', windowsHide:true,
    maxBuffer:64*1024*1024, timeout:120000
  });
  const applies = !check.error && check.status === 0;
  console.log('3-way dry-run:', applies?'clean':'CONFLICT / unsupported');
  if (!applies) {
    console.error((check.stderr || check.stdout || String(check.error)).slice(0,8000));
    reject('겹치는 원본 파일은 수동으로 통합해야 합니다. 자동 적용하지 않았습니다.');
    return;
  }
  if (mode === '--check') {
    console.log('DRY RUN ONLY. No upstream source applied. Run --apply only in this isolated branch.');
    return;
  }
  run(['apply', '--3way', '--index', '-'], { input:patch });
  console.log('Applied into this isolated worktree only; NOT committed or installed.');
  console.log('MANDATORY: compare each high-risk file, run all tests, prove preservation of');
  console.log('patch 01/02, no LinkAni or next-episode autoplay before any commit.');
}
try { main(); } catch (error) { reject(String(error?.message || error)); }
