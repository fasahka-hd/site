import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";

import { join, dirname } from "path";

import { fileURLToPath } from "url";

import { avatarCache, workshopCache } from "./lru_cache.js";

function steamid64ToSteamid(sid64) {
  sid64 = String(sid64);
  if (!/^\d+$/.test(sid64)) return "";
  const base = 76561197960265728n;
  const id = BigInt(sid64) - base;
  if (id < 0n) return "";
  const y = Number(id % 2n);
  const z = Number((id - BigInt(y)) / 2n);
  return `STEAM_0:${y}:${z}`;
}

function steamidToSteamid64(steamid) {
  steamid = String(steamid).trim();
  if (/^\d{17}$/.test(steamid)) return steamid;
  const m = steamid.match(/^STEAM_\d:([01]):(\d+)$/);
  if (!m) return "";
  const y = parseInt(m[1], 10);
  const z = parseInt(m[2], 10);
  const base = 76561197960265728n;
  return String(base + BigInt(z) * 2n + BigInt(y));
}

function stripPort(ip) {
  ip = String(ip || "").trim();
  if (!ip) return "";
  const m4 = ip.match(/^(\d+\.\d+\.\d+\.\d+)(?::\d+)?$/);
  if (m4) return m4[1];
  const m6 = ip.match(/^\[([0-9a-fA-F:]+)\](?::\d+)?$/);
  if (m6) return m6[1];
  return ip;
}

const CP1252_TO_BYTE = new Map([ [ 8364, 128 ], [ 129, 129 ], [ 8218, 130 ], [ 402, 131 ], [ 8222, 132 ], [ 8230, 133 ], [ 8224, 134 ], [ 8225, 135 ], [ 710, 136 ], [ 8240, 137 ], [ 352, 138 ], [ 8249, 139 ], [ 338, 140 ], [ 141, 141 ], [ 381, 142 ], [ 143, 143 ], [ 144, 144 ], [ 8216, 145 ], [ 8217, 146 ], [ 8220, 147 ], [ 8221, 148 ], [ 8226, 149 ], [ 8211, 150 ], [ 8212, 151 ], [ 732, 152 ], [ 8482, 153 ], [ 353, 154 ], [ 8250, 155 ], [ 339, 156 ], [ 157, 157 ], [ 382, 158 ], [ 376, 159 ] ]);

function charToCP1252Byte(cp) {
  if (cp <= 127) return cp;
  if (cp >= 160 && cp <= 255) return cp;
  const m = CP1252_TO_BYTE.get(cp);
  return m !== void 0 ? m : -1;
}

const FANCY_CHAR_MAP = new Map([ [ "₣", "F" ], [ "ƒ", "f" ], [ "đ", "d" ], [ "Đ", "D" ], [ "þ", "th" ], [ "Þ", "TH" ], [ "ł", "l" ], [ "Ł", "L" ], [ "æ", "ae" ], [ "Æ", "AE" ], [ "œ", "oe" ], [ "Œ", "OE" ], [ "ø", "o" ], [ "Ø", "O" ], [ "ß", "ss" ], [ "ı", "i" ], [ "ĸ", "k" ], [ "Ŧ", "T" ], [ "ŧ", "t" ], [ "Ð", "D" ], [ "ð", "d" ] ]);

function normalizeNicknameDisplay(nick) {
  nick = String(nick || "");
  if (!nick) return nick;
  let clean = nick.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  if (!clean) return nick.trim();
  let mapped = "";
  for (const ch of clean) mapped += FANCY_CHAR_MAP.get(ch) || ch;
  if (/[\u00c0-\u024f\u1e00-\u1eff\u2070-\u209f\u20a0-\u20cf\uff00-\uffef]/.test(mapped)) {
    const asciiLike = mapped.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    const letters = asciiLike.replace(/[^\p{L}\p{N}]/gu, "");
    if (/[A-Za-z]/.test(letters) && !/[А-Яа-яЁё]/.test(letters)) clean = asciiLike; else clean = mapped;
  } else clean = mapped;
  clean = clean.replace(/\s+/g, " ").trim();
  return clean || nick;
}

function fixCrazyNick(nick) {
  nick = String(nick || "");
  if (!nick) return nick;
  let needsFix = false;
  for (let i = 0; i < nick.length; i++) {
    const c = nick.charCodeAt(i);
    if (c >= 192 && c <= 255 || CP1252_TO_BYTE.has(c)) {
      needsFix = true;
      break;
    }
  }
  if (!needsFix) return normalizeNicknameDisplay(nick);
  const bytes = [];
  for (let i = 0; i < nick.length; i++) {
    const cp = nick.codePointAt(i);
    const b = charToCP1252Byte(cp);
    if (b < 0) return normalizeNicknameDisplay(nick);
    bytes.push(b);
    if (cp > 65535) i++;
  }
  try {
    const decoded = new TextDecoder("utf-8", {
      fatal: true
    }).decode(Buffer.from(bytes));
    if (decoded && decoded !== nick) return normalizeNicknameDisplay(decoded);
  } catch {}
  return normalizeNicknameDisplay(nick);
}

