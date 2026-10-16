'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { stopOwnedChild } = require('./runtime-attach-fixture/owned-child.cjs');

function makeChild({ onWrite, onKill } = {}) {
  const child = new EventEmitter();
  child.pid = 4567;
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = 0;
  child.stdin = {
    writable: true,
    write(value) { if (onWrite) onWrite(child, value); }
  };
  child.kill = () => {
    child.killCalls += 1;
    if (onKill) onKill(child);
    return true;
  };
  return child;
}

test('requests graceful shutdown first and does not kill an owned child that exits cleanly', async () => {
  const child = makeChild({
    onWrite(target, value) {
      assert.equal(value, '{"type":"shutdown"}\n');
      setImmediate(() => {
        target.exitCode = 0;
        target.emit('exit', 0, null);
      });
    }
  });
  const result = await stopOwnedChild(child, { shutdownMessage: '{"type":"shutdown"}\n', graceMs: 100 });
  assert.equal(result.graceful, true);
  assert.equal(result.exitCode, 0);
  assert.equal(child.killCalls, 0);
});

test('bounds failure cleanup to the exact spawned child after graceful shutdown times out', async () => {
  const events = [];
  const child = makeChild({
    onKill(target) {
      setImmediate(() => {
        target.signalCode = 'SIGTERM';
        target.emit('exit', null, 'SIGTERM');
      });
    }
  });
  const result = await stopOwnedChild(child, {
    reason: 'test-failure',
    shutdownMessage: '{"type":"shutdown"}\n',
    graceMs: 5,
    terminationWaitMs: 100,
    onEvent: (name, details) => events.push({ name, details })
  });
  assert.equal(result.graceful, false);
  assert.equal(result.exitedAfterTermination, true);
  assert.equal(child.killCalls, 1);
  assert.equal(events[0].details.exactOwnedChildOnly, true);
});

test('reports an unresponsive owned child without claiming cleanup completed', async () => {
  const child = makeChild();
  const result = await stopOwnedChild(child, { graceMs: 5, terminationWaitMs: 5 });
  assert.equal(result.graceful, false);
  assert.equal(result.exitedAfterTermination, false);
  assert.equal(child.killCalls, 1);
});
