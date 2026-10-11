'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { findUnexpectedWorkingTreePaths } = require('./runtime-attach-working-tree.cjs');

const isExperimentEvidence = file => /^docs\/verification\/runtime-attach-evidence-\d{8}T\d{6}Z(?:-\d+)?\.jsonl$/.test(file)
  || /^docs\/verification\/assets\/runtime-attach-v0\.5\.14-\d{8}T\d{6}Z(?:-\d+)?\.png$/.test(file);

test('allows only untracked artifacts produced by an experiment run', () => {
  const status = [
    '?? docs/verification/runtime-attach-evidence-20261011T120000Z.jsonl',
    '?? docs/verification/assets/runtime-attach-v0.5.14-20261011T120000Z.png'
  ].join('\n');

  assert.deepEqual(findUnexpectedWorkingTreePaths(status, isExperimentEvidence), []);
});

test('rejects modified or deleted tracked harness files even when their paths are known', () => {
  const status = [
    ' M tests/runtime-attach-feasibility.cjs',
    ' M tests/runtime-attach-fixture/host-hook.cjs',
    ' D tests/runtime-attach-fixture/agent.cjs'
  ].join('\n');

  assert.deepEqual(findUnexpectedWorkingTreePaths(status, isExperimentEvidence), [
    'tests/runtime-attach-feasibility.cjs',
    'tests/runtime-attach-fixture/host-hook.cjs',
    'tests/runtime-attach-fixture/agent.cjs'
  ]);
});

test('rejects modified committed evidence and staged files matching allowed paths', () => {
  const status = [
    ' M docs/verification/runtime-attach-evidence-20261010T180559Z.jsonl',
    'A  docs/verification/runtime-attach-evidence-20261011T120000Z.jsonl'
  ].join('\n');

  assert.deepEqual(findUnexpectedWorkingTreePaths(status, isExperimentEvidence), [
    'docs/verification/runtime-attach-evidence-20261010T180559Z.jsonl',
    'docs/verification/runtime-attach-evidence-20261011T120000Z.jsonl'
  ]);
});

test('rejects unrelated untracked files', () => {
  assert.deepEqual(findUnexpectedWorkingTreePaths('?? local-notes.txt', isExperimentEvidence), ['local-notes.txt']);
});
