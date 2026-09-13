import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync as mkdirp } from "fs";

import { join, dirname } from "path";

import { fileURLToPath } from "url";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

const LOCK_DIR = join(DATA_DIR, "queue.lock");

const LOCK_OWNER = join(LOCK_DIR, "owner");

const STALE_MS = 15e3;

const RETRY_MS = 25;

const ACQUIRE_TIMEOUT_MS = 1e4;

let lockPromise = Promise.resolve();

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirp(DATA_DIR, {
    recursive: true
  });
}

function releaseFileLock() {
  try {
    rmSync(LOCK_DIR, {
      recursive: true,
      force: true
    });
  } catch {}
}

function breakIfStale() {
  try {
    const raw = readFileSync(LOCK_OWNER, "utf8");
    const info = JSON.parse(raw || "{}");
    const age = Date.now() - Number(info.ts || 0);
    if (!Number.isFinite(age) || age > STALE_MS) {
      releaseFileLock();
      return true;
    }
  } catch {
    releaseFileLock();
    return true;
  }
  return false;
}

async function acquireFileLock() {
  ensureDataDir();
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      try {
        writeFileSync(LOCK_OWNER, JSON.stringify({
          pid: process.pid,
          ts: Date.now()
        }), "utf8");
      } catch {}
      return true;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      breakIfStale();
      if (Date.now() > deadline) {
        console.error("[QUEUE LOCK] acquire timeout, forcing lock break");
        releaseFileLock();
        continue;
      }
      await new Promise(r => setTimeout(r, RETRY_MS));
    }
  }
}

async function withQueueLock(fn) {
  const prev = lockPromise;
  let resolveNext;
  lockPromise = new Promise(resolve => {
    resolveNext = resolve;
  });
  try {
    await prev;
  } catch {}
  let held = false;
  try {
    held = await acquireFileLock();
    return await fn();
  } finally {
    if (held) releaseFileLock();
    resolveNext();
  }
}

export { withQueueLock };
