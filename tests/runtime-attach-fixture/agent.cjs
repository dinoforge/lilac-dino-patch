'use strict';

const readline = require('node:readline');

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

try {
  const catalogPath = process.env.LILAC_RUNTIME_ATTACH_CATALOG;
  if (!catalogPath) throw new Error('Missing synthetic catalog path.');
  const catalog = require(catalogPath);
  const now = new Date('2026-10-11T12:00:00.000Z');
  const days = catalog.buildDemoWeek({ year: 2026, quarter: 4 }, now);
  if (!Array.isArray(days) || days.length !== 7 || days.some(day => !Array.isArray(day))) {
    throw new Error('The Companion fixture did not produce seven weekday lists.');
  }
  if (days.flat().some(work => work.synthetic !== true)) {
    throw new Error('The fixture contains non-synthetic work data.');
  }
  emit({ type: 'fixture', source: 'companion/core/catalog.cjs', synthetic: true, days });
} catch (error) {
  emit({ type: 'fixture-error', message: String(error && error.message || error) });
  process.exitCode = 1;
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message && message.type === 'shutdown') {
    input.close();
    emit({ type: 'stopped', graceful: true });
    process.stdout.write('', () => process.exit(0));
  }
});
