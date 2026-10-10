const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/build.yml'), 'utf8');

test('installer artifact creation and release upload both require explicit rights approval', () => {
  assert.match(workflow, /^  build:\r?\n    # Do not generate or upload installer artifacts until the source and API rights review is approved\.\r?\n    # Leave the repository variable unset until that review is complete\.\r?\n    if: \$\{\{ vars\.LILAC_RELEASE_RIGHTS_APPROVED == 'true' \}\}$/m);
  assert.match(workflow, /^  release:\r?\n    if: \$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) && vars\.LILAC_RELEASE_RIGHTS_APPROVED == 'true' \}\}$/m);
  assert.match(workflow, /^on:\r?\n  push:\r?\n    tags: \['v\*'\]\r?\n  workflow_dispatch:$/m);
});
