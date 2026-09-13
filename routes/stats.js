import { Router } from "express";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { steamid64ToSteamid, fixCrazyNick } from "../lib/helpers.js";

let statsCache = null;

let statsCacheAt = 0;

const STATS_TTL = 2e4;

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([ promise.finally(() => clearTimeout(timer)), new Promise(resolve => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  }) ]);
}

function statsRoutes() {
  const r = Router();
  r.get("/api/stats", authGuard, requirePerm("view_stats"), async (req, res) => {
    try {
      if (statsCache && Date.now() - statsCacheAt < STATS_TTL) return res.json(statsCache);
      const pool = db();
      let topPlaytime = [ [], [] ], topMoney = [ [], [] ], p = [ {
        cnt: 0
      } ], b = [ {
        cnt: 0
      } ], ab = [ {
        cnt: 0
      } ];
      try {
        const activeBanSql = `SELECT COUNT(*) AS cnt FROM ba_bans WHERE ((ban_len = 0 AND unban_time = 0) OR (ban_len <> 0 AND (unban_time > UNIX_TIMESTAMP() OR (unban_time = 0 AND ban_time + ban_len > UNIX_TIMESTAMP()))))`;
        const results = await Promise.all([ withTimeout(pool.query("SELECT steamid, name, playtime FROM ba_users WHERE playtime > 0 ORDER BY playtime DESC LIMIT 10"), 2500, [ [], [] ]).catch(() => [ [], [] ]), withTimeout(pool.query(`SELECT p.SteamID, p.Money, u.name FROM player_data p\n             LEFT JOIN ba_users u ON u.steamid = p.SteamID\n             WHERE p.Money > 0 ORDER BY p.Money DESC LIMIT 10`), 2500, [ [], [] ]).catch(() => [ [], [] ]), withTimeout(pool.query("SELECT COUNT(*) AS cnt FROM ba_users"), 1800, [ [ {
          cnt: 0
        } ], [] ]).catch(() => [ [ {
          cnt: 0
        } ], [] ]), withTimeout(pool.query("SELECT COUNT(*) AS cnt FROM ba_bans"), 1800, [ [ {
          cnt: 0
        } ], [] ]).catch(() => [ [ {
          cnt: 0
        } ], [] ]), withTimeout(pool.query(activeBanSql), 1800, [ [ {
          cnt: 0
        } ], [] ]).catch(() => [ [ {
          cnt: 0
        } ], [] ]) ]);
        topPlaytime = results[0];
        topMoney = results[1];
        p = results[2][0];
        b = results[3][0];
        ab = results[4][0];
      } catch (e) {
        console.error("Stats queries failed partially:", e.message);
      }
      const topPlaytimeList = topPlaytime[0].map(r2 => ({
        steamid: r2.steamid,
        steamid32: steamid64ToSteamid(r2.steamid),
        name: fixCrazyNick(r2.name),
        playtime: parseInt(r2.playtime || 0, 10)
      }));
      const topMoneyList = topMoney[0].map(r2 => ({
        steamid: r2.SteamID,
        steamid32: steamid64ToSteamid(r2.SteamID),
        name: fixCrazyNick(r2.name),
        money: parseInt(r2.Money || 0, 10)
      }));
      const stats = {
        total_players: parseInt(p[0]?.cnt || 0, 10),
        total_bans: parseInt(b[0]?.cnt || 0, 10),
        active_bans: parseInt(ab[0]?.cnt || 0, 10),
        active_admins_today: 0
      };
      try {
        const todayStart = Math.floor((new Date).setHours(0, 0, 0, 0) / 1e3);
        const [rowsAdmins] = await withTimeout(pool.query("SELECT COUNT(DISTINCT admin_steamid64) AS cnt FROM admin_logs WHERE timestamp >= ?", [ todayStart ]), 1200, [ [ {
          cnt: 0
        } ], [] ]);
        stats.active_admins_today = parseInt(rowsAdmins[0]?.cnt || 0, 10);
      } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
      const payload = {
        ok: true,
        stats: stats,
        top_playtime: topPlaytimeList,
        top_money: topMoneyList
      };
      statsCache = payload;
      statsCacheAt = Date.now();
      res.json(payload);
    } catch (e) {
      console.error("stats error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { statsRoutes as default };
