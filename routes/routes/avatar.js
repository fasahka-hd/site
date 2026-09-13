import { Router } from "express";

import multer from "multer";

import { existsSync, mkdirSync, createReadStream, readFileSync, statSync, unlinkSync } from "fs";

import { join, extname } from "path";

import { randomUUID } from "crypto";

import { authGuard } from "../lib/guard.js";

import { requirePerm } from "../lib/roles.js";

import { steamidToSteamid64 } from "../lib/helpers.js";

import { AVATAR_DIR, getCustomAvatarUrl, setCustomAvatar, removeCustomAvatar, listCustomAvatars } from "../lib/avatars.js";

import { resolveAvatar, resolveAvatarBatch, serveCachedAvatar } from "../lib/avatar_cache.js";

import { avatarCache } from "../lib/lru_cache.js";

const AV_MAX = 8 * 1024 * 1024;

const AV_ALLOWED = new Map([ [ "image/jpeg", ".jpg" ], [ "image/jpg", ".jpg" ], [ "image/pjpeg", ".jpg" ], [ "image/png", ".png" ], [ "image/webp", ".webp" ] ]);

const MAGIC_BYTES = {
  "ÿØÿ": ".jpg",
  "PNG\r\n\n": ".png",
  RIFF: ".webp"
};

function checkMagicBytes(filepath, expectedExt) {
  try {
    const buf = readFileSync(filepath);
    if (buf.length < 4) return false;
    if (buf[0] === 255 && buf[1] === 216 && buf[2] === 255) {
      return expectedExt === ".jpg" || expectedExt === ".jpeg";
    }
    if (buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71) {
      return expectedExt === ".png";
    }
    if (buf[0] === 82 && buf[1] === 73 && buf[2] === 70 && buf[3] === 70) {
      if (buf.length >= 12 && buf[8] === 87 && buf[9] === 69 && buf[10] === 66 && buf[11] === 80) {
        return expectedExt === ".webp";
      }
    }
    return false;
  } catch {
    return false;
  }
}

const AV_EXT = new Set([ ".jpg", ".jpeg", ".png", ".webp" ]);

const avStorage = multer.diskStorage({
  destination(req, file, cb) {
    if (!existsSync(AVATAR_DIR)) mkdirSync(AVATAR_DIR, {
      recursive: true
    });
    cb(null, AVATAR_DIR);
  },
  filename(req, file, cb) {
    const ext = AV_ALLOWED.get(file.mimetype) || extname(file.originalname).toLowerCase() || ".png";
    cb(null, randomUUID() + ext.replace(/[^a-z.]/gi, "").slice(0, 6));
  }
});

const avUpload = multer({
  storage: avStorage,
  limits: {
    fileSize: AV_MAX,
    files: 1
  },
  fileFilter(req, file, cb) {
    const ext = extname(String(file.originalname || "")).toLowerCase();
    if (AV_ALLOWED.has(file.mimetype) || AV_EXT.has(ext)) cb(null, true); else cb(null, false);
  }
});

function normSid(v) {
  const raw = String(v || "").trim();
  if (/^\d{17}$/.test(raw)) return raw;
  return steamidToSteamid64(raw) || "";
}

