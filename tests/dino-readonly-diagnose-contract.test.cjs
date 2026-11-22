'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '../scripts/dino-read-only-diagnose.ps1'), 'utf8');

test('read-only state inspector recognizes both Rust backup generations', () => {
  assert.match(script, /state\.json/);
  assert.match(script, /state-\[0-9a-f\]\{24\}/);
  assert.match(script, /Version-Slot/);
  assert.match(script, /recordedStateFile/);
  assert.match(script, /recordedBackupFile/);
  assert.match(script, /original-app\.asar/);
});
test('state selection fails closed on ambiguous hashes and invalid metadata', () => {
  assert.match(script, /\$byHash\.Count -eq 1/);
  assert.match(script, /\$byHash\.Count -eq 0 -and \$matched\.Count -eq 1/);
  assert.match(script, /STATE_NOT_UNIQUE/);
  assert.match(script, /INVALID_STATE_RECORD/);
  assert.match(script, /matchingPendingRecords/);
});
test('inspector only reads files, without repair or write commands', () => {
  for (const verb of ['Remove-Item', 'Move-Item', 'Copy-Item', 'Set-Content', 'Add-Content', 'New-Item', 'Rename-Item', 'Out-File']) {
    assert.doesNotMatch(script, new RegExp('^\\s*'+verb+'(?:\\s|$)', 'im'), verb);
  }
  assert.match(script, /Get-FileHash/);
  assert.match(script, /ReparsePoint/);
});
