import { Router } from "express";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { decodeIfNeeded, logAdminAction, readQueueFile, writeQueueFile } from "../lib/helpers.js";

import { withQueueLock } from "../lib/queue_lock.js";

function playerWeaponsRoutes() {
  const r = Router();
  r.get("/api/player_weapons", authGuard, requirePerm("view_profile"), async (req, res) => {
    try {
      const pool = db();
      const steamid32 = String(req.query.steamid32 || "").trim();
      if (!steamid32) return res.json({
        ok: true,
        items: []
      });
      const [rows] = await pool.query(`SELECT pw.weapon_id, pw.issued_by, UNIX_TIMESTAMP(pw.issued_at) AS issued_at,\n         w.weapon_class, w.name AS title\n         FROM panel_player_weapons pw JOIN panel_weapons w ON w.id = pw.weapon_id\n         WHERE pw.steamid32 = ? ORDER BY pw.issued_at DESC`, [ steamid32 ]);
      const items = rows.map(row => ({
        weapon_id: row.weapon_id,
        weapon_class: String(row.weapon_class),
        title: decodeIfNeeded(row.title || ""),
        issued_by: decodeIfNeeded(row.issued_by || ""),
        issued_at: parseInt(row.issued_at || 0, 10)
      }));
      res.json({
        ok: true,
        items: items
      });
    } catch (e) {
      console.error("player_weapons get error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/player_weapons", authGuard, requirePerm("give_weapon"), async (req, res) => {
    try {
      const pool = db();
      const data = req.body;
      const action = String(data.action || "").trim();
      const steamid32 = String(data.steamid32 || "").trim();
      const weaponId = parseInt(data.weapon_id || 0, 10);
      if (action === "give") {
        if (!steamid32 || weaponId <= 0) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        const nick = req.session.user?.nickname || "Site";
        await pool.query("INSERT IGNORE INTO panel_player_weapons (steamid32, weapon_id, issued_by, issued_at) VALUES (?, ?, ?, NOW())", [ steamid32, weaponId, nick ]);
        if (req.session.user) {
          await logAdminAction(pool, req.session.user.steamid64, "GIVE_WEAPON", steamid32, `weapon_id: ${weaponId}`);
        }
        try {
          const [[wRow]] = await pool.query("SELECT weapon_class FROM panel_weapons WHERE id = ? LIMIT 1", [ weaponId ]);
          if (wRow && wRow.weapon_class) {
            await withQueueLock(async () => {
              const queue = readQueueFile();
              const now = Math.floor(Date.now() / 1e3);
              const cmdText = `giveweapon ${steamid32} ${wRow.weapon_class}`;
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
          }
        } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
        return res.json({
          ok: true
        });
      }
      if (action === "revoke") {
        if (!steamid32 || weaponId <= 0) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        let weaponClass = "";
        try {
          const [[wRow]] = await pool.query("SELECT weapon_class FROM panel_weapons WHERE id = ? LIMIT 1", [ weaponId ]);
          if (wRow) weaponClass = wRow.weapon_class || "";
        } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
        await pool.query("DELETE FROM panel_player_weapons WHERE steamid32 = ? AND weapon_id = ? LIMIT 1", [ steamid32, weaponId ]);
        if (req.session.user) {
          await logAdminAction(pool, req.session.user.steamid64, "REVOKE_WEAPON", steamid32, `weapon_id: ${weaponId}`);
        }
        if (weaponClass) {
          try {
            await withQueueLock(async () => {
              const queue = readQueueFile();
              const now = Math.floor(Date.now() / 1e3);
              const cmdText = `removeweapon ${steamid32} ${weaponClass}`;
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
        }
        return res.json({
          ok: true
        });
      }
      return res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("player_weapons post error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { playerWeaponsRoutes as default };
