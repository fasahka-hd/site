import { Router } from "express";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { decodeIfNeeded, logAdminAction, readQueueFile, writeQueueFile } from "../lib/helpers.js";

import { withQueueLock } from "../lib/queue_lock.js";

function playerJobsRoutes() {
  const r = Router();
  r.get("/api/player_jobs", authGuard, requirePerm("view_profile"), async (req, res) => {
    try {
      const pool = db();
      const steamid32 = String(req.query.steamid32 || "").trim();
      if (!steamid32) return res.json({
        ok: true,
        items: []
      });
      const [rows] = await pool.query(`SELECT pj.job_id, pj.given_by, UNIX_TIMESTAMP(pj.given_at) AS given_at,\n         j.job_command, j.name AS title\n         FROM panel_player_jobs pj JOIN panel_jobs j ON j.id = pj.job_id\n         WHERE pj.steamid32 = ? ORDER BY pj.given_at DESC`, [ steamid32 ]);
      const items = rows.map(row => ({
        job_id: row.job_id,
        job_command: String(row.job_command),
        title: decodeIfNeeded(row.title || ""),
        given_by: decodeIfNeeded(row.given_by || ""),
        given_at: parseInt(row.given_at || 0, 10)
      }));
      res.json({
        ok: true,
        items: items
      });
    } catch (e) {
      console.error("player_jobs get error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/player_jobs", authGuard, requirePerm("give_job"), async (req, res) => {
    try {
      const pool = db();
      const data = req.body;
      const action = String(data.action || "").trim();
      const steamid32 = String(data.steamid32 || "").trim();
      const jobId = parseInt(data.job_id || 0, 10);
      if (action === "give") {
        if (!steamid32 || jobId <= 0) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        const nick = req.session.user?.nickname || "Site";
        await pool.query("INSERT IGNORE INTO panel_player_jobs (steamid32, job_id, given_by, given_at) VALUES (?, ?, ?, NOW())", [ steamid32, jobId, nick ]);
        if (req.session.user) {
          await logAdminAction(pool, req.session.user.steamid64, "GIVE_JOB", steamid32, `job_id: ${jobId}`);
        }
        try {
          const [[jRow]] = await pool.query("SELECT job_command FROM panel_jobs WHERE id = ? LIMIT 1", [ jobId ]);
          if (jRow && jRow.job_command) {
            await withQueueLock(async () => {
              const queue = readQueueFile();
              const now = Math.floor(Date.now() / 1e3);
              const cmdText = `ba adddonate ${steamid32} ${jRow.job_command}`;
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
        if (!steamid32 || jobId <= 0) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        let jobCommand = "";
        try {
          const [[jRow]] = await pool.query("SELECT job_command FROM panel_jobs WHERE id = ? LIMIT 1", [ jobId ]);
          if (jRow) jobCommand = jRow.job_command || "";
        } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
        await pool.query("DELETE FROM panel_player_jobs WHERE steamid32 = ? AND job_id = ? LIMIT 1", [ steamid32, jobId ]);
        if (req.session.user) {
          await logAdminAction(pool, req.session.user.steamid64, "REVOKE_JOB", steamid32, `job_id: ${jobId}`);
        }
        if (jobCommand) {
          try {
            await withQueueLock(async () => {
              const queue = readQueueFile();
              const now = Math.floor(Date.now() / 1e3);
              const cmdText = `ba removedonate ${steamid32} ${jobCommand}`;
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
      console.error("player_jobs post error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { playerJobsRoutes as default };
