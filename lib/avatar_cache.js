import { existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream, unlinkSync, renameSync } from "fs";

import { join, resolve, dirname } from "path";

import { fileURLToPath } from "url";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

const CACHE_DIR = join(DATA_DIR, "avatars_cache");

const INDEX_FILE = join(DATA_DIR, "avatars_index.json");

const INDEX_TMP = INDEX_FILE + ".tmp";

let _writeLock = Promise.resolve();

function withWriteLock(fn) {
  const prev = _writeLock;
  let resolveNext;
  _writeLock = new Promise(r => {
    resolveNext = r;
  });
  return prev.then(() => fn()).finally(() => resolveNext());
}

function ensureDirs() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, {
    recursive: true
  });
}

function loadIndex() {
  try {
    return existsSync(INDEX_FILE) ? JSON.parse(readFileSync(INDEX_FILE, "utf8")) : {};
  } catch {
    return {};
  }
}

function saveIndex(idx) {
  ensureDirs();
  const json = JSON.stringify(idx || {}, null, 2);
  writeFileSync(INDEX_TMP, json, "utf8");
  renameSync(INDEX_TMP, INDEX_FILE);
}

async function fetchSteamAvatarRaw(apiKey, sid) {
  const providers = [ async () => {
    if (!apiKey) throw new Error("No API Key");
    const r = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${sid}`, {
      signal: AbortSignal.timeout(3e3)
    });
    const j = await r.json();
    return j?.response?.players?.[0]?.avatarmedium || j?.response?.players?.[0]?.avatarfull || null;
  }, async () => {
    const r = await fetch(`https://steamcommunity.com/profiles/${sid}?xml=1`, {
      signal: AbortSignal.timeout(3e3),
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });
    const t = await r.text();
    const match = t.match(/<avatarMedium><!\[CDATA\[(.*?)\]\]><\/avatarMedium>/) || t.match(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/);
    return match ? match[1] : null;
  } ];
  for (const p of providers) {
    try {
      const url = await p();
      if (url) return url;
    } catch {}
  }
  return null;
}

