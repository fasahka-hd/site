import { Router } from "express";

import { db } from "../lib/db.js";

import { authGuard } from "../lib/guard.js";

import { requirePerm } from "../lib/roles.js";

import { steamid64ToSteamid, steamidToSteamid64, decodeIfNeeded, logAdminAction } from "../lib/helpers.js";

const EMOJI_CATALOG = [ {
  emoji: "👑",
  name: "Корона"
}, {
  emoji: "🎩",
  name: "Шляпа"
}, {
  emoji: "🔥",
  name: "Огонь"
}, {
  emoji: "⚡",
  name: "Молния"
}, {
  emoji: "💎",
  name: "Алмаз"
}, {
  emoji: "🌟",
  name: "Звезда"
}, {
  emoji: "🛡️",
  name: "Щит"
}, {
  emoji: "🎯",
  name: "Таргет"
}, {
  emoji: "🦊",
  name: "Лиса"
}, {
  emoji: "🐉",
  name: "Дракон"
}, {
  emoji: "🧊",
  name: "Лёд"
}, {
  emoji: "💀",
  name: "Череп"
}, {
  emoji: "😎",
  name: "Крутой"
}, {
  emoji: "🚀",
  name: "Ракета"
}, {
  emoji: "🍀",
  name: "Удача"
}, {
  emoji: "🏆",
  name: "Кубок"
} ];

const EMOJI_SET = new Set(EMOJI_CATALOG.map(x => x.emoji));

function normalizeSteamId(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^\d{17}$/.test(raw)) {
    const sid32 = steamid64ToSteamid(raw);
    if (!sid32) return null;
    return {
      steamid64: raw,
      steamid32: sid32
    };
  }
  const sid64 = steamidToSteamid64(raw.toUpperCase());
  if (!sid64) return null;
  return {
    steamid64: sid64,
    steamid32: steamid64ToSteamid(sid64)
  };
}

function cleanTitle(value) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 64);
}

function rowToBadge(row) {
  if (!row) return null;
  return {
    id: row.id,
    steamid64: String(row.steamid64 || ""),
    steamid32: String(row.steamid32 || ""),
    emoji: String(row.emoji || ""),
    title: decodeIfNeeded(row.title || ""),
    issued_by: decodeIfNeeded(row.issued_by || ""),
    issued_at: parseInt(row.issued_at_ts || row.issued_at || 0, 10),
    updated_at: parseInt(row.updated_at_ts || row.updated_at || 0, 10),
    active: Boolean(row.active)
  };
}

async function findBadge(pool, steamid64) {
  const [rows] = await pool.query(`SELECT id, steamid64, steamid32, emoji, title, issued_by, active,\n     UNIX_TIMESTAMP(issued_at) AS issued_at_ts, UNIX_TIMESTAMP(updated_at) AS updated_at_ts\n     FROM panel_player_emojis WHERE steamid64 = ? AND active = 1 LIMIT 1`, [ steamid64 ]);
  return rowToBadge(rows[0]);
}

function emojisRoutes() {
  const r = Router();
  r.get("/api/emojis/catalog", authGuard, requirePerm("manage_emojis"), (_req, res) => {
    res.json({
      ok: true,
      items: EMOJI_CATALOG
    });
  });
  r.get("/api/player_emojis", authGuard, requirePerm("manage_emojis"), async (req, res) => {
    try {
      const pool = db();
      const sid = String(req.query.steamid || "").trim();
      if (sid) {
        const ids = normalizeSteamId(sid);
        if (!ids) return res.status(400).json({
          ok: false,
          error: "BAD_STEAMID"
        });
        return res.json({
          ok: true,
          item: await findBadge(pool, ids.steamid64)
        });
      }
      const [rows] = await pool.query(`SELECT id, steamid64, steamid32, emoji, title, issued_by, active,\n         UNIX_TIMESTAMP(issued_at) AS issued_at_ts, UNIX_TIMESTAMP(updated_at) AS updated_at_ts\n         FROM panel_player_emojis WHERE active = 1 ORDER BY updated_at DESC LIMIT 500`);
      res.json({
        ok: true,
        items: rows.map(rowToBadge)
      });
    } catch (e) {
      console.error("player_emojis get error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/player_emojis", authGuard, requirePerm("manage_emojis"), async (req, res) => {
    try {
      const pool = db();
      const action = String(req.body.action || "give").trim();
      const ids = normalizeSteamId(req.body.steamid || req.body.steamid64 || req.body.steamid32);
      if (!ids) return res.status(400).json({
        ok: false,
        error: "BAD_STEAMID"
      });
      if (action === "give") {
        const emoji = String(req.body.emoji || "").trim();
        const title = cleanTitle(req.body.title);
        if (!EMOJI_SET.has(emoji)) return res.status(400).json({
          ok: false,
          error: "BAD_EMOJI"
        });
        if (!title) return res.status(400).json({
          ok: false,
          error: "NO_TITLE"
        });
        const [existing] = await pool.query("SELECT emoji, title FROM panel_player_emojis WHERE steamid64 = ? AND active = 1 LIMIT 1", [ ids.steamid64 ]);
        if (existing.length) return res.status(409).json({
          ok: false,
          error: "EMOJI_ALREADY_EXISTS"
        });
        const by = cleanTitle(req.session?.user?.nickname || req.session?.user?.steamid64 || "KP");
        await pool.query(`INSERT INTO panel_player_emojis (steamid64, steamid32, emoji, title, issued_by, active)\n           VALUES (?, ?, ?, ?, ?, 1)\n           ON DUPLICATE KEY UPDATE steamid32=VALUES(steamid32), emoji=VALUES(emoji), title=VALUES(title),\n           issued_by=VALUES(issued_by), active=1, updated_at=CURRENT_TIMESTAMP`, [ ids.steamid64, ids.steamid32, emoji, title, by ]);
        await logAdminAction(pool, req.session.user?.steamid64 || "", "GIVE_EMOJI", ids.steamid64, `${emoji} ${title}`);
        return res.json({
          ok: true,
          item: await findBadge(pool, ids.steamid64)
        });
      }
      if (action === "revoke") {
        await pool.query("UPDATE panel_player_emojis SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE steamid64 = ? LIMIT 1", [ ids.steamid64 ]);
        await logAdminAction(pool, req.session.user?.steamid64 || "", "REVOKE_EMOJI", ids.steamid64, "");
        return res.json({
          ok: true
        });
      }
      return res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("player_emojis post error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.get("/api/player_badge", authGuard, requirePerm("view_profile"), async (req, res) => {
    try {
      const ids = normalizeSteamId(req.query.steamid || req.query.sid || "");
      if (!ids) return res.status(400).json({
        ok: false,
        error: "BAD_STEAMID"
      });
      res.json({
        ok: true,
        item: await findBadge(db(), ids.steamid64)
      });
    } catch (e) {
      console.error("player_badge error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

function normalizeEmojiSteamId(value) {
  return normalizeSteamId(value);
}

async function getPlayerBadge(pool, steamid64) {
  return findBadge(pool, steamid64);
}

export { EMOJI_CATALOG, emojisRoutes as default, getPlayerBadge, normalizeEmojiSteamId };
