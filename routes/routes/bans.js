import { Router } from "express";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { steamid64ToSteamid, fixCrazyNick } from "../lib/helpers.js";

function bansRoutes() {
  const r = Router();
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
  r.get("/api/bans", authGuard, requirePerm("view_bans"), async (req, res) => {
    try {
      const pool = db();
      const page = Math.max(1, parseInt(req.query.page || 1, 10));
      const perPage = Math.max(1, Math.min(100, parseInt(req.query.per_page || 20, 10)));
      const offset = (page - 1) * perPage;
      const search = String(req.query.q || "").trim();
      const activeOnly = [ "1", "true", "yes", "on" ].includes(String(req.query.active_only || "").toLowerCase());
      const where = [];
      const params = [];
      if (search) {
        where.push("(name LIKE ? OR a_name LIKE ? OR reason LIKE ? OR CAST(steamid AS CHAR) LIKE ? OR CAST(a_steamid AS CHAR) LIKE ?)");
        const term = "%" + search + "%";
        params.push(term, term, term, term, term);
      }
      if (activeOnly) {
        where.push("(COALESCE(unban_reason,'') REGEXP '^[0-9]+\\\\[STEAM_' OR COALESCE(unban_reason,'') = '') AND ((ban_len = 0 AND unban_time = 0) OR (ban_len <> 0 AND (unban_time > UNIX_TIMESTAMP() OR (unban_time = 0 AND ban_time + ban_len > UNIX_TIMESTAMP()))))");
      }
      const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
      const [[countRow]] = await pool.query(`SELECT COUNT(*) AS cnt FROM ba_bans ${whereSql}`, params);
      const total = parseInt(countRow.cnt, 10);
      const [rows] = await pool.query(`SELECT steamid, name, a_name, a_steamid, reason, ban_time, ban_len, unban_time, unban_reason\n         FROM ba_bans ${whereSql} ORDER BY ban_time DESC LIMIT ?, ?`, [ ...params, offset, perPage ]);
      const items = rows.map(b => {
        const aRaw = String(b.a_steamid || "0");
        const a64 = /^\d{17}$/.test(aRaw) ? aRaw : "";
        const a64n = parseInt(a64 || "0", 10);
        const pRaw = String(b.steamid || "");
        let pSteam64 = "";
        let pSteam = pRaw;
        if (pRaw && /^\d+$/.test(pRaw) && pRaw.length >= 16) {
          pSteam64 = pRaw;
          pSteam = steamid64ToSteamid(pRaw);
        }
        return {
          steamid: pSteam,
          steamid64: pSteam64,
          name: fixCrazyNick(b.name || ""),
          a_name: fixCrazyNick(b.a_name || ""),
          a_steamid64: a64,
          a_steamid: a64n > 0 ? steamid64ToSteamid(a64) : aRaw.startsWith("STEAM_") ? aRaw : "STEAM_0:0:0",
          reason: fixCrazyNick(b.reason || ""),
          ban_time: parseInt(b.ban_time || 0, 10),
          ban_len: parseInt(b.ban_len || 0, 10),
          unban_time: parseInt(b.unban_time || 0, 10),
          unban_reason: fixCrazyNick(b.unban_reason || ""),
          active: banIsActive(b.ban_len, b.unban_time, b.unban_reason, b.ban_time)
        };
      });
      res.json({
        ok: true,
        items: items,
        total: total,
        page: page,
        per_page: perPage,
        has_more: total > offset + perPage
      });
    } catch (e) {
      console.error("bans error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { bansRoutes as default };
