import { Router } from "express";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { steamid64ToSteamid, decodeIfNeeded, stripPort, logAdminAction } from "../lib/helpers.js";

function blacklistRoutes() {
  const r = Router();
  function sessionNickname(session) {
    const u = session?.user;
    return u?.nickname?.trim() || "Site";
  }
  r.get("/api/blacklist", authGuard, requirePerm("view_blacklist"), async (req, res) => {
    try {
      const pool = db();
      const [rows] = await pool.query(`SELECT steamid64, steamid, nickname, ip, reason, added_by, active,\n         UNIX_TIMESTAMP(added_at) AS added_at_ts,\n         UNIX_TIMESTAMP(updated_at) AS updated_at_ts\n         FROM chsp_list ORDER BY COALESCE(updated_at, added_at) DESC`);
      const missingNickSids = [];
      const missingIpSids = [];
      for (const row of rows) {
        const sid64 = String(row.steamid64 || "");
        if (!sid64) continue;
        let nick = decodeIfNeeded(row.nickname || "");
        if (!nick || /^неизвестный игрок$/iu.test(nick.trim())) {
          missingNickSids.push(sid64);
        }
        let ipVal = stripPort(row.ip || "");
        if (!ipVal && sid64) {
          missingIpSids.push(sid64);
        }
      }
      const nickMap = {};
      if (missingNickSids.length) {
        try {
          const placeholders = missingNickSids.map(() => "?").join(",");
          const [nickRows] = await pool.query(`SELECT steamid, name FROM ba_users WHERE steamid IN (${placeholders})`, missingNickSids);
          for (const nr of nickRows) {
            if (nr?.name) nickMap[String(nr.steamid)] = decodeIfNeeded(nr.name);
          }
        } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
      }
      const ipMap = {};
      if (missingIpSids.length) {
        try {
          const placeholders = missingIpSids.map(() => "?").join(",");
          const [ipRows] = await pool.query(`SELECT t.steamid, t.ip\n             FROM ba_iplog t\n             INNER JOIN (\n               SELECT steamid, MAX(lastseen) AS max_seen\n               FROM ba_iplog\n               WHERE steamid IN (${placeholders})\n               GROUP BY steamid\n             ) latest ON t.steamid = latest.steamid AND t.lastseen = latest.max_seen`, missingIpSids);
          for (const ir of ipRows) {
            if (ir?.ip) ipMap[String(ir.steamid)] = stripPort(ir.ip);
          }
        } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
        const stillMissing = missingIpSids.filter(s => !ipMap[s]);
        if (stillMissing.length) {
          try {
            const placeholders = stillMissing.map(() => "?").join(",");
            const [banIpRows] = await pool.query(`SELECT t.steamid, t.ip\n               FROM ba_bans t\n               INNER JOIN (\n                 SELECT steamid, MAX(ban_time) AS max_time\n                 FROM ba_bans\n                 WHERE steamid IN (${placeholders}) AND ip <> '0'\n                 GROUP BY steamid\n               ) latest ON t.steamid = latest.steamid AND t.ban_time = latest.max_time`, stillMissing);
            for (const br of banIpRows) {
              if (br?.ip) ipMap[String(br.steamid)] = stripPort(br.ip);
            }
          } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
        }
      }
      const items = rows.map(row => {
        const sid64 = String(row.steamid64 || "");
        let sid = String(row.steamid || "");
        if (!sid && sid64 && /^\d+$/.test(sid64)) sid = steamid64ToSteamid(sid64);
        let nick = decodeIfNeeded(row.nickname || "");
        if (!nick || /^неизвестный игрок$/iu.test(nick.trim())) {
          nick = nickMap[sid64] || nick || sid64;
        }
        let ipVal = stripPort(row.ip || "");
        if (!ipVal) {
          ipVal = ipMap[sid64] || "";
        }
        return {
          steamid64: sid64,
          steamid: sid,
          nickname: nick,
          ip: ipVal,
          reason: decodeIfNeeded(row.reason || ""),
          added_by: decodeIfNeeded(row.added_by || ""),
          active: parseInt(row.active ?? 1, 10),
          added_at: parseInt(row.added_at_ts || 0, 10),
          updated_at: parseInt(row.updated_at_ts || 0, 10)
        };
      });
      res.json({
        ok: true,
        items: items
      });
    } catch (e) {
      console.error("blacklist error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/chsp_action", authGuard, requirePerm("manage_blacklist"), async (req, res) => {
    try {
      const pool = db();
      const action = String(req.body.action || "").trim();
      const steamid64 = String(req.body.steamid64 || "").trim();
      let ip = stripPort(req.body.ip || "");
      const nickname = String(req.body.nickname || "").trim();
      const reason = String(req.body.reason || "").trim();
      const addedBy = sessionNickname(req.session);
      if (!action) return res.status(400).json({
        ok: false,
        error: "NO_ACTION"
      });
      if (action === "add") {
        if (!steamid64 || !/^\d{17}$/.test(steamid64)) return res.status(400).json({
          ok: false,
          error: "BAD_STEAMID64"
        });
        const steamid = steamid64ToSteamid(steamid64);
        await pool.query(`INSERT INTO chsp_list (steamid64, steamid, nickname, ip, reason, added_by, active)\n           VALUES (?, ?, ?, ?, ?, ?, 1)\n           ON DUPLICATE KEY UPDATE steamid=VALUES(steamid), nickname=VALUES(nickname), ip=VALUES(ip),\n           reason=VALUES(reason), added_by=VALUES(added_by), active=1, updated_at=CURRENT_TIMESTAMP`, [ steamid64, steamid, nickname, ip, reason, addedBy ]);
        if (ip) {
          await pool.query(`INSERT INTO chsp_ip_list (ip, reason, added_by, active) VALUES (?, ?, ?, 1)\n             ON DUPLICATE KEY UPDATE reason=VALUES(reason), added_by=VALUES(added_by), active=1`, [ ip, reason, addedBy ]).catch(() => {});
        }
        if (req.session.user) {
          await logAdminAction(pool, req.session.user.steamid64, "BLACKLIST_ADD", steamid64, reason).catch(() => {});
        }
        return res.json({
          ok: true
        });
      }
      if (action === "remove") {
        if (!steamid64 || !/^\d{17}$/.test(steamid64)) return res.status(400).json({
          ok: false,
          error: "BAD_STEAMID64"
        });
        await pool.query("DELETE FROM chsp_list WHERE steamid64 = ? LIMIT 1", [ steamid64 ]);
        if (ip) await pool.query("DELETE FROM chsp_ip_list WHERE ip = ? LIMIT 1", [ ip ]).catch(() => {});
        if (req.session.user) {
          await logAdminAction(pool, req.session.user.steamid64, "BLACKLIST_REMOVE", steamid64, "").catch(() => {});
        }
        return res.json({
          ok: true
        });
      }
      if (action === "remove_ip") {
        if (!ip) return res.status(400).json({
          ok: false,
          error: "NO_IP"
        });
        await pool.query("DELETE FROM chsp_ip_list WHERE ip = ? LIMIT 1", [ ip ]);
        return res.json({
          ok: true
        });
      }
      return res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("chsp_action error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { blacklistRoutes as default };
