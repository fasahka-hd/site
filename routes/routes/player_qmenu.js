import { Router } from "express";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { decodeIfNeeded, logAdminAction, readQueueFile, writeQueueFile } from "../lib/helpers.js";

import { withQueueLock } from "../lib/queue_lock.js";

function playerQmenuRoutes() {
  const r = Router();
  r.get("/api/player_qmenu", authGuard, requirePerm("view_profile"), async (req, res) => {
    try {
      const pool = db();
      const steamid32 = String(req.query.steamid32 || "").trim();
      if (!steamid32) return res.json({
        ok: true,
        items: []
      });
      const [rows] = await pool.query(`SELECT access_type, issued_by, UNIX_TIMESTAMP(issued_at) AS issued_at\n         FROM panel_player_qmenu\n         WHERE steamid32 = ? ORDER BY issued_at DESC`, [ steamid32 ]);
      const items = rows.map(row => ({
        access_type: String(row.access_type),
        issued_by: decodeIfNeeded(row.issued_by || ""),
        issued_at: parseInt(row.issued_at || 0, 10)
      }));
      res.json({
        ok: true,
        items: items
      });
    } catch (e) {
      console.error("player_qmenu get error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/player_qmenu", authGuard, requirePerm("give_qmenu"), async (req, res) => {
    try {
      const pool = db();
      const data = req.body;
      const action = String(data.action || "").trim();
      const steamid32 = String(data.steamid32 || "").trim();
      const accessType = String(data.access_type || "").trim();
      if (![ "qmenu", "qmenuplus" ].includes(accessType)) {
        return res.status(400).json({
          ok: false,
          error: "BAD_ACCESS_TYPE"
        });
      }
      if (action === "give") {
        if (!steamid32) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        const nick = req.session.user?.nickname || "Site";
        await pool.query("INSERT IGNORE INTO panel_player_qmenu (steamid32, access_type, issued_by, issued_at) VALUES (?, ?, ?, NOW())", [ steamid32, accessType, nick ]);
        if (req.session.user) {
          await logAdminAction(pool, req.session.user.steamid64, "GIVE_QMENU", steamid32, `type: ${accessType}`);
        }
        try {
          await withQueueLock(async () => {
            const queue = readQueueFile();
            const now = Math.floor(Date.now() / 1e3);
            const cmdText = `giveqmenu ${steamid32} ${accessType}`;
            const cmdId = "cmd_" + now + "_" + Math.floor(1e3 + Math.random() * 9e3);
            queue.push({
              id: cmdId,
              type: "console",
              text: cmdText,
              done: false,
              processing: false,
              time: now
            });
            writeQueueFile(queue);
          });
        } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
        return res.json({
          ok: true
        });
      }
      if (action === "revoke") {
        if (!steamid32) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        await pool.query("DELETE FROM panel_player_qmenu WHERE steamid32 = ? AND access_type = ? LIMIT 1", [ steamid32, accessType ]);
        if (req.session.user) {
          await logAdminAction(pool, req.session.user.steamid64, "REVOKE_QMENU", steamid32, `type: ${accessType}`);
        }
        try {
          await withQueueLock(async () => {
            const queue = readQueueFile();
            const now = Math.floor(Date.now() / 1e3);
            const cmdText = `removeqmenu ${steamid32} ${accessType}`;
            const cmdId = "cmd_" + now + "_" + Math.floor(1e3 + Math.random() * 9e3);
            queue.push({
              id: cmdId,
              type: "console",
              text: cmdText,
              done: false,
              processing: false,
              time: now
            });
            writeQueueFile(queue);
          });
        } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
        return res.json({
          ok: true
        });
      }
      return res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("player_qmenu post error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { playerQmenuRoutes as default };
