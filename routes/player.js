import { Router } from "express";

import { db } from "../lib/db.js";

import { requirePerm, getUserRole, webRolesDef, webNormalizeRole } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { steamid64ToSteamid, steamidToSteamid64, readOnlineMap, fixCrazyNick, decodeIfNeeded, stripPort, checkVacBans, isOnlineEntryFresh } from "../lib/helpers.js";

import { peekCachedUrl } from "../lib/avatar_cache.js";

import { getCustomAvatarUrl } from "../lib/avatars.js";

function avatarUrlFor(sid64) {
  try {
    const custom = getCustomAvatarUrl(sid64);
    if (custom) return custom;
    return peekCachedUrl(sid64);
  } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
  return null;
}

const HIGH_LEVEL_THRESHOLD = 80;

function canViewIp(session) {
  const role = webNormalizeRole(session?.user?.role);
  const level = webRolesDef()[role]?.level || 0;
  return level >= HIGH_LEVEL_THRESHOLD;
}

function banIsActive(banLen, unbanTime, unbanReason, banTime) {
  const unbanReasonStr = String(unbanReason || "").trim();
  const isRealUnban = unbanReasonStr && !/^\d+\[STEAM_/.test(unbanReasonStr);
  if (isRealUnban) return false;
  banLen = parseInt(banLen || 0, 10);
  unbanTime = parseInt(unbanTime || 0, 10);
  if (banLen === 0) return unbanTime === 0;
  const now = Math.floor(Date.now() / 1e3);
  if (unbanTime > 0) return now < unbanTime;
  const bt = parseInt(banTime || 0, 10);
  if (bt > 0) return now < bt + banLen;
  return false;
}

function playerRoutes(cfg, steamApiLimiter) {
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
  async function batchResolveWarnAdmins(pool, warns) {
    const adminSteamids = [ ...new Set(warns.map(w => String(w.admin_steamid || "").trim()).filter(Boolean)) ];
    if (!adminSteamids.length) return {};
    const nameMap = {};
    try {
      const placeholders = adminSteamids.map(() => "?").join(",");
      const [rows] = await pool.query(`SELECT steamid64, COALESCE(nickname,'') AS nickname FROM web_users WHERE steamid64 IN (${placeholders})`, adminSteamids);
      for (const row of rows) {
        nameMap[String(row.steamid64)] = decodeIfNeeded(row.nickname);
      }
    } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
    const unresolved = adminSteamids.filter(s => !nameMap[s]);
    if (unresolved.length) {
      try {
        const placeholders = unresolved.map(() => "?").join(",");
        const [rows] = await pool.query(`SELECT steamid, name FROM ba_users WHERE steamid IN (${placeholders})`, unresolved);
        for (const row of rows) {
          nameMap[String(row.steamid)] = decodeIfNeeded(row.name);
        }
      } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
    }
    return nameMap;
  }
  async function resolveWarnAdmin(pool, adminSteamid) {
    const raw = String(adminSteamid || "").trim();
    if (!raw) return "—";
    const sid64 = /^\d{17}$/.test(raw) ? raw : steamidToSteamid64(raw);
    if (sid64) {
      try {
        const [w] = await pool.query("SELECT COALESCE(nickname,'') AS nickname FROM web_users WHERE steamid64 = ? LIMIT 1", [ sid64 ]);
        if (w[0]?.nickname) return decodeIfNeeded(w[0].nickname);
      } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
      try {
        const sid32 = steamid64ToSteamid(sid64);
        const [u] = await pool.query("SELECT name FROM ba_users WHERE steamid = ? OR steamid = ? LIMIT 1", [ sid64, sid32 ]);
        if (u[0]?.name) return decodeIfNeeded(u[0].name);
      } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
    }
    return raw;
  }
  async function getWarns(pool, sid64) {
    if (!await tableExists(pool, "ba_warns")) return [];
    try {
      const sid64Str = String(sid64 || "").trim();
      const sid64Num = /^\d{17}$/.test(sid64Str) ? sid64Str : "0";
      const [rows] = await pool.query(`SELECT id, CAST(steamid AS CHAR) AS steamid, reason, admin_steamid, UNIX_TIMESTAMP(timestamp) AS ts\n         FROM ba_warns\n         WHERE steamid = ? OR CAST(steamid AS CHAR) = ?\n         ORDER BY timestamp DESC, id DESC LIMIT 5`, [ sid64Num, sid64Str ]);
      const out = [];
      for (const w of rows) {
        const adminSteamid = String(w.admin_steamid || "");
        out.push({
          id: parseInt(w.id || 0, 10),
          steamid: String(w.steamid || sid64),
          reason: decodeIfNeeded(w.reason || "Причина не указана"),
          admin_steamid: adminSteamid,
          admin_name: "—",
          timestamp: parseInt(w.ts || 0, 10)
        });
      }
      return out;
    } catch (e) {
      console.error("warns query error:", e.message);
      return [];
    }
  }
  r.get("/api/player", authGuard, requirePerm("view_profile"), async (req, res) => {
    try {
      const sid64 = String(req.query.sid || "").trim();
      if (!sid64 || !/^\d{17}$/.test(sid64)) return res.status(400).json({
        ok: false,
        error: "BAD_STEAMID64"
      });
      const pool = db();
      const online = readOnlineMap();
      const svId = await baPreferredSvId(pool);
      const sid32 = steamid64ToSteamid(sid64);
      const [rows] = await pool.query(`\n        SELECT u.steamid, u.name, u.firstjoined, u.lastseen, u.playtime,\n          pd.Money AS money,\n          (SELECT r.rank FROM ba_ranks r WHERE r.steamid = u.steamid\n            ORDER BY CASE WHEN r.sv_id = ? THEN 0 ELSE 1 END ASC, r.expire_time DESC, r.rank DESC LIMIT 1) AS rank_id\n        FROM ba_users u\n        LEFT JOIN player_data pd ON pd.SteamID = u.steamid\n        WHERE u.steamid = ? OR u.steamid = ? LIMIT 1\n      `, [ svId, sid64, sid32 ]);
      if (!rows.length) return res.status(404).json({
        ok: false,
        error: "NOT_FOUND"
      });
      const row = rows[0];
      let donateBalance = 0;
      try {
        if (await tableExists(pool, "GMDonate_Players")) {
          const [drows] = await pool.query("SELECT Balance FROM GMDonate_Players WHERE SteamID64 = ? LIMIT 1", [ sid64 ]);
          donateBalance = Math.round(Number(drows[0]?.Balance || 0));
        }
      } catch (e) {
        console.error("donate balance query error:", e.message);
      }
      const onRaw = online[sid64];
      const fresh = isOnlineEntryFresh(onRaw);
      const on = fresh ? onRaw : null;
      const nick = on ? decodeIfNeeded(on.nick || "") || sid64 : fixCrazyNick(row.name || "") || sid64;
      const isOnline = on ? on.online !== void 0 ? Boolean(on.online) : true : false;
      const ping = on ? parseInt(on.ping || 0, 10) : 0;
      const showIp = canViewIp(req.session);
      let ip = "";
      if (showIp) {
        try {
          const [ipRows] = await pool.query("SELECT ip FROM ba_iplog WHERE steamid = ? OR steamid = ? ORDER BY lastseen DESC LIMIT 1", [ sid64, sid32 ]);
          if (ipRows[0]) ip = stripPort(ipRows[0].ip);
        } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
        if (!ip) {
          try {
            const [ipRows] = await pool.query("SELECT ip FROM ba_bans WHERE (steamid = ? OR steamid = ?) AND ip <> '0' ORDER BY ban_time DESC LIMIT 1", [ sid64, sid32 ]);
            if (ipRows[0]) ip = stripPort(ipRows[0].ip);
          } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
        }
      }
      let discordLinked = false;
      let discordId = "";
      let discordUsername = "";
      let discordRoleSynced = false;
      try {
        const [discRows] = await pool.query("SELECT discord_id, discord_username, role_synced FROM donate_discord_users WHERE steamid64 = ? LIMIT 1", [ sid64 ]);
        if (discRows[0] && discRows[0].discord_id) {
          discordLinked = true;
          discordId = String(discRows[0].discord_id);
          discordUsername = decodeIfNeeded(discRows[0].discord_username || "") || "";
          discordRoleSynced = discRows[0].role_synced === true || discRows[0].role_synced === 1 || discRows[0].role_synced === "1" || discRows[0].role_synced === "true";
        }
      } catch (e) {
        console.error("discord link query error:", e.message);
      }
      let chsp = null;
      try {
        const [chspRows] = await pool.query("SELECT steamid64, reason, added_by, active FROM chsp_list WHERE steamid64 = ? LIMIT 1", [ sid64 ]);
        if (chspRows[0]) {
          chsp = {
            active: Boolean(chspRows[0].active),
            reason: decodeIfNeeded(chspRows[0].reason),
            added_by: decodeIfNeeded(chspRows[0].added_by)
          };
        }
      } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
      const [bansRows] = await pool.query(`\n        SELECT steamid, name, a_name, a_steamid, reason, ban_time, ban_len, unban_time, unban_reason\n        FROM ba_bans WHERE steamid = ? OR steamid = ? ORDER BY ban_time DESC LIMIT 50\n      `, [ sid64, sid32 ]);
      const bans = bansRows.map(b => ({
        steamid: /^\d{17}$/.test(String(b.steamid || "")) ? steamid64ToSteamid(String(b.steamid || "")) : String(b.steamid || ""),
        name: fixCrazyNick(b.name || ""),
        a_name: fixCrazyNick(b.a_name || ""),
        a_steamid: String(b.a_steamid || ""),
        reason: fixCrazyNick(b.reason || ""),
        ban_time: parseInt(b.ban_time || 0, 10),
        ban_len: parseInt(b.ban_len || 0, 10),
        unban_time: parseInt(b.unban_time || 0, 10),
        unban_reason: fixCrazyNick(b.unban_reason || ""),
        active: banIsActive(b.ban_len, b.unban_time, b.unban_reason, b.ban_time)
      }));
      const isBanned = bans.some(b => b.active);
      const chspActive = !!(chsp && chsp.active);
      const warns = await getWarns(pool, sid64);
      if (warns.length > 0) {
        const adminNames = await batchResolveWarnAdmins(pool, warns);
        for (const w of warns) {
          const adminSid = String(w.admin_steamid || "");
          const resolvedSid = /^\d{17}$/.test(adminSid) ? adminSid : steamidToSteamid64(adminSid);
          w.admin_name = adminNames[resolvedSid] || adminNames[adminSid] || adminSid || "—";
        }
      }
      res.json({
        ok: true,
        steamid64: sid64,
        steamid: sid32,
        nick: nick,
        avatar: avatarUrlFor(sid64),
        online: isOnline,
        ping: ping,
        rank: String(row.rank_id || ""),
        rank_id: String(row.rank_id || ""),
        money: parseInt(row.money || 0, 10),
        donate_balance: donateBalance,
        playtime: parseInt(row.playtime || 0, 10),
        firstjoined: parseInt(row.firstjoined || 0, 10),
        lastseen: parseInt(row.lastseen || 0, 10),
        ip: ip,
        discord_linked: discordLinked,
        discord_id: discordId,
        discord_username: discordUsername,
        discord_role_synced: discordRoleSynced,
        chsp: chsp,
        chsp_active: chspActive,
        is_banned: isBanned,
        bans: bans,
        warns: warns,
        warns_count: warns.length,
        warns_limit: 5
      });
    } catch (e) {
      console.error("player error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/player_donate_action", authGuard, requirePerm("manage_player_donate"), async (req, res) => {
    try {
      const sid64 = String(req.body?.sid || req.body?.steamid64 || "").trim();
      const action = String(req.body?.action || "").trim();
      const invId = parseInt(req.body?.inv_id || "0", 10);
      if (!sid64 || !/^\d{17}$/.test(sid64)) return res.status(400).json({
        ok: false,
        error: "BAD_STEAMID64"
      });
      if (![ "delete", "clear" ].includes(action)) return res.status(400).json({
        ok: false,
        error: "BAD_ACTION"
      });
      const pool = db();
      if (!await tableExists(pool, "GMDonate_Inventory")) return res.json({
        ok: true,
        affected: 0
      });
      let affected = 0;
      if (action === "delete") {
        if (!invId || invId <= 0) return res.status(400).json({
          ok: false,
          error: "BAD_INV_ID"
        });
        const [r2] = await pool.query("DELETE FROM GMDonate_Inventory WHERE SteamID64 = ? AND InvID = ?", [ sid64, invId ]);
        affected = r2?.affectedRows || 0;
      } else {
        const [r2] = await pool.query("DELETE FROM GMDonate_Inventory WHERE SteamID64 = ?", [ sid64 ]);
        affected = r2?.affectedRows || 0;
      }
      res.json({
        ok: true,
        affected: affected
      });
    } catch (e) {
      console.error("player donate action error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.get("/api/player_donate", authGuard, requirePerm("view_player_donate"), async (req, res) => {
    try {
      const sid64 = String(req.query.sid || "").trim();
      if (!sid64 || !/^\d{17}$/.test(sid64)) return res.status(400).json({
        ok: false,
        error: "BAD_STEAMID64"
      });
      const pool = db();
      const sid32 = steamid64ToSteamid(sid64);
      const items = [];
      const transactions = [];
      let gmBalance = 0;
      let inventoryApiError = "";
      if (await tableExists(pool, "GMDonate_Players")) {
        try {
          const [rows] = await pool.query("SELECT Balance FROM GMDonate_Players WHERE SteamID64 = ? LIMIT 1", [ sid64 ]);
          gmBalance = Math.round(Number(rows[0]?.Balance || 0));
        } catch (e) {
          console.error("GMDonate_Players error:", e.message);
        }
      }
      if (await tableExists(pool, "GMDonate_Inventory")) {
        try {
          const [rows] = await pool.query(`\n            SELECT InvID, ItemUID, ItemName, UpdatedAt\n            FROM GMDonate_Inventory\n            WHERE SteamID64 = ?\n            ORDER BY UpdatedAt DESC, InvID DESC\n            LIMIT 500\n          `, [ sid64 ]);
          for (const r2 of rows) items.push({
            source: "GMDonate_Inventory",
            inv_id: String(r2.InvID || ""),
            name: fixCrazyNick(r2.ItemName || r2.ItemUID || "Предмет"),
            item_id: String(r2.ItemUID || ""),
            type: "Инвентарь F6",
            status: "В инвентаре",
            sum: 0,
            time: parseInt(r2.UpdatedAt || 0, 10)
          });
        } catch (e) {
          inventoryApiError = e.message || "GMDonate_Inventory_ERROR";
          console.error("GMDonate_Inventory error:", e.message);
        }
      } else {
        inventoryApiError = "GMDonate_Inventory table not found. Обнови processor_sv.lua на сервере и выполни igs_sync_online_inventories / перезайди игроком.";
      }
      if (await tableExists(pool, "GMDonate_Transactions")) {
        try {
          const [rows] = await pool.query(`\n            SELECT TxHash, Sum, Note, TxTime\n            FROM GMDonate_Transactions\n            WHERE SteamID64 = ?\n            ORDER BY TxTime DESC, TxHash DESC\n            LIMIT 50\n          `, [ sid64 ]);
          for (const r2 of rows) transactions.push({
            sum: Number(r2.Sum || 0),
            note: decodeIfNeeded(r2.Note || "").trim() || "—",
            time: parseInt(r2.TxTime || 0, 10)
          });
        } catch (e) {
          console.error("GMDonate_Transactions history error:", e.message);
        }
      }
      res.json({
        ok: true,
        steamid64: sid64,
        steamid: sid32,
        gm_balance: gmBalance,
        inventory_api_error: inventoryApiError,
        items: items,
        transactions: transactions
      });
    } catch (e) {
      console.error("player donate error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.get("/api/vac_check", authGuard, requirePerm("view_profile"), steamApiLimiter, async (req, res) => {
    const sid64 = String(req.query.sid || "").trim();
    if (!sid64 || !/^\d{17}$/.test(sid64)) return res.status(400).json({
      ok: false,
      error: "BAD_SID"
    });
    const info = await checkVacBans(cfg.STEAM_API_KEY, sid64);
    const vac = info || {
      VACBanned: false,
      NumberOfVACBans: 0,
      DaysSinceLastBan: 0,
      NumberOfGameBans: 0,
      EconomyBan: "none"
    };
    res.json({
      ok: true,
      vac_info: {
        VACBanned: Boolean(vac.VACBanned),
        NumberOfVACBans: parseInt(vac.NumberOfVACBans || 0, 10),
        DaysSinceLastBan: parseInt(vac.DaysSinceLastBan || 0, 10),
        NumberOfGameBans: parseInt(vac.NumberOfGameBans || 0, 10),
        EconomyBan: vac.EconomyBan || "none"
      },
      ...!info ? {
        note: "Steam API недоступна"
      } : {}
    });
  });
  return r;
}

export { playerRoutes as default };