function decodeIfNeeded(s) {
  if (s === null || s === void 0 || s === "") return "";
  return normalizeNicknameDisplay(fixCrazyNick(String(s)));
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, {
    recursive: true
  });
}

const ONLINE_STALE_SEC = 120;

let _onlineMap = {};

let _diskLoaded = false;

let _onlineDirty = false;

function nowSec() {
  return Math.floor(Date.now() / 1e3);
}

function isOnlineEntryFresh(entry) {
  if (!entry || typeof entry !== "object") return false;
  const ts = parseInt(entry._ts || 0, 10);
  if (!ts) return false;
  return nowSec() - ts <= ONLINE_STALE_SEC;
}

function normalizeOnlineRow(row) {
  if (!row || typeof row !== "object") return null;
  const out = {
    ...row
  };
  out._ts = nowSec();
  return out;
}

function readOnlineMap() {
  if (_diskLoaded) return _onlineMap;
  _diskLoaded = true;
  ensureDataDir();
  const f = join(DATA_DIR, "online.json");
  if (!existsSync(f)) {
    _onlineMap = {};
    return {};
  }
  try {
    const raw = readFileSync(f, "utf8");
    const j = JSON.parse(raw || "{}");
    if (!j || typeof j !== "object") {
      _onlineMap = {};
      return {};
    }
    const map = {};
    if (Array.isArray(j)) {
      for (const row of j) {
        if (!row || typeof row !== "object") continue;
        const sid64 = String(row.steamid64 || row.sid64 || "");
        if (sid64 && /^\d+$/.test(sid64)) {
          map[sid64] = {
            ...row,
            _ts: 0
          };
        }
      }
    } else {
      for (const [key, val] of Object.entries(j)) {
        if (val && typeof val === "object" && /^\d+$/.test(String(key))) {
          map[key] = {
            ...val,
            _ts: 0
          };
        }
      }
    }
    _onlineMap = map;
    return map;
  } catch {
    _onlineMap = {};
    return {};
  }
}

function flushOnlineToDisk() {
  if (!_onlineDirty) return;
  ensureDataDir();
  const f = join(DATA_DIR, "online.json");
  const tmp = f + ".tmp";
  const json = JSON.stringify(_onlineMap || {}, null, 2);
  try {
    writeFileSync(tmp, json, "utf8");
    renameSync(tmp, f);
  } catch {
    writeFileSync(f, json, "utf8");
  }
}

function writeOnlineMap(data) {
  if (!data || typeof data !== "object") return;
  _diskLoaded = true;
  const map = {};
  if (Array.isArray(data)) {
    for (const row of data) {
      const norm = normalizeOnlineRow(row);
      if (!norm) continue;
      const sid64 = String(norm.steamid64 || norm.sid64 || "");
      if (sid64 && /^\d+$/.test(sid64)) map[sid64] = norm;
    }
  } else {
    for (const [key, val] of Object.entries(data)) {
      if (!val || typeof val !== "object") continue;
      if (!/^\d+$/.test(String(key))) continue;
      map[String(key)] = normalizeOnlineRow(val);
    }
  }
  _onlineMap = map;
  _onlineDirty = true;
}

function getOnlineStatus(sid64, online) {
  const row = online ? online[sid64] : null;
  if (!row || !isOnlineEntryFresh(row)) {
    return {
      online: false,
      nick: "",
      ping: 0
    };
  }
  const is = row.online !== void 0 ? Boolean(row.online) : true;
  return {
    online: is,
    nick: decodeIfNeeded(row.nick || ""),
    ping: parseInt(row.ping || 0, 10)
  };
}

function readQueueFile() {
  ensureDataDir();
  const f = join(DATA_DIR, "queue.json");
  if (!existsSync(f)) {
    writeFileSync(f, "[]", "utf8");
    return [];
  }
  try {
    return JSON.parse(readFileSync(f, "utf8") || "[]");
  } catch {
    return [];
  }
}

function writeQueueFile(data) {
  ensureDataDir();
  const f = join(DATA_DIR, "queue.json");
  const tmp = f + ".tmp";
  if (Array.isArray(data)) {
    const now = Math.floor(Date.now() / 1e3);
    data = data.filter(cmd => {
      if (!cmd) return false;
      if (cmd.done) return now - (cmd.done_time || cmd.time || 0) < 600;
      return true;
    });
    if (data.length > 500) data = data.slice(-500);
  }
  const json = JSON.stringify(data || [], null, 2);
  try {
    writeFileSync(tmp, json, "utf8");
    renameSync(tmp, f);
  } catch {
    writeFileSync(f, json, "utf8");
  }
}