async function fetchSteamAvatarsBulk(apiKey, sids) {
  const out = {};
  if (!apiKey || !sids.length) return out;
  const chunks = [];
  for (let i = 0; i < sids.length; i += 100) chunks.push(sids.slice(i, i + 100));
  await Promise.allSettled(chunks.map(async chunk => {
    const ids = chunk.join(",");
    try {
      const r = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${ids}`, {
        signal: AbortSignal.timeout(8e3)
      });
      if (!r.ok) {
        console.error("[AVATAR] Steam API HTTP", r.status);
        return;
      }
      const j = await r.json();
      for (const p of j?.response?.players || []) {
        const sid = String(p?.steamid || "");
        out[sid] = p?.avatarmedium || p?.avatarfull || null;
      }
      for (const sid of chunk) {
        if (!(sid in out)) out[sid] = null;
      }
    } catch (e) {
      console.error("[AVATAR] Steam API error:", e.message);
    }
  }));
  return out;
}

async function resolveAvatar(pool, sid64, apiKey) {
  if (!sid64 || !/^\d{17}$/.test(sid64)) return "/img/noavatar.png";
  const idx = loadIndex();
  const entry = idx[sid64];
  if (entry && existsSync(join(CACHE_DIR, entry.file))) {
    return "/api/avatars_cache/" + entry.file;
  }
  const remoteUrl = await fetchSteamAvatarRaw(apiKey, sid64);
  if (!remoteUrl) return "/img/noavatar.png";
  try {
    const r = await fetch(remoteUrl, {
      signal: AbortSignal.timeout(5e3)
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const filename = `${sid64}.jpg`;
    ensureDirs();
    writeFileSync(join(CACHE_DIR, filename), buf);
    await withWriteLock(async () => {
      const freshIdx = loadIndex();
      freshIdx[sid64] = {
        file: filename,
        updated_at: Date.now()
      };
      saveIndex(freshIdx);
    });
    return "/api/avatars_cache/" + filename;
  } catch {
    return "/img/noavatar.png";
  }
}

async function resolveAvatarBatch(pool, sids, apiKey) {
  const out = {};
  if (!sids.length) return out;
  const idx = loadIndex();
  const missing = [];
  for (const sid of sids) {
    const entry = idx[sid];
    if (entry && existsSync(join(CACHE_DIR, entry.file))) {
      out[sid] = "/api/avatars_cache/" + entry.file;
    } else {
      missing.push(sid);
    }
  }
  if (!missing.length) return out;
  console.log("[AVATAR] fetching", missing.length, "avatars from Steam...");
  const steamUrls = await fetchSteamAvatarsBulk(apiKey, missing);
  console.log("[AVATAR] Steam returned URLs for", Object.keys(steamUrls).filter(k => steamUrls[k]).length, "of", missing.length);
  const downloads = [];
  for (const sid of missing) {
    const url = steamUrls[sid];
    if (url) {
      downloads.push({
        sid: sid,
        url: url
      });
    } else {
      out[sid] = "/img/noavatar.png";
    }
  }
  if (downloads.length) {
    const downloaded = await Promise.allSettled(downloads.map(async ({sid: sid, url: url}) => {
      try {
        const r = await fetch(url, {
          signal: AbortSignal.timeout(5e3)
        });
        const buf = Buffer.from(await r.arrayBuffer());
        const filename = `${sid}.jpg`;
        ensureDirs();
        writeFileSync(join(CACHE_DIR, filename), buf);
        return {
          sid: sid,
          filename: filename,
          ok: true
        };
      } catch {
        return {
          sid: sid,
          filename: null,
          ok: false
        };
      }
    }));
    const newEntries = {};
    for (const result of downloaded) {
      if (result.status === "fulfilled" && result.value.ok) {
        const {sid: sid, filename: filename} = result.value;
        out[sid] = "/api/avatars_cache/" + filename;
        newEntries[sid] = {
          file: filename,
          updated_at: Date.now()
        };
      } else {
        const sid = result.status === "fulfilled" ? result.value.sid : "";
        if (sid && !(sid in out)) out[sid] = "/img/noavatar.png";
      }
    }
    if (Object.keys(newEntries).length) {
      await withWriteLock(async () => {
        const freshIdx = loadIndex();
        Object.assign(freshIdx, newEntries);
        saveIndex(freshIdx);
      });
    }
  }
  for (const sid of missing) {
    if (!(sid in out)) out[sid] = "/img/noavatar.png";
  }
  return out;
}

function pruneStaleCache() {
  try {
    const idx = loadIndex();
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1e3;
    let changed = false;
    for (const [sid, entry] of Object.entries(idx)) {
      if (!entry || !entry.file) continue;
      if ((entry.updated_at || 0) < cutoff) {
        const fp = join(CACHE_DIR, entry.file);
        try {
          if (existsSync(fp)) unlinkSync(fp);
        } catch {}
        delete idx[sid];
        changed = true;
      }
    }
    if (changed) saveIndex(idx);
  } catch {}
}

function peekCachedUrl(sid64) {
  const idx = loadIndex();
  const entry = idx[sid64];
  return entry ? "/api/avatars_cache/" + entry.file : null;
}

async function serveCachedAvatar(req, res) {
  const name = req.params.name;
  if (!/^\d{17}\.(jpg|webp|png)$/.test(name)) return res.status(404).end();
  const fp = resolve(CACHE_DIR, name);
  if (existsSync(fp)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    const ext = name.split(".").pop().toLowerCase();
    const mimeMap = {
      jpg: "image/jpeg",
      webp: "image/webp",
      png: "image/png"
    };
    res.setHeader("Content-Type", mimeMap[ext] || "image/jpeg");
    createReadStream(fp).pipe(res);
  } else {
    res.status(404).end();
  }
}

setTimeout(pruneStaleCache, 3e4);

export { peekCachedUrl, resolveAvatar, resolveAvatarBatch, serveCachedAvatar, pruneStaleCache };
