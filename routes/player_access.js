import { Router } from "express";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { decodeIfNeeded, logAdminAction, readQueueFile, writeQueueFile } from "../lib/helpers.js";

import { withQueueLock } from "../lib/queue_lock.js";

function normalizePropsAmount(value) {
  const n = parseInt(value || 0, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1e5, n));
}

let _accessTableEnsured = false;

async function ensureAccessTable() {
  if (_accessTableEnsured) return;
  try {
    await db().query(`CREATE TABLE IF NOT EXISTS panel_player_access (\n      steamid32 VARCHAR(32) NOT NULL,\n      props_extra INT UNSIGNED NOT NULL DEFAULT 0,\n      setmodel TINYINT(1) NOT NULL DEFAULT 0,\n      issued_by VARCHAR(64) NOT NULL DEFAULT '',\n      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n      PRIMARY KEY (steamid32)\n    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    _accessTableEnsured = true;
  } catch (e) {
    console.error("ensureAccessTable failed:", e.message);
  }
}

async function pushConsole(text) {
  try {
    await withQueueLock(async () => {
      const queue = readQueueFile();
      const now = Math.floor(Date.now() / 1e3);
      const cmdId = "cmd_" + now + "_" + Math.floor(1e3 + Math.random() * 9e3);
      queue.push({
        id: cmdId,
        type: "console",
        text: text,
        done: false,
        processing: false,
        time: now
      });
      writeQueueFile(queue);
    });
  } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
}

function playerAccessRoutes() {
  const r = Router();
  r.get("/api/player_access", authGuard, requirePerm("view_profile"), async (req, res) => {
    try {
      await ensureAccessTable();
      const steamid32 = String(req.query.steamid32 || "").trim();
      if (!steamid32) return res.json({
        ok: true,
        item: {
          props_extra: 0,
          setmodel: false
        }
      });
      const [rows] = await db().query(`SELECT props_extra, setmodel, issued_by, UNIX_TIMESTAMP(updated_at) AS updated_at\n         FROM panel_player_access WHERE steamid32 = ? LIMIT 1`, [ steamid32 ]);
      const row = rows[0] || {};
      res.json({
        ok: true,
        item: {
          props_extra: parseInt(row.props_extra || 0, 10),
          setmodel: Boolean(row.setmodel),
          issued_by: decodeIfNeeded(row.issued_by || ""),
          updated_at: parseInt(row.updated_at || 0, 10)
        }
      });
    } catch (e) {
      console.error("player_access get error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/player_access", authGuard, requirePerm("give_access"), async (req, res) => {
    try {
      await ensureAccessTable();
      const data = req.body || {};
      const action = String(data.action || "save").trim();
      const steamid32 = String(data.steamid32 || "").trim();
      if (!steamid32) return res.status(400).json({
        ok: false,
        error: "BAD_STEAMID"
      });
      const nick = req.session.user?.nickname || "Site";
      if (action === "save") {
        const propsExtra = normalizePropsAmount(data.props_extra);
        const setmodel = data.setmodel ? 1 : 0;
        await db().query(`INSERT INTO panel_player_access (steamid32, props_extra, setmodel, issued_by, updated_at)\n           VALUES (?, ?, ?, ?, NOW())\n           ON DUPLICATE KEY UPDATE props_extra=VALUES(props_extra), setmodel=VALUES(setmodel), issued_by=VALUES(issued_by), updated_at=NOW()`, [ steamid32, propsExtra, setmodel, nick ]);
        if (req.session.user) {
          await logAdminAction(db(), req.session.user.steamid64, "SET_PLAYER_ACCESS", steamid32, `props_extra: ${propsExtra}, setmodel: ${setmodel}`);
        }
        await pushConsole(`panel_setprops ${steamid32} ${propsExtra}`);
        await pushConsole(`panel_setmodelaccess ${steamid32} ${setmodel}`);
        return res.json({
          ok: true
        });
      }
      if (action === "clear") {
        await db().query("DELETE FROM panel_player_access WHERE steamid32 = ? LIMIT 1", [ steamid32 ]);
        if (req.session.user) {
          await logAdminAction(db(), req.session.user.steamid64, "CLEAR_PLAYER_ACCESS", steamid32, "");
        }
        await pushConsole(`panel_setprops ${steamid32} 0`);
        await pushConsole(`panel_setmodelaccess ${steamid32} 0`);
        return res.json({
          ok: true
        });
      }
      return res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("player_access post error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { playerAccessRoutes as default };
