'use strict';

function findUnexpectedWorkingTreePaths(statusOutput, isExpectedUntrackedArtifact) {
  return statusOutput.split(/\r?\n/).filter(Boolean).map(line => ({
    status: line.slice(0, 2),
    file: line.slice(3)
  })).filter(({ status, file }) => status !== '??' || !isExpectedUntrackedArtifact(file)).map(({ file }) => file);
}

module.exports = { findUnexpectedWorkingTreePaths };
