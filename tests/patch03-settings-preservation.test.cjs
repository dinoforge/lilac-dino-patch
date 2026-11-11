'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  OFFICIAL_SOURCES,
  SOURCE_MODE_KEY,
  SOURCE_MIGRATION_KEY,
  initializeSourceSettings,
  officialSourceForState,
  readSourceSettings,
  saveSourceSelection
} = require('../src/integrated-search.js');

class MemoryStorage {
  constructor(values = {}, failOnce = null) {
    this.values = new Map(Object.entries(values));
    this.failOnce = failOnce;
  }

  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) {
    if (this.failOnce === key) {
      this.failOnce = null;
      throw new Error(`synthetic write failure: ${key}`);
    }
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
  snapshot() { return Object.fromEntries(this.values); }
}

const officialSourceValue = storage => storage.getItem('contentSource') || 'reanime';

test('a valid official provider alone is read without adding Dino settings', () => {
  const storage = new MemoryStorage({ contentSource: 'linkkf' });
  const before = storage.snapshot();

  const result = initializeSourceSettings(storage);

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'provider');
  assert.equal(result.provider, 'linkkf');
  assert.equal(officialSourceValue(storage), 'linkkf');
  assert.deepEqual(storage.snapshot(), before);
});

test('the Dino integrated key works by itself and leaves the official default intact', () => {
  const storage = new MemoryStorage({ [SOURCE_MODE_KEY]: 'integrated' });
  const before = storage.snapshot();

  const result = initializeSourceSettings(storage);

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'integrated');
  assert.equal(result.provider, 'reanime');
  assert.equal(officialSourceForState(result, null), 'reanime');
  assert.equal(officialSourceValue(storage), 'reanime');
  assert.deepEqual(storage.snapshot(), before, 'the original app default is used without persisting an inferred preference');
});

test('reproduces legacy integrated collision and migrates only the preserved valid provider', () => {
  const storage = new MemoryStorage({ contentSource: 'integrated', contentSourceProvider: 'miruro' });

  assert.equal(officialSourceValue(storage), 'integrated', 'before migration the original app reads an unsupported source value');
  assert.equal(OFFICIAL_SOURCES.includes(officialSourceValue(storage)), false);
  assert.equal(readSourceSettings(storage).needsMigration, true);

  const migrated = initializeSourceSettings(storage);
  assert.equal(migrated.ok, true);
  assert.equal(migrated.mode, 'integrated');
  assert.equal(migrated.provider, 'miruro');
  assert.equal(storage.getItem('contentSource'), 'miruro');
  assert.equal(storage.getItem(SOURCE_MODE_KEY), 'integrated');
  assert.equal(officialSourceValue(storage), 'miruro', 'the original app sees its prior valid provider after migration');

  const journal = JSON.parse(storage.getItem(SOURCE_MIGRATION_KEY));
  assert.equal(journal.version, 1);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0].status, 'complete');
  assert.deepEqual(journal.entries[0].before, {
    contentSource: 'integrated', contentSourceProvider: 'miruro', mode: null
  });
  assert.deepEqual(journal.entries[0].after, { contentSource: 'miruro', mode: 'integrated' });

  const repeated = initializeSourceSettings(storage);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.mode, 'integrated');
  assert.equal(JSON.parse(storage.getItem(SOURCE_MIGRATION_KEY)).entries.length, 1, 'startup does not duplicate the migration journal');
});

test('finishes a valid prepared migration journal after an interrupted legacy settings write', () => {
  const entry = {
    status: 'prepared',
    before: { contentSource: 'integrated', contentSourceProvider: 'miruro', mode: null },
    after: { contentSource: 'miruro', mode: 'integrated' }
  };
  const storage = new MemoryStorage({
    contentSource: 'integrated',
    contentSourceProvider: 'miruro',
    [SOURCE_MIGRATION_KEY]: JSON.stringify({ version: 1, entries: [entry] })
  });

  const result = initializeSourceSettings(storage);

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'miruro');
  assert.equal(storage.getItem('contentSource'), 'miruro');
  assert.equal(storage.getItem(SOURCE_MODE_KEY), 'integrated');
  const journal = JSON.parse(storage.getItem(SOURCE_MIGRATION_KEY));
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0].status, 'complete');
});

test('migrates a legacy integrated value when a valid prior provider and the newer Dino mode key coexist', () => {
  const storage = new MemoryStorage({
    contentSource: 'integrated',
    contentSourceProvider: 'ohli24',
    [SOURCE_MODE_KEY]: 'integrated'
  });

  const result = initializeSourceSettings(storage);

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'integrated');
  assert.equal(result.provider, 'ohli24');
  assert.equal(storage.getItem('contentSource'), 'ohli24');
  assert.equal(storage.getItem(SOURCE_MODE_KEY), 'integrated');
  assert.equal(officialSourceValue(storage), 'ohli24');
  const journal = JSON.parse(storage.getItem(SOURCE_MIGRATION_KEY));
  assert.deepEqual(journal.entries[0].before, {
    contentSource: 'integrated', contentSourceProvider: 'ohli24', mode: 'integrated'
  });
  assert.equal(journal.entries[0].status, 'complete');
});