async function steamGetPersonaname(steamApiKey, sid64) {
  if (!steamApiKey || !sid64 || !/^\d+$/.test(sid64)) return "";
  try {
    const url = "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=" + encodeURIComponent(steamApiKey) + "&steamids=" + encodeURIComponent(sid64);
    const r = await fetch(url, {
      signal: AbortSignal.timeout(6e3),
      headers: {
        "User-Agent": "VibeRP-WebPanel"
      }
    });
    if (!r.ok) return "";
    const j = await r.json();
    return String(j?.response?.players?.[0]?.personaname || "").trim();
  } catch {
    return "";
  }
}

async function steamGetAvatarBatch(steamApiKey, sid64s) {
  const out = {};
  if (!steamApiKey || !Array.isArray(sid64s) || !sid64s.length) return out;
  const missing = [];
  for (const s of sid64s) {
    const cached = avatarCache.get(s);
    if (cached !== void 0) out[s] = cached; else missing.push(s);
  }
  if (!missing.length) return out;
  const chunks = [];
  for (let i = 0; i < missing.length; i += 100) {
    chunks.push(missing.slice(i, i + 100));
  }
  for (const chunk of chunks) {
    try {
      const ids = chunk.map(s => encodeURIComponent(s)).join(",");
      const url = "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=" + encodeURIComponent(steamApiKey) + "&steamids=" + ids;
      const r = await fetch(url, {
        signal: AbortSignal.timeout(8e3),
        headers: {
          "User-Agent": "VibeRP-WebPanel"
        }
      });
      if (!r.ok) continue;
      const j = await r.json();
      const players = j?.response?.players || [];
      for (const p of players) {
        const sid = String(p?.steamid || "");
        const avatar = String(p?.avatarmedium || p?.avatarfull || "").trim();
        const final = avatar || "/img/noavatar.png";
        avatarCache.set(sid, final);
        out[sid] = final;
      }
      for (const sid of chunk) {
        if (!(sid in out)) {
          avatarCache.set(sid, "/img/noavatar.png");
          out[sid] = "/img/noavatar.png";
        }
      }
    } catch {
      for (const sid of chunk) {
        if (!(sid in out)) out[sid] = "/img/noavatar.png";
      }
    }
  }
  return out;
}

async function steamWorkshopDetails(workshopId) {
  const id = String(workshopId || "").trim();
  if (!id || !/^\d+$/.test(id)) return null;
  const cached = workshopCache.get(id);
  if (cached !== void 0) return cached;
  try {
    const r = await fetch("https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/", {
      method: "POST",
      body: new URLSearchParams({
        itemcount: "1",
        "publishedfileids[0]": id
      }),
      signal: AbortSignal.timeout(6e3)
    });
    if (!r.ok) return null;
    const j = await r.json();
    const d = j?.response?.publishedfiledetails?.[0];
    if (!d || d.result !== 1) return null;
    const result = {
      title: String(d.title || ""),
      preview_url: String(d.preview_url || ""),
      file_size: d.file_size != null ? Number(d.file_size) : null
    };
    workshopCache.set(id, result);
    return result;
  } catch {
    return null;
  }
}

async function checkVacBans(steamApiKey, sid64) {
  if (!steamApiKey) return null;
  try {
    const url = "https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=" + encodeURIComponent(steamApiKey) + "&steamids=" + encodeURIComponent(sid64);
    const r = await fetch(url, {
      signal: AbortSignal.timeout(5e3),
      headers: {
        "User-Agent": "VibeRP-WebPanel"
      }
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.players?.[0] || null;
  } catch {
    return null;
  }
}

async function logAdminAction(pool, adminSteamid64, action, target, details) {
  try {
    await pool.query("INSERT INTO admin_logs (admin_steamid64, action, target, details, timestamp) VALUES (?, ?, ?, ?, ?)", [ adminSteamid64, action, target, details, Math.floor(Date.now() / 1e3) ]);
  } catch {}
}

export { ONLINE_STALE_SEC, checkVacBans, decodeIfNeeded, fixCrazyNick, normalizeNicknameDisplay, flushOnlineToDisk, getOnlineStatus, isOnlineEntryFresh, logAdminAction, readOnlineMap, readQueueFile, steamGetAvatarBatch, steamGetPersonaname, steamWorkshopDetails, steamid64ToSteamid, steamidToSteamid64, stripPort, writeOnlineMap, writeQueueFile };
