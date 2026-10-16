'use strict';

function hasExited(child) {
  return !child || !child.pid || child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs) {
  if (hasExited(child)) {
    return Promise.resolve({ exited: true, code: child && child.exitCode, signal: child && child.signalCode });
  }
  return new Promise(resolve => {
    let settled = false;
    const finish = (exited, code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener('exit', onExit);
      resolve({ exited, code, signal });
    };
    const onExit = (code, signal) => finish(true, code, signal);
    const timeout = setTimeout(() => finish(false, child.exitCode, child.signalCode), timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopOwnedChild(child, { reason = 'unspecified', shutdownMessage, graceMs = 3000, terminationWaitMs = 3000, onEvent = () => {} } = {}) {
  if (hasExited(child)) {
    return { exitCode: child && child.exitCode, signal: child && child.signalCode, graceful: true, alreadyExited: true };
  }

  let shutdownSent = false;
  try {
    if (typeof shutdownMessage === 'string' && child.stdin && child.stdin.writable) {
      child.stdin.write(shutdownMessage);
      shutdownSent = true;
    }
  } catch (error) {
    onEvent('owned-child-shutdown-send-failed', { reason, message: String(error && error.message || error).slice(0, 200) });
  }

  const gracefulExit = await waitForChildExit(child, graceMs);
  if (gracefulExit.exited) {
    return { exitCode: gracefulExit.code, signal: gracefulExit.signal, graceful: shutdownSent && gracefulExit.code === 0 };
  }

  let terminationRequested = false;
  try { terminationRequested = child.kill(); } catch {}
  onEvent('owned-child-bounded-termination', {
    pid: child.pid,
    reason,
    shutdownSent,
    terminationRequested,
    exactOwnedChildOnly: true
  });
  const forcedExit = await waitForChildExit(child, terminationWaitMs);
  return {
    exitCode: forcedExit.code,
    signal: forcedExit.signal,
    graceful: false,
    terminationRequested,
    exitedAfterTermination: forcedExit.exited
  };
}

module.exports = { stopOwnedChild };
