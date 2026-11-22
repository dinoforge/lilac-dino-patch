'use strict';

const path = require('node:path');

const WINDOWS_EXTENDED_PATH_THRESHOLD = 240;

function toExtendedWindowsPath(value, platform = process.platform) {
  if (platform !== 'win32' || typeof value !== 'string' || !path.win32.isAbsolute(value)) return value;
  if (value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\')) return value;

  const normalized = path.win32.normalize(value);
  if (normalized.length < WINDOWS_EXTENDED_PATH_THRESHOLD) return value;
  if (normalized.startsWith('\\\\')) return `\\\\?\\UNC\\${normalized.slice(2)}`;
  return `\\\\?\\${normalized}`;
}

module.exports = { toExtendedWindowsPath, WINDOWS_EXTENDED_PATH_THRESHOLD };
