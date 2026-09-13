import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";

import { join, dirname } from "path";

import { fileURLToPath } from "url";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

const AVATAR_DIR = join(DATA_DIR, "avatars");

const INDEX = join(DATA_DIR, "custom_avatars.json");

function ensureDir() {
  if (!existsSync(AVATAR_DIR)) mkdirSync(AVATAR_DIR, {
    recursive: true
  });
}

let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    _cache = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8") || "{}") : {};
  } catch {
    _cache = {};
  }
  if (!_cache || typeof _cache !== "object") _cache = {};
  return _cache;
}

function save() {
  ensureDir();
  try {
    writeFileSync(INDEX, JSON.stringify(_cache || {}, null, 2), "utf8");
  } catch {}
}

function getCustomAvatarFile(sid64) {
  const idx = load();
  const e = idx[String(sid64)];
  return e && e.file ? e.file : null;
}

function getCustomAvatarUrl(sid64) {
  const f = getCustomAvatarFile(sid64);
  return f ? "/api/custom_avatar/" + f : null;
}

function setCustomAvatar(sid64, file, by) {
  ensureDir();
  const idx = load();
  const prev = idx[String(sid64)];
  if (prev && prev.file && prev.file !== file) {
    try {
      unlinkSync(join(AVATAR_DIR, prev.file));
    } catch {}
  }
  idx[String(sid64)] = {
    file: file,
    by: String(by || ""),
    ts: Math.floor(Date.now() / 1e3)
  };
  _cache = idx;
  save();
  return true;
}

function removeCustomAvatar(sid64) {
  const idx = load();
  const e = idx[String(sid64)];
  if (!e) return false;
  if (e.file) {
    try {
      unlinkSync(join(AVATAR_DIR, e.file));
    } catch {}
  }
  delete idx[String(sid64)];
  _cache = idx;
  save();
  return true;
}

function listCustomAvatars() {
  return load();
}

export { AVATAR_DIR, getCustomAvatarFile, getCustomAvatarUrl, listCustomAvatars, removeCustomAvatar, setCustomAvatar };