test('a new integrated selection leaves the official provider value untouched and remains harmless after unpatch', () => {
  const storage = new MemoryStorage({ contentSource: 'ohli24' });
  const saved = saveSourceSelection(storage, 'integrated');

  assert.equal(saved.ok, true);
  assert.equal(saved.mode, 'integrated');
  assert.equal(storage.getItem('contentSource'), 'ohli24');
  assert.equal(storage.getItem('contentSourceProvider'), null, 'new integrated mode does not need the legacy provider key');
  assert.equal(storage.getItem(SOURCE_MODE_KEY), 'integrated');
  assert.equal(officialSourceValue(storage), 'ohli24', 'the unpatched original ignores the Dino namespace and sees the original provider');
});

test('provider choice survives integrated search, provider switching, uninstall, restart, and explicit reapply', () => {
  const storage = new MemoryStorage({
    contentSource: 'reanime',
    contentSourceProvider: 'reanime',
    theme: 'dark',
    history: JSON.stringify([{ id: 'history-1' }]),
    library: JSON.stringify([{ id: 'favorite-1' }])
  });

  assert.equal(saveSourceSelection(storage, 'integrated').ok, true);
  assert.equal(storage.getItem('contentSource'), 'reanime');
  assert.equal(storage.getItem(SOURCE_MODE_KEY), 'integrated');
  assert.equal(saveSourceSelection(storage, 'miruro').ok, true);
  assert.equal(storage.getItem('contentSource'), 'miruro');
  assert.equal(storage.getItem(SOURCE_MODE_KEY), null);
  assert.equal(saveSourceSelection(storage, 'integrated').ok, true);

  const beforeUninstall = storage.snapshot();
  // Patch uninstall restores source files only; it must not rewrite the user profile.
  assert.equal(officialSourceValue(storage), 'miruro');
  assert.deepEqual(storage.snapshot(), beforeUninstall);

  const afterRestart = initializeSourceSettings(storage);
  assert.equal(afterRestart.ok, true);
  assert.equal(afterRestart.mode, 'integrated');
  assert.equal(afterRestart.provider, 'miruro');
  assert.equal(officialSourceValue(storage), 'miruro');

  // The explicit engine reapply uses the same source state; initialization remains idempotent.
  const afterReapply = initializeSourceSettings(storage);
  assert.equal(afterReapply.ok, true);
  assert.equal(afterReapply.mode, 'integrated');
  assert.equal(storage.getItem('theme'), 'dark');
  assert.equal(storage.getItem('history'), JSON.stringify([{ id: 'history-1' }]));
  assert.equal(storage.getItem('library'), JSON.stringify([{ id: 'favorite-1' }]));
  assert.deepEqual(storage.snapshot(), beforeUninstall);
});

test('legacy integrated values without a valid saved provider are preserved and not guessed', () => {
  for (const values of [
    { contentSource: 'integrated' },
    { contentSource: 'integrated', contentSourceProvider: 'future-provider' },
    { contentSource: 'integrated', contentSourceProvider: '' }
  ]) {
    const storage = new MemoryStorage(values);
    const before = storage.snapshot();
    const result = initializeSourceSettings(storage);

    assert.equal(result.ok, false);
    assert.equal(result.needsRecovery, true);
    assert.equal(result.reason, 'legacy-provider-unavailable');
    assert.equal(officialSourceForState(result, values.contentSource), 'reanime', 'the renderer uses the official default for this session without guessing or persisting a prior choice');
    assert.deepEqual(storage.snapshot(), before, 'unknown prior provider values are not overwritten');
    assert.equal(OFFICIAL_SOURCES.includes(officialSourceValue(storage)), false, 'the unpatched original still sees the unsupported legacy value');
    assert.equal(storage.getItem(SOURCE_MIGRATION_KEY), null);
  }
});

test('unrecoverable legacy integrated values remain incompatible with the unpatched original after uninstall', () => {
  const storage = new MemoryStorage({ contentSource: 'integrated', contentSourceProvider: 'unknown-provider' });
  const before = storage.snapshot();

  const whilePatched = initializeSourceSettings(storage);
  assert.equal(whilePatched.ok, false);
  assert.equal(officialSourceForState(whilePatched, storage.getItem('contentSource')), 'reanime');

  // Uninstall restores app source files, not LocalStorage. The clean v0.5.58
  // renderer reads contentSource directly and its provider list excludes integrated.
  const afterUninstall = officialSourceValue(storage);
  assert.equal(afterUninstall, 'integrated');
  assert.equal(OFFICIAL_SOURCES.includes(afterUninstall), false);
  assert.deepEqual(storage.snapshot(), before, 'uninstall must not silently guess and rewrite an unknown former provider');
});

