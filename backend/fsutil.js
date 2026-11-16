// fsutil.js — crash-safe JSON persistence.
//
// writeJsonAtomic writes to a temp file, flushes it to disk, then renames
// it over the target. A crash or power cut leaves either the old file or
// the new one — never a half-written file.

const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameWithRetry(tmp, file);
}

// On Windows, antivirus or the search indexer can hold a just-written file
// for a moment, making rename fail with EPERM/EBUSY/EACCES. Retry briefly.
const RENAME_RETRY = ["EPERM", "EBUSY", "EACCES"];
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!RENAME_RETRY.includes(err.code) || attempt >= 20) {
        try { fs.unlinkSync(from); } catch (_) {}
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + attempt * 5); // short synchronous pause
    }
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`⚠️  Could not read ${file}: ${err.message}`);
    return fallback;
  }
}

// Append one line and flush it to disk before returning. If a crash left a
// half-written last line, start on a fresh line so this record survives.
function appendLineDurable(file, line) {
  ensureDir(path.dirname(file));
  let prefix = "";
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const rfd = fs.openSync(file, "r");
      try {
        const last = Buffer.alloc(1);
        fs.readSync(rfd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      } finally {
        fs.closeSync(rfd);
      }
    }
  }
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, prefix + (line.endsWith("\n") ? line : `${line}\n`));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { ensureDir, writeJsonAtomic, readJson, appendLineDurable };