function avatarRoutes(cfg, steamApiLimiter) {
  const r = Router();
  r.get("/api/avatar", authGuard, steamApiLimiter, async (req, res) => {
    const sid = String(req.query.sid || "").trim();
    if (!sid || !/^\d{17}$/.test(sid)) {
      return res.json({
        ok: true,
        url: "/img/noavatar.png"
      });
    }
    const cached = avatarCache.get(sid);
    if (cached !== void 0) {
      res.setHeader("Cache-Control", "private, max-age=3600");
      return res.json({
        ok: true,
        url: cached
      });
    }
    try {
      const pool = req.app?.locals?.db || cfg.pool;
      const url = await resolveAvatar(pool, sid, cfg.STEAM_API_KEY);
      avatarCache.set(sid, url);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.json({
        ok: true,
        url: url
      });
    } catch {
      res.json({
        ok: true,
        url: "/img/noavatar.png"
      });
    }
  });
  r.post("/api/avatars", authGuard, steamApiLimiter, async (req, res) => {
    const {sids: sids} = req.body || {};
    if (!Array.isArray(sids) || !sids.length) {
      return res.status(400).json({
        ok: false,
        error: "NO_SIDS"
      });
    }
    const clean = sids.map(s => String(s).trim()).filter(s => /^\d{17}$/.test(s)).slice(0, 100);
    const result = {};
    const missing = [];
    for (const sid of clean) {
      const cached = avatarCache.get(sid);
      if (cached !== void 0) {
        result[sid] = cached;
      } else {
        missing.push(sid);
      }
    }
    if (missing.length) {
      try {
        const pool = req.app?.locals?.db || cfg.pool;
        const batch = await resolveAvatarBatch(pool, missing, cfg.STEAM_API_KEY);
        for (const [sid, url] of Object.entries(batch)) {
          result[sid] = url;
          avatarCache.set(sid, url);
        }
      } catch {
        for (const sid of missing) {
          if (!(sid in result)) result[sid] = "/img/noavatar.png";
        }
      }
    }
    for (const sid of clean) {
      if (!(sid in result)) result[sid] = "/img/noavatar.png";
    }
    res.json({
      ok: true,
      items: result
    });
  });
  r.get("/api/custom_avatar/:name", (req, res) => {
    const name = String(req.params.name || "");
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes("..")) return res.status(400).end();
    const p = join(AVATAR_DIR, name);
    if (!p.startsWith(AVATAR_DIR) || !existsSync(p)) return res.status(404).end();
    const stat = statSync(p);
    const etag = `"${stat.size}-${stat.mtimeMs}"`;
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    createReadStream(p).pipe(res);
  });
  r.post("/api/custom_avatar", authGuard, requirePerm("manage_users"), (req, res, next) => {
    avUpload.single("avatar")(req, res, err => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({
          ok: false,
          error: "FILE_TOO_LARGE"
        });
        return res.status(400).json({
          ok: false,
          error: "UPLOAD_ERROR"
        });
      }
      next();
    });
  }, (req, res) => {
    const sid = normSid(req.body.steamid || req.body.steamid64 || req.body.sid);
    if (!sid) return res.status(400).json({
      ok: false,
      error: "BAD_STEAMID"
    });
    if (!req.file) return res.status(400).json({
      ok: false,
      error: "NO_FILE_OR_BAD_TYPE"
    });
    const expectedExt = extname(req.file.filename).toLowerCase();
    if (!checkMagicBytes(req.file.path, expectedExt)) {
      try {
        unlinkSync(req.file.path);
      } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
      return res.status(400).json({
        ok: false,
        error: "INVALID_IMAGE_FILE"
      });
    }
    const by = req.session.user?.nickname || req.session.user?.steamid64 || "";
    setCustomAvatar(sid, req.file.filename, by);
    avatarCache.delete(sid);
    res.json({
      ok: true,
      url: "/api/custom_avatar/" + req.file.filename,
      steamid64: sid
    });
  });
  r.delete("/api/custom_avatar", authGuard, requirePerm("manage_users"), (req, res) => {
    const sid = normSid(req.query.steamid || req.query.sid || req.body?.steamid);
    if (!sid) return res.status(400).json({
      ok: false,
      error: "BAD_STEAMID"
    });
    const ok = removeCustomAvatar(sid);
    avatarCache.delete(sid);
    res.json({
      ok: ok
    });
  });
  r.get("/api/custom_avatar_of", authGuard, requirePerm("manage_users"), (req, res) => {
    const sid = normSid(req.query.steamid || req.query.sid);
    if (!sid) return res.status(400).json({
      ok: false,
      error: "BAD_STEAMID"
    });
    res.json({
      ok: true,
      url: getCustomAvatarUrl(sid) || null
    });
  });
  r.get("/api/custom_avatars", authGuard, requirePerm("manage_users"), (req, res) => {
    const idx = listCustomAvatars();
    const items = Object.entries(idx).map(([sid, e]) => ({
      steamid64: sid,
      url: "/api/custom_avatar/" + e.file,
      by: e.by || "",
      ts: e.ts || 0
    })).sort((a, b) => b.ts - a.ts);
    res.json({
      ok: true,
      items: items
    });
  });
  r.get("/api/avatars_cache/:name", serveCachedAvatar);
  return r;
}

export { avatarRoutes as default };