test('missing original source uses the official default without persisting an inferred preference', () => {
  const storage = new MemoryStorage();
  const result = initializeSourceSettings(storage);

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'reanime');
  assert.equal(result.mode, 'provider');
  assert.deepEqual(storage.snapshot(), {});
});

test('invalid or corrupt settings and migration journals fail without modifying existing values', () => {
  const invalidSource = new MemoryStorage({ contentSource: 'unrecognized-source' });
  const invalidBefore = invalidSource.snapshot();
  assert.equal(initializeSourceSettings(invalidSource).ok, false);
  assert.deepEqual(invalidSource.snapshot(), invalidBefore);

  const invalidMode = new MemoryStorage({ contentSource: 'ohli24', [SOURCE_MODE_KEY]: 'unknown-mode' });
  const invalidModeBefore = invalidMode.snapshot();
  assert.equal(initializeSourceSettings(invalidMode).reason, 'unsupported-dino-source-mode');
  assert.deepEqual(invalidMode.snapshot(), invalidModeBefore);
  assert.equal(officialSourceForState({ ok: false }, 'ohli24'), 'ohli24', 'a valid official source remains usable in memory when Dino settings are invalid');
  assert.equal(officialSourceForState({ ok: false }, 'future-source'), 'reanime', 'unsupported values never reach the official renderer state');

  const corruptJournal = new MemoryStorage({
    contentSource: 'integrated',
    contentSourceProvider: 'reanime',
    [SOURCE_MIGRATION_KEY]: '{not-json'
  });
  const corruptBefore = corruptJournal.snapshot();
  const failed = initializeSourceSettings(corruptJournal);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'legacy-migration-journal-invalid');
  assert.deepEqual(corruptJournal.snapshot(), corruptBefore);
});

test('unresolved migration recovery journals block future writes without changing profile values', () => {
  const journal = {
    version: 1,
    entries: [{
      status: 'recovery-required',
      before: { contentSource: 'integrated', contentSourceProvider: 'miruro', mode: null },
      after: { contentSource: 'miruro', mode: 'integrated' }
    }]
  };
  const storage = new MemoryStorage({
    contentSource: 'miruro',
    contentSourceProvider: 'miruro',
    [SOURCE_MODE_KEY]: 'integrated',
    [SOURCE_MIGRATION_KEY]: JSON.stringify(journal)
  });
  const before = storage.snapshot();

  const result = initializeSourceSettings(storage);
  assert.equal(result.ok, false);
  assert.equal(result.needsRecovery, true);
  assert.equal(result.reason, 'legacy-migration-recovery-required');
  assert.deepEqual(storage.snapshot(), before);
});

test('switching back to an individual provider updates the official key and disables Dino mode', () => {
  const storage = new MemoryStorage({ contentSource: 'miruro', [SOURCE_MODE_KEY]: 'integrated' });
  const saved = saveSourceSelection(storage, 'linkkf');

  assert.equal(saved.ok, true);
  assert.equal(saved.mode, 'provider');
  assert.equal(saved.provider, 'linkkf');
  assert.equal(storage.getItem('contentSource'), 'linkkf');
  assert.equal(storage.getItem('contentSourceProvider'), 'linkkf');
  assert.equal(storage.getItem(SOURCE_MODE_KEY), null);
  assert.equal(officialSourceValue(storage), 'linkkf');
});

test('failed legacy migration rolls back changed settings and keeps an auditable recovery entry', () => {
  const storage = new MemoryStorage({ contentSource: 'integrated', contentSourceProvider: 'miruro' }, 'contentSource');
  const result = initializeSourceSettings(storage);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'legacy-source-migration-rolled-back');
  assert.equal(storage.getItem('contentSource'), 'integrated');
  assert.equal(storage.getItem('contentSourceProvider'), 'miruro');
  assert.equal(storage.getItem(SOURCE_MODE_KEY), null);
  const journal = JSON.parse(storage.getItem(SOURCE_MIGRATION_KEY));
  assert.equal(journal.entries[0].status, 'rolled-back');
  assert.deepEqual(journal.entries[0].before, {
    contentSource: 'integrated', contentSourceProvider: 'miruro', mode: null
  });
});

test('invalid source selections do not modify the profile', () => {
  const storage = new MemoryStorage({ contentSource: 'reanime' });
  const before = storage.snapshot();
  const result = saveSourceSelection(storage, 'not-an-official-provider');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported-source-selection');
  assert.deepEqual(storage.snapshot(), before);
});
