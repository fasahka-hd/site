import { Router } from "express";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { steamid64ToSteamid, readOnlineMap, fixCrazyNick, decodeIfNeeded, isOnlineEntryFresh } from "../lib/helpers.js";

import { peekCachedUrl, resolveAvatarBatch } from "../lib/avatar_cache.js";

import { getCustomAvatarUrl } from "../lib/avatars.js";

import { avatarCache } from "../lib/lru_cache.js";

function avatarUrlFor(sid64) {
  try {
    const custom = getCustomAvatarUrl(sid64);
    if (custom) return custom;
    const mem = avatarCache.get(sid64);
    if (mem !== void 0) return mem;
    return peekCachedUrl(sid64);
  } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
  return null;
}

function playersRoutes() {
  const r = Router();
  async function baPreferredSvId(pool) {
    try {
      const [rows] = await pool.query("SELECT sv_id, COUNT(*) AS c FROM ba_ranks GROUP BY sv_id ORDER BY c DESC LIMIT 1");
      return rows[0]?.sv_id || "NOT_SET";
    } catch {
      return "NOT_SET";
    }
  }
  async function tableExists(pool, table) {
    try {
      const [rows] = await pool.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1", [ table ]);
      return rows.length > 0;
    } catch {
      return false;
    }
  }
  async function fetchDonateBalances(pool, sids) {
    if (!await tableExists(pool, "GMDonate_Players") || !sids.length) return new Map;
    const map = new Map;
    try {
      const ph = sids.map(() => "?").join(",");
      const [rows] = await pool.query(`SELECT CAST(SteamID64 AS CHAR) AS SteamID64, Balance FROM GMDonate_Players WHERE SteamID64 IN (${ph})`, sids);
      for (const row of rows) map.set(String(row.SteamID64), Number(row.Balance || 0));
      return map;
    } catch (e) {
      console.error("fetchDonateBalances error:", e.message);
      return map;
    }
  }
  async function fetchRanks(pool, sids, svId) {
    const map = new Map;
    if (!sids.length) return map;
    try {
      const ph = sids.map(() => "?").join(",");
      const [rows] = await pool.query(`SELECT steamid, sv_id, rank, expire_time FROM ba_ranks WHERE steamid IN (${ph})`, sids);
      for (const row of rows) {
        const sid = String(row.steamid);
        const item = {
          rank: row.rank,
          svScore: row.sv_id === svId ? 0 : 1,
          expire: parseInt(row.expire_time || 0, 10),
          rankVal: parseInt(row.rank || 0, 10)
        };
        const cur = map.get(sid);
        if (!cur || item.svScore < cur.svScore || item.svScore === cur.svScore && item.expire > cur.expire || item.svScore === cur.svScore && item.expire === cur.expire && item.rankVal > cur.rankVal) {
          map.set(sid, item);
        }
      }
      return map;
    } catch (e) {
      console.error("fetchRanks error:", e.message);
      return map;
    }
  }
  let _cache = null;
  let _cacheTime = 0;
  let _inflight = null;
  const PLAYERS_TTL_MS = 1e4;
  r.get("/api/players", authGuard, requirePerm("view_players"), async (req, res) => {
    const now = Date.now();
    if (_cache && now - _cacheTime < PLAYERS_TTL_MS) {
      return res.json(_cache);
    }
    if (_inflight) {
      try {
        return res.json(await _inflight);
      } catch {
        return res.status(500).json({
          ok: false,
          error: "DB_QUERY_FAILED"
        });
      }
    }
    _inflight = (async () => {
      const pool = db();
      const online = readOnlineMap() || {};
      const svId = await baPreferredSvId(pool);
      let rows = [];
      try {
        const [r2] = await pool.query(`\n          SELECT\n            u.steamid,\n            u.name,\n            u.lastseen,\n            u.playtime,\n            pd.Money AS money,\n            CASE WHEN chsp.steamid64 IS NOT NULL THEN 1 ELSE 0 END AS chsp_active\n          FROM ba_users u\n          LEFT JOIN player_data pd ON pd.SteamID = u.steamid\n          LEFT JOIN chsp_list chsp ON chsp.steamid64 = u.steamid AND chsp.active = 1\n          ORDER BY u.lastseen DESC LIMIT 2000\n        `);
        rows = r2 || [];
      } catch (e) {
        console.error("main players query error:", e.message);
      }
      const list = [];
      const seen = new Set;
      for (const row of rows) {
        let sid64 = String(row.steamid || "");
        if (!/^\d+$/.test(sid64)) {
          const m = sid64.match(/^STEAM_\d+:(\d+):(\d+)$/);
          if (m) sid64 = String(76561197960265728n + BigInt(m[2]) * 2n + BigInt(m[1])); else continue;
        }
        if (!sid64) continue;
        seen.add(sid64);
        const onRaw = online[sid64];
        const fresh = isOnlineEntryFresh(onRaw);
        const on = fresh ? onRaw : null;
        const nick = on ? decodeIfNeeded(on.nick || "") || sid64 : fixCrazyNick(row.name || "") || sid64;
        const isOnline = on ? on.online !== void 0 ? Boolean(on.online) : true : false;
        list.push({
          steamid64: sid64,
          steamid: steamid64ToSteamid(sid64),
          nick: nick,
          online: isOnline,
          ping: on ? parseInt(on.ping || 0, 10) : 0,
          rank: "",
          rank_id: "",
          money: parseInt(row.money || 0, 10),
          playtime: parseInt(row.playtime || 0, 10),
          lastseen: parseInt(row.lastseen || 0, 10),
          chsp: Boolean(row.chsp_active)
        });
      }
      for (const [sid64, on] of Object.entries(online)) {
        if (!/^\d+$/.test(sid64) || seen.has(sid64)) continue;
        if (!isOnlineEntryFresh(on)) continue;
        const isOnline = on.online !== void 0 ? Boolean(on.online) : true;
        if (!isOnline) continue;
        list.push({
          steamid64: sid64,
          steamid: steamid64ToSteamid(sid64),
          nick: decodeIfNeeded(on.nick || "") || sid64,
          online: true,
          ping: parseInt(on.ping || 0, 10),
          rank: "",
          rank_id: "",
          money: 0,
          playtime: 0,
          lastseen: Math.floor(Date.now() / 1e3),
          chsp: false
        });
      }
      const allSids = list.map(p => p.steamid64).filter(Boolean);
      const donateMap = await fetchDonateBalances(pool, allSids);
      const rankMap = await fetchRanks(pool, allSids, svId);
      const uncachedSids = [];
      for (const p of list) {
        p.donate_balance = donateMap.get(p.steamid64) || 0;
        const rankItem = rankMap.get(p.steamid64);
        if (rankItem) {
          const rv = String(rankItem.rank ?? "");
          p.rank = rv;
          p.rank_id = rv;
        }
        p.avatar = avatarUrlFor(p.steamid64);
        if (!p.avatar) uncachedSids.push(p.steamid64);
      }
      if (uncachedSids.length) {
        const cfg = req.app?.locals?.cfg || {};
        resolveAvatarBatch(pool, uncachedSids.slice(0, 100), cfg.STEAM_API_KEY).then(batch => {
          for (const [sid, url] of Object.entries(batch)) {
            avatarCache.set(sid, url);
          }
        }).catch(() => {});
      }
      return {
        ok: true,
        items: list
      };
    })();
    try {
      const payload = await _inflight;
      _cache = payload;
      _cacheTime = Date.now();
      res.json(payload);
    } catch (e) {
      console.error("players error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_QUERY_FAILED"
      });
    } finally {
      _inflight = null;
    }
  });
  return r;
}

export { playersRoutes as default };
