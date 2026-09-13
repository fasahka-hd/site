import { Router } from "express";

import { timingSafeEqual, randomUUID } from "crypto";

import { requirePerm, hasPerm, getUserRole } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { readQueueFile, writeQueueFile } from "../lib/helpers.js";

import { withQueueLock } from "../lib/queue_lock.js";

import { db } from "../lib/db.js";

const PLAYER_RANKS = new Set([ "*", "co*", "uprav", "zamuprav", "arizona-team", "project-team", "manager", "vice-manager", "head-curator", "curator", "head-admin", "admin", "moderator", "helper", "inter", "owner", "superadmin", "d-admin", "d-moderator", "vip", "User" ]);

const ALLOWED_COMMANDS = [ {
  perm: "kick",
  pattern: /^ba kick\b/
}, {
  perm: "ban",
  pattern: /^ba (ban|perma)\b/
}, {
  perm: "unban",
  pattern: /^ba unban\b/
}, {
  perm: "adminmode",
  pattern: /^ba setadminmode\b/
}, {
  perm: "give_money",
  pattern: /^ba addmoney\b/
}, {
  perm: "set_rank",
  pattern: /^ba setgroup\b/
}, {
  perm: "manage_blacklist",
  pattern: /^blacklist_(add|addip|remove|removeip)\b/
}, {
  perm: "give_model",
  pattern: /^(addmodel|removemodel)\b/
}, {
  perm: "give_weapon",
  pattern: /^(giveweapon|removeweapon)\b/
}, {
  perm: "give_job",
  pattern: /^(givejob|removejob)\b/
}, {
  perm: "give_qmenu",
  pattern: /^(giveqmenu|removeqmenu)\b/
}, {
  perm: "give_access",
  pattern: /^(panel_setprops|panel_setmodelaccess)\b/
}, {
  perm: "manage_player_donate",
  pattern: /^ba adddonate\b/
}, {
  perm: "manage_player_donate",
  pattern: /^ba (removedonate|takedonate|del_donate)\b/
}, {
  perm: "manage_promos",
  pattern: /^promo_/
}, {
  perm: "view_money_logs",
  pattern: /^duels_reset_stats(_all)?\b/
}, {
  perm: "view_money_logs",
  pattern: /^duels_sync_now\b/
}, {
  perm: "manage_player_donate",
  pattern: /^igs_(delete_inventory_item|clear_inventory)\b/
} ];

function resolveCommandPerm(text) {
  const t = text.replace(/\s+/g, " ").toLowerCase().trim();
  for (const {perm: perm, pattern: pattern} of ALLOWED_COMMANDS) {
    if (pattern.test(t)) return perm;
  }
  return "raw_console";
}

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    const tmp = Buffer.alloc(bufA.length);
    timingSafeEqual(bufA, tmp);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function commandsRoutes(cfg) {
  const r = Router();
  r.post("/api/command", authGuard, async (req, res) => {
    const type = String(req.body.type || "console").trim();
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({
      ok: false,
      error: "EMPTY_COMMAND"
    });
    if (text.length > 512) return res.status(400).json({
      ok: false,
      error: "COMMAND_TOO_LONG"
    });
    if (type !== "console") return res.status(400).json({
      ok: false,
      error: "BAD_TYPE"
    });
    const setGroupMatch = text.match(/^ba\s+setgroup\s+(\S+)\s+(\S+)\s*$/i);
    if (setGroupMatch && !PLAYER_RANKS.has(setGroupMatch[2])) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PLAYER_RANK",
        rank: setGroupMatch[2]
      });
    }
    const role = getUserRole(req.session);
    const adminSid64 = String(req.session?.user?.steamid64 || "");
    const neededPerm = resolveCommandPerm(text);
    if (neededPerm === "raw_console" && req.body?.confirm_raw !== true) {
      return res.status(403).json({ ok: false, error: "CONFIRM_RAW_REQUIRED" });
    }
    if (!hasPerm(role, neededPerm)) return res.status(403).json({
      ok: false,
      error: "FORBIDDEN",
      perm: neededPerm
    });
    let conn;
    let id = null;
    try {
      conn = await db().getConnection();
      await conn.beginTransaction();
      const now = Math.floor(Date.now() / 1e3);
      const sgMatch = text.match(/^ba\s+setgroup\s+(\S+)\s+(\S+)\s*$/i);
      let reuseId = null;
      if (sgMatch) {
        const targetSteam = sgMatch[1].toUpperCase();
        const [rows] = await conn.query("SELECT id FROM command_queue WHERE done = 0 AND text LIKE ? ORDER BY time DESC LIMIT 1", ["%setgroup " + targetSteam + "%"]);
        if (rows.length) reuseId = rows[0].id;
      }
      if (!reuseId) {
        id = "cmd_" + now + "_" + randomUUID().slice(0, 8);
        await conn.query("INSERT INTO command_queue (id, type, text, admin_steamid64, done, processing, time) VALUES (?, ?, ?, ?, 0, 0, ?)", [id, type, text, adminSid64, now]);
      } else {
        id = reuseId;
        await conn.query("UPDATE command_queue SET text = ?, admin_steamid64 = ?, time = ?, processing = 0, processing_time = 0 WHERE id = ?", [text, adminSid64, now, id]);
      }
      await conn.commit();
      await conn.release();
    } catch (e) {
      console.error("command queue db error:", e.message);
      if (conn) { try { await conn.rollback(); } catch (_) {}; try { await conn.release(); } catch (_) {}; }
      return res.status(500).json({ ok: false, error: "DB_ERROR" });
    }
    try {
      const parts = text.trim().split(/\s+/);
      const action = parts.slice(0, 2).join(" ");
      const target = parts[2] || "";
      await db().query("INSERT INTO admin_logs (admin_steamid64, action, target, details, timestamp) VALUES (?, ?, ?, ?, ?)", [ adminSid64, action, target, text, Math.floor(Date.now() / 1e3) ]);
    } catch (e) { console.error("command admin log error:", e && e.message ? e.message : e); }
    res.json({
      ok: true,
      id: id
    });
  });
  function requirePassword(req, res) {
    const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const pass = String(req.body?.password || req.headers["x-api-password"] || auth || "").trim();
    if (!cfg.WEB_SECRET || !safeCompare(pass, cfg.WEB_SECRET)) {
      console.warn(`[QUEUE API] bad password on ${req.method} ${req.path} from ${req.ip}`);
      res.status(403).json({ ok: false, error: "BAD_PASSWORD" });
      return false;
    }
    if (cfg.ALLOWED_QUEUE_IPS) {
      const allowed = Array.isArray(cfg.ALLOWED_QUEUE_IPS) ? cfg.ALLOWED_QUEUE_IPS : [cfg.ALLOWED_QUEUE_IPS];
      const ip = req.ip || req.connection?.remoteAddress || "";
      if (!allowed.includes(ip)) {
        console.warn(`[QUEUE API] bad IP ${ip} on ${req.path}`);
        res.status(403).json({ ok: false, error: "BAD_IP" });
        return false;
      }
    }
    return true;
  }
  r.get("/api/get", async (req, res) => {
    if (!requirePassword(req, res)) return;
    try {
      const now = Math.floor(Date.now() / 1e3);
      const timeout = 30;
      await db().query("UPDATE command_queue SET processing = 0, processing_time = 0, tries = COALESCE(tries, 0) + 1, done = IF(COALESCE(tries, 0) + 1 >= 10, 1, done), done_time = IF(COALESCE(tries, 0) + 1 >= 10, ?, 0), error = IF(COALESCE(tries, 0) + 1 >= 10, 'TIMEOUT', error) WHERE processing = 1 AND ? - processing_time > ?", [now, now, timeout]);
      const [rows] = await db().query("SELECT * FROM command_queue WHERE done = 0 AND processing = 0 ORDER BY time ASC LIMIT 25");
      if (rows.length) {
        for (const r of rows) {
          await db().query("UPDATE command_queue SET processing = 1, processing_time = ? WHERE id = ?", [now, r.id]);
        }
      }
      res.json(rows);
    } catch (e) {
      console.error("get error:", e.message);
      res.status(500).json([]);
    }
  });
  r.post("/api/mark", async (req, res) => {
    if (!requirePassword(req, res)) return;
    try {
      const id = String(req.body.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "NO_ID" });
      const now = Math.floor(Date.now() / 1e3);
      const [result] = await db().query("UPDATE command_queue SET done = 1, done_time = ?, processing = 0, processing_time = 0 WHERE id = ?", [now, id]);
      if (result.affectedRows === 0) return res.status(404).json({ ok: false, error: "CMD_NOT_FOUND" });
      res.json({ ok: true });
    } catch (e) {
      console.error("mark error:", e.message);
      res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
    }
  });
  return r;
}

export { commandsRoutes as default };
